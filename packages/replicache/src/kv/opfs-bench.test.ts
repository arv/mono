/**
 * A/B benchmark comparing the OPFS-backed {@link OPFSStore} against the existing
 * {@link IDBStore} (and {@link MemStore} as an in-memory baseline).
 *
 * This runs in the same Playwright/Chromium browser environment as the rest of
 * the replicache test suite. It is gated behind an env flag so it does not slow
 * down the normal test run. To run it:
 *
 *   cd packages/replicache
 *   VITE_OPFS_BENCH=1 pnpm exec vitest run src/kv/opfs-bench.test.ts
 *
 * The results table is printed to the console.
 */
import {test} from 'vitest';
import {deepFreeze, type FrozenJSONValue} from '../frozen-json.ts';
import {withRead, withWrite} from '../with-transactions.ts';
import {IDBStore} from './idb-store.ts';
import {MemStore} from './mem-store.ts';
import {dropOPFSStore, OPFSStore} from './opfs-store.ts';
import type {Store} from './store.ts';

// import.meta.env is provided by Vite; VITE_-prefixed vars are exposed to the
// browser bundle.
const ENABLED =
  (import.meta as unknown as {env?: Record<string, string>}).env
    ?.VITE_OPFS_BENCH === '1';

type Factory = {
  readonly label: string;
  readonly create: (name: string) => Store;
  readonly drop: (name: string) => Promise<void>;
};

const factories: Factory[] = [
  {
    label: 'MemStore',
    create: name => new MemStore(name),
    drop: () => Promise.resolve(),
  },
  {
    label: 'IDBStore',
    create: name => new IDBStore(name),
    drop: name =>
      new Promise<void>(resolve => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      }),
  },
  {
    label: 'OPFSStore',
    create: name => new OPFSStore(name),
    drop: dropOPFSStore,
  },
];

// Roughly `size` bytes of JSON per value.
function makeValue(i: number, size: number): FrozenJSONValue {
  const pad = 'x'.repeat(Math.max(0, size - 40));
  return deepFreeze({id: i, ts: Date.now(), n: i * 7, data: pad});
}

function fmt(ms: number): string {
  return ms < 10 ? ms.toFixed(2) : ms.toFixed(1);
}

function opsPerSec(ops: number, ms: number): string {
  return Math.round((ops / ms) * 1000).toLocaleString();
}

// Render rows (array of same-keyed records) as a fixed-width text table.
function formatTable(rows: Record<string, string>[]): string[] {
  const cols = Object.keys(rows[0]);
  const widths = cols.map(c =>
    Math.max(c.length, ...rows.map(r => r[c].length)),
  );
  const pad = (s: string, w: number) => s + ' '.repeat(w - s.length);
  const sep = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  const header =
    '| ' + cols.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';
  const body = rows.map(
    r => '| ' + cols.map((c, i) => pad(r[c], widths[i])).join(' | ') + ' |',
  );
  return [header, sep, ...body];
}

async function benchStore(
  f: Factory,
  cfg: {n: number; perCommit: number; valueSize: number; reads: number},
): Promise<Record<string, string>> {
  const {n, perCommit, valueSize, reads} = cfg;
  const uniq = Math.random().toString(36).slice(2);

  // --- Batched write: all N entries in a single commit ---
  const batchName = `bench-batch-${f.label}-${uniq}`;
  await f.drop(batchName);
  let store = f.create(batchName);
  let t = performance.now();
  await withWrite(store, async w => {
    for (let i = 0; i < n; i++) {
      await w.put(`key${i}`, makeValue(i, valueSize));
    }
  });
  const batchMs = performance.now() - t;

  // --- Sequential read of all N entries ---
  t = performance.now();
  await withRead(store, async r => {
    for (let i = 0; i < n; i++) {
      await r.get(`key${i}`);
    }
  });
  const seqReadMs = performance.now() - t;

  // --- Random read ---
  const idxs = Array.from({length: reads}, () => Math.floor(Math.random() * n));
  t = performance.now();
  await withRead(store, async r => {
    for (const i of idxs) {
      await r.get(`key${i}`);
    }
  });
  const randReadMs = performance.now() - t;
  await store.close();
  await f.drop(batchName);

  // --- Per-commit write: `perCommit` entries, one commit each (transaction
  // overhead dominated) ---
  const pcName = `bench-pc-${f.label}-${uniq}`;
  await f.drop(pcName);
  store = f.create(pcName);
  t = performance.now();
  for (let i = 0; i < perCommit; i++) {
    await withWrite(store, async w => {
      await w.put(`key${i}`, makeValue(i, valueSize));
    });
  }
  const perCommitMs = performance.now() - t;
  await store.close();
  await f.drop(pcName);

  return {
    store: f.label,
    [`batch write ${n}`]: `${fmt(batchMs)}ms (${opsPerSec(n, batchMs)}/s)`,
    [`seq read ${n}`]: `${fmt(seqReadMs)}ms (${opsPerSec(n, seqReadMs)}/s)`,
    [`rand read ${reads}`]: `${fmt(randReadMs)}ms (${opsPerSec(
      reads,
      randReadMs,
    )}/s)`,
    [`1-per-commit ${perCommit}`]: `${fmt(perCommitMs)}ms (${opsPerSec(
      perCommit,
      perCommitMs,
    )}/s)`,
  };
}

test.runIf(ENABLED)(
  'OPFS vs IDB vs Mem benchmark',
  async () => {
    const configs = [
      {n: 1000, perCommit: 500, valueSize: 256, reads: 1000},
      {n: 5000, perCommit: 1000, valueSize: 1024, reads: 2000},
    ];

    const lines: string[] = [];
    for (const cfg of configs) {
      const rows: Record<string, string>[] = [];
      for (const f of factories) {
        rows.push(await benchStore(f, cfg));
      }
      lines.push(
        `=== n=${cfg.n}, value≈${cfg.valueSize}B, ` +
          `perCommit=${cfg.perCommit}, randReads=${cfg.reads} ===`,
      );
      lines.push(...formatTable(rows));
      lines.push('');
    }
    // Single console.log with markers so the numbers are easy to extract from
    // the browser-forwarded test output. Run with `--silent=false` to surface
    // it (the shared browser config sets `silent: 'passed-only'`).
    // eslint-disable-next-line no-console
    console.log('__OPFS_BENCH__\n' + lines.join('\n') + '\n__OPFS_BENCH_END__');
  },
  120_000,
);
