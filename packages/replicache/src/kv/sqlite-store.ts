import {RWLock} from '@rocicorp/lock';
import type {ReadonlyJSONValue} from '../../../shared/src/json.ts';
import {deepFreeze} from '../frozen-json.ts';
import type {Read, Store, Write} from './store.ts';
import {
  maybeTransactionIsClosedRejection,
  throwIfStoreClosed,
  throwIfTransactionClosed,
} from './throw-if-closed.ts';

/**
 * A SQLite prepared statement.
 *
 * `run` executes the statement with optional parameters.
 * `all` executes the statement and returns the result rows.
 * `finalize` releases the statement.
 */
export interface PreparedStatement {
  firstValue(params: string[]): Promise<unknown>;
  exec(params: string[]): Promise<void>;
  all(params: string[]): Promise<unknown[][]>;
}

export interface SQLiteDatabase {
  /**
   * Close the database connection.
   */
  close(): void;

  /**
   * Destroy or delete the database (e.g. delete file).
   */
  destroy(): void;

  /**
   * Prepare a SQL string, returning a statement you can execute.
   * E.g. `const stmt = db.prepare("SELECT * FROM todos WHERE id=?");`
   */
  prepare(sql: string): PreparedStatement;

  // for PRAGMA statements, schema creation and transaction control.
  execSync(sql: string): void;
}

export type CreateSQLiteDatabase = (
  filename: string,
  opts?: SQLiteStoreOptions,
) => SQLiteDatabase;

/**
 * SQLite-based implementation of the Store interface using a configurable delegate.
 * Supports shared connections between multiple store instances with the same name,
 * providing efficient resource utilization and proper transaction isolation.
 * Uses parameterized queries for safety and performance.
 */
export class SQLiteStore implements Store {
  readonly #filename: string;
  readonly #entry: StoreEntry;

  #closed = false;

  constructor(
    name: string,
    create: CreateSQLiteDatabase,
    opts?: SQLiteStoreOptions,
  ) {
    this.#filename = safeFilename(name);
    this.#entry = getOrCreateEntry(name, create, opts);
  }

  async read(): Promise<Read> {
    throwIfStoreClosed(this);

    const entry = this.#entry;
    const {db, lock, preparedStatements} = entry;
    const release = await lock.read();

    // Start shared read transaction if this is the first reader
    // This ensures consistent reads across all concurrent readers
    if (entry.activeReaders === 0) {
      db.execSync('BEGIN');
    }
    entry.activeReaders++;

    return new SQLiteStoreRead(() => {
      entry.activeReaders--;
      // Commit shared read transaction when last reader finishes
      if (entry.activeReaders === 0) {
        db.execSync('COMMIT');
      }
      release();
    }, preparedStatements);
  }

  async write(): Promise<Write> {
    throwIfStoreClosed(this);

    const {lock, db, preparedStatements} = this.#entry;
    const release = await lock.write();

    // At this point, RWLock guarantees no active readers
    // The last reader would have already committed the shared transaction

    db.execSync('BEGIN IMMEDIATE');

    return new SQLiteWrite(release, db, preparedStatements);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    const {lock, db} = this.#entry;
    // Wait for all readers and writers to finish.
    const writeRelease = await lock.write();

    // Handle reference counting for shared stores - only close database
    // when this is the last store instance using it
    decrementStoreRefCount(this.#filename, db);

    this.#closed = true;
    writeRelease();
  }

  get closed(): boolean {
    return this.#closed;
  }
}

export function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

export type PreparedStatements = {
  has: PreparedStatement;
  get: PreparedStatement;
  put: PreparedStatement;
  del: PreparedStatement;
  getMany: PreparedStatement;
  hasMany: PreparedStatement;
};

export interface SQLiteStoreOptions {
  // Common options
  busyTimeout?: number;
  journalMode?: 'WAL' | 'DELETE';
  synchronous?: 'NORMAL' | 'FULL';
  readUncommitted?: boolean;
}

/**
 * Common database setup logic shared between expo-sqlite and op-sqlite implementations.
 * Configures SQLite pragmas, creates the entry table, and prepares common statements.
 */

export function setupDatabase(
  delegate: SQLiteDatabase,
  opts?: SQLiteStoreOptions,
): PreparedStatements {
  // Configure SQLite pragmas for optimal performance
  delegate.execSync(`PRAGMA busy_timeout = ${opts?.busyTimeout ?? 200}`);
  delegate.execSync(`PRAGMA journal_mode = '${opts?.journalMode ?? 'WAL'}'`);
  delegate.execSync(`PRAGMA synchronous = '${opts?.synchronous ?? 'NORMAL'}'`);
  delegate.execSync(
    `PRAGMA read_uncommitted = ${Boolean(opts?.readUncommitted)}`,
  );

  // Create the entry table
  delegate.execSync(`
    CREATE TABLE IF NOT EXISTS entry (
      key TEXT PRIMARY KEY, 
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `);

  // Prepare common statements
  return {
    has: delegate.prepare(`SELECT 1 FROM entry WHERE key = ? LIMIT 1`),
    get: delegate.prepare('SELECT value FROM entry WHERE key = ?'),
    put: delegate.prepare(
      'INSERT OR REPLACE INTO entry (key, value) VALUES (?, ?)',
    ),
    del: delegate.prepare('DELETE FROM entry WHERE key = ?'),
    getMany: delegate.prepare(
      `SELECT key, value FROM entry WHERE key IN (SELECT value FROM json_each(?))`,
    ),
    hasMany: delegate.prepare(
      `SELECT key FROM entry WHERE key IN (SELECT value FROM json_each(?))`,
    ),
  };
}

// Striped layout per entry: [key, resolve, reject]
const PENDING_STRIDE = 3;
const PENDING_KEY = 0;
const PENDING_RESOLVE = 1;
const PENDING_REJECT = 2;

async function flushGets(
  pending: unknown[],
  getSingle: PreparedStatement,
  getMany: PreparedStatement,
): Promise<void> {
  if (pending.length === PENDING_STRIDE) {
    const key = pending[PENDING_KEY] as string;
    const resolve = pending[PENDING_RESOLVE] as (
      v: ReadonlyJSONValue | undefined,
    ) => void;
    const reject = pending[PENDING_REJECT] as (e: unknown) => void;
    let raw: unknown;
    try {
      raw = await getSingle.firstValue([key]);
    } catch (e) {
      reject(e);
      return;
    }
    try {
      resolve(
        raw === undefined
          ? undefined
          : deepFreeze(JSON.parse(raw as string) as ReadonlyJSONValue),
      );
    } catch (e) {
      reject(e);
    }
    return;
  }

  const keySet = new Set<string>();
  for (let i = PENDING_KEY; i < pending.length; i += PENDING_STRIDE) {
    keySet.add(pending[i] as string);
  }

  let rows: unknown[][];
  try {
    rows = await getMany.all([JSON.stringify([...keySet])]);
  } catch (e) {
    for (let i = PENDING_REJECT; i < pending.length; i += PENDING_STRIDE) {
      (pending[i] as (e: unknown) => void)(e);
    }
    return;
  }

  const resultMap = new Map<string, string>();
  for (const row of rows) {
    resultMap.set(row[0] as string, row[1] as string);
  }

  for (let i = 0; i < pending.length; i += PENDING_STRIDE) {
    const key = pending[i + PENDING_KEY] as string;
    const resolve = pending[i + PENDING_RESOLVE] as (
      v: ReadonlyJSONValue | undefined,
    ) => void;
    const reject = pending[i + PENDING_REJECT] as (e: unknown) => void;
    const raw = resultMap.get(key);
    try {
      resolve(
        raw === undefined
          ? undefined
          : deepFreeze(JSON.parse(raw) as ReadonlyJSONValue),
      );
    } catch (e) {
      reject(e);
    }
  }
}

async function flushHas(
  pending: unknown[],
  hasSingle: PreparedStatement,
  hasMany: PreparedStatement,
): Promise<void> {
  if (pending.length === PENDING_STRIDE) {
    const key = pending[PENDING_KEY] as string;
    const resolve = pending[PENDING_RESOLVE] as (v: boolean) => void;
    const reject = pending[PENDING_REJECT] as (e: unknown) => void;
    try {
      resolve((await hasSingle.firstValue([key])) !== undefined);
    } catch (e) {
      reject(e);
    }
    return;
  }

  const keySet = new Set<string>();
  for (let i = PENDING_KEY; i < pending.length; i += PENDING_STRIDE) {
    keySet.add(pending[i] as string);
  }

  let rows: unknown[][];
  try {
    rows = await hasMany.all([JSON.stringify([...keySet])]);
  } catch (e) {
    for (let i = PENDING_REJECT; i < pending.length; i += PENDING_STRIDE) {
      (pending[i] as (e: unknown) => void)(e);
    }
    return;
  }

  const existingKeys = new Set(rows.map(row => row[0] as string));
  for (let i = 0; i < pending.length; i += PENDING_STRIDE) {
    const key = pending[i + PENDING_KEY] as string;
    const resolve = pending[i + PENDING_RESOLVE] as (v: boolean) => void;
    resolve(existingKeys.has(key));
  }
}

export class SQLiteStoreRead implements Read {
  readonly #release: () => void;
  readonly #preparedStatements: PreparedStatements;
  #closed = false;
  // Flat striped arrays: [key, resolve, reject, ...]
  #pendingGets: unknown[] = [];
  #pendingHas: unknown[] = [];
  #scheduled = false;

  constructor(release: () => void, preparedStatements: PreparedStatements) {
    this.#release = release;
    this.#preparedStatements = preparedStatements;
  }

  has(key: string): Promise<boolean> {
    return (
      maybeTransactionIsClosedRejection(this) ??
      new Promise((resolve, reject) => {
        this.#pendingHas.push(key, resolve, reject);
        this.#scheduleLookup();
      })
    );
  }

  get(key: string): Promise<ReadonlyJSONValue | undefined> {
    return (
      maybeTransactionIsClosedRejection(this) ??
      new Promise((resolve, reject) => {
        this.#pendingGets.push(key, resolve, reject);
        this.#scheduleLookup();
      })
    );
  }

  #scheduleLookup(): void {
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        const {get, has, getMany, hasMany} = this.#preparedStatements;
        const gets = this.#pendingGets.splice(0);
        const hass = this.#pendingHas.splice(0);
        if (gets.length > 0) void flushGets(gets, get, getMany);
        if (hass.length > 0) void flushHas(hass, has, hasMany);
      });
    }
  }

  release(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#release();
    }
  }

  get closed(): boolean {
    return this.#closed;
  }
}

export class SQLiteWrite implements Write {
  readonly #release: () => void;
  readonly #dbDelegate: SQLiteDatabase;
  readonly #preparedStatements: PreparedStatements;
  #committed = false;
  #closed = false;
  // Flat striped arrays: [key, resolve, reject, ...]
  #pendingGets: unknown[] = [];
  #pendingHas: unknown[] = [];
  #scheduled = false;

  constructor(
    release: () => void,
    dbDelegate: SQLiteDatabase,
    preparedStatements: PreparedStatements,
  ) {
    this.#release = release;
    this.#dbDelegate = dbDelegate;
    this.#preparedStatements = preparedStatements;
  }

  has(key: string): Promise<boolean> {
    return (
      maybeTransactionIsClosedRejection(this) ??
      new Promise((resolve, reject) => {
        this.#pendingHas.push(key, resolve, reject);
        this.#scheduleLookup();
      })
    );
  }

  get(key: string): Promise<ReadonlyJSONValue | undefined> {
    return (
      maybeTransactionIsClosedRejection(this) ??
      new Promise((resolve, reject) => {
        this.#pendingGets.push(key, resolve, reject);
        this.#scheduleLookup();
      })
    );
  }

  #scheduleLookup(): void {
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        const {get, has, getMany, hasMany} = this.#preparedStatements;
        const gets = this.#pendingGets.splice(0);
        const hass = this.#pendingHas.splice(0);
        if (gets.length > 0) void flushGets(gets, get, getMany);
        if (hass.length > 0) void flushHas(hass, has, hasMany);
      });
    }
  }

  async put(key: string, value: ReadonlyJSONValue): Promise<void> {
    throwIfTransactionClosed(this);
    await this.#preparedStatements.put.exec([key, JSON.stringify(value)]);
  }

  async del(key: string): Promise<void> {
    throwIfTransactionClosed(this);
    await this.#preparedStatements.del.exec([key]);
  }

  // oxlint-disable-next-line require-await
  async commit(): Promise<void> {
    throwIfTransactionClosed(this);
    this.#dbDelegate.execSync('COMMIT');
    this.#committed = true;
  }

  release(): void {
    if (!this.#closed) {
      this.#closed = true;

      if (!this.#committed) {
        this.#dbDelegate.execSync('ROLLBACK');
      }

      this.#release();
    }
  }

  get closed(): boolean {
    return this.#closed;
  }
}

type StoreEntry = {
  readonly lock: RWLock;
  readonly db: SQLiteDatabase;
  refCount: number;
  activeReaders: number;
  preparedStatements: PreparedStatements;
};

// Global map to share database connections between multiple store instances with the same name
const stores = new Map<string, StoreEntry>();

/**
 * Gets an existing store entry or creates a new one if it doesn't exist.
 * This implements the shared connection pattern where multiple stores with the same
 * name share the same database connection, lock, and delegate.
 */
function getOrCreateEntry(
  name: string,
  create: (filename: string, opts?: SQLiteStoreOptions) => SQLiteDatabase,
  opts?: SQLiteStoreOptions,
): StoreEntry {
  const filename = safeFilename(name);
  const entry = stores.get(filename);

  if (entry) {
    entry.refCount++;
    return entry;
  }

  const dbDelegate = create(filename, opts);
  const preparedStatements = setupDatabase(dbDelegate, opts);

  const lock = new RWLock();

  const newEntry: StoreEntry = {
    lock,
    db: dbDelegate,
    refCount: 1,
    activeReaders: 0,
    preparedStatements,
  };
  stores.set(filename, newEntry);
  return newEntry;
}

/**
 * Decrements the reference count for a shared store and cleans up resources
 * when the last reference is released.
 */

function decrementStoreRefCount(
  filename: string,
  dbDelegate: SQLiteDatabase,
): void {
  const entry = stores.get(filename);
  if (entry) {
    entry.refCount--;
    if (entry.refCount <= 0) {
      dbDelegate.close();
      stores.delete(filename);
    }
  }
}
export function clearAllNamedStoresForTesting(): void {
  for (const entry of stores.values()) {
    entry.db.close();
  }
  stores.clear();
}

export function dropStore(
  name: string,
  createDelegate: (
    filename: string,
    opts?: SQLiteStoreOptions,
  ) => SQLiteDatabase,
): Promise<void> {
  const filename = safeFilename(name);
  const entry = stores.get(filename);
  if (entry) {
    try {
      entry.db.close();
    } catch {
      // Ignore close errors
    }
    stores.delete(filename);
  }

  // Create a temporary delegate to handle database deletion
  const tempDelegate = createDelegate(filename);
  try {
    // we close the db before destroying it - this
    // caused an issue with expo-sqlite since it requires this
    tempDelegate.close();
  } catch {
    // Ignore close errors
  }
  try {
    tempDelegate.destroy();
  } catch {
    // Destroy errors shouldn't be fatal; the file may already be gone or locked
  }

  return Promise.resolve();
}
