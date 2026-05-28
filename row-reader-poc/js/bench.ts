/**
 * Compares binary `RowReader` access against a `JSON.parse` baseline, plus
 * Rust serialization throughput via WASM. Run with `npm run bench` (Node.js)
 * after building the node wasm package.
 */
import {bench, group, run} from 'mitata';

import {CompiledSchema} from './schema.ts';
import {RowReader} from './row-reader.ts';
import {demoSchema, demoSchemaJson, DEMO_ROW_JSON} from './demo-schema.ts';
import {WasmSchema} from '../pkg-node/row_wasm.js';

const schema = new CompiledSchema(demoSchema);
const wasmSchema = new WasmSchema(demoSchemaJson);

// Pre-serialize one row to a standalone ArrayBuffer for the read benchmarks.
const binaryBuffer = wasmSchema.serialize_row(DEMO_ROW_JSON).buffer as ArrayBuffer;

// Equivalent plain-JSON string for the baseline (int64 as strings, to match).
const PLAIN_JSON = DEMO_ROW_JSON;

group('single column read', () => {
  bench('binary: new reader + get int64', () => {
    const row = new RowReader(schema, binaryBuffer);
    return row.get('user_id');
  });

  bench('json: parse + access int', () => {
    const obj = JSON.parse(PLAIN_JSON);
    return obj.user_id;
  });
});

group('all columns', () => {
  bench('binary: toObject()', () => {
    const row = new RowReader(schema, binaryBuffer);
    return row.toObject();
  });

  bench('json: JSON.parse()', () => JSON.parse(PLAIN_JSON));
});

group('hot path (reader already constructed)', () => {
  const row = new RowReader(schema, binaryBuffer);

  bench('binary: get string col', () => row.get('name'));
  bench('binary: get float64 col', () => row.get('score'));
  bench('binary: get json col', () => row.get('metadata'));
});

group('rust serialization (via WASM)', () => {
  // serialize_row decodes JSON input every call (harness overhead). The
  // 1000-row variant decodes once then serializes 1000 times, so its
  // per-row cost (call time / 1000) reflects serialization alone.
  bench('serialize 1 row (incl. JSON decode)', () =>
    wasmSchema.serialize_row(DEMO_ROW_JSON),
  );
  bench('serialize 1000 rows (decode once)', () =>
    wasmSchema.bench_serialize(1000, DEMO_ROW_JSON),
  );
});

await run();
