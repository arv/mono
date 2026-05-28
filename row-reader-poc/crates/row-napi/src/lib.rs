//! Native Node addon (napi-rs) over the shared `row-json` decode/serialize.
//!
//! This is the `tsgo`-style alternative to wasm for Node: a per-platform native
//! `.node` binary that calls Rust directly — no wasm boundary, no wasm-bindgen
//! glue. The API mirrors `WasmSchema` (napi-derive lowercases to camelCase:
//! `serializeRow`, `benchSerialize`, `fixedSectionSize`) so the two can be
//! benchmarked head to head on identical inputs.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use row_json::JsonSchema;

#[napi]
pub struct NativeSchema {
    inner: JsonSchema,
}

#[napi]
impl NativeSchema {
    #[napi(constructor)]
    pub fn new(schema_json: String) -> napi::Result<Self> {
        JsonSchema::from_json(&schema_json)
            .map(|inner| NativeSchema { inner })
            .map_err(napi::Error::from_reason)
    }

    /// Serialize one row (a JSON object) into the binary layout; returns a Node
    /// `Buffer` over the bytes.
    #[napi]
    pub fn serialize_row(&self, row_json: String) -> napi::Result<Buffer> {
        self.inner
            .serialize_row(&row_json)
            .map(Buffer::from)
            .map_err(napi::Error::from_reason)
    }

    /// Serialize `n` rows; returns total bytes written (decode once).
    #[napi]
    pub fn bench_serialize(&self, n: u32, row_json: String) -> napi::Result<u32> {
        self.inner
            .bench_serialize(n, &row_json)
            .map_err(napi::Error::from_reason)
    }

    #[napi(getter)]
    pub fn fixed_section_size(&self) -> u32 {
        self.inner.fixed_section_size() as u32
    }
}
