/**
 * Copy the cargo-built native library to `pkg-native/row_napi.node` under a
 * platform-neutral name. Run after `cargo build --release -p row-napi`.
 *
 * Production would use `@napi-rs/cli` to build + name a `.node` per platform and
 * emit a loader that picks the right one (the tsgo model); for this POC we build
 * for the host platform only.
 */
import {copyFileSync, existsSync, mkdirSync} from 'node:fs';

const candidates = [
  'target/release/librow_napi.so', // linux
  'target/release/librow_napi.dylib', // macOS
  'target/release/row_napi.dll', // windows
];
const src = candidates.find(existsSync);
if (!src) {
  throw new Error(
    'native addon not found — run `cargo build --release -p row-napi` first',
  );
}
mkdirSync('pkg-native', {recursive: true});
copyFileSync(src, 'pkg-native/row_napi.node');
console.log(`copied ${src} -> pkg-native/row_napi.node`);
