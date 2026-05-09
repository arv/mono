import {expect, test} from 'vitest';
import {SQLiteStoreRead, type PreparedStatements} from './sqlite-store.ts';

function makeMockStatements(
  opts: {
    getManyRows?: unknown[][];
    hasManyRows?: unknown[][];
  } = {},
): {
  stmts: PreparedStatements;
  getManyCallCount: () => number;
  hasManyCallCount: () => number;
} {
  let getManyCount = 0;
  let hasManyCount = 0;

  const stmts: PreparedStatements = {
    put: {async exec() {}},
    del: {async exec() {}},
    getMany: {
      async exec() {},
      // oxlint-disable-next-line require-await
      async all() {
        getManyCount++;
        return opts.getManyRows ?? [];
      },
    },
    hasMany: {
      async exec() {},
      // oxlint-disable-next-line require-await
      async all() {
        hasManyCount++;
        return opts.hasManyRows ?? [];
      },
    },
  };

  return {
    stmts,
    getManyCallCount: () => getManyCount,
    hasManyCallCount: () => hasManyCount,
  };
}

test('concurrent gets are batched into a single getMany call', async () => {
  const {stmts, getManyCallCount} = makeMockStatements({
    getManyRows: [
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

  expect(getManyCallCount()).toBe(1);
  expect(valA).toBe('alpha');
  expect(valB).toBe('beta');
  expect(valC).toBeUndefined();
});

test('concurrent has calls are batched into a single hasMany call', async () => {
  const {stmts, hasManyCallCount} = makeMockStatements({
    hasManyRows: [['a']],
  });
  const read = new SQLiteStoreRead(() => {}, stmts);

  const [hasA, hasB] = await Promise.all([read.has('a'), read.has('b')]);

  expect(hasManyCallCount()).toBe(1);
  expect(hasA).toBe(true);
  expect(hasB).toBe(false);
});

test('sequential awaited gets each trigger their own flush', async () => {
  const {stmts, getManyCallCount} = makeMockStatements();
  const read = new SQLiteStoreRead(() => {}, stmts);

  await read.get('a');
  await read.get('b');

  expect(getManyCallCount()).toBe(2);
});

test('mixed concurrent gets and has are batched separately', async () => {
  const {stmts, getManyCallCount, hasManyCallCount} = makeMockStatements();
  const read = new SQLiteStoreRead(() => {}, stmts);

  await Promise.all([read.get('a'), read.has('b'), read.get('c')]);

  expect(getManyCallCount()).toBe(1);
  expect(hasManyCallCount()).toBe(1);
});
