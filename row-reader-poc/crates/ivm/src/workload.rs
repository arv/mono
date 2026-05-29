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

#[cfg(not(target_arch = "wasm32"))]
fn filter_bench_shard(rows: i64, pushes: i64, shards: i64, shard: i64) -> u32 {
    let schema = Schema::new(&["id", "active", "score", "name"]);
    let cmp = Comparator::new(&schema, &["id"]);
    let active = schema.index_of("active").unwrap();

    let mut source = MemorySource::new(cmp.clone());
    for k in 0..rows {
        if k % shards == shard {
            source.insert(make_row(k, k % 3 != 0));
        }
    }
    let filter = Filter::new(move |r| r.get(active) == &Value::Bool(true));
    let mut pipeline = Pipeline::new(source, vec![Box::new(filter)], View::new(cmp));
    pipeline.hydrate();

    for i in 0..pushes {
        let id = i % rows;
        if id % shards != shard {
            continue;
        }
        let times = i / rows;
        let init = id % 3 != 0;
        let old_active = init ^ (times % 2 == 1);
        pipeline.push(Change::Edit {
            old: make_row(id, old_active),
            new: make_row(id, !old_active),
        });
    }

    pipeline.view().len() as u32
}

/// Data-parallel `filter_bench`: partition rows by `id % shards` into
/// independent (shared-nothing) sub-pipelines, one per OS thread, and sum their
/// view sizes. The result is identical to single-threaded `filter_bench` (the
/// filter is per-row, so partitioning by id is sound).
///
/// This is the *sound* form of IVM parallelism. A single pipeline's change
/// stream is sequential and stateful, so it can't be parallelized — but
/// key-partitioning gives shared-nothing data parallelism (the model
/// Differential Dataflow / Materialize / Flink use; joins partition by join
/// key, group-bys by group key). Native threads share memory for free; the
/// equivalent in Node needs workers + serialization. (A server would use a
/// persistent thread pool; this spawns per call.)
#[cfg(not(target_arch = "wasm32"))]
pub fn filter_bench_parallel(rows: u32, pushes: u32, shards: u32) -> u32 {
    let shards = shards.max(1);
    if shards == 1 {
        return filter_bench(rows, pushes);
    }
    let rows = rows.max(1) as i64;
    let pushes = pushes as i64;
    let shards = shards as i64;
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..shards)
            .map(|s| scope.spawn(move || filter_bench_shard(rows, pushes, shards, s)))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).sum()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sharding_matches_single_threaded() {
        let single = filter_bench(200, 1000);
        for shards in [1, 2, 3, 4, 8] {
            assert_eq!(
                filter_bench_parallel(200, 1000, shards),
                single,
                "shards={shards} must equal single-threaded",
            );
        }
    }
}
