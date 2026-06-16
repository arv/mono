/**
 * Browser thread-scaling benchmark — postMessage/transfer hand-off (open
 * `threads.html` via `pnpm run dev`).
 *
 * Sweeps worker count, and for each runs N Web Workers that serialize rows in
 * wasm and transfer the row ArrayBuffers to the main thread. Plots rows/s vs
 * worker count. Compare with the SharedArrayBuffer-ring variant in
 * `threads-sab.html`.
 */
import {demoSchema} from '../demo-schema.ts';
import {RowReader} from '../row-reader.ts';
import {CompiledSchema} from '../schema.ts';
import {addRow, drawChart, type Point} from './chart.ts';

const TOTAL = 100_000; // rows per trial, split across workers
const CHUNK = 1000; // rows per postMessage

const schema = new CompiledSchema(demoSchema);
const statusEl = document.getElementById('status')!;
const rowsEl = document.getElementById('rows')!;
const canvas = document.getElementById('chart') as HTMLCanvasElement;

interface FromWorker {
  ready?: boolean;
  done?: boolean;
  buffers?: ArrayBuffer[];
}

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

function runTrial(threads: number, sanityCheck: boolean): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const counts = split(TOTAL, threads);
    const workers: Worker[] = [];
    let readyCount = 0;
    let doneCount = 0;
    let received = 0;
    let startedAt = 0;
    let sanityDone = !sanityCheck;

    for (let ring = 0; ring < threads; ring++) {
      const worker = new Worker(
        new URL('./browser.worker.ts', import.meta.url),
        {type: 'module'},
      );
      worker.onerror = e => reject(new Error(`worker ${ring}: ${e.message}`));
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const d = e.data;
        if (d.ready) {
          if (++readyCount === threads) {
            startedAt = performance.now();
            for (let k = 0; k < threads; k++) {
              workers[k].postMessage({
                type: 'produce',
                ring: k,
                count: counts[k],
                chunk: CHUNK,
              });
            }
          }
          return;
        }
        if (d.done) {
          if (++doneCount === threads) {
            const ms = performance.now() - startedAt;
            workers.forEach(w => w.terminate());
            resolve((received / ms) * 1000);
          }
          return;
        }
        const buffers = d.buffers ?? [];
        if (!sanityDone && buffers.length > 0) {
          const reader = new RowReader(schema, buffers[0]);
          if (typeof reader.get('name') !== 'string') {
            reject(new Error('sanity decode failed'));
            return;
          }
          sanityDone = true;
        }
        received += buffers.length;
      };
      workers.push(worker);
    }
  });
}

async function main(): Promise<void> {
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
    drawChart(canvas, points, 'rows/s vs threads (postMessage transfer)');
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  statusEl.textContent = `cores≈${navigator.hardwareConcurrency}; ${TOTAL} rows/trial; done`;
}

main().catch(err => {
  statusEl.textContent = `error: ${err.message}`;
});
