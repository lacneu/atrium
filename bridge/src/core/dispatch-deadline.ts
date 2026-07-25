/**
 * How long a `/send` handler may take BEFORE it hands the prompt to its provider.
 *
 * Aborting Convex's POST does not cancel the handler it started. So a handler stuck
 * upstream of the send — an unbounded internal fetch, a paused process, a wedged
 * attachment staging — can wake up long after Convex reconciled its outbox row:
 * told the user the dispatch never reported back, and released the next queued turn
 * (see `convex/outboxReconcile.ts`). Submitting the prompt at that point would run a
 * turn Convex has already settled, alongside a second turn moving on the same
 * session — the one-turn-per-session invariant broken, with work the user cannot see.
 *
 * So the handler gives up first. This deadline sits well under the reconciler's
 * `STALLED_PENDING_MS` (15 min), which is the moment the row stops belonging to it.
 * Provider-neutral on purpose: OpenClaw checks it before `chat.send`, Hermes before
 * `prompt.submit` — the same rule at each provider's acceptance point.
 */
export const PRE_SEND_DEADLINE_MS = 8 * 60_000;

/**
 * Throw when this DISPATCH is past the deadline; call right before submitting.
 *
 * The age measured is the dispatch's, not the handler's: Convex reports how long the
 * outbox row had already been `pending` when it sent the POST (`dispatchAgeMs`), and
 * we add our own elapsed time on top. Without that term a POST arriving at minute 14
 * would still grant a fresh 8-minute budget and could submit at minute 22 — well past
 * the moment the row was reconciled and the conversation released. Only DURATIONS
 * cross the Convex↔bridge boundary, so no clock skew enters the comparison.
 */
export function assertBeforeSendDeadline(
  handlerStartedMs: number,
  now: number,
  dispatchAgeMs = 0,
): void {
  const elapsedMs = dispatchAgeMs + (now - handlerStartedMs);
  if (elapsedMs > PRE_SEND_DEADLINE_MS) {
    throw new Error(
      `dispatch deadline exceeded before send (elapsedMs=${elapsedMs}) — ` +
        "refusing to start a turn Convex has already settled",
    );
  }
}
