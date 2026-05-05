import {assert} from '../../../shared/src/asserts.ts';
import type {Hash} from '../hash.ts';
import type {Release} from '../with-transactions.ts';
import type {Chunk, Refs} from './chunk.ts';

export interface Store {
  read(): Promise<Read>;
  write(): Promise<Write>;
  close(): Promise<void>;
}

interface GetChunk {
  getChunk(hash: Hash): Promise<Chunk | undefined>;
}

export interface MustGetChunk {
  mustGetChunk(hash: Hash): Promise<Chunk>;
}

export interface Read extends GetChunk, MustGetChunk, Release {
  hasChunk(hash: Hash): Promise<boolean>;
  getHead(name: string): Promise<Hash | undefined>;
  get closed(): boolean;
  getManyChunks(hashes: readonly Hash[]): Promise<(Chunk | undefined)[]>;
  /**
   * True when {@link getManyChunks} reduces the number of underlying storage
   * round-trips to 1 (e.g. SQLite `SELECT … IN (…)`). False for stores like
   * IDB where getManyChunks is `Promise.all` of N individual requests —
   * concurrent but not fewer round-trips.
   */
  readonly supportsBulkPrefetch: boolean;
}

export function getManyChunks(
  read: Read,
  hashes: readonly Hash[],
): Promise<(Chunk | undefined)[]> {
  return read.getManyChunks(hashes);
}

export interface Write extends Read {
  createChunk<V>(data: V, refs: Refs): Chunk<V>;
  putChunk<V>(c: Chunk<V>): Promise<void>;
  putManyChunks(chunks: readonly Chunk[]): Promise<void>;
  setHead(name: string, hash: Hash): Promise<void>;
  removeHead(name: string): Promise<void>;
  assertValidHash(hash: Hash): void;
  commit(): Promise<void>;
}

export function putManyChunks(
  write: Write,
  chunks: readonly Chunk[],
): Promise<void> {
  return write.putManyChunks(chunks);
}

export class ChunkNotFoundError extends Error {
  name = 'ChunkNotFoundError';
  readonly hash: Hash;
  constructor(hash: Hash) {
    super(`Chunk not found ${hash}`);
    this.hash = hash;
  }
}

export async function mustGetChunk(
  store: GetChunk,
  hash: Hash,
): Promise<Chunk> {
  const chunk = await store.getChunk(hash);
  if (chunk) {
    return chunk;
  }
  throw new ChunkNotFoundError(hash);
}

export async function mustGetHeadHash(
  name: string,
  store: Read,
): Promise<Hash> {
  const hash = await store.getHead(name);
  assert(hash, `Missing head ${name}`);
  return hash;
}
