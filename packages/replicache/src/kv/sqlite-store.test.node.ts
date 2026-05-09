import {expect, test} from 'vitest';
import {SQLiteStoreRead, type PreparedStatements} from './sqlite-store.ts';

function makeMockStatements(
  opts: {
    getRows?: unknown[][];
    hasRows?: unknown[][];
  } = {},
): {
  stmts: PreparedStatements;
  getCallCount: () => number;
  hasCallCount: () => number;
} {
  let getCount = 0;
  let hasCount = 0;

  const stmts: PreparedStatements = {
    put: {async exec() {}, all: () => Promise.resolve([])},
    del: {async exec() {}, all: () => Promise.resolve([])},
    get: {
      async exec() {},
      // oxlint-disable-next-line require-await
      async all() {
        getCount++;
        return opts.getRows ?? [];
      },
    },
    has: {
      async exec() {},
      // oxlint-disable-next-line require-await
      async all() {
        hasCount++;
        return opts.hasRows ?? [];
      },
    },
  };

  return {
    stmts,
    getCallCount: () => getCount,
    hasCallCount: () => hasCount,
  };
}

test('concurrent gets are batched into a single get call', async () => {
  const {stmts, getCallCount} = makeMockStatements({
    getRows: [
      ['a', '"alpha"'],
      ['b', '"beta"'],
    ],
  });
  const read = new SQLiteStoreRead(() => {}, stmts);

  const [valA, valB, valC] = await Promise.all([
    read.get('a'),
    read.get('b'),
    read.get('c'),
  ]);

  expect(getCallCount()).toBe(1);
  expect(valA).toBe('alpha');
  expect(valB).toBe('beta');
  expect(valC).toBeUndefined();
});

test('concurrent has calls are batched into a single has call', async () => {
  const {stmts, hasCallCount} = makeMockStatements({
    hasRows: [['a']],
  });
  const read = new SQLiteStoreRead(() => {}, stmts);

  const [hasA, hasB] = await Promise.all([read.has('a'), read.has('b')]);

  expect(hasCallCount()).toBe(1);
  expect(hasA).toBe(true);
  expect(hasB).toBe(false);
});

test('sequential awaited gets each trigger their own flush', async () => {
  const {stmts, getCallCount} = makeMockStatements();
  const read = new SQLiteStoreRead(() => {}, stmts);

  await read.get('a');
  await read.get('b');

  expect(getCallCount()).toBe(2);
});

test('mixed concurrent gets and has are batched separately', async () => {
  const {stmts, getCallCount, hasCallCount} = makeMockStatements();
  const read = new SQLiteStoreRead(() => {}, stmts);

  await Promise.all([read.get('a'), read.has('b'), read.get('c')]);

  expect(getCallCount()).toBe(1);
  expect(hasCallCount()).toBe(1);
});
