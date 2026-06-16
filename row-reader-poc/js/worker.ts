/// <reference lib="webworker" />
import init, {WasmSchema} from '../pkg-web/row_wasm.js';
import {demoSchemaJson} from './demo-schema.ts';

// `--target web` requires initializing the wasm module before first use.
const ready = init().then(() => new WasmSchema(demoSchemaJson));

self.onmessage = async (e: MessageEvent) => {
  if (e.data?.type !== 'serialize') return;
  const schema = await ready;
  const buf = schema.serialize_row(e.data.rowJson);
  const buffer = buf.buffer as ArrayBuffer;
  // Transfer ownership to the main thread — zero copy.
  (self as DedicatedWorkerGlobalScope).postMessage({buffer}, [buffer]);
};
