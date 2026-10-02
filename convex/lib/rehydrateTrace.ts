// Pure helpers for the `openclaw.rehydrate` decision trace + the
// `routing.rehydrate_missed` anomaly. Extracted from bridge_ingest so the
// content-free contract AND the anomaly fire-condition are unit-testable without
// the httpAction / Convex runtime (the bug surface is the SHAPE + the predicate,
// not the ingest plumbing).
//
// CONTRACT (mcp-enrich): the trace is keyed `chatId:outboxId` (the master join key
// matching chat.send + openclaw.dispatch), content-free — enums / scalars / routed
// agent NAMES only, NEVER prompt or history text.

/** The content-free fields the bridge ships for each dispatch's rehydration decision. */
export interface RehydrateTraceInput {
  decision: string;
  freshSession: boolean;
  routedSwitch: boolean;
  prependedTurns: number;
  routedAgentId: string;
  routedInstanceName: string | null;
  switchedFromAgentId: string | null;
  switchedFromInstanceName: string | null;
  /** Hybrid rehydration: a rolling summary rode in the injected block (+ its bounded
   *  size). Optional (absent on skips / pre-feature bridges) — still content-free. */
  summaryUsed?: boolean;
  summaryChars?: number;
  /** A `rehydrate` decision whose existing history did not ride the turn: over the
   *  live window (`window`) or over the frame beside inline attachments (`frame`).
   *  Allowlisted below; anything else is dropped. */
  historyWithheld?: string;
  /** Pre-send guard (W2): what the bridge decided BEFORE the send, on the figures
   *  the gateway's own describe carried. `presendBlocked` is the one that means the
   *  turn never left. Enums + an integer percent; the compaction reason arrives
   *  already BUCKETED by the bridge and is re-bucketed here (a divergent bridge is
   *  not a trusted source). */
  presendAction?: string;
  presendFillPct?: number | null;
  presendFillSource?: string | null;
  presendCompaction?: string;
  presendBlocked?: boolean;
  presendCompactReasonClass?: string;
}

import { COMPACTION_REASON_CLASSES } from "./compactionReasons";

/** Actions the pre-send guard may report. An ALLOWLIST, not a pass-through: this is
 *  the ingest trust boundary, and a divergent (or forged) bridge must not be able to
 *  put an arbitrary string in a trace. */
const PRESEND_ACTIONS: ReadonlySet<string> = new Set([
  "send",
  "send_warn",
  "compact_then_send",
  "compact_or_block",
]);
const PRESEND_COMPACTIONS: ReadonlySet<string> = new Set([
  "not_needed",
  "compacted",
  "refused",
  "error",
  "skipped_busy",
  "skipped_known_refusal",
  "skipped_no_budget",
  "unknown",
]);
const PRESEND_FILL_SOURCES: ReadonlySet<string> = new Set([
  "gateway_estimate",
  "counter",
]);
const HISTORY_WITHHELD_REASONS: ReadonlySet<string> = new Set([
  "window",
  "frame",
]);

/** The withheld reason when it is one the bridge can state, else undefined. */
function historyWithheldReason(
  value: unknown,
): "window" | "frame" | undefined {
  return typeof value === "string" && HISTORY_WITHHELD_REASONS.has(value)
    ? (value as "window" | "frame")
    : undefined;
}

/** Content-free projection of the pre-send guard's report. Anything unrecognized is
 *  DROPPED (never coerced to a default that would read as a real measurement). */
function presendTraceMeta(b: RehydrateTraceInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.presendAction !== undefined && PRESEND_ACTIONS.has(b.presendAction)) {
    out.presendAction = b.presendAction;
  }
  if (
    typeof b.presendFillPct === "number" &&
    Number.isFinite(b.presendFillPct)
  ) {
    // A percent, floored to an integer and bounded: a fill can legitimately
    // exceed 100 (that IS the overflow signal), but not unboundedly.
    out.presendFillPct = Math.max(0, Math.min(999, Math.round(b.presendFillPct)));
  }
  if (
    typeof b.presendFillSource === "string" &&
    PRESEND_FILL_SOURCES.has(b.presendFillSource)
  ) {
    out.presendFillSource = b.presendFillSource;
  }
  if (
    b.presendCompaction !== undefined &&
    PRESEND_COMPACTIONS.has(b.presendCompaction)
  ) {
    out.presendCompaction = b.presendCompaction;
  }
  // Only the TRUE case is recorded: a withheld send is the exceptional fact worth
  // a field, and `false` on every normal turn is noise.
  if (b.presendBlocked === true) out.presendBlocked = true;
  if (
    b.presendCompactReasonClass !== undefined &&
    COMPACTION_REASON_CLASSES.has(b.presendCompactReasonClass)
  ) {
    out.presendCompactReasonClass = b.presendCompactReasonClass;
  }
  return out;
}

/** Build the `openclaw.rehydrate` trace meta — content-free by construction. The
 *  switchedFrom* names are included only when present (an actual agent switch). NO
 *  field here is free text; the type forbids it and this function never reads a body
 *  message/history. */
export function rehydrateTraceMeta(
  b: RehydrateTraceInput,
): Record<string, unknown> {
  return {
    op: "rehydrateTrace",
    decision: b.decision,
    freshSession: b.freshSession,
    routedSwitch: b.routedSwitch,
    prependedTurns: b.prependedTurns,
    routedAgentId: b.routedAgentId,
    routedInstanceName: b.routedInstanceName,
    ...(b.switchedFromAgentId !== null
      ? { switchedFromAgentId: b.switchedFromAgentId }
      : {}),
    ...(b.switchedFromInstanceName !== null
      ? { switchedFromInstanceName: b.switchedFromInstanceName }
      : {}),
    ...(b.summaryUsed === true
      ? { summaryUsed: true, summaryChars: b.summaryChars ?? 0 }
      : {}),
    ...(historyWithheldReason(b.historyWithheld) !== undefined
      ? { historyWithheld: historyWithheldReason(b.historyWithheld) }
      : {}),
    ...presendTraceMeta(b),
  };
}

/** The `routing.rehydrate_missed` anomaly fire condition: a per-turn ROUTED switch
 *  (or a fork's first turn, which carries the same re-key signal) whose session was
 *  FRESH but that still did NOT re-inject history — i.e. the agent got no
 *  conversation context. Two shapes: a non-`rehydrate` decision (e.g. an attachment
 *  turn on a gateway that cannot take history beside a file), and a `rehydrate`
 *  decision whose history EXISTED but was withheld (over the window, or over the
 *  frame beside the attachments) — prepending nothing. An empty history is not a
 *  miss (nothing to carry), so the second shape needs the bridge's stated reason. */
export function shouldReportRehydrateMissed(b: {
  routedSwitch: boolean;
  freshSession: boolean;
  decision: string;
  prependedTurns?: number;
  summaryUsed?: boolean;
  historyWithheld?: string;
}): boolean {
  if (!b.routedSwitch || !b.freshSession) return false;
  // A gateway COMMAND is sent exactly as typed and needs no context; the bridge leaves
  // the session fresh, so the next ordinary turn carries the history. Not a miss.
  if (b.decision === "skip_command") return false;
  if (b.decision !== "rehydrate") return true;
  return (
    historyWithheldReason(b.historyWithheld) !== undefined &&
    (b.prependedTurns ?? 0) === 0 &&
    b.summaryUsed !== true
  );
}
