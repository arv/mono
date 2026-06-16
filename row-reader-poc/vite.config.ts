import {resolve} from 'node:path';
import {defineConfig} from 'vite';

// COOP/COEP make the page cross-origin isolated, which is required for
// SharedArrayBuffer + Atomics.waitAsync (the threads-sab.html demo).
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Three pages: the single-worker smoke test (index.html), the postMessage
// multi-worker benchmark (threads.html), and the SharedArrayBuffer-ring
// benchmark (threads-sab.html). All use the --target web wasm in pkg-web.
export default defineConfig({
  server: {headers: crossOriginIsolation},
  preview: {headers: crossOriginIsolation},
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        'index': resolve(import.meta.dirname, 'index.html'),
        'threads': resolve(import.meta.dirname, 'threads.html'),
        'threads-sab': resolve(import.meta.dirname, 'threads-sab.html'),
      },
    },
  },
});
