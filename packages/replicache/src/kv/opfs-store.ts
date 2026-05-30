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
 * - A commit is encoded on the main thread into one contiguous buffer and
 *   appended to the file with a single `write` + `flush` in the worker.
 * - A read is a single `read` of just the value bytes at the indexed offset.
 * - On open the log is scanned once to rebuild the index.
 * - When the log accumulates enough dead bytes (overwritten/deleted entries) it
 *   is compacted in place.
 *
 * Why a worker: `createSyncAccessHandle()` is only exposed on a Web Worker (it
 * is not on the main thread in any shipping browser — verified on Chromium
 * 141). The engine therefore runs in a dedicated worker. To keep the
 * cross-thread cost low, the value/commit byte buffers are **transferred**
 * (zero-copy) rather than structured-cloned:
 *
 * - `get` transfers the value bytes from the worker to the main thread; the
 *   main thread does the `JSON.parse` (no string copy across the boundary).
 * - `commit` encodes the whole batch into one `ArrayBuffer` on the main thread
 *   and transfers it into the worker, which writes it verbatim.
 *
 * Strict serializable transactions are provided by an `RWLock` on the main
 * thread (multiple concurrent readers or a single writer), exactly like
 * {@link MemStore}; the worker processes the resulting messages one at a time.
 */

const FILE_PREFIX = 'rep-opfs-';

// Log record format (little-endian):
//   tag:uint8 (0=put, 1=del) | keyLen:uint32 | valLen:uint32 | key | value
const HEADER_SIZE = 9;
const TAG_PUT = 0;
const TAG_DEL = 1;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function fileName(name: string): string {
  return FILE_PREFIX + encodeURIComponent(name) + '.log';
}

/**
 * Encode a pending mutation batch into a single contiguous buffer in the log
 * record format. The resulting buffer is transferred into the worker and
 * written verbatim; the worker re-scans it to update its index.
 */
function encodeBatch(
  pending: Map<string, FrozenJSONValue | typeof deleteSentinel>,
): ArrayBuffer {
  const encoded: {tag: number; keyBytes: Uint8Array; valBytes: Uint8Array}[] =
    [];
  let total = 0;
  for (const [key, value] of pending) {
    const isDel = value === deleteSentinel;
    const keyBytes = textEncoder.encode(key);
    const valBytes = isDel
      ? new Uint8Array(0)
      : textEncoder.encode(JSON.stringify(value));
    encoded.push({tag: isDel ? TAG_DEL : TAG_PUT, keyBytes, valBytes});
    total += HEADER_SIZE + keyBytes.length + valBytes.length;
  }

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let pos = 0;
  for (const {tag, keyBytes, valBytes} of encoded) {
    view.setUint8(pos, tag);
    view.setUint32(pos + 1, keyBytes.length, true);
    view.setUint32(pos + 5, valBytes.length, true);
    buf.set(keyBytes, pos + HEADER_SIZE);
    buf.set(valBytes, pos + HEADER_SIZE + keyBytes.length);
    pos += HEADER_SIZE + keyBytes.length + valBytes.length;
  }
  return buf.buffer;
}

/**
 * Source for the worker that owns the OPFS sync access handle. Kept
 * dependency-free so it can be loaded from a Blob URL without a bundler step.
 */
const WORKER_SRC = `
const HEADER_SIZE = 9;
const TAG_PUT = 0;
const TAG_DEL = 1;
const COMPACT_RATIO = 2;
const MIN_COMPACT_BYTES = 64 * 1024;
const dec = new TextDecoder();

let handle = null;
const index = new Map(); // key -> {offset, length}
let fileSize = 0;
let liveBytes = 0;

// Scan a buffer of log records and fold it into the index. Offsets in the index
// are absolute file offsets, so records are placed at base + their position.
function foldBuffer(buf, base) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  while (pos + HEADER_SIZE <= buf.length) {
    const tag = view.getUint8(pos);
    const keyLen = view.getUint32(pos + 1, true);
    const valLen = view.getUint32(pos + 5, true);
    const keyStart = pos + HEADER_SIZE;
    const valStart = keyStart + keyLen;
    const next = valStart + valLen;
    if (next > buf.length) break; // truncated trailing record
    const key = dec.decode(buf.subarray(keyStart, valStart));
    const existing = index.get(key);
    if (existing) liveBytes -= existing.length;
    if (tag === TAG_DEL) {
      index.delete(key);
    } else {
      index.set(key, {offset: base + valStart, length: valLen});
      liveBytes += valLen;
    }
    pos = next;
  }
}

function get(key) {
  const entry = index.get(key);
  if (entry === undefined) return null;
  const buf = new Uint8Array(entry.length);
  const read = handle.read(buf, {at: entry.offset});
  if (read !== entry.length) throw new Error('short read while reading value');
  return buf;
}

function commit(buf) {
  if (buf.length === 0) return;
  const base = fileSize;
  const written = handle.write(buf, {at: base});
  if (written !== buf.length) throw new Error('short write while committing');
  handle.flush();
  fileSize = base + written;
  foldBuffer(buf, base);
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
    const keyBytes = new TextEncoder().encode(key);
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
  liveBytes = 0;
  for (const [key, entry] of newIndex) {
    index.set(key, entry);
    liveBytes += entry.length;
  }
}

self.onmessage = async e => {
  const {id, op} = e.data;
  try {
    let result = null;
    let transfer = [];
    if (op === 'open') {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(e.data.fileName, {create: true});
      handle = await fh.createSyncAccessHandle();
      fileSize = handle.getSize();
      if (fileSize > 0) {
        const all = new Uint8Array(fileSize);
        const read = handle.read(all, {at: 0});
        if (read !== fileSize) throw new Error('short read while scanning');
        foldBuffer(all, 0);
      }
    } else if (op === 'has') {
      result = index.has(e.data.key);
    } else if (op === 'get') {
      const bytes = get(e.data.key);
      if (bytes === null) {
        result = {found: false, buffer: null};
      } else {
        result = {found: true, buffer: bytes.buffer};
        transfer = [bytes.buffer]; // zero-copy hand-off to the main thread
      }
    } else if (op === 'commit') {
      commit(new Uint8Array(e.data.buffer));
    } else if (op === 'close') {
      if (handle) handle.close();
      handle = null;
    } else {
      throw new Error('unknown op ' + op);
    }
    self.postMessage({id, ok: true, result}, transfer);
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

type GetResult = {found: boolean; buffer: ArrayBuffer | null};

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
      if (!p) {
        return;
      }
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

  #call<T>(
    op: string,
    payload?: Record<string, unknown>,
    transfer?: Transferable[],
  ): Promise<T> {
    const id = this.#nextId++;
    const {promise, resolve, reject} = resolver<T>();
    this.#pending.set(id, {resolve: resolve as (v: unknown) => void, reject});
    this.#worker.postMessage({id, op, ...payload}, transfer ?? []);
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

  commit(buffer: ArrayBuffer): Promise<void> {
    // Transfer the encoded batch into the worker (zero-copy).
    return this.#call('commit', {buffer}, [buffer]);
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
    const {found, buffer} = await this.#client.get(key);
    if (!found || buffer === null) {
      return undefined;
    }
    return deepFreeze(JSON.parse(textDecoder.decode(new Uint8Array(buffer))));
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
    const buffer = encodeBatch(this._pending);
    await this.#client.commit(buffer);
    this._pending.clear();
    return undefined;
  }

  // release() is inherited from WriteImplBase, which releases the underlying
  // ReadImpl (and thus the RWLock write lock). withWrite() calls commit() then
  // release(); only release() touches the lock, so it is released exactly once.
}

/**
 * Deletes the underlying OPFS file for the named store. The store must be closed
 * first, otherwise the worker's open sync access handle keeps the file locked.
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
