//! `wasm-bindgen` bindings over `row-core`.
//!
//! JS hands us the schema and each row as JSON strings; we return the binary
//! row buffer as a `Uint8Array`. `int64` columns cross the boundary as decimal
//! strings (Option A in the plan) to dodge wasm-bindgen's `i64`/`BigInt`
//! friction, and `bytes` columns cross as arrays of `u8`.

use row_core::{ColumnDef, ColumnType, ColumnValue, RowSchema};
use serde::Deserialize;
use serde_json::Value;
use wasm_bindgen::prelude::*;

/// Shape of one entry in the schema JSON array: `{ name, type, nullable? }`.
#[derive(Deserialize)]
struct ColumnDescriptor {
    name: String,
    #[serde(rename = "type")]
    col_type: String,
    #[serde(default)]
    nullable: bool,
}

fn parse_type(s: &str) -> Result<ColumnType, JsError> {
    Ok(match s {
        "bool" => ColumnType::Bool,
        "int32" => ColumnType::Int32,
        "int64" => ColumnType::Int64,
        "float64" => ColumnType::Float64,
        "string" => ColumnType::Str,
        "json" => ColumnType::Json,
        "bytes" => ColumnType::Bytes,
        other => return Err(JsError::new(&format!("unknown column type: {other}"))),
    })
}

#[wasm_bindgen]
pub struct WasmSchema {
    inner: RowSchema,
}

#[wasm_bindgen]
impl WasmSchema {
    /// Build a schema from a JSON array of column descriptors:
    /// `[{ "name": string, "type": string, "nullable"?: bool }]`.
    #[wasm_bindgen(constructor)]
    pub fn new(schema_json: &str) -> Result<WasmSchema, JsError> {
        let descriptors: Vec<ColumnDescriptor> = serde_json::from_str(schema_json)
            .map_err(|e| JsError::new(&format!("invalid schema json: {e}")))?;

        let mut defs = Vec::with_capacity(descriptors.len());
        for d in descriptors {
            let col_type = parse_type(&d.col_type)?;
            defs.push(ColumnDef {
                name: d.name,
                col_type,
                nullable: d.nullable,
            });
        }

        Ok(WasmSchema {
            inner: RowSchema::new(defs),
        })
    }

    /// Serialize one row (a JSON object of column values) into the binary
    /// layout. Returns an owned `Uint8Array`; JS reads it via `RowReader`.
    pub fn serialize_row(&self, row_json: &str) -> Result<Vec<u8>, JsError> {
        let value: Value = serde_json::from_str(row_json)
            .map_err(|e| JsError::new(&format!("invalid row json: {e}")))?;
        let map = value
            .as_object()
            .ok_or_else(|| JsError::new("row json must be an object"))?;

        let n = self.inner.columns.len();

        // Pass 1: materialize owned storage for values that can't borrow
        // straight from `map` — re-serialized JSON columns, decoded byte
        // arrays, and int64s parsed out of their string form.
        let mut json_strings: Vec<Option<String>> = vec![None; n];
        let mut byte_bufs: Vec<Option<Vec<u8>>> = vec![None; n];
        let mut int64s: Vec<i64> = vec![0; n];

        for (i, col) in self.inner.columns.iter().enumerate() {
            let name = &col.def.name;
            let Some(v) = present(map, name) else {
                continue;
            };
            match col.def.col_type {
                ColumnType::Json => {
                    json_strings[i] = Some(serde_json::to_string(v).map_err(|e| {
                        JsError::new(&format!("cannot serialize json column {name}: {e}"))
                    })?);
                }
                ColumnType::Bytes => {
                    let arr = v.as_array().ok_or_else(|| {
                        JsError::new(&format!("bytes column {name} must be an array of u8"))
                    })?;
                    let mut bytes = Vec::with_capacity(arr.len());
                    for elem in arr {
                        let byte = elem
                            .as_u64()
                            .filter(|n| *n <= u8::MAX as u64)
                            .ok_or_else(|| {
                                JsError::new(&format!("bytes column {name} has a non-u8 element"))
                            })?;
                        bytes.push(byte as u8);
                    }
                    byte_bufs[i] = Some(bytes);
                }
                ColumnType::Int64 => {
                    let s = v.as_str().ok_or_else(|| {
                        JsError::new(&format!("int64 column {name} must be a string"))
                    })?;
                    int64s[i] = s.parse::<i64>().map_err(|e| {
                        JsError::new(&format!("invalid int64 for column {name}: {e}"))
                    })?;
                }
                _ => {}
            }
        }

        // Pass 2: build the borrowed ColumnValue slice and serialize.
        let mut values: Vec<ColumnValue<'_>> = Vec::with_capacity(n);
        for (i, col) in self.inner.columns.iter().enumerate() {
            let name = &col.def.name;
            let Some(v) = present(map, name) else {
                values.push(ColumnValue::Null);
                continue;
            };
            let cv = match col.def.col_type {
                ColumnType::Bool => ColumnValue::Bool(
                    v.as_bool()
                        .ok_or_else(|| JsError::new(&format!("bool column {name} invalid")))?,
                ),
                ColumnType::Int32 => {
                    let x = v
                        .as_i64()
                        .ok_or_else(|| JsError::new(&format!("int32 column {name} invalid")))?;
                    ColumnValue::Int32(x as i32)
                }
                ColumnType::Int64 => ColumnValue::Int64(int64s[i]),
                ColumnType::Float64 => ColumnValue::Float64(
                    v.as_f64()
                        .ok_or_else(|| JsError::new(&format!("float64 column {name} invalid")))?,
                ),
                ColumnType::Str => ColumnValue::Str(
                    v.as_str()
                        .ok_or_else(|| JsError::new(&format!("string column {name} invalid")))?,
                ),
                ColumnType::Json => ColumnValue::Json(json_strings[i].as_deref().unwrap()),
                ColumnType::Bytes => ColumnValue::Bytes(byte_bufs[i].as_deref().unwrap()),
            };
            values.push(cv);
        }

        Ok(self.inner.serialize(&values))
    }

    /// Serialize `n` copies of the same row; returns total bytes written. Used
    /// to measure serialization throughput with minimal JS<->WASM crossings.
    pub fn bench_serialize(&self, n: u32, row_json: &str) -> Result<u32, JsError> {
        let mut total = 0u32;
        for _ in 0..n {
            let buf = self.serialize_row(row_json)?;
            total = total.wrapping_add(buf.len() as u32);
        }
        Ok(total)
    }

    /// Total fixed-section size in bytes (for diagnostics / tests).
    #[wasm_bindgen(getter)]
    pub fn fixed_section_size(&self) -> usize {
        self.inner.fixed_section_size
    }
}

/// Returns the value for `name` only if present and not JSON null.
fn present<'a>(map: &'a serde_json::Map<String, Value>, name: &str) -> Option<&'a Value> {
    match map.get(name) {
        Some(v) if !v.is_null() => Some(v),
        _ => None,
    }
}
