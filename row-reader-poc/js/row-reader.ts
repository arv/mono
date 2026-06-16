import type {ColumnType, CompiledSchema} from './schema.ts';

/**
 * Reads columns out of a binary row buffer on demand via `DataView`. The schema
 * is compiled once; constructing a reader over an already-received buffer is
 * cheap (no parsing up front — columns are decoded only when read).
 *
 * `byteOffset` lets one reader read a row that lives at an offset within a
 * larger buffer — e.g. a slot inside a `SharedArrayBuffer` ring — with no copy.
 * Call `reposition` to point an existing reader at the next row (no allocation).
 * Column offsets and variable-section pointers are row-relative, so every read
 * adds the base offset.
 */
export class RowReader {
  readonly #schema: CompiledSchema;
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  #base: number;
  static readonly #decoder = new TextDecoder();

  constructor(schema: CompiledSchema, buffer: ArrayBufferLike, byteOffset = 0) {
    this.#schema = schema;
    this.#view = new DataView(buffer);
    this.#bytes = new Uint8Array(buffer);
    this.#base = byteOffset;
  }

  /** Point this reader at a row starting at `byteOffset` in the same buffer. */
  reposition(byteOffset: number): void {
    this.#base = byteOffset;
  }

  get(col: string): unknown {
    const meta = this.#schema.index.get(col);
    if (!meta) return undefined;
    if (meta.def.nullable && this.#isNull(meta.index)) return null;
    return this.#readTyped(meta.def.type, this.#base + meta.offset);
  }

  #isNull(colIndex: number): boolean {
    const byte = this.#base + (colIndex >> 3);
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
        // ptr is row-relative; add the row's base offset to locate the payload.
        const ptr = this.#base + this.#view.getUint32(offset, true);
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
