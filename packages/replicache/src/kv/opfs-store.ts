import {RWLock} from '@rocicorp/lock';
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
 * This variant uses the *asynchronous* OPFS API only
 * ({@link FileSystemFileHandle.getFile} for reads,
 * {@link FileSystemFileHandle.createWritable} for writes). Unlike
 * `createSyncAccessHandle()`, the async API is available on the main thread in
 * every browser that ships OPFS, so there is no Web Worker involved.
 *
 * Storage layout: each named store is a directory under the OPFS root, and each
 * key is stored as its own file whose contents are the JSON-encoded value:
 *
 * - `get(key)`  → `getFileHandle(key)` + `file.text()` + `JSON.parse`. Values
 *   are not cached in memory, so read latency reflects actually going to disk —
 *   a fair comparison against IndexedDB.
 * - `put(key)`  → `createWritable()` + `write(json)` + `close()` (an atomic
 *   swap of that one file).
 * - `del(key)`  → `removeEntry(key)`.
 *
 * Transactions: mutations are buffered in memory (see {@link WriteImplBase}) and
 * only applied to disk on `commit()`, so an un-committed transaction writes
 * nothing. Strict serializable visibility is provided by an `RWLock` (multiple
 * concurrent readers or a single writer), exactly like {@link MemStore}.
 *
 * Caveat vs. {@link IDBStore}: a multi-key commit is applied file-by-file rather
 * than as one atomic unit, so a crash mid-commit can leave a partial write on
 * disk. Concurrent readers never observe a partial commit because the write
 * lock excludes them.
 */

const DIR_PREFIX = 'rep-opfs-';

function dirName(name: string): string {
  return DIR_PREFIX + encodeURIComponent(name);
}

// Map an arbitrary key to a safe OPFS file name. encodeURIComponent never emits
// '/', and the 'k' prefix keeps us clear of the reserved '.'/'..' names and the
// empty string.
function keyToFileName(key: string): string {
  return 'k' + encodeURIComponent(key);
}

function isNotFound(e: unknown): boolean {
  return (e as DOMException)?.name === 'NotFoundError';
}

export class OPFSStore implements Store {
  readonly #name: string;
  readonly #rwLock = new RWLock();
  #dirPromise: Promise<FileSystemDirectoryHandle> | null = null;
  #closed = false;

  constructor(name: string) {
    this.#name = name;
  }

  #dir(): Promise<FileSystemDirectoryHandle> {
    if (!this.#dirPromise) {
      this.#dirPromise = navigator.storage
        .getDirectory()
        .then(root =>
          root.getDirectoryHandle(dirName(this.#name), {create: true}),
        );
    }
    return this.#dirPromise;
  }

  async read(): Promise<Read> {
    throwIfStoreClosed(this);
    const dir = await this.#dir();
    const release = await this.#rwLock.read();
    return new ReadImpl(dir, release);
  }

  async write(): Promise<Write> {
    throwIfStoreClosed(this);
    const dir = await this.#dir();
    const release = await this.#rwLock.write();
    return new WriteImpl(dir, release);
  }

  close(): Promise<void> {
    // The async OPFS API holds no long-lived handles to close.
    this.#closed = true;
    return promiseVoid;
  }

  get closed(): boolean {
    return this.#closed;
  }
}

class ReadImpl implements Read {
  readonly #dir: FileSystemDirectoryHandle;
  readonly #release: () => void;
  #closed = false;

  constructor(dir: FileSystemDirectoryHandle, release: () => void) {
    this.#dir = dir;
    this.#release = release;
  }

  release(): void {
    this.#release();
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async has(key: string): Promise<boolean> {
    const rejection = maybeTransactionIsClosedRejection(this);
    if (rejection) {
      return rejection;
    }
    try {
      await this.#dir.getFileHandle(keyToFileName(key));
      return true;
    } catch (e) {
      if (isNotFound(e)) {
        return false;
      }
      throw e;
    }
  }

  async get(key: string): Promise<FrozenJSONValue | undefined> {
    const rejection = maybeTransactionIsClosedRejection(this);
    if (rejection) {
      return rejection;
    }
    try {
      const fh = await this.#dir.getFileHandle(keyToFileName(key));
      const file = await fh.getFile();
      const text = await file.text();
      return deepFreeze(JSON.parse(text));
    } catch (e) {
      if (isNotFound(e)) {
        return undefined;
      }
      throw e;
    }
  }
}

class WriteImpl extends WriteImplBase implements Write {
  readonly #dir: FileSystemDirectoryHandle;

  constructor(dir: FileSystemDirectoryHandle, release: () => void) {
    super(new ReadImpl(dir, release));
    this.#dir = dir;
  }

  async commit(): Promise<void> {
    if (this.closed) {
      return transactionIsClosedRejection();
    }
    for (const [key, value] of this._pending) {
      const fileName = keyToFileName(key);
      if (value === deleteSentinel) {
        try {
          await this.#dir.removeEntry(fileName);
        } catch (e) {
          if (!isNotFound(e)) {
            throw e;
          }
        }
      } else {
        const fh = await this.#dir.getFileHandle(fileName, {create: true});
        const writable = await fh.createWritable();
        await writable.write(JSON.stringify(value));
        await writable.close();
      }
    }
    this._pending.clear();
    return undefined;
  }

  // release() is inherited from WriteImplBase, which releases the underlying
  // ReadImpl (and thus the RWLock write lock). withWrite() calls commit() then
  // release(); only release() touches the lock, so it is released exactly once.
}

/**
 * Deletes the OPFS directory backing the named store.
 */
export async function dropOPFSStore(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(dirName(name), {recursive: true});
  } catch (e) {
    if (!isNotFound(e)) {
      throw e;
    }
  }
}
