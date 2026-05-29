use crate::{Change, Comparator, Filter, MemorySource, Pipeline, Row, Schema, Value, View};

fn make_row(id: i64, active: bool) -> Row {
    Row::new(vec![
        Value::Int(id),
        Value::Bool(active),
        Value::Float(id as f64 * 1.5),
        Value::Str(format!("row{id}")),
    ])
}

/// Build a source -> filter -> view pipeline, hydrate `rows` rows, then apply
/// `pushes` membership-flipping edits, and return the final view size.
///
/// Deterministic and pure (no external state), so the byte-for-byte identical
/// workload in `js/ivm/reference.ts` lets the JS, wasm, and native runs be
/// compared apples-to-apples (they must agree on the returned size). The edits
/// flip `active`, exercising the filter's add/remove/edit splitting and the
/// view's incremental insert/remove on every push.
pub fn filter_bench(rows: u32, pushes: u32) -> u32 {
    let rows = rows.max(1) as i64;
    let schema = Schema::new(&["id", "active", "score", "name"]);
    let cmp = Comparator::new(&schema, &["id"]);
    let active = schema.index_of("active").unwrap();

    let mut source = MemorySource::new(cmp.clone());
    for k in 0..rows {
        source.insert(make_row(k, k % 3 != 0));
    }
    let filter = Filter::new(move |r| r.get(active) == &Value::Bool(true));
    let mut pipeline = Pipeline::new(source, vec![Box::new(filter)], View::new(cmp));
    pipeline.hydrate();

    for i in 0..pushes as i64 {
        let id = i % rows;
        let times = i / rows; // prior flips on this id
        let init = id % 3 != 0;
        let old_active = init ^ (times % 2 == 1);
        pipeline.push(Change::Edit {
            old: make_row(id, old_active),
            new: make_row(id, !old_active),
        });
    }

    pipeline.view().len() as u32
}
