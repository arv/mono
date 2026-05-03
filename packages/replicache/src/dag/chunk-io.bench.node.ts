/**
 * Benchmark: getManyChunks vs sequential getChunk, putManyChunks vs sequential putChunk.
 *
 * "Before" path: N concurrent single-chunk calls (each a separate SQL statement).
 * "After"  path: one getManyChunks / putManyChunks call (one SQL statement total).
 *
 * Run:
 *   npm --workspace=replicache run bench
 */

import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bench, describe} from 'vitest';
import {deepFreeze} from '../frozen-json.ts';
import {assertHash, makeNewFakeHashFunction} from '../hash.ts';
import {withRead, withWrite} from '../with-transactions.ts';
import {createChunk, type Refs} from './chunk.ts';
import {StoreImpl} from './store-impl.ts';
import {
  getManyChunks as getManyChunksHelper,
  putManyChunks as putManyChunksHelper,
} from './store.ts';
import {zeroSQLiteStoreProvider} from '../kv/zero-sqlite/store.ts';

const chunkHasher = makeNewFakeHashFunction();

function makeChunks(n: number) {
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push(
      createChunk(
        deepFreeze({id: `key-${i}`, value: 'x'.repeat(64)}),
        [] as Refs,
        chunkHasher,
      ),
    );
  }
  return chunks;
}

let storeSeq = 0;

function makeStore() {
  const name = join(tmpdir(), `rpl_bench_${++storeSeq}_${Date.now()}`);
  const kv = zeroSQLiteStoreProvider().create(name);
  return new StoreImpl(kv as never, chunkHasher, assertHash);
}

for (const n of [10, 50]) {
  describe(`dag chunk reads — ${n} chunks`, () => {
    // Seed store once; both read benches share it.
    const store = makeStore();
    const chunks = makeChunks(n);

    void (async () => {
      await withWrite(store, async w => {
        await putManyChunksHelper(w, chunks);
      });
    })();

    bench(`before: Promise.all getChunk×${n}`, async () => {
      await withRead(store, async r => {
        await Promise.all(chunks.map(c => r.getChunk(c.hash)));
      });
    });

    bench(`after:  getManyChunks×${n}`, async () => {
      await withRead(store, async r => {
        await getManyChunksHelper(r, chunks.map(c => c.hash));
      });
    });
  });

  describe(`dag chunk writes — ${n} chunks`, () => {
    bench(`before: Promise.all putChunk×${n}`, async () => {
      const store = makeStore();
      const chunks = makeChunks(n);
      await withWrite(store, async w => {
        await Promise.all(chunks.map(c => w.putChunk(c)));
      });
    });

    bench(`after:  putManyChunks×${n}`, async () => {
      const store = makeStore();
      const chunks = makeChunks(n);
      await withWrite(store, async w => {
        await putManyChunksHelper(w, chunks);
      });
    });
  });
}
