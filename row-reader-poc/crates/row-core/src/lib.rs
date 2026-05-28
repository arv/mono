//! Pure-Rust row schema + binary serializer.
//!
//! Wire format produced by [`RowSchema::serialize`]:
//!
//! ```text
//! [ null bitmap | fixed section | variable section ]
//!   ^ 1 bit per   ^ one fixed-     ^ string / json /
//!     column        size slot per    bytes payloads,
//!                   column           pointed at from
//!                                    the fixed section
//! ```
//!
//! * Null bitmap: `ceil(columns / 8)` bytes, bit `i` set means column `i` is
//!   null. (`isNull` on the JS side reads the same bit.)
//! * Fixed section: each column occupies [`ColumnType::fixed_size`] bytes.
//!   Variable-length types store `ptr: u32` + `len: u32` (absolute offset into
//!   the buffer + byte length) here.
//! * Variable section: raw UTF-8 / bytes appended after the fixed section.
//!
//! All multi-byte integers are little-endian.

mod serializer;
pub mod value;

pub use value::ColumnValue;

/// Column types. Must match the TypeScript `ColumnType` union exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    Bool,
    Int32,
    Int64,
    Float64,
    /// Variable-length UTF-8, stored as ptr(u32)+len(u32) in the fixed section.
    Str,
    /// Same layout as `Str`; the payload is a JSON string that JS parses.
    Json,
    /// Same layout as `Str`; the payload is raw bytes.
    Bytes,
}

impl ColumnType {
    /// Size of the fixed-section slot for this type.
    pub fn fixed_size(&self) -> usize {
        match self {
            Self::Bool => 1,
            Self::Int32 => 4,
            Self::Int64 | Self::Float64 => 8,
            Self::Str | Self::Json | Self::Bytes => 8, // ptr(u32) + len(u32)
        }
    }
}

#[derive(Debug, Clone)]
pub struct ColumnDef {
    pub name: String,
    pub col_type: ColumnType,
    pub nullable: bool,
}

#[derive(Debug, Clone)]
pub struct ComputedColumn {
    pub def: ColumnDef,
    /// Position in the columns array; also the null-bitmap bit index.
    pub index: usize,
    /// Byte offset of this column's slot in the fixed section.
    pub offset: usize,
}

#[derive(Debug, Clone)]
pub struct RowSchema {
    pub columns: Vec<ComputedColumn>,
    pub null_bitmap_bytes: usize,
    pub fixed_section_size: usize,
}

impl RowSchema {
    pub fn new(defs: Vec<ColumnDef>) -> Self {
        // The null bitmap is addressed by a column's full index (see
        // `serialize`), so it must reserve one bit per column. Sizing it by the
        // count of nullable columns (as an earlier draft did) overflows the
        // bitmap as soon as a nullable column lands at an index past the last
        // reserved bit, silently corrupting the fixed section. One bit per
        // column keeps Rust and JS in agreement for every schema.
        let null_bitmap_bytes = defs.len().div_ceil(8);

        let mut offset = null_bitmap_bytes;
        let mut columns = Vec::with_capacity(defs.len());

        for (index, def) in defs.into_iter().enumerate() {
            let fixed = def.col_type.fixed_size();
            columns.push(ComputedColumn { def, index, offset });
            offset += fixed;
        }

        Self {
            columns,
            null_bitmap_bytes,
            fixed_section_size: offset,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, col_type: ColumnType, nullable: bool) -> ColumnDef {
        ColumnDef {
            name: name.into(),
            col_type,
            nullable,
        }
    }

    fn read_u32(buf: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(buf[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn computes_offsets_and_bitmap() {
        let schema = RowSchema::new(vec![
            col("id", ColumnType::Int64, false),
            col("name", ColumnType::Str, false),
            col("active", ColumnType::Bool, false),
            col("meta", ColumnType::Json, true),
        ]);

        assert_eq!(schema.null_bitmap_bytes, 1); // ceil(4 / 8)
        assert_eq!(schema.columns[0].offset, 1); // id, right after bitmap
        assert_eq!(schema.columns[1].offset, 9); // name, after 8-byte int64
        assert_eq!(schema.columns[2].offset, 17); // active, after 8-byte str slot
        assert_eq!(schema.columns[3].offset, 18); // meta, after 1-byte bool
        assert_eq!(schema.fixed_section_size, 26); // 18 + 8-byte json slot
    }

    #[test]
    fn serializes_fixed_and_variable_sections() {
        let schema = RowSchema::new(vec![
            col("id", ColumnType::Int64, false),
            col("score", ColumnType::Float64, false),
            col("active", ColumnType::Bool, false),
            col("name", ColumnType::Str, false),
        ]);

        let buf = schema.serialize(&[
            ColumnValue::Int64(42),
            ColumnValue::Float64(9.81),
            ColumnValue::Bool(true),
            ColumnValue::Str("Alice"),
        ]);

        assert_eq!(buf[0], 0); // no nulls
        assert_eq!(
            i64::from_le_bytes(buf[1..9].try_into().unwrap()),
            42,
            "int64"
        );
        assert_eq!(
            f64::from_le_bytes(buf[9..17].try_into().unwrap()),
            9.81,
            "float64"
        );
        assert_eq!(buf[17], 1, "bool");

        let ptr = read_u32(&buf, 18) as usize;
        let len = read_u32(&buf, 22) as usize;
        assert_eq!(&buf[ptr..ptr + len], b"Alice");
    }

    #[test]
    fn null_sets_bitmap_and_leaves_slot_zeroed() {
        let schema = RowSchema::new(vec![
            col("a", ColumnType::Int32, false),
            col("b", ColumnType::Str, true),
        ]);

        let buf = schema.serialize(&[ColumnValue::Int32(7), ColumnValue::Null]);

        assert_eq!(buf[0] & 0b10, 0b10, "bit 1 set for null column b");
        // b's slot stays zeroed; the variable section is empty.
        assert_eq!(read_u32(&buf, schema.columns[1].offset), 0);
        assert_eq!(buf.len(), schema.fixed_section_size);
    }

    /// Regression test: a nullable column at index >= 8 must still address a
    /// valid bitmap byte. With a bitmap sized by nullable count this would
    /// write past the bitmap into the fixed section.
    #[test]
    fn null_bit_for_high_index_column_stays_in_bitmap() {
        let mut defs: Vec<ColumnDef> = (0..9)
            .map(|i| col(&format!("c{i}"), ColumnType::Bool, false))
            .collect();
        defs.push(col("flag", ColumnType::Bool, true)); // index 9

        let schema = RowSchema::new(defs);
        assert_eq!(schema.null_bitmap_bytes, 2); // ceil(10 / 8)

        let mut values: Vec<ColumnValue> = vec![ColumnValue::Bool(false); 9];
        values.push(ColumnValue::Null);
        let buf = schema.serialize(&values);

        // bit 9 -> byte 1, bit 1
        assert_eq!(buf[1] & 0b10, 0b10);
    }
}
