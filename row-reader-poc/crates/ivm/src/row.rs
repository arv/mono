use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::value::Value;

/// A row: an ordered map of column name -> value. Mirrors zql's
/// `Row = Record<string, Value>`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Row(BTreeMap<String, Value>);

impl Row {
    pub fn new() -> Self {
        Row(BTreeMap::new())
    }

    /// Builder-style insert: `Row::new().with("id", 1).with("active", true)`.
    pub fn with(mut self, col: &str, val: impl Into<Value>) -> Self {
        self.0.insert(col.to_owned(), val.into());
        self
    }

    pub fn set(&mut self, col: &str, val: impl Into<Value>) {
        self.0.insert(col.to_owned(), val.into());
    }

    pub fn get(&self, col: &str) -> Option<&Value> {
        self.0.get(col)
    }
}

/// Orders rows by a fixed list of sort columns (zql's `Comparator`, derived
/// from the source's sort order). The key it produces is also used to index
/// rows in the memory source and view, so the sort columns must uniquely
/// identify a row (include the primary key).
#[derive(Debug, Clone)]
pub struct Comparator {
    columns: Vec<String>,
}

impl Comparator {
    pub fn new(columns: &[&str]) -> Self {
        Comparator {
            columns: columns.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    /// The sort key of `row`: its values for the sort columns, in order.
    pub fn key(&self, row: &Row) -> Vec<Value> {
        self.columns
            .iter()
            .map(|c| row.get(c).cloned().unwrap_or(Value::Null))
            .collect()
    }

    pub fn compare(&self, a: &Row, b: &Row) -> Ordering {
        self.key(a).cmp(&self.key(b))
    }
}
