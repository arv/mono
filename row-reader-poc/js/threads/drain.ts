import {type Row, ThreadQueue} from './queue.ts';

/**
 * Consume `total` rows from the queue, sleeping on `Atomics.waitAsync` when all
 * rings are empty (so it works on a browser main thread, which cannot
 * `Atomics.wait`). Producers must run a queue constructed with `{notify: true}`.
 *
 * Reads the signal word *before* scanning so a producer enqueueing between the
 * scan and the wait can't be missed (the async wait sees the changed value and
 * returns immediately).
 */
export async function drainAsync(
  queue: ThreadQueue,
  total: number,
  onRow: (row: Row) => void,
  opts: {timeoutMs?: number} = {},
): Promise<void> {
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
  let consumed = 0;
  let scan = 0;
  while (consumed < total) {
    const signal = queue.loadSignal();
    const row = queue.dequeue(scan);
    if (row !== null) {
      scan = (row.threadId + 1) % queue.numRings;
      onRow(row);
      consumed++;
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`drain timed out at ${consumed}/${total} rows`);
    }
    await queue.waitForData(signal, 1000);
  }
}
