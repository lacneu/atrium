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
 * How long a turn tolerates TOTAL silence from its provider AFTER acceptance.
 *
 * The pre-send deadline above stops at acceptance; this one starts there. Together they
 * mean no turn can wait forever at any stage, which was not true until lot 29: the Hermes
 * transports awaited their terminal with no bound at all, so a lost frame or a stalled
 * provider left the row `streaming` until Convex's stuck-stream watchdog reaped it —
 * twelve minutes of "Réflexion…" on an answer already lost.
 *
 * Two relationships fix the value, neither arbitrary:
 *  - well UNDER Convex's `STALE_STREAM_MS` (12 min), so the bridge settles the turn with
 *    a named cause and the watchdog stays the backstop it was built to be;
 *  - equal to the OpenClaw normalizer's own silence budget, because the transports are
 *    answering the same question and a user has no reason to wait longer on one provider
 *    than another.
 *
 * Provider-neutral on purpose, like the deadline above: it lives here so the WS and REST
 * paths cannot drift into two different answers to the same question.
 */
export const RECV_SILENCE_MS = 240_000;

/** The abort REASON a turn uses when IT gave up on silence — distinct from a user Stop,
 *  which arrives through the caller's own signal. Without it the two are the same
 *  `AbortError` and the turn cannot tell "the user cancelled" from "nobody answered". */
export const RECV_SILENCE_ABORT = "hermes-recv-silence";

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
