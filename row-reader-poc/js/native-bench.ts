/**
 * Native (napi) vs WASM serialization, head to head on identical inputs.
 * Asserts the two produce byte-identical output, then benchmarks both. Run
 * `pnpm run build:wasm:node` + `pnpm run build:native` first, then
 * `pnpm run bench:native`.
 */
import assert from 'node:assert/strict';

import {bench, group, run} from 'mitata';

import {WasmSchema} from '../pkg-node/row_wasm.js';
import {DEMO_ROW_JSON, demoSchemaJson} from './demo-schema.ts';
import {NativeSchema} from './native/index.ts';

const wasm = new WasmSchema(demoSchemaJson);
const native = new NativeSchema(demoSchemaJson);

// Correctness: the native addon and wasm must produce identical bytes.
const wasmBytes = Buffer.from(wasm.serialize_row(DEMO_ROW_JSON));
const nativeBytes = Buffer.from(native.serializeRow(DEMO_ROW_JSON));
assert.deepEqual(
  nativeBytes,
  wasmBytes,
  'native and wasm produce identical bytes',
);
assert.equal(native.fixedSectionSize, wasm.fixed_section_size);
console.log(`native == wasm bytes (${nativeBytes.length}B); benchmarking…`);

group('serialize 1 row (incl. JSON decode)', () => {
  bench('native (napi)', () => native.serializeRow(DEMO_ROW_JSON));
  bench('wasm', () => wasm.serialize_row(DEMO_ROW_JSON));
});

group('serialize 1000 rows (decode once)', () => {
  bench('native (napi)', () => native.benchSerialize(1000, DEMO_ROW_JSON));
  bench('wasm', () => wasm.bench_serialize(1000, DEMO_ROW_JSON));
});

await run();
