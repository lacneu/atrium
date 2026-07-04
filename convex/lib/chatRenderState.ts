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
      return null; // "complete" / unknown -> no chip
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
  // The gateway's normalized hard failure classes (errorKind, from
  // ChatErrorEventSchema) that the bridge persists as errorCode — allowlisted
  // so the diagnostic surface names them instead of collapsing to "unknown".
  "context_length",
  "rate_limit",
  "timeout",
  "refusal",
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
