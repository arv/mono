import {expect, test} from 'vitest';
import {deepFreeze} from '../frozen-json.ts';
import {withRead, withWrite} from '../with-transactions.ts';
import {dropOPFSStore, OPFSStore} from './opfs-store.ts';

// Two OPFSStore instances in one page faithfully model two browser tabs: they
// get distinct BroadcastChannel objects and distinct sync access handles, but
// share navigator.locks and the single OPFS file (per origin). These tests
// would deadlock or read stale/corrupt data with the single-tab design.

function uniqueName(prefix: string): string {
  return prefix + '-' + Math.random().toString(36).slice(2);
}

test('multi-tab: second store can open the same file (no exclusive-handle lockout)', async () => {
  const name = uniqueName('mt-open');
  await dropOPFSStore(name);
  const a = new OPFSStore(name);
  const b = new OPFSStore(name);
  try {
    // With an exclusive handle this second open would throw
    // NoModificationAllowedError. With readwrite-unsafe both succeed.
    await withWrite(a, async w => {
      await w.put('k', deepFreeze('from-a'));
    });
    await withRead(b, async r => {
      expect(await r.get('k')).toEqual('from-a');
    });
  } finally {
    await a.close();
    await b.close();
    await dropOPFSStore(name);
  }
});

test("multi-tab: tab B sees tab A's committed writes", async () => {
  const name = uniqueName('mt-write');
  await dropOPFSStore(name);
  const a = new OPFSStore(name);
  const b = new OPFSStore(name);
  try {
    await withWrite(a, async w => {
      await w.put('x', deepFreeze({n: 1}));
      await w.put('y', deepFreeze({n: 2}));
    });

    // B never read these keys, so nothing to invalidate; its worker resyncs the
    // appended tail on read.
    await withRead(b, async r => {
      expect(await r.get('x')).toEqual({n: 1});
      expect(await r.get('y')).toEqual({n: 2});
    });

    // Interleave: B writes, A must observe it.
    await withWrite(b, async w => {
      await w.put('z', deepFreeze({n: 3}));
    });
    await withRead(a, async r => {
      expect(await r.get('z')).toEqual({n: 3});
    });
  } finally {
    await a.close();
    await b.close();
    await dropOPFSStore(name);
  }
});

test("multi-tab: A's cache is invalidated when B overwrites a key A had read", async () => {
  const name = uniqueName('mt-invalidate');
  await dropOPFSStore(name);
  const a = new OPFSStore(name);
  const b = new OPFSStore(name);
  try {
    await withWrite(a, async w => {
      await w.put('k', deepFreeze({v: 1}));
    });
    // A reads 'k' -> now cached as {v:1} in A.
    await withRead(a, async r => {
      expect(await r.get('k')).toEqual({v: 1});
    });

    // B overwrites 'k'. This broadcasts a change message for 'k'.
    await withWrite(b, async w => {
      await w.put('k', deepFreeze({v: 2}));
    });

    // BroadcastChannel invalidation is asynchronous and not ordered against the
    // cross-tab Web Lock handoff, so cross-tab cache coherence is eventual:
    // there is a brief window after B commits in which A could still serve the
    // old cached value. Yield so the change message is delivered before we read.
    await new Promise(r => setTimeout(r, 50));

    // A must now see the new value, not its cached {v:1}.
    await withRead(a, async r => {
      expect(await r.get('k')).toEqual({v: 2});
    });
  } finally {
    await a.close();
    await b.close();
    await dropOPFSStore(name);
  }
});

test('multi-tab: concurrent writers are serialized by the cross-tab Web Lock', async () => {
  const name = uniqueName('mt-concurrent');
  await dropOPFSStore(name);
  const a = new OPFSStore(name);
  const b = new OPFSStore(name);
  try {
    await withWrite(a, async w => {
      await w.put('counter', deepFreeze(0));
    });

    // Fire many increments from both "tabs" at once. Each does read-modify-write
    // inside a single write transaction; the exclusive cross-tab lock must make
    // these atomic with respect to each other.
    const bump = (store: OPFSStore) =>
      withWrite(store, async w => {
        const cur = (await w.get('counter')) as number;
        await w.put('counter', deepFreeze(cur + 1));
      });

    const N = 10;
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      ops.push(bump(a), bump(b));
    }
    await Promise.all(ops);

    // If writes were serialized, every increment landed: counter === 2*N.
    await withRead(a, async r => {
      expect(await r.get('counter')).toEqual(2 * N);
    });
  } finally {
    await a.close();
    await b.close();
    await dropOPFSStore(name);
  }
});
