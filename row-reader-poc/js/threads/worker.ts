/**
 * Producer thread: runs its own wasm serializer instance and pushes serialized
 * rows into its shared ring. Each row encodes the producing thread id so the
 * consumer can verify provenance.
 */
import {parentPort, workerData} from 'node:worker_threads';

import {WasmSchema} from '../../pkg-node/row_wasm.js';
import {demoSchemaJson} from '../demo-schema.ts';
import {ThreadQueue, type Layout} from './queue.ts';

interface WorkerData {
  sab: SharedArrayBuffer;
  layout: Layout;
  ring: number;
  count: number;
}

const {sab, layout, ring, count} = workerData as WorkerData;

const queue = new ThreadQueue(sab, layout);
const schema = new WasmSchema(demoSchemaJson);

for (let i = 0; i < count; i++) {
  // int64 columns cross the wasm boundary as strings; build a distinct row so
  // the consumer can confirm it read the right producer's data.
  const rowJson = JSON.stringify({
    id: String(i),
    user_id: String(ring),
    name: `t${ring}#${i}`,
    score: i * 0.5,
    active: (i & 1) === 0,
    metadata: {tags: ['a', 'b'], count: i},
  });
  const bytes = schema.serialize_row(rowJson);
  queue.enqueue(ring, ring, bytes);
}

parentPort?.postMessage({ring, produced: count});
