/**
 * Browser consumer (main thread): spawns N Web Workers that each serialize rows
 * with their own wasm instance and transfer them here. The main thread decodes
 * every row with `RowReader` and verifies provenance + integrity. Open via
 * `threads.html` (served by `pnpm run dev`).
 */
import {demoSchema} from '../demo-schema.ts';
import {RowReader} from '../row-reader.ts';
import {CompiledSchema} from '../schema.ts';

const THREADS = 4;
const ROWS = 5000; // rows per worker
const CHUNK = 500; // rows per postMessage (amortizes message overhead)
const total = THREADS * ROWS;

const schema = new CompiledSchema(demoSchema);

const out = document.getElementById('out');
const log = (msg: string) => {
  console.log(msg);
  if (out) out.textContent += `${msg}\n`;
};

interface FromWorker {
  ring: number;
  buffers?: ArrayBuffer[];
  done?: boolean;
}

const counts = new Array<number>(THREADS).fill(0);
let consumed = 0;
let doneWorkers = 0;
const startedAt = performance.now();

const workers: Worker[] = [];

function finishIfDone() {
  if (doneWorkers !== THREADS) return;
  const ms = (performance.now() - startedAt).toFixed(0);
  log(`consumed ${consumed} rows from ${THREADS} workers in ${ms}ms`);
  counts.forEach((c, r) => log(`  worker ${r}: ${c} rows`));
  const ok = consumed === total && counts.every(c => c === ROWS);
  log(ok ? `OK — every worker delivered ${ROWS} rows` : 'MISMATCH');
  workers.forEach(w => w.terminate());
}

for (let ring = 0; ring < THREADS; ring++) {
  const worker = new Worker(new URL('./browser.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onerror = e => log(`worker ${ring} error: ${e.message}`);
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const {ring: r, buffers, done} = e.data;
    if (done) {
      doneWorkers++;
      finishIfDone();
      return;
    }
    for (const buf of buffers ?? []) {
      const reader = new RowReader(schema, buf);
      const name = reader.get('name');
      const userId = reader.get('user_id');
      if (typeof name !== 'string' || !name.startsWith(`t${r}#`)) {
        throw new Error(`worker ${r}: wrong name ${String(name)}`);
      }
      if (userId !== BigInt(r)) {
        throw new Error(`worker ${r}: wrong user_id ${String(userId)}`);
      }
      counts[r]++;
      consumed++;
    }
  };
  workers.push(worker);
}

log(`spawning ${THREADS} workers x ${ROWS} rows = ${total} rows…`);
for (let ring = 0; ring < THREADS; ring++) {
  workers[ring].postMessage({type: 'produce', ring, count: ROWS, chunk: CHUNK});
}
