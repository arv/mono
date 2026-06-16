/**
 * Node thread-scaling benchmark: runs the worker_threads + SharedArrayBuffer
 * pipeline at increasing thread counts and reports rows/s as a function of
 * threads, for two consumer strategies:
 *   - "copy"      — dequeue copies each row out of shared memory (`.slice`)
 *   - "zero-copy" — consume reads each row in place, freeing the slot after
 *
 * The consumer otherwise does no per-row work, so the gap between the two lines
 * is purely the per-row copy — i.e. how much it raises the single-consumer
 * ceiling. Writes an SVG plot. Run: `pnpm run threads:bench` (env ROWS).
 */
import {writeFileSync} from 'node:fs';
import {availableParallelism} from 'node:os';
import {Worker} from 'node:worker_threads';

import {computeLayout, ThreadQueue} from './queue.ts';

type Mode = 'copy' | 'zero-copy';

interface Point {
  threads: number;
  rowsPerSec: number;
}

const NOOP = () => {};

async function runTrial(
  threads: number,
  totalRows: number,
  mode: Mode,
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
    if (mode === 'copy') {
      const row = queue.dequeue(scan);
      if (row === null) {
        await new Promise(resolve => setImmediate(resolve));
        continue;
      }
      scan = (row.threadId + 1) % threads;
    } else {
      const ring = queue.consume(scan, NOOP);
      if (ring === -1) {
        await new Promise(resolve => setImmediate(resolve));
        continue;
      }
      scan = (ring + 1) % threads;
    }
    consumed++;
  }
  const ms = performance.now() - start;
  await Promise.all(workers.map(w => w.terminate()));
  return {threads, rowsPerSec: (totalRows / ms) * 1000};
}

interface Series {
  label: string;
  color: string;
  points: Point[];
}

function svgChart(series: Series[]): string {
  const W = 760;
  const H = 460;
  const m = {l: 80, r: 24, t: 60, b: 56};
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const all = series.flatMap(s => s.points);
  const xMax = Math.max(...all.map(p => p.threads));
  const yMax = Math.max(...all.map(p => p.rowsPerSec)) * 1.1;
  const x = (t: number) => m.l + (t / xMax) * iw;
  const y = (v: number) => m.t + ih - (v / yMax) * ih;

  const grid: string[] = [];
  for (let i = 0; i <= 5; i++) {
    const v = (yMax / 5) * i;
    const yy = y(v);
    grid.push(
      `<line x1="${m.l}" y1="${yy}" x2="${m.l + iw}" y2="${yy}" stroke="#eee"/>` +
        `<text x="${m.l - 10}" y="${yy + 4}" text-anchor="end" font-size="12" fill="#555">${(v / 1000).toFixed(0)}k</text>`,
    );
  }
  const xLabels = all
    .map(p => p.threads)
    .filter((t, i, a) => a.indexOf(t) === i)
    .map(
      t =>
        `<text x="${x(t)}" y="${m.t + ih + 22}" text-anchor="middle" font-size="12" fill="#555">${t}</text>`,
    )
    .join('');

  const plots = series
    .map((s, si) => {
      const poly = s.points
        .map(p => `${x(p.threads)},${y(p.rowsPerSec)}`)
        .join(' ');
      const dots = s.points
        .map(
          p =>
            `<circle cx="${x(p.threads)}" cy="${y(p.rowsPerSec)}" r="3.5" fill="${s.color}"/>`,
        )
        .join('');
      const legendY = 44 + si * 18;
      const legend =
        `<line x1="${m.l}" y1="${legendY}" x2="${m.l + 24}" y2="${legendY}" stroke="${s.color}" stroke-width="2"/>` +
        `<text x="${m.l + 30}" y="${legendY + 4}" font-size="12" fill="#333">${s.label}</text>`;
      return `<polyline points="${poly}" fill="none" stroke="${s.color}" stroke-width="2"/>${dots}${legend}`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif">
<rect width="${W}" height="${H}" fill="white"/>
<text x="${W / 2}" y="26" text-anchor="middle" font-size="16" fill="#111">Row throughput vs threads — copy vs zero-copy consumer (Node)</text>
${grid.join('\n')}
<line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${m.t + ih}" stroke="#999"/>
<line x1="${m.l}" y1="${m.t + ih}" x2="${m.l + iw}" y2="${m.t + ih}" stroke="#999"/>
<text x="${m.l + iw / 2}" y="${H - 12}" text-anchor="middle" font-size="13" fill="#333">threads</text>
<text x="18" y="${m.t + ih / 2}" text-anchor="middle" font-size="13" fill="#333" transform="rotate(-90 18 ${m.t + ih / 2})">rows / second</text>
${xLabels}
${plots}
</svg>`;
}

const TOTAL = Number(process.env.ROWS ?? 200_000);
const REPEAT = Number(process.env.REPEAT ?? 3);
const cores = availableParallelism();
const maxThreads = Math.min(cores * 2, 16);
const threadCounts = [...new Set([1, 2, 3, 4, 6, 8, 12, 16, maxThreads])]
  .filter(t => t <= maxThreads)
  .sort((a, b) => a - b);

console.log(
  `cores=${cores}; ${TOTAL} rows/trial; best of ${REPEAT}; thread counts: ${threadCounts.join(', ')}`,
);

// Warm up both code paths so neither is measured cold (the JIT confound).
await runTrial(4, 20_000, 'copy');
await runTrial(4, 20_000, 'zero-copy');

const copyPts: Point[] = [];
const zeroPts: Point[] = [];
console.log('threads  copy      zero-copy');
for (const t of threadCounts) {
  // Tightly interleave the two modes and take best-of-REPEAT, so both see the
  // same warmth / system state at each thread count.
  let copyBest = 0;
  let zeroBest = 0;
  for (let r = 0; r < REPEAT; r++) {
    copyBest = Math.max(
      copyBest,
      (await runTrial(t, TOTAL, 'copy')).rowsPerSec,
    );
    zeroBest = Math.max(
      zeroBest,
      (await runTrial(t, TOTAL, 'zero-copy')).rowsPerSec,
    );
  }
  copyPts.push({threads: t, rowsPerSec: copyBest});
  zeroPts.push({threads: t, rowsPerSec: zeroBest});
  console.log(
    `${String(t).padStart(7)}  ${`${(copyBest / 1000).toFixed(0)}k`.padStart(7)}   ${`${(zeroBest / 1000).toFixed(0)}k`.padStart(7)}  (${(zeroBest / copyBest).toFixed(2)}x)`,
  );
}

const series: Series[] = [
  {label: 'copy (.slice per row)', color: '#ef4444', points: copyPts},
  {label: 'zero-copy (in place)', color: '#2563eb', points: zeroPts},
];

const outUrl = new URL('../../threads-scaling.svg', import.meta.url);
writeFileSync(outUrl, svgChart(series));
console.log(`wrote ${outUrl.pathname}`);
