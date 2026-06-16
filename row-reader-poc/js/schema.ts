export type ColumnType =
  | 'bool'
  | 'int32'
  | 'int64'
  | 'float64'
  | 'string'
  | 'json'
  | 'bytes';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  nullable?: boolean | undefined;
}

export interface Schema {
  columns: ColumnDef[];
}

const TYPE_SIZE: Record<ColumnType, number> = {
  bool: 1,
  int32: 4,
  int64: 8,
  float64: 8,
  string: 8, // ptr(u32) + len(u32)
  json: 8,
  bytes: 8,
};

export interface ComputedColumn {
  def: ColumnDef;
  index: number;
  offset: number;
}

/**
 * Compiles a plain `Schema` into column offsets once. Must stay byte-for-byte
 * compatible with the Rust `RowSchema` (see `crates/row-core/src/lib.rs`).
 */
export class CompiledSchema {
  readonly columns: ComputedColumn[];
  readonly index: Map<string, ComputedColumn>;
  readonly nullBitmapBytes: number;
  readonly fixedSectionSize: number;

  constructor(schema: Schema) {
    // One bit per column, addressed by column index — matches the Rust side.
    this.nullBitmapBytes = Math.ceil(schema.columns.length / 8);

    let offset = this.nullBitmapBytes;
    let idx = 0;
    this.columns = [];
    this.index = new Map();

    for (const def of schema.columns) {
      const col: ComputedColumn = {def, index: idx++, offset};
      this.columns.push(col);
      this.index.set(def.name, col);
      offset += TYPE_SIZE[def.type];
    }

    this.fixedSectionSize = offset;
  }
}
