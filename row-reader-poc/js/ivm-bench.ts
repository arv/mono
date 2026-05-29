/**
 * IVM throughput: native (napi) vs wasm vs a faithful JS reference, on an
 * identical filter-pipeline workload (`ivm::filter_bench` / `reference.ts`).
 * This is the performance question for porting zql's IVM to Rust: the native
 * number is the server upside; wasm must be at least as fast as JS for the
 * client. Asserts all three agree on the result, then benchmarks. Run
 * `pnpm run build:wasm:node` + `pnpm run build:native` first.
 */
import assert from 'node:assert/strict';

import {bench, group, run} from 'mitata';

import {ivm_filter_bench as wasmIvm} from '../pkg-node/row_wasm.js';
import {filterBench as jsIvm} from './ivm/reference.ts';
import {ivmFilterBench as nativeIvm} from './native/index.ts';

const ROWS = 1000;
const PUSHES = 10_000;

const js = jsIvm(ROWS, PUSHES);
const wasm = wasmIvm(ROWS, PUSHES);
const native = nativeIvm(ROWS, PUSHES);
assert.equal(wasm, js, 'wasm vs js final view size');
assert.equal(native, js, 'native vs js final view size');
console.log(
  `IVM filter pipeline: ${ROWS} rows hydrated + ${PUSHES} edits -> view size ${js} (native, wasm, js all agree)`,
);

group(`IVM filter pipeline (${ROWS} rows + ${PUSHES} edits)`, () => {
  bench('native (napi)', () => nativeIvm(ROWS, PUSHES));
  bench('wasm', () => wasmIvm(ROWS, PUSHES));
  bench('js (reference)', () => jsIvm(ROWS, PUSHES));
});

await run();
