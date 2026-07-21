/**
 * Streaming normalizer for OpenClaw Gateway frames (TypeScript port).
 *
 * Faithful port of backend/app/normalizer.py. The OpenClaw Gateway is an
 * event-driven firehose: it can emit empty finals, duplicate finals, private
 * acknowledgements, follow-on runs, auto-compaction replays, legacy 5.7 deltas,
 * 5.19 message snapshots, tool deliveries and media paths -- in any
 * interleaving. This module absorbs all of that and exposes a small, stable,
 * browser-facing event vocabulary so the frontend never has to parse raw
 * OpenClaw frames.
 *
 * Design:
 *   * Pure transducer with an INJECTED clock. feed(frame, now) and tick(now)
 *     return arrays of stable events; nextTimeout(now) tells the receive loop
 *     how long to wait. All timing is expressed as ABSOLUTE deadlines stored on
 *     the instance -- never as silence-reset budgets -- so a private-ack grace
 *     cannot be reset by an unrelated frame, and every behaviour is
 *     deterministic under a mocked clock.
 *   * One per-run text state machine (snapshot vs delta vs ack precedence) that
 *     every scenario routes through.
 *   * Isolation gate (sessionKey + runId refinement) runs before any emission,
 *     so the deprecated openclaw.frame passthrough and the normalized events
 *     share exactly one drop decision.
 *
 * MEDIA ADAPTATION vs Python (intentional): in the Convex architecture the
 * bridge stores media bytes in Convex File Storage, so the normalizer does NOT
 * mint HMAC-signed URLs. It emits media as
 *   { type: "media", items: [{ filename, path }] }
 * where `path` is the outbound absolute server path the bridge fetches later.
 * The outbound-path filtering (reject inbound, "..", scheme/netloc/query,
 * dedupe) is preserved verbatim, and /home/node/.openclaw paths are still
 * stripped from any VISIBLE text via sanitizeText.
 */

import { MediaConfigurationError, sanitizeFrame, sanitizeText } from "./sanitize.js";
import {
  EVENT_OPENCLAW_FRAME,
  EVENT_MESSAGE_DELTA,
  EVENT_MESSAGE_SNAPSHOT,
  EVENT_MESSAGE_FINAL,
  EVENT_RUN_STATUS,
  EVENT_TOOL_STATUS,
  EVENT_MEDIA,
  EVENT_MEDIA_UNDELIVERED,
  EVENT_AGENT_ACTIVITY,
  EVENT_CONTEXT_COMPACTION,
  EVENT_PLAN_ADVANCE,
  type BridgeEvent,
} from "../../core/events.js";
import { isDeliveryRunId } from "../../core/async-task.js";
import {
  isProvenanceStream,
  parseProvenanceReport,
} from "../../core/provenance.js";
import {
  childChatTerminalStatus,
  childLifecycleStatus,
} from "./sub-agent-frames.js";

// The normalized event vocabulary now lives in core/events.ts (the shared
// provider contract). Re-export it from the OpenClaw normalizer so existing
// importers reading it off this module keep working unchanged.
export {
  EVENT_OPENCLAW_FRAME,
  EVENT_MESSAGE_DELTA,
  EVENT_MESSAGE_SNAPSHOT,
  EVENT_MESSAGE_FINAL,
  EVENT_RUN_STATUS,
  EVENT_TOOL_STATUS,
  EVENT_MEDIA,
};
export type { BridgeEvent };

// --- Timing (seconds), absolute deadlines, mirror the OWUI pipe ---------------
// Max gap between own-session frames during an active turn before a recv-timeout
// finalize. Raised 180 -> 240s: a thinking:high turn on a large model with a big
// context legitimately goes silent (no deltas) for minutes while reasoning; 180s
// cut still-working turns into empty bubbles (report ms7b5j…). The 12-min Convex
// stuck-stream watchdog remains the ultimate backstop for a truly hung turn.
export const BASE_RECV_TIMEOUT = 240.0;
export const COMPACTION_RECV_TIMEOUT = 900.0; // widened gap budget while compaction is pending
// Synthetic error class when a compaction never completes within the widened
// budget (#40295 deadlock signature: compaction started, then total silence for
// COMPACTION_RECV_TIMEOUT). Finalizing this as an actionable ERROR beats the
// former silent EMPTY-COMPLETE bubble (the buffer was blanked by
// resetForCompaction) that left the user staring at ~15 min of "thinking".
export const COMPACTION_TIMEOUT_CODE = "compaction_timeout";
const COMPACTION_TIMEOUT_TEXT =
  "The gateway did not finish optimizing (compacting) the session in time.";
export const EMPTY_FINAL_GRACE = 90.0; // wait after an empty chat:final for real content
export const PRIVATE_ACK_GRACE = 5.0; // wait after a private-ack final for the visible message
export const LIFECYCLE_END_GRACE = 10.0; // wait after lifecycle:end for a follow-on run

// Channels/providers that mean "deliver into the current chat" (vs an external
// target like Telegram). A message-tool send to one of these is the visible
// reply; anything with an explicit external target is not.
const CURRENT_CHAT_CHANNELS = new Set([
  "chat",
  "current",
  "atrium",
  "webchat",
  "owui",
  "openwebui",
  "direct",
]);
const EXTERNAL_TARGET_KEYS = ["target", "targets", "to", "accountId", "chatId"] as const;
const VISIBLE_TEXT_KEYS = ["message", "caption", "text", "body", "content", "markdown"] as const;

// A private acknowledgement is a short "sent." style confirmation OpenClaw
// emits as its own final text while the user-visible reply is delivered
// separately. It must never be persisted as the assistant answer.
//
// Mirror of the Python regex (re.IGNORECASE):
//   ^\s*(?:envoy[éè]+|message\s+envoy[éè]+|réponse\s+envoy[éè]+|done|ok|fait)
//   (?:\s+dans\s+le\s+(?:canal|webchat)[^.\n]*)?[\s.!…]*$
// JS \s matches Unicode whitespace by default; `i` and `u` flags applied.
// ChatErrorEventSchema.errorKind enum (gateway-protocol logs-chat.ts), minus
// "unknown" (nothing actionable to classify). Only these values may persist as
// the message's stable errorCode.
// Known gateway overflow phrasings (live capture: "Context overflow: prompt
// too large for the model. Try /reset (or /new) ...").
// Every context-overflow phrasing a supported gateway can surface as BARE TEXT
// (real 2026.6.11 never populates errorKind — live-verified). Covers the
// OpenClaw-documented provider patterns (docs/concepts/compaction:
// request_too_large, "context length exceeded", "input exceeds the maximum
// number of tokens", "input token count exceeds the maximum number of input
// tokens", "input is too long for the model", "ollama error: context length
// exceeded") PLUS Atrium's own UI phrasings, so a hard overflow ALWAYS
// classifies to context_length and shows the actionable card — never a generic
// error (report 2026-07: 4 of 6 documented phrasings were previously missed).
const CONTEXT_OVERFLOW_TEXT_RE =
  /context overflow|prompt too large|maximum context length|context[- ]length exceeded|request_too_large|request too large|input (?:token count )?exceeds the maximum number of (?:input )?tokens|input is too long for the model|too many tokens|reduce the length|exceeds? (?:the )?(?:model'?s )?(?:maximum )?context/i;

// The gateway's per-session OCC guard: commitReplySessionInitialization retries a
// stale snapshot ONCE, then throws this exact message when a concurrent writer
// (e.g. the previous turn's post-run memory flush churning the session entry)
// keeps invalidating the init snapshot (gateway get-reply, verified 2026.6.11;
// live incident 2026-07-09). Upstream treats it as TRANSIENT: the Telegram
// channel spool-retries on this same message with exponential backoff
// (polling-session.ts REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE). Classifying it to
// a stable code lets Convex auto-retry the turn (turnRetry.ts) and the UI show
// an honest "transient, retrying" card instead of a generic error.
const SESSION_INIT_CONFLICT_RE = /reply session initialization conflicted/i;
// Same transient-session-conflict family, embedded/PI runtime flavor: the
// gateway's per-session prompt lock detects a concurrent writer ("session file
// changed while embedded prompt lock was released") — observed live when a
// queued follow-up dispatches right as the previous run releases. A re-run
// succeeds; classify it to the SAME stable code so Convex's bounded auto-retry
// (zero-content turns only) absorbs it instead of surfacing a raw error card.
const EMBEDDED_LOCK_CONFLICT_RE =
  /session file changed while embedded prompt lock/i;

// TRANSIENT provider-internal failure (upstream 5xx / overload / malformed
// stream / network cut): the classes where an automatic re-dispatch is what
// the user would do by hand.
//
// COST/SIDE-EFFECT ARBITRATION for the NETWORK markers (codex P1, decided by
// the user 2026-07-20 — the "VPN flip" resilience he explicitly wants, same
// as Claude Code's own visible retries): a connection cut AFTER the provider
// accepted the call can mask a billed completion whose response never
// arrived. Re-dispatching then re-bills at most ONE completion — exactly the
// user's manual re-send. It can NEVER duplicate side effects: gateway tools
// only execute from RECEIVED responses, and any received tool/media/text
// leaves parts or text that the zero-content gates catch (the retry stands
// down). Bounded 2 attempts; classification stays marker-strict — live prod 2026-07-20 (fabien): OpenAI internal error killed a
// zero-content turn, the manual re-send succeeded. Classification is by
// TRANSIENT MARKER, never by envelope ("All models failed (…)" wraps the
// per-model causes — only their content proves transience), against the
// gateway's own vendored error surface (dist assistant-error-format, read
// 2026-07-20):
//   "The AI service returned an (internal) error. Please try again (in a moment)."
//   "The AI service is temporarily overloaded/unavailable (HTTP 5xx). …"
//   "The provider returned an HTML error page … (e.g. Cloudflare) blocked …"
//   "LLM streaming response contained a malformed fragment. Please try again."
//   raw OpenAI generic: "An error occurred while processing your request"
//   bare transport statuses: HTTP 5xx / 5xx status words.
const PROVIDER_INTERNAL_TEXT_RE =
  /the ai service returned an (?:internal )?error|the ai service is temporarily (?:overloaded|unavailable)|returned an html error page|malformed_streaming_fragment|malformed fragment|an error occurred while processing your request|http\s*5\d\d\b|\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)|internal server error|\bupstream (?:error|connect)|server_error|overloaded_error|fetch failed|socket hang ?up|network error|econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|und_err|terminated unexpectedly/i;
// NEVER-transient guards, checked FIRST: an auth/entitlement/config failure
// matching a loose 5xx-ish marker must not auto-retry (a wrong key retried is
// wasted quota and a misleading label; a refusal must stay a refusal). The
// rate-limit family is also excluded — its correct handling is a LONGER
// backoff than the 5/15s retry curve, and real gateways classify it upstream.
const PROVIDER_INTERNAL_EXCLUDE_RE =
  /rate[- ]?limit|too many requests|http\s*4\d\d\b|unauthorized|forbidden|invalid[_ ](?:api[_ ]?key|request|model)|api[_ ]?key|authentication|billing|quota|insufficient|not[_ ]found|unsupported|refus|content[_ ]policy|context overflow|prompt too large/i;

// Terminal stopReason values we persist into the (metadata-only) pressure
// trace. The schema types stopReason as a FREE string — anything outside this
// allowlist buckets to "other" so a raw network string never reaches traces
// (SOC2; codex P2). Values: live captures ("stop" = natural end, "rpc" = the
// user Stop via chat.abort) + the schema-adjacent classic finish reasons.
const KNOWN_STOP_REASONS = new Set([
  "stop",
  "rpc",
  "length",
  "tool_use",
  "aborted",
  "error",
  "timeout",
  "content_filter",
]);
const bucketStopReason = (v: string): string =>
  KNOWN_STOP_REASONS.has(v) ? v : "other";

const CHAT_ERROR_KINDS = new Set([
  "refusal",
  "timeout",
  "rate_limit",
  "context_length",
]);

const PRIVATE_ACK_RE =
  /^\s*(?:envoy[éè]+|message\s+envoy[éè]+|r[éè]ponse\s+envoy[éè]+|done|ok|fait)(?:\s+dans\s+le\s+(?:canal|webchat)[^.\n]*)?[\s.!…]*$/iu;

// --- Event & frame typing ----------------------------------------------------
// (BridgeEvent is imported from core/events.ts and re-exported above.)

type Json = unknown;
type JsonObject = Record<string, Json>;

function isObject(v: Json): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: Json): v is string {
  return typeof v === "string";
}

// --- Pure helpers (ports of the module-level Python functions) ---------------

/** Extract human-visible text from a string or a list of content parts. */
function textFromContent(content: Json): string {
  if (isString(content)) {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (isString(part)) {
        parts.push(part);
      } else if (isObject(part) && isString(part.text)) {
        parts.push(part.text);
      }
    }
    return parts.filter((p) => p).join("\n");
  }
  return "";
}

/** Extract visible text from a chat `message` snapshot (content or text). */
function textFromMessage(message: Json): string {
  if (!isObject(message)) {
    return "";
  }
  const text = textFromContent(message.content);
  if (text) {
    return text;
  }
  return textFromContent(message.text);
}

/** True for a safe OpenClaw outbound media path (no scheme/traversal). */
function isOutboundMediaPath(path: Json): path is string {
  if (!isString(path) || path === "") {
    return false;
  }
  if (!path.startsWith("/")) {
    return false;
  }
  if (!path.includes("/media/outbound/")) {
    return false;
  }
  if (path.includes("..")) {
    return false;
  }
  // urlsplit() in Python rejects scheme/netloc/query. For an absolute fs path
  // those map to: any "://" (scheme+netloc) or any "?" (query). A leading "/"
  // path has no scheme/netloc, but reject defensively to match Python exactly.
  if (path.includes("?")) {
    return false; // query component
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
    return false; // scheme present
  }
  return true;
}

// Global scanner for an outbound media path EMBEDDED anywhere inside a (possibly
// multi-line) string -- e.g. exec stdout or a bare path surfaced in a tool
// result. The tail stops at whitespace, backtick, quote, paren or angle bracket
// (mirrors sanitize.ts OUTBOUND_PATH_RE), so a path inside prose or a shell
// transcript is extracted without trailing junk. Each hit is re-validated
// through isOutboundMediaPath, so the "..", inbound, scheme and query filters
// still apply -- this widens DISCOVERY only, never the safety gate.
const EMBEDDED_OUTBOUND_RE =
  /\/home\/node\/\.openclaw\/media\/outbound\/[^\s`)>"']+/g;

// A whole-line MEDIA: delivery directive (the convention the bridge injects via
// the [LIVRAISON] block). Mirrors sanitize.ts MEDIA_DIRECTIVE_RE so DISCOVERY and
// visible-text STRIPPING agree on the same path. CRUCIAL: the convention defines
// the ENTIRE rest of the line as the path, so a filename WITH SPACES ("IFOA
// Presentation.pdf") is captured intact -- the bare-token scan above would
// truncate it at the first space (the reported gateway-http delivery bug: the
// visible text was stripped correctly but the file the bridge then tried to
// fetch was the truncated ".../IFOA", which does not exist -> no media part).
const MEDIA_DIRECTIVE_LINE_RE =
  /^MEDIA:(\/home\/node\/\.openclaw\/media\/outbound\/.+)$/;

/**
 * Every outbound media path embedded in a string (may be empty). Scanned
 * line-by-line so a MEDIA: directive line yields its WHOLE rest-of-line path
 * (spaces included) while every other line falls back to the conservative
 * bare-token scan. A directive line is NOT also bare-scanned, so a spaced name
 * never produces a truncated duplicate alongside the full path.
 *
 * Each hit is tagged with its DELIVERY INTENT: a MEDIA: directive is the agent
 * explicitly delivering the file (always honored — re-sending an old file on
 * request is legitimate); a path merely EMBEDDED in prose (exec stdout, a memory
 * note the agent read) is an incidental MENTION — the consumer freshness-gates
 * it so last week's files never re-attach to today's turn (the exports bug).
 */
function extractOutboundPaths(
  text: string,
): Array<{ path: string; explicit: boolean }> {
  const out: Array<{ path: string; explicit: boolean }> = [];
  for (const line of text.split(/\r\n|[\n\r\v\f]/)) {
    const directive = MEDIA_DIRECTIVE_LINE_RE.exec(line);
    if (directive) {
      // trimEnd: the gateway file has no trailing whitespace, and a trailing
      // space would make the fetch path not-found.
      out.push({ path: directive[1]!.trimEnd(), explicit: true });
      continue;
    }
    for (const match of line.matchAll(EMBEDDED_OUTBOUND_RE)) {
      out.push({ path: match[0], explicit: false });
    }
  }
  return out;
}

function isPrivateAck(text: string): boolean {
  if (!text) {
    return false;
  }
  return PRIVATE_ACK_RE.test(text.trim());
}

/**
 * Content fingerprint of a message snapshot. The Python version uses a SHA-256
 * hex digest of the visible text; here we use the visible text itself, which is
 * an equally valid (collision-free) fingerprint for dedup-key equality and
 * avoids pulling in a hash dependency. Equal text -> equal fingerprint; the
 * private-ack -> visible transition has DIFFERENT text and so is not deduped,
 * exactly as in Python.
 */
function contentFingerprint(message: Json): string {
  const text = textFromMessage(message);
  if (!text) {
    return "";
  }
  return text;
}

/** Collect every string found anywhere inside a nested structure. */
function flattenStrings(value: Json): string[] {
  const out: string[] = [];
  if (isString(value)) {
    out.push(value);
  } else if (isObject(value)) {
    for (const item of Object.values(value)) {
      out.push(...flattenStrings(item));
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      out.push(...flattenStrings(item));
    }
  }
  return out;
}

// OpenClaw flags a SUCCESSFUL `sessions_spawn` result with isError:true (the child IS
// created — its childSessionKey sits inside the result payload — yet the tool is marked
// errored). Treat a spawn whose result carries a childSessionKey as SUCCESS so the tool
// card doesn't falsely read "error" (mirrors the sub-agent observer's extractChildSession
// Key: childSessionKey presence — not isError — is the real success signal).
function spawnResultAccepted(name: unknown, result: unknown): boolean {
  if (name !== "sessions_spawn") return false;
  return flattenStrings(result as Json).some((s) =>
    s.includes("childSessionKey"),
  );
}

function extractLifecycleError(error: Json): string {
  if (isString(error) && error.trim()) {
    return error.trim();
  }
  if (isObject(error)) {
    for (const key of ["message", "error", "detail", "reason", "code"]) {
      const value = error[key];
      if (isString(value) && value.trim()) {
        return value.trim();
      }
    }
  }
  return "OpenClaw stopped the run";
}

function posixBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

// --- The transducer ----------------------------------------------------------

export class Normalizer {
  readonly sessionKey: string;

  // Session-level run tracking.
  ownRunIds: Set<string>;
  turnActive: boolean;
  finalized: boolean;
  compactionPending: boolean;
  currentRunId: string | null;

  // Per-turn visible-text state.
  text: string;
  hasSnapshot: boolean;
  hasVisibleToolText: boolean;
  pendingAckText: string;
  // path -> the intent it was EMITTED with (true = explicit). A Map (not a list)
  // so a LATER explicit sighting of a mention-only path re-emits as an upgrade —
  // the deliberate "re-send an old file via MEDIA:" case survives a stale-dropped
  // earlier mention (the sink dedupes actual double-attaches).
  mediaPaths: Map<string, boolean>;
  lastDedupKey: string | null;
  // 6.5 webchat sink: the gateway runs the message-tool itself and only emits a
  // bare `stream:"item"` frame (no args, no result) — the delivered text lives
  // ONLY in the session transcript. When such an item was seen AND the turn is
  // holding a private-ack/empty-final grace, the session loop recovers the text
  // via `sessions.get` (history recovery, deferred since 5.19) exactly once.
  sawMessageToolItem: boolean;
  // The agent ran NATIVE media generation this turn (a codex `imageGeneration`
  // item). It carries no path/url/bytes — if the turn then delivers no media
  // (no MEDIA:/mediaUrls), finalize emits a diagnostic so the gap is visible.
  sawMediaGeneration: boolean;
  // Child session keys observed THIS turn (spawnedBy admission): the parent may
  // legitimately end SILENT while children work — its real reply arrives later
  // as an announce/spontaneous turn. A SET (not a boolean) so the sink can
  // intersect with the keys the turn's OWN sessions_spawn calls returned —
  // a stale child from a PREVIOUS turn never exempts the current one.
  observedChildKeys: Set<string>;
  // --- Gateway COMPACTION detection (pinned on live capture 2026-07-03) ------
  // A PREFLIGHT compaction (before the model call) leaves NO trace in the frame
  // stream: no phase, no notice — the ONLY observable signal is the session id
  // ROTATION (truncateAfterCompaction rotates the transcript; the checkpoint's
  // pre/postCompaction sessionIds confirm it). `expectedSessionId` is seeded per
  // turn from the pre-send `sessions.describe`; the first own frame carrying a
  // DIFFERENT id ⇒ the gateway compacted before answering. A MID-TURN compaction
  // already surfaces as livenessState "abandoned" (resetForCompaction) — it emits
  // its own signal and SUPPRESSES the follow-up rotation (same compaction, not two).
  private expectedSessionId: string | null = null;
  private suppressNextRotation = false;
  private compactionSignaled = false;
  // EXPLICIT gateway compaction signals ({stream:"compaction"} agent events,
  // upstream embedded-agent-subscribe.handlers.compaction.ts, v2026.7.1): the
  // authoritative mid-turn signal. "active" between phase:start and phase:end,
  // "ended" once an end was seen this turn. When present it is PREFERRED over
  // the livenessState:"abandoned" heuristic — upstream, "abandoned" is ANY
  // replayInvalid terminal without visible text (e.g. an interrupted tool
  // chain), NOT compaction. The heuristic stays as the multi-version fallback
  // (2026.5.19+ gateways emit no compaction stream; Hermes never does).
  private explicitCompaction: "none" | "active" | "ended" = "none";
  private recoveryAttempted = false;
  // Diagnostic captures for the per-turn pressure trace (never classification):
  // the terminal frame's optional stopReason, and the REAL post-turn usage the
  // gateway flattens onto agent events on live deployments (dev 2026-07-04).
  private diagStopReason: string | null = null;
  // WHY the current turn finalized (set by finalize()); shipped in the pressure
  // trace so the exact close path is unambiguous on the next live repro.
  private finalizeCause: string | null = null;
  // Set when a PURE recv-silence deadline elapsed on a live turn (no finalize):
  // the session consumes it to trigger an active gateway status query instead of
  // closing the turn. One-shot per elapse (the recv wait is cleared).
  private recvSilence = false;
  private diagUsage: {
    totalTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
  } | null = null;
  // Buffered tool args by toolCallId: a real tool's start(args) + result(result)
  // coalesce into ONE `completed` tool.status carrying input+output, so the UI
  // shows a single clean card per tool instead of a start card + a result card.
  private readonly toolArgs = new Map<string, unknown>();

  // Absolute deadlines: name -> time. "recv" is the silence budget; the others
  // are wall-clock graces armed from a specific event.
  private deadlines: Map<string, number>;

  constructor(sessionKey: string) {
    this.sessionKey = sessionKey;
    this.ownRunIds = new Set();
    this.turnActive = false;
    this.finalized = true; // no turn in progress until beginTurn
    this.compactionPending = false;
    this.currentRunId = null;
    this.text = "";
    this.hasSnapshot = false;
    this.hasVisibleToolText = false;
    this.pendingAckText = "";
    this.mediaPaths = new Map();
    this.lastDedupKey = null;
    this.sawMessageToolItem = false;
    this.sawMediaGeneration = false;
    this.observedChildKeys = new Set();
    this.deadlines = new Map();
  }

  // -- turn lifecycle (called from the browser->gateway task) ---------------

  /** Reset per-turn state when the user sends a message (before chat.send). */
  beginTurn(now: number): void {
    // Per-turn diagnostics reset (codex P2: without this, a turn without
    // stopReason/usage frames would inherit the PREVIOUS turn's values in its
    // pressure trace).
    this.diagStopReason = null;
    this.finalizeCause = null;
    this.recvSilence = false;
    this.diagUsage = null;
    this.turnActive = true;
    this.finalized = false;
    this.compactionPending = false;
    this.currentRunId = null;
    this.text = "";
    this.hasSnapshot = false;
    this.hasVisibleToolText = false;
    this.pendingAckText = "";
    this.mediaPaths = new Map();
    this.lastDedupKey = null;
    this.sawMessageToolItem = false;
    this.sawMediaGeneration = false;
    this.observedChildKeys = new Set();
    this.recoveryAttempted = false;
    this.suppressNextRotation = false;
    this.compactionSignaled = false;
    this.explicitCompaction = "none";
    this.toolArgs.clear();
    // A fresh turn invalidates the previous run ids: frames arriving before the
    // new ack are admitted on sessionKey alone (ownRunIds empty), then the ack
    // seeds the new run id for foreign-run filtering.
    this.ownRunIds = new Set();
    this.deadlines = new Map();
    this.armRecv(now);
  }

  /**
   * Seed the session id the pre-send `sessions.describe` reported, per turn.
   * Rotation detection compares own frames against it (see the field comment).
   * `null` (no describe / no session yet) ⇒ adopt the first id seen silently —
   * a brand-new session must never read as "compacted".
   */
  noteExpectedSessionId(sessionId: string | null): void {
    this.expectedSessionId = sessionId;
  }

  /** Seed ownRunIds from the chat.send ack so foreign runs are filtered. */
  noteRunStarted(runId: string | null | undefined, now: number): void {
    if (isString(runId) && runId) {
      this.ownRunIds.add(runId);
      if (this.currentRunId === null) {
        this.currentRunId = runId;
      }
    }
    this.armRecv(now);
  }

  /** TRUE when the recv deadline is currently armed — i.e. an OWN frame arrived
   *  since the last silence elapse (armRecv re-arms on every own frame). The
   *  silence-recovery poll uses it to self-cancel when the live stream RESUMES. */
  get recvDeadlineArmed(): boolean {
    return this.deadlines.has("recv");
  }

  /** Consume the pure-recv-silence signal (returns true once per elapse). The
   *  session reacts by querying the gateway, NOT by closing the turn. */
  takeRecvSilence(): boolean {
    if (!this.recvSilence) return false;
    this.recvSilence = false;
    return true;
  }

  /** Finalize the active turn explicitly (e.g. on chat.abort or a send error). */
  endTurn(
    now: number,
    status = "final",
    error: string | null = null,
    cause = "external",
  ): BridgeEvent[] {
    return this.finalize(now, status, error, null, cause);
  }

  /** Finalize the active turn as failed after a per-message upstream error. */
  failTurn(now: number, message: string): BridgeEvent[] {
    return this.finalize(now, "error", message, null, "upstream_error");
  }

  // -- receive-loop timing --------------------------------------------------

  /** Seconds until the nearest deadline, or null when idle (wait forever). */
  nextTimeout(now: number): number | null {
    if (this.deadlines.size === 0) {
      return null;
    }
    const nearest = Math.min(...this.deadlines.values());
    return Math.max(0.0, nearest - now);
  }

  /** Resolve expired deadlines. Guarantees an armed wait always finalizes. */
  tick(now: number): BridgeEvent[] {
    if (this.finalized) {
      this.deadlines = new Map();
      return [];
    }
    const expired = new Set<string>();
    for (const [name, dl] of this.deadlines) {
      if (dl <= now) {
        expired.add(name);
      }
    }
    if (expired.size === 0) {
      return [];
    }
    const events: BridgeEvent[] = [];
    if (expired.has("private_ack")) {
      // Grace elapsed with no visible follow-on. The chat.history fallback is
      // deferred; degrade gracefully to best-effort content (never hang).
      this.clearWait("private_ack");
      if (!this.text && this.pendingAckText) {
        this.text = this.pendingAckText;
      }
      events.push(...this.finalize(now, "final", null, null, "private_ack_grace"));
    } else if (expired.has("empty_final") || expired.has("lifecycle_end") || expired.has("recv")) {
      if (this.compactionPending && expired.has("recv")) {
        // #40295 DEADLOCK: a compaction started, then the gateway went silent for
        // the FULL widened budget. Settle an actionable error (not an empty
        // COMPLETE bubble) so the user knows to reset/retry rather than wait.
        events.push(
          ...this.finalize(
            now,
            "error",
            COMPACTION_TIMEOUT_TEXT,
            COMPACTION_TIMEOUT_CODE,
            "compaction_timeout",
          ),
        );
      } else if (
        expired.has("recv") &&
        !expired.has("lifecycle_end") &&
        !expired.has("empty_final")
      ) {
        // PURE silence gap on a still-live turn (NOT a gateway-signaled grace
        // end). The gateway is reasoning silently (confirmed live: a thinking
        // turn stays silent for minutes while tick/health frames prove the
        // socket alive; report ms7b5j finalizeCause=recv_timeout). Do NOT
        // self-close — clear the recv wait and SIGNAL the session to QUERY the
        // gateway for the real run status (self-heal), keeping the turn open so
        // the late result is never discarded. The session's transcript poll (or
        // the live socket, whichever delivers first) finalizes it; the recovery
        // deadline + the Convex watchdog bound a genuine hang.
        this.clearWait("recv");
        this.recvSilence = true;
      } else {
        // A lifecycle_end / empty_final GRACE elapsed = the gateway signaled the
        // turn's end; that IS a terminal, so finalize (not a silence auto-close).
        const cause = expired.has("lifecycle_end")
          ? "lifecycle_end_timeout"
          : "empty_final_timeout";
        events.push(...this.finalize(now, "final", null, null, cause));
      }
    }
    return events;
  }

  // -- main transducer ------------------------------------------------------

  /** Transduce one raw gateway frame into stable bridge events. */
  feed(frame: Json, now: number): BridgeEvent[] {
    if (!isObject(frame)) {
      return [];
    }
    if (frame.type === "res") {
      // Request/response frames are matched by the connection's request();
      // the ack runId is seeded via noteRunStarted, not forwarded here.
      return [];
    }
    const eventType = frame.event;
    if (eventType !== "agent" && eventType !== "chat") {
      // Anything that is not a session content stream is unattributable and is
      // never forwarded to the browser (isolation requirement).
      return [];
    }
    const payload = frame.payload;
    if (!isObject(payload)) {
      return [];
    }

    // --- SUB-AGENT observation gate (admitted BEFORE the isolation drop) ----
    // A child run spawned by THIS chat's agent (`sessions_spawn`) emits on its OWN session
    // `agent:<id>:subagent:<uuid>`, but every child frame carries `spawnedBy` = the PARENT
    // sessionKey. Admit it for OBSERVATION ONLY when spawnedBy matches THIS session —
    // contamination-proof, because the parent sessionKey embeds the chatId (a child of any
    // other chat carries a different spawnedBy, so it is dropped by the isolation gate below).
    // CRITICAL: route to handleSubAgent and RETURN here, never falling through to the run-state
    // tracking — the child owns its OWN runId; admitting it into ownRunIds/currentRunId would
    // corrupt the PARENT turn's finalization. The child's text NEVER becomes parent reply text.
    if (
      isString(payload.spawnedBy) &&
      payload.spawnedBy === this.sessionKey &&
      payload.sessionKey !== this.sessionKey
    ) {
      if (isString(payload.sessionKey)) {
        this.observedChildKeys.add(payload.sessionKey);
      }
      return this.handleSubAgent(
        eventType,
        payload,
        isObject(payload.data) ? payload.data : {},
      );
    }

    // --- isolation gate (one decision for passthrough + normalized) -------
    if (payload.sessionKey !== this.sessionKey) {
      return []; // foreign session OR sessionless -> drop
    }
    const frameRunId = payload.runId;
    if (isString(frameRunId) && frameRunId && this.ownRunIds.size > 0 && !this.ownRunIds.has(frameRunId)) {
      // Same session, different run. Admit it only while a lifecycle-end or
      // compaction grace is open (a legitimate follow-on / replay run);
      // otherwise it is a background run and must not become the answer.
      if (this.deadlines.has("lifecycle_end") || this.compactionPending) {
        this.ownRunIds.add(frameRunId);
      } else {
        return [];
      }
    }
    if (isString(frameRunId) && frameRunId) {
      this.currentRunId = frameRunId;
    }

    // Own frame: refresh the silence budget and emit the deprecated passthrough
    // first, then the normalized interpretation.
    this.armRecv(now);
    const events: BridgeEvent[] = [
      { type: EVENT_OPENCLAW_FRAME, frame: this.safeSanitizeFrame(frame) },
    ];
    // Compaction-by-rotation: an own frame carrying a session id that differs
    // from the pre-send describe means the gateway compacted (and rotated the
    // transcript) before/while answering. Adopt-silently cases: no expectation
    // seeded (fresh session), or a mid-turn compaction already signaled this
    // rotation (suppressNextRotation). One signal per turn.
    const frameSessionId = payload.sessionId;
    if (isString(frameSessionId) && frameSessionId) {
      if (this.expectedSessionId === null || this.suppressNextRotation) {
        this.expectedSessionId = frameSessionId;
        this.suppressNextRotation = false;
      } else if (frameSessionId !== this.expectedSessionId) {
        this.expectedSessionId = frameSessionId;
        if (!this.compactionSignaled) {
          this.compactionSignaled = true;
          events.push({ type: EVENT_CONTEXT_COMPACTION, phase: "preflight" });
        }
      }
    }
    const data = isObject(payload.data) ? payload.data : {};
    if (eventType === "chat") {
      this.handleChat(payload, data, now, events);
    } else {
      this.handleAgent(payload, data, now, events);
    }
    return events;
  }

  // -- chat (5.19 official path) -------------------------------------------

  /**
   * OBSERVATION-ONLY handling of a CHILD sub-agent frame (admitted by `spawnedBy` in feed()).
   * Emits a STRUCTURAL `agent.activity` signal — the child session key, a STATUS
   * (running/done/error/aborted), a lifecycle phase, the child's FINAL result text, and (on
   * failure) the error message — and NOTHING ELSE: never a `message.*` (so the parent reply is
   * untouched), and it never reads/mutates `this.ownRunIds`/`this.currentRunId` (the child owns
   * its runId). Status mapping is the SHARED classifier (sub-agent-frames.ts), so this live
   * per-turn signal and the persisted store status can never diverge. Intermediate child
   * streams (assistant deltas + plugin provenance, which carries the child's RETRIEVED content —
   * SOC2) are deliberately NOT surfaced for the MVP.
   */
  private handleSubAgent(
    eventType: string,
    payload: JsonObject,
    data: JsonObject,
  ): BridgeEvent[] {
    // FULLY ISOLATED from the parent's state machine: never touches this.ownRunIds/currentRunId
    // NOR the parent's recv silence timer. `spawnedBy` is CHAT-level (not run-level), so a
    // sub-agent from a PRIOR turn can still emit during a later turn; re-arming the parent recv
    // on it would push the WRONG turn's timeout (codex P2). The turn-correlated keep-alive
    // (admit only the CURRENT turn's children, learned from the `sessions_spawn` tool result's
    // childSessionKey) is consumer-half work; until then a long sub-agent under a silent parent
    // is covered by the stuck-stream watchdog. KNOWN MVP limitation.
    const childSessionKey = isString(payload.sessionKey) ? payload.sessionKey : "";
    if (!childSessionKey) return [];
    // The child's TERMINAL chat frame is the PRIMARY discriminator: final=done (the answer),
    // error=failed/timed-out (+ a top-level `errorMessage`), aborted=stopped. Reuse the parent's
    // `textFromMessage` + `safeSanitizeText` (a child final/error can carry `MEDIA:` lines /
    // server paths the normalizer strips from every other emitted text — SOC2). A non-terminal
    // chat frame (delta) is intentionally not surfaced (the child is already running).
    if (eventType === "chat") {
      const term = childChatTerminalStatus(payload.state);
      if (term === null) return [];
      const event: BridgeEvent = {
        type: EVENT_AGENT_ACTIVITY,
        childSessionKey,
        status: term,
        done: true,
      };
      if (term === "done") {
        event.text = this.safeSanitizeText(textFromMessage(payload.message));
      } else {
        // error/aborted: capture the failure reason (top-level errorMessage when present,
        // else the "Error: <msg>" message text). Never gate on the string (mode-dependent).
        const reason = isString(payload.errorMessage)
          ? payload.errorMessage
          : textFromMessage(payload.message);
        event.errorMessage = this.safeSanitizeText(reason);
      }
      return [event];
    }
    // A real lifecycle phase only — gate on the lifecycle STREAM, because tool/item child
    // frames ALSO carry a `data.phase` (start/result/completed) that would otherwise surface
    // as a bogus lifecycle signal (codex P3). Maps end=done / error=failed / else=running.
    if (
      eventType === "agent" &&
      isString(payload.stream) &&
      payload.stream.endsWith("lifecycle") &&
      isString(data.phase)
    ) {
      const ls = childLifecycleStatus(data.phase);
      if (ls === null) return [];
      const event: BridgeEvent = {
        type: EVENT_AGENT_ACTIVITY,
        childSessionKey,
        status: ls,
        phase: data.phase,
      };
      if (ls !== "running") event.done = true;
      if (ls === "error") {
        event.errorMessage = this.safeSanitizeText(isString(data.error) ? data.error : "");
      }
      return [event];
    }
    return [];
  }

  private handleChat(payload: JsonObject, _data: JsonObject, now: number, events: BridgeEvent[]): void {
    const state = payload.state;
    const isFinal = state === "final";
    const message = payload.message;
    const deltaText = payload.deltaText;
    // Dedup key includes the message-content fingerprint: an exact re-broadcast
    // (same runId/seq/state/deltaText/content) is dropped, but a same-runId/seq
    // final with DIFFERENT content (private-ack -> visible) is NOT, so the real
    // answer is never swallowed.
    const dedupKey = JSON.stringify([
      "chat",
      payload.runId ?? null,
      payload.seq ?? null,
      state ?? null,
      isString(deltaText) ? deltaText : null,
      contentFingerprint(message),
    ]);
    if (dedupKey === this.lastDedupKey) {
      return; // exact re-broadcast: passthrough only, no normalized dup
    }
    this.lastDedupKey = dedupKey;

    // TERMINAL error/abort on the MAIN chat stream (ChatErrorEventSchema /
    // ChatAbortedEventSchema). Previously unhandled: the turn hung until the
    // 180s recv timeout and the failure class was lost. `errorKind`
    // (refusal|timeout|rate_limit|context_length|unknown) classifies it —
    // `context_length` = a HARD un-recovered overflow (distinct from the
    // silently-handled compaction this normalizer detects via session-id
    // rotation). The message text here is an error description, never the
    // reply — do NOT let it fall through to applyVisible.
    if (state === "error" || state === "aborted") {
      if (state === "aborted") {
        // HEURISTIC path only: an abort while the abandoned-derived compaction
        // is pending is the gateway abandoning the run to compact (it resumes
        // after the replay) — terminalizing it here froze real turns as
        // "Interrompu" (live report 2026-07-04). Let the widened compaction
        // grace keep the turn open instead. Its stopReason belongs to the
        // ABANDONED attempt — never captured (codex P2: it would pollute the
        // successful replay's trace).
        // EXPLICIT path: that rationale does NOT transfer. Upstream (v2026.7.1)
        // never aborts a run to compact mid-turn — overflow PAUSES the run (no
        // abort), threshold runs between requests, and manual aborts BEFORE
        // any compaction event is emitted. A chat:aborted while an explicit
        // compaction is active OR its overflow replay is still pending content
        // is therefore a REAL abort (user Stop / operator / timeout):
        // swallowing it would hold the turn on "compacting" until the 900s
        // compaction_timeout backstop. Terminalize it normally.
        if (this.compactionPending && this.explicitCompaction === "none") {
          return;
        }
      }
      if (isString(payload.stopReason)) {
        this.diagStopReason = bucketStopReason(payload.stopReason);
      }
      if (state === "aborted") {
        // A chat:aborted terminalizes as aborted ("Interrompu"). We do NOT try to
        // reclassify it by stopReason: the field is optional in the protocol
        // schema, and the user Stop (chat.abort RPC) is a chat:aborted on the
        // SAME socket (verified live) — keying "Interrompu" off a stopReason
        // value would risk showing a real Stop as a connection error (codex P2).
        // The DISTINCT gateway-side infrastructure end — a socket DROP mid-turn
        // (e.g. a large-session self-compact recreating the session) — is caught
        // unambiguously by the session close path (connection_lost), which never
        // fires for a user Stop (that keeps the socket open).
        events.push(...this.finalize(now, "aborted", null, null, "gateway_abort"));
        return;
      }
      const reason = isString(payload.errorMessage)
        ? payload.errorMessage
        : textFromMessage(message);
      // A chat:error arriving AFTER the run finished generating is a
      // POST-reply failure (observed live 2026-07-04: 78 tool calls, full
      // answer streamed, run ended, then the gateway's post-turn compaction
      // timed out and emitted a context overflow on the same run). The Control
      // UI shows the answer + a separate warning banner; painting the
      // DELIVERED answer as a failed turn misled the user. Discriminator
      // (codex P1, structural not temporal): real visible content AND the
      // lifecycle-end grace is armed — the run's generation had ENDED and we
      // were only waiting for a possible follow-on. A mid-generation or
      // mid-tool failure (no lifecycle end yet) keeps the honest error card —
      // a truncated reply is never silently marked complete. The error CLASS
      // still reaches the diagnostic trace via diagnosticErrorKind (a
      // trace-only channel — never the message's errorCode, which would paint
      // an error card on a successful reply).
      if (this.hasRealContent() && this.deadlines.has("lifecycle_end")) {
        const diagKind =
          isString(payload.errorKind) && CHAT_ERROR_KINDS.has(payload.errorKind)
            ? payload.errorKind
            : CONTEXT_OVERFLOW_TEXT_RE.test(reason ?? "")
              ? "context_length"
              : SESSION_INIT_CONFLICT_RE.test(reason ?? "") ||
                  EMBEDDED_LOCK_CONFLICT_RE.test(reason ?? "")
                ? "session_init_conflict"
                : null;
        console.log(
          "[normalizer] chat:error AFTER the run ended — finalizing complete (post-reply gateway failure, see gateway_pressure trace)",
        );
        const evs = this.finalize(now, "complete", null, null, "gateway_terminal");
        for (const e of evs) {
          if (e.type === "message.final") {
            (e as { diagnosticErrorKind?: string | null }).diagnosticErrorKind =
              diagKind;
          }
        }
        events.push(...evs);
        return;
      }
      // ALLOWLIST the wire value against the schema enum before persisting it
      // as a trusted stable code (never a raw network string as errorCode).
      const kind =
        isString(payload.errorKind) &&
        CHAT_ERROR_KINDS.has(payload.errorKind)
          ? payload.errorKind
          : null;
      events.push(
        ...this.finalize(
          now,
          "error",
          this.safeSanitizeText(reason) || "gateway error",
          kind,
          "gateway_error",
        ),
      );
      return;
    }

    if (isFinal && isString(payload.stopReason)) {
      this.diagStopReason = bucketStopReason(payload.stopReason);
    }
    const snapshotText = textFromMessage(message);
    if (snapshotText) {
      this.applyVisible(snapshotText, true, isFinal, now, events);
      return;
    }
    if (isString(deltaText) && deltaText) {
      // ChatDeltaEventSchema.replace: a non-prefix replacement delta must
      // REPLACE the accumulated text (appending corrupts the reply) — via the
      // snapshot path so the UI resyncs — but WITHOUT flipping the snapshot
      // precedence: a mid-stream refresh is followed by MORE deltas, which a
      // locked hasSnapshot would silently drop (stream stuck to timeout).
      if (payload.replace === true) {
        this.applyVisible(deltaText, true, isFinal, now, events);
        this.hasSnapshot = false; // stay in delta mode; the stream continues
        return;
      }
      this.applyVisible(deltaText, false, isFinal, now, events);
      return;
    }
    // No usable text. A final with no deliverable is an empty final: wait for
    // follow-on content instead of ending the turn blank.
    if (isFinal && !this.finalized) {
      if (this.hasRealContent()) {
        events.push(...this.finalize(now, "final", null, null, "gateway_final"));
      } else {
        this.arm("empty_final", now + EMPTY_FINAL_GRACE);
      }
    }
  }

  // -- agent (5.7 legacy + tool/lifecycle streams) --------------------------

  private handleAgent(payload: JsonObject, data: JsonObject, now: number, events: BridgeEvent[]): void {
    // Defensive usage sniff: live gateways flatten session metadata onto agent
    // events (dev 2026-07-04: inputTokens/outputTokens/totalTokens/
    // estimatedCostUsd x248). Latest-wins per turn; absent fields stay null —
    // a gateway that never stamps them (local bench) costs nothing here.
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    if (
      num(payload.totalTokens) !== null ||
      num(payload.estimatedCostUsd) !== null
    ) {
      this.diagUsage = {
        totalTokens: num(payload.totalTokens),
        inputTokens: num(payload.inputTokens),
        outputTokens: num(payload.outputTokens),
        estimatedCostUsd: num(payload.estimatedCostUsd),
      };
    }
    const stream = payload.stream;
    // Codex NATIVE media generation (e.g. an `imageGeneration` item, stream
    // "codex_app_server.item") is a lifecycle marker with NO path/url/bytes — there
    // is no handle for the bridge to fetch. Flag it (keyed on data.type, robust to
    // the stream label) so finalize can surface a diagnostic when the turn delivers
    // no media (the agent omitted the MEDIA:/mediaUrls delivery directive).
    if (data.type === "imageGeneration" && data.phase === "completed") {
      this.sawMediaGeneration = true;
      return;
    }
    if (stream === "assistant") {
      const mediaUrls = data.mediaUrls;
      if (Array.isArray(mediaUrls)) {
        this.collectMedia(mediaUrls, events);
      }
      const text = data.text;
      const delta = data.delta;
      if (isString(text) && text) {
        // Full snapshot: replace and lock out later deltas/acks.
        this.applyVisible(text, true, false, now, events);
      } else if (isString(delta) && delta) {
        // Legacy 5.7 incremental: append verbatim (spaces are load-bearing).
        this.applyVisible(delta, false, false, now, events);
      }
      return;
    }
    if (stream === "compaction") {
      this.handleCompaction(data, now, events);
      return;
    }
    if (stream === "tool") {
      this.handleTool(payload, data, now, events);
      return;
    }
    if (stream === "lifecycle") {
      this.handleLifecycle(payload, data, now, events);
      return;
    }
    if (stream === "item") {
      // 6.5 (bench-verified): the gateway-run message-tool surfaces ONLY as an
      // item frame {itemId, phase, kind:"tool", name:"message", title, status} —
      // no args, no result. The delivered text lives in the session transcript
      // alone. Flag it so the session loop can run the history recovery once
      // the turn ends up holding a bare ack (wantsHistoryRecovery below).
      if (data.kind === "tool" && data.name === "message") {
        this.sawMessageToolItem = true;
        return;
      }
      // DELIVERY runs (sub-agent announce / task delivery) carry NO `tool`
      // stream frames — item frames are the only tool telemetry on the wire
      // (measured live, 2026.7.1 bench capture 2026-07-14). Derive the tool
      // card from the item's terminal frame (name + outcome; args/result do
      // not exist on these runs) so the turn's work is user-visible: the
      // deferred announce open then triggers and merges into the anchored
      // bubble instead of the whole tool-only turn being discarded as silent.
      // Ordinary runs keep their exact tool-frame pipeline — never both.
      if (
        (data.kind === "tool" || data.kind === "command") &&
        isString(data.name) &&
        data.name !== "" &&
        isDeliveryRunId(this.currentRunId) &&
        data.phase === "end"
      ) {
        const itemStatus = isString(data.status) ? data.status : null;
        events.push({
          type: EVENT_TOOL_STATUS,
          name: data.name,
          phase: itemStatus === "completed" ? "completed" : "error",
          runId: this.currentRunId,
        });
        // update_plan: the plan CONTENT never reaches a delivery run's wire
        // (the item meta only names the plan's first step) — emit the bare
        // "plan moved" signal; the sink counts them and Convex advances the
        // last known plan at turn end.
        if (data.name === "update_plan" && itemStatus === "completed") {
          events.push({
            type: EVENT_PLAN_ADVANCE,
            runId: this.currentRunId,
          });
        }
      }
      return;
    }
    if (isProvenanceStream(stream)) {
      // Provenance contract (atrium docs/PROVENANCE_CONTRACT.md):
      // a context-injecting plugin reports what it fed the LLM on
      // `<pluginId>.provenance` (gateway-scoped stream, emitter identity
      // stamped into data). Valid reports become kind:"provenance" parts on
      // this turn's message; anything off-contract drops HERE — bounded,
      // never able to break a turn.
      const part = parseProvenanceReport(data);
      if (part !== null) {
        events.push({ type: "provenance", part });
      }
    }
  }

  // -- history recovery (the webchat sink for gateway-delivered replies) -----

  /**
   * True when the turn most likely delivered its real reply through the
   * gateway message-tool and is now holding a grace period with nothing but a
   * private ack (or an empty final): the session loop should fetch the session
   * transcript and feed the delivered text back via `recoverVisibleText`.
   * One-shot per turn (`markRecoveryAttempted`).
   */
  get wantsHistoryRecovery(): boolean {
    return (
      !this.finalized &&
      this.sawMessageToolItem &&
      !this.recoveryAttempted &&
      !this.hasRealContent() &&
      (this.deadlines.has("private_ack") || this.deadlines.has("empty_final"))
    );
  }

  /** Mark the (single) recovery attempt as started so the loop never re-fires. */
  markRecoveryAttempted(): void {
    this.recoveryAttempted = true;
  }

  /**
   * Apply transcript-recovered visible text as the authoritative answer and
   * close the turn (the chat final that armed the grace has already passed).
   * No-op once finalized (the grace may have flushed the ack meanwhile).
   */
  recoverVisibleText(text: string, now: number): BridgeEvent[] {
    if (this.finalized || !text) {
      return [];
    }
    const events: BridgeEvent[] = [];
    this.hasVisibleToolText = true;
    this.applyVisible(text, true, true, now, events);
    return events;
  }

  private handleTool(_payload: JsonObject, data: JsonObject, now: number, events: BridgeEvent[]): void {
    const name = data.name;
    const phase = data.phase;
    const toolCallId = isString(data.toolCallId) ? data.toolCallId : undefined;

    if (name === "message") {
      // The message-tool is the VISIBLE-reply mechanism, not a UI tool card:
      // emit on every phase (unchanged) and extract the visible text on start.
      events.push({
        type: EVENT_TOOL_STATUS,
        name,
        phase: phase ?? null,
        runId: this.currentRunId,
      });
      if (phase === "start") {
        const visible = this.messageToolText(data.args);
        if (visible) {
          this.hasVisibleToolText = true;
          this.applyVisible(visible, true, false, now, events);
        }
      }
    } else {
      // Real tools (web_search, web_fetch, …): the start(args) and the
      // result(result) share the provider toolCallId, which is Convex's addPart
      // UPSERT key — so emitting the start yields a LIVE "running" card that the
      // completed then patches in place (still one card per tool; the historical
      // coalescing survives as the defensive path when the frame carries no id).
      // The start also anchors the card's textOffset at its true position in
      // the narrative flow (the completed would anchor too late).
      if (phase === "start") {
        if (toolCallId) {
          this.toolArgs.set(toolCallId, data.args);
          events.push({
            type: EVENT_TOOL_STATUS,
            name: name ?? null,
            phase: "start",
            toolCallId,
            input: data.args ?? undefined,
            runId: this.currentRunId,
          });
        }
        // No toolCallId: keep the coalesced single-card behavior (no orphan).
      } else {
        const input =
          toolCallId && this.toolArgs.has(toolCallId)
            ? this.toolArgs.get(toolCallId)
            : data.args;
        if (toolCallId) this.toolArgs.delete(toolCallId);
        // OpenClaw flags a SUCCESSFUL `sessions_spawn` result with isError:true (the
        // child IS created — its childSessionKey is in the result — yet the tool is
        // marked errored). Treat a spawn whose result carries a childSessionKey as
        // SUCCESS so the card doesn't falsely read "error" (mirrors the observer's
        // extractChildSessionKey: childSessionKey presence is the real success signal).
        const errored =
          data.isError === true && !spawnResultAccepted(name, data.result);
        events.push({
          type: EVENT_TOOL_STATUS,
          name: name ?? null,
          phase: errored ? "error" : "completed",
          ...(toolCallId ? { toolCallId } : {}),
          input: input ?? undefined,
          output: data.result ?? undefined,
          runId: this.currentRunId,
        });
      }
    }

    // Outbound media discovery from the tool RESULT. The result may be a bare
    // string (exec stdout), or an object/array carrying stdout; flattenStrings
    // yields every string either way. A file an agent produces via `exec` (e.g.
    // the write-md-file skill) surfaces its path ONLY here -- as a
    // "MEDIA:/home/node/.openclaw/media/outbound/<f>" line embedded in stdout --
    // never as a `mediaUrls` array or in the visible reply. collectMedia scans
    // each string for embedded outbound paths, so this is the load-bearing hook
    // that makes exec-produced attachments reach the webchat.
    const result = data.result;
    if (result !== undefined && result !== null) {
      this.collectMedia(flattenStrings(result), events);
    }
  }

  // -- explicit gateway compaction stream ({stream:"compaction"}) ------------

  /**
   * EXPLICIT compaction agent events (v2026.7.1
   * embedded-agent-subscribe.handlers.compaction.ts): {phase:"start"} then
   * {phase:"end", willRetry, completed}. The mid-turn OVERFLOW compaction
   * emits NO lifecycle end at all — the run pauses and continues on the SAME
   * runId — so the accumulated text stays valid and is NEVER reset here
   * (unlike the abandoned-replay heuristic, whose restart invalidates it;
   * pinned by the upstream fixture scenario compaction-explicit-stream-signals).
   * `willRetry:true` = the failed LLM request is being replayed inside the
   * same run (the Control UI's "retrying" state): keep the widened silence
   * budget until content resumes (applyVisible clears it — there is no
   * lifecycle start on this path). One persisted marker per turn
   * (compactionSignaled guard, shared with the heuristic and the rotation
   * detector).
   */
  private handleCompaction(data: JsonObject, now: number, events: BridgeEvent[]): void {
    if (this.finalized) {
      // Between-turns (threshold) compaction: nothing to guard here — the next
      // turn's preflight rotation detector reports it on its own message.
      return;
    }
    const phase = data.phase;
    if (phase === "start") {
      this.explicitCompaction = "active";
      this.compactionPending = true; // widened recv budget while the gateway summarizes
      this.armRecv(now);
      events.push({ type: EVENT_RUN_STATUS, status: "compacting", runId: this.currentRunId });
      if (!this.compactionSignaled) {
        this.compactionSignaled = true;
        events.push({ type: EVENT_CONTEXT_COMPACTION, phase: "midturn" });
      }
      // A session-id rotation following this compaction (truncateAfterCompaction)
      // is THIS same compaction — never a second signal.
      this.suppressNextRotation = true;
      return;
    }
    if (phase === "end") {
      this.explicitCompaction = "ended";
      if (data.willRetry === true) {
        // Overflow replay in flight on the same run: stay in the widened
        // budget; resumed content restores the normal one.
        this.armRecv(now);
      } else {
        // Compaction settled with no replay (threshold/manual): the run
        // resumes its normal cadence.
        this.compactionPending = false;
        this.armRecv(now);
      }
    }
  }

  private handleLifecycle(_payload: JsonObject, data: JsonObject, now: number, events: BridgeEvent[]): void {
    const phase = data.phase;
    if (phase === "error") {
      const message = extractLifecycleError(data.error);
      // A lifecycle error MAY carry a structured errorKind (like chat:error);
      // read it so an overflow whose only signal is the CODE (not the text) still
      // classifies to context_length — extractLifecycleError only sees text, and
      // a bare "context_length" code never matches the phrasing regex. Fall back
      // to the text regex inside finalize when no structured kind is present.
      const errObj =
        data.error && typeof data.error === "object" && !Array.isArray(data.error)
          ? (data.error as JsonObject)
          : null;
      const rawKind = errObj?.errorKind ?? data.errorKind;
      const kind =
        isString(rawKind) && CHAT_ERROR_KINDS.has(rawKind) ? rawKind : null;
      events.push(
        ...this.finalize(now, "error", message, kind, "gateway_error"),
      );
      return;
    }
    if (phase === "end") {
      // livenessState == "abandoned" is the multi-version compaction FALLBACK
      // heuristic (2026.5.19+ gateways emit no explicit signal). A plain
      // replayInvalid with livenessState == "working" is a normal terminal end
      // (cache invalidated, no restart) and must NOT reset buffers.
      if (data.livenessState === "abandoned") {
        // The EXPLICIT {stream:"compaction"} signal, when present this turn,
        // is preferred over the heuristic: upstream (v2026.7.1) "abandoned"
        // means ANY replayInvalid terminal without visible text — NOT
        // compaction — and the true mid-turn compaction emits no lifecycle
        // end at all.
        if (this.explicitCompaction === "active") {
          // Mid-compaction lifecycle end: the compaction machinery governs.
          // The widened wait is already armed; the compaction end (or resumed
          // content) resolves the turn — never a buffer reset on a signal
          // upstream does not tie to compaction.
          return;
        }
        if (this.explicitCompaction === "ended") {
          // This gateway proved it emits explicit compaction signals, and no
          // compaction is active: this abandoned end is a plain terminal
          // (e.g. an interrupted tool chain). Normal end handling — a short
          // follow-on grace, no reset, no 900s compaction wait.
          this.arm("lifecycle_end", now + LIFECYCLE_END_GRACE);
          events.push({ type: EVENT_RUN_STATUS, status: "working", runId: this.currentRunId });
          return;
        }
        this.resetForCompaction(now);
        // The abandoned run's deltas/snapshot are ALREADY persisted in Convex;
        // resetForCompaction only clears the normalizer's internal buffers. Emit
        // an empty snapshot so the sink CLEARS that stale liveText too — otherwise
        // a replay that yields no new text would let stream.finalize fall back to
        // the invalidated prefix. The replay refills it when real text resumes.
        events.push({ type: EVENT_MESSAGE_SNAPSHOT, text: "" });
        events.push({ type: EVENT_RUN_STATUS, status: "compacting", runId: this.currentRunId });
        // Signal the compaction itself (persisted marker), and suppress the
        // follow-up session-id rotation — the replay's rotated id is THIS same
        // compaction, not a second one.
        if (!this.compactionSignaled) {
          this.compactionSignaled = true;
          events.push({ type: EVENT_CONTEXT_COMPACTION, phase: "midturn" });
        }
        this.suppressNextRotation = true;
      } else {
        // Not necessarily turn-final: a follow-on run may continue. Arm a short
        // grace; if nothing follows, tick() finalizes.
        this.arm("lifecycle_end", now + LIFECYCLE_END_GRACE);
        events.push({ type: EVENT_RUN_STATUS, status: "working", runId: this.currentRunId });
      }
      return;
    }
    if (phase === "start") {
      if (this.compactionPending) {
        this.compactionPending = false;
        this.armRecv(now);
      }
      this.clearWait("lifecycle_end");
      events.push({ type: EVENT_RUN_STATUS, status: "running", runId: this.currentRunId });
    }
  }

  // -- visible-text state machine ------------------------------------------

  private applyVisible(
    candidate: string,
    isSnapshot: boolean,
    isFinal: boolean,
    now: number,
    events: BridgeEvent[],
  ): void {
    if (this.finalized) {
      return;
    }
    if (isSnapshot && isPrivateAck(candidate)) {
      // A private acknowledgement must never be persisted as the answer.
      if (this.hasRealContent()) {
        // We already have the real reply; ignore the ack but still close the
        // turn if this was the terminal final.
        if (isFinal) {
          events.push(...this.finalize(now, "final", null, null, "lifecycle_final"));
        }
        return;
      }
      // Hold the ack and wait briefly for the visible message.
      this.pendingAckText = candidate;
      this.arm("private_ack", now + PRIVATE_ACK_GRACE);
      return;
    }
    let emitted: string;
    let eventType: string;
    if (isSnapshot) {
      this.hasSnapshot = true;
      this.text = candidate;
      emitted = candidate;
      eventType = EVENT_MESSAGE_SNAPSHOT;
    } else {
      if (this.hasSnapshot) {
        return; // an authoritative snapshot already won; ignore deltas
      }
      this.text += candidate;
      emitted = candidate;
      eventType = EVENT_MESSAGE_DELTA;
    }
    this.pendingAckText = "";
    this.clearWait("empty_final");
    this.clearWait("private_ack");
    if (this.compactionPending) {
      // Real content resumed ⇒ the compaction (incl. an overflow replay on the
      // same run, which has no lifecycle start to clear this) is over: restore
      // the normal silence budget.
      this.compactionPending = false;
      this.armRecv(now);
    }
    events.push({ type: eventType, text: this.safeSanitizeText(emitted) });
    // A MEDIA: directive (or a bare outbound path) in the VISIBLE reply is a real
    // attachment — emit a media event so it renders as a downloadable part. We
    // scan the RAW `candidate` (the directive is dropped from the sanitized text).
    // collectMedia dedups by path, so this is harmless when the same path also
    // surfaced from a tool result.
    this.collectMedia([candidate], events);
    if (isFinal) {
      events.push(...this.finalize(now, "final", null, null, "gateway_final"));
    }
  }

  // -- media ----------------------------------------------------------------

  /**
   * Filter media candidates to safe outbound paths and emit a media event.
   *
   * ADAPTATION: emits { filename, path } items (no signed URL). `path` is the
   * outbound absolute server path; the bridge fetches the bytes later and
   * stores them in Convex File Storage. Same filtering as Python: reject
   * non-outbound / inbound / "..", scheme/netloc/query; dedupe within a turn.
   */
  private collectMedia(candidates: Json, events: BridgeEvent[]): void {
    if (!Array.isArray(candidates)) {
      return;
    }
    const items: Array<{ filename: string; path: string; explicit: boolean }> =
      [];
    // Validate + dedupe a single resolved path. An EXPLICIT sighting UPGRADES an
    // earlier mention-only one — including one emitted by a PREVIOUS collectMedia
    // call (the deliberate "re-send an old file via MEDIA:" case: the earlier
    // mention may have been stale-dropped by the fetcher, so the explicit
    // delivery must RE-EMIT; the sink dedupes an actual double-attach). Never
    // downgrades: an explicit path re-mentioned later stays deduped.
    const consider = (path: string, explicit: boolean): void => {
      if (!isOutboundMediaPath(path)) return;
      const prior = this.mediaPaths.get(path);
      if (prior !== undefined) {
        if (!explicit || prior) return; // same-or-weaker sighting -> deduped
        this.mediaPaths.set(path, true);
        const inCall = items.find((i) => i.path === path);
        if (inCall) {
          inCall.explicit = true; // upgrade within this call's batch
        } else {
          // Upgrade across calls: re-emit as explicit.
          items.push({ filename: posixBasename(path), path, explicit: true });
        }
        return;
      }
      this.mediaPaths.set(path, explicit);
      items.push({ filename: posixBasename(path), path, explicit });
    };
    for (const candidate of candidates) {
      if (!isString(candidate)) {
        continue;
      }
      if (isOutboundMediaPath(candidate)) {
        // A bare path candidate (a structured `mediaUrls` entry / a tool-result
        // field that IS the path) — a deliberate delivery signal, not prose.
        consider(candidate, true);
      } else {
        // Paths inside free text (exec stdout / memory notes / MEDIA: lines):
        // each hit carries its own intent tag; `consider` re-validates.
        for (const hit of extractOutboundPaths(candidate)) {
          consider(hit.path, hit.explicit);
        }
      }
    }
    if (items.length > 0) {
      events.push({ type: EVENT_MEDIA, items, runId: this.currentRunId });
    }
  }

  private messageToolText(argsIn: Json): string {
    let args: Json = argsIn;
    if (isString(args)) {
      try {
        args = JSON.parse(args);
      } catch {
        return "";
      }
    }
    if (!isObject(args)) {
      return "";
    }
    const action = args.action;
    if (action !== "send" && action !== "thread-reply" && action !== undefined && action !== null) {
      return "";
    }
    for (const key of EXTERNAL_TARGET_KEYS) {
      if (args[key]) {
        return ""; // explicit external destination -> not the current reply
      }
    }
    for (const key of ["channel", "provider"]) {
      const value = args[key];
      if (value && !CURRENT_CHAT_CHANNELS.has(String(value).toLowerCase())) {
        return "";
      }
    }
    for (const key of VISIBLE_TEXT_KEYS) {
      const text = textFromContent(args[key]);
      if (text) {
        return text;
      }
    }
    return "";
  }

  // -- finalization & deadlines --------------------------------------------

  private finalize(
    now: number,
    status = "final",
    error: string | null = null,
    errorKind: string | null = null,
    // WHY the turn closed — diagnosis only (rides the pressure trace). Lets an
    // AUTO-close on a silence deadline (recv/empty_final/lifecycle_end) be told
    // apart from a real gateway terminal, WITHOUT assuming the mechanism.
    cause: string | null = null,
  ): BridgeEvent[] {
    if (this.finalized) {
      return [];
    }
    this.finalizeCause = cause;
    this.finalized = true;
    this.turnActive = false;
    this.compactionPending = false;
    this.deadlines = new Map();
    const text = this.text || this.pendingAckText;
    const finalEvent: BridgeEvent = {
      type: EVENT_MESSAGE_FINAL,
      text: this.safeSanitizeText(text),
      diagnosticStopReason: this.diagStopReason,
      diagnosticUsage: this.diagUsage,
      diagnosticFinalizeCause: this.finalizeCause,
      // Native media generation with NO delivery directive (no MEDIA:/outbound):
      // the sink's empty-result guard needs this AT finalize time (the separate
      // EVENT_MEDIA_UNDELIVERED below is pushed AFTER run.status, too late).
      mediaGeneratedUndelivered:
        this.sawMediaGeneration && this.mediaPaths.size === 0,
      observedChildKeys: [...this.observedChildKeys],
    };
    const statusEvent: BridgeEvent = {
      type: EVENT_RUN_STATUS,
      status: error ? "error" : status,
      runId: this.currentRunId,
    };
    if (error) {
      finalEvent.error = error;
      statusEvent.message = error;
    }
    if (!errorKind && error) {
      // FALLBACK classification: real 2026.6.11 gateways do not populate
      // errorKind (live-verified — like `usage`), so a hard overflow arrived
      // as bare text. Pin the known overflow phrasings to context_length so
      // the actionable headline + pressure-trace marker still fire. Same for
      // the session-init OCC conflict — the stable code Convex's bounded
      // auto-retry keys on (only ever fired for a ZERO-content turn there).
      errorKind = CONTEXT_OVERFLOW_TEXT_RE.test(error)
        ? "context_length"
        : SESSION_INIT_CONFLICT_RE.test(error) ||
            EMBEDDED_LOCK_CONFLICT_RE.test(error)
          ? "session_init_conflict"
          : PROVIDER_INTERNAL_TEXT_RE.test(error) &&
              !PROVIDER_INTERNAL_EXCLUDE_RE.test(error)
            ? "provider_internal"
            : null;
    }
    if (
      error !== null &&
      EMBEDDED_LOCK_CONFLICT_RE.test(error) &&
      this.hasRealContent()
    ) {
      // The EMBEDDED-LOCK flavor ONLY (structural discriminant, codex P1).
      // What licenses the downgrade is the hasRealContent() gate, NOT a
      // post-generation guarantee: upstream (v2026.7.1) throws this at the
      // canonical post-stream reacquire, but ALSO mid-turn on transcript
      // writes between steps of a multi-tool turn (withSessionWriteLock) —
      // possibly with truncated streamed text. Either way, once content has
      // streamed, upstream itself refuses any retry (the announce path's
      // "send evidence" criterion — a retry could only duplicate the
      // delivery), so content-present + this error ⇒ close COMPLETE (live
      // prod 2026-07-21: an announce delivery streamed its full report, then
      // the follow-up turn tripped the lock — the complete reply wore an
      // error badge; see docs/design/upstream-interpretation-comparison.md
      // §3). The class survives on the trace-only channel. The INIT flavor
      // ("reply session initialization conflicted") is thrown PRE-generation
      // — with content it keeps the honest error card (the content cannot be
      // this turn's), and with zero content the bounded auto-retry handles
      // it (unchanged).
      console.log(
        "[normalizer] session-conflict at finalize with streamed content — closing complete (persistence conflict, see gateway_pressure trace)",
      );
      statusEvent.status = "complete";
      delete statusEvent.message;
      delete finalEvent.error;
      (finalEvent as { diagnosticErrorKind?: string | null }).diagnosticErrorKind =
        "session_init_conflict";
      error = null;
      errorKind = null;
    }
    if (errorKind) {
      // The gateway's normalized failure class (ChatErrorEventSchema.errorKind:
      // refusal|timeout|rate_limit|context_length|unknown). Rides message.final
      // so the sink can persist it as the message's stable errorCode —
      // `context_length` is the hard-overflow signal the context-overflow
      // observability chain keys on.
      finalEvent.errorKind = errorKind;
    }
    const result: BridgeEvent[] = [finalEvent, statusEvent];
    // The agent ran native media generation this turn but delivered NO media
    // (no MEDIA:/mediaUrls/outbound path) -> emit a content-free diagnostic so the
    // gap (agent omitted the delivery directive) is visible to the #7 loop.
    if (this.sawMediaGeneration && this.mediaPaths.size === 0) {
      result.push({ type: EVENT_MEDIA_UNDELIVERED, runId: this.currentRunId });
    }
    return result;
  }

  private resetForCompaction(now: number): void {
    // The abandoned run's terminal diagnostics must not leak onto the replay
    // (codex P2): its stopReason/usage belong to the aborted attempt.
    this.diagStopReason = null;
    this.diagUsage = null;
    // The abandoned attempt's media-generation flag would otherwise leak into
    // the replay's mediaGeneratedUndelivered (a replay ending clean without
    // media would be misflagged empty_response — codex P2).
    this.sawMediaGeneration = false;
    // Everything the abandoned run produced is invalidated by the replay.
    this.compactionPending = true;
    this.text = "";
    this.hasSnapshot = false;
    this.hasVisibleToolText = false;
    this.pendingAckText = "";
    this.mediaPaths = new Map();
    this.lastDedupKey = null;
    this.deadlines.delete("empty_final");
    this.deadlines.delete("private_ack");
    this.deadlines.delete("lifecycle_end");
    this.armRecv(now);
  }

  private armRecv(now: number): void {
    if (this.finalized) {
      return;
    }
    const budget = this.compactionPending ? COMPACTION_RECV_TIMEOUT : BASE_RECV_TIMEOUT;
    this.deadlines.set("recv", now + budget);
  }

  private arm(name: string, deadline: number): void {
    this.deadlines.set(name, deadline);
  }

  private clearWait(name: string): void {
    this.deadlines.delete(name);
  }

  private hasRealContent(): boolean {
    return Boolean(
      this.hasVisibleToolText ||
        this.mediaPaths.size > 0 ||
        (this.text && !isPrivateAck(this.text)),
    );
  }

  // -- sanitization wrappers (never leak server paths to the browser) -------

  private safeSanitizeText(text: string): string {
    try {
      return sanitizeText(text, { mediaSessionKey: this.sessionKey });
    } catch (err) {
      if (err instanceof MediaConfigurationError) {
        return text;
      }
      throw err;
    }
  }

  private safeSanitizeFrame(frame: Json): Json {
    try {
      return sanitizeFrame(frame, { mediaSessionKey: this.sessionKey });
    } catch (err) {
      if (err instanceof MediaConfigurationError) {
        // Cannot build signed media links; forward without the raw frame's
        // content rather than leaking a server path.
        return { event: isObject(frame) ? frame.event : undefined, payload: { sanitized: false } };
      }
      throw err;
    }
  }
}
