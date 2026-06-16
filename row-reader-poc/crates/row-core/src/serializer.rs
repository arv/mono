use crate::{ColumnValue, RowSchema};

impl RowSchema {
    /// Serialize one row into a freshly allocated buffer. The schema drives all
    /// offset logic, so there is no per-column lookup here.
    pub fn serialize(&self, values: &[ColumnValue<'_>]) -> Vec<u8> {
        assert_eq!(
            values.len(),
            self.columns.len(),
            "value count must match schema column count",
        );

        // Fixed section starts zeroed: zero is the null/empty representation for
        // every slot, and unused null-bitmap bits stay clear.
        let mut buf = vec![0u8; self.fixed_section_size];

        for (col, value) in self.columns.iter().zip(values.iter()) {
            match value {
                ColumnValue::Null => {
                    let byte = col.index / 8;
                    let bit = col.index % 8;
                    buf[byte] |= 1 << bit;
                }
                ColumnValue::Bool(v) => {
                    buf[col.offset] = *v as u8;
                }
                ColumnValue::Int32(v) => {
                    buf[col.offset..col.offset + 4].copy_from_slice(&v.to_le_bytes());
                }
                ColumnValue::Int64(v) => {
                    buf[col.offset..col.offset + 8].copy_from_slice(&v.to_le_bytes());
                }
                ColumnValue::Float64(v) => {
                    buf[col.offset..col.offset + 8].copy_from_slice(&v.to_le_bytes());
                }
                ColumnValue::Str(s) | ColumnValue::Json(s) => {
                    write_var(&mut buf, col.offset, s.as_bytes());
                }
                ColumnValue::Bytes(b) => {
                    write_var(&mut buf, col.offset, b);
                }
            }
        }

        buf
    }
}

/// Append `data` to the variable section and record its absolute pointer + len
/// in the fixed-section slot at `offset`.
fn write_var(buf: &mut Vec<u8>, offset: usize, data: &[u8]) {
    let ptr = buf.len() as u32;
    let len = data.len() as u32;
    buf[offset..offset + 4].copy_from_slice(&ptr.to_le_bytes());
    buf[offset + 4..offset + 8].copy_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(data);
}
