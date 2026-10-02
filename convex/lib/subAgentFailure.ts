// SOC2 BOUNDARY — the CONTENT-FREE projection of a sub-agent failure for the
// OBSERVABILITY plane (anomaly `evidence` + the MCP `list_anomalies` view).
//
// Two-plane rule (non-negotiable): the plane-1 report record (subAgentReports)
// holds the raw `errorMessage`/`resultText`/`taskName` — owner-scoped, surfaced
// only in the Atrium UI to the owner/admin (the admin read is audited). This
// module is the ONLY thing that feeds the plane-2 anomaly evidence, and it emits
// NOTHING but {status enum, error CATEGORY enum, counts, opaque ids}. Raw error
// text never crosses into the observability plane.
//
// CRITICAL INVARIANT (subAgentFailure.test.ts pins it): no function here ever
// returns a substring of an `errorMessage`/`resultText`/`taskName`.
// `classifySubAgentError` PATTERN-MATCHES the raw text but RETURNS ONLY a fixed
// enum literal — it is a CLASSIFIER, not a display-shortener. Do NOT reach for
// `subAgentActivityView.shortenSubAgentError` here: that helper returns an
// arbitrary line of the raw error (display-injection safety, NOT content-freeness)
// and using it would leak content into the anomaly/MCP plane.

/** The four lifecycle states the bridge writes (mirrors the schema union). */
import { isProviderAuthRevokedFailureText, withoutOperatorValues } from "./chatRenderState";
export type SubAgentStatus = "running" | "done" | "error" | "aborted";

/**
 * Allowlisted, content-free error categories. `unknown` is the fallback. The
 * classifier's output is ALWAYS one of these literals — never raw error text, so
 * it is safe to ship into anomaly evidence / the MCP plane.
 */
export const SUBAGENT_ERROR_CATEGORIES = [
  "tool_failed",
  "timeout",
  "aborted",
  "api_error",
  // The gateway refused the spawn: the child never ran. Decided from the row's
  // stable class, never from text — a refusal's prose can say anything.
  "spawn_refused",
  // The GATEWAY'S host storage refused the child's work (a full disk — including the
  // scratch space it reads its databases through —, a read-only database, an I/O error).
  "gateway_storage_unavailable",
  // The gateway closed the agent's database to new work (OpenClaw 2026.9.5+): the child
  // was refused or retired by the gateway, not failed by its own task.
  "gateway_agent_db_closed",
  // The model provider refused the agent's credential as revoked or expired: the child
  // did not fail its task, its agent cannot reach the model until an operator
  // fixes its credential. Before the text patterns — its `401` would read as `api_error`,
  // and an "expired" token as a `timeout`.
  "provider_auth_revoked",
  // OUR verdict, not the gateway's: a reaper gave up on a child it saw no activity from
  // (Convex's stale-row reaper, 20 min; the bridge's no-frame sweep, 15 min). The child
  // may have run unseen — a frozen bridge, a reconnect — or never started. Decided from
  // the code those reapers store (SUBAGENT_NO_ACTIVITY_CODE), never from their prose,
  // and kept apart from `timeout`, which is a limit the GATEWAY enforced.
  "no_activity",
  "unknown",
] as const;
export type SubAgentErrorCategory = (typeof SUBAGENT_ERROR_CATEGORIES)[number];

/** The stable class Atrium's reapers store on a child they gave up on for want of any
 *  activity (convex/subAgents.ts `reapStaleSubAgents`; the bridge's observer sweep writes
 *  the same value, bridge/src/providers/openclaw/sub-agent-observer.ts). Allowlisted in
 *  KNOWN_ERROR_CODES, like every class a row may carry. */
export const SUBAGENT_NO_ACTIVITY_CODE = "subagent_no_activity";

/** A terminal FAILURE state (error or aborted) — the failures a report captures. */
export function isFailedStatus(status: SubAgentStatus): boolean {
  return status === "error" || status === "aborted";
}

// --- The allowlist classifier ------------------------------------------------
//
// Each pattern maps the raw error to a FIXED enum. Precedence is most-specific
// root cause first (an explicit HTTP status / rate-limit is more actionable than
// a generic "tool failed"). The patterns READ the text; the function RETURNS an
// enum literal only — the text itself is never echoed.

// Timeout. It ALSO matches the reapers' own prose ("Sous-agent expiré — aucune activité …",
// "no activity for 900s"), and that is deliberate: a row reaped before the reapers stored
// SUBAGENT_NO_ACTIVITY_CODE keeps the category it was always published under — nothing
// on it says which of the two it was, and re-deriving one from prose is what the code
// replaces. New rows carry the code, which is read first.
const TIMEOUT_RE =
  /expir|p[ée]rim|stale|timed?\s*out|timeout|no\s+activity|aucune\s+activit/i;
// HTTP status (4xx/5xx) or an explicit API/auth/quota signal.
const API_ERROR_RE =
  /\b(4\d{2}|5\d{2})\b|api[\s_-]?error|rate[\s_-]?limit|unauthoriz|forbidden|quota|too\s+many\s+requests/i;
// A tool/command invocation failure.
const TOOL_FAILED_RE =
  /failed\s*\(|\btool\b|web_fetch|web_search|\bexec\b|command|\bmcp\b/i;
// The two GATEWAY-side refusals, recognized from the text for a row the bridge did not
// class (one written before the class existed: prod 2026-09-28, four children `unknown`).
// A MIRROR of the bridge's rules (bridge/src/core/failure-classifier.ts
// GATEWAY_STORAGE_UNAVAILABLE_RE + GATEWAY_HOST_STORAGE_FULL_RE, AGENT_DATABASE_CLOSED_RE),
// which carry the upstream citations; the two must stay in step. Tested BEFORE the generic
// patterns: the staging sentence says "free disk space/quota", and `quota` alone would call a
// full gateway disk an API error.
const GATEWAY_STORAGE_UNAVAILABLE_TEXT_RE =
  /database or disk is full|attempt to write a readonly database|disk i\/o error|state database was (?:full|read-only)|state database had an i\/o error|\benospc\b|\bedquot\b|no space left on device|disk quota exceeded|could not write local session data because the disk is full|free disk space\/quota or set xdg_cache_home to a writable filesystem/i;
const GATEWAY_AGENT_DB_CLOSED_TEXT_RE =
  /agent database execution admission is closed|sessions remain unavailable|preserve and inspect this database before accepting a fresh agent/i;

/** The row's stable class -> its category, where the class names a gateway-side cause
 *  the text patterns would misread. */
const CATEGORY_BY_CODE: Readonly<Record<string, SubAgentErrorCategory>> = {
  gateway_storage_unavailable: "gateway_storage_unavailable",
  gateway_agent_db_closed: "gateway_agent_db_closed",
  provider_auth_revoked: "provider_auth_revoked",
  [SUBAGENT_NO_ACTIVITY_CODE]: "no_activity",
};

/**
 * Classify a sub-agent error into a content-free category. ALWAYS returns one of
 * `SUBAGENT_ERROR_CATEGORIES` — it pattern-matches `errorMessage` but never
 * returns any part of it. An `aborted` status is categorized by status alone (its
 * message, if any, is not consulted — an abort is an abort).
 */
export function classifySubAgentError(
  status: SubAgentStatus,
  errorMessage?: string,
  /** The row's allowlisted STABLE class (an enum, never text). */
  errorCode?: string,
): SubAgentErrorCategory {
  if (status === "aborted") return "aborted";
  // BEFORE the text patterns: a refused spawn's row used to stay `running` until a
  // watchdog wrote "timed out" over it, and the TIMEOUT pattern then published a
  // delegation that never started as one that ran out of time (prod 2026-09-23).
  if (errorCode === "spawn_refused") return "spawn_refused";
  const byCode = errorCode !== undefined ? CATEGORY_BY_CODE[errorCode] : undefined;
  if (byCode !== undefined) return byCode;
  // Through the CLASSIFICATION normalizer, not the display mask: the mask protects a
  // credential in text a reader is shown, and it left every OTHER quoted value free to
  // pick the category published in the anomaly and the diagnostic (codex).
  const text = withoutOperatorValues((errorMessage ?? "").trim()).trim();
  if (text === "") return "unknown";
  // Storage first, as in the bridge: an admission refusal can carry a full disk as its reason.
  if (GATEWAY_STORAGE_UNAVAILABLE_TEXT_RE.test(text)) return "gateway_storage_unavailable";
  if (GATEWAY_AGENT_DB_CLOSED_TEXT_RE.test(text)) return "gateway_agent_db_closed";
  // The shared mirror of the bridge rule (chatRenderState), on the RAW message: it does its
  // own operator-value stripping, model ids of a fallback summary included.
  if (isProviderAuthRevokedFailureText(errorMessage)) return "provider_auth_revoked";
  if (TIMEOUT_RE.test(text)) return "timeout";
  if (API_ERROR_RE.test(text)) return "api_error";
  if (TOOL_FAILED_RE.test(text)) return "tool_failed";
  return "unknown";
}

/**
 * A short, opaque tail of a `childSessionKey` (`agent:<id>:subagent:<uuid>` → the
 * uuid head). The session key is an OPAQUE correlation id (same id class as
 * chatId/runId, which Atrium already treats as non-PHI in traces) — never user
 * content. Truncated so the evidence stays compact.
 */
export function shortChildId(childSessionKey: string): string {
  const trimmed = childSessionKey.trim();
  if (trimmed === "") return "";
  const segment = trimmed.slice(trimmed.lastIndexOf(":") + 1) || trimmed;
  return segment.length > 12 ? segment.slice(0, 12) : segment;
}

/** The content-free input shape: a structural subset of the `subAgents` doc.
 *  Deliberately does NOT include `taskName`/`resultText` — they are content and
 *  must never reach this module. */
export type SubAgentFailureInput = {
  childSessionKey: string;
  status: SubAgentStatus;
  errorMessage?: string;
  errorCode?: string;
};

/** The content-free structure shipped into anomaly evidence / the MCP plane. */
export type SubAgentFailureStructure = {
  totalCount: number; // children captured in this report's scope
  failedCount: number; // failed (error|aborted) among them
  statuses: SubAgentStatus[]; // per-child lifecycle state (enum)
  errorCategories: SubAgentErrorCategory[]; // per-child category (enum), aligned by index
  childIdShort: string[]; // per-child opaque id tail, aligned by index
};

/**
 * Project a set of captured children into the CONTENT-FREE failure structure.
 * The output carries ONLY enums, counts, and opaque id tails — it is, by
 * construction, free of `errorMessage`/`resultText`/`taskName`. This is the
 * single chokepoint feeding plane-2; keep it the only producer of that payload.
 */
export function toSubAgentFailureStructure(
  children: readonly SubAgentFailureInput[],
): SubAgentFailureStructure {
  const statuses: SubAgentStatus[] = [];
  const errorCategories: SubAgentErrorCategory[] = [];
  const childIdShort: string[] = [];
  let failedCount = 0;
  for (const c of children) {
    statuses.push(c.status);
    errorCategories.push(
      classifySubAgentError(c.status, c.errorMessage, c.errorCode),
    );
    childIdShort.push(shortChildId(c.childSessionKey));
    if (isFailedStatus(c.status)) failedCount += 1;
  }
  return {
    totalCount: children.length,
    failedCount,
    statuses,
    errorCategories,
    childIdShort,
  };
}

/**
 * The AGENT a child session belongs to, read off its key (`agent:<id>:subagent:<uuid>`).
 *
 * A Stop has to reach each child at the bridge serving ITS agent — a child born
 * on another instance is unreachable through the chat's default routing, and the
 * kill would silently land nowhere. The row carries the instance but not the
 * agent, and the key is where the agent is written down.
 *
 * Null for anything not of that shape — a background-task row (`task:<id>`) has
 * no agent of its own and falls back to the chat's routing.
 */
export function agentIdFromChildKey(childSessionKey: string): string | null {
  const parts = childSessionKey.trim().split(":");
  if (parts.length < 4) return null;
  if (parts[0] !== "agent" || parts[2] !== "subagent") return null;
  const agentId = parts[1];
  return agentId === "" ? null : agentId;
}
