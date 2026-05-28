/**
 * Browser thread-scaling benchmark (open `threads.html` via `pnpm run dev`).
 *
 * Sweeps worker count, and for each runs N Web Workers that serialize rows in
 * wasm and transfer them to the main thread. Plots rows/s as a function of
 * worker count on a canvas. The consumer only counts transferred rows (one
 * sanity decode up front), so the curve reflects producer + transfer scaling.
 */
import {demoSchema} from '../demo-schema.ts';
import {RowReader} from '../row-reader.ts';
import {CompiledSchema} from '../schema.ts';

const TOTAL = 100_000; // rows per trial, split across workers
const CHUNK = 1000; // rows per postMessage

const schema = new CompiledSchema(demoSchema);
const statusEl = document.getElementById('status')!;
const rowsEl = document.getElementById('rows')!;
const canvas = document.getElementById('chart') as HTMLCanvasElement;

interface Point {
  threads: number;
  rowsPerSec: number;
}

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
        {
          type: 'module',
        },
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

function addRow(threads: number, rowsPerSec: number): void {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${threads}</td><td>${(rowsPerSec / 1000).toFixed(0)}k</td>`;
  rowsEl.appendChild(tr);
}

function drawChart(points: Point[]): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const m = {l: 80, r: 24, t: 48, b: 56};
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const xMax = Math.max(...points.map(p => p.threads));
  const yMax = Math.max(...points.map(p => p.rowsPerSec), 1) * 1.1;
  const x = (t: number) => m.l + (t / xMax) * iw;
  const y = (v: number) => m.t + ih - (v / yMax) * ih;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.font = '15px sans-serif';
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.fillText('rows/s vs threads (browser Web Workers + wasm)', W / 2, 24);

  ctx.font = '12px sans-serif';
  for (let i = 0; i <= 5; i++) {
    const v = (yMax / 5) * i;
    const yy = y(v);
    ctx.strokeStyle = '#eee';
    ctx.beginPath();
    ctx.moveTo(m.l, yy);
    ctx.lineTo(m.l + iw, yy);
    ctx.stroke();
    ctx.fillStyle = '#555';
    ctx.textAlign = 'right';
    ctx.fillText(`${(v / 1000).toFixed(0)}k`, m.l - 8, yy + 4);
  }

  ctx.strokeStyle = '#999';
  ctx.beginPath();
  ctx.moveTo(m.l, m.t);
  ctx.lineTo(m.l, m.t + ih);
  ctx.lineTo(m.l + iw, m.t + ih);
  ctx.stroke();

  ctx.fillStyle = '#333';
  ctx.textAlign = 'center';
  ctx.fillText('threads', m.l + iw / 2, H - 14);
  points.forEach(p =>
    ctx.fillText(String(p.threads), x(p.threads), m.t + ih + 20),
  );

  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(p.threads);
    const py = y(p.rowsPerSec);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  ctx.fillStyle = '#2563eb';
  points.forEach(p => {
    const px = x(p.threads);
    const py = y(p.rowsPerSec);
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(`${(p.rowsPerSec / 1000).toFixed(0)}k`, px, py - 9);
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
    addRow(t, rowsPerSec);
    drawChart(points);
    await new Promise(resolve => setTimeout(resolve, 0)); // let the page paint
  }
  statusEl.textContent = `cores≈${navigator.hardwareConcurrency}; ${TOTAL} rows/trial; done`;
}

main().catch(err => {
  statusEl.textContent = `error: ${err.message}`;
});
