/// <reference lib="webworker" />
/**
 * Browser SAB producer: serializes rows and pushes them into its ring in the
 * shared SharedArrayBuffer, blocking on synchronous `Atomics.wait` when the
 * ring is full (allowed on worker threads). The main thread drains with
 * `Atomics.waitAsync`. Requires a cross-origin-isolated page (COOP/COEP).
 */
import init, {WasmSchema} from '../../pkg-web/row_wasm.js';
import {demoSchemaJson} from '../demo-schema.ts';
import {type Layout, ThreadQueue} from './queue.ts';

const post = (self as DedicatedWorkerGlobalScope).postMessage.bind(self);

interface ConfigMsg {
  type: 'config';
  sab: SharedArrayBuffer;
  layout: Layout;
  ring: number;
}
interface StartMsg {
  type: 'start';
  count: number;
}

let queue: ThreadQueue;
let ring = 0;
let schema: WasmSchema;
const ready = init().then(() => {
  schema = new WasmSchema(demoSchemaJson);
});

self.onmessage = async (e: MessageEvent<ConfigMsg | StartMsg>) => {
  const d = e.data;
  if (d.type === 'config') {
    queue = new ThreadQueue(d.sab, d.layout, {notify: true});
    ring = d.ring;
    await ready;
    post({ready: true});
    return;
  }
  // 'start': serialize `count` rows into our ring (blocks on full via Atomics.wait).
  for (let i = 0; i < d.count; i++) {
    const rowJson = JSON.stringify({
      id: String(i),
      user_id: String(ring),
      name: `t${ring}#${i}`,
      score: i * 0.5,
      active: (i & 1) === 0,
      metadata: {tags: ['a', 'b'], count: i},
    });
    queue.enqueue(ring, ring, schema.serialize_row(rowJson));
  }
  post({done: true});
};
