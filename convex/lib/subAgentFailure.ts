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
  "unknown",
] as const;
export type SubAgentErrorCategory = (typeof SUBAGENT_ERROR_CATEGORIES)[number];

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

// Timeout / stale-observer reaper (subAgents.STALE_SUBAGENT_MESSAGE is FR:
// "Sous-agent expiré — aucune activité …"); also the English equivalents.
const TIMEOUT_RE =
  /expir|p[ée]rim|stale|timed?\s*out|timeout|no\s+activity|aucune\s+activit/i;
// HTTP status (4xx/5xx) or an explicit API/auth/quota signal.
const API_ERROR_RE =
  /\b(4\d{2}|5\d{2})\b|api[\s_-]?error|rate[\s_-]?limit|unauthoriz|forbidden|quota|too\s+many\s+requests/i;
// A tool/command invocation failure.
const TOOL_FAILED_RE =
  /failed\s*\(|\btool\b|web_fetch|web_search|\bexec\b|command|\bmcp\b/i;

/**
 * Classify a sub-agent error into a content-free category. ALWAYS returns one of
 * `SUBAGENT_ERROR_CATEGORIES` — it pattern-matches `errorMessage` but never
 * returns any part of it. An `aborted` status is categorized by status alone (its
 * message, if any, is not consulted — an abort is an abort).
 */
export function classifySubAgentError(
  status: SubAgentStatus,
  errorMessage?: string,
): SubAgentErrorCategory {
  if (status === "aborted") return "aborted";
  const text = (errorMessage ?? "").trim();
  if (text === "") return "unknown";
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
    errorCategories.push(classifySubAgentError(c.status, c.errorMessage));
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
