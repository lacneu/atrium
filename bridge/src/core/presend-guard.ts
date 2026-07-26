// The GRADUATED pre-send guard (W2 / G-04, G-06, G-07).
//
// THE DEFECT IT ADDRESSES: the bridge already does a `sessions.describe` before
// every send and then sends unconditionally. When the session no longer fits, the
// turn is spent, the user waits, and the answer is a hard `context_length` — four
// times in three days in production, every one settled by a manual reset.
//
// THE INVARIANT THAT SHAPES THIS FILE (P6): a guard must NEVER cost a turn that
// would have succeeded. So this module is a PURE function whose default is
// `"send"`, and the only path to `"block"` is an explicit, positive, measured
// case. There is no try/catch here to forget: an unknown fill, an absent budget,
// a NaN — every one of them returns `"send"` because that is the fall-through, not
// because a handler caught something. The caller wraps the RPC it performs, and
// its catch also sends.
//
// The user-visible decision (block at >95% AFTER a mandatory compaction failed,
// rather than spending on a send known not to fit) was Olivier's, 2026-07-26.

/** What the send path should do next. `"send"` is the default in every doubt. */
export type PresendAction =
  /** Ship the message as-is. */
  | "send"
  /** Ship it, and tell the reader the session is close to its limit. */
  | "send_warn"
  /** Compact FIRST (best-effort), then re-describe, then send either way. */
  | "compact_then_send"
  /** Compact FIRST; if the compaction does not succeed, do NOT send. */
  | "compact_or_block";

export interface PresendInput {
  /** LIVE fill of the session as a 0..1+ share, or null when UNKNOWN. */
  fill: number | null;
  /** The gateway's own "the assembled prompt does not fit" figure, when it says
   *  so. Any positive value is the strongest signal there is. */
  overflowTokens?: number | null;
  /** TRUE once this turn has already attempted a compaction. At most ONE attempt
   *  per turn: a second would be a retry loop on the turn path. */
  alreadyCompacted: boolean;
}

/** The gateway summarizes with the model, so the compaction RPC needs a real
 *  budget. Shared by the pre-send guard and the manual `/compact` route. */
export const COMPACT_TIMEOUT_MS = 60_000;
/** Below this remaining budget, attempting a compaction is not worth it: the RPC
 *  would very likely outlive the dispatch deadline and cost the send. */
export const COMPACT_MIN_BUDGET_MS = 10_000;
/**
 * Room the guard must LEAVE after the compaction. Without it the guard could
 * consume the whole dispatch deadline and the send it was protecting would be
 * refused by `assertBeforeSendDeadline` — a turn lost to the guard, the one outcome
 * P6 forbids.
 *
 * It covers EVERYTHING still to come, not just the send: the re-describe (8 s), the
 * rehydration reads, the inbound reference staging (which streams files) and the
 * media injection, then `chat.send` itself (20 s). Sizing it to the send alone left
 * a window as wide as the compaction in which the guard caused the very refusal it
 * exists to prevent.
 */
export const PRESEND_RESERVE_MS = 8_000 + 30_000 + 20_000;

/**
 * How long the compaction RPC may be given, from the budget still left before the
 * dispatch deadline. Null = do NOT attempt it (and therefore do not block: skipping
 * the remedy is not evidence that the prompt does not fit).
 */
export function compactBudget(remainingMs: number): number | null {
  const usable = Math.min(COMPACT_TIMEOUT_MS, remainingMs - PRESEND_RESERVE_MS);
  return usable >= COMPACT_MIN_BUDGET_MS ? usable : null;
}

/** Below this, say nothing. */
export const FILL_INFORM = 0.7;
/** From here, compact pre-emptively but never withhold the send. */
export const FILL_COMPACT = 0.85;
/**
 * From here, a compaction is MANDATORY and an observed refusal withholds the send.
 *
 * Note what this threshold does and does not claim. A prompt at 97 % of
 * `promptBudgetBeforeReserve` is not PROVEN too large — the output reserve has not
 * been subtracted yet, this turn's own message and tool schemas are not counted, and
 * the gateway may still accept it. It is a judgment: at that fill, with the remedy
 * unavailable, the send overwhelmingly fails, and Olivier's decision (2026-07-26) was
 * to name the cause immediately rather than spend a turn and a provider call
 * discovering it. When the gateway states an overflow outright
 * (`overflowTokens > 0`), that IS proof and the threshold is not what decides.
 */
export const FILL_BLOCK = 0.95;

export function presendAction(input: PresendInput): PresendAction {
  // ONE attempt per turn. Reached only when a compaction already ran this turn:
  // whatever the fill says now, the remedy has been tried and the send proceeds.
  // (Blocking here instead would turn a single overfull turn into a dead end.)
  if (input.alreadyCompacted) return "send";

  // The gateway's OWN verdict that the prompt does not fit outranks any ratio we
  // compute: it accounts for what the counters miss (tool schemas, injected
  // context). Guarded for finiteness — a NaN must not become a block.
  //
  // DELIBERATELY checked BEFORE the fill, and NOT conditioned on the fill being
  // known (reviewed and kept, 2026-07-26): this figure IS the explicit positive
  // measurement the invariant asks for — the gateway computed it against its own
  // budget. Requiring our derived ratio to corroborate it would disarm the guard on
  // exactly the sessions where the counters are missing, which is when the gateway's
  // assessment is the only evidence there is. It is also the field the 2026-07-20
  // incident turned on: 50 960 tokens of overflow while the counters read
  // comfortable.
  const overflow = input.overflowTokens;
  if (typeof overflow === "number" && Number.isFinite(overflow) && overflow > 0) {
    return "compact_or_block";
  }

  const fill = input.fill;
  // UNKNOWN fill ⇒ send. This is the whole of P6: arming a guard on a measure we
  // do not have is how a guard blocks a turn that would have worked.
  if (fill === null || !Number.isFinite(fill)) return "send";

  if (fill > FILL_BLOCK) return "compact_or_block";
  if (fill > FILL_COMPACT) return "compact_then_send";
  if (fill > FILL_INFORM) return "send_warn";
  return "send";
}

/** Does this action require a compaction attempt before the send? */
export function requiresCompaction(action: PresendAction): boolean {
  return action === "compact_then_send" || action === "compact_or_block";
}

/**
 * After a compaction attempt, may the send proceed?
 *
 * `compacted` is TRUE only when the gateway confirmed it compacted. A REFUSAL is not
 * a defect — but it is also not a shrink, so under `compact_or_block` the prompt
 * still does not fit and sending it would spend a turn on a guaranteed failure.
 *
 * `attemptFailed` (the RPC threw, or answered without saying what it did) ⇒ SEND. We
 * do not know the session did not shrink, and P6 forbids paying for our own
 * uncertainty with the user's turn.
 *
 * `transientRefusal` ⇒ SEND, and this one is subtle. "Already active" / "already in
 * flight" mean something was RUNNING on this session — possibly a compaction that is
 * about to shrink it, possibly a delivery run whose existence the guard's own
 * busy-check missed by a microsecond. Withholding on that evidence blocks a turn for
 * a reason that is about to stop being true, which is exactly the failure this
 * module is shaped to make impossible.
 */
export function sendAfterCompaction(params: {
  action: PresendAction;
  compacted: boolean;
  attemptFailed: boolean;
  transientRefusal?: boolean;
}): boolean {
  if (params.action !== "compact_or_block") return true;
  if (params.attemptFailed) return true; // unknown outcome ⇒ send (P6)
  if (params.transientRefusal === true) return true; // about to stop being true
  return params.compacted;
}

/**
 * Thrown when the guard WITHHELD the send. A distinct type, not a message the
 * classifier greps: this is the one dispatch failure the bridge itself decides, so
 * it must be impossible to mint by accident from gateway text, and equally
 * impossible for a phrasing change to stop recognising.
 *
 * It classifies to the dispatch code `context_length` — deliberately the SAME code
 * the gateway's own hard overflow finalizes with, so the user gets the one card and
 * the two wired actions whether the overflow was measured before the send or
 * reported after it.
 */
export class ContextBlockedError extends Error {
  constructor(
    /** Content-free detail for the bridge log: the measured fill, as a percent. */
    readonly fillPct: number | null,
  ) {
    super(
      `send withheld: the session does not fit and the compaction did not shrink it` +
        (fillPct === null ? "" : ` (fill ${fillPct}%)`),
    );
    this.name = "ContextBlockedError";
  }
}
