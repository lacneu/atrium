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
  // The gateway's state database refused the write (SQLite busy/locked, or full,
  // read-only, I/O). Curated CLASS names the bridge classifier mints from the
  // gateway's own sentence — never that sentence itself, so no PHI risk. Without
  // them here the filter above drops the code from the trace, and the two
  // per-cause anomaly classes they exist for are unreachable: the failure counts
  // only in the generic stream-error channel and the diagnostic API says
  // "unknown" (codex, the same hole `provider_internal` was added for).
  // The gateway refused to USE the credential: it had put the auth profile in a
  // cooldown window. Allowlisted for the same reason as the storage classes — without
  // the code on the trace the per-cause anomaly plane cannot count it, and the failure
  // falls back into the generic stream-error channel. That is ALL this list decides —
  // whether a cause that exists is countable. In the reported incident no class reached
  // it at all (the bridge classifier returned null), so the empty bubble was not this
  // list's doing; the entry is here so that, now that the class exists, a repeat is
  // countable instead of anonymous.
  "auth_profile_cooldown",
  "gateway_storage_busy",
  "gateway_storage_unavailable",
  // The bridge's own inbound-staging refusals. Allowlisted for the same reason as
  // the storage classes: without the code on the trace, the per-cause anomaly
  // plane cannot count them and the failure falls back into the generic channel —
  // which is exactly how "every attachment fails" went unnamed for five days.
  "attachment_path_refused",
  "attachment_name_too_long",
  "attachment_staging_failed",
  "attachment_cleanup_unconfirmed",
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

/** Remove the credential id from a gateway failure sentence.
 *
 *  Upstream composes `Auth profile "<id>" …` and lets an operator name a profile
 *  anything: the one that reached a user was an email address. That sentence is stored
 *  on a message, on a sub-agent row, in a scheduled run's history, and served to every
 *  reader of the chat, copied with the bubble and written into an archive export — and
 *  the reader is not necessarily the credential's owner (codex).
 *
 *  THE RULE IS TOTAL, AND DELIBERATELY BLUNT: from the opening quote to the end of the
 *  string, everything goes.
 *
 *  Three cleverer versions were defeated in a row, each by the same thing — the id is
 *  OPERATOR-CONTROLLED, so it can contain whatever the redaction uses as a delimiter.
 *  A closing quote (`"[^"]*"` stopped early), a newline (`.` stopped), a second
 *  sentence (greedy ran to the wrong tail), and finally the tail itself: an id holding
 *  `" is temporarily unavailable` ended the lazy match and left its own suffix
 *  readable. A partial redaction of an attacker-chosen string is not winnable, so this
 *  one does not try.
 *
 *  WHAT IT COSTS, stated rather than discovered later: the provider and the model are
 *  lost from the detail line, and so is the target of the sibling `type mismatch`
 *  sentence. The localized card carries what the reader should do, the session meta
 *  already names the model, and the gateway's own auth-profile store is the operator's
 *  source of truth for which profile is paused and why. That is a smaller loss than a
 *  redaction that can be walked out of.
 *
 *  WHERE IT RUNS: every door that PERSISTS such a sentence — a turn
 *  (`stream.finalize`), a child and its two interaction writers, a settled task
 *  engagement, a fork that copies history, an import that writes rows from a file, and
 *  the two report creators that FREEZE a snapshot of one (`feedback.submitFeedback`,
 *  `subAgentReports.createSubAgentReport`) — plus every READ path, which masks on the
 *  way out for rows the operator-invoked backfill has not reached yet: the chat query,
 *  the sub-agent and interaction listings, both feedback reads, the sub-agent report
 *  read, the two dev probes, the scheduled run history (re-typed from the bridge
 *  rather than stored) and the archive export — and the reader's view, as a belt. Traces never carry the
 *  sentence at all (stream.ts refuses raw text), and anomaly evidence carries a class,
 *  a count and a correlation id.
 *
 *  ROWS WRITTEN BEFORE THIS EXISTED are handled by the one-time migration in
 *  `migrations.maskStoredCredentialIds` (convex/migrations.ts) — masking the readers
 *  instead would
 *  mean finding every query that serves such a row, which is the enumeration this
 *  design exists to avoid. */
/** Where an operator-chosen credential id starts, STRUCTURALLY.
 *
 *  Not a list of openings. Upstream composes about thirty different sentences around a
 *  quoted profile id — `Auth profile "…"`, `Per-entry apiKey "…"`,
 *  `No credentials found for profile "…"`, `MCP server "…" references auth profile
 *  "…"`, and so on — and three passes of this review added one opening at a time while
 *  more remained (codex). What they share is the WORD before the quote: a `profile` or
 *  an `apiKey` followed by a quoted string is that string being named as a credential.
 *  A new sentence upstream is covered the day it appears. */
const CREDENTIAL_SENTENCE_RE = /\b(?:profile|api\s*key)\s+"/i;

/** The text with every OPERATOR-CHOSEN value removed, for code that CLASSIFIES.
 *
 *  The bridge has the same function, and the rule is the same because the hazard is:
 *  a gateway failure sentence interpolates values an operator picked — a profile id, a
 *  provider, a model, an MCP server name, a session key — and any pattern applied to
 *  the raw text lets one of them choose the verdict (codex, five passes running).
 *
 *  Two rules by context. A sentence that NAMES A CREDENTIAL is CUT at its first quote:
 *  no class but the cooldown is legitimate there, so losing the tail costs nothing.
 *  Every other sentence keeps its SHAPE and loses only what is inside each quote,
 *  because real sentences put a value first and their classifying words after it.
 *
 *  Distinct from `maskCredentialId`, which protects the credential in text a READER is
 *  shown; this one protects a DECISION. */
export function withoutOperatorValues(raw: string): string {
  if (CREDENTIAL_SENTENCE_RE.test(raw)) {
    const firstQuote = raw.indexOf('"');
    return firstQuote === -1 ? raw : `${raw.slice(0, firstQuote + 1)}…`;
  }
  let out = raw;
  if (((out.match(/"/g) ?? []).length % 2) === 1) out = out.replace(/"[^"]*$/, '"…');
  return out.replace(/"[^"]*"/g, '"…"');
}

export function maskCredentialId<T extends string | undefined | null>(text: T): T {
  if (typeof text !== "string") return text;
  // THREE PREFIXES, not one. Upstream names the same operator-chosen id in
  // `Auth profile "<id>" …`, `Per-entry apiKey profile "<id>" …` and
  // `Per-entry apiKey "<id>" …` (prepare-auth.ts, model-auth-provider.ts) — and the
  // last two were passing through intact, one of them guaranteed so by a test of mine
  // (codex).
  if (!CREDENTIAL_SENTENCE_RE.test(text)) return text;
  // Cut at the FIRST quote, not at the credential word. `MCP server "<name>"
  // references auth profile "<id>"` puts an operator value BEFORE that word, and
  // cutting there left it stored, served and exported (codex).
  const firstQuote = text.indexOf('"');
  return (firstQuote === -1 ? text : `${text.slice(0, firstQuote + 1)}…`) as T;
}
