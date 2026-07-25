// ENVELOPE-SEQ CONTINUITY — frame-loss detection for one gateway connection.
//
// The gateway stamps a per-CONNECTION `seq` on every BROADCAST frame. When its
// outbound buffer exceeds the limit and the frame is droppable, it DISCARDS the
// frame while still ADVANCING that counter (upstream `server-broadcast.ts`: the
// `slow && dropIfSlow` branch does `clientSeq.set(c, nextSeq); continue;`). A
// hole in the sequence is therefore the ONLY trace a silently dropped frame
// leaves behind — and nothing checked it, so lost content simply went missing
// and the user was the one who noticed.
//
// THE FALSE POSITIVE TO AVOID: TARGETED broadcasts deliberately carry NO seq
// (same upstream file: `const eventSeq = isTargeted ? undefined : nextSeq`).
// Their absence must never read as a hole, or a perfectly healthy connection
// would raise a gap on every targeted frame. Only frames that HAVE a numeric seq
// participate in the continuity check.
//
// Pure and dependency-free so the contract is unit-testable in isolation.

/** A detected discontinuity: `missing` frames were lost before `received`. */
export interface SeqGap {
  /** How many frames the gateway dropped (>= 1). */
  missing: number;
  /** The seq we were expecting next. */
  expected: number;
  /** The seq that actually arrived. */
  received: number;
}

export interface SeqTracker {
  /**
   * Feed ONE inbound frame. Returns the gap it revealed, or null when there is
   * nothing to report (no seq / first frame / contiguous / repeat).
   */
  observe(frame: Readonly<Record<string, unknown>>): SeqGap | null;
  /** Total frames known lost on this connection (monotonic). */
  readonly missingTotal: number;
}

export function createSeqTracker(): SeqTracker {
  let last: number | null = null;
  let missingTotal = 0;
  return {
    observe(frame: Readonly<Record<string, unknown>>): SeqGap | null {
      const seq = frame.seq;
      // No seq = a TARGETED broadcast. Not a hole, and it must not disturb the
      // baseline either: the next numbered frame continues from the last
      // NUMBERED one, so `last` is deliberately left untouched here.
      if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
      const prev = last;
      if (prev === null) {
        last = seq; // first numbered frame: no baseline to compare against
        return null;
      }
      // NEVER DOWNGRADE the baseline (codex P3). A repeat or an out-of-order
      // arrival is not a loss, and letting it lower `last` would manufacture a
      // gap on the NEXT frame: 5, 4, 6 would report "5 lost" although 5 arrived.
      // Keep the highest seq ever seen.
      if (seq <= prev) return null;
      last = seq;
      if (seq === prev + 1) return null; // contiguous
      const missing = seq - prev - 1;
      missingTotal += missing;
      return { missing, expected: prev + 1, received: seq };
    },
    get missingTotal(): number {
      return missingTotal;
    },
  };
}
