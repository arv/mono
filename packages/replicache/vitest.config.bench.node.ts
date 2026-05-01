import {resolve} from 'node:path';
import {mergeConfig} from 'vitest/config';
import {benchConfig} from '../../packages/shared/src/tool/vitest-config.ts';

export default mergeConfig(benchConfig, {
  root: resolve(import.meta.dirname),
  test: {
    name: 'replicache/bench/node',
    browser: {
      enabled: false,
    },
    include: ['src/**/*.bench.node.?(c|m)[jt]s?(x)'],
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--expose-gc'],
      },
    },
  },
});
