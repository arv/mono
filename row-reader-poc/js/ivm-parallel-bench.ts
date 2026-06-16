/**
 * Sharded (key-partitioned) IVM throughput: native Rust across N threads vs
 * single-threaded JS. This is the server-side parallelism story — a single
 * pipeline can't be parallelized (stateful + ordered), but partitioning rows by
 * key into shared-nothing sub-pipelines is sound, and native threads share
 * memory for free. Every shard count must agree with the single-threaded
 * result. Run `pnpm run build:native` first.
 */
import assert from 'node:assert/strict';
import {availableParallelism} from 'node:os';

import {bench, group, run} from 'mitata';

import {filterBench as jsIvm} from './ivm/reference.ts';
import {ivmFilterBenchParallel as nativeParallel} from './native/index.ts';

const ROWS = 1000;
const PUSHES = 50_000;
const cores = availableParallelism();
const shardCounts = [1, 2, 4, 8].filter(s => s <= cores * 2);

const expected = jsIvm(ROWS, PUSHES);
for (const s of shardCounts) {
  assert.equal(
    nativeParallel(ROWS, PUSHES, s),
    expected,
    `native shards=${s} vs js`,
  );
}
console.log(
  `IVM filter pipeline: ${ROWS} rows + ${PUSHES} edits -> view ${expected}; cores=${cores}; all shard counts agree`,
);

group(`IVM ${PUSHES} edits (sharded native vs single-threaded JS)`, () => {
  bench('js (1 thread)', () => jsIvm(ROWS, PUSHES));
  for (const s of shardCounts) {
    bench(`native (${s} shard${s === 1 ? '' : 's'})`, () =>
      nativeParallel(ROWS, PUSHES, s));
  }
});

await run();
