/**
 * End-to-end correctness check: serialize rows in Rust (via WASM) and read them
 * back with the TypeScript `RowReader`, asserting the round-trip. Run with
 * `npm run verify` after building the node wasm package.
 */
import assert from 'node:assert/strict';

import {WasmSchema} from '../pkg-node/row_wasm.js';
import {RowReader} from './row-reader.ts';
import {CompiledSchema, type Schema} from './schema.ts';

const schemaDef: Schema = {
  columns: [
    {name: 'id', type: 'int64'},
    {name: 'user_id', type: 'int64'},
    {name: 'name', type: 'string'},
    {name: 'score', type: 'float64'},
    {name: 'active', type: 'bool'},
    {name: 'count', type: 'int32'},
    {name: 'blob', type: 'bytes'},
    {name: 'metadata', type: 'json', nullable: true},
  ],
};

const schema = new CompiledSchema(schemaDef);
const wasmSchema = new WasmSchema(JSON.stringify(schemaDef.columns));

// Sanity: both sides agree on the fixed-section size.
assert.equal(
  wasmSchema.fixed_section_size,
  schema.fixedSectionSize,
  'Rust and TS disagree on fixed section size',
);

function roundTrip(rowJson: string): RowReader {
  const buf = wasmSchema.serialize_row(rowJson);
  return new RowReader(schema, buf.buffer as ArrayBuffer);
}

// --- case 1: fully populated row -----------------------------------------
{
  const row = roundTrip(
    JSON.stringify({
      id: '1',
      user_id: '42',
      name: 'Alice',
      score: 9.81,
      active: true,
      count: 7,
      blob: [1, 2, 255],
      metadata: {tags: ['a', 'b'], count: 3},
    }),
  );

  assert.equal(row.get('id'), 1n);
  assert.equal(row.get('user_id'), 42n);
  assert.equal(row.get('name'), 'Alice');
  assert.equal(row.get('score'), 9.81);
  assert.equal(row.get('active'), true);
  assert.equal(row.get('count'), 7);
  assert.deepEqual(row.get('blob'), new Uint8Array([1, 2, 255]));
  assert.deepEqual(row.get('metadata'), {tags: ['a', 'b'], count: 3});
  assert.equal(row.get('does_not_exist'), undefined);

  assert.deepEqual(row.toObject(), {
    id: 1n,
    user_id: 42n,
    name: 'Alice',
    score: 9.81,
    active: true,
    count: 7,
    blob: new Uint8Array([1, 2, 255]),
    metadata: {tags: ['a', 'b'], count: 3},
  });
}

// --- case 2: nullable column omitted --------------------------------------
{
  const row = roundTrip(
    JSON.stringify({
      id: '100',
      user_id: '200',
      name: '',
      score: -0.5,
      active: false,
      count: -1,
      blob: [],
      // metadata omitted -> null
    }),
  );

  assert.equal(row.get('name'), '', 'empty string round-trips');
  assert.equal(row.get('active'), false);
  assert.equal(row.get('count'), -1);
  assert.deepEqual(row.get('blob'), new Uint8Array([]));
  assert.equal(row.get('metadata'), null, 'omitted nullable column reads null');
}

// --- case 3: explicit JSON null for the nullable column -------------------
{
  const row = roundTrip(
    JSON.stringify({
      id: '1',
      user_id: '1',
      name: 'x',
      score: 1,
      active: true,
      count: 0,
      blob: [9],
      metadata: null,
    }),
  );
  assert.equal(row.get('metadata'), null, 'explicit null reads null');
}

console.log('verify: all round-trip assertions passed');
