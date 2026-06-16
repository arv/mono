use crate::row::Row;

/// An incremental change flowing through the dataflow. A subset of zql's
/// `Change` — `add`, `remove`, and `edit`. (zql's `child` change, for
/// relationship edits, is deferred along with the join operators.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Add(Row),
    Remove(Row),
    Edit { old: Row, new: Row },
}
