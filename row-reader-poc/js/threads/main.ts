/**
 * Consumer (main thread): spawns N producer worker threads, each serializing
 * rows via wasm and pushing them through a SharedArrayBuffer ring buffer. The
 * main thread drains all rings, decodes every row with `RowReader`, and
 * verifies provenance + integrity.
 *
 * Run: `pnpm run threads`  (env: THREADS, ROWS, CAPACITY)
 */
import {Worker} from 'node:worker_threads';

import {demoSchema} from '../demo-schema.ts';
import {RowReader} from '../row-reader.ts';
import {CompiledSchema} from '../schema.ts';
import {computeLayout, ThreadQueue} from './queue.ts';

const THREADS = Number(process.env.THREADS ?? 4);
const ROWS = Number(process.env.ROWS ?? 5000); // rows per thread
const CAPACITY = Number(process.env.CAPACITY ?? 256); // ring slots (bounded)

const total = THREADS * ROWS;
const layout = computeLayout(THREADS, CAPACITY);
const sab = new SharedArrayBuffer(layout.byteLength);
const queue = new ThreadQueue(sab, layout);
const schema = new CompiledSchema(demoSchema);

let workerError: Error | null = null;
const workers: Worker[] = [];
for (let ring = 0; ring < THREADS; ring++) {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    workerData: {sab, layout, ring, count: ROWS},
  });
  worker.on('error', err => {
    workerError = err;
  });
  workers.push(worker);
}

console.log(
  `${THREADS} threads x ${ROWS} rows = ${total} rows, ring capacity ${CAPACITY} (KB shared: ${(layout.byteLength / 1024).toFixed(0)})`,
);

const counts = new Array<number>(THREADS).fill(0);
let consumed = 0;
let scan = 0;
const startedAt = Date.now();

while (consumed < total) {
  if (workerError) throw workerError;
  if (Date.now() - startedAt > 30_000) {
    throw new Error(`timed out: consumed ${consumed}/${total}`);
  }

  const row = queue.dequeue(scan);
  if (row === null) {
    // All rings momentarily empty: yield so producers run and worker
    // error/exit events can fire.
    await new Promise(resolve => setImmediate(resolve));
    continue;
  }

  scan = (row.threadId + 1) % THREADS;

  const reader = new RowReader(schema, row.bytes.buffer as ArrayBuffer);
  const name = reader.get('name');
  const userId = reader.get('user_id');
  if (typeof name !== 'string' || !name.startsWith(`t${row.threadId}#`)) {
    throw new Error(
      `row from thread ${row.threadId} has wrong name: ${String(name)}`,
    );
  }
  if (userId !== BigInt(row.threadId)) {
    throw new Error(
      `row from thread ${row.threadId} has user_id ${String(userId)}`,
    );
  }
  const meta = reader.get('metadata') as {tags: string[]} | null;
  if (!meta || meta.tags[0] !== 'a') {
    throw new Error(`row from thread ${row.threadId} has bad metadata`);
  }

  counts[row.threadId]++;
  consumed++;
}

const elapsed = Date.now() - startedAt;
await Promise.all(workers.map(w => w.terminate()));

console.log(
  `consumed ${consumed} rows in ${elapsed}ms from ${THREADS} threads:`,
);
counts.forEach((c, r) => console.log(`  thread ${r}: ${c} rows`));

const ok = counts.every(c => c === ROWS) && consumed === total;
console.log(
  ok
    ? `threads: OK — every thread delivered ${ROWS} rows (${((total / elapsed) * 1000) | 0} rows/s)`
    : 'threads: MISMATCH',
);
if (!ok) process.exit(1);
