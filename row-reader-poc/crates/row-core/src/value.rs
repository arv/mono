/// A single column value to be serialized. Borrows variable-length data so the
/// serializer never copies strings/bytes more than once (straight into the
/// output buffer).
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnValue<'a> {
    Null,
    Bool(bool),
    Int32(i32),
    Int64(i64),
    Float64(f64),
    Str(&'a str),
    /// Pre-serialized JSON string. Same wire layout as `Str`; JS parses it.
    Json(&'a str),
    Bytes(&'a [u8]),
}
