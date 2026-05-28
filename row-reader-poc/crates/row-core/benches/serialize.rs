//! Criterion benchmark for pure-Rust serialization, isolated from any WASM
//! call overhead. The plan placed this at the workspace root; cargo requires
//! benches to live inside a package, so it lives in `row-core`.

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use row_core::{ColumnDef, ColumnType, ColumnValue, RowSchema};

fn make_schema() -> RowSchema {
    RowSchema::new(vec![
        ColumnDef {
            name: "id".into(),
            col_type: ColumnType::Int64,
            nullable: false,
        },
        ColumnDef {
            name: "user_id".into(),
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
        ColumnDef {
            name: "metadata".into(),
            col_type: ColumnType::Json,
            nullable: true,
        },
    ])
}

fn bench_serialize(c: &mut Criterion) {
    let schema = make_schema();
    let metadata_json = r#"{"tags":["a","b"],"count":3}"#;

    let values = vec![
        ColumnValue::Int64(1),
        ColumnValue::Int64(42),
        ColumnValue::Str("Alice"),
        ColumnValue::Float64(9.81),
        ColumnValue::Bool(true),
        ColumnValue::Json(metadata_json),
    ];

    c.bench_function("serialize_row", |b| {
        b.iter(|| schema.serialize(black_box(&values)))
    });

    // Baseline: serde_json serialization of an equivalent object.
    let obj = serde_json::json!({
        "id": 1,
        "user_id": 42,
        "name": "Alice",
        "score": 9.81,
        "active": true,
        "metadata": { "tags": ["a", "b"], "count": 3 }
    });

    c.bench_function("serde_json_serialize", |b| {
        b.iter(|| serde_json::to_vec(black_box(&obj)).unwrap())
    });
}

criterion_group!(benches, bench_serialize);
criterion_main!(benches);
