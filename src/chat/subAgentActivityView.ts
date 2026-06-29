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

/** True iff the chat has at least one sub-agent still RUNNING. A cheap derivation
 *  (no card building) the composer uses to treat the chat as BUSY: while a child
 *  runs the parent turn has finalized but the bridge is one-turn-per-session, so a
 *  follow-up must be HELD (and the hold made visible) rather than silently parked. */
export function hasRunningSubAgent(rows: readonly SubAgentRow[]): boolean {
  return rows.some((r) => r.status === "running");
}

/** status -> display tone. error AND aborted both map to the visible-FAILURE
 *  tone (an aborted/timed-out child is a failure the user must see). */
export function statusTone(status: SubAgentStatus): SubAgentTone {
  if (status === "running") return "running";
  if (status === "done") return "done";
  return "failed"; // error | aborted
}

/** A sub-agent can be REPORTED once it has reached a TERMINAL state — `done`
 *  (the `wrong_result` case: "it finished but the answer was wrong") OR
 *  failed/aborted (the error case). A still-`running` child has nothing to
 *  report yet, so the flag is gated off there. Gating the report flag on
 *  "failure" alone would make the `wrong_result` category dead-reachable
 *  (a done child would never expose a flag). */
export function isReportableSubAgent(status: SubAgentStatus): boolean {
  return status !== "running";
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
 * The sub-agent rows a SINGLE assistant turn spawned, for anchoring the cards
 * UNDER that turn (not in a chat-level pile). Pure ownership join: keep only the
 * rows whose `childSessionKey` is in `keys` (the keys the turn's `sessions_spawn`
 * output carried — see assistantEmptyState.extractSpawnedChildKeys). An empty
 * `keys` (the turn spawned nothing, or its spawn output was elided) yields no
 * rows: the turn anchors no card, and the chat-level failure beacon stays the
 * safety net for an elided / out-of-window failure.
 */
export function subAgentRowsForMessage(
  rows: readonly SubAgentRow[],
  keys: readonly string[],
): SubAgentRow[] {
  if (keys.length === 0) return [];
  const owned = new Set(keys);
  return rows.filter((r) => owned.has(r.childSessionKey));
}

/** The chat-level FAILURE-beacon view model. `jumpIds` are the failed rows' ids
 *  in THREAD order (oldest spawn first = top→bottom of the conversation), so a
 *  consumer can scroll to the first failed card that is actually anchored on
 *  screen and fall back to a failure-only list for any whose spawning turn is
 *  outside the loaded message window / had an elided spawn output. */
export type FailedSubAgentBeacon = {
  visible: boolean;
  count: number;
  jumpIds: string[];
};

/**
 * Derive the persistent, chat-level failure signal (Bug C): the un-missable
 * indicator that a sub-agent failed SOMEWHERE in the chat, kept reachable even
 * when its spawning message is scrolled far away. Pure so visibility + count +
 * jump ORDER are unit-tested without a DOM harness.
 *
 * Rule: visible iff the gateway advertises `subagents` AND at least one row is a
 * FAILURE (error | aborted — `statusTone` collapses both). Independent of the
 * tools toggle: a failure must surface in BOTH the clean and analysis views, so
 * this never depends on `show`. `count` is the number of failed sub-agents;
 * `jumpIds` orders them oldest-first so the first jump target is the topmost
 * failure in the thread.
 */
export function failedSubAgentBeacon(
  rows: readonly SubAgentRow[],
  capable: boolean,
): FailedSubAgentBeacon {
  if (!capable) return { visible: false, count: 0, jumpIds: [] };
  const failed = rows.filter((r) => statusTone(r.status) === "failed");
  if (failed.length === 0) return { visible: false, count: 0, jumpIds: [] };
  const jumpIds = [...failed]
    .sort(
      (a, b) =>
        a.createdAt - b.createdAt ||
        (a._id < b._id ? -1 : a._id > b._id ? 1 : 0),
    )
    .map((r) => r._id);
  return { visible: true, count: failed.length, jumpIds };
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

// --- DISPLAY-side error shortening ------------------------------------------
//
// A sub-agent `errorMessage` reaches the store sanitized of server paths (the
// bridge observer's sanitizeResult) but can still be a long, ugly blob -- the
// gateway wraps tool failures in an untrusted-content safety notice, so a single
// failure can carry ~2KB of "SECURITY NOTICE ... EXTERNAL_UNTRUSTED_CONTENT ...
// DO NOT ..." boilerplate around the one useful line ("web_fetch failed (401)").
// Rendering that raw is both ugly AND a content-injection surface. This reduces
// ANY errorMessage to a SHORT, human reason fit for an inline label:
//   1) the highest-signal "<tool> failed (<code>)" pattern  -> "web_fetch (401)"
//   2) else the first meaningful, non-boilerplate line, capped
//   3) else the localized generic fallback
// Applied at the display EDGES (the sub-agent card + the empty-bubble failed
// state), never inside toCard -- the raw message stays in the view model.

/** Hard cap on the shortened reason (chars, ellipsis included). */
const SUBAGENT_ERROR_CAP = 120;

// Structural markers the gateway's untrusted-content wrapper injects. They are
// noise and must never reach the display. The token markers are matched
// case-insensitively (they are always emitted in this form); the imperative
// "DO NOT" is matched in its UPPERCASE boilerplate form ONLY, so legitimate
// lowercase prose ("you do not have access") is preserved.
const BOILERPLATE_TOKENS = /EXTERNAL_UNTRUSTED_CONTENT|SECURITY\s*NOTICE|UNTRUSTED\s*CONTENT/i;
const BOILERPLATE_IMPERATIVE = /DO NOT/;

function isBoilerplate(line: string): boolean {
  return BOILERPLATE_TOKENS.test(line) || BOILERPLATE_IMPERATIVE.test(line);
}

function capReason(s: string): string {
  return s.length <= SUBAGENT_ERROR_CAP
    ? s
    : `${s.slice(0, SUBAGENT_ERROR_CAP - 1)}…`;
}

/** First whitespace-collapsed, non-boilerplate, non-trivial line of `text`. */
function firstMeaningfulLine(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length < 3) continue; // blank / too short to be a reason
    // Skip a SEPARATOR / decoration line with no actual word content (e.g.
    // "=====", "----", "***", "<<<>>>"): the gateway's security wrapper fences the
    // real reason with these, so returning one would surface "=====" instead of the
    // reason (or the generic fallback). Require at least one letter or digit.
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    if (isBoilerplate(line)) continue; // safety-wrapper noise
    return line;
  }
  return null;
}

/**
 * Reduce a raw sub-agent error to a SHORT, display-safe reason. ALWAYS returns a
 * non-empty string: a usable extraction when possible, else the localized generic
 * fallback. Guaranteed to be <= SUBAGENT_ERROR_CAP chars and free of the
 * untrusted-content boilerplate.
 */
export function shortenSubAgentError(raw: string | null | undefined): string {
  const generic = m.subagents_error_generic();
  if (raw === null || raw === undefined) return generic;
  const text = raw.trim();
  if (text === "") return generic;

  // 1) Highest-signal: "<tool> failed (<code>)" -> "<tool> (<code>)". Runs over
  //    the WHOLE text so it survives even a single-line boilerplate blob.
  const toolFail = /([A-Za-z][\w.-]*)\s+failed\s*\(([^)]{1,40})\)/i.exec(text);
  if (toolFail) return capReason(`${toolFail[1]} (${toolFail[2].trim()})`);

  // 2) Else the first meaningful, non-boilerplate line.
  const line = firstMeaningfulLine(text);
  // The final guard: never return a candidate that still carries a marker.
  if (line && !isBoilerplate(line)) return capReason(line);

  // 3) Nothing usable / everything was boilerplate.
  return generic;
}
