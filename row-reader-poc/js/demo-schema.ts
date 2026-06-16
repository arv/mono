import type {Schema} from './schema.ts';

/** Shared by the benchmark and the browser smoke test so they can't drift. */
export const demoSchema: Schema = {
  columns: [
    {name: 'id', type: 'int64'},
    {name: 'user_id', type: 'int64'},
    {name: 'name', type: 'string'},
    {name: 'score', type: 'float64'},
    {name: 'active', type: 'bool'},
    {name: 'metadata', type: 'json', nullable: true},
  ],
};

/** Schema JSON in the shape the Rust `WasmSchema` constructor expects. */
export const demoSchemaJson = JSON.stringify(demoSchema.columns);

// int64 columns cross the WASM boundary as strings (JSON can't encode BigInt).
export const DEMO_ROW_JSON = JSON.stringify({
  id: '1',
  user_id: '42',
  name: 'Alice',
  score: 9.81,
  active: true,
  metadata: {tags: ['a', 'b'], count: 3},
});
