//! Shared JSON decode + binary serialize, used by both the wasm and the native
//! (napi) bindings so the decode logic lives in one place.
//!
//! Binding-agnostic: errors are plain `String`s that each binding maps to its
//! own error type (`JsError`, `napi::Error`, …). The schema is compiled once in
//! [`JsonSchema::from_json`]; after that, serializing a row is just offset
//! writes — JSON decoding of the row input is kept separate from serialization.
//!
//! `int64` columns cross the boundary as decimal strings (to dodge BigInt
//! friction); `bytes` columns cross as arrays of `u8`.

use row_core::{ColumnDef, ColumnType, ColumnValue, RowSchema};
use serde::Deserialize;
use serde_json::Value;

/// One entry in the schema JSON array: `{ name, type, nullable? }`.
#[derive(Deserialize)]
struct ColumnDescriptor {
    name: String,
    #[serde(rename = "type")]
    col_type: String,
    #[serde(default)]
    nullable: bool,
}

fn parse_type(s: &str) -> Result<ColumnType, String> {
    Ok(match s {
        "bool" => ColumnType::Bool,
        "int32" => ColumnType::Int32,
        "int64" => ColumnType::Int64,
        "float64" => ColumnType::Float64,
        "string" => ColumnType::Str,
        "json" => ColumnType::Json,
        "bytes" => ColumnType::Bytes,
        other => return Err(format!("unknown column type: {other}")),
    })
}

/// A decoded column value, owned and already in column order.
enum OwnedValue {
    Null,
    Bool(bool),
    Int32(i32),
    Int64(i64),
    Float64(f64),
    Str(String),
    Json(String),
    Bytes(Vec<u8>),
}

impl OwnedValue {
    fn as_column_value(&self) -> ColumnValue<'_> {
        match self {
            OwnedValue::Null => ColumnValue::Null,
            OwnedValue::Bool(v) => ColumnValue::Bool(*v),
            OwnedValue::Int32(v) => ColumnValue::Int32(*v),
            OwnedValue::Int64(v) => ColumnValue::Int64(*v),
            OwnedValue::Float64(v) => ColumnValue::Float64(*v),
            OwnedValue::Str(s) => ColumnValue::Str(s),
            OwnedValue::Json(s) => ColumnValue::Json(s),
            OwnedValue::Bytes(b) => ColumnValue::Bytes(b),
        }
    }
}

/// Returns the value for `name` only if present and not JSON null.
fn present<'a>(map: &'a serde_json::Map<String, Value>, name: &str) -> Option<&'a Value> {
    match map.get(name) {
        Some(v) if !v.is_null() => Some(v),
        _ => None,
    }
}

/// A compiled schema that decodes JSON row objects and serializes them to the
/// binary layout. Offsets are computed once in [`Self::from_json`].
pub struct JsonSchema {
    inner: RowSchema,
}

impl JsonSchema {
    pub fn from_json(schema_json: &str) -> Result<Self, String> {
        let descriptors: Vec<ColumnDescriptor> =
            serde_json::from_str(schema_json).map_err(|e| format!("invalid schema json: {e}"))?;
        let mut defs = Vec::with_capacity(descriptors.len());
        for d in descriptors {
            let col_type = parse_type(&d.col_type)?;
            defs.push(ColumnDef {
                name: d.name,
                col_type,
                nullable: d.nullable,
            });
        }
        Ok(Self {
            inner: RowSchema::new(defs),
        })
    }

    pub fn fixed_section_size(&self) -> usize {
        self.inner.fixed_section_size
    }

    /// Decode + serialize one JSON row object into the binary layout.
    pub fn serialize_row(&self, row_json: &str) -> Result<Vec<u8>, String> {
        let decoded = self.decode_row(row_json)?;
        let values: Vec<ColumnValue<'_>> =
            decoded.iter().map(OwnedValue::as_column_value).collect();
        Ok(self.inner.serialize(&values))
    }

    /// Decode once, serialize `n` times; returns total bytes written. Isolates
    /// the serialization cost from JSON parsing.
    pub fn bench_serialize(&self, n: u32, row_json: &str) -> Result<u32, String> {
        let decoded = self.decode_row(row_json)?;
        let values: Vec<ColumnValue<'_>> =
            decoded.iter().map(OwnedValue::as_column_value).collect();
        let mut total = 0u32;
        for _ in 0..n {
            total = total.wrapping_add(self.inner.serialize(&values).len() as u32);
        }
        Ok(total)
    }

    fn decode_row(&self, row_json: &str) -> Result<Vec<OwnedValue>, String> {
        let value: Value =
            serde_json::from_str(row_json).map_err(|e| format!("invalid row json: {e}"))?;
        let map = value
            .as_object()
            .ok_or_else(|| "row json must be an object".to_string())?;

        let mut out = Vec::with_capacity(self.inner.columns.len());
        for col in &self.inner.columns {
            let name = &col.def.name;
            let Some(v) = present(map, name) else {
                out.push(OwnedValue::Null);
                continue;
            };
            let owned = match col.def.col_type {
                ColumnType::Bool => OwnedValue::Bool(
                    v.as_bool()
                        .ok_or_else(|| format!("bool column {name} invalid"))?,
                ),
                ColumnType::Int32 => {
                    let x = v
                        .as_i64()
                        .ok_or_else(|| format!("int32 column {name} invalid"))?;
                    OwnedValue::Int32(x as i32)
                }
                ColumnType::Int64 => {
                    let s = v
                        .as_str()
                        .ok_or_else(|| format!("int64 column {name} must be a string"))?;
                    OwnedValue::Int64(
                        s.parse()
                            .map_err(|e| format!("invalid int64 for column {name}: {e}"))?,
                    )
                }
                ColumnType::Float64 => OwnedValue::Float64(
                    v.as_f64()
                        .ok_or_else(|| format!("float64 column {name} invalid"))?,
                ),
                ColumnType::Str => OwnedValue::Str(
                    v.as_str()
                        .ok_or_else(|| format!("string column {name} invalid"))?
                        .to_owned(),
                ),
                ColumnType::Json => OwnedValue::Json(
                    serde_json::to_string(v)
                        .map_err(|e| format!("cannot serialize json column {name}: {e}"))?,
                ),
                ColumnType::Bytes => {
                    let arr = v
                        .as_array()
                        .ok_or_else(|| format!("bytes column {name} must be an array of u8"))?;
                    let mut bytes = Vec::with_capacity(arr.len());
                    for elem in arr {
                        let byte = elem
                            .as_u64()
                            .filter(|n| *n <= u8::MAX as u64)
                            .ok_or_else(|| format!("bytes column {name} has a non-u8 element"))?;
                        bytes.push(byte as u8);
                    }
                    OwnedValue::Bytes(bytes)
                }
            };
            out.push(owned);
        }
        Ok(out)
    }
}
