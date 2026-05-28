# Row Reader POC

Proof of concept for binary row serialization vs JSON, for Zero's IVM path.
Rust serializes database rows into a compact binary buffer; JS reads columns
lazily through a `DataView`-backed `RowReader`. This POC targets **web only**
(Node.js + browser); React Native wiring comes later.

It is a **standalone sub-project**: it has its own Cargo workspace and its own
`package.json`, and is intentionally _not_ part of the monorepo's npm workspaces
or its turbo/vitest/oxlint pipelines.

## Layout

```
row-reader-poc/
  crates/
    row-core/          # pure Rust: schema, serializer, column types (+ unit tests)
      benches/serialize.rs   # criterion bench (binary vs serde_json)
    row-wasm/          # wasm-bindgen bindings
  js/
    schema.ts          # CompiledSchema (offsets computed once)
    row-reader.ts      # RowReader (DataView-based lazy column reads)
    demo-schema.ts     # schema shared by bench + browser smoke test
    verify.ts          # Node round-trip correctness check
    bench.ts           # mitata benchmark (binary reads vs JSON.parse)
    worker.ts/main.ts  # browser worker smoke test (postMessage transfer)
    threads/           # multi-thread producers -> single consumer
      queue.ts         #   SPSC rings over one SharedArrayBuffer (+ signal word)
      drain.ts         #   async consumer drain loop (Atomics.waitAsync)
      worker.ts        #   Node producer (worker_threads): serialize -> ring
      main.ts          #   Node consumer demo: drain + decode + verify
      bench.ts         #   Node rows/s-vs-threads sweep -> SVG plot
      async-verify.ts  #   Node: Atomics.waitAsync consumer + sync producers
      chart.ts         #   shared canvas chart + results table
      browser.worker.ts      # browser producer: serialize -> transfer
      browser.main.ts        # browser benchmark: postMessage/transfer
      browser-sab.worker.ts  # browser producer: serialize -> SAB ring
      browser-sab.main.ts    # browser benchmark: SharedArrayBuffer ring
  index.html           # single-worker browser smoke test
  threads.html         # multi-worker benchmark (postMessage transfer)
  threads-sab.html     # multi-worker benchmark (SharedArrayBuffer ring)
```

## Wire format

```
[ null bitmap | fixed section | variable section ]
```

- **Null bitmap** — `ceil(columns / 8)` bytes, one bit per column (bit `i` set
  ⇒ column `i` is null).
- **Fixed section** — one fixed-size slot per column. Variable-length types
  (`string`/`json`/`bytes`) store `ptr: u32` + `len: u32` (absolute offset into
  the buffer + byte length) here.
- **Variable section** — raw UTF-8 / bytes appended after the fixed section.

All multi-byte integers are little-endian. The Rust `RowSchema` and the
TypeScript `CompiledSchema` compute byte-identical offsets.

## Prerequisites

- Rust + `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- `wasm-bindgen-cli`, version matching the `wasm-bindgen` crate (currently
  0.2.122): `cargo install wasm-bindgen-cli --version 0.2.122`
- Node.js >= 22 (runs the `.ts` files directly via native type stripping — no transpile step)
- pnpm 11.3 (via `corepack`; pinned by the `packageManager` field)

## Build & run

```bash
# from row-reader-poc/
pnpm install
pnpm run build:wasm        # builds pkg-node (bench/verify) + pkg-web (browser)

pnpm run verify            # Rust->WASM->JS round-trip correctness check
pnpm run threads           # N producer threads -> main, via a shared ring buffer
pnpm run threads:async     # validate Atomics.waitAsync consumer + sync producers
pnpm run threads:bench     # rows/s vs thread count sweep -> threads-scaling.svg
pnpm run bench             # JS read vs JSON.parse + WASM serialize throughput
pnpm run bench:rust        # pure-Rust criterion: binary serialize vs serde_json
cargo test -p row-core     # serializer unit tests

pnpm run dev               # vite (COOP/COEP) -> / , /threads.html , /threads-sab.html
```

`build:wasm` compiles the crate to wasm once (`cargo build --target
wasm32-unknown-unknown`), then runs `wasm-bindgen` for each JS target: `pkg-node`
(`--target nodejs`, used by `bench.ts`/`verify.ts`, no init needed) and
`pkg-web` (`--target web`, used by the worker, requires `await init()`). Both
are git-ignored — regenerate with `pnpm run build:wasm`.

## Sample results

Measured on this POC's dev container (Node 22, `wasm-opt` disabled — see
"Deviations"). Numbers are illustrative, not a final verdict.

Pure Rust (criterion):

| benchmark              | time    |
| ---------------------- | ------- |
| `serialize_row` binary | ~97 ns  |
| `serde_json::to_vec`   | ~461 ns |

JS reads vs JSON (mitata):

| benchmark                                | time     |
| ---------------------------------------- | -------- |
| binary: new reader + get int64           | ~165 ns  |
| json: `JSON.parse` + access int          | ~1.10 µs |
| binary: `toObject()` (all 6 cols)        | ~1.40 µs |
| json: `JSON.parse()` (full object)       | ~1.09 µs |
| binary: get float64 (hot, no realloc)    | ~22 ns   |
| binary: get string col                   | ~198 ns  |
| binary: get json col                     | ~763 ns  |
| WASM serialize 1 row (incl. JSON decode) | ~5.3 µs  |
| WASM serialize, decode once (per row)    | ~0.22 µs |

**Read of the results.** Binary wins big for individual numeric reads (a
`DataView` read is tens of ns vs ~1.1 µs to `JSON.parse` the whole row).
Materializing the whole row (`toObject`) is roughly a wash with `JSON.parse`,
because `toObject` still `JSON.parse`s the embedded `json` column and decodes
strings via `TextDecoder`. So the approach pays off precisely when JS reads a
few columns per row rather than always materializing every row — which matches
Zero's access pattern. String/`json` reads are dominated by `TextDecoder` /
`JSON.parse`, as expected.

The schema is compiled once, so per-row serialization is just offset writes:
decoding the row once and serializing 1000 times costs **~0.22 µs/row** in WASM
(vs ~0.1 µs pure-native Rust — the gap is the per-row output allocation). The
~5.3 µs single-row number is almost entirely the **one-time JSON decode** of the
row input, which is a harness artifact: a real integration feeds already-typed
DB-row values across the boundary, so that decode (and serde) disappears
entirely. The earlier ~5.6 µs figure conflated JSON parsing with serialization.

## BigInt at the WASM boundary

`int64` columns cross the boundary as **decimal strings** (Option A in the
plan): `JSON.stringify` can't encode `BigInt`, and this sidesteps wasm-bindgen's
`i64` friction. Rust parses them with `str::parse::<i64>()`. On the read side,
`RowReader` returns `int64` as a JS `BigInt` (`DataView.getBigInt64`).
`bytes` columns cross as arrays of `u8`.

## Multi-threaded production

N producer threads each serialize rows with their own wasm instance and push
them to the main thread, which decodes every row with `RowReader`. Each row
encodes its producer (`user_id`, `name = tN#i`) so the consumer can verify
provenance, that `metadata` round-trips, and that every thread delivered
exactly its quota. Both variants run single-threaded wasm instances per worker
— the wasm _linear memory_ is not shared; only the hand-off channel differs.

### Node (`pnpm run threads`)

Threads are Node `worker_threads`. Hand-off is one `SharedArrayBuffer` holding N
lock-free **SPSC ring buffers** (`queue.ts`), one per producer, drained by the
single consumer. Synchronization is pure `Atomics` (sequentially consistent in
JS, so a producer's slot writes before its `Atomics.store(head)` are visible
once the consumer observes the advanced head). The ring is bounded, so a full
ring blocks the producer (`Atomics.wait`) until the consumer frees a slot and
`Atomics.notify`s it — real backpressure.

Tunable via env: `THREADS` (default 4), `ROWS` per thread (5000), `CAPACITY`
ring slots (256). Example: `THREADS=8 ROWS=3000 CAPACITY=16 pnpm run threads`.

```
4 threads x 5000 rows = 20000 rows, ring capacity 256 (KB shared: 256)
consumed 20000 rows in ~296ms from 4 threads:
  thread 0..3: 5000 rows each
threads: OK — every thread delivered 5000 rows (~67k rows/s)
```

`pnpm run threads:bench` sweeps the thread count (lean consumer, no per-row
decode) and writes `threads-scaling.svg`. On a 4-core box throughput rises to
~3 producers (3 producers + 1 consumer ≈ 4 cores), then dips as it
oversubscribes:

```
threads= 1   147k rows/s
threads= 3   306k rows/s   (peak, ~2x over 1 thread)
threads= 8   258k rows/s
```

In production the Node path wouldn't use wasm at all — `row-core` can ship as a
**native addon** (napi-rs, per-platform prebuilt `.node` binaries, the model TS
7's `tsgo` uses), which removes the wasm↔JS copy and lets typed values cross the
FFI directly (dropping serde). Faster in Node; the cost is a per-platform
prebuild matrix vs wasm's single portable artifact.

### Browser (`pnpm run dev`)

Two benchmark pages, both Web Workers running the `--target web` wasm, sweeping
worker count and plotting rows/s vs threads on a canvas:

- **`/threads.html` — postMessage/transfer.** Each worker transfers its row
  `ArrayBuffer`s to the main thread (zero-copy ownership move), batched. No
  shared memory, so no COOP/COEP needed. On a 10-core box this peaked ~385k
  rows/s — it's hand-off-bound: transferring ~100k tiny buffers is per-object
  expensive.
- **`/threads-sab.html` — SharedArrayBuffer ring.** The Node design, in the
  browser: producers push into per-worker rings and block on synchronous
  `Atomics.wait` when full; the main thread drains with **`Atomics.waitAsync`**
  (it cannot `Atomics.wait`). Requires a cross-origin-isolated page —
  `vite.config.ts` sets `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp` on the dev and preview servers.

The async-consumer + sync-producer + signal/notify protocol (the part unique to
the SAB browser path) is validated headlessly in Node via `pnpm run
threads:async` (`Atomics.waitAsync` works in Node too). The COOP/COEP headers
are verified to be served (page + wasm asset). What is **not** run here is the
page in a real browser — this container's network policy blocks the headless
Chromium download (Playwright CDN returns 403), so open the pages manually.

True shared-_linear-memory_ wasm threads (one wasm module across all threads,
e.g. via `wasm-bindgen-rayon`) compile here too; the blocker is the per-thread
stack/TLS bootstrap glue, clean in a cross-origin-isolated browser but fiddly to
verify headlessly.

## Deviations from the original plan

1. **Null bitmap sizing (correctness fix).** The plan sized the null bitmap by
   the _number of nullable columns_ but addressed bits by _full column index_.
   That overflows the bitmap (corrupting the fixed section) once a nullable
   column sits past the last reserved bit. Both the Rust and TS sides here size
   the bitmap as `ceil(columns / 8)` — one bit per column — so they stay in
   agreement for every schema. A regression test (`row-core`) covers a nullable
   column at index ≥ 8.
2. **Criterion bench location.** Cargo requires benches to live inside a crate,
   so `rust_bench.rs` is `crates/row-core/benches/serialize.rs` rather than a
   top-level `benches/`.
3. **`wasm-bindgen` directly, not `wasm-pack`.** wasm-pack is in maintenance
   mode; it only wraps `cargo build --target wasm32-unknown-unknown` + the
   `wasm-bindgen` CLI + `wasm-opt`. The build scripts call those directly, so
   the only wasm tool needed is `wasm-bindgen-cli` (pinned to the crate's
   `wasm-bindgen` version). The `nodejs` target emits CommonJS, so the node
   build writes a `{"type":"commonjs"}` `package.json` into `pkg-node/` (the
   project is otherwise ESM); wasm-pack used to generate this for us.
4. **Two binding outputs** (`pkg-node` + `pkg-web`) instead of one, because the
   Node bench and the browser worker need different `wasm-bindgen` targets
   (`nodejs` vs `web`).
5. **No `wasm-opt` pass.** The optional binaryen optimization step is skipped;
   the wasm is still LLVM-optimized via the release profile (`opt-level = "s"`,
   `lto`). Run `wasm-opt` on the `pkg-*/*_bg.wasm` files for
   production-representative size/perf numbers.
