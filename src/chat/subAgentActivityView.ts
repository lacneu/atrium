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
/** A tool the CHILD sub-agent called, on the always-loaded SUMMARY: name + lifecycle
 *  status + the toolCallId join key only. The args/result DETAIL lives in its own
 *  table (subAgentToolParts), correlated to this summary by toolCallId in the panel.
 *  Mirrors the schema's `subAgents.tools` element. */
export type SubAgentToolRow = {
  name: string;
  status: "running" | "done";
  toolCallId?: string;
};

/** The child's STATIC session config (model / reasoning / speed / scope) — CONFIG,
 *  not content. Drives the panel session bar + the Advanced popover. */
export type SubAgentSessionMeta = {
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  controlScope?: string;
  subagentRole?: string;
  spawnDepth?: number;
  /** Spawn-time config (present only when the spawn set it) + the source gateway kind
   *  (the provider seam). `context: "fork"` = the parent transcript was branched in. */
  context?: string;
  runtime?: string;
  mode?: string;
  cleanup?: string;
  sandbox?: string;
  gatewayKind?: string;
  /** Extended spawn args + child session statics (see convex/subAgents SESSION_META). */
  label?: string;
  cwd?: string;
  agentId?: string;
  lightContext?: boolean;
  sessionId?: string;
  spawnedWorkspaceDir?: string;
};

/** Run telemetry (runtime / tokens / estimated cost) — content-free numbers written
 *  at heartbeat/terminal cadence (live-ish while running, final once settled). */
export type SubAgentTelemetry = {
  runtimeMs?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  startedAt?: number;
};

export type SubAgentRow = {
  _id: string;
  /** The assistant message that spawned this child (the bridge tags it at
   *  registration). The ROBUST correlation key — message-precise, no toolPart parse. */
  parentMessageId?: string;
  childSessionKey: string;
  taskName?: string;
  status: SubAgentStatus;
  resultText?: string;
  phase?: string;
  errorMessage?: string;
  tools?: ReadonlyArray<SubAgentToolRow>;
  sessionMeta?: SubAgentSessionMeta;
  telemetry?: SubAgentTelemetry;
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
  /** The child's session key — the panel open/correlation key. */
  childSessionKey: string;
  /** Mixture-of-Agents role when this card is a MoA component (from the
   *  spawn meta): drives the card's KIND label + the aggregator-first order +
   *  the nested rendering of references under their aggregator. */
  moaRole?: "moa_reference" | "moa_aggregator";
  /** The spawn task name (clean) when known — the card's subtitle. */
  taskName?: string;
  label: string;
  status: SubAgentStatus;
  tone: SubAgentTone;
  failure: boolean;
  phase?: string;
  errorMessage?: string;
  resultText?: string;
  /** The tools the child used (name + status + the toolCallId join key) — the
   *  AUTHORITATIVE summary list (its length is the tool count). The panel renders
   *  one card per entry and looks up the args/result DETAIL by toolCallId, so the
   *  card count can never disagree with the count. Absent when the child called none. */
  tools?: ReadonlyArray<{
    name: string;
    status: "running" | "done";
    toolCallId?: string;
  }>;
  /** The child's static session config — model / reasoning / speed / scope (the
   *  panel session bar + Advanced popover). Absent until the first session frame. */
  sessionMeta?: SubAgentSessionMeta;
  /** Run telemetry (live-ish while running via heartbeats; final once settled). */
  telemetry?: SubAgentTelemetry;
  /** The agent the CHILD runs AS, derived from the session key (`agent:<id>:subagent:…`).
   *  Differs from the parent when the spawn targeted another agent (allowAgents). */
  childAgentId?: string;
};

export type SubAgentActivityView = {
  cards: SubAgentCardView[];
  total: number;
  done: number;
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

/** The agent id the CHILD runs AS, parsed from `agent:<id>:subagent:<uuid>` (nesting
 *  keeps the FIRST id — depth-2 keys append more `:subagent:` segments). Undefined on
 *  a foreign/unNparseable key shape rather than a wrong guess. */
export function childAgentIdFromKey(key: string): string | undefined {
  const match = /^agent:(.+?):subagent:/.exec(key.trim());
  const id = match?.[1]?.trim();
  return id ? id : undefined;
}

/** Human duration for a child's runtimeMs: "42 s", "3 min 12 s", "1 h 04 min".
 *  Sub-second runs read "< 1 s" (never "0 s"). Pure for unit tests. */
export function formatRuntime(runtimeMs: number): string {
  if (!Number.isFinite(runtimeMs) || runtimeMs < 0) return "";
  if (runtimeMs < 1000) return "< 1 s";
  const totalSec = Math.round(runtimeMs / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? `${totalMin} min ${sec} s` : `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${h} h ${String(min).padStart(2, "0")} min` : `${h} h`;
}

/** Estimated cost display: cents-precision for regular runs, tighter for tiny ones
 *  ("0,0042 $" not "0,00 $") so a cheap child never reads as free. Pure. */
export function formatCostUsd(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd < 0) return "";
  const decimals = costUsd > 0 && costUsd < 0.01 ? 4 : 2;
  return `${costUsd.toFixed(decimals).replace(".", ",")} $`;
}

/** The card's KIND label: MoA components are named for what they are —
 *  "Sous-agent" was wrong for them (they are reference/aggregator models of a
 *  Mixture-of-Agents pass, not spawned agents). */
export function subAgentKindLabel(card: Pick<SubAgentCardView, "moaRole">): string {
  if (card.moaRole === "moa_aggregator") return m.subagent_kind_moa_aggregator();
  if (card.moaRole === "moa_reference") return m.subagent_kind_moa_reference();
  return m.subagent_panel_kind();
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

/**
 * True when the child's gateway session no longer exists to talk to: a spawn with
 * `cleanup: "delete"` is ARCHIVED by the gateway right after its announce, so once
 * the child is terminal an interaction send can only fail — the composer disables
 * with an explicit reason instead. A running child is NOT archived yet (its send
 * is gated by the running rule, not this one).
 */
export function isSubAgentSessionArchived(
  card: Pick<SubAgentCardView, "tone" | "sessionMeta"> | undefined,
): boolean {
  return (
    card !== undefined &&
    card.tone !== "running" &&
    card.sessionMeta?.cleanup === "delete"
  );
}

/** Build one card from a row. */
function toCard(row: SubAgentRow): SubAgentCardView {
  const tone = statusTone(row.status);
  const role = row.sessionMeta?.subagentRole;
  return {
    id: row._id,
    childSessionKey: row.childSessionKey,
    ...(role === "moa_reference" || role === "moa_aggregator"
      ? { moaRole: role }
      : {}),
    taskName: row.taskName?.trim() || undefined,
    label: subAgentLabel(row),
    status: row.status,
    tone,
    failure: tone === "failed",
    // phase is only meaningful while running; drop it on a settled card.
    phase: row.status === "running" ? row.phase : undefined,
    errorMessage: row.errorMessage,
    resultText: row.resultText,
    // Name + status only (the row never carries args/results — SOC2).
    tools: row.tools?.map((t) => ({
      name: t.name,
      status: t.status,
      toolCallId: t.toolCallId,
    })),
    sessionMeta: row.sessionMeta,
    telemetry: row.telemetry,
    childAgentId: childAgentIdFromKey(row.childSessionKey),
  };
}

/**
 * Compact progress over a child's tools: total + how many have completed. Pure so
 * the "N tools, M done" summary line is unit-tested without a DOM harness.
 */
export function subAgentToolsProgress(
  tools: ReadonlyArray<{ status: "running" | "done" }> | undefined,
): { total: number; done: number; running: number } {
  const list = tools ?? [];
  const done = list.filter((t) => t.status === "done").length;
  return { total: list.length, done, running: list.length - done };
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
  const cards = sorted.map(toCard).sort((a, b) => {
    // MoA hierarchy: the aggregator leads, its references follow (in their
    // 1..n order — the childSessionKey ends with `ref<i>`), everything else
    // keeps the newest-first order from above (stable sort).
    const rank = (c: SubAgentCardView): number =>
      c.moaRole === "moa_aggregator" ? 0 : c.moaRole === "moa_reference" ? 1 : 2;
    // Group by MoA RUN first (the `hermes-moa:<mid>:` segment) so that even if
    // several runs ever shared one panel, each aggregator keeps ITS references
    // right under it — never interleaved with another run's.
    const runOf = (c: SubAgentCardView): string =>
      c.moaRole ? c.childSessionKey.replace(/:(ref\d+|aggregate)$/, "") : "";
    const runCmp = runOf(a).localeCompare(runOf(b));
    if (a.moaRole && b.moaRole && runCmp !== 0) return runCmp;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) {
      const idx = (c: SubAgentCardView): number => {
        const mref = /ref(\d+)$/.exec(c.childSessionKey);
        return mref?.[1] ? Number.parseInt(mref[1], 10) : 0;
      };
      return idx(a) - idx(b);
    }
    return 0;
  });
  return {
    cards,
    total: cards.length,
    done: cards.filter((c) => c.tone === "done").length,
    running: cards.filter((c) => c.tone === "running").length,
    failed: cards.filter((c) => c.tone === "failed").length,
  };
}

/** One badge in the multi-sub-agent PROGRESS summary header: a tone + its count. */
export type SubAgentProgressBadge = { tone: SubAgentTone; count: number };

/**
 * The progress badges for the summary header shown ABOVE several sub-agent cards
 * (the user's "which already returned / how many still running" ask): one badge
 * per tone that has at least one sub-agent, in a STABLE order (done, running,
 * failed) so the header never reorders as states settle. Returns EMPTY for a
 * single sub-agent — its own card already carries the status, so a summary would
 * be redundant. Pure so the order + the zero-suppression are unit tested.
 */
export function subAgentProgressBadges(
  view: SubAgentActivityView,
): SubAgentProgressBadge[] {
  if (view.total <= 1) return [];
  const counts: Record<SubAgentTone, number> = {
    done: view.done,
    running: view.running,
    failed: view.failed,
  };
  const order: SubAgentTone[] = ["done", "running", "failed"];
  return order
    .filter((tone) => counts[tone] > 0)
    .map((tone) => ({ tone, count: counts[tone] }));
}

/**
 * The sub-agent rows a SINGLE assistant turn spawned, for anchoring the cards
 * UNDER that turn (not in a chat-level pile). Pure ownership join: keep only the
 * rows for ONE assistant turn. PRIMARY join = `parentMessageId === messageId` (the
 * bridge tags every child with its spawning message — robust, no parse). FALLBACK =
 * `childSessionKey ∈ keys` (the keys the turn's `sessions_spawn` output carried),
 * which still covers any row written before parentMessageId tagging. With neither a
 * messageId match nor a key match a turn anchors no card, and the chat-level failure
 * beacon stays the safety net for an elided / out-of-window failure.
 */
export function subAgentRowsForMessage(
  rows: readonly SubAgentRow[],
  keys: readonly string[],
  messageId?: string,
): SubAgentRow[] {
  const owned = new Set(keys);
  return rows.filter(
    (r) =>
      (messageId !== undefined && r.parentMessageId === messageId) ||
      owned.has(r.childSessionKey),
  );
}

/** "N sous-agent(s)" count label (i18n singular/plural; both branches tested). */
export function subAgentCountLabel(total: number): string {
  return total === 1
    ? m.subagents_count({ count: total })
    : m.subagents_count_plural({ count: total });
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
