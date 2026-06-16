//! Minimal wasm surface to measure the serializer-only size floor: typed args
//! in, binary row out, no serde_json / JSON parsing, no ivm.

use row_core::{ColumnDef, ColumnType, ColumnValue, RowSchema};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn serialize_one(id: i64, name: &str, score: f64, active: bool) -> Vec<u8> {
    let schema = RowSchema::new(vec![
        ColumnDef {
            name: "id".into(),
            col_type: ColumnType::Int64,
            nullable: false,
        },
        ColumnDef {
            name: "name".into(),
            col_type: ColumnType::Str,
            nullable: false,
        },
        ColumnDef {
            name: "score".into(),
            col_type: ColumnType::Float64,
            nullable: false,
        },
        ColumnDef {
            name: "active".into(),
            col_type: ColumnType::Bool,
            nullable: false,
        },
    ]);
    schema.serialize(&[
        ColumnValue::Int64(id),
        ColumnValue::Str(name),
        ColumnValue::Float64(score),
        ColumnValue::Bool(active),
    ])
}
