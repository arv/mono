# Handoff: make `@rocicorp/logger` `LogContext` faster / fewer allocations

## Goal
Reduce per-call allocations in `LogContext.withContext` (and the
`OptionalLoggerImpl` constructor). `withContext` is called all over `mono`
(per request, per IVM operation, per SQLite fetch, etc.), so its allocation
cost shows up as GC pressure across the whole system.

This work must land in the **`@rocicorp/logger`** package (a separate,
published repo — `rocicorp/logger`), not in `arv/mono`. `mono` only consumes it
as a dependency (`"@rocicorp/logger": "^5.4.0"`). After releasing a new logger
version, bump it in `mono` to pick up the win.

> Branch naming for this work: use the `arv/` prefix (e.g. `arv/logcontext-alloc`).

---

## Diagnosis (observed in `@rocicorp/logger@5.4.0`, `out/logger.js`)

`withContext` allocates a spread context object **and** a new `LogContext`,
whose `OptionalLoggerImpl` constructor allocates **a fresh closure per log
method, every call**:

```js
// LogContext
withContext(key, value) {
  const ctx = { ...this.#context, [key]: value };          // alloc: spread object
  return new LogContext(this.#level, ctx, this.#logSink);  // + instance + closures below
}

// OptionalLoggerImpl constructor
constructor(logSink, level = 'info', context) {
  const impl = (level) => (...args) => logSink.log(level, context, ...args); // closure factory
  switch (level) {                       // fall-through
    case 'debug': this.debug = impl('debug');  // closure
    case 'info':  this.info  = impl('info');   // closure
    case 'warn':  this.warn  = impl('warn');   // closure
    case 'error': this.error = impl('error');  // closure
  }
  this.flush = () => logSink.flush?.() ?? Promise.resolve(); // closure
}
```

At `debug` level that is **~7 allocations per `withContext`**: 4 method
closures + the `flush` closure + the spread context object + the `LogContext`
instance.

**Why the closures can't simply become prototype methods:** the methods are
deliberately `undefined` when the level is below them, so that
`lc.debug?.(expensive())` short-circuits and never evaluates `expensive()` when
debug logging is off. Always-present prototype methods would break that lazy
argument evaluation.

---

## Fix: shared functions that read instance fields

Keep the "method is `undefined` when below level" behavior (preserves the
`?.` lazy-arg semantics), but assign **shared** function references instead of
freshly-allocated closures. The functions read `this`, so they work when
invoked as `lc.debug(...)` (i.e. `this === lc`). Store `logSink`/`context` as
instance fields so the shared functions can reach them.

```js
function debugFn(...args) { this._sink.log('debug', this._ctx, ...args); }
function infoFn (...args) { this._sink.log('info',  this._ctx, ...args); }
function warnFn (...args) { this._sink.log('warn',  this._ctx, ...args); }
function errorFn(...args) { this._sink.log('error', this._ctx, ...args); }
function flushFn() { return this._sink.flush?.() ?? Promise.resolve(); }

export class OptionalLoggerImpl {
  debug; info; warn; error; flush;
  _sink; _ctx;                       // (use real private #fields in the TS source)
  constructor(logSink, level = 'info', context) {
    this._sink = logSink;
    this._ctx = context;
    switch (level) {                 // fall-through preserved
      case 'debug': this.debug = debugFn;
      case 'info':  this.info  = infoFn;
      case 'warn':  this.warn  = warnFn;
      case 'error': this.error = errorFn;
    }
    this.flush = flushFn;
  }
}
```

This removes the 5 per-instance closures, leaving only the spread context object
+ the instance per `withContext`. (~7 → 2 allocations.)

### Implementation notes
- **Edit the TypeScript source** (`src/logger.ts` in the logger repo), not the
  built `out/logger.js`. Mirror the structure above. The shared functions need
  access to `logSink`/`context`; in TS you can keep them as `#private` fields if
  the shared functions are **private methods** on the class (e.g. assign
  `this.debug = this.#debug` where `#debug(...args){ this.#logSink.log('debug', this.#context, ...args) }`).
  Verify with a quick check that assigning a `#private` method reference and
  calling it as `lc.debug(x)` keeps `this` bound (it does — method-call form
  sets `this`). If the toolchain complains, fall back to module-level functions
  + non-private fields as shown above.
- Keep the fall-through `switch` exactly as-is (it is load-bearing: each level
  enables itself and all higher-severity levels).
- `flush` can also be a single shared function (`flushFn`).

### Optional, bigger follow-up (more invasive — separate change)
Defer the context-object spread: represent context as a parent pointer +
`(key, value)` and only materialize the merged object lazily in the sink's
`stringified()` path. Most `withContext` calls never actually log, so the spread
is often pure waste. This changes the context representation seen by all
`LogSink` implementations (`consoleLogSink`, datadog, otel, …), so it's a larger,
riskier change — do it separately, not in the first PR.

---

## Why it's safe (semantics preserved)
- Methods are still `undefined` below their level → `lc.debug?.(expensive())`
  still short-circuits and does not evaluate `expensive()`.
- When enabled, `lc.debug(...args)` calls `logSink.log('debug', context, ...args)`
  exactly as before (same level, same context, same args).
- `flush()` behavior unchanged.
- No public API/type changes.

## Validation
- In the logger repo: run its own test suite; add/keep tests asserting (a) below
  the configured level the method is `undefined`, (b) at/above level the sink
  receives `(level, context, ...args)`, (c) `withContext` chaining merges
  context correctly.
- Microbenchmark (5M iters, debug level) comparing current vs. shared-function:
  **~192–220 ns → ~170 ns per `withContext`+call**, and **~7 → 2 allocations**
  per call. The raw-ns win is modest (V8 optimizes short-lived closures), but the
  allocation cut is the systemic benefit (less GC).
- In `mono` after bumping the logger version: re-run the zqlite hydration
  benchmark (`packages/zql-benchmarks`, `chinook-hydration` "all playlists" zqlite
  case) — `withContext` was ~5.6% of that run and contributed to the ~6–8% GC.

---

## Context from the `mono` perf work that surfaced this
While speeding up zqlite hydration in `arv/mono`, profiling showed
`@rocicorp/logger`'s `withContext` at ~5.6% of the run, plus GC pressure from
the per-fetch allocations. Two complementary levers:

1. **Reduce call sites in `mono`** (already done, lower risk): precompute the
   constant `LogContext`s once instead of calling `withContext` per operation.
   Landed in `arv/mono` PR for `zqlite` `Statement` (precompute per-method log
   contexts), which gave ~1.19× on zqlite hydration on its own.
2. **Make `withContext` itself cheaper** (this handoff): the shared-function
   rewrite above, in `@rocicorp/logger`. Benefits every consumer.

### Interim option (if you don't want to wait for a logger release)
Apply the same rewrite to `arv/mono` as a committed **pnpm patch**:
`pnpm patch @rocicorp/logger@5.4.0`, edit `out/logger.js` per the fix, then
`pnpm patch-commit` (creates `patches/@rocicorp__logger@5.4.0.patch` +
`pnpm.patchedDependencies` in the root `package.json`). Auto-applied on install.
Use this only as a bridge; the real fix belongs upstream.
