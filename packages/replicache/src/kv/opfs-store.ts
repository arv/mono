import {RWLock} from '@rocicorp/lock';
import {resolver} from '@rocicorp/resolver';
import {promiseVoid} from '../../../shared/src/resolved-promises.ts';
import {deepFreeze, type FrozenJSONValue} from '../frozen-json.ts';
import type {Read, Store, Write} from './store.ts';
import {
  maybeTransactionIsClosedRejection,
  throwIfStoreClosed,
  transactionIsClosedRejection,
} from './throw-if-closed.ts';
import {WriteImplBase, deleteSentinel} from './write-impl-base.ts';

/**
 * An OPFS (Origin Private File System / Web File System API) backed
 * implementation of {@link Store}, as an alternative to {@link IDBStore}.
 *
 * Storage engine: a log-structured store. All data for a named store lives in a
 * single append-only log file accessed through a synchronous
 * {@link FileSystemSyncAccessHandle}, with an in-memory index mapping each key
 * to the `{offset, length}` of its most recently written value.
 *
 * - Writes are a single synchronous `write` + `flush` of the whole commit batch
 *   appended to the end of the file (one syscall round-trip per transaction).
 * - Reads do a single synchronous `read` of just the value bytes at the indexed
 *   offset, then `JSON.parse`. Values are not cached, so read latency reflects
 *   actually going to disk — a fair comparison against IndexedDB.
 * - On open the log is scanned once to rebuild the index.
 * - When the log accumulates enough dead bytes (overwritten/deleted entries) it
 *   is compacted in place.
 *
 * Why a Worker: `createSyncAccessHandle()` is only exposed on a Web Worker in
 * most shipping browsers (main-thread support is very recent). The engine
 * therefore runs in a dedicated worker and the main thread talks to it over a
 * small request/response protocol. Strict serializable transactions are
 * provided by an `RWLock` on the main thread (multiple concurrent readers or a
 * single writer), exactly like {@link MemStore}; the worker processes the
 * resulting messages one at a time.
 */

const FILE_PREFIX = 'rep-opfs-';

function fileName(name: string): string {
  return FILE_PREFIX + encodeURIComponent(name) + '.log';
}

/**
 * Source for the worker that owns the OPFS sync access handle. It is kept
 * dependency-free so it can be loaded from a Blob URL without a bundler step.
 *
 * Log record format (little-endian):
 *   tag:   uint8   (0 = put, 1 = delete)
 *   keyLen: uint32
 *   valLen: uint32
 *   key bytes (utf-8)
 *   value bytes (utf-8 JSON; empty for deletes)
 */
const WORKER_SRC = `
const HEADER_SIZE = 9;
const TAG_PUT = 0;
const TAG_DEL = 1;
const COMPACT_RATIO = 2;
const MIN_COMPACT_BYTES = 64 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

let handle = null;
const index = new Map(); // key -> {offset, length}
let fileSize = 0;
let liveBytes = 0;

function scan() {
  if (fileSize === 0) return;
  const buf = new Uint8Array(fileSize);
  const read = handle.read(buf, {at: 0});
  if (read !== fileSize) throw new Error('short read while scanning');
  const view = new DataView(buf.buffer);
  let pos = 0;
  while (pos + HEADER_SIZE <= fileSize) {
    const tag = view.getUint8(pos);
    const keyLen = view.getUint32(pos + 1, true);
    const valLen = view.getUint32(pos + 5, true);
    const keyStart = pos + HEADER_SIZE;
    const valStart = keyStart + keyLen;
    const next = valStart + valLen;
    if (next > fileSize) break; // truncated trailing record
    const key = dec.decode(buf.subarray(keyStart, valStart));
    const existing = index.get(key);
    if (existing) liveBytes -= existing.length;
    if (tag === TAG_DEL) {
      index.delete(key);
    } else {
      index.set(key, {offset: valStart, length: valLen});
      liveBytes += valLen;
    }
    pos = next;
  }
}

function has(key) {
  return index.has(key);
}

function get(key) {
  const entry = index.get(key);
  if (entry === undefined) return {found: false, str: null};
  const buf = new Uint8Array(entry.length);
  const read = handle.read(buf, {at: entry.offset});
  if (read !== entry.length) throw new Error('short read while reading value');
  return {found: true, str: dec.decode(buf)};
}

// entries: array of [key, strOrNull]; null means delete.
function commit(entries) {
  if (entries.length === 0) return;
  const encoded = [];
  let total = 0;
  for (const [key, str] of entries) {
    const keyBytes = enc.encode(key);
    const valBytes = str === null ? new Uint8Array(0) : enc.encode(str);
    encoded.push({del: str === null, key, keyBytes, valBytes});
    total += HEADER_SIZE + keyBytes.length + valBytes.length;
  }
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  const base = fileSize;
  let pos = 0;
  const updates = [];
  for (const e of encoded) {
    view.setUint8(pos, e.del ? TAG_DEL : TAG_PUT);
    view.setUint32(pos + 1, e.keyBytes.length, true);
    view.setUint32(pos + 5, e.valBytes.length, true);
    buf.set(e.keyBytes, pos + HEADER_SIZE);
    const valStart = pos + HEADER_SIZE + e.keyBytes.length;
    buf.set(e.valBytes, valStart);
    updates.push(
      e.del ? [e.key, null] : [e.key, {offset: base + valStart, length: e.valBytes.length}],
    );
    pos += HEADER_SIZE + e.keyBytes.length + e.valBytes.length;
  }
  const written = handle.write(buf, {at: base});
  if (written !== total) throw new Error('short write while committing');
  handle.flush();
  fileSize = base + total;
  for (const [key, entry] of updates) {
    const prev = index.get(key);
    if (prev) liveBytes -= prev.length;
    if (entry === null) {
      index.delete(key);
    } else {
      index.set(key, entry);
      liveBytes += entry.length;
    }
  }
  maybeCompact();
}

function maybeCompact() {
  if (fileSize < MIN_COMPACT_BYTES || fileSize <= liveBytes * COMPACT_RATIO) {
    return;
  }
  const live = [];
  let total = 0;
  for (const [key, entry] of index) {
    const valBytes = new Uint8Array(entry.length);
    const read = handle.read(valBytes, {at: entry.offset});
    if (read !== entry.length) throw new Error('short read while compacting');
    const keyBytes = enc.encode(key);
    live.push([key, keyBytes, valBytes]);
    total += HEADER_SIZE + keyBytes.length + valBytes.length;
  }
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let pos = 0;
  const newIndex = new Map();
  for (const [key, keyBytes, valBytes] of live) {
    view.setUint8(pos, TAG_PUT);
    view.setUint32(pos + 1, keyBytes.length, true);
    view.setUint32(pos + 5, valBytes.length, true);
    buf.set(keyBytes, pos + HEADER_SIZE);
    const valStart = pos + HEADER_SIZE + keyBytes.length;
    buf.set(valBytes, valStart);
    newIndex.set(key, {offset: valStart, length: valBytes.length});
    pos += HEADER_SIZE + keyBytes.length + valBytes.length;
  }
  handle.truncate(0);
  const written = handle.write(buf, {at: 0});
  if (written !== total) throw new Error('short write while compacting');
  handle.flush();
  fileSize = total;
  index.clear();
  for (const [key, entry] of newIndex) index.set(key, entry);
}

self.onmessage = async e => {
  const {id, op} = e.data;
  try {
    let result = null;
    if (op === 'open') {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(e.data.fileName, {create: true});
      handle = await fh.createSyncAccessHandle();
      fileSize = handle.getSize();
      scan();
    } else if (op === 'get') {
      result = get(e.data.key);
    } else if (op === 'has') {
      result = has(e.data.key);
    } else if (op === 'commit') {
      commit(e.data.entries);
    } else if (op === 'close') {
      if (handle) handle.close();
      handle = null;
    } else {
      throw new Error('unknown op ' + op);
    }
    self.postMessage({id, ok: true, result});
  } catch (err) {
    self.postMessage({id, ok: false, error: String((err && err.stack) || err)});
  }
};
`;

let workerURL: string | undefined;
function getWorkerURL(): string {
  if (workerURL === undefined) {
    workerURL = URL.createObjectURL(
      new Blob([WORKER_SRC], {type: 'text/javascript'}),
    );
  }
  return workerURL;
}

type GetResult = {found: boolean; str: string | null};

/** Thin promise-based RPC wrapper around the OPFS worker. */
class WorkerClient {
  readonly #worker: Worker;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    {resolve: (v: unknown) => void; reject: (e: unknown) => void}
  >();

  constructor() {
    this.#worker = new Worker(getWorkerURL());
    this.#worker.onmessage = (e: MessageEvent) => {
      const {id, ok, result, error} = e.data;
      const p = this.#pending.get(id);
      if (!p) return;
      this.#pending.delete(id);
      if (ok) {
        p.resolve(result);
      } else {
        p.reject(new Error('OPFS worker error: ' + error));
      }
    };
    this.#worker.onerror = e => {
      const err = new Error('OPFS worker crashed: ' + e.message);
      for (const p of this.#pending.values()) {
        p.reject(err);
      }
      this.#pending.clear();
    };
  }

  #call<T>(op: string, payload?: Record<string, unknown>): Promise<T> {
    const id = this.#nextId++;
    const {promise, resolve, reject} = resolver<T>();
    this.#pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    this.#worker.postMessage({id, op, ...payload});
    return promise;
  }

  open(name: string): Promise<void> {
    return this.#call('open', {fileName: fileName(name)});
  }

  has(key: string): Promise<boolean> {
    return this.#call('has', {key});
  }

  get(key: string): Promise<GetResult> {
    return this.#call('get', {key});
  }

  commit(entries: [string, string | null][]): Promise<void> {
    return this.#call('commit', {entries});
  }

  async close(): Promise<void> {
    await this.#call('close');
    this.#worker.terminate();
  }
}

export class OPFSStore implements Store {
  readonly #name: string;
  readonly #rwLock = new RWLock();
  #client: WorkerClient | null = null;
  #openPromise: Promise<WorkerClient> | null = null;
  #closed = false;

  constructor(name: string) {
    this.#name = name;
  }

  #open(): Promise<WorkerClient> {
    if (this.#client) {
      return Promise.resolve(this.#client);
    }
    if (!this.#openPromise) {
      const client = new WorkerClient();
      this.#openPromise = client.open(this.#name).then(() => {
        this.#client = client;
        return client;
      });
    }
    return this.#openPromise;
  }

  async read(): Promise<Read> {
    throwIfStoreClosed(this);
    const client = await this.#open();
    const release = await this.#rwLock.read();
    return new ReadImpl(client, release);
  }

  async write(): Promise<Write> {
    throwIfStoreClosed(this);
    const client = await this.#open();
    const release = await this.#rwLock.write();
    return new WriteImpl(client, release);
  }

  async close(): Promise<void> {
    if (this.#client) {
      // Wait for any in-flight transactions to release their locks first.
      const release = await this.#rwLock.write();
      try {
        await this.#client.close();
      } finally {
        this.#client = null;
        release();
      }
    }
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }
}

class ReadImpl implements Read {
  readonly #client: WorkerClient;
  readonly #release: () => void;
  #closed = false;

  constructor(client: WorkerClient, release: () => void) {
    this.#client = client;
    this.#release = release;
  }

  release(): void {
    this.#release();
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }

  has(key: string): Promise<boolean> {
    return maybeTransactionIsClosedRejection(this) ?? this.#client.has(key);
  }

  async get(key: string): Promise<FrozenJSONValue | undefined> {
    const rejection = maybeTransactionIsClosedRejection(this);
    if (rejection) {
      return rejection;
    }
    const {found, str} = await this.#client.get(key);
    if (!found) {
      return undefined;
    }
    return deepFreeze(JSON.parse(str as string));
  }
}

class WriteImpl extends WriteImplBase implements Write {
  readonly #client: WorkerClient;

  constructor(client: WorkerClient, release: () => void) {
    super(new ReadImpl(client, release));
    this.#client = client;
  }

  async commit(): Promise<void> {
    if (this.closed) {
      return transactionIsClosedRejection();
    }
    if (this._pending.size === 0) {
      return promiseVoid;
    }
    const entries: [string, string | null][] = [];
    for (const [key, value] of this._pending) {
      entries.push([
        key,
        value === deleteSentinel ? null : JSON.stringify(value),
      ]);
    }
    await this.#client.commit(entries);
    this._pending.clear();
  }

  // release() is inherited from WriteImplBase, which releases the underlying
  // ReadImpl (and thus the RWLock write lock). withWrite() calls commit() then
  // release(); only release() touches the lock, so it is released exactly once.
}

/**
 * Deletes the underlying OPFS file for the named store. The store must be closed
 * first, otherwise the worker's exclusive sync access handle keeps the file
 * locked.
 */
export async function dropOPFSStore(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(fileName(name));
  } catch (e) {
    if ((e as DOMException)?.name !== 'NotFoundError') {
      throw e;
    }
  }
}
