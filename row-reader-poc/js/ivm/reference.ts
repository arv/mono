/**
 * A faithful, minimal JS reimplementation of the `ivm` crate's push pipeline
 * (memory source -> filter -> view), used as the JS baseline for the
 * native/wasm/JS comparison in `js/ivm-bench.ts`.
 *
 * This is intentionally a *stripped* IVM — no LogContext, schema, lazy streams,
 * relationships, or ordered BTree (it keys by id in a `Map`). Real zql carries
 * all of that, so this reference is the *fastest* a JS IVM could plausibly be:
 * a conservative (JS-favorable) bar for wasm to clear, and a lower bound on the
 * native speedup. The workload mirrors `ivm::filter_bench` exactly.
 */
export type Value = null | boolean | number | string;
export type Row = Record<string, Value>;

type Change =
  | {type: 'add'; row: Row}
  | {type: 'remove'; row: Row}
  | {type: 'edit'; old: Row; new: Row};

type Key = (row: Row) => Value;

class MemorySource {
  readonly #data = new Map<Value, Row>();
  readonly #key: Key;
  constructor(key: Key) {
    this.#key = key;
  }
  insert(row: Row): void {
    this.#data.set(this.#key(row), row);
  }
  rows(): Row[] {
    return [...this.#data.values()];
  }
  push(c: Change): Change[] {
    switch (c.type) {
      case 'add':
        this.#data.set(this.#key(c.row), c.row);
        return [c];
      case 'remove':
        this.#data.delete(this.#key(c.row));
        return [c];
      case 'edit': {
        const ok = this.#key(c.old);
        const nk = this.#key(c.new);
        this.#data.delete(ok);
        this.#data.set(nk, c.new);
        return ok === nk
          ? [c]
          : [
              {type: 'remove', row: c.old},
              {type: 'add', row: c.new},
            ];
      }
    }
  }
}

class Filter {
  readonly #pass: (row: Row) => boolean;
  constructor(pass: (row: Row) => boolean) {
    this.#pass = pass;
  }
  push(c: Change): Change[] {
    switch (c.type) {
      case 'add':
        return this.#pass(c.row) ? [c] : [];
      case 'remove':
        return this.#pass(c.row) ? [c] : [];
      case 'edit': {
        const o = this.#pass(c.old);
        const n = this.#pass(c.new);
        if (o && n) return [c];
        if (o && !n) return [{type: 'remove', row: c.old}];
        if (!o && n) return [{type: 'add', row: c.new}];
        return [];
      }
    }
  }
}

class View {
  readonly #data = new Map<Value, Row>();
  readonly #key: Key;
  constructor(key: Key) {
    this.#key = key;
  }
  apply(c: Change): void {
    switch (c.type) {
      case 'add':
        this.#data.set(this.#key(c.row), c.row);
        break;
      case 'remove':
        this.#data.delete(this.#key(c.row));
        break;
      case 'edit':
        this.#data.delete(this.#key(c.old));
        this.#data.set(this.#key(c.new), c.new);
        break;
    }
  }
  get size(): number {
    return this.#data.size;
  }
}

function makeRow(id: number, active: boolean): Row {
  // Lean scalar row (matches the Rust workload): no string column, so the
  // benchmark measures IVM engine throughput, not row construction.
  return {id, active, score: id * 1.5};
}

/** Mirror of `ivm::filter_bench`. Returns the final view size. */
export function filterBench(rows: number, pushes: number): number {
  rows = Math.max(1, rows);
  const key: Key = row => row.id as Value;
  const source = new MemorySource(key);
  for (let k = 0; k < rows; k++) {
    source.insert(makeRow(k, k % 3 !== 0));
  }
  const filter = new Filter(row => row.active === true);
  const view = new View(key);

  // hydrate
  for (const row of source.rows()) {
    for (const c of filter.push({type: 'add', row})) view.apply(c);
  }

  for (let i = 0; i < pushes; i++) {
    const id = i % rows;
    const times = Math.floor(i / rows);
    const init = id % 3 !== 0;
    const oldActive = init !== (times % 2 === 1); // XOR
    const changes = source.push({
      type: 'edit',
      old: makeRow(id, oldActive),
      new: makeRow(id, !oldActive),
    });
    for (const c of changes) {
      for (const c2 of filter.push(c)) view.apply(c2);
    }
  }

  return view.size;
}
