/**
 * Benchmark: getMany / putMany for expo-sqlite and op-sqlite store paths
 *
 * These stores can't run on Node.js natively (they need the React Native
 * bridge), so we use @rocicorp/zero-sqlite3 under the hood but wrap every
 * operation in the same number of Promise/async hops that the real libraries
 * use.  On actual devices each of those hops also crosses the JS→native bridge
 * (~0.5–2 ms).  The Node.js numbers show the structural overhead; multiply the
 * per-hop count by your bridge latency to estimate the real savings.
 *
 * Async-hop counts per individual key operation:
 *   expo-sqlite get/put  → 2 hops  (executeForRawResultAsync + getFirstAsync)
 *   op-sqlite   get/put  → 1 hop   (executeRaw)
 *
 * With getMany/putMany those hops collapse to a *constant* count regardless
 * of how many keys are requested.
 *
 * Run:
 *   node --expose-gc --import tsx/esm \
 *     packages/replicache/src/kv/batch-ops-rn.bench.node.ts
 */
import {existsSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sqlite3 from '@rocicorp/zero-sqlite3';
import {withRead, withWrite} from '../with-transactions.ts';
import type {
  PreparedStatement,
  SQLiteDatabase,
  SQLiteStoreOptions,
} from './sqlite-store.ts';
import {SQLiteStore} from './sqlite-store.ts';
import type {Read, Store, Write} from './store.ts';
import {getMany, putMany} from './store.ts';

// ─── Mock SQLiteDatabase implementations ─────────────────────────────────────
// Each wraps zero-sqlite3 in async Promises to mirror the number of async hops
// the real React Native binding uses.  On RN each hop also crosses the bridge.

class ExpoLikePreparedStatement implements PreparedStatement {
  readonly #stmt: sqlite3.Statement;

  constructor(stmt: sqlite3.Statement) {
    this.#stmt = stmt;
  }

  // expo: executeForRawResultAsync → Promise  +  getFirstAsync → Promise = 2 hops
  async firstValue(params: string[]): Promise<unknown> {
    const rows = await Promise.resolve(
      this.#stmt.all(...params) as Record<string, unknown>[],
    );
    const row = await Promise.resolve(rows[0] ? Object.values(rows[0]) : null);
    return row ? row[0] : undefined;
  }

  // expo: executeForRawResultAsync → Promise = 1 hop
  async exec(params: string[]): Promise<void> {
    await Promise.resolve(this.#stmt.run(params));
  }
}

class ExpoLikeSQLiteDatabase implements SQLiteDatabase {
  readonly #db: sqlite3.Database;
  readonly #filename: string;

  constructor(filename: string, opts?: SQLiteStoreOptions) {
    this.#filename = filename;
    this.#db = sqlite3(filename);
    this.#db.exec(
      `PRAGMA journal_mode=${opts?.journalMode ?? 'WAL'};` +
        `PRAGMA synchronous=${opts?.synchronous ?? 'NORMAL'};`,
    );
  }

  close() {
    this.#db.close();
  }
  destroy() {
    if (existsSync(this.#filename)) unlinkSync(this.#filename);
  }
  execSync(sql: string) {
    this.#db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    return new ExpoLikePreparedStatement(this.#db.prepare(sql));
  }

  // expo executeForRows: executeForRawResultAsync → Promise + getAllAsync → Promise = 2 hops
  async executeForRows(
    sql: string,
    params: string[],
  ): Promise<[string, string][]> {
    const rows = await Promise.resolve(
      this.#db.prepare(sql).all(...params) as Record<string, unknown>[],
    );
    return await Promise.resolve(
      rows.map(r => Object.values(r) as [string, string]),
    );
  }
}

class OpSQLikePreparedStatement implements PreparedStatement {
  readonly #stmt: sqlite3.Statement;

  constructor(stmt: sqlite3.Statement) {
    this.#stmt = stmt;
  }

  // op-sqlite: executeRaw → Promise = 1 hop
  async firstValue(params: string[]): Promise<unknown> {
    const rows = await Promise.resolve(
      (this.#stmt.all(...params) as Record<string, unknown>[]).map(r =>
        Object.values(r),
      ),
    );
    return rows[0]?.[0];
  }

  // op-sqlite: executeRaw → Promise = 1 hop
  async exec(params: string[]): Promise<void> {
    await Promise.resolve(this.#stmt.run(params));
  }
}

class OpSQLikeSQLiteDatabase implements SQLiteDatabase {
  readonly #db: sqlite3.Database;
  readonly #filename: string;

  constructor(filename: string, opts?: SQLiteStoreOptions) {
    this.#filename = filename;
    this.#db = sqlite3(filename);
    this.#db.exec(
      `PRAGMA journal_mode=${opts?.journalMode ?? 'WAL'};` +
        `PRAGMA synchronous=${opts?.synchronous ?? 'NORMAL'};`,
    );
  }

  close() {
    this.#db.close();
  }
  destroy() {
    if (existsSync(this.#filename)) unlinkSync(this.#filename);
  }
  execSync(sql: string) {
    this.#db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    return new OpSQLikePreparedStatement(this.#db.prepare(sql));
  }

  // op-sqlite executeForRows: executeRaw → Promise = 1 hop
  async executeForRows(
    sql: string,
    params: string[],
  ): Promise<[string, string][]> {
    const rows = await Promise.resolve(
      (this.#db.prepare(sql).all(...params) as Record<string, unknown>[]).map(
        r => Object.values(r) as [string, string],
      ),
    );
    return rows;
  }
}

// ─── Store factories ──────────────────────────────────────────────────────────

const dir = tmpdir();
let storeSeq = 0;

function makeExpoStore(tag: string): Store {
  const name = `bench_expo_${tag}_${++storeSeq}`;
  return new SQLiteStore(
    name,
    filename =>
      new ExpoLikeSQLiteDatabase(join(dir, `${filename}.db`), {
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      }),
  );
}

function makeOpStore(tag: string): Store {
  const name = `bench_op_${tag}_${++storeSeq}`;
  return new SQLiteStore(
    name,
    filename =>
      new OpSQLikeSQLiteDatabase(join(dir, `${filename}.db`), {
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      }),
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntries(n: number): [string, string][] {
  return Array.from({length: n}, (_, i) => [
    `key_${i.toString().padStart(6, '0')}`,
    `value_${i}`,
  ]);
}

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
    `  ${label.padEnd(44)} ${opsPerSec.toFixed(0).padStart(9)} ops/s  (${usPerOp.toFixed(1)} µs/op)`,
  );
  return opsPerSec;
}

function header(title: string) {
  const w = 78;
  console.log(`\n${'─'.repeat(w)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(w));
  console.log(`  ${'benchmark'.padEnd(44)} ${'ops/s'.padStart(9)}  latency`);
  console.log('─'.repeat(w));
}

function ratio(batch: number, seq: number, what: string) {
  const x = (batch / seq).toFixed(2);
  const dir = batch >= seq ? 'faster' : 'slower';
  console.log(`  → ${what}: ${x}x ${dir} than sequential`);
}

// ─── Per-library suite ────────────────────────────────────────────────────────

async function runSuite(
  libName: string,
  hopsPerGet: number,
  makeStore: (tag: string) => Store,
  n: number,
) {
  const bridgeNote =
    `(${hopsPerGet} bridge hop${hopsPerGet > 1 ? 's' : ''}/op on RN → ` +
    `~${hopsPerGet} ms saved per key at 1 ms/hop)`;
  header(`${libName} — ${n} keys  ${bridgeNote}`);

  const entries = makeEntries(n);
  const keys = entries.map(([k]) => k);

  // Pre-populate two long-lived stores (one for reads, one for writes).
  const readStore = makeStore('read');
  await withWrite(readStore, async wt => {
    for (const [k, v] of entries) await wt.put(k, v);
  });
  const writeStore = makeStore('write');

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

  const pmOps = await measure('putMany (concurrent Promise.all)', async () => {
    await withWrite(writeStore, async (wt: Write) => {
      await putMany(wt, entries);
    });
  });

  const psOps = await measure('put (sequential loop)', async () => {
    await withWrite(writeStore, async (wt: Write) => {
      for (const [k, v] of entries) await wt.put(k, v);
    });
  });

  ratio(gmOps, gsOps, 'getMany');
  ratio(pmOps, psOps, 'putMany');

  await readStore.close();
  await writeStore.close();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n=== React Native KV store batch-ops benchmark ===');
console.log(
  "Using zero-sqlite3 with Promise wrappers that mirror each library's\n" +
    'async call structure.  "Bridge hops" = how many async awaits each\n' +
    'operation requires; on real devices each hop costs ~0.5–2 ms extra.\n',
);

for (const n of [10, 50, 100]) {
  await runSuite('expo-sqlite (2 hops/get, 1 hop/put)', 2, makeExpoStore, n);
}
for (const n of [10, 50, 100]) {
  await runSuite('op-sqlite  (1 hop/get, 1 hop/put)', 1, makeOpStore, n);
}

// ─── Projected real-device savings ───────────────────────────────────────────
// The Node.js numbers only show SQL overhead, not bridge latency.
// On real RN devices, each async hop costs ~0.5–2 ms.
// getMany collapses N×hops bridge round-trips to a constant (hops per call).

console.log('\n' + '═'.repeat(78));
console.log('  Projected bridge-latency savings on real React Native devices');
console.log('═'.repeat(78));
console.log('  (assuming 1 ms per bridge crossing; expo has 2 crossings/get)');
console.log();
console.log(
  '  library      keys   sequential cost   getMany cost   speedup (reads)',
);
console.log('  ' + '─'.repeat(74));

for (const [lib, hops] of [
  ['expo-sqlite', 2],
  ['op-sqlite  ', 1],
] as const) {
  for (const n of [10, 50, 100]) {
    const seqMs = (n * hops).toFixed(0).padStart(3);
    const batchMs = hops.toFixed(0);
    const speedup = (n * hops) / hops; // = N
    console.log(
      `  ${lib}  ${String(n).padStart(3)} keys     ${seqMs} ms            ${batchMs} ms          ${speedup.toFixed(0)}x`,
    );
  }
}

console.log('\n  Note: putMany speedup = N×1 ms → 1 ms for both libraries.\n');
console.log('✓ Done\n');
