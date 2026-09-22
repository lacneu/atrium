/**
 * WHY a turn closed — the label that survives its traces.
 *
 * The cause is computed by the bridge on every terminal and, until now, it rode
 * `chat.gateway_pressure` alone: a TRACE. Traces expire; the message they explain
 * does not. Prod triage 2026-09-21 measured the consequence — an `empty_response`
 * from the day before, still red in its conversation, whose `list_traces` returned
 * nothing for either the message or the child key. Seven tool calls, no text, and
 * no way left to say why the turn ended. The verdict must live on the object it
 * explains.
 *
 * Worse, the trace path never even guaranteed the record: it fires only when the
 * turn had pre-send pressure or closed on one of the AUTO_CLOSE causes, so an
 * ordinary `gateway_final` was frequently computed and never written anywhere.
 *
 * CONTENT-FREE by construction (SOC2 observability plane): this is an enum of our
 * own vocabulary — no message text, no error text, no identifier.
 */

/**
 * Every cause the bridge mints. Kept in lockstep with the sources by
 * `convex/finalizeCauseVocabulary.test.ts`, which reads the bridge's own call
 * sites through the TypeScript AST rather than trusting this list.
 */
export const FINALIZE_CAUSES: ReadonlySet<string> = new Set([
  // — The gateway said the turn ended —
  "gateway_final", // a final frame carrying the answer
  "gateway_terminal", // a post-reply failure, settled `complete`
  "gateway_error", // the gateway reported the turn failed
  "gateway_abort", // chat:aborted (a user Stop)
  "lifecycle_final", // a private ack arrived as the terminal
  "side_result_error", // a side-channel result carried the failure
  "upstream_error", // the connection itself failed upstream
  // — WE ended it, on a deadline the gateway never met —
  "recv_timeout",
  "response_timeout",
  "empty_final_timeout",
  "lifecycle_end_timeout",
  "lifecycle_finishing_timeout",
  "compaction_timeout",
  "approval_timeout",
  "private_ack_grace",
  "truncated_final_grace",
  "history_recovery_grace",
  // — Hermes terminals with no OpenClaw counterpart —
  "correlation_lost",
  "prompt_steered",
  "unreadable_terminal",
  "terminal_missing",
  "session_reset",
  // — The session closed the turn from outside the frame stream —
  "connection_lost",
  "gateway_restarting",
  "connection_saturated",
  "external",
  // — …and the one CONVEX mints itself (see CONVEX_MINTED_CAUSES) —
  "user_stop",
]);

/**
 * Causes Convex writes on its own, with no bridge involved.
 *
 * The user's Stop is settled here — the guaranteed finalize in `dispatchAbort`,
 * which runs whether or not the bridge could be reached. `first terminal write
 * wins`, so whatever that write says is the turn's verdict for good: leaving it
 * blank meant every Stop was permanently unexplained the moment its traces
 * expired, which is the exact defect this field exists to remove.
 *
 * Kept apart from the bridge's vocabulary because
 * `finalizeCauseVocabulary.test.ts` asserts the two sides agree, and these have no
 * counterpart there by construction.
 */
export const CONVEX_MINTED_CAUSES: ReadonlySet<string> = new Set(["user_stop"]);

/**
 * An unrecognised cause is NOT dropped.
 *
 * Dropping it would reproduce the very gap this field exists to close: a newer
 * bridge minting a word this deployment has not learned would leave the operator
 * with nothing, which is indistinguishable from "we never computed one". It is
 * recorded as `unclassified` — "the bridge named a cause, and this deployment does
 * not know that name" — which is a different, and actionable, statement.
 */
export const UNCLASSIFIED_FINALIZE_CAUSE = "unclassified";

/** A cause must LOOK like our vocabulary before it can be stored under it. */
const CAUSE_SHAPE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Bucket a cause reported by the bridge into a value safe to store.
 *
 * The boundary does not trust the sender's vocabulary — the same split
 * `compactionReasonClass` uses. Returns null when there is nothing to record:
 * absent then means "no cause reached us", never "we had one and hid it".
 */
export function finalizeCauseClass(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;
  if (FINALIZE_CAUSES.has(value)) return value;
  // Well-formed but unknown: the operator sees that a cause existed.
  if (CAUSE_SHAPE.test(value)) return UNCLASSIFIED_FINALIZE_CAUSE;
  // Malformed: not our vocabulary at all, and never a raw network string in
  // storage. Absence is the honest answer here.
  return null;
}
