//! Minimal incremental view maintenance (IVM) engine — a Rust port of the core
//! dataflow in `packages/zql/src/ivm`, scoped to a first vertical slice: the
//! value/row/change model, a memory source, a filter operator (with the
//! edit-splitting semantics zql's filter has), and a materialized view, wired
//! into a push-based [`Pipeline`].
//!
//! Deferred (the bulk of the ~7k-line TS engine): the pull/`fetch` hydration
//! path with lazy streams + `yield`, relationships / `child` changes, and the
//! stateful operators — `join` / `flipped-join`, `exists`, `take` / `skip`,
//! `fan-in` / `fan-out`, and constraints.

pub mod change;
pub mod ops;
pub mod row;
pub mod value;
pub mod workload;

pub use change::Change;
pub use ops::{Filter, MemorySource, Operator, Pipeline, View};
pub use row::{Comparator, Row, Schema};
pub use value::Value;
pub use workload::filter_bench;
