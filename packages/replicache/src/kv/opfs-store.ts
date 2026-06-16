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
 *
 * Read-through cache: the cross-thread round-trip (not the payload copy) is what
 * bounds point reads, so a bounded LRU value cache is kept on the main thread.
 * A `get`/`has` hit is served without touching the worker at all (zero
 * round-trips); a successful `commit` updates the cache from the just-written
 * batch so it stays warm. This is safe because the write lock excludes readers
 * during a commit, and in Replicache's usage values are content-addressed
 * (immutable per key). The cache size is configurable; 0 disables it entirely.
 *
 * Multiple tabs: an exclusive sync access handle would let only the first tab
 * open a given store (every other tab's open throws `NoModificationAllowedError`
 * — verified on Chromium 141). To support concurrent tabs, each tab instead
 * opens its **own** handle in `readwrite-unsafe` mode; such handles to the same
 * file see each other's flushed writes (also verified). Coordination is then:
 *
 * - A cross-tab read/write lock via the **Web Locks API** (`navigator.locks`):
 *   reads take it `shared`, commits and compaction take it `exclusive`. This is
 *   the cross-tab analog of the in-process {@link RWLock} and, crucially,
 *   excludes readers during a compaction (the one operation that moves existing
 *   value offsets). Web Locks auto-release if a tab crashes, so a dead tab can't
 *   wedge the others.
 * - A **`BroadcastChannel`** announces which keys each commit changed; other
 *   tabs evict exactly those keys from their LRU and mark their worker index
 *   stale.
 * - Before a read (when stale) and before every commit, the worker **resyncs**:
 *   it folds any bytes appended by other tabs into its index, or fully re-scans
 *   if the file shrank (another tab compacted).
 *
 * Set `multiTab: false` to skip all of this (single-handle, no Web Lock / no
 * BroadcastChannel) when the store is known to be owned by one tab.
 *
 * Consistency note: writes are strictly serialized across tabs by the exclusive
 * Web Lock, and within a tab the worker always resyncs before reading, so a tab
 * never reads a torn or stale value *from disk*. The main-thread LRU, however,
 * is invalidated via an asynchronous `BroadcastChannel` message that is not
 * ordered against the lock handoff, so cross-tab *cache* coherence is eventual:
 * for a brief window after another tab commits, a cached read here may return
 * the previous value. This matches Replicache's existing model (it polls/render
 * on its own cadence and values are immutable per key); set `cacheSize: 0` if a
 * store needs strict cross-tab read-after-write on every get.
 */

const FILE_PREFIX = 'rep-opfs-';

/** Default number of values kept in the main-thread read-through cache. */
const DEFAULT_CACHE_SIZE = 1000;

/** Options for {@link OPFSStore}. */
export type OPFSStoreOptions = {
  /**
   * Maximum number of values to keep in the main-thread read-through LRU cache.
   * Hits are served without a worker round-trip. Set to 0 to disable caching
   * (every `get` goes to the worker). Defaults to {@link DEFAULT_CACHE_SIZE}.
   */
  cacheSize?: number | undefined;

  /**
   * Coordinate concurrent access from multiple tabs (Web Locks +
   * BroadcastChannel + `readwrite-unsafe` handle). Defaults to `true`. Set to
   * `false` for a lighter single-owner store that opens an exclusive handle and
   * skips cross-tab coordination; a second tab opening the same store will then
   * fail to open.
   */
  multiTab?: boolean | undefined;
};

// A deleted/absent key is cached as this sentinel so negative lookups (has ===
// false, get === undefined) also avoid a worker round-trip.
const ABSENT = Symbol('absent');
type Cached = FrozenJSONValue | typeof ABSENT;

/**
 * Tiny bounded LRU over a Map (insertion-ordered). Recency is maintained by
 * delete+set on access; eviction drops the oldest entry. A `size` of 0 makes
 * every operation a no-op.
 */
class LRU {
  readonly #max: number;
  readonly #map = new Map<string, Cached>();

  constructor(max: number) {
    this.#max = max;
  }

  get(key: string): Cached | undefined {
    if (this.#max === 0) {
      return undefined;
    }
    const v = this.#map.get(key);
    if (v !== undefined) {
      // Touch: move to most-recently-used.
      this.#map.delete(key);
      this.#map.set(key, v);
    }
    return v;
  }

  set(key: string, value: Cached): void {
    if (this.#max === 0) {
      return;
    }
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.#max) {
      // Evict least-recently-used (first key in insertion order).
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) {
        this.#map.delete(oldest);
      }
    }
  }

  // Drop a key entirely (used when another tab reports it changed). The next
  // read then misses and re-fetches the authoritative value from the worker.
  invalidate(key: string): void {
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }
}

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
let fileSize = 0;     // bytes of the file this worker has folded into its index
let liveBytes = 0;
let multiTab = false; // when false, this worker is the sole writer: skip resync

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

// Bring this worker's index up to date with whatever other tabs have written to
// the shared file since we last looked. Cheap when nothing changed (one
// getSize). If the file grew, fold only the appended tail; if it shrank, another
// tab compacted, so re-scan from scratch.
function resync() {
  if (!multiTab) return; // sole writer: our index is already authoritative
  const actual = handle.getSize();
  if (actual === fileSize) return;
  if (actual < fileSize) {
    // File was compacted/truncated by another tab: rebuild the whole index.
    index.clear();
    liveBytes = 0;
    fileSize = 0;
  }
  if (actual > fileSize) {
    const tail = new Uint8Array(actual - fileSize);
    const read = handle.read(tail, {at: fileSize});
    if (read !== tail.length) throw new Error('short read during resync');
    foldBuffer(tail, fileSize);
    fileSize = actual;
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
  // Append at the true end of file, not our cached fileSize, so we never
  // clobber bytes another tab appended since our last resync.
  resync();
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
      multiTab = !!e.data.multiTab;
      // multiTab => readwrite-unsafe so each tab can hold its own handle; such
      // handles to the same file see each other's flushed writes.
      handle = multiTab
        ? await fh.createSyncAccessHandle({mode: 'readwrite-unsafe'})
        : await fh.createSyncAccessHandle();
      fileSize = handle.getSize();
      if (fileSize > 0) {
        const all = new Uint8Array(fileSize);
        const read = handle.read(all, {at: 0});
        if (read !== fileSize) throw new Error('short read while scanning');
        foldBuffer(all, 0);
      }
    } else if (op === 'resync') {
      resync();
    } else if (op === 'has') {
      resync();
      result = index.has(e.data.key);
    } else if (op === 'get') {
      resync();
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

/**
 * Bridge the Web Locks API (callback-scoped) to our acquire/release model. The
 * lock is held for as long as the callback's promise is unresolved, so we
 * resolve the acquire promise with a release function that settles it.
 */
function acquireWebLock(
  name: string,
  mode: 'shared' | 'exclusive',
): Promise<() => void> {
  const {promise: acquired, resolve, reject} = resolver<() => void>();
  navigator.locks
    .request(name, {mode}, () => {
      const {promise: held, resolve: release} = resolver<void>();
      resolve(release);
      return held; // hold the lock until release() is called
    })
    .catch(reject); // if the request itself fails, fail the acquire
  return acquired;
}

// BroadcastChannel message: keys whose values a commit in another tab changed.
type ChangeMessage = {keys: string[]};

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

  open(name: string, multiTab: boolean): Promise<void> {
    return this.#call('open', {fileName: fileName(name), multiTab});
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
  readonly #multiTab: boolean;
  // Same-tab serialization. In multi-tab mode the cross-tab Web Lock provides
  // the real mutual exclusion; this still guards the per-tab worker/cache.
  readonly #rwLock = new RWLock();
  readonly #cache: LRU;
  // Cross-tab coordination (multi-tab mode only).
  readonly #lockName: string | undefined;
  readonly #channel: BroadcastChannel | undefined;
  #client: WorkerClient | null = null;
  #openPromise: Promise<WorkerClient> | null = null;
  #closed = false;

  constructor(name: string, options?: OPFSStoreOptions) {
    this.#name = name;
    this.#cache = new LRU(options?.cacheSize ?? DEFAULT_CACHE_SIZE);
    this.#multiTab = options?.multiTab ?? true;
    if (this.#multiTab) {
      this.#lockName = 'rep-opfs-lock-' + name;
      this.#channel = new BroadcastChannel('rep-opfs-chan-' + name);
      // Another tab committed: drop exactly those keys so our next read
      // re-fetches the authoritative value (and our worker resyncs the tail).
      this.#channel.onmessage = (e: MessageEvent<ChangeMessage>) => {
        for (const key of e.data.keys) {
          this.#cache.invalidate(key);
        }
      };
    }
  }

  #open(): Promise<WorkerClient> {
    if (this.#client) {
      return Promise.resolve(this.#client);
    }
    if (!this.#openPromise) {
      const client = new WorkerClient();
      this.#openPromise = client.open(this.#name, this.#multiTab).then(() => {
        this.#client = client;
        return client;
      });
    }
    return this.#openPromise;
  }

  // Acquire the cross-tab Web Lock (no-op in single-tab mode). Returns a release
  // callback; in single-tab mode it is a no-op.
  #acquireCrossTab(mode: 'shared' | 'exclusive'): Promise<() => void> {
    if (this.#lockName === undefined) {
      return Promise.resolve(() => {});
    }
    return acquireWebLock(this.#lockName, mode);
  }

  async read(): Promise<Read> {
    throwIfStoreClosed(this);
    const client = await this.#open();
    const crossTab = await this.#acquireCrossTab('shared');
    const local = await this.#rwLock.read();
    const release = () => {
      local();
      crossTab();
    };
    return new ReadImpl(client, this.#cache, release);
  }

  async write(): Promise<Write> {
    throwIfStoreClosed(this);
    const client = await this.#open();
    const crossTab = await this.#acquireCrossTab('exclusive');
    const local = await this.#rwLock.write();
    const release = () => {
      local();
      crossTab();
    };
    return new WriteImpl(client, this.#cache, release, this.#channel);
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
    this.#channel?.close();
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }
}

class ReadImpl implements Read {
  readonly #client: WorkerClient;
  readonly #cache: LRU;
  readonly #release: () => void;
  #closed = false;

  constructor(client: WorkerClient, cache: LRU, release: () => void) {
    this.#client = client;
    this.#cache = cache;
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
    const rejection = maybeTransactionIsClosedRejection(this);
    if (rejection) {
      return rejection;
    }
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached !== ABSENT);
    }
    // On a miss, use the worker's cheap index-only `has` rather than fetching
    // (and caching) the whole value, which a caller of `has` does not want.
    return this.#client.has(key);
  }

  async get(key: string): Promise<FrozenJSONValue | undefined> {
    const rejection = maybeTransactionIsClosedRejection(this);
    if (rejection) {
      return rejection;
    }
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return cached === ABSENT ? undefined : cached;
    }
    const {found, buffer} = await this.#client.get(key);
    if (!found || buffer === null) {
      this.#cache.set(key, ABSENT);
      return undefined;
    }
    const value = deepFreeze(
      JSON.parse(textDecoder.decode(new Uint8Array(buffer))),
    );
    this.#cache.set(key, value);
    return value;
  }
}

class WriteImpl extends WriteImplBase implements Write {
  readonly #client: WorkerClient;
  readonly #cache: LRU;
  readonly #channel: BroadcastChannel | undefined;

  constructor(
    client: WorkerClient,
    cache: LRU,
    release: () => void,
    channel: BroadcastChannel | undefined,
  ) {
    super(new ReadImpl(client, cache, release));
    this.#client = client;
    this.#cache = cache;
    this.#channel = channel;
  }

  async commit(): Promise<void> {
    if (this.closed) {
      return transactionIsClosedRejection();
    }
    if (this._pending.size === 0) {
      return promiseVoid;
    }
    const changedKeys = [...this._pending.keys()];
    const buffer = encodeBatch(this._pending);
    await this.#client.commit(buffer);
    // Worker write succeeded and we still hold the write lock, so the cache can
    // be brought forward from the just-committed batch without racing readers.
    for (const [key, value] of this._pending) {
      this.#cache.set(key, value === deleteSentinel ? ABSENT : value);
    }
    this._pending.clear();
    // Tell other tabs which keys changed so they drop them from their caches.
    this.#channel?.postMessage({keys: changedKeys} satisfies ChangeMessage);
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
