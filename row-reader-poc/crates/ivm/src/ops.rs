use std::collections::BTreeMap;

use crate::change::Change;
use crate::row::{Comparator, Row};
use crate::value::Value;

/// A dataflow operator: it receives a change on its input and emits zero or
/// more changes on its output. (zql operators also support a pull `fetch` path
/// for hydration; this slice models the push path only.)
pub trait Operator {
    fn push(&mut self, change: Change) -> Vec<Change>;
}

/// An in-memory source: the head of a pipeline. Holds rows sorted by the
/// comparator's key, applies incoming changes to that storage, and forwards
/// them downstream. A key-changing edit is split into remove + add (the row
/// moves position), matching zql's source behavior.
pub struct MemorySource {
    cmp: Comparator,
    data: BTreeMap<Vec<Value>, Row>,
}

impl MemorySource {
    pub fn new(cmp: Comparator) -> Self {
        MemorySource {
            cmp,
            data: BTreeMap::new(),
        }
    }

    /// Load an initial row without emitting a change (pre-hydration).
    pub fn insert(&mut self, row: Row) {
        self.data.insert(self.cmp.key(&row), row);
    }

    /// Rows in sort order — the pull side used to hydrate downstream.
    pub fn rows(&self) -> impl Iterator<Item = &Row> {
        self.data.values()
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
}

impl Operator for MemorySource {
    fn push(&mut self, change: Change) -> Vec<Change> {
        match change {
            Change::Add(row) => {
                self.data.insert(self.cmp.key(&row), row.clone());
                vec![Change::Add(row)]
            }
            Change::Remove(row) => {
                self.data.remove(&self.cmp.key(&row));
                vec![Change::Remove(row)]
            }
            Change::Edit { old, new } => {
                let old_key = self.cmp.key(&old);
                let new_key = self.cmp.key(&new);
                self.data.remove(&old_key);
                self.data.insert(new_key.clone(), new.clone());
                if old_key == new_key {
                    vec![Change::Edit { old, new }]
                } else {
                    // The row moved in sort order: downstream sees it leave and
                    // re-enter.
                    vec![Change::Remove(old), Change::Add(new)]
                }
            }
        }
    }
}

/// Filters rows by a predicate. Edits get the same split logic zql's filter
/// uses: an edit can become an add (row started matching), a remove (stopped
/// matching), a pass-through edit (still matches), or nothing.
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
    fn push(&mut self, change: Change) -> Vec<Change> {
        let pass = &self.predicate;
        match change {
            Change::Add(row) => {
                if pass(&row) {
                    vec![Change::Add(row)]
                } else {
                    vec![]
                }
            }
            Change::Remove(row) => {
                if pass(&row) {
                    vec![Change::Remove(row)]
                } else {
                    vec![]
                }
            }
            Change::Edit { old, new } => match (pass(&old), pass(&new)) {
                (true, true) => vec![Change::Edit { old, new }],
                (true, false) => vec![Change::Remove(old)],
                (false, true) => vec![Change::Add(new)],
                (false, false) => vec![],
            },
        }
    }
}

/// A materialized view: the sink. Maintains the result set sorted by the
/// comparator and applies changes incrementally.
pub struct View {
    cmp: Comparator,
    data: BTreeMap<Vec<Value>, Row>,
}

impl View {
    pub fn new(cmp: Comparator) -> Self {
        View {
            cmp,
            data: BTreeMap::new(),
        }
    }

    pub fn apply(&mut self, change: Change) {
        match change {
            Change::Add(row) => {
                self.data.insert(self.cmp.key(&row), row);
            }
            Change::Remove(row) => {
                self.data.remove(&self.cmp.key(&row));
            }
            Change::Edit { old, new } => {
                self.data.remove(&self.cmp.key(&old));
                self.data.insert(self.cmp.key(&new), new);
            }
        }
    }

    /// The materialized rows, in sort order.
    pub fn rows(&self) -> Vec<&Row> {
        self.data.values().collect()
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
}

/// A push pipeline: source -> operators -> view. `push` threads a change from
/// the source through each operator to the view; `hydrate` flows the source's
/// existing rows through the operators into the view.
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

    fn flow(&mut self, changes: Vec<Change>) {
        let mut current = changes;
        for op in &mut self.operators {
            let mut next = Vec::new();
            for change in current {
                next.extend(op.push(change));
            }
            current = next;
        }
        for change in current {
            self.view.apply(change);
        }
    }

    /// Apply a source change and propagate it to the view.
    pub fn push(&mut self, change: Change) {
        let emitted = self.source.push(change);
        self.flow(emitted);
    }

    /// Flow the source's current rows through the operators into the view.
    pub fn hydrate(&mut self) {
        let rows: Vec<Row> = self.source.rows().cloned().collect();
        for row in rows {
            self.flow(vec![Change::Add(row)]);
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

    // Test schema: columns [id, active, score] at indices 0, 1, 2.
    fn schema() -> std::rc::Rc<Schema> {
        Schema::new(&["id", "active", "score"])
    }

    fn row(id: i64, active: bool) -> Row {
        Row::new(vec![Value::Int(id), Value::Bool(active), Value::Float(0.0)])
    }

    fn ids(view: &View) -> Vec<i64> {
        view.rows()
            .iter()
            .map(|r| match r.get(0) {
                Value::Int(n) => *n,
                _ => panic!("missing id"),
            })
            .collect()
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
        assert_eq!(p.view().rows()[0].get(2), &Value::Float(9.9));
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
