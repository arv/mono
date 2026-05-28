/**
 * Browser thread-scaling benchmark — SharedArrayBuffer ring hand-off (open
 * `threads-sab.html` via `pnpm run dev`; needs a cross-origin-isolated page,
 * which vite.config sets via COOP/COEP headers).
 *
 * Producers (Web Workers) push rows into per-worker rings in shared memory,
 * blocking on synchronous `Atomics.wait` when full. The main thread drains
 * with `Atomics.waitAsync` (it cannot `Atomics.wait`). Compare with the
 * postMessage/transfer variant in `threads.html`.
 */
import {demoSchema} from '../demo-schema.ts';
import {RowReader} from '../row-reader.ts';
import {CompiledSchema} from '../schema.ts';
import {addRow, drawChart, type Point} from './chart.ts';
import {drainAsync} from './drain.ts';
import {computeLayout, ThreadQueue} from './queue.ts';

const TOTAL = 100_000; // rows per trial, split across workers
const CAPACITY = 256; // ring slots per worker (bounded)

const schema = new CompiledSchema(demoSchema);
const statusEl = document.getElementById('status')!;
const rowsEl = document.getElementById('rows')!;
const canvas = document.getElementById('chart') as HTMLCanvasElement;

function split(total: number, threads: number): number[] {
  const base = Math.floor(total / threads);
  const counts: number[] = [];
  let assigned = 0;
  for (let r = 0; r < threads; r++) {
    const c = r === threads - 1 ? total - assigned : base;
    assigned += c;
    counts.push(c);
  }
  return counts;
}

async function runTrial(
  threads: number,
  sanityCheck: boolean,
): Promise<number> {
  const layout = computeLayout(threads, CAPACITY);
  const sab = new SharedArrayBuffer(layout.byteLength);
  const queue = new ThreadQueue(sab, layout); // consumer reads the signal word
  const counts = split(TOTAL, threads);
  const workers: Worker[] = [];

  // Spawn workers, share the SAB, and wait until every wasm instance is ready.
  await new Promise<void>((resolve, reject) => {
    let readyCount = 0;
    for (let ring = 0; ring < threads; ring++) {
      const worker = new Worker(
        new URL('./browser-sab.worker.ts', import.meta.url),
        {type: 'module'},
      );
      worker.onerror = e => reject(new Error(`worker ${ring}: ${e.message}`));
      worker.onmessage = (e: MessageEvent<{ready?: boolean}>) => {
        if (e.data?.ready && ++readyCount === threads) resolve();
      };
      worker.postMessage({type: 'config', sab, layout, ring}); // SAB is shared, not transferred
      workers.push(worker);
    }
  });

  const startedAt = performance.now();
  for (let ring = 0; ring < threads; ring++) {
    workers[ring].postMessage({type: 'start', count: counts[ring]});
  }

  let sanityDone = !sanityCheck;
  await drainAsync(
    queue,
    TOTAL,
    row => {
      if (!sanityDone) {
        const reader = new RowReader(schema, row.bytes.buffer as ArrayBuffer);
        if (typeof reader.get('name') !== 'string') {
          throw new Error('sanity decode failed');
        }
        sanityDone = true;
      }
    },
    {timeoutMs: 60_000},
  );

  const ms = performance.now() - startedAt;
  workers.forEach(w => w.terminate());
  return (TOTAL / ms) * 1000;
}

async function main(): Promise<void> {
  if (!crossOriginIsolated) {
    statusEl.textContent =
      'not cross-origin isolated — SharedArrayBuffer unavailable (need COOP/COEP headers)';
    return;
  }
  const maxThreads = Math.min(navigator.hardwareConcurrency || 4, 16);
  const threadCounts = [...new Set([1, 2, 3, 4, 6, 8, 12, 16, maxThreads])]
    .filter(t => t <= maxThreads)
    .sort((a, b) => a - b);

  statusEl.textContent = `cores≈${navigator.hardwareConcurrency}; ${TOTAL} rows/trial; running…`;
  await runTrial(2, true); // warm up + sanity decode

  const points: Point[] = [];
  for (const t of threadCounts) {
    const rowsPerSec = await runTrial(t, false);
    points.push({threads: t, rowsPerSec});
    addRow(rowsEl, t, rowsPerSec);
    drawChart(canvas, points, 'rows/s vs threads (SharedArrayBuffer ring)');
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  statusEl.textContent = `cores≈${navigator.hardwareConcurrency}; ${TOTAL} rows/trial; done`;
}

main().catch(err => {
  statusEl.textContent = `error: ${err.message}`;
});
