/**
 * Benchmark: getMany / putMany vs sequential loops
 *
 * Run:
 *   node --expose-gc --import tsx/esm \
 *     packages/replicache/src/kv/batch-ops.bench.node.ts
 *
 * NOTE: ZeroSQLite uses a *synchronous* Node.js native binding, so there is
 * no real per-call overhead beyond the SQLite engine itself.  On React Native
 * (expo-sqlite, op-sqlite) every individual get/put crosses the JS→native
 * bridge (~0.5–2 ms), so the speedup scales linearly with key count there.
 */
import {withRead, withWrite} from '../with-transactions.ts';
import {MemStore} from './mem-store.ts';
import type {Read, Store, Write} from './store.ts';
import {getMany, putMany} from './store.ts';
import {zeroSQLiteStoreProvider} from './zero-sqlite/store.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeEntries(n: number): [string, string][] {
  return Array.from({length: n}, (_, i) => [
    `key_${i.toString().padStart(6, '0')}`,
    `value_${i}`,
  ]);
}

/** Run `fn` for `durationMs` after warmup, return ops/sec and µs/op. */
async function measure(
  label: string,
  fn: () => Promise<void>,
  durationMs = 500,
): Promise<number> {
  for (let i = 0; i < 3; i++) await fn();
  if (typeof global.gc === 'function') global.gc();

  let ops = 0;
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    await fn();
    ops++;
  }
  const opsPerSec = (ops / durationMs) * 1000;
  const usPerOp = (durationMs * 1000) / ops;
  console.log(
    `  ${label.padEnd(42)} ${opsPerSec.toFixed(0).padStart(9)} ops/s  (${usPerOp.toFixed(1)} µs/op)`,
  );
  return opsPerSec;
}

function header(title: string) {
  console.log(`\n${'─'.repeat(76)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(76));
  console.log(`  ${'benchmark'.padEnd(42)} ${'ops/s'.padStart(9)}  latency`);
  console.log('─'.repeat(76));
}

function ratio(batch: number, seq: number) {
  const x = (batch / seq).toFixed(2);
  const dir = batch >= seq ? 'faster' : 'slower';
  return `  → getMany/putMany is ${x}x ${dir} than the sequential loop`;
}

// ─── MemStore — measures Promise-microtask amortisation ──────────────────────
//
// MemStore operations are synchronous (Map lookups), so the overhead being
// measured here is purely the cost of sequential `await` turns vs a single
// resolved Promise.all().

async function benchMemStore(n: number) {
  header(`MemStore — ${n} keys  (Promise overhead only, no I/O)`);
  const entries = makeEntries(n);
  const keys = entries.map(([k]) => k);

  // Pre-populate a store that is reused across iterations.
  const readStore = new MemStore('bench-mem-read');
  await withWrite(readStore, async wt => {
    for (const [k, v] of entries) await wt.put(k, v);
  });

  // Each write iteration uses a fresh write transaction (not a new store).
  const writeStore = new MemStore('bench-mem-write');

  const gmOps = await measure('getMany (batch)', async () => {
    await withRead(readStore, async (rt: Read) => {
      await getMany(rt, keys);
    });
  });

  const gsOps = await measure('get (sequential loop)', async () => {
    await withRead(readStore, async (rt: Read) => {
      for (const k of keys) await rt.get(k);
    });
  });

  const pmOps = await measure('putMany (batch)', async () => {
    await withWrite(writeStore, async (wt: Write) => {
      await putMany(wt, entries);
    });
  });

  const psOps = await measure('put (sequential loop)', async () => {
    await withWrite(writeStore, async (wt: Write) => {
      for (const [k, v] of entries) await wt.put(k, v);
    });
  });

  console.log(ratio(gmOps, gsOps), ' [getMany]');
  console.log(ratio(pmOps, psOps), ' [putMany]');

  await readStore.close();
  await writeStore.close();
}

// ─── ZeroSQLiteStore — measures SQL batching vs N individual statements ───────
//
// ZeroSQLite is synchronous so reads/writes don't await real I/O.
// The comparison shows the SQL overhead: one SELECT…IN vs N SELECT statements,
// and transaction/statement overhead per call.

async function benchSQLiteStore(n: number) {
  header(
    `ZeroSQLiteStore — ${n} keys  (synchronous Node.js driver; RN bridges cost ~1 ms/call extra)`,
  );
  const entries = makeEntries(n);
  const keys = entries.map(([k]) => k);
  const provider = zeroSQLiteStoreProvider({
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });

  // Pre-populate read store once.
  const readName = `bench_sql_r_${n}`;
  const readStore: Store = provider.create(readName);
  await withWrite(readStore, async wt => {
    for (const [k, v] of entries) await wt.put(k, v);
  });

  const writeName = `bench_sql_w_${n}`;
  const writeStore: Store = provider.create(writeName);

  const gmOps = await measure('getMany (batch SELECT…IN)', async () => {
    await withRead(readStore, async (rt: Read) => {
      await getMany(rt, keys);
    });
  });

  const gsOps = await measure('get (sequential loop)', async () => {
    await withRead(readStore, async (rt: Read) => {
      for (const k of keys) await rt.get(k);
    });
  });

  const pmOps = await measure('putMany (concurrent execs)', async () => {
    await withWrite(writeStore, async (wt: Write) => {
      await putMany(wt, entries);
    });
  });

  const psOps = await measure('put (sequential loop)', async () => {
    await withWrite(writeStore, async (wt: Write) => {
      for (const [k, v] of entries) await wt.put(k, v);
    });
  });

  console.log(ratio(gmOps, gsOps), ' [getMany]');
  console.log(ratio(pmOps, psOps), ' [putMany]');

  await readStore.close();
  await writeStore.close();
  await provider.drop(readName);
  await provider.drop(writeName);
}

// ─── main ────────────────────────────────────────────────────────────────────

console.log('\n=== KV Store batch-ops benchmark ===\n');

for (const n of [10, 50, 100]) await benchMemStore(n);
for (const n of [10, 50, 100]) await benchSQLiteStore(n);

console.log('\n✓ Done\n');
