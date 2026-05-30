import {expect, test} from 'vitest';
import {deepFreeze} from '../frozen-json.ts';
import {withRead, withWrite} from '../with-transactions.ts';
import {dropOPFSStore, OPFSStore} from './opfs-store.ts';
import {runAll} from './store-test-util.ts';

// Run the shared store conformance suite against the OPFS implementation. Each
// invocation uses a unique name so subtests get an isolated file (an OPFS sync
// access handle holds an exclusive lock on its file).
runAll('opfs', () => new OPFSStore('test-opfs' + Math.random()));

// Run it again with the read-through cache disabled, to prove the worker path
// is correct on its own and the cache is not masking bugs.
runAll(
  'opfs-nocache',
  () => new OPFSStore('test-opfs-nc' + Math.random(), {cacheSize: 0}),
);

test('opfs: basic put/get/has/del round-trip', async () => {
  const name = 'opfs-basic-' + Math.random().toString(36).slice(2);
  await dropOPFSStore(name);
  const store = new OPFSStore(name);
  try {
    await withWrite(store, async w => {
      await w.put('a', deepFreeze({hello: 'world'}));
      await w.put('b', deepFreeze([1, 2, 3]));
      expect(await w.has('a')).toBe(true);
      expect(await w.get('a')).toEqual({hello: 'world'});
    });

    await withRead(store, async r => {
      expect(await r.has('a')).toBe(true);
      expect(await r.get('a')).toEqual({hello: 'world'});
      expect(await r.get('b')).toEqual([1, 2, 3]);
      expect(await r.has('missing')).toBe(false);
      expect(await r.get('missing')).toBeUndefined();
    });

    await withWrite(store, async w => {
      await w.del('a');
    });

    await withRead(store, async r => {
      expect(await r.has('a')).toBe(false);
      expect(await r.get('a')).toBeUndefined();
      expect(await r.get('b')).toEqual([1, 2, 3]);
    });
  } finally {
    await store.close();
    await dropOPFSStore(name);
  }
});

test('opfs: data persists across reopen', async () => {
  const name = 'opfs-persist-' + Math.random().toString(36).slice(2);
  await dropOPFSStore(name);
  let store = new OPFSStore(name);
  await withWrite(store, async w => {
    for (let i = 0; i < 50; i++) {
      await w.put('k' + i, deepFreeze({i, payload: 'x'.repeat(20)}));
    }
  });
  await store.close();

  // Reopen with a fresh instance; the index must be rebuilt from the log.
  store = new OPFSStore(name);
  try {
    await withRead(store, async r => {
      for (let i = 0; i < 50; i++) {
        expect(await r.get('k' + i)).toEqual({i, payload: 'x'.repeat(20)});
      }
    });
  } finally {
    await store.close();
    await dropOPFSStore(name);
  }
});

test('opfs: overwrites and deletes survive compaction', async () => {
  const name = 'opfs-compact-' + Math.random().toString(36).slice(2);
  await dropOPFSStore(name);
  const store = new OPFSStore(name);
  try {
    // Repeatedly overwrite the same keys with ~1KB values to force the log to
    // grow well past the live size and trigger compaction.
    const value = (n: number) => deepFreeze({n, blob: String(n).repeat(256)});
    for (let round = 0; round < 40; round++) {
      await withWrite(store, async w => {
        for (let i = 0; i < 20; i++) {
          await w.put('key' + i, value(round * 1000 + i));
        }
      });
    }
    // Delete half the keys.
    await withWrite(store, async w => {
      for (let i = 0; i < 20; i += 2) {
        await w.del('key' + i);
      }
    });

    await withRead(store, async r => {
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          expect(await r.get('key' + i)).toBeUndefined();
        } else {
          expect(await r.get('key' + i)).toEqual({
            n: 39 * 1000 + i,
            blob: String(39 * 1000 + i).repeat(256),
          });
        }
      }
    });
  } finally {
    await store.close();
    await dropOPFSStore(name);
  }
});

test('opfs: read-through cache stays coherent with overwrites and deletes', async () => {
  const name = 'opfs-cache-' + Math.random().toString(36).slice(2);
  await dropOPFSStore(name);
  const store = new OPFSStore(name, {cacheSize: 100});
  try {
    await withWrite(store, async w => {
      await w.put('a', deepFreeze({v: 1}));
    });

    // Prime the cache.
    await withRead(store, async r => {
      expect(await r.get('a')).toEqual({v: 1});
      // Negative lookup should also be cached.
      expect(await r.get('missing')).toBeUndefined();
      expect(await r.has('missing')).toBe(false);
    });

    // Overwrite then read: must see the new value, not the cached old one.
    await withWrite(store, async w => {
      await w.put('a', deepFreeze({v: 2}));
    });
    await withRead(store, async r => {
      expect(await r.get('a')).toEqual({v: 2});
    });

    // A key whose negative result was cached, then created, must now be found.
    await withWrite(store, async w => {
      await w.put('missing', deepFreeze('now here'));
    });
    await withRead(store, async r => {
      expect(await r.has('missing')).toBe(true);
      expect(await r.get('missing')).toEqual('now here');
    });

    // Delete then read: must be undefined, not the cached value.
    await withWrite(store, async w => {
      await w.del('a');
    });
    await withRead(store, async r => {
      expect(await r.get('a')).toBeUndefined();
      expect(await r.has('a')).toBe(false);
    });
  } finally {
    await store.close();
    await dropOPFSStore(name);
  }
});

test('opfs: cached reads survive a reopen (read from disk, then cache)', async () => {
  const name = 'opfs-cache-reopen-' + Math.random().toString(36).slice(2);
  await dropOPFSStore(name);
  let store = new OPFSStore(name, {cacheSize: 100});
  await withWrite(store, async w => {
    await w.put('k', deepFreeze({hello: 'world'}));
  });
  await store.close();

  // Fresh instance => empty cache => first read comes from the worker/disk and
  // populates the cache; second read is served from the cache.
  store = new OPFSStore(name, {cacheSize: 100});
  try {
    await withRead(store, async r => {
      expect(await r.get('k')).toEqual({hello: 'world'});
      expect(await r.get('k')).toEqual({hello: 'world'});
    });
  } finally {
    await store.close();
    await dropOPFSStore(name);
  }
});
