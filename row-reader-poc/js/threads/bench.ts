/**
 * Node thread-scaling benchmark: runs the worker_threads + SharedArrayBuffer
 * pipeline at increasing thread counts and reports rows/s as a function of
 * threads. The consumer only drains (no per-row decode) so the curve reflects
 * producer (serialize) + hand-off scaling rather than single-consumer decode
 * cost. Writes an SVG plot. Run: `pnpm run threads:bench` (env ROWS).
 */
import {writeFileSync} from 'node:fs';
import {availableParallelism} from 'node:os';
import {Worker} from 'node:worker_threads';

import {computeLayout, ThreadQueue} from './queue.ts';

interface Point {
  threads: number;
  rows: number;
  ms: number;
  rowsPerSec: number;
}

async function runTrial(
  threads: number,
  totalRows: number,
  capacity = 1024,
): Promise<Point> {
  const layout = computeLayout(threads, capacity);
  const sab = new SharedArrayBuffer(layout.byteLength);
  const queue = new ThreadQueue(sab, layout);
  const workers: Worker[] = [];
  let workerError: Error | null = null;

  const base = Math.floor(totalRows / threads);
  let assigned = 0;
  for (let ring = 0; ring < threads; ring++) {
    const count = ring === threads - 1 ? totalRows - assigned : base;
    assigned += count;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: {sab, layout, ring, count},
    });
    worker.on('error', err => {
      workerError = err;
    });
    workers.push(worker);
  }

  let consumed = 0;
  let scan = 0;
  const start = performance.now();
  while (consumed < totalRows) {
    if (workerError) throw workerError;
    const row = queue.dequeue(scan);
    if (row === null) {
      await new Promise(resolve => setImmediate(resolve));
      continue;
    }
    scan = (row.threadId + 1) % threads;
    consumed++;
  }
  const ms = performance.now() - start;
  await Promise.all(workers.map(w => w.terminate()));
  return {threads, rows: totalRows, ms, rowsPerSec: (totalRows / ms) * 1000};
}

function svgChart(points: Point[]): string {
  const W = 760;
  const H = 440;
  const m = {l: 80, r: 24, t: 48, b: 56};
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const xMax = Math.max(...points.map(p => p.threads));
  const yMax = Math.max(...points.map(p => p.rowsPerSec)) * 1.1;
  const x = (t: number) => m.l + (t / xMax) * iw;
  const y = (v: number) => m.t + ih - (v / yMax) * ih;

  const yTicks = 5;
  const grid: string[] = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = (yMax / yTicks) * i;
    const yy = y(v);
    grid.push(
      `<line x1="${m.l}" y1="${yy}" x2="${m.l + iw}" y2="${yy}" stroke="#eee"/>` +
        `<text x="${m.l - 10}" y="${yy + 4}" text-anchor="end" font-size="12" fill="#555">${(v / 1000).toFixed(0)}k</text>`,
    );
  }
  const xLabels = points
    .map(
      p =>
        `<text x="${x(p.threads)}" y="${m.t + ih + 22}" text-anchor="middle" font-size="12" fill="#555">${p.threads}</text>`,
    )
    .join('');
  const poly = points.map(p => `${x(p.threads)},${y(p.rowsPerSec)}`).join(' ');
  const dots = points
    .map(
      p =>
        `<circle cx="${x(p.threads)}" cy="${y(p.rowsPerSec)}" r="3.5" fill="#2563eb"/>` +
        `<text x="${x(p.threads)}" y="${y(p.rowsPerSec) - 9}" text-anchor="middle" font-size="11" fill="#2563eb">${(p.rowsPerSec / 1000).toFixed(0)}k</text>`,
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif">
<rect width="${W}" height="${H}" fill="white"/>
<text x="${W / 2}" y="26" text-anchor="middle" font-size="16" fill="#111">Row serialization throughput vs threads (Node worker_threads + wasm)</text>
${grid.join('\n')}
<line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${m.t + ih}" stroke="#999"/>
<line x1="${m.l}" y1="${m.t + ih}" x2="${m.l + iw}" y2="${m.t + ih}" stroke="#999"/>
<text x="${m.l + iw / 2}" y="${H - 12}" text-anchor="middle" font-size="13" fill="#333">threads</text>
<text x="18" y="${m.t + ih / 2}" text-anchor="middle" font-size="13" fill="#333" transform="rotate(-90 18 ${m.t + ih / 2})">rows / second</text>
${xLabels}
<polyline points="${poly}" fill="none" stroke="#2563eb" stroke-width="2"/>
${dots}
</svg>`;
}

const TOTAL = Number(process.env.ROWS ?? 200_000);
const cores = availableParallelism();
const maxThreads = Math.min(cores * 2, 16);
const threadCounts = [...new Set([1, 2, 3, 4, 6, 8, 12, 16, maxThreads])]
  .filter(t => t <= maxThreads)
  .sort((a, b) => a - b);

console.log(
  `cores=${cores}; ${TOTAL} rows/trial; thread counts: ${threadCounts.join(', ')}`,
);
await runTrial(2, Math.min(TOTAL, 20_000)); // warm up

const points: Point[] = [];
for (const t of threadCounts) {
  const p = await runTrial(t, TOTAL);
  points.push(p);
  console.log(
    `threads=${String(t).padStart(2)}  ${(p.rowsPerSec / 1000).toFixed(0).padStart(6)}k rows/s  (${p.ms.toFixed(0)}ms)`,
  );
}

const outUrl = new URL('../../threads-scaling.svg', import.meta.url);
writeFileSync(outUrl, svgChart(points));
console.log(`wrote ${outUrl.pathname}`);
