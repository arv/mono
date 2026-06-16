/**
 * Node validation of the async-consumer protocol used by the browser SAB path:
 * producer worker_threads block on synchronous `Atomics.wait` (full ring) while
 * the single consumer sleeps on `Atomics.waitAsync` (no busy-poll). Verifies
 * provenance + integrity of every row and that the signal/notify handshake has
 * no lost wakeups. Run: `pnpm run threads:async`.
 */
import {Worker} from 'node:worker_threads';

import {demoSchema} from '../demo-schema.ts';
import {RowReader} from '../row-reader.ts';
import {CompiledSchema} from '../schema.ts';
import {drainAsyncInPlace} from './drain.ts';
import {computeLayout, ThreadQueue} from './queue.ts';

const THREADS = Number(process.env.THREADS ?? 4);
const ROWS = Number(process.env.ROWS ?? 50_000);
const CAPACITY = Number(process.env.CAPACITY ?? 64); // small ring -> backpressure
const total = THREADS * ROWS;

const layout = computeLayout(THREADS, CAPACITY);
const sab = new SharedArrayBuffer(layout.byteLength);
const queue = new ThreadQueue(sab, layout); // consumer only reads the signal
const schema = new CompiledSchema(demoSchema);

const workers: Worker[] = [];
for (let ring = 0; ring < THREADS; ring++) {
  workers.push(
    new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: {sab, layout, ring, count: ROWS, notify: true},
    }),
  );
}

const counts = new Array<number>(THREADS).fill(0);
// One reader over the shared buffer, repositioned per row — zero-copy in-place.
const reader = new RowReader(schema, queue.buffer);
const startedAt = performance.now();

await drainAsyncInPlace(
  queue,
  total,
  (threadId, byteOffset) => {
    reader.reposition(byteOffset);
    if (reader.get('user_id') !== BigInt(threadId)) {
      throw new Error(`thread ${threadId}: wrong user_id`);
    }
    if (reader.get('name') !== `t${threadId}#${counts[threadId]}`) {
      throw new Error(`thread ${threadId}: wrong name`);
    }
    counts[threadId]++;
  },
  {timeoutMs: 30_000},
);

const ms = performance.now() - startedAt;
await Promise.all(workers.map(w => w.terminate()));

counts.forEach((c, r) => console.log(`  thread ${r}: ${c} rows`));
const ok = counts.every(c => c === ROWS);
console.log(
  ok
    ? `async-verify: OK — ${total} rows drained via Atomics.waitAsync in ${ms.toFixed(0)}ms (${((total / ms) * 1000) | 0} rows/s)`
    : 'async-verify: MISMATCH',
);
if (!ok) process.exit(1);
