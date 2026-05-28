/// <reference lib="webworker" />
/**
 * Browser producer: initializes its own wasm instance (posts `ready` when done
 * so the main thread can time trials without init overhead), then on `produce`
 * serializes rows and transfers them (zero-copy) to the main thread in batches.
 */
import init, {WasmSchema} from '../../pkg-web/row_wasm.js';
import {demoSchemaJson} from '../demo-schema.ts';

const post = (self as DedicatedWorkerGlobalScope).postMessage.bind(self);

let schema: WasmSchema;
const ready = init().then(() => {
  schema = new WasmSchema(demoSchemaJson);
  post({ready: true});
});

interface ProduceMsg {
  type: 'produce';
  ring: number;
  count: number;
  chunk: number;
}

self.onmessage = async (e: MessageEvent<ProduceMsg>) => {
  if (e.data?.type !== 'produce') return;
  await ready;
  const {ring, count, chunk} = e.data;

  let batch: ArrayBuffer[] = [];
  for (let i = 0; i < count; i++) {
    const rowJson = JSON.stringify({
      id: String(i),
      user_id: String(ring),
      name: `t${ring}#${i}`,
      score: i * 0.5,
      active: (i & 1) === 0,
      metadata: {tags: ['a', 'b'], count: i},
    });
    batch.push(schema.serialize_row(rowJson).buffer as ArrayBuffer);
    if (batch.length >= chunk) {
      post({ring, buffers: batch}, batch); // transfer ownership to main
      batch = [];
    }
  }
  if (batch.length > 0) post({ring, buffers: batch}, batch);
  post({ring, done: true});
};
