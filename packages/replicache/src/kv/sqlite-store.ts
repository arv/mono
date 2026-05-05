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

  /**
   * Execute an ad-hoc SQL query and return all result rows as `[col0, col1]`
   * pairs. Implementing this enables the batch {@link SQLiteStoreRead.getMany}
   * optimisation, which issues a single `SELECT … IN (…)` instead of one
   * round-trip per key. If omitted the implementation falls back to sequential
   * {@link PreparedStatement.firstValue} calls.
   */
  executeForRows?(sql: string, params: string[]): Promise<[string, string][]>;

  /**
   * Insert or replace multiple rows in a single SQL statement.
   * Implementing this enables {@link SQLiteWrite.putMany} to issue one
   * `INSERT OR REPLACE INTO entry (key, value) VALUES (?,?),(?,?),...`
   * instead of one bridge crossing per entry. If omitted the implementation
   * falls back to concurrent {@link PreparedStatement.exec} calls.
   *
   * SQLite's default variable limit is 999; each row uses 2 params, so
   * callers should not exceed ~499 entries per call.
   */
  insertManyRows?(entries: [string, string][]): Promise<void>;
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
  readonly supportsBulkReads = true;

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

    return new SQLiteStoreRead(
      () => {
        entry.activeReaders--;
        // Commit shared read transaction when last reader finishes
        if (entry.activeReaders === 0) {
          db.execSync('COMMIT');
        }
        release();
      },
      preparedStatements,
      db,
    );
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
  };
}

/**
 * Fetch multiple keys in a single `SELECT … IN (…)` query when the database
 * supports {@link SQLiteDatabase.executeForRows}. Falls back to sequential
 * individual gets otherwise.
 */
async function sqliteBatchGet(
  db: SQLiteDatabase,
  keys: string[],
  getFallback: (key: string) => Promise<ReadonlyJSONValue | undefined>,
): Promise<(ReadonlyJSONValue | undefined)[]> {
  if (keys.length === 0) {
    return [];
  }
  if (!db.executeForRows) {
    return Promise.all(keys.map(getFallback));
  }
  const placeholders = keys.map(() => '?').join(',');
  const rows = await db.executeForRows(
    `SELECT key, value FROM entry WHERE key IN (${placeholders})`,
    keys,
  );
  const resultMap = new Map<string, ReadonlyJSONValue>();
  for (const [key, jsonValue] of rows) {
    resultMap.set(key, deepFreeze(JSON.parse(jsonValue)));
  }
  return keys.map(k => resultMap.get(k));
}

export class SQLiteStoreRead implements Read {
  #release: () => void;
  #closed = false;
  #preparedStatements: PreparedStatements;
  #db: SQLiteDatabase;

  constructor(
    release: () => void,
    preparedStatements: PreparedStatements,
    db: SQLiteDatabase,
  ) {
    this.#release = release;
    this.#preparedStatements = preparedStatements;
    this.#db = db;
  }

  async has(key: string): Promise<boolean> {
    throwIfTransactionClosed(this);
    const value = await this.#preparedStatements.has.firstValue([key]);
    return value !== undefined;
  }

  async get(key: string): Promise<ReadonlyJSONValue | undefined> {
    throwIfTransactionClosed(this);
    const value = await this.#preparedStatements.get.firstValue([key]);
    if (!value) {
      return undefined;
    }

    const parsedValue = JSON.parse(value as string) as ReadonlyJSONValue;
    return deepFreeze(parsedValue);
  }

  getMany(keys: string[]): Promise<(ReadonlyJSONValue | undefined)[]> {
    return (
      maybeTransactionIsClosedRejection(this) ??
      sqliteBatchGet(this.#db, keys, k => this.get(k))
    );
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

  constructor(
    release: () => void,
    dbDelegate: SQLiteDatabase,
    preparedStatements: PreparedStatements,
  ) {
    this.#release = release;
    this.#dbDelegate = dbDelegate;
    this.#preparedStatements = preparedStatements;
  }

  async has(key: string): Promise<boolean> {
    throwIfTransactionClosed(this);
    const value = await this.#preparedStatements.has.firstValue([key]);
    return value !== undefined;
  }

  async get(key: string): Promise<ReadonlyJSONValue | undefined> {
    throwIfTransactionClosed(this);
    const value = await this.#preparedStatements.get.firstValue([key]);
    if (!value) {
      return undefined;
    }

    const parsedValue = JSON.parse(value as string) as ReadonlyJSONValue;
    return deepFreeze(parsedValue);
  }

  getMany(keys: string[]): Promise<(ReadonlyJSONValue | undefined)[]> {
    return (
      maybeTransactionIsClosedRejection(this) ??
      sqliteBatchGet(this.#dbDelegate, keys, k => this.get(k))
    );
  }

  async put(key: string, value: ReadonlyJSONValue): Promise<void> {
    throwIfTransactionClosed(this);
    await this.#preparedStatements.put.exec([key, JSON.stringify(value)]);
  }

  async putMany(entries: Iterable<[string, ReadonlyJSONValue]>): Promise<void> {
    throwIfTransactionClosed(this);
    const rows = Array.from(
      entries,
      ([k, v]) => [k, JSON.stringify(v)] as [string, string],
    );
    if (rows.length === 0) return;
    if (this.#dbDelegate.insertManyRows) {
      await this.#dbDelegate.insertManyRows(rows);
      return;
    }
    // Fall back to concurrent individual exec calls.
    await Promise.all(
      rows.map(([k, v]) => this.#preparedStatements.put.exec([k, v])),
    );
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
