/// <reference lib="webworker" />
/**
 * Browser producer: initializes its own wasm instance, serializes rows, and
 * transfers them (zero-copy) to the main thread in batches. Each row encodes
 * its producing worker so the main thread can verify provenance.
 */
import init, {WasmSchema} from '../../pkg-web/row_wasm.js';
import {demoSchemaJson} from '../demo-schema.ts';

// `--target web` wasm must be initialized before first use.
const ready = init().then(() => new WasmSchema(demoSchemaJson));

interface ProduceMsg {
  type: 'produce';
  ring: number;
  count: number;
  chunk: number;
}

self.onmessage = async (e: MessageEvent<ProduceMsg>) => {
  if (e.data?.type !== 'produce') return;
  const {ring, count, chunk} = e.data;
  const schema = await ready;
  const post = (self as DedicatedWorkerGlobalScope).postMessage.bind(self);

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
    // serialize_row returns a Uint8Array over a fresh, exact-sized ArrayBuffer.
    batch.push(schema.serialize_row(rowJson).buffer as ArrayBuffer);
    if (batch.length >= chunk) {
      post({ring, buffers: batch}, batch); // transfer ownership to main
      batch = [];
    }
  }
  if (batch.length > 0) post({ring, buffers: batch}, batch);
  post({ring, done: true});
};
