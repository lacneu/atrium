import { m } from "@/paraglide/messages.js";

// Pure logic for the chat-level "Sous-agents" block (SubAgentActivity.tsx).
//
// The bridge OBSERVES a chat's sub-agent (child) runs and upserts one row per
// child into the `subAgents` table (see convex/subAgents.ts). The UI subscribes
// to listSubAgents and renders one card per child. ALL the derivation — sorting,
// status -> display tone, the label fallback, the visible-FAILURE mapping, and
// the show/hide gate — lives here as pure functions so every branch (especially
// the error / timed-out path that is the whole point of the feature) is unit
// tested WITHOUT a DOM harness (the repo's pure-helper test convention, GC-P5).

/** The four lifecycle states the bridge writes (mirrors the schema union). */
export type SubAgentStatus = "running" | "done" | "error" | "aborted";

/** One sub-agent observation, as listSubAgents returns it. Kept structural (a
 *  loose superset of the Convex doc) so the pure helpers stay independent of the
 *  generated types and are trivially testable with plain fixtures. */
export type SubAgentRow = {
  _id: string;
  childSessionKey: string;
  taskName?: string;
  status: SubAgentStatus;
  resultText?: string;
  phase?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
};

/** Display tone, collapsing the two failure states into ONE visible-failure
 *  bucket: a card is `failed` whether the child errored or was aborted/timed
 *  out — both must read as "this went wrong, look here". */
export type SubAgentTone = "running" | "done" | "failed";

/** The view model for a single card. `failure` is the load-bearing flag: when
 *  true the card surfaces `errorMessage` PROMINENTLY (the user's headline pain is
 *  a sub-agent that failed/hung with no way to see it). */
export type SubAgentCardView = {
  id: string;
  label: string;
  status: SubAgentStatus;
  tone: SubAgentTone;
  failure: boolean;
  phase?: string;
  errorMessage?: string;
  resultText?: string;
};

export type SubAgentActivityView = {
  cards: SubAgentCardView[];
  total: number;
  running: number;
  failed: number;
};

/**
 * A short, human-pickable tail of a `childSessionKey`. The bridge keys are
 * `agent:<id>:subagent:<uuid>`, so the meaningful part is the segment AFTER the
 * last `:` (the child uuid). A long uuid is truncated to its head + ellipsis so
 * the fallback label stays compact; CSS ellipsis handles any remaining overflow.
 */
export function shortSessionKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") return "";
  const segment = trimmed.slice(trimmed.lastIndexOf(":") + 1) || trimmed;
  return segment.length > 10 ? `${segment.slice(0, 8)}…` : segment;
}

/** A card's label: the task name when the spawn meta carried one, else a short
 *  tail of the child session key. A blank/whitespace taskName falls back too. */
export function subAgentLabel(row: SubAgentRow): string {
  const name = row.taskName?.trim();
  if (name) return name;
  const short = shortSessionKey(row.childSessionKey);
  return short || m.subagents_untitled();
}

/** status -> display tone. error AND aborted both map to the visible-FAILURE
 *  tone (an aborted/timed-out child is a failure the user must see). */
export function statusTone(status: SubAgentStatus): SubAgentTone {
  if (status === "running") return "running";
  if (status === "done") return "done";
  return "failed"; // error | aborted
}

/** Build one card from a row. */
function toCard(row: SubAgentRow): SubAgentCardView {
  const tone = statusTone(row.status);
  return {
    id: row._id,
    label: subAgentLabel(row),
    status: row.status,
    tone,
    failure: tone === "failed",
    // phase is only meaningful while running; drop it on a settled card.
    phase: row.status === "running" ? row.phase : undefined,
    errorMessage: row.errorMessage,
    resultText: row.resultText,
  };
}

/**
 * Derive the whole block view from the raw rows: newest spawn FIRST (the server
 * already sorts, but re-sorting here keeps the helper self-contained and pins
 * the order under test), plus the running/failed counts used by the summary so a
 * collapsed block still surfaces the failed count.
 */
export function buildSubAgentActivityView(
  rows: readonly SubAgentRow[],
): SubAgentActivityView {
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  const cards = sorted.map(toCard);
  return {
    cards,
    total: cards.length,
    running: cards.filter((c) => c.tone === "running").length,
    failed: cards.filter((c) => c.tone === "failed").length,
  };
}

/**
 * The block's show/hide gate, pure so the visibility rule is unit-tested.
 *
 * Rule: `capable && total > 0 && (show || failed > 0)`. Two hard preconditions —
 * the gateway must advertise the `subagents` capability AND the chat must have at
 * least one sub-agent (otherwise a chat is visually unchanged). Beyond that:
 *  - ANALYSIS view (`show`): always visible (the full picture).
 *  - CLEAN view (`!show`): visible ONLY when a sub-agent FAILED — a failed/hung
 *    child is the headline pain (Bug C) and must be un-missable even with the
 *    tools toggle off, so the user knows to unblock the waiting parent.
 */
export function subAgentActivityVisible(
  show: boolean,
  capable: boolean,
  total: number,
  failed: number,
): boolean {
  return capable && total > 0 && (show || failed > 0);
}

/**
 * Which cards to render given the view mode. The ANALYSIS view shows ALL cards
 * (running/done/failed); the CLEAN view shows ONLY the failed ones — a tight
 * failure surface that does not clutter the content-focused view with running/
 * done detail. Pure so the filtering is table-tested.
 */
export function subAgentCardsToShow(
  cards: readonly SubAgentCardView[],
  show: boolean,
): SubAgentCardView[] {
  return show ? [...cards] : cards.filter((c) => c.failure);
}

/** "N sous-agent(s)" count label (i18n singular/plural; both branches tested). */
export function subAgentCountLabel(total: number): string {
  return total === 1
    ? m.subagents_count({ count: total })
    : m.subagents_count_plural({ count: total });
}

/** "N sub-agent(s) failed" label for the CLEAN-view failure header (i18n
 *  singular/plural; both branches tested). */
export function subAgentFailedLabel(failed: number): string {
  return failed === 1
    ? m.subagents_failed_label({ count: failed })
    : m.subagents_failed_label_plural({ count: failed });
}
