use std::hash::{Hash, Hasher};
use std::rc::Rc;

use rustc_hash::FxHashSet;

use crate::change::Change;
use crate::row::{Comparator, Row};

/// Stack-allocated operator output: zero, one, or two changes — so an operator
/// emits without a per-push `Vec<Change>` heap allocation (the common case is
/// 0 or 1). Two covers a key-changing edit splitting into remove + add.
pub enum Emit {
    None,
    One(Change),
    Two(Change, Change),
}

/// A dataflow operator: receives a change, emits zero or more changes. (zql
/// operators also support a pull `fetch` path; this slice models push only.)
pub trait Operator {
    fn push(&mut self, change: Change) -> Emit;
}

/// A row keyed by its sort-column values, for use in a `HashSet`. Constructing
/// one is two `Rc` bumps (no heap), so the store needs no separate per-op key
/// allocation — the cost that made a `BTreeMap<Vec<Value>, _>` lose to V8.
/// (Hash + Eq are both over the sort columns, so they stay consistent.)
#[derive(Clone)]
struct RowKey {
    row: Row,
    sort: Rc<[usize]>,
}

impl RowKey {
    fn new(row: Row, sort: &Rc<[usize]>) -> Self {
        RowKey {
            row,
            sort: Rc::clone(sort),
        }
    }
}

impl PartialEq for RowKey {
    fn eq(&self, other: &Self) -> bool {
        self.sort
            .iter()
            .all(|&i| self.row.get(i) == other.row.get(i))
    }
}

impl Eq for RowKey {}

impl Hash for RowKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        for &i in self.sort.iter() {
            self.row.get(i).hash(state);
        }
    }
}

/// A set of rows keyed by the sort columns (which must uniquely identify a
/// row). Unordered — this matches the JS reference's `Map`, so the benchmark
/// compares raw change/membership throughput, not ordered-view maintenance.
/// An ordered view would swap this for a B-tree (and the JS side would too).
/// No per-operation key allocation.
struct RowStore {
    sort: Rc<[usize]>,
    set: FxHashSet<RowKey>,
}

impl RowStore {
    fn new(cmp: &Comparator) -> Self {
        RowStore {
            sort: cmp.sort(),
            set: FxHashSet::default(),
        }
    }

    /// Insert, replacing any existing row with the same sort key.
    fn insert(&mut self, row: Row) {
        self.set.replace(RowKey::new(row, &self.sort));
    }

    fn remove(&mut self, row: &Row) {
        self.set.remove(&RowKey::new(row.clone(), &self.sort));
    }

    fn same_key(&self, a: &Row, b: &Row) -> bool {
        self.sort.iter().all(|&i| a.get(i) == b.get(i))
    }

    fn rows(&self) -> impl Iterator<Item = &Row> {
        self.set.iter().map(|k| &k.row)
    }

    fn len(&self) -> usize {
        self.set.len()
    }
}

/// An in-memory source: the head of a pipeline. Holds rows keyed by the
/// comparator key, applies incoming changes to that storage, and forwards them
/// downstream. A key-changing edit is split into remove + add (the row moves).
pub struct MemorySource {
    rows: RowStore,
}

impl MemorySource {
    pub fn new(cmp: Comparator) -> Self {
        MemorySource {
            rows: RowStore::new(&cmp),
        }
    }

    /// Load an initial row without emitting a change (pre-hydration).
    pub fn insert(&mut self, row: Row) {
        self.rows.insert(row);
    }

    /// Rows (unordered) — the pull side used to hydrate downstream.
    pub fn rows(&self) -> impl Iterator<Item = &Row> {
        self.rows.rows()
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.len() == 0
    }
}

impl Operator for MemorySource {
    fn push(&mut self, change: Change) -> Emit {
        match change {
            Change::Add(row) => {
                self.rows.insert(row.clone());
                Emit::One(Change::Add(row))
            }
            Change::Remove(row) => {
                self.rows.remove(&row);
                Emit::One(Change::Remove(row))
            }
            Change::Edit { old, new } => {
                let same = self.rows.same_key(&old, &new);
                self.rows.remove(&old);
                self.rows.insert(new.clone());
                if same {
                    Emit::One(Change::Edit { old, new })
                } else {
                    // The row moved in sort order: downstream sees it leave and
                    // re-enter.
                    Emit::Two(Change::Remove(old), Change::Add(new))
                }
            }
        }
    }
}

/// Filters rows by a predicate, with zql's edit-splitting: an edit becomes an
/// add (started matching), a remove (stopped matching), a pass-through edit
/// (still matches), or nothing.
pub struct Filter {
    predicate: Box<dyn Fn(&Row) -> bool>,
}

impl Filter {
    pub fn new(predicate: impl Fn(&Row) -> bool + 'static) -> Self {
        Filter {
            predicate: Box::new(predicate),
        }
    }
}

impl Operator for Filter {
    fn push(&mut self, change: Change) -> Emit {
        let pass = &self.predicate;
        match change {
            Change::Add(row) => {
                if pass(&row) {
                    Emit::One(Change::Add(row))
                } else {
                    Emit::None
                }
            }
            Change::Remove(row) => {
                if pass(&row) {
                    Emit::One(Change::Remove(row))
                } else {
                    Emit::None
                }
            }
            Change::Edit { old, new } => match (pass(&old), pass(&new)) {
                (true, true) => Emit::One(Change::Edit { old, new }),
                (true, false) => Emit::One(Change::Remove(old)),
                (false, true) => Emit::One(Change::Add(new)),
                (false, false) => Emit::None,
            },
        }
    }
}

/// A materialized view: the sink. Maintains the result set and applies changes
/// incrementally.
pub struct View {
    rows: RowStore,
}

impl View {
    pub fn new(cmp: Comparator) -> Self {
        View {
            rows: RowStore::new(&cmp),
        }
    }

    pub fn apply(&mut self, change: Change) {
        match change {
            Change::Add(row) => self.rows.insert(row),
            Change::Remove(row) => self.rows.remove(&row),
            Change::Edit { old, new } => {
                self.rows.remove(&old);
                self.rows.insert(new);
            }
        }
    }

    /// The materialized rows (unordered).
    pub fn rows(&self) -> Vec<&Row> {
        self.rows.rows().collect()
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.len() == 0
    }
}

/// Recurse a change through the remaining operators into the view. The common
/// 0/1-emit path is plain stack recursion — no per-push worklist allocation.
fn flow_change(ops: &mut [Box<dyn Operator>], view: &mut View, change: Change) {
    match ops.split_first_mut() {
        None => view.apply(change),
        Some((head, tail)) => match head.push(change) {
            Emit::None => {}
            Emit::One(c) => flow_change(tail, view, c),
            Emit::Two(a, b) => {
                flow_change(tail, view, a);
                flow_change(tail, view, b);
            }
        },
    }
}

fn flow_emit(ops: &mut [Box<dyn Operator>], view: &mut View, emit: Emit) {
    match emit {
        Emit::None => {}
        Emit::One(c) => flow_change(ops, view, c),
        Emit::Two(a, b) => {
            flow_change(ops, view, a);
            flow_change(ops, view, b);
        }
    }
}

/// A push pipeline: source -> operators -> view.
pub struct Pipeline {
    source: MemorySource,
    operators: Vec<Box<dyn Operator>>,
    view: View,
}

impl Pipeline {
    pub fn new(source: MemorySource, operators: Vec<Box<dyn Operator>>, view: View) -> Self {
        Pipeline {
            source,
            operators,
            view,
        }
    }

    /// Apply a source change and propagate it to the view.
    pub fn push(&mut self, change: Change) {
        let emit = self.source.push(change);
        flow_emit(&mut self.operators, &mut self.view, emit);
    }

    /// Flow the source's current rows through the operators into the view.
    pub fn hydrate(&mut self) {
        let rows: Vec<Row> = self.source.rows().cloned().collect();
        for row in rows {
            flow_change(&mut self.operators, &mut self.view, Change::Add(row));
        }
    }

    pub fn view(&self) -> &View {
        &self.view
    }

    pub fn source(&self) -> &MemorySource {
        &self.source
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::Schema;
    use crate::value::Value;

    // Test schema: columns [id, active, score] at indices 0, 1, 2.
    fn schema() -> std::rc::Rc<Schema> {
        Schema::new(&["id", "active", "score"])
    }

    fn row(id: i64, active: bool) -> Row {
        Row::new(vec![Value::Int(id), Value::Bool(active), Value::Float(0.0)])
    }

    fn ids(view: &View) -> Vec<i64> {
        // The store is unordered, so sort for stable assertions.
        let mut ids: Vec<i64> = view
            .rows()
            .iter()
            .map(|r| match r.get(0) {
                Value::Int(n) => *n,
                _ => panic!("missing id"),
            })
            .collect();
        ids.sort_unstable();
        ids
    }

    fn build() -> Pipeline {
        let schema = schema();
        let cmp = Comparator::new(&schema, &["id"]);
        let active = schema.index_of("active").unwrap();
        let mut source = MemorySource::new(cmp.clone());
        source.insert(row(1, true));
        source.insert(row(2, false));
        source.insert(row(3, true));
        let filter = Filter::new(move |r| r.get(active) == &Value::Bool(true));
        let mut pipeline = Pipeline::new(source, vec![Box::new(filter)], View::new(cmp));
        pipeline.hydrate();
        pipeline
    }

    #[test]
    fn hydrate_applies_filter() {
        let p = build();
        assert_eq!(ids(p.view()), vec![1, 3]);
        assert_eq!(p.source().len(), 3);
    }

    #[test]
    fn add_matching_and_non_matching() {
        let mut p = build();
        p.push(Change::Add(row(4, true)));
        p.push(Change::Add(row(5, false)));
        assert_eq!(ids(p.view()), vec![1, 3, 4]); // 5 filtered out
        assert_eq!(p.source().len(), 5); // but both reach the source
    }

    #[test]
    fn remove_propagates() {
        let mut p = build();
        p.push(Change::Remove(row(3, true)));
        assert_eq!(ids(p.view()), vec![1]);
    }

    #[test]
    fn edit_true_to_false_becomes_remove() {
        let mut p = build();
        p.push(Change::Edit {
            old: row(1, true),
            new: row(1, false),
        });
        assert_eq!(ids(p.view()), vec![3]);
    }

    #[test]
    fn edit_false_to_true_becomes_add() {
        let mut p = build();
        p.push(Change::Edit {
            old: row(2, false),
            new: row(2, true),
        });
        assert_eq!(ids(p.view()), vec![1, 2, 3]);
    }

    #[test]
    fn edit_content_keeps_membership_and_updates_row() {
        let mut p = build();
        // Same id + still active, but the score (index 2) changes.
        let new = Row::new(vec![Value::Int(1), Value::Bool(true), Value::Float(9.9)]);
        p.push(Change::Edit {
            old: row(1, true),
            new: new.clone(),
        });
        assert_eq!(ids(p.view()), vec![1, 3]);
        let row1 = p
            .view()
            .rows()
            .into_iter()
            .find(|r| r.get(0) == &Value::Int(1))
            .unwrap();
        assert_eq!(row1.get(2), &Value::Float(9.9));
    }

    #[test]
    fn edit_changing_sort_key_moves_row() {
        let mut p = build();
        // id 1 -> 9 (still active): leaves position 1, re-enters at the end.
        p.push(Change::Edit {
            old: row(1, true),
            new: row(9, true),
        });
        assert_eq!(ids(p.view()), vec![3, 9]);
        assert_eq!(p.source().len(), 3);
    }
}
