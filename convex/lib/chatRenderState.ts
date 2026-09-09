// Pure, framework-agnostic chat render-state + PHI-redaction helpers.
//
// SINGLE SOURCE shared by the frontend (src/chat/runStatusView wraps these with
// localized labels) AND the backend (the key-authed GET /api/v1/chat-state
// diagnostic projection). Same idiom as convex/lib/charts.ts (one module both
// sides import) — so the API reproduces the CLIENT'S derived render-state from
// the EXACT same logic: a bug in the derivation appears in both, never drifts.
//
// NO imports here (no paraglide `m`, no convex server) so it is importable from
// either root. The frontend adds i18n labels on top of `runStatusKind`; the
// API never localizes.
//
// SOC2/PHI: the redaction helpers (errorCode/textLenBucket/mimeTypeBase) exist
// so the diagnostic API emits a POSITIVE-allowlist STRUCTURAL projection — the
// client's view minus the words — never raw content. See the regulatory spec in
// docs / memory atrium-soc2-debug-api.

/** The transient run-status kind the client renders (label attached on the FE).
 *  `undefined` status = the assistant-ui optimistic placeholder (thinking). */
export type RunStatusKind = "thinking" | "generating" | "error" | "aborted";

export function runStatusKind(
  status: string | undefined,
  hasText: boolean,
  /** The user STOPPED the conversation while this block's delegated work ran.
   *  The block itself settled normally — it wrote its reply and finished — so
   *  `status` is "complete" and cannot carry the fact. Without this the reader
   *  gets a reply that simply has no sequel, and nothing says the rest was cut
   *  short at their request. */
  interrupted = false,
): RunStatusKind | null {
  if (status === undefined) return "thinking"; // optimistic placeholder
  switch (status) {
    case "streaming":
      return hasText ? "generating" : "thinking";
    case "error":
      return "error";
    case "aborted":
      return "aborted";
    default:
      // A SETTLED block whose work was stopped reads as interrupted. Checked
      // last, so a real terminal state always wins over the marker: an errored
      // turn is an error whether or not a Stop landed on it afterwards.
      return interrupted ? "aborted" : null;
  }
}

/** True if the message has at least one non-empty text content part. */
export function messageHasText(
  content: ReadonlyArray<{ type?: string; text?: unknown }> | undefined,
): boolean {
  if (!content) return false;
  return content.some(
    (p) =>
      p?.type === "text" &&
      typeof p.text === "string" &&
      p.text.trim().length > 0,
  );
}

// --- PHI-redaction helpers (API diagnostic projection) ---------------------

/** Stable error codes the diagnostic API may expose. `messages.error` is a free
 *  string (the bridge can write raw gateway text = PHI risk), so the API maps it
 *  to this allowlist; ANYTHING else collapses to "unknown" (never the raw text).
 *  Keep `stream_orphaned` in sync with stuckStreams.STUCK_STREAM_ERROR_CODE. */
export const KNOWN_ERROR_CODES = [
  "stream_orphaned",
  "gateway_timeout",
  "gateway_error",
  "aborted_by_user",
  // The bridge's infrastructure-end code (a socket drop mid-turn — session
  // close / large-session compaction). Non-PHI by construction; allowlisted so
  // /api/v1/chat-state + the obs MCP report it as a real class, not "unknown".
  "connection_lost",
  // Recv-silence self-heal exhausted: the agent worked past the recovery budget.
  "response_timeout",
  // The gateway ANNOUNCED its restart before closing (`event:"shutdown"`) — a
  // known maintenance window rather than an unexplained drop.
  "gateway_restarting",
  // The bridge's own normalized transient classes — curated codes the finalize path
  // persists as `errorCode` (turnRetry keys its bounded auto-retry on them). They
  // were missing here, so the trace filter dropped them and their lost turns could
  // never raise a named cause (codex P1).
  "provider_internal",
  "session_init_conflict",
  "session_write_conflict",
  "empty_response_silent",
  // The dispatch never reported back and the reconciler settled the row to unlock
  // the conversation. Delivery is UNKNOWN (the bridge can execute a send and lose
  // only its response), which is what its message says.
  "DISPATCH_STALLED",
  // The gateway closed us with `1008 "slow consumer"`: it had been dropping
  // frames before cutting the link, so the reply was provably incomplete.
  "connection_saturated",
  // The gateway's normalized hard failure classes (errorKind, from
  // ChatErrorEventSchema) that the bridge persists as errorCode — allowlisted
  // so the diagnostic surface names them instead of collapsing to "unknown".
  "context_length",
  // The overflow class the bridge mints when the turn's session had JUST been
  // compacted by the pre-send guard: retryable exactly once (turnRetry).
  "context_length_compacted",
  // The pre-send guard WITHHELD the send: measured not to fit, and the mandatory
  // compaction did not shrink it. Nothing ran, nothing was billed.
  "context_length_presend",
  "rate_limit",
  "timeout",
  "refusal",
  // Synthesized by the bridge when a compaction never completes (#40295): a
  // distinct actionable class, not a silent empty turn.
  "compaction_timeout",
  // A turn that ended in ERROR while NOTHING named a cause: no gateway errorKind,
  // no text the classifier recognizes. Allowlisted so the diagnostic surface says
  // "nobody reported a cause" instead of collapsing it to the same `unknown` a
  // missing code produces — the two were indistinguishable, and prod 2026-09-08
  // showed the consequence: an announce turn's failure read as unclassifiable when
  // the truth was that no class had ever been persisted.
  "unclassified_error",
  // The turn finished COMPLETE but delivered nothing usable (no text + no media).
  "empty_response",
  // The reply went out through a message-tool call whose arguments the bridge
  // could not read, and the transcript recovery found nothing: a NAMED cause
  // instead of an unexplained empty turn.
  "msgtool_args_unreadable",
  // The turn ended still waiting for a command approval Atrium cannot grant.
  "awaiting_approval",
  // Dispatch-failure codes (failDispatch stores the CODE, the UI localizes):
  "not_configured",
  "no_agent",
  "agent_restricted",
  "send_failed",
  "ATTACHMENT_TOO_LARGE",
  "ATTACHMENT_REJECTED",
] as const;

export function normalizeMessageErrorCode(
  error: string | null | undefined,
): string | null {
  if (error === null || error === undefined || error === "") return null;
  return (KNOWN_ERROR_CODES as readonly string[]).includes(error)
    ? error
    : "unknown";
}

/** Coarse text-length bucket. An EXACT length leaks fixed-format PHI (SSN, phone,
 *  ICD codes); a bucket keeps the "is there text / roughly how much" signal that
 *  drives rendering (empty body, huge turn) without the precise count. */
export type TextLenBucket = "0" | "1-100" | "101-1k" | "1k+";

export function textLenBucket(len: number): TextLenBucket {
  if (len <= 0) return "0";
  if (len <= 100) return "1-100";
  if (len <= 1000) return "101-1k";
  return "1k+";
}

/** The base media type, stripped of any parameter (e.g. `application/pdf;
 *  name="biopsy.pdf"` -> `application/pdf`) — the `name=` param is a filename
 *  leak masquerading as structure. */
export function mimeTypeBase(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const semi = mime.indexOf(";");
  return (semi === -1 ? mime : mime.slice(0, semi)).trim();
}

/** How many repeated tools to name. A turn that touched more than this many
 *  DIFFERENT tools more than once is not looping on one thing, and the counts
 *  above already say how much it did. */
const MAX_REPEATED_TOOLS = 8;

/** A tool part as the chat-state projection emits it (name + phase only). */
type ProjectedPart = { kind: string; name?: string; phase?: string | null };

/**
 * REPETITION SHAPE of one turn's tool activity, computed over the SOC2 projection
 * of its parts — so it carries nothing the projection does not already carry.
 *
 * It answers "did this turn go round in circles?" WITHOUT deciding it: many calls
 * spread over few distinct tools, the same tool called back to back, or the same
 * tool erroring over and over. What counts as too much belongs to the agent's own
 * instructions, so no threshold and no verdict live here — only the shape.
 *
 * Returns null for a turn that called no tool: an absent aggregate says "no tool
 * activity", where a zero-filled one would read as "tools that did nothing".
 */
export function summarizeToolActivity(parts: readonly ProjectedPart[]): {
  calls: number;
  errors: number;
  distinctTools: number;
  repeatedTools: { name: string; calls: number; errors: number }[];
  repeatedToolsTruncated: boolean;
  longestSameToolRun: { name: string; length: number } | null;
} | null {
  const tools = parts.filter(
    (p): p is ProjectedPart & { name: string } =>
      p.kind === "tool" && typeof p.name === "string",
  );
  if (tools.length === 0) return null;

  const calls = new Map<string, { calls: number; errors: number }>();
  let errors = 0;
  // Longest run of the SAME tool back to back — the most direct loop signal, and
  // the one a per-name count cannot give: 30 calls alternating between two tools
  // and 30 calls of one tool in a row are the same counts and not the same turn.
  let longest: { name: string; length: number } | null = null;
  let runName: string | undefined;
  let runLength = 0;
  for (const tool of tools) {
    const seen = calls.get(tool.name) ?? { calls: 0, errors: 0 };
    seen.calls += 1;
    if (tool.phase === "error") {
      seen.errors += 1;
      errors += 1;
    }
    calls.set(tool.name, seen);
    if (tool.name === runName) {
      runLength += 1;
    } else {
      runName = tool.name;
      runLength = 1;
    }
    if (longest === null || runLength > longest.length) {
      longest = { name: tool.name, length: runLength };
    }
  }

  const repeated = [...calls.entries()]
    .filter(([, v]) => v.calls > 1)
    // Most repeated first; ties by name so the output is stable across reads.
    .sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
    .map(([name, v]) => ({ name, calls: v.calls, errors: v.errors }));

  return {
    calls: tools.length,
    errors,
    distinctTools: calls.size,
    repeatedTools: repeated.slice(0, MAX_REPEATED_TOOLS),
    // Never a silent truncation: the caller is told the list was cut.
    repeatedToolsTruncated: repeated.length > MAX_REPEATED_TOOLS,
    longestSameToolRun: longest,
  };
}
