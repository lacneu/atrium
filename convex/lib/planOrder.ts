// WHICH PLAN UPDATE IS CURRENT — one rule, read by both tiers.
//
// Plan parts are appended in write order, but a write's ORDER is not its CAUSE:
// `clearPlan` is retried on a transient POST failure (bridge convex-writer
// IDEMPOTENT_OPS), so a clear whose first write was lost can land AFTER a plan
// another run published in between. Each part therefore carries `stamp` — the
// instant the BRIDGE received the frame behind it (core/events.ts
// `stampReceived`), re-posted unchanged by a retry — and the current update is
// the one with the greatest stamp, not the last row inserted.
//
// Parts written before the stamp existed, or by an older bridge, carry none.
// Such a part is dated by the GREATEST stamp seen before it — not the last one
// seen: a row that lost (an older clear parked after the plan it could not hide)
// must not drag the unstamped row that follows it below the winner. With that,
// an unstamped part written after stamped ones still wins on insertion order,
// and a run of unstamped parts reduces to plain insertion order. Equal stamps
// keep insertion order. Note what that inheritance means in a MIXED history:
// an unstamped row is not immune to a bad stamp above it — it inherits that
// stamp, so an inversion below reaches it too.
//
// The stamp's unit is the bridge's clock in SECONDS (bridge session.ts
// `Clock`), with millisecond resolution. ORDERING only ever compares two of
// them; the one place a stamp is read as a Unix time is `usablePlanStamp`
// below, which needs an absolute reference to catch a unit regression.
//
// STATED LIMITS, and they are not all of one kind:
//   - TIES fall back to insertion order — exactly the ordering this replaces,
//     never worse. Two causes inside one millisecond compare equal.
//   - INVERSIONS are worse than insertion order, because a wrong stamp is
//     believed: two instances serving one chat hold two clocks, and the clock
//     is the WALL clock, so an NTP correction can move it backwards. A clear
//     stamped 110 by a fast bridge beats a plan stamped 101 that arrived after
//     it — insertion order would have shown that plan. This is the price of
//     reading a stamp at all, and it buys the retry window, which is a certain
//     defect rather than a clock-skew-sized one.
// Nothing here refuses a write: this is a reading rule, and the write side
// stays unconditional on purpose (convex/stream.ts `clearPlanPart`).

/** Index of the current plan update in `parts` (ordered by `order`), or -1. */
export function currentPlanIndex(
  parts: readonly { stamp?: number }[],
): number {
  let winner = -1;
  let winnerStamp = -Infinity;
  let seenMax = -Infinity;
  for (let i = 0; i < parts.length; i++) {
    const own = parts[i]?.stamp;
    const effective = own ?? seenMax;
    if (effective >= winnerStamp) {
      winner = i;
      winnerStamp = effective;
    }
    if (own !== undefined && own > seenMax) seenMax = own;
  }
  return winner;
}

/** How far ahead of the server's own clock a plan stamp may claim to be.
 *
 *  A generous day: bridge clocks drift, and refusing a legitimately skewed
 *  stamp costs more than admitting one. What this actually bars is the UNIT
 *  regression — a stamp posted in MILLISECONDS is ~1000x the server's seconds
 *  (1.8e12 vs 1.8e9), so it would outrank every correct stamp for the lifetime
 *  of the message and pin one plan as current forever (codex). */
const STAMP_FUTURE_SLACK_S = 86_400;

/** A plan stamp fit to order by, or undefined — the screen every write path
 *  applies to network input before storing one (convex/stream.ts `addPart`,
 *  bridge_ingest's `clearPlan`/`advancePlan`).
 *
 *  Dropping is deliberate: the plan itself is still true, only its ordering
 *  claim is not, and an unstamped part orders by arrival — the behavior that
 *  predates stamps. `nowMs` is the server's own clock, in milliseconds. */
export function usablePlanStamp(
  stamp: unknown,
  nowMs: number,
): number | undefined {
  if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) {
    return undefined;
  }
  return stamp <= nowMs / 1000 + STAMP_FUTURE_SLACK_S ? stamp : undefined;
}
