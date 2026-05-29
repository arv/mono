/**
 * Loads the native (napi) addon and types its surface. The `.node` binary is a
 * Node-native module — loaded with `createRequire`, no wasm. Build it with
 * `pnpm run build:native`.
 */
import {createRequire} from 'node:module';

export interface NativeSchema {
  /** Serialize one JSON row object into the binary layout (Node Buffer). */
  serializeRow(rowJson: string): Buffer;
  /** Serialize `n` rows (decode once); returns total bytes. */
  benchSerialize(n: number, rowJson: string): number;
  readonly fixedSectionSize: number;
}

interface NativeAddon {
  NativeSchema: new (schemaJson: string) => NativeSchema;
  ivmFilterBench: (rows: number, pushes: number) => number;
}

const require = createRequire(import.meta.url);
const addon = require('../../pkg-native/row_napi.node') as NativeAddon;

export const NativeSchema = addon.NativeSchema;
export const ivmFilterBench = addon.ivmFilterBench;
