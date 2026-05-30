import {RWLock} from '@rocicorp/lock';
import {assert} from '../../../shared/src/asserts.ts';
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
 * implementation of {@link Store}.
 *
 * Design: a log-structured store. All data lives in a single append-only log
 * file accessed through a {@link FileSystemSyncAccessHandle}. An in-memory index
 * maps each key to the `{offset, length}` of its most recently written value in
 * the log. This means:
 *
 * - Writes are a single synchronous `write` + `flush` of the whole commit batch
 *   appended to the end of the file (one syscall per transaction).
 * - Reads do a single synchronous `read` of just the value bytes at the indexed
 *   offset, then `JSON.parse`. Values are *not* cached in memory, so read
 *   performance reflects actually going to disk (a fair comparison to IDB).
 * - On open the log is scanned once to rebuild the index.
 * - When the log accumulates enough dead bytes (overwritten/deleted entries) it
 *   is compacted in place.
 *
 * Sync access handles historically required a Web Worker, but current Chromium
 * exposes them on the main thread as well, which is what this implementation
 * relies on. Like {@link IDBStore}, the implementation provides strict
 * serializable transactions via an `RWLock`.
 */

const FILE_PREFIX = 'rep-opfs-';
const HEADER_SIZE = 9; // tag(1) + keyLen(4) + valLen(4)
const TAG_PUT = 0;
const TAG_DEL = 1;

// Compact when the file is more than this factor larger than the live bytes
// (and at least MIN_COMPACT_BYTES, to avoid churning on tiny stores).
const COMPACT_RATIO = 2;
const MIN_COMPACT_BYTES = 64 * 1024;

const EMPTY = new Uint8Array(0);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type IndexEntry = {
  // Offset of the value bytes within the log file.
  offset: number;
  // Length of the value bytes.
  length: number;
};

function fileName(name: string): string {
  return FILE_PREFIX + encodeURIComponent(name) + '.log';
}

/**
 * The actual on-disk engine, shared across all read/write transactions of a
 * single {@link OPFSStore}.
 */
class OPFSLog {
  readonly #handle: FileSystemSyncAccessHandle;
  readonly #index: Map<string, IndexEntry> = new Map();
  #fileSize: number;
  // Sum of value bytes currently reachable from the index. Used to decide when
  // compaction is worthwhile.
  #liveValueBytes = 0;

  private constructor(handle: FileSystemSyncAccessHandle) {
    this.#handle = handle;
    this.#fileSize = handle.getSize();
    this.#scan();
  }

  static async open(name: string): Promise<OPFSLog> {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(fileName(name), {create: true});
    const handle = await fh.createSyncAccessHandle();
    return new OPFSLog(handle);
  }

  // Rebuild the in-memory index from the log file.
  #scan(): void {
    const size = this.#fileSize;
    if (size === 0) {
      return;
    }
    const buf = new Uint8Array(size);
    const read = this.#handle.read(buf, {at: 0});
    assert(read === size, 'short read while scanning OPFS log');
    const view = new DataView(buf.buffer);

    let pos = 0;
    while (pos + HEADER_SIZE <= size) {
      const tag = view.getUint8(pos);
      const keyLen = view.getUint32(pos + 1, true);
      const valLen = view.getUint32(pos + 5, true);
      const keyStart = pos + HEADER_SIZE;
      const valStart = keyStart + keyLen;
      const next = valStart + valLen;
      if (next > size) {
        // Truncated/partial trailing record (e.g. crash mid-write); ignore it.
        break;
      }
      const key = textDecoder.decode(buf.subarray(keyStart, valStart));
      const existing = this.#index.get(key);
      if (existing) {
        this.#liveValueBytes -= existing.length;
      }
      if (tag === TAG_DEL) {
        this.#index.delete(key);
      } else {
        this.#index.set(key, {offset: valStart, length: valLen});
        this.#liveValueBytes += valLen;
      }
      pos = next;
    }
  }

  has(key: string): boolean {
    return this.#index.has(key);
  }

  get(key: string): FrozenJSONValue | undefined {
    const entry = this.#index.get(key);
    if (entry === undefined) {
      return undefined;
    }
    const buf = new Uint8Array(entry.length);
    const read = this.#handle.read(buf, {at: entry.offset});
    assert(read === entry.length, 'short read while reading OPFS value');
    return deepFreeze(JSON.parse(textDecoder.decode(buf)));
  }

  // Apply a batch of pending changes as a single appended, flushed write.
  commit(pending: Map<string, FrozenJSONValue | typeof deleteSentinel>): void {
    if (pending.size === 0) {
      return;
    }

    // Encode all keys/values up front so we know the exact buffer size.
    type Encoded = {
      tag: number;
      key: string;
      keyBytes: Uint8Array;
      valBytes: Uint8Array;
    };
    const encoded: Encoded[] = [];
    let total = 0;
    for (const [key, value] of pending) {
      const isDel = value === deleteSentinel;
      const keyBytes = textEncoder.encode(key);
      const valBytes = isDel
        ? EMPTY
        : textEncoder.encode(JSON.stringify(value));
      encoded.push({tag: isDel ? TAG_DEL : TAG_PUT, key, keyBytes, valBytes});
      total += HEADER_SIZE + keyBytes.length + valBytes.length;
    }

    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    const base = this.#fileSize;
    let pos = 0;
    // Index updates are applied only after the write+flush succeeds.
    const updates: [string, IndexEntry | undefined][] = [];
    for (const {tag, key, keyBytes, valBytes} of encoded) {
      view.setUint8(pos, tag);
      view.setUint32(pos + 1, keyBytes.length, true);
      view.setUint32(pos + 5, valBytes.length, true);
      buf.set(keyBytes, pos + HEADER_SIZE);
      const valStart = pos + HEADER_SIZE + keyBytes.length;
      buf.set(valBytes, valStart);
      updates.push(
        tag === TAG_DEL
          ? [key, undefined]
          : [key, {offset: base + valStart, length: valBytes.length}],
      );
      pos += HEADER_SIZE + keyBytes.length + valBytes.length;
    }

    const written = this.#handle.write(buf, {at: base});
    assert(written === total, 'short write while committing OPFS log');
    this.#handle.flush();
    this.#fileSize = base + total;

    for (const [key, entry] of updates) {
      const prev = this.#index.get(key);
      if (prev) {
        this.#liveValueBytes -= prev.length;
      }
      if (entry === undefined) {
        this.#index.delete(key);
      } else {
        this.#index.set(key, entry);
        this.#liveValueBytes += entry.length;
      }
    }

    this.#maybeCompact();
  }

  #maybeCompact(): void {
    if (
      this.#fileSize < MIN_COMPACT_BYTES ||
      this.#fileSize <= this.#liveValueBytes * COMPACT_RATIO
    ) {
      return;
    }
    this.#compact();
  }

  // Rewrite the log so it contains only the live entries.
  #compact(): void {
    // Read all live values first (offsets refer to the current file).
    const live: {keyBytes: Uint8Array; valBytes: Uint8Array}[] = [];
    let total = 0;
    for (const [key, entry] of this.#index) {
      const valBytes = new Uint8Array(entry.length);
      const read = this.#handle.read(valBytes, {at: entry.offset});
      assert(read === entry.length, 'short read while compacting OPFS log');
      const keyBytes = textEncoder.encode(key);
      live.push({keyBytes, valBytes});
      total += HEADER_SIZE + keyBytes.length + valBytes.length;
    }

    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    let pos = 0;
    const newIndex = new Map<string, IndexEntry>();
    let i = 0;
    for (const [key] of this.#index) {
      const {keyBytes, valBytes} = live[i++];
      view.setUint8(pos, TAG_PUT);
      view.setUint32(pos + 1, keyBytes.length, true);
      view.setUint32(pos + 5, valBytes.length, true);
      buf.set(keyBytes, pos + HEADER_SIZE);
      const valStart = pos + HEADER_SIZE + keyBytes.length;
      buf.set(valBytes, valStart);
      newIndex.set(key, {offset: valStart, length: valBytes.length});
      pos += HEADER_SIZE + keyBytes.length + valBytes.length;
    }

    this.#handle.truncate(0);
    const written = this.#handle.write(buf, {at: 0});
    assert(written === total, 'short write while compacting OPFS log');
    this.#handle.flush();
    this.#fileSize = total;
    this.#index.clear();
    for (const [key, entry] of newIndex) {
      this.#index.set(key, entry);
    }
  }

  close(): void {
    this.#handle.close();
  }
}

export class OPFSStore implements Store {
  readonly #name: string;
  readonly #rwLock = new RWLock();
  #log: OPFSLog | null = null;
  #openPromise: Promise<OPFSLog> | null = null;
  #closed = false;

  constructor(name: string) {
    this.#name = name;
  }

  #open(): Promise<OPFSLog> {
    if (this.#log) {
      return Promise.resolve(this.#log);
    }
    if (!this.#openPromise) {
      this.#openPromise = OPFSLog.open(this.#name).then(log => {
        this.#log = log;
        return log;
      });
    }
    return this.#openPromise;
  }

  async read(): Promise<Read> {
    throwIfStoreClosed(this);
    const log = await this.#open();
    const release = await this.#rwLock.read();
    return new ReadImpl(log, release);
  }

  async write(): Promise<Write> {
    throwIfStoreClosed(this);
    const log = await this.#open();
    const release = await this.#rwLock.write();
    return new WriteImpl(log, release);
  }

  async close(): Promise<void> {
    if (this.#log) {
      // Wait for any in-flight transactions to release their locks first.
      const release = await this.#rwLock.write();
      this.#log.close();
      this.#log = null;
      release();
    }
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }
}

class ReadImpl implements Read {
  readonly #log: OPFSLog;
  readonly #release: () => void;
  #closed = false;

  constructor(log: OPFSLog, release: () => void) {
    this.#log = log;
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
    return (
      maybeTransactionIsClosedRejection(this) ??
      Promise.resolve(this.#log.has(key))
    );
  }

  get(key: string): Promise<FrozenJSONValue | undefined> {
    return (
      maybeTransactionIsClosedRejection(this) ??
      Promise.resolve(this.#log.get(key))
    );
  }
}

class WriteImpl extends WriteImplBase implements Write {
  readonly #log: OPFSLog;

  constructor(log: OPFSLog, release: () => void) {
    super(new ReadImpl(log, release));
    this.#log = log;
  }

  commit(): Promise<void> {
    if (this.closed) {
      return transactionIsClosedRejection();
    }
    this.#log.commit(this._pending);
    this._pending.clear();
    return promiseVoid;
  }

  // release() is inherited from WriteImplBase, which releases the underlying
  // ReadImpl (and thus the RWLock write lock). withWrite() calls commit() then
  // release(); only release() touches the lock, so it is released exactly once.
}

/**
 * Deletes the underlying OPFS file for the named store.
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
