import type {ColumnType, CompiledSchema} from './schema.ts';

/**
 * Reads columns out of a binary row buffer on demand via `DataView`. The schema
 * is compiled once; constructing a reader over an already-received buffer is
 * cheap (no parsing up front — columns are decoded only when read).
 */
export class RowReader {
  readonly #schema: CompiledSchema;
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  static readonly #decoder = new TextDecoder();

  constructor(schema: CompiledSchema, buffer: ArrayBuffer) {
    this.#schema = schema;
    this.#view = new DataView(buffer);
    this.#bytes = new Uint8Array(buffer);
  }

  get(col: string): unknown {
    const meta = this.#schema.index.get(col);
    if (!meta) return undefined;
    if (meta.def.nullable && this.#isNull(meta.index)) return null;
    return this.#readTyped(meta.def.type, meta.offset);
  }

  #isNull(colIndex: number): boolean {
    const byte = colIndex >> 3;
    const bit = colIndex & 7;
    return (this.#bytes[byte] & (1 << bit)) !== 0;
  }

  #readTyped(type: ColumnType, offset: number): unknown {
    switch (type) {
      case 'bool':
        return this.#view.getUint8(offset) !== 0;
      case 'int32':
        return this.#view.getInt32(offset, true);
      case 'int64':
        return this.#view.getBigInt64(offset, true);
      case 'float64':
        return this.#view.getFloat64(offset, true);
      case 'string':
      case 'json':
      case 'bytes': {
        const ptr = this.#view.getUint32(offset, true);
        const len = this.#view.getUint32(offset + 4, true);
        if (type === 'bytes') {
          return this.#bytes.slice(ptr, ptr + len);
        }
        const str = RowReader.#decoder.decode(
          this.#bytes.subarray(ptr, ptr + len),
        );
        return type === 'json' ? JSON.parse(str) : str;
      }
    }
  }

  toObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const col of this.#schema.columns) {
      out[col.def.name] = this.get(col.def.name);
    }
    return out;
  }
}
