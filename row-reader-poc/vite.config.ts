import {resolve} from 'node:path';
import {defineConfig} from 'vite';

// Two pages: the single-worker smoke test (index.html) and the multi-worker
// demo (threads.html). Both use the `--target web` wasm in pkg-web.
export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        threads: resolve(import.meta.dirname, 'threads.html'),
      },
    },
  },
});
