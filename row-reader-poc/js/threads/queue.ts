/**
 * Lock-free SPSC ring buffers over a single `SharedArrayBuffer` — one ring per
 * producer thread, drained by a single consumer (the main thread). Each
 * producer owns its ring's `head`; the consumer owns every `tail`. All
 * synchronization uses `Atomics` (JS atomics are sequentially consistent, so a
 * producer's payload writes before its `Atomics.store(head)` are visible to the
 * consumer once it observes the advanced head).
 *
 * Layout of the shared buffer:
 *
 *   [ control int32s | data slots ]
 *     ^ per ring:       ^ numRings * capacity slots of `slotBytes`:
 *       head, tail        [ threadId i32 | len i32 | payload bytes ]
 */

const CTRL_PAD_INTS = 8; // reserve a cache-line-ish gap before per-ring ints
const SLOT_BYTES = 256; // 8-byte header + up to 248-byte payload
const SLOT_HEADER = 8;

export interface Layout {
  numRings: number;
  capacity: number; // must be a power of two
  dataOffset: number; // byte offset of the first data slot
  slotBytes: number;
  payloadMax: number;
  byteLength: number; // total SharedArrayBuffer size
}

const align = (n: number, a: number) => Math.ceil(n / a) * a;

export function computeLayout(numRings: number, capacity: number): Layout {
  if ((capacity & (capacity - 1)) !== 0) {
    throw new Error(`capacity must be a power of two, got ${capacity}`);
  }
  const ctrlInts = CTRL_PAD_INTS + numRings * 2;
  const dataOffset = align(ctrlInts * 4, 8);
  return {
    numRings,
    capacity,
    dataOffset,
    slotBytes: SLOT_BYTES,
    payloadMax: SLOT_BYTES - SLOT_HEADER,
    byteLength: dataOffset + numRings * capacity * SLOT_BYTES,
  };
}

export interface Row {
  threadId: number;
  bytes: Uint8Array;
}

export class ThreadQueue {
  readonly #i32: Int32Array;
  readonly #u8: Uint8Array;
  readonly #layout: Layout;
  readonly #mask: number;

  constructor(sab: SharedArrayBuffer, layout: Layout) {
    this.#i32 = new Int32Array(sab);
    this.#u8 = new Uint8Array(sab);
    this.#layout = layout;
    this.#mask = layout.capacity - 1;
  }

  #headIdx(ring: number): number {
    return CTRL_PAD_INTS + ring * 2;
  }

  #tailIdx(ring: number): number {
    return CTRL_PAD_INTS + ring * 2 + 1;
  }

  #slotByteBase(ring: number, slot: number): number {
    const {dataOffset, capacity, slotBytes} = this.#layout;
    return dataOffset + (ring * capacity + slot) * slotBytes;
  }

  /**
   * Producer side: copy `bytes` into ring `ring`'s next slot, blocking (via
   * `Atomics.wait`) while the ring is full. Tagged with `threadId`.
   */
  enqueue(ring: number, threadId: number, bytes: Uint8Array): void {
    if (bytes.length > this.#layout.payloadMax) {
      throw new Error(
        `row of ${bytes.length}B exceeds slot payload ${this.#layout.payloadMax}B`,
      );
    }
    const headIdx = this.#headIdx(ring);
    const tailIdx = this.#tailIdx(ring);
    const head = Atomics.load(this.#i32, headIdx);
    const next = (head + 1) & this.#mask;

    // Backpressure: wait until the consumer frees a slot (advances tail).
    while (next === Atomics.load(this.#i32, tailIdx)) {
      Atomics.wait(this.#i32, tailIdx, next);
    }

    const byteBase = this.#slotByteBase(ring, head);
    const intBase = byteBase >> 2;
    this.#i32[intBase] = threadId;
    this.#i32[intBase + 1] = bytes.length;
    this.#u8.set(bytes, byteBase + SLOT_HEADER);

    Atomics.store(this.#i32, headIdx, next); // publish
  }

  /**
   * Consumer side: scan rings starting at `scanStart` and return the first
   * available row (copied out of shared memory), or null if all rings are
   * empty. Notifies the owning producer that a slot was freed.
   */
  dequeue(scanStart = 0): Row | null {
    const {numRings} = this.#layout;
    for (let k = 0; k < numRings; k++) {
      const ring = (scanStart + k) % numRings;
      const headIdx = this.#headIdx(ring);
      const tailIdx = this.#tailIdx(ring);
      const tail = Atomics.load(this.#i32, tailIdx);
      if (Atomics.load(this.#i32, headIdx) === tail) continue; // empty

      const byteBase = this.#slotByteBase(ring, tail);
      const intBase = byteBase >> 2;
      const threadId = this.#i32[intBase];
      const len = this.#i32[intBase + 1];
      const payloadOff = byteBase + SLOT_HEADER;
      // .slice() copies out of the SharedArrayBuffer into a private buffer, so
      // the returned RowReader-ready bytes don't alias the ring slot.
      const bytes = this.#u8.slice(payloadOff, payloadOff + len);

      Atomics.store(this.#i32, tailIdx, (tail + 1) & this.#mask);
      Atomics.notify(this.#i32, tailIdx); // wake a producer blocked on full

      return {threadId, bytes};
    }
    return null;
  }
}
