//! `wasm-bindgen` bindings over the shared `row-json` decode/serialize. A thin
//! wrapper: it maps `String` errors to `JsError` and exposes the API to JS.
//!
//! `int64` columns cross the boundary as decimal strings; `bytes` columns cross
//! as arrays of `u8`.

use row_json::JsonSchema;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmSchema {
    inner: JsonSchema,
}

#[wasm_bindgen]
impl WasmSchema {
    /// Build a schema from a JSON array of column descriptors:
    /// `[{ "name": string, "type": string, "nullable"?: bool }]`.
    #[wasm_bindgen(constructor)]
    pub fn new(schema_json: &str) -> Result<WasmSchema, JsError> {
        JsonSchema::from_json(schema_json)
            .map(|inner| WasmSchema { inner })
            .map_err(|e| JsError::new(&e))
    }

    /// Serialize one row (a JSON object of column values) into the binary
    /// layout. Returns an owned `Uint8Array`; JS reads it via `RowReader`.
    pub fn serialize_row(&self, row_json: &str) -> Result<Vec<u8>, JsError> {
        self.inner
            .serialize_row(row_json)
            .map_err(|e| JsError::new(&e))
    }

    /// Serialize `n` rows; returns total bytes written (decode once).
    pub fn bench_serialize(&self, n: u32, row_json: &str) -> Result<u32, JsError> {
        self.inner
            .bench_serialize(n, row_json)
            .map_err(|e| JsError::new(&e))
    }

    /// Total fixed-section size in bytes (for diagnostics / tests).
    #[wasm_bindgen(getter)]
    pub fn fixed_section_size(&self) -> usize {
        self.inner.fixed_section_size()
    }
}

/// IVM filter-pipeline benchmark workload (see `ivm::filter_bench`), exposed for
/// the native-vs-wasm-vs-JS comparison in `js/ivm-bench.ts`.
#[wasm_bindgen]
pub fn ivm_filter_bench(rows: u32, pushes: u32) -> u32 {
    ivm::filter_bench(rows, pushes)
}
