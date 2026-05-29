use std::cmp::Ordering;
use std::collections::HashMap;
use std::rc::Rc;

use crate::value::Value;

/// Column layout, compiled once. Maps column name -> positional index so rows
/// store values *positionally* (no per-row string keys).
///
/// This is the difference between losing and winning against V8: a naive
/// `BTreeMap<String, Value>` row allocates a fresh `String` per column on every
/// row, plus tree nodes — work V8's hidden-class objects do for free. Resolving
/// names to indices once, here, lets rows be flat value slices.
pub struct Schema {
    names: Vec<String>,
    index: HashMap<String, usize>,
}

impl Schema {
    pub fn new(columns: &[&str]) -> Rc<Self> {
        let names: Vec<String> = columns.iter().map(|s| (*s).to_owned()).collect();
        let index = names
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, n)| (n, i))
            .collect();
        Rc::new(Schema { names, index })
    }

    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.index.get(name).copied()
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }
}

/// A row: values stored positionally per the schema, shared via `Rc` so moving
/// a row through the dataflow is a refcount bump rather than a deep copy —
/// matching how JS passes object references.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row(Rc<[Value]>);

impl Row {
    pub fn new(values: Vec<Value>) -> Self {
        Row(values.into())
    }

    pub fn get(&self, index: usize) -> &Value {
        &self.0[index]
    }

    pub fn values(&self) -> &[Value] {
        &self.0
    }
}

/// Orders rows by a fixed list of sort-column indices (resolved from the schema
/// once). The key it produces also indexes rows in the source and view, so the
/// sort columns must uniquely identify a row.
#[derive(Clone)]
pub struct Comparator {
    sort: Rc<[usize]>,
}

impl Comparator {
    pub fn new(schema: &Schema, columns: &[&str]) -> Self {
        let sort: Vec<usize> = columns
            .iter()
            .map(|c| {
                schema
                    .index_of(c)
                    .unwrap_or_else(|| panic!("unknown sort column: {c}"))
            })
            .collect();
        Comparator { sort: sort.into() }
    }

    /// The sort key of `row`: its values for the sort columns, in order.
    pub fn key(&self, row: &Row) -> Vec<Value> {
        self.sort.iter().map(|&i| row.get(i).clone()).collect()
    }

    pub fn compare(&self, a: &Row, b: &Row) -> Ordering {
        self.key(a).cmp(&self.key(b))
    }
}
