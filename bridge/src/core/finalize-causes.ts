/**
 * WHY a turn closed — the bridge's own vocabulary, as a TYPE.
 *
 * It is a union rather than a list because the compiler is the only guard that
 * cannot drift: a new cause fails to compile until it is named here, and a name
 * that no site mints is visible in one place. The first attempt at keeping this
 * in step used an AST scan of the call sites, and it was wrong within the hour —
 * the causes reach `finalize` through several shapes (a literal argument, a
 * `finalizeOrHold` hand-off, a ternary assigned to a local), and a positional rule
 * saw ten of seventeen and missed `side_result_error` entirely.
 *
 * Convex holds the matching allowlist (`convex/lib/finalizeCause.ts`) because the
 * ingest boundary does not trust the wire; `convex/finalizeCauseVocabulary.test.ts`
 * asserts the two agree by reading THIS declaration.
 */
export type FinalizeCause =
  // — The gateway said the turn ended —
  /** A final frame carrying the answer. */
  | "gateway_final"
  /** A post-reply gateway failure, settled `complete`. */
  | "gateway_terminal"
  /** The gateway reported that the turn failed. */
  | "gateway_error"
  /** `chat:aborted` — a user Stop. */
  | "gateway_abort"
  /** A private acknowledgement arrived as the terminal. */
  | "lifecycle_final"
  /** A side-channel result carried the failure. */
  | "side_result_error"
  /** The connection itself failed upstream. */
  | "upstream_error"
  // — WE ended it, on a deadline the gateway never met —
  | "recv_timeout"
  | "response_timeout"
  | "empty_final_timeout"
  | "lifecycle_end_timeout"
  | "lifecycle_finishing_timeout"
  | "compaction_timeout"
  | "approval_timeout"
  | "private_ack_grace"
  | "truncated_final_grace"
  | "history_recovery_grace"
  // — Hermes terminals with no OpenClaw counterpart —
  /** The provider sent more events than the turn could attribute to it. */
  | "correlation_lost"
  /** The provider merged this prompt into a turn already running. */
  | "prompt_steered"
  /** The terminal arrived in a shape this bridge could not read. */
  | "unreadable_terminal"
  /** The body simply ended: the provider never declared the turn over. */
  | "terminal_missing"
  /** WE cancelled this turn: a `/reset` cleared the conversation under it. The
   *  provider reported nothing — telling this apart from `gateway_abort` is the
   *  difference between "the user reset" and "the gateway stopped us". */
  | "session_reset"
  // — The session closed the turn from outside the frame stream —
  /** A terminal nobody named: the socket went, and we said so. */
  | "connection_lost"
  /** The gateway announced its own restart on the way out. */
  | "gateway_restarting"
  /** Frames were dropped because one end could not keep up. */
  | "connection_saturated"
  | "external";

/**
 * The same vocabulary at runtime. DERIVED from the union by construction: the
 * `satisfies` below fails to compile if the two ever disagree in either
 * direction — a member missing here, or one here that the union does not name.
 */
export const FINALIZE_CAUSES = [
  "gateway_final",
  "gateway_terminal",
  "gateway_error",
  "gateway_abort",
  "lifecycle_final",
  "side_result_error",
  "upstream_error",
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
  "correlation_lost",
  "prompt_steered",
  "unreadable_terminal",
  "terminal_missing",
  "session_reset",
  "connection_lost",
  "gateway_restarting",
  "connection_saturated",
  "external",
] as const satisfies readonly FinalizeCause[];

// …and the other direction: every member of the union appears above. A union
// member with no runtime entry would leave `Exclude<…>` non-empty, and indexing
// `never` with it is an error. (A plain `satisfies` only proves the inclusion
// this comment's counterpart proves.)
type _EveryCauseListed =
  Exclude<FinalizeCause, (typeof FINALIZE_CAUSES)[number]> extends never
    ? true
    : never;
const _everyCauseListed: _EveryCauseListed = true;
void _everyCauseListed;
