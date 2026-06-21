// Logical turn order for chat messages.
//
// `_creationTime` is NOT a reliable logical order: a mid-turn QUEUE follow-up
// inserted in the pending-pre-ack window gets a `_creationTime` EARLIER than the
// in-flight turn's assistant reply (which is created later, at ack). Ordering by
// `_creationTime` then both leaks a future queued user message into history AND
// misorders/drops the prior assistant.
//
// Fix: a queued user message carries an explicit `orderTime`:
//   - while parked: a SENTINEL (sorts LAST, after every dispatched turn);
//   - on dispatch: re-stamped to the real time by `drainNextQueued`, which ALWAYS
//     runs on turn-end (finalize / markOutbox / failDispatch / stuck-stream), hence
//     AFTER the prior turn's assistant was created → it sorts correctly.
// Idle sends and assistant messages NEVER set `orderTime` — their `_creationTime`
// IS their logical position. Order everywhere by `effectiveOrder`.
//
// WINDOWING INVARIANT (keeps listByChat's `_creationTime`-windowed read valid): an
// `orderTime`-bearing row always has a RECENT `_creationTime` (queued = just
// inserted; drained = stamped moments later), so it can never fall outside the
// newest-N window. Do NOT stamp `orderTime` onto an OLD message.

/** Sentinel `orderTime` for a still-parked queued message — sorts after any real
 *  Date.now() (≈ year 275760). Replaced with the real dispatch time on drain. */
export const QUEUED_ORDER_SENTINEL = 8.64e15;

/** A message's logical-order key: explicit `orderTime` when set, else creation time. */
export function effectiveOrder(m: {
  orderTime?: number;
  _creationTime: number;
}): number {
  return m.orderTime ?? m._creationTime;
}

/**
 * Total order for messages: by `effectiveOrder`, tie-broken by `_creationTime`. The
 * tie-break is LOAD-BEARING when several follow-ups are queued at once — they all
 * carry the same SENTINEL `orderTime`, so `effectiveOrder` alone can't separate them
 * (FIFO `_creationTime` does). ALL consumers (listByChat sort, rehydration, the
 * delete/truncate-forward boundary) must use THIS, or they'll disagree on the order.
 */
export function compareOrder(
  a: { orderTime?: number; _creationTime: number },
  b: { orderTime?: number; _creationTime: number },
): number {
  return effectiveOrder(a) - effectiveOrder(b) || a._creationTime - b._creationTime;
}
