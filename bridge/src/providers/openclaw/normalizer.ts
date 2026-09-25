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

import {
  isUnsafeOutboundPath,
  MediaConfigurationError,
  sanitizeFrame,
  sanitizeText,
  DELIVERABLE_MEDIA_SUBDIRS,
} from "./sanitize.js";
import { isGatewayInitiatedRunId } from "./run-families.js";
import { planPartFromPlanStream } from "../../core/plan-part.js";
import {
  classifyFailureText,
  withoutOperatorData,
} from "../../core/failure-classifier.js";
import {
  bucketCompactionReason,
  compactionCompleted,
  compactionFailedForGood,
  isCompactionHookRelay,
  isCompactionRefusal,
} from "../../core/compaction-verdict.js";
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
  EVENT_FRAME_GAP,
  EVENT_PLAN_ADVANCE,
  EVENT_PLAN,
  EVENT_TURN_PHASE,
  EVENT_SESSION_OVERFULL,
  EVENT_COMPACTION_CAUSE,
  stampReceived,
  type BridgeEvent,
} from "../../core/events.js";
import type { FinalizeCause } from "../../core/finalize-causes.js";
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
  EVENT_PLAN,
  EVENT_TURN_PHASE,
  EVENT_SESSION_OVERFULL,
  EVENT_COMPACTION_CAUSE,
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
// The gateway's DISPLAY projection truncates a chat final's text at 8 000 chars
// and appends this exact marker (`chat-display-projection.ts`, verified in the
// deployed 2026.7.1 build). It is a HISTORY cap reused on a LIVE event, so a long
// reply delivered through the message tool reaches us already cut — and nothing
// detected it: the truncated text was persisted as the answer, marker and all.
export const TRUNCATED_FINAL_MARKER = "\n...(truncated)...";
// Wait after a truncated final for the transcript recovery to bring back the FULL
// text. Short on purpose: the recovery RPC is bounded at 10 s, and if it brings
// nothing the truncated text is still finalized — better a cut answer than a
// 90-second wait for one.
export const TRUNCATED_FINAL_GRACE = 20.0;
// The projection cuts at EXACTLY its cap and then appends the marker, so a real
// truncation always carries a body at least this long. Without the length test,
// any short reply that happens to end with the marker (an agent quoting a log
// excerpt, or told to end that way) would hold the turn open for the recovery
// grace it does not need (codex P2). An operator who lowers the cap below this
// loses the detection — never the reply.
export const TRUNCATED_FINAL_MIN_BODY = 8_000;
export const PRIVATE_ACK_GRACE = 5.0; // wait after a private-ack final for the visible message
// The same wait, when it exists ONLY to let the history recovery run: that recovery
// calls `sessions.get` with a 10 s budget (bridge/src/session.ts, recoverDeliveredReply),
// so a 5 s window finalizes the turn while its own RPC is still in flight and the
// reply that comes back is refused as belonging to a finalized turn. This one has to
// outlive the call it opens.
export const HISTORY_RECOVERY_GRACE = 12.0;
export const LIFECYCLE_END_GRACE = 10.0; // wait after lifecycle:end for a follow-on run
// The DEFERRED terminal (`phase:"finishing"`): the gateway is done producing and
// is finishing its post-turn work (transcript persistence, hooks) before it emits
// the real `end` — the standard embedded-agent path sets `deferTerminalLifecycle`
// (verified in the deployed 2026.7.1 build). We had no branch for it, so the turn
// simply went silent until the 240 s recv timeout. Bounded well under that: the
// real end normally lands in seconds, and if it never does the turn still closes.
export /** The contract's own ceiling for a back-off counter (logs-chat.ts
 *  `ChatStatusEventSchema`: integers 1..10 on BOTH fields). Checking only the lower
 *  bound let `{attempt: 11, maxAttempts: 11}` through to the label — a counter the
 *  gateway cannot legally emit, which means the frame is not what it claims to be
 *  (raised in review). */
/** Upstream's OWN test for "this tool frame is visible progress"
 *  (`server-chat-progress-snapshot.ts` `isTool`), transcribed rather than approximated.
 *
 *  Two earlier versions were wrong. The first accepted a raw non-empty `toolCallId`,
 *  so `"   "` counted as an id. The second added `itemId`/`id` fallbacks and read a
 *  flat `data.reviewId` — but those fallbacks belong to `preambleItemId`, a DIFFERENT
 *  variable in the same upstream function, and the review id is nested at
 *  `data.review.id` (raised in review). Transcribing from the wrong lines of the right
 *  file reads as fidelity and is not. */
function isUpstreamToolProgress(data: JsonObject): boolean {
  const toolCallId = isString(data.toolCallId) ? data.toolCallId.trim() : "";
  if (toolCallId === "") return false;
  const phase = isString(data.phase) ? data.phase.trim() : "";
  if (!UPSTREAM_RESUME_TOOL_PHASES.has(phase)) return false;
  // `review` is progress only when the frame names the review it belongs to, and that
  // id lives INSIDE the `review` object.
  if (phase === "review") {
    const review = isObject(data.review) ? data.review : null;
    const reviewId = review !== null && isString(review.id) ? review.id.trim() : "";
    if (reviewId === "") return false;
  }
  return true;
}

/** The tool phases upstream counts as a RESUME signal
 *  (`server-chat-progress-snapshot.ts` `isTool`). Deliberately NOT the same set as
 *  `TOOL_PROGRESS_PHASES` below, which answers a different question — whether a tool
 *  frame carries incremental output. Same word, two contracts. */
const UPSTREAM_RESUME_TOOL_PHASES: ReadonlySet<string> = new Set([
  "start",
  "input_delta",
  "update",
  "review",
  "result",
]);

const RETRY_MAX_ATTEMPTS = 10;

const LIFECYCLE_FINISHING_GRACE = 60.0;
// A tool asked for HUMAN approval (`stream:"approval" phase:"requested"`). The
// run is alive and deliberately waiting, so the 240 s silence budget is the wrong
// clock — but the wait must still be BOUNDED, or this re-creates the "Génération…"
// that never ends. Same budget as a compaction: generous enough for a person to
// answer, short enough that the turn always settles with a named cause.
// MUST stay under the Convex stuck-stream watchdog (STALE_STREAM_MS = 12 min):
// an approval wait is genuinely SILENT — no frames, no writes, nothing to bump
// `updatedAt` — so a longer budget would let the watchdog reap the message as
// `stream_orphaned` before this could close it with the cause it exists to name
// (codex P2). Ten minutes leaves the watchdog its margin.
export const APPROVAL_WAIT = 600.0;
/** A question the agent put to a HUMAN (OpenClaw `ask_user`) holds the turn until the
 *  gateway's own deadline — 15 min by default (`src/infra/embedded-question-broker.ts:115`
 *  at v2026.9.5), which is LONGER than our 240 s silence budget and the 12 min Convex
 *  stuck-stream watchdog. The wait is bounded by that deadline plus a margin, capped so
 *  a deadline we cannot read never becomes an unbounded hold. */
export const QUESTION_WAIT_DEFAULT = 15 * 60.0;
export const QUESTION_WAIT_MAX = 60 * 60.0;
export const QUESTION_WAIT_MARGIN = 30.0;
/** While a human is asked, the phase is re-published this often: a phase write is the
 *  streaming row's heartbeat, and nothing else moves during the wait. */
export const HUMAN_WAIT_BEAT = 60.0;
// The turn ended while still waiting for an approval Atrium has no way to grant.
// A NAMED terminal, so the per-cause anomaly chain reports it instead of the turn
// reading as an unexplained timeout. See the `gap` entry in
// Classified in bridge/protocol/openclaw/coverage/<version>.json: the resolution
// path is NOT implemented,
// and inventing an automatic approval would be a security decision nobody made.
export const APPROVAL_PENDING_CODE = "awaiting_approval";

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
// "unknown" (nothing actionable to classify). These are the values the GATEWAY may
// send; the stable errorCode also carries classes this build mints from the sentence
// when the gateway sends none (auth_profile_cooldown, the storage classes).
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

// The gateway's per-session OCC guard: commitReplySessionInitialization retries a
// stale snapshot ONCE, then throws this exact message when a concurrent writer
// (e.g. the previous turn's post-run memory flush churning the session entry)
// keeps invalidating the init snapshot (gateway get-reply, verified 2026.6.11;
// live incident 2026-07-09). Upstream treats it as TRANSIENT: the Telegram
// channel spool-retries on this same message with exponential backoff
// (polling-session.ts REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE). Classifying it to
// a stable code lets Convex auto-retry the turn (turnRetry.ts) and the UI show
// an honest "transient, retrying" card instead of a generic error.
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
// NEVER-transient guards, checked FIRST: an auth/entitlement/config failure
// matching a loose 5xx-ish marker must not auto-retry (a wrong key retried is
// wasted quota and a misleading label; a refusal must stay a refusal). The
// rate-limit family is also excluded — its correct handling is a LONGER
// backoff than the 5/15s retry curve, and real gateways classify it upstream.

// Terminal stopReason values we persist into the (metadata-only) pressure
// trace. The schema types stopReason as a FREE string — anything outside this
// allowlist buckets to "other" so a raw network string never reaches traces
// (SOC2; codex P2). Values: live captures ("stop" = natural end, "rpc" = the
// user Stop via chat.abort) + the schema-adjacent classic finish reasons +
// the CONSTANTS 2026.9.4 puts on a terminal (never free text, so naming them
// leaks nothing): "restart" (AGENT_RUN_RESTART_ABORT_STOP_REASON — gateway
// restart, chat-send-admission.ts), "superseded" (AGENT_RUN_SUPERSEDED_STOP_REASON,
// agent-run-terminal-outcome.ts), "auth-revoked" (a full-provider logout,
// models-auth-status.ts abortChatRunsForProvider) and "toolUse" (the provider
// union's own spelling, packages/llm-core/src/types.ts StopReason), "end_turn" /
// "tool_calls" (embedded-agent-runner/run/terminal-resolution.ts: a yield, a
// client tool call) and "archive" / "delete" (the closed
// SessionLifecycleParams.action, sessions-lifecycle-drain.ts, broadcast by
// chat-abort.ts on the killed run). Bucketed to "other", a trace could not tell
// a gateway restart from a revoked login or a deleted session.
const KNOWN_STOP_REASONS = new Set([
  "stop",
  "rpc",
  "length",
  "tool_use",
  "toolUse",
  "tool_calls",
  "end_turn",
  "aborted",
  "error",
  "timeout",
  "content_filter",
  "restart",
  "superseded",
  "auth-revoked",
  "archive",
  "delete",
]);
const bucketStopReason = (v: string): string =>
  KNOWN_STOP_REASONS.has(v) ? v : "other";

const CHAT_ERROR_KINDS = new Set([
  "refusal",
  "timeout",
  "rate_limit",
  "context_length",
]);

/**
 * PROGRESS phases on `stream:"tool"` — a tool is still RUNNING. Enumerated from
 * every upstream emission site at v2026.7.1 (`stream: "tool"` → `phase:` is one
 * of start ×62, result ×28, update ×3, chunk ×1), so `result` is the only
 * completion on this stream; the tool's terminal ALSO rides the `item` stream as
 * `phase:"end"` (handlers.tools.ts emitTrackedItemEvent), consumed separately.
 *
 * The list is an ALLOWLIST of non-terminals rather than of terminals on purpose
 * (multi-version safety, supported range 2026.5.19+): an UNKNOWN phase carrying
 * a result payload must still be able to close the card — a stuck spinner is a
 * worse failure than a card closed by an unrecognized name. `delta` is included
 * defensively: it is emitted on sibling streams by the same handler file and
 * would mean progress here too.
 */
const TOOL_PROGRESS_PHASES: ReadonlySet<string> = new Set([
  "update",
  "chunk",
  "delta",
]);

function isToolProgressPhase(phase: unknown): boolean {
  return isString(phase) && TOOL_PROGRESS_PHASES.has(phase);
}

/**
 * WHERE a run's timeout struck, bucketed to the values the gateway actually
 * emits (enumerated from the deployed 2026.7.1 build: `provider`, `queue`,
 * `gateway_draining`).
 *
 * Bucketed for the SAME reason `stopReason` is: this rides `chat.gateway_pressure`,
 * a metadata-only trace exposed through the observability/MCP surface. The field
 * is typed as a free string on the wire, so forwarding it verbatim would open a
 * path for arbitrary gateway text — possibly carrying request content — into
 * records whose whole contract is that they never hold any (codex P1, SOC2).
 */
const TIMEOUT_PHASES: ReadonlySet<string> = new Set([
  "provider",
  "queue",
  "gateway_draining",
]);

function bucketTimeoutPhase(phase: string): string {
  return TIMEOUT_PHASES.has(phase) ? phase : "other";
}

/**
 * The normalizer's clock is epoch SECONDS (`Date.now() / 1000`); the reset fence
 * compares milliseconds. Converted here so a verdict carries the instant its
 * FRAME arrived, not the instant its write happens to go out.
 */
function observedAtMs(nowSeconds: number): number {
  return Math.round(nowSeconds * 1000);
}

/**
 * Does `haystack` already carry `needle` AS A DELIVERY — the whole of it, or one of
 * its blank-line-separated segments?
 *
 * Plain `includes` was wrong: a recovered reply "OK" is not already present because
 * the live answer happens to contain "TOKEN", and dropping it on that basis loses a
 * message the user was really sent.
 */
function holdsDelivery(haystack: string, needle: string): boolean {
  if (needle === "") return true;
  if (haystack === needle) return true;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const startsSegment = at === 0 || haystack.startsWith("\n\n", at - 2);
    const end = at + needle.length;
    const endsSegment = end === haystack.length || haystack.startsWith("\n\n", end);
    if (startsSegment && endsSegment) return true;
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

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

/** True for a safe OpenClaw deliverable media path (no scheme/traversal). */
function isOutboundMediaPath(path: Json): path is string {
  if (!isString(path) || path === "") {
    return false;
  }
  if (!path.startsWith("/")) {
    return false;
  }
  // ROOT-AGNOSTIC, deliberately: a gateway's state dir follows its account or
  // `OPENCLAW_STATE_DIR`, so `/home/alice/.openclaw/…` and `/srv/openclaw/…` are ordinary
  // deployments — and `gateway-http`, the default transport, serves whatever path the
  // gateway itself minted a ticket for. Anchoring this on `/home/node` looked tidier and
  // silently dropped every delivery from such a gateway (codex P1).
  //
  // What a path must have is a DELIVERABLE DIRECTORY in it. Where the bytes then come from
  // is the fetcher's business, and the shared-fs one enforces its own, stricter rule —
  // that is a transport constraint and does not belong in this shared reader.
  if (!DELIVERABLE_MEDIA_SUBDIRS.some((d) => path.includes(`/media/${d}/`))) {
    return false;
  }
  // The dangerous SHAPES (".." traversal, a query component, a scheme) live in
  // ONE definition, shared with the child lane — which had no filter at all
  // until it was given this one. urlsplit() in Python rejects scheme/netloc/
  // query; for an absolute fs path those map to "://" and "?".
  return !isUnsafeOutboundPath(path);
}

// Global scanner for an outbound media path EMBEDDED anywhere inside a (possibly
// multi-line) string -- e.g. exec stdout or a bare path surfaced in a tool
// result. The tail stops at whitespace, backtick, quote, paren or angle bracket
// (mirrors sanitize.ts OUTBOUND_PATH_RE), so a path inside prose or a shell
// transcript is extracted without trailing junk. Each hit is re-validated
// through isOutboundMediaPath, so the "..", inbound, scheme and query filters
// still apply -- this widens DISCOVERY only, never the safety gate.
const EMBEDDED_OUTBOUND_RE = new RegExp(
  // …and the embedded scan with it: what the reader accepts, the scanner must find.
  String.raw`(?:/[^\s\`)>"']+)*/media/(?:${DELIVERABLE_MEDIA_SUBDIRS.join("|")})/[^\s\`)>"']+`,
  "g",
);

// A whole-line MEDIA: delivery directive (the convention the bridge injects via
// the [LIVRAISON] block). Mirrors sanitize.ts MEDIA_DIRECTIVE_RE so DISCOVERY and
// visible-text STRIPPING agree on the same path. CRUCIAL: the convention defines
// the ENTIRE rest of the line as the path, so a filename WITH SPACES ("IFOA
// Presentation.pdf") is captured intact -- the bare-token scan above would
// truncate it at the first space (the reported gateway-http delivery bug: the
// visible text was stripped correctly but the file the bridge then tried to
// fetch was the truncated ".../IFOA", which does not exist -> no media part).
const MEDIA_DIRECTIVE_LINE_RE = new RegExp(
  // Root-agnostic, mirroring sanitize.ts MEDIA_DIRECTIVE_RE so DISCOVERY and STRIPPING agree.
  String.raw`^MEDIA:((?:/.*)?/media/(?:${DELIVERABLE_MEDIA_SUBDIRS.join("|")})/.+)$`,
);

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
  // The SAME separators the visible-text stripper splits on. Narrower here, a
  // `MEDIA:<path>\u2028rest` line read as one line missed the directive and demoted the path
  // to a mention — while the stripper DID see the directive and removed it: the line was
  // gone and the file was not attached (codex).
  for (const line of text.split(
    /\r\n|[\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029]/,
  )) {
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

/** A media-generation task's DELIVERY run: `<tool>:<taskId>:ok[:<suffix>]`.
 *
 *  Anchored on the three tool names upstream lists as background media tasks, and on `:ok` —
 *  the `:error` sibling is a failure the turn already reports as one. Live shape:
 *  `image_generate:f21f0360-…:ok:agent-loop`. */
const MEDIA_TASK_DELIVERY_RUN_RE =
  /^(?:image_generate|music_generate|video_generate):[^:]+:ok(?::|$)/;

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
  // Chat-frame dedup keys ALREADY seen this turn. A single scalar slot only
  // caught ADJACENT repeats: an upstream replay (`meta:{cached:true}`) that
  // re-sends A after B (A,B,A) slipped straight through and duplicated content.
  // Insertion-ordered Set = LRU: at the cap the oldest key is evicted, which at
  // worst re-admits a very old duplicate — it never decides a turn, so unlike
  // the per-turn caps of W8 this eviction is deliberately SILENT (a loud log
  // here would fire on every long turn and devalue the pattern).
  seenDedupKeys: Set<string>;
  /** The immediately preceding chat dedup key — the ADJACENT-only rule, kept for
   *  frames with no `seq` to identify them by. */
  lastDedupKey: string | null;
  // 6.5 webchat sink: the gateway runs the message-tool itself and only emits a
  // bare `stream:"item"` frame (no args, no result) — the delivered text lives
  // ONLY in the session transcript. When such an item was seen AND the turn is
  // holding a private-ack/empty-final grace, the session loop recovers the text
  // via `sessions.get` (history recovery, deferred since 5.19) exactly once.
  sawMessageToolItem: boolean;
  // Message-tool calls this turn whose `args` we could not read at all (G-16).
  // The tool IS the visible-reply mechanism, so an unreadable call means the
  // answer may exist only in the transcript: it arms the same history recovery
  // as a gateway-run message tool, and it NAMES the cause if that recovery
  // still finds nothing — instead of the turn reading as a plain empty response.
  msgtoolUnreadableArgs: number;
  // This turn received a chat final the gateway had CUT at its 8 000-char display
  // cap (G-13). The text is real but INCOMPLETE, so the transcript recovery stays
  // eligible even though the turn holds content — the one case where "we already
  // have an answer" is not a reason to stop looking for it.
  sawTruncatedFinal: boolean;
  truncatedFinals: number;
  // Runs the gateway flagged `isHeartbeat` on an `agent` frame. The discriminant
  // exists ONLY there (the `chat` payload has no such field — verified in the
  // deployed 2026.7.1 build), so it must be LEARNED from agent traffic and then
  // applied when a chat frame of that run shows up. Bounded, session-scoped:
  // heartbeats outlive a turn, so this is deliberately NOT reset per turn.
  private heartbeatRunIds = new Set<string>();
  // A replay of THIS turn is expected on a NEW runId — set the moment the
  // gateway tells us so (an abandoned lifecycle end we reset for, or an explicit
  // `compaction end willRetry:true`). Positive proof of filiation: without it,
  // `compactionPending` alone is a 900-second door held open for any run.
  private replayExpected = false;
  /** The announced replay is expected to CONTINUE on the current runId (the
   *  explicit `compaction end willRetry:true` path). The proof is then only a
   *  hedge for a gateway that rotates instead, and the first frame of the
   *  resumed run consumes it — leaving it standing would keep admitting any run
   *  of the session for as long as the turn ran (codex P1). */
  private replaySameRun = false;
  // Runs adopted through a grace window. ADDITIVE ONLY: an adopted run may add
  // text, never finalize the turn — the harm G-12 names is a stranger becoming
  // the answer AND closing the turn on it.
  private adoptedRunIds = new Set<string>();
  /** Foreign-run frames refused this turn, by reason. This counter is also the
   *  instrument that measures the real exposure — before it, the rate at which
   *  strangers reached a live turn was simply unknown. */
  foreignRunRejections: Map<string, number>;
  // Assistant-stream frames tagged `phase:"commentary"` this turn (G-17). Count
  // only — the preamble text is conversational content.
  commentaryFrames: number;
  /** The frame being processed belongs to a run adopted through a grace window. */
  private frameRunAdopted = false;
  /** Adopted runs that still owe a boundary before their first additive write.
   *  PER RUN (codex P2): two runs can be admitted in the same grace window, and a
   *  single flag let the first consume the separator while the second's reply was
   *  then glued onto it. Bounded by the same LRU rule as the other per-run sets. */
  private adoptedSeparatorOwed = new Set<string>();
  /** The runId of the frame being processed (empty when it carries none). */
  private frameRunId = "";
  /**
   * Bumped whenever the turn's content is INVALIDATED — a new turn, or a
   * compaction reset that discards the abandoned attempt. A recovery RPC in
   * flight across such a reset would otherwise apply the abandoned attempt's
   * text and finalize the turn on it, locking out the replay's real answer
   * (codex P1). The turn epoch does not move on a compaction reset, so this
   * counter is the one that has to.
   */
  recoveryGeneration = 0;
  // The agent ran NATIVE media generation this turn (a codex `imageGeneration`
  // item). It carries no path/url/bytes — if the turn then delivers no media
  // (no MEDIA:/mediaUrls), finalize emits a diagnostic so the gap is visible.
  sawMediaGeneration: boolean;
  /** This turn IS the delivery run of a media-generation background task.
   *
   *  Upstream runs `image_generate` / `music_generate` / `video_generate` as background
   *  tasks (media-generation-task-status.ts @ v2026.9.4): the asking turn gets an ACK
   *  (`details.async:true`, a `taskId`) and the artifact arrives later, in a run the gateway
   *  names `<tool>:<taskId>:ok`. That name IS the contract — the run exists for nothing else,
   *  and `:ok` is the gateway's own word that the task succeeded — so finalizing it with no
   *  media is a promise broken by construction. No prose is read to know it.
   *
   *  Both shapes were captured live on the SAME build, hours apart (bench 2026-09-18,
   *  scenario async-task): one delivery run carried
   *  `mediaUrls:["…/media/tool-image-generation/…png"]`, the next carried none and said
   *  "l'image arrivera automatiquement dès qu'elle sera prête". Five production reports
   *  describe the second — and nothing saw it: the turn ends `complete`, so it carries no
   *  failure class at all. */
  mediaDeliveryRun = false;
  // Child session keys observed THIS turn (spawnedBy admission): the parent may
  // legitimately end SILENT while children work — its real reply arrives later
  // as an announce/spontaneous turn. A SET (not a boolean) so the sink can
  // intersect with the keys the turn's OWN sessions_spawn calls returned —
  // a stale child from a PREVIOUS turn never exempts the current one.
  observedChildKeys: Set<string>;
  /** TRUE once the per-turn cap dropped observed child keys: the set is then
   *  INCOMPLETE, and an absence in it proves nothing. The sink's empty-response
   *  guard reads that absence as "no child of this turn is working", so a parent
   *  legitimately delegating a silent reply would be finalized as an error. */
  observedChildKeysTruncated: boolean;
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
  // Whether an OWN frame of this turn proved (or may have proved) that a run reached
  // generation — see provesGeneration. Never reset inside a turn: a replay or a
  // follow-on run cannot undo work an earlier run of the same turn did.
  private generationEvidence = false;
  // Frames of this turn may have been LOST (socket closed mid-turn, pre-ack buffer
  // overflowed): an absence read from the stream proves nothing after that.
  private streamGap = false;
  // Diagnostic captures for the per-turn pressure trace (never classification):
  // the terminal frame's optional stopReason, and the REAL post-turn usage the
  // gateway flattens onto agent events on live deployments (dev 2026-07-04).
  private diagStopReason: string | null = null;
  /** Terminal diagnostics the gateway ships and we used to drop (G-20). */
  private diagTimeoutPhase: string | null = null;
  private diagProviderStarted: boolean | null = null;
  private diagAborted = false;
  /** The gateway's OWN hand-off signal (`lifecycle.yielded`). */
  sawYielded = false;
  /** Whether this normalizer published a provider back-off that nothing has closed yet.
   *
   *  It is NOT "the last published phase is still the back-off" — something else can
   *  publish a phase in between, which is why the clear this flag triggers names what
   *  it may remove (`onlyIfRetrying`).
   *
   *  An earlier version of this comment said a bare `status` frame must clear it. That
   *  was wrong and the code followed it: upstream projects the `overloaded`,
   *  `server_error` and `timeout` retries as `starting_model` with no `retry` field, so
   *  a bare status can equally mean "still backing off, for another cause". The label
   *  is closed by a real resume signal instead — see `clearRetryingPhase`. */
  private inRetryingPhase = false;
  /** A `lifecycle_finishing` grace that a compaction suspended. Re-armed when the
   *  compaction settles: suspending it is what keeps a long summary from closing the
   *  turn, but DROPPING it would leave the post-compaction silence unbounded. */
  private finishingSuspended = false;
  /** A tool is waiting on a human approval this app cannot grant (G-21). */
  /** The approvals awaiting a human, BY ID.
   *
   *  One boolean for all of them said "someone is waiting" and nothing more, so the
   *  first `resolved` released every pending request. That was survivable while its
   *  only effect was restoring the silence clock early; it stopped being survivable
   *  when a release also gives the 60 s finishing promise back — one answered
   *  approval would then close the turn as a SUCCESS while another command was still
   *  waiting for someone to authorise it, and could still run afterwards.
   *
   *  Upstream names the request, but NOT with one stable field: the emitter
   *  (`embedded-agent-subscribe.handlers.tools.completion.ts`, v2026.9.5) puts
   *  `toolCallId` on BOTH frames and `approvalId` only on a `requested` whose status
   *  is `approval-pending` — the `resolved` carries no `approvalId` at all. Keying on
   *  `approvalId` therefore missed on every single resolution. Both ids are stored as
   *  ALIASES of one record so either frame finds it; a frame naming nothing falls
   *  back to a count, because a generation that names nothing must not silently
   *  become "nothing is pending". */
  private readonly approvalAliases = new Map<string, string>();
  /** Questions this turn's run put to a human (OpenClaw `ask_user`), by question id.
   *  Fed from OUTSIDE the frame stream (`question.requested` is a broadcast, not an
   *  agent frame — see RunManager.noteHumanQuestion). A holder like an approval: while
   *  one is pending no grace may close the turn and the silence clock is suspended. */
  private readonly pendingQuestionIds = new Set<string>();
  /** How many approvals this TURN has requested, resolved ones included. Content can
   *  stand in for a resolution only on a turn that asked exactly once: after a second
   *  request, text is far more likely to be the first command's output than an answer
   *  to the one still waiting. */
  private approvalsRequested = 0;
  /** May an in-flight transcript recovery FINALIZE this turn with what it finds?
   *
   *  Normally yes — a recovery running because the connection died IS the turn's
   *  ending. It is revoked only where the question arises: `sessions.get` is given
   *  10 s and answers long after the window that dispatched it was torn down.
   *  Cancelling that deadline said "stop waiting"; it did not reach the request
   *  already on the wire, which came back and closed the turn as a success over a
   *  tool that had resumed — or over a human still being asked to authorise a
   *  command. Revoked, the text is still APPLIED: the reply really was delivered and
   *  discarding it would be the other half of the same defect. It simply no longer
   *  ends the turn. */
  private workResumeCount = 0;
  /** One entry per transcript fetch IN FLIGHT: its token, and the `workResumeCount`
   *  it left with.
   *
   *  Turn-scoped revocation was wrong twice over. Once any promise had been torn
   *  down, a LATER and entirely legitimate recovery — the socket died, the silence
   *  budget expired — inherited the revocation and could no longer close the turn it
   *  was recovering. And a single shared mark was not per-attempt at all: with A
   *  revoked and B dispatched before A returned, B's mark was the current count, so
   *  A came back, compared against B's mark, matched, and closed the turn with its
   *  stale transcript. The answer belongs to the attempt that asked the question. */
  private readonly recoveryAttempts = new Map<number, number>();
  private nextRecoveryToken = 1;
  private readonly pendingApprovalIds = new Set<string>();
  private anonymousApprovals = 0;
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
  /** Per-turn collection caps. A turn is bounded work; these are not. A runaway
   *  agent (a tool loop, a path-spraying prose reply, a spawn storm) grew them for
   *  the whole turn, and the memory it cost was invisible. Overflow is LOUD and
   *  logged ONCE per episode — the pattern `stashAnnounceFrame` already sets in the
   *  run-manager — because a silent truncation reads as "nothing was dropped". */
  private static readonly MAX_TOOL_ARGS = 2_000;
  /** Deliveries recovered after work resumed and held for the terminal. Bounded for
   *  memory alone — reaching it is reported, never absorbed. */
  private static readonly MAX_RECOVERED_TAILS = 16;
  private static readonly MAX_MEDIA_PATHS = 2_000;
  private static readonly MAX_OBSERVED_CHILDREN = 1_000;
  /** Chat dedup memory (G-15). NOT one of the caps above: eviction here is an
   *  LRU, silent, and decides nothing — see `seenDedupKeys`. */
  private static readonly MAX_DEDUP_KEYS = 64;
  /** Heartbeat runIds remembered per session (G-12). Same LRU rationale. */
  private static readonly MAX_HEARTBEAT_RUNS = 64;
  private overflowLogged = new Set<string>();

  /** TRUE when the cap is reached (caller skips the write); logs once. */
  private capReached(label: string, size: number, cap: number): boolean {
    if (size < cap) return false;
    if (!this.overflowLogged.has(label)) {
      this.overflowLogged.add(label);
      console.error(
        `[normalizer] ${label} cap reached (${cap}) — further entries are DROPPED for this turn`,
      );
    }
    return true;
  }


  // Absolute deadlines: name -> time. "recv" is the silence budget; the others
  // are wall-clock graces armed from a specific event.
  private deadlines: Map<string, number>;

  /** The provider session Convex has STORED for this chat, when it has one.
   *
   *  Carried so a terminal `session_gone` can name it: the clear is guarded by an exact
   *  match on the Convex side, so an unnamed clear could wipe a binding a newer turn
   *  had already made. Null when the chat has no stored session — there is then nothing to
   *  name, and no directive is emitted. The CLASS still arises there: the conversation the
   *  gateway cannot find is its own, not necessarily one Atrium recorded (see where the
   *  directive is set, which says the same thing — an earlier version of this sentence
   *  claimed the opposite, codex). */
  private readonly providerSessionId: string | null;

  constructor(sessionKey: string, providerSessionId: string | null = null) {
    this.sessionKey = sessionKey;
    this.providerSessionId = providerSessionId;
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
    this.seenDedupKeys = new Set();
    this.lastDedupKey = null;
    this.sawMessageToolItem = false;
    this.msgtoolUnreadableArgs = 0;
    this.sawTruncatedFinal = false;
    this.truncatedFinals = 0;
    this.recoveryGeneration++;
    this.replayExpected = false;
    this.replaySameRun = false;
    this.adoptedRunIds = new Set();
    this.adoptedSeparatorOwed = new Set();
    this.foreignRunRejections = new Map();
    this.commentaryFrames = 0;
    this.sawMediaGeneration = false;
    this.observedChildKeys = new Set();
    this.observedChildKeysTruncated = false;
    this.deadlines = new Map();
  }

  // -- turn lifecycle (called from the browser->gateway task) ---------------

  /** Reset per-turn state when the user sends a message (before chat.send). */
  beginTurn(now: number): void {
    // Per-turn diagnostics reset (codex P2: without this, a turn without
    // stopReason/usage frames would inherit the PREVIOUS turn's values in its
    // pressure trace).
    this.diagStopReason = null;
    this.diagTimeoutPhase = null;
    this.diagProviderStarted = null;
    this.diagAborted = false;
    this.sawYielded = false;
    this.inRetryingPhase = false;
    this.finishingSuspended = false;
    this.clearApprovals();
    this.pendingQuestionIds.clear();
    // Per TURN, not per release: `clearApprovals` also runs when the turn ends and
    // when content answers one, and zeroing the count there would let the NEXT
    // request on the same turn look like the turn's first.
    this.approvalsRequested = 0;
    this.workResumeCount = 0;
    this.recoveryAttempts.clear();
    this.recoveredTails = [];
    this.recoveryWindowCause = null;
    this.pendingFinal = null;
    this.pendingFinalMark = -1;
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
    this.seenDedupKeys = new Set();
    this.lastDedupKey = null;
    this.sawMessageToolItem = false;
    this.msgtoolUnreadableArgs = 0;
    this.sawTruncatedFinal = false;
    this.truncatedFinals = 0;
    this.recoveryGeneration++;
    this.replayExpected = false;
    this.replaySameRun = false;
    this.adoptedRunIds = new Set();
    this.adoptedSeparatorOwed = new Set();
    this.foreignRunRejections = new Map();
    this.commentaryFrames = 0;
    this.sawMediaGeneration = false;
    this.observedChildKeys = new Set();
    // …and its completeness flag: left set, ONE capped turn would make every later
    // turn declare an incomplete list, quietly disabling the empty-response guard
    // for the rest of the session (codex P2).
    this.observedChildKeysTruncated = false;
    this.recoveryAttempted = false;
    this.generationEvidence = false;
    this.streamGap = false;
    this.suppressNextRotation = false;
    this.compactionSignaled = false;
    this.explicitCompaction = "none";
    this.toolArgs.clear();
    this.overflowLogged.clear();
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
  /**
   * The pre-send guard compacted THIS session, on purpose, before the turn (W2).
   *
   * WHY this exists: `session.operation` is the gateway's own account of a
   * compaction and the only carrier of a cause it computed itself — and it is
   * unreachable without a dedicated connection (see session.ts). Without this, the
   * marker's cause sentence and the pressure trace's `compactionReason` would be
   * permanently absent, i.e. two projections shipped in this same lot carrying
   * nothing. For the compactions ATRIUM causes we do not need the gateway to tell
   * us why: we asked, pre-emptively, before assembling the prompt — which is
   * exactly the `pre_compaction` class.
   *
   * Consumed ONCE, by the rotation that our own compaction produces.
   */
  notePresendCompactionCause(reasonClass: string): void {
    this.presendCompactionCause = reasonClass;
  }

  /** One-shot cause class stashed by the pre-send guard (see below). */
  private presendCompactionCause: string | null = null;

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
      if (MEDIA_TASK_DELIVERY_RUN_RE.test(runId)) this.mediaDeliveryRun = true;
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
    cause: FinalizeCause = "external",
    // A caller that ALREADY knows the failure class states it (a NAMED connection
    // end). Without this the kind stayed null on every forced finalize, the text
    // fallback below could not classify a bare code, and the operator telemetry
    // reported a generic `gateway_error` for an end we had just identified.
    errorKind: string | null = null,
  ): BridgeEvent[] {
    return stampReceived(
      this.finalize(now, status, error, errorKind, cause),
      now,
    );
  }

  /** Finalize the active turn as failed after a per-message upstream error. */
  failTurn(now: number, message: string): BridgeEvent[] {
    return stampReceived(this.failTurnAt(now, message), now);
  }

  private failTurnAt(now: number, message: string): BridgeEvent[] {
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
    return stampReceived(this.tickAt(now), now);
  }

  private tickAt(now: number): BridgeEvent[] {
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
    if (expired.has("human_beat")) {
      // The heartbeat of a turn a human is holding: nothing else moves while someone
      // decides, and the Convex watchdog would otherwise orphan it at 12 min — before
      // a 15 min question has even expired.
      this.clearWait("human_beat");
      if (this.humanWaitPending()) {
        this.arm("human_beat", now + HUMAN_WAIT_BEAT);
        events.push({
          type: EVENT_TURN_PHASE,
          phase: this.approvalPending() ? "awaiting_approval" : "awaiting_input",
        });
      }
      if (expired.size === 1) return events;
    }
    if (expired.has("question_wait")) {
      // The gateway's own deadline passed with no answer. It unblocks `ask_user` with
      // "no answer — proceed with best judgment" and the agent carries on: this is not
      // a verdict on the turn, so the ORDINARY budget restarts rather than a close.
      this.clearWait("question_wait");
      this.pendingQuestionIds.clear();
      if (!this.approvalPending()) {
        this.clearWait("human_beat");
        this.armRecv(now);
        this.rearmFinishingIfReleased(now);
        events.push({ type: EVENT_TURN_PHASE, phase: "generating" });
      }
      return events;
    }
    if (expired.has("history_recovery")) {
      // The window the finishing grace opened for the transcript fetch. It is its own
      // deadline, not a borrowed `private_ack`, for one reason: resumed work must be
      // able to cancel it. Reusing the ack key left `approval:requested`, a compaction
      // start or a fresh tool start unable to reach it — `cancelFinishingGrace` only
      // knows about `lifecycle_finishing` — and its expiry finalized a SUCCESS over
      // demonstrably live work, twelve seconds after the repair that was supposed to
      // prevent exactly that.
      this.clearWait("history_recovery");
      if (
        this.pendingFinal !== null &&
        this.pendingFinalMark === this.workResumeCount
      ) {
        // A terminal the gateway already delivered was held for a fetch that never
        // came back. Close on IT, with everything we hold.
        const run = this.pendingFinal;
        this.pendingFinal = null;
        events.push(...run(now));
      } else if (this.humanWaitPending() || this.compactionPending) {
        // Held by someone with a stronger claim; THEIR bound (900 s approval_wait,
        // the compaction path) ends the turn, with a named cause.
      } else {
        if (!this.text && this.pendingAckText) this.text = this.pendingAckText;
        events.push(
          ...this.finalize(
            now,
            "final",
            null,
            null,
            this.recoveryWindowCause ?? "history_recovery_grace",
          ),
        );
      }
    } else if (expired.has("private_ack")) {
      // Grace elapsed with no visible follow-on. The chat.history fallback is
      // deferred; degrade gracefully to best-effort content (never hang).
      this.clearWait("private_ack");
      if (!this.text && this.pendingAckText) {
        this.text = this.pendingAckText;
      }
      if (this.humanWaitPending() || this.compactionPending) {
        // …unless someone with a stronger claim owns this turn's end. A five-second
        // grace armed by an ack has no business closing a turn whose next command a
        // human is still being asked to authorise, or whose context is being
        // summarised: THEIR bounds end it, with a named cause. The same rule the
        // recovery window states, and it was missing here.
      } else {
        // Through the same arbitration as every other success: a fetch on the wire
        // outlives this five-second grace, and closing here handed Atrium the ack
        // ("Envoyé dans le webchat.") and lost the reply it acknowledges.
        this.finalizeOrHold(now, "private_ack_grace", events);
      }
    } else if (expired.has("approval_wait")) {
      // Nobody answered within the budget. NAMED, never a silent timeout: the
      // turn is blocked on a decision this app cannot make.
      //
      // The gateway run is deliberately NOT cancelled — same contract as every
      // other synthetic terminal here: we stop waiting, we do not kill work the
      // user may still receive, and cancelling *because we gave up* would also
      // kill a command a human is about to approve in the Control UI. Declared,
      // with its consequences, in bridge/protocol/openclaw/coverage/<version>.json.
      this.clearWait("approval_wait");
      this.clearApprovals();
      // The CODE is persisted as the error string too (codex P2): the UI shows
      // the localized headline for the code and suppresses a detail identical to
      // it, so a hardcoded English sentence here would be printed underneath the
      // French label, untranslated and saying the same thing twice.
      events.push(
        ...this.finalize(
          now,
          "error",
          APPROVAL_PENDING_CODE,
          APPROVAL_PENDING_CODE,
          "approval_timeout",
        ),
      );
    } else if (expired.has("lifecycle_finishing")) {
      // The DEFERRED terminal never became a real one. The answer is already
      // written (the gateway said it was finishing), so close on it rather than
      // hold the turn to the 240 s silence timeout — the defect this branch
      // exists to end (G-20).
      this.clearWait("lifecycle_finishing");
      this.finishingSuspended = false;
      // …but "already written" and "readable by us" are not the same thing. The
      // gateway-run message-tool delivers its text through the session transcript
      // alone — we see only an item frame. `wantsHistoryRecovery` keys on the three
      // graces that mean "held, with nothing to show" (`private_ack`, `empty_final`,
      // `truncated_final`); this one was never among them, so the order
      // `finishing -> message item -> 60 s` finalized a SUCCESS with no text and the
      // recovery that exists for exactly this case never ran. Hand it the 5 s window
      // instead of closing blind — once per turn, and the ack grace finalizes anyway
      // if the transcript brings nothing back.
      if (
        (this.sawMessageToolItem || this.msgtoolUnreadableArgs > 0) &&
        !this.hasRealContent() &&
        !this.recoveryAttempted
      ) {
        this.arm("history_recovery", now + HISTORY_RECOVERY_GRACE);
        return events;
      }
      this.finalizeOrHold(now, "lifecycle_finishing_timeout", events);
    } else if (expired.has("truncated_final")) {
      // The recovery had its window and brought nothing back. Finalize with the
      // truncated text we do have — never hold the turn open for a reply that
      // already arrived, only shortened.
      this.clearWait("truncated_final");
      if (this.humanWaitPending() || this.compactionPending) {
        // Same rule: a holder owns the end (see the ack branch above).
      } else {
        this.finalizeOrHold(now, "truncated_final_grace", events);
      }
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
      } else if (this.humanWaitPending() || this.compactionPending) {
        // A holder owns this turn's end (see the ack branch above): a grace must not
        // close it while a human is being asked to authorise a command or the
        // context is being summarised. THEIR bounds end it, with a named cause.
        this.clearWait("empty_final");
        this.clearWait("lifecycle_end");
        this.armRecv(now);
      } else {
        // A lifecycle_end / empty_final GRACE elapsed = the gateway signaled the
        // turn's end; that IS a terminal, so finalize (not a silence auto-close).
        const cause = expired.has("lifecycle_end")
          ? "lifecycle_end_timeout"
          : "empty_final_timeout";
        this.finalizeOrHold(now, cause, events);
      }
    }
    return events;
  }

  // -- main transducer ------------------------------------------------------

  /** Transduce one raw gateway frame into stable bridge events. */
  /** Every produced event carries the instant this frame ARRIVED (see
   *  core/events.ts `stampReceived`) — including a replayed announce frame,
   *  which the run manager re-feeds with its original `now`. */
  feed(frame: Json, now: number): BridgeEvent[] {
    return stampReceived(this.feedFrame(frame, now), now);
  }

  private feedFrame(frame: Json, now: number): BridgeEvent[] {
    if (!isObject(frame)) {
      return [];
    }
    if (frame.type === "res") {
      // Request/response frames are matched by the connection's request();
      // the ack runId is seeded via noteRunStarted, not forwarded here.
      return [];
    }
    const eventType = frame.event;
    if (
      eventType !== "agent" &&
      eventType !== "chat" &&
      eventType !== "chat.side_result" &&
      eventType !== "session.operation"
    ) {
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
        // A key ALREADY recorded costs nothing and rejects nothing — at exactly the
        // cap, re-seeing a known child would otherwise mark the list incomplete and
        // disable the empty-response guard for a turn that lost nothing (codex P2).
        if (!this.observedChildKeys.has(payload.sessionKey)) {
          if (
            this.capReached(
              "observedChildKeys",
              this.observedChildKeys.size,
              Normalizer.MAX_OBSERVED_CHILDREN,
            )
          ) {
            // A NEW key was dropped: the sink must not read an absence from this
            // list as "no child of this turn is working".
            this.observedChildKeysTruncated = true;
          } else {
            this.observedChildKeys.add(payload.sessionKey);
          }
        }
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
    // LEARN the heartbeat discriminant BEFORE the admission check below. It rides
    // the `agent` payload only, so if we waited for admission we would refuse the
    // very frames that identify the run and never learn anything (the flag would
    // be dead code). Bounded LRU: heartbeats recur for the life of the session.
    if (payload.isHeartbeat === true && isString(payload.runId) && payload.runId) {
      Normalizer.touch(
        this.heartbeatRunIds,
        payload.runId,
        Normalizer.MAX_HEARTBEAT_RUNS,
      );
    }
    const frameRunId = payload.runId;
    if (isString(frameRunId) && frameRunId && this.ownRunIds.size > 0 && !this.ownRunIds.has(frameRunId)) {
      const refusal = this.foreignRunRefusal(frameRunId);
      if (refusal !== null) {
        this.noteForeignRunRejection(refusal);
        return [];
      }
      this.ownRunIds.add(frameRunId);
      this.adoptedRunIds.add(frameRunId);
      this.replaySameRun = false;
      if (this.text !== "") {
        Normalizer.touch(
          this.adoptedSeparatorOwed,
          frameRunId,
          Normalizer.MAX_HEARTBEAT_RUNS,
        );
      }
      // One replay per signal: a second unknown run needs its own proof.
      this.replayExpected = false;
    this.replaySameRun = false;
    }
    // ADDITIVE ONLY (G-12). A run admitted through a grace window may ADD to the
    // turn and close it — a legitimate follow-on or compaction replay does both —
    // but it may never OVERWRITE text another run already delivered. That is the
    // corruption the lot is about: an answer the user has read, replaced by
    // something else. Evaluated per frame, from the frame's own run.
    // The announced replay RESUMED on the run we already own: the hedge for a
    // rotating gateway is spent, and holding it open would admit any run of the
    // session for the rest of the turn (codex P1).
    if (
      this.replayExpected &&
      this.replaySameRun &&
      isString(frameRunId) &&
      frameRunId &&
      this.ownRunIds.has(frameRunId)
    ) {
      this.replayExpected = false;
      this.replaySameRun = false;
    }
    this.frameRunId = isString(frameRunId) && frameRunId ? frameRunId : "";
    this.frameRunAdopted =
      this.frameRunId !== "" && this.adoptedRunIds.has(this.frameRunId);
    if (isString(frameRunId) && frameRunId) {
      this.currentRunId = frameRunId;
    }

    // Own frame: refresh the silence budget and emit the deprecated passthrough
    // first, then the normalized interpretation.
    this.armRecv(now);
    if (!this.generationEvidence && Normalizer.provesGeneration(eventType, payload)) {
      this.generationEvidence = true;
    }
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
          // The cause, when WE are the cause: the pre-send guard compacted this
          // session moments ago and this rotation is that compaction's footprint.
          // One-shot — a later rotation we did not ask for stays cause-less rather
          // than inheriting this one.
          if (this.presendCompactionCause !== null) {
            events.push({
              type: EVENT_COMPACTION_CAUSE,
              reason: this.presendCompactionCause,
              completed: true,
              refusal: false,
            });
            this.presendCompactionCause = null;
          }
          // A session-id ROTATION is proof a compaction completed: clear any
          // standing overfull verdict.
          events.push({
            type: EVENT_SESSION_OVERFULL,
            overfull: false,
            observedAt: observedAtMs(now),
          });
        }
      }
    }
    const data = isObject(payload.data) ? payload.data : {};
    if (eventType === "session.operation") {
      this.handleSessionOperation(payload, events);
      return events;
    }
    if (eventType === "chat.side_result") {
      this.handleSideResult(payload, now, events);
    } else if (eventType === "chat") {
      this.handleChat(payload, data, now, events);
    } else {
      this.handleAgent(payload, data, now, events);
    }
    return events;
  }

  /**
   * `session.operation` — the gateway's OWN account of a compaction (W2 / G-09).
   *
   * It carries `{operationId, operation:"compact", phase:"start"|"end", completed?,
   * reason?}`. The `reason` is what Atrium never had: until now the cause was
   * inferred (a session-id rotation ⇒ "preflight"), and the marker shown to the
   * user implied a pre-emptive threshold compaction even when the real cause was
   * an OVERFLOW the session had already hit.
   *
   * This is now the PRIMARY source, with the rotation heuristic as the fallback —
   * the pattern the explicit compaction stream already established. It has to
   * stay a fallback: the event is broadcast with `dropIfSlow: true`, so a slow
   * consumer simply does not receive it, and its ABSENCE proves nothing.
   */
  // NOT CURRENTLY FED (2026-07-26). `session.operation` is delivered only to
  // connections that called `sessions.subscribe`, and subscribing on the
  // turn-serving socket cost conversation frames — proven by bisect on the live
  // bench (see the comment in session.ts). This handler stays because it is the
  // correct reader for the event and is covered by tests; it will be fed by the
  // dedicated session-events connection when that is built. Until then a
  // GATEWAY-decided compaction has no observable cause (that stream carries phase
  // and verdict only); the compactions ATRIUM performs label themselves through
  // `notePresendCompactionCause`.
  private handleSessionOperation(
    payload: JsonObject,
    events: BridgeEvent[],
  ): void {
    if (payload.operation !== "compact") return;
    if (payload.phase !== "end") return; // `start` says nothing about the cause
    const reason = bucketCompactionReason(payload.reason);
    if (reason === null) return;
    events.push({
      type: EVENT_COMPACTION_CAUSE,
      reason,
      completed: payload.completed === true,
      refusal: isCompactionRefusal(reason),
    });
  }

  /**
   * `chat.side_result` — content the AGENT produced, thrown away until now (G-18).
   *
   * The gateway emits it when a message is answered WITHOUT starting an agent run
   * (`!agentRunStarted && !queuedFollowupEnqueued`, verified in the deployed
   * 2026.7.1 build): the "by the way" reply goes out on this event, and the
   * `chat` final that immediately follows carries NO message. We dropped the
   * event at the type gate, so the turn saw only the empty final — 90 seconds of
   * grace, then `empty_response_silent` on a turn that HAD an answer.
   *
   * Admitted under the SAME barriers as `chat` (sessionKey above, runId above —
   * upstream sends the caller's own `clientRunId`) and applied ADDITIVELY: the
   * empty final that follows must be able to close the turn on this text.
   */
  private handleSideResult(
    payload: JsonObject,
    now: number,
    events: BridgeEvent[],
  ): void {
    const text = isString(payload.text) ? payload.text : "";
    if (!text.trim()) return;
    // Re-broadcasts reach this event too, and it bypasses the chat dedup: an
    // identical retransmission would deliver the same paragraph twice (codex P2).
    // Same memory, same LRU — keyed on the event's own identity.
    const dedupKey = JSON.stringify([
      "side_result",
      payload.runId ?? null,
      payload.kind ?? null,
      payload.ts ?? null,
      text,
    ]);
    if (this.seenDedupKeys.has(dedupKey)) {
      this.noteDedupKey(dedupKey);
      return;
    }
    this.noteDedupKey(dedupKey);
    if (payload.isError === true) {
      // A failure notice, NOT the reply. Applying it as reply text would close
      // the turn `complete` on an explicit upstream error (codex P2): the user
      // would read a failure as the agent's answer. Finalize as an error with
      // the notice as its message — the empty final that follows is then a no-op.
      events.push(
        ...this.finalize(
          now,
          "error",
          this.safeSanitizeText(text) || "The agent reported a failure.",
          null,
          "side_result_error",
        ),
      );
      return;
    }
    this.applyVisible(text, false, false, now, events);
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
    // The hand-off signal ALSO rides the terminal itself since 2026.9.1
    // (`ChatFinalEvent.yielded`, protocol/openclaw/2026.9.1/logs-chat.ts). Reading it
    // only off the lifecycle event meant that losing that one frame turned a legitimate
    // hand-off into an EMPTY response — and the empty-response guard retries, which can
    // repeat a sub-agent's work and its external effects (codex). Two carriers, one
    // meaning: whichever arrives is believed.
    if (isFinal && payload.yielded === true) this.sawYielded = true;
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
    // Remember a key ONLY when the frame carries a reliable identifier. Without
    // `seq` (documented for targeted broadcasts) the key is content alone, so a
    // legitimately repeated delta — "ha", "!", "ha" — would have its second
    // occurrence deleted as a re-broadcast (codex P1). Those frames keep the
    // ADJACENT-only rule the scalar slot always had; only seq-bearing frames get
    // the memory that closes the A,B,A replay.
    const hasSeq = typeof payload.seq === "number";
    if (hasSeq) {
      if (this.seenDedupKeys.has(dedupKey)) {
        // Refresh on the HIT too: a key that keeps being replayed is the most
        // recently seen, and letting it age out would re-admit it as new text.
        this.noteDedupKey(dedupKey);
        this.lastDedupKey = dedupKey;
        return; // exact re-broadcast: passthrough only, no normalized dup
      }
      this.noteDedupKey(dedupKey);
    } else if (dedupKey === this.lastDedupKey) {
      return;
    }
    this.lastDedupKey = dedupKey;

    // PROVIDER BACK-OFF (2026.9.4 `ChatStatusEvent.retry`). The run loop
    // re-enters the attempt (upstream run-loop.ts `while (true)`), and each
    // attempt's terminal re-emits lifecycle `finishing` — which this normalizer
    // turns into `post_processing`. So a rate-limited turn repeated
    // "post-processing" while the gateway's own UI showed "Retrying... 2/10":
    // a terminal-ish label for a turn that has not even reached the model.
    //
    // `retry` is present ONLY for `reason === "rate_limit"` (server-chat.ts
    // gates on it); any other back-off arrives as a bare `starting_model` and
    // stays invisible here. The richer `stream:"run_status"` agent event is the
    // fix for that case and is its own lot — this reads the field it is given.
    //
    // Best-effort by construction: the frame is sent with `dropIfSlow`, so an
    // attempt CAN be missed under backpressure. The label must therefore never
    // be treated as a count of what happened — only as what is happening now.
    if (state === "status") {
      const retry = payload.retry;
      if (isObject(retry)) {
        const attempt = retry.attempt;
        const maxAttempts = retry.maxAttempts;
        // The contract is INTEGERS in 1..10 (logs-chat.ts ChatStatusEventSchema), and
        // `typeof === "number"` admitted -1, 0 and 2.5 straight to the label (raised in
        // review). A counter that reads "2.5/1" is worse than no counter: it makes the
        // reader doubt the turn rather than the frame.
        if (
          Number.isInteger(attempt) &&
          Number.isInteger(maxAttempts) &&
          (attempt as number) >= 1 &&
          (maxAttempts as number) >= (attempt as number) &&
          (maxAttempts as number) <= RETRY_MAX_ATTEMPTS &&
          // The DISCRIMINANT is part of the contract: the schema declares
          // `reason: "rate_limit"` and nothing else. Accepting any object with two
          // plausible counters let a divergent frame say "provider is rate-limiting"
          // when it never claimed that (raised in review).
          retry.reason === "rate_limit"
        ) {
          // A BACK-OFF IS NOT SILENCE. The gateway may emit `finishing` before the
          // retry status, and this branch published the label and returned without
          // touching the 60 s promise — so a back-off longer than a minute closed the
          // turn as a SUCCESS while the provider was still retrying. Cancelled
          // WITHOUT the helper: the label belongs to the back-off, and a bare
          // `generating` would wipe the very counter this branch just published.
          this.cancelFinishingGrace(now);
          events.push({
            type: EVENT_TURN_PHASE,
            phase: "retrying",
            retry: { attempt, maxAttempts },
          });
          this.inRetryingPhase = true;
          return;
        }
        // The frame CLAIMS a back-off but does not satisfy the contract. That is a
        // divergent frame, not a resume: falling through to the clear made
        // `valid retry -> malformed retry` read as "the run resumed" (raised in
        // review). Ignore it and leave the label where it was.
        return;
      }
      // A BARE status is NOT proof of resume, and treating it as one was wrong.
      // Upstream projects the retries whose reason is `overloaded`, `server_error` or
      // `timeout` as `starting_model` with NO `retry` field (server-chat.ts) — so a
      // bare status can equally mean "still backing off, for another cause". Clearing
      // on it told the reader the wait was over while the provider was still refusing
      // (raised in review). The back-off ends on a real resume signal instead.
      // Every other status frame stays deliberately eventless: the startup
      // phases describe work Atrium does not render, and inventing a label for
      // them would replace the turn's real activity with gateway bookkeeping.
      return;
    }

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
        // Through the arbitration like the other terminals: an abort closes the sink
        // just as hard, and a reply the message-tool had really delivered — still
        // being read out of the transcript — was lost to it. The abort still arrives.
        this.finalizeOrHoldWith(now, events, (at) =>
          this.finalize(at, "aborted", null, null, "gateway_abort"),
        );
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
            : // The SHARED classifier (W2 / G-11) — the same one the sub-agent
              // path now uses. `provider_internal` is deliberately possible here
              // too: this is a DIAGNOSTIC field on a turn already closing
              // `complete`, so it cannot trigger a retry.
              classifyFailureText(reason ?? null);
        console.log(
          "[normalizer] chat:error AFTER the run ended — finalizing complete (post-reply gateway failure, see gateway_pressure trace)",
        );
        this.finalizeOrHoldWith(now, events, (at) => {
          const evs = this.finalize(at, "complete", null, null, "gateway_terminal");
          for (const e of evs) {
            if (e.type === "message.final") {
              (e as { diagnosticErrorKind?: string | null }).diagnosticErrorKind =
                diagKind;
            }
          }
          return evs;
        });
        return;
      }
      // ALLOWLIST the wire value against the schema enum before persisting it
      // as a trusted stable code (never a raw network string as errorCode).
      const kind =
        isString(payload.errorKind) &&
        CHAT_ERROR_KINDS.has(payload.errorKind)
          ? payload.errorKind
          : null;
      // Through the arbitration like the successes: an error terminal closes the
      // sink exactly as hard, and a reply the user was really sent — still being read
      // out of the transcript — was lost to it. Held, the error still arrives; it
      // arrives with the delivery beside it.
      const errorText = this.safeSanitizeText(reason) || "gateway error";
      this.finalizeOrHoldWith(now, events, (at) =>
        this.finalize(at, "error", errorText, kind, "gateway_error"),
      );
      return;
    }

    if (isFinal && isString(payload.stopReason)) {
      this.diagStopReason = bucketStopReason(payload.stopReason);
    }
    const snapshotText = textFromMessage(message);
    if (snapshotText) {
      if (
        isFinal &&
        snapshotText.endsWith(TRUNCATED_FINAL_MARKER) &&
        snapshotText.length - TRUNCATED_FINAL_MARKER.length >=
          TRUNCATED_FINAL_MIN_BODY
      ) {
        // The gateway CUT this reply for display (G-13). Show what arrived — a
        // cut answer beats a blank one — but do NOT close the turn on it: arm a
        // short grace so the transcript recovery can replace it with the full
        // text. `sawTruncatedFinal` is what makes that recovery eligible even
        // though the turn now holds "real" content.
        this.truncatedFinals++;
        if (this.truncatedFinals === 1) {
          console.warn(
            `[normalizer] chat final TRUNCATED by the gateway display projection (session=${this.sessionKey}, len=${snapshotText.length}) — recovering the full text from the transcript`,
          );
        }
        this.sawTruncatedFinal = true;
        this.applyVisible(snapshotText, true, false, now, events);
        if (!this.finalized) {
          // A lifecycle end may already have armed its 10 s follow-on grace, and
          // the recovery RPC alone is allowed 10 s: leaving it in place would
          // finalize the CUT text before the full one could arrive (codex P1).
          // This wait supersedes it — the turn has its terminal already, what it
          // is waiting for now is the complete text.
          this.clearWait("lifecycle_end");
          this.arm("truncated_final", now + TRUNCATED_FINAL_GRACE);
        }
        return;
      }
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
        this.applyVisible(deltaText, true, isFinal, now, events, true);
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
        this.finalizeOrHold(now, "gateway_final", events);
      } else if (this.sawYielded) {
        // A HAND-OFF, not a silence. The gateway said this turn passed the work on, so
        // there is no follow-on content to wait for: arming the 90s empty-final grace
        // left the turn showing as active for a minute and a half, which is exactly the
        // frame-loss case `ChatFinalEvent.yielded` exists to cover (codex).
        this.finalizeOrHold(now, "gateway_final", events);
      } else {
        this.arm("empty_final", now + EMPTY_FINAL_GRACE);
      }
    }
  }

  // -- agent (5.7 legacy + tool/lifecycle streams) --------------------------

  /** End the provider back-off on ANY sign the run resumed.
   *
   *  It used to fire on a bare `status` or on visible text only, and both can be
   *  absent: upstream treats `assistant`, `tool` and `item` as three equivalent
   *  resume signals, and the next attempt does NOT necessarily re-emit the startup
   *  statuses — `startupStagesEmitted` survives the retry `continue` upstream. A run
   *  that resumed by calling a tool therefore kept showing "retrying 2/10" (raised in
   *  review). Idempotent: the flag is consumed, so only the FIRST signal speaks. */
  private clearRetryingPhase(events: BridgeEvent[]): void {
    if (!this.inRetryingPhase) return;
    this.inRetryingPhase = false;
    // `onlyIfRetrying` matters: this flag means "a back-off was seen", not "the last
    // published phase is still the back-off". Something else can legitimately have
    // published `awaiting_approval` in between, and the bare `generating` clear —
    // shared with Hermes' resume signal — wipes whatever phase is stored. So the
    // clear names what it is allowed to remove (raised in review).
    events.push({ type: EVENT_TURN_PHASE, phase: "generating", onlyIfRetrying: true });
  }

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
      // ANY assistant frame is a resume upstream, including the ones that never reach
      // `applyVisible`: commentary returns early, and a media-only or empty-activity
      // frame carries no text at all. The clear lived in `applyVisible` alone, so a
      // run that came back speaking anything but final text kept the back-off label
      // (raised in review).
      this.clearRetryingPhase(events);
      const mediaUrls = data.mediaUrls;
      if (Array.isArray(mediaUrls)) {
        this.collectMedia(mediaUrls, events);
      }
      const text = data.text;
      const delta = data.delta;
      // PHASE (G-17). The gateway tags every assistant-stream payload
      // `commentary` | `final_answer` (`AssistantPhaseSchema`), and it emits the
      // model's PREAMBLE as `{text: <commentary>, replace: true,
      // phase: "commentary"}` — verified in the deployed 2026.7.1 build
      // (`buildAssistantStreamData` / `emitAssistantStreamDataSafely`).
      // We read neither field, so a preamble became the reply text AND locked
      // `hasSnapshot`, after which every delta of the REAL answer was dropped in
      // silence. A commentary is progress, never the answer: it is already
      // surfaced as a `stream:"item"` preamble, so it leaves the reply buffer
      // untouched here.
      const phase = isString(data.phase) ? data.phase : null;
      if (phase === "commentary") {
        this.commentaryFrames++;
        if (this.commentaryFrames === 1) {
          console.log(
            `[normalizer] assistant commentary kept OUT of the reply buffer (session=${this.sessionKey})`,
          );
        }
        return;
      }
      // `replace` is a REFRESH of the same answer, not a new authority: apply it
      // through the snapshot path (so the UI resyncs and Convex allows the
      // shrink) but do NOT lock snapshot precedence — more deltas follow. Same
      // rule the chat path already applies to `ChatDeltaEventSchema.replace`.
      const replace = data.replace === true;
      if (isString(text) && text) {
        // Full snapshot: replace and lock out later deltas/acks.
        this.applyVisible(text, true, false, now, events, replace);
        if (replace) this.hasSnapshot = false;
      } else if (isString(delta) && delta) {
        if (replace) {
          this.applyVisible(delta, true, false, now, events, true);
          this.hasSnapshot = false;
        } else {
          // Legacy 5.7 incremental: append verbatim (spaces are load-bearing).
          this.applyVisible(delta, false, false, now, events);
        }
      }
      return;
    }
    if (stream === "approval") {
      // G-21. The gateway asks a HUMAN to approve a command; Atrium has no
      // surface to answer, so the turn used to sit silent until the 240 s recv
      // timeout and settle as an unexplained empty response. Say what it is
      // waiting for, suspend the silence clock, and BOUND the wait.
      const phase = data.phase;
      if (phase === "requested") {
        // `toolCallId` first: it is the one id the resolution is guaranteed to carry.
        this.approvalsRequested += 1;
        const aliases = [data.toolCallId, data.approvalId].filter(isString);
        if (aliases.length > 0) {
          const record = aliases[0]!;
          this.pendingApprovalIds.add(record);
          for (const alias of aliases) this.approvalAliases.set(alias, record);
        } else this.anonymousApprovals += 1;
        this.clearWait("recv");
        // …AND THE FINISHING GRACE, for the same reason every other resumption
        // clears it: an approval request is proof the gateway is not silent. It
        // suspended the 240 s recv clock and bounded the wait at 900 s, but left the
        // 60 s finishing promise armed — so `finishing -> approval requested`
        // finalized the turn as a SUCCESS one minute later, while a human was still
        // being asked to authorise a command the gateway had not cancelled. Ordered
        // AFTER `approvalPending` is set so the helper keeps `awaiting_approval` and
        // does not publish `generating` over it.
        this.suspendFinishingGrace(now);
        this.arm("approval_wait", now + APPROVAL_WAIT);
        events.push({ type: EVENT_TURN_PHASE, phase: "awaiting_approval" });
      } else if (phase === "resolved") {
        // Explicitly released by the gateway (approved, denied or failed) — the
        // run resumes its normal cadence. `generating` CLEARS the stored phase.
        // THIS request, not every request. A second command can be waiting on its
        // own authorisation, and releasing it here would re-arm the finishing promise
        // and close the turn while a human still had a decision to make.
        this.releaseApproval(
          [data.toolCallId, data.approvalId].filter(isString),
          now,
          events,
        );
      }
      return;
    }
    if (stream === "plan") {
      // NATIVE work plan (G-22). The gateway emits it on its own stream — we had
      // no branch, so a plan the model maintained was invisible unless it also
      // went through the `update_plan` TOOL. Same PlanPart either way (shared
      // reader), and never a tool call: the turn's tool counters, and the
      // spawn/yield gates that read them, stay untouched.
      const planPart = planPartFromPlanStream(data);
      if (planPart !== null) {
        events.push({ type: EVENT_PLAN, plan: planPart, runId: this.currentRunId });
      }
      return;
    }
    if (stream === "error") {
      // The gateway's OWN loss diagnostic — not a turn failure. It tracks the
      // per-run `seq` of the agent events it forwards and, when it sees a hole,
      // tells us so on this stream (`{reason:"seq gap", expected, received}`,
      // pinned upstream by server-chat.agent-events.test.ts). We had NO branch
      // for it, so the single explicit signal that content was lost was
      // silently discarded — the user then saw a truncated reply with no
      // explanation, and we had nothing to diagnose with.
      // It must NEVER finalize the turn in error: the frames that DID arrive are
      // still valid, and the run continues. Content-free by construction
      // (two counters), so it is safe to trace.
      if (data.reason === "seq gap") {
        const expected = typeof data.expected === "number" ? data.expected : null;
        const received = typeof data.received === "number" ? data.received : null;
        events.push({
          type: EVENT_FRAME_GAP,
          source: "gateway",
          expected,
          received,
          missing:
            expected !== null && received !== null && received > expected
              ? received - expected
              : null,
          runId: this.currentRunId,
        });
      }
      // Any OTHER `stream:"error"` payload stays observe-only too: it is a
      // diagnostic channel, and an unknown shape must not be able to fail a turn.
      return;
    }
    if (stream === "compaction") {
      this.handleCompaction(data, now, events);
      return;
    }
    if (stream === "tool") {
      // Upstream's rule, not "any tool frame": a tool counts as progress only with a
      // call id and a recognised phase (server-chat-progress-snapshot.ts). A frame
      // that is not a resume must not end the back-off — `onlyIfRetrying` protects
      // OTHER phases from this clear, never the back-off itself (raised in review).
      if (isUpstreamToolProgress(data)) this.clearRetryingPhase(events);
      this.handleTool(payload, data, now, events);
      return;
    }
    if (stream === "lifecycle") {
      this.handleLifecycle(payload, data, now, events);
      return;
    }
    if (stream === "item") {
      // Same rule: only a PREAMBLE item is upstream's progress signal.
      if (data.kind === "preamble") {
        this.clearRetryingPhase(events);
        // A preamble is the gateway narrating work it is about to do — this file
        // already treats it as a progress signal, which is why it clears the
        // retrying phase. After a `finishing` it is therefore resumption too, on the
        // same footing as a tool start.
        //
        // NOT the `assistant` stream, deliberately, and the corpus says why: 461
        // assistant frames follow a `finishing` across the captures. That IS the
        // answer being written — the exact case where the grace's premise ("the
        // answer is already written") holds — so cancelling there would fire on
        // nearly every turn and give back the G-20 defect the 60 s bound exists to
        // fix. No capture exercises a preamble after a finishing; this branch is
        // reasoned from the signal's meaning here, not from an observed frame.
        this.noteGatewayResumedWork(events, now);
      }
      // 6.5 (bench-verified): the gateway-run message-tool surfaces ONLY as an
      // item frame {itemId, phase, kind:"tool", name:"message", title, status} —
      // no args, no result. The delivered text lives in the session transcript
      // alone. Flag it so the session loop can run the history recovery once
      // the turn ends up holding a bare ack (wantsHistoryRecovery below).
      if (data.kind === "tool" && data.name === "message") {
        this.sawMessageToolItem = true;
        // A `start` here is the tool BEGINNING to deliver, not proof it delivered:
        // the same reading every other tool start gets (see handleTool), and the
        // reason it matters is that this branch returns before the generic start
        // handling below. Without it, `finishing -> message start` kept the 60 s
        // promise armed over a tool that was still running.
        if (data.phase === "start") this.noteGatewayResumedWork(events, now);
        return;
      }
      // DELIVERY runs (sub-agent announce / task delivery) carry NO `tool`
      // stream frames — item frames are the only tool telemetry on the wire
      // (measured live, 2026.7.1 bench capture 2026-07-14). Derive the tool
      // card from the item's terminal frame (name + outcome; args/result do
      // not exist on these runs) so the turn's work is user-visible: the
      // deferred announce open then triggers and merges into the anchored
      // bubble instead of the whole tool-only turn being discarded as silent.
      // A DELIVERY RUN'S ONLY TOOL TELEMETRY IS THIS LANE — starts included.
      //
      // The branch below reads `phase === "end"` because that is where the card is
      // written. But a `start` here is still the gateway beginning new work, and it
      // is the ONLY such signal a delivery run emits: the production incident that
      // motivated the finishing-grace repair ran on exactly this lane, and a repair
      // placed only on the `tool` lane could never have caught it.
      if (
        (data.kind === "tool" || data.kind === "command") &&
        isString(data.name) &&
        data.name !== "" &&
        data.phase === "start"
      ) {
        this.noteGatewayResumedWork(events, now);
      }
      // Ordinary runs keep their exact tool-frame pipeline — never both.
      if (
        (data.kind === "tool" || data.kind === "command") &&
        isString(data.name) &&
        data.name !== "" &&
        isDeliveryRunId(this.currentRunId) &&
        data.phase === "end"
      ) {
        const itemStatus = isString(data.status) ? data.status : null;
        // `progress_card` (2026.8.1+) is NOT a tool card here: the gateway
        // already emits the native `plan` stream for every successful call, on
        // delivery runs too (measured 2026-09-02), so the card would only
        // duplicate it — and, worse, make a card-clearing call (plan stream
        // `steps: []`, deliberately invisible) reopen the bubble with a bare
        // tool card (codex P2). `update_plan` (<= 2026.7.x) keeps its card: on
        // that generation the card IS the only visible trace of the plan work.
        // Only a SUCCESSFUL progress_card is represented by a plan: the gateway
        // emits the plan stream under `!isToolError`, so a failed call has this
        // item as its only telemetry — its error card must surface (codex P2).
        if (!(data.name === "progress_card" && itemStatus === "completed")) {
          // THE REASON THE GATEWAY SENT, AND WE DROPPED.
          //
          // On a delivery run the item stream is the ONLY telemetry a tool gets —
          // there is no `tool` frame with its result — and this branch kept the
          // name and the phase and nothing else. So a failed tool showed a card
          // saying `sessions_yield — error` with no reason anywhere, on the one
          // lane where no other frame could supply it.
          //
          // The frame HAS the reason: `data.error`, captured in
          // golden/2026.9.1/spawn-parallel-merge.jsonl on a refused
          // `sessions_yield`. Production, 2026-09-21: an agent's yield was refused
          // twice, it carried on working, and neither the reader nor the diagnosis
          // could see why — the sentence was on the wire the whole time.
          //
          // Shaped like the payload an ordinary run carries (`jsonResult({status,
          // error})`, upstream tool-results.ts) so both lanes produce the SAME
          // thing: the card renders it the same way, and the readers that decide on
          // a tool's structured status (core/private-tool-args.ts,
          // convex/lib/toolOutcome.ts) work on a delivery run too instead of
          // falling back on the phase.
          //
          // SANITIZED TO PARITY, NOT BETTER — said plainly because the file's
          // header claims "never leak server paths to the browser" and that claim is
          // already imperfect here. `safeSanitizeText` returns text VERBATIM unless
          // it names `/home/node/.openclaw/` or a deliverable media root
          // (providers/openclaw/sanitize.ts), so an absolute path under any other
          // root — a real one seen in production: `Local media path is not under an
          // allowed directory: /tmp/…` — survives. The ordinary tool lane is wider
          // still: it persists `data.result` with no sanitization at all. So this
          // reaches the same exposure the other lane already has, and no more.
          // Closing it properly means sanitizing every tool payload, which is a lot
          // of its own and would destroy useful error text if done bluntly.
          const itemError = isString(data.error)
            ? this.safeSanitizeText(data.error)
            : null;
          events.push({
            type: EVENT_TOOL_STATUS,
            name: data.name,
            phase: itemStatus === "completed" ? "completed" : "error",
            ...(itemError !== null && itemError !== ""
              ? { output: { details: { status: "error", error: itemError } } }
              : {}),
            runId: this.currentRunId,
          });
        }
        // update_plan: the plan CONTENT never reaches a delivery run's wire
        // (the item meta only names the plan's first step) — emit the bare
        // "plan moved" signal; the sink counts them and Convex advances the
        // last known plan at turn end.
        // `update_plan` ONLY (<= 2026.7.x). Its successor `progress_card`
        // (2026.8.1+) also accepts markdown-only and clearing calls, which an
        // item frame — no args — cannot tell from a checklist update, so an
        // inferred advance could fake progress; and on 2026.8.x the gateway
        // emits the native `plan` stream on delivery runs too (measured live,
        // bench 2026-09-02: `stream:"plan"` on announce runs), so the real plan
        // reaches the wire through planPartFromPlanStream — inferring here
        // would advance it twice (codex P2).
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
      (this.sawMessageToolItem ||
        this.msgtoolUnreadableArgs > 0 ||
        this.sawTruncatedFinal) &&
      !this.recoveryAttempted &&
      // A truncated final IS content — incomplete content. It is the one case
      // where holding text must not stop the recovery.
      (!this.hasRealContent() || this.sawTruncatedFinal) &&
      (this.deadlines.has("private_ack") ||
        this.deadlines.has("history_recovery") ||
        this.deadlines.has("empty_final") ||
        this.deadlines.has("truncated_final"))
    );
  }

  /**
   * The recovery must bring back the FULL text: this turn holds a final the
   * gateway CUT (G-13). Only then may the caller fall back to the plain
   * assistant transcript entry — for the other triggers that entry is typically
   * the private ack ("Sent."), and persisting it would hide a lost reply behind
   * something that looks like an answer (codex P1).
   */
  get recoveryNeedsFullText(): boolean {
    return this.sawTruncatedFinal;
  }

  /** Mark the (single) recovery attempt as started so the loop never re-fires. */
  markRecoveryAttempted(now: number): number {
    this.recoveryAttempted = true;
    // The window that triggered this fetch BECOMES the recovery window.
    //
    // Two things were wrong with leaving it where it was. It must outlive the fetch:
    // `private_ack` is five seconds and `sessions.get` is given ten, so the ack grace
    // could finalize the turn on "Envoyé dans le webchat." while the real reply was
    // still on the wire. And it must be REACHABLE: resumed work cancels
    // `history_recovery`, and only that — so an ack grace left in place went on to
    // close the turn as a success over a tool that had been running for twelve
    // seconds. One deadline, cancellable, never shorter than the call it opens nor
    // than the grace it replaces (`truncated_final`'s twenty seconds are deliberate).
    let deadline = now + HISTORY_RECOVERY_GRACE;
    const causeOf: Record<string, FinalizeCause> = {
      private_ack: "private_ack_grace",
      empty_final: "empty_final_timeout",
      truncated_final: "truncated_final_grace",
    };
    for (const key of ["private_ack", "empty_final", "truncated_final"]) {
      const at = this.deadlines.get(key);
      if (at === undefined) continue;
      if (at > deadline) deadline = at;
      // The grace moves, its DIAGNOSIS does not: whoever reads the trace needs to
      // know which wait closed the turn, and "history_recovery_grace" everywhere
      // would erase the distinction the causes exist to draw.
      this.recoveryWindowCause = causeOf[key] ?? null;
      this.clearWait(key);
    }
    this.arm("history_recovery", deadline);
    return this.noteRecoveryDispatched();
  }

  /** A transcript fetch LEAVES now, holding the right to close the turn with what it
   *  brings back. Bound to the work-resume count of this instant: if work resumes
   *  before the answer lands, the right is gone — and a recovery dispatched AFTER
   *  that resumption gets its own, current, binding. Every dispatcher calls this,
   *  including the orphan/silence poll, which is a turn's ending by construction. */
  noteRecoveryDispatched(): number {
    const token = this.nextRecoveryToken++;
    this.recoveryAttempts.set(token, this.workResumeCount);
    // An attempt that never comes back would leak an entry; bound the map by the
    // same one-shot logic the turn already has — a handful of tokens at most.
    if (this.recoveryAttempts.size > 8) {
      const oldest = this.recoveryAttempts.keys().next().value;
      if (oldest !== undefined) this.recoveryAttempts.delete(oldest);
    }
    return token;
  }

  /** This fetch is OVER and brought nothing — superseded, failed, or empty.
   *
   *  A token that never resolves used to hold the arbitration's terminal back until
   *  the window expired, and on a dead socket no tick comes to expire it. Releasing
   *  is the dispatcher's own statement that nothing more is coming; the held terminal
   *  is then run by whatever next reaches the pipeline (the window, or the session's
   *  own end), because nothing outside it may emit events. */
  releaseRecoveryToken(token: number): void {
    this.recoveryAttempts.delete(token);
  }

  /** May the recovery now landing finalize the turn? Asked of ITS token, never of
   *  the newest one. A token this turn does not know (an untokenized caller, or one
   *  evicted) is believed: refusing would silently stop closing turns. */
  private recoveryMayClose(token: number | undefined): boolean {
    if (token === undefined) {
      // An untokenized caller is believed, and it answers for EVERY attempt: it
      // cannot say which one it is, so leaving the others "in flight" would hold the
      // turn open waiting for fetches nobody is going to report. Both real
      // dispatchers carry a token; this is the compatibility door.
      this.recoveryAttempts.clear();
      return true;
    }
    const mark = this.recoveryAttempts.get(token);
    this.recoveryAttempts.delete(token);
    return mark === undefined || mark === this.workResumeCount;
  }

  /** Frames of THIS turn may have been lost (the socket closed mid-turn, the pre-ack
   *  buffer refused a frame). Absences read from the stream stop proving anything. */
  noteStreamGap(): void {
    this.streamGap = true;
  }

  get streamGapNoted(): boolean {
    return this.streamGap;
  }

  /**
   * Whether an own frame shows that a run of this turn reached generation, or MAY have.
   *
   * Only the frames upstream sends while a run is still being PREPARED are excluded:
   * `chat` `state:"status"` and `agent` `stream:"run_status"` (measured on every run of
   * a full bench capture: nothing else precedes `lifecycle start`), plus the failure's
   * own terminals — a `chat` error and a `lifecycle` `error`/`end`, which a
   * pre-generation failure emits too. Everything else counts, unknown shapes included:
   * a wrong "yes" only costs an automatic retry, a wrong "no" could repeat work.
   */
  private static provesGeneration(eventType: string, payload: Record<string, unknown>): boolean {
    if (eventType === "chat") {
      return payload.state !== "status" && payload.state !== "error";
    }
    if (eventType !== "agent") return true;
    if (payload.stream === "run_status") return false;
    if (payload.stream === "lifecycle") {
      const phase = isObject(payload.data) ? payload.data.phase : undefined;
      return phase !== "error" && phase !== "end";
    }
    return true;
  }

  /** A writer-claim rebound on this turn struck before any run generated: no frame
   *  proving generation, on a stream with no known loss, no own-looking frame refused
   *  as foreign (it could have been this run's start), and no transcript recovery
   *  standing in for frames. Any doubt keeps the conservative class. */
  private writeReboundBeforeGeneration(): boolean {
    return (
      !this.generationEvidence &&
      !this.streamGap &&
      this.foreignRunRejections.size === 0 &&
      !this.recoveryAttempted
    );
  }

  /**
   * Apply transcript-recovered visible text as the authoritative answer and
   * close the turn (the chat final that armed the grace has already passed).
   * No-op once finalized (the grace may have flushed the ack meanwhile).
   */
  recoverVisibleText(text: string, now: number, token?: number): BridgeEvent[] {
    return stampReceived(this.recoverVisibleTextAt(text, now, token), now);
  }

  private recoverVisibleTextAt(
    text: string,
    now: number,
    token: number | undefined,
  ): BridgeEvent[] {
    if (this.finalized || !text) {
      return [];
    }
    const events: BridgeEvent[] = [];
    this.applyingRecovery = true;
    try {
      return this.applyRecoveredText(text, now, token, events);
    } finally {
      this.applyingRecovery = false;
    }
  }

  private applyRecoveredText(
    text: string,
    now: number,
    token: number | undefined,
    events: BridgeEvent[],
  ): BridgeEvent[] {
    const mayClose = this.recoveryMayClose(token); // consumes THIS token
    // Another fetch may still be on the wire: the mechanism supports several
    // attempts, and closing on the first arrival would refuse the later ones — the
    // loss this arbitration exists to prevent, reached by its own hand.
    const othersInFlight = this.recoveryAttempts.size > 0;
    // A terminal the gateway already delivered OWNS the close, with its own status,
    // cause and diagnosis. Finalizing generically here would throw all three away.
    const heldTerminal =
      this.pendingFinal !== null && this.pendingFinalMark === this.workResumeCount;
    if (mayClose) {
      this.hasVisibleToolText = true;
      this.applyVisible(text, true, !heldTerminal && !othersInFlight, now, events);
      return this.runHeldTerminal(now, events, othersInFlight, heldTerminal);
    }
    // Work resumed while this fetch was on the wire. What came back is an OLDER
    // delivery, and the run that resumed is writing the answer the user will read.
    if (
      holdsDelivery(this.text, text) ||
      this.recoveredTails.some((held) => holdsDelivery(held, text))
    ) {
      // We already hold this exact delivery — the only case where dropping loses
      // nothing. Dropping merely BECAUSE the live run has content was wrong: the
      // recovered reply really was delivered to the user, and it then vanished from
      // Atrium entirely.
      console.log(
        `[recovery] DROPPED (session=${this.sessionKey}) — the delivered text is already in this turn's reply`,
      );
      return this.runHeldTerminal(now, events, othersInFlight, heldTerminal);
    }
    // Held for the terminal, not written into the live stream. The turn stays open
    // and ends by its own path; the delivered reply is materialised then.
    console.log(
      `[recovery] HELD for the terminal (session=${this.sessionKey}) — work resumed while the transcript fetch was in flight`,
    );
    this.hasVisibleToolText = true;
    // MERGED, never overwritten. A scalar lost a delivery outright: a compaction
    // replay re-arms the recovery, and a second revoked result whose transcript is
    // not a superset of the first replaced it — A had really been sent, and vanished.
    this.noteRecoveredTail(text);
    return this.runHeldTerminal(now, events, othersInFlight, heldTerminal);
  }

  /**
   * Run the terminal that was waiting on the transcript — once nothing is left on
   * the wire, and only while the gateway has not gone back to work since.
   */
  private runHeldTerminal(
    now: number,
    events: BridgeEvent[],
    othersInFlight: boolean,
    heldTerminal: boolean,
  ): BridgeEvent[] {
    if (!heldTerminal) {
      // Work that resumed AFTER that terminal revokes it: the gateway said it was
      // done and then went back to work, so the turn ends by its own path.
      this.pendingFinal = null;
      return events;
    }
    if (othersInFlight) return events; // its window still bounds the wait
    const run = this.pendingFinal!;
    this.pendingFinal = null;
    this.clearWait("history_recovery");
    events.push(...run(now));
    return events;
  }

  /** Hold one recovered delivery for the terminal, merged monotonically. */
  private noteRecoveredTail(text: string): void {
    // A segment is replaced only by one that demonstrably CONTINUES it (same
    // prefix), never by one that merely contains it somewhere: a delivery "OK" is
    // not the same reply as one that happens to contain "TOKEN".
    const extended = this.recoveredTails.findIndex((held) => text.startsWith(held));
    if (extended >= 0) {
      this.recoveredTails[extended] = text;
    } else if (this.recoveredTails.length >= Normalizer.MAX_RECOVERED_TAILS) {
      // NAMED, never silent: evicting one would drop a reply the user received, and
      // so would dropping this one quietly. Sixteen independent revoked recoveries
      // in a single turn has never been observed; if it happens, the trace says so.
      console.warn(
        `[recovery] held-delivery cap reached (session=${this.sessionKey}) — this recovered reply is NOT materialised`,
      );
    } else {
      this.recoveredTails.push(text);
    }
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
        // Same reading as every other tool start (see the `else` branch below): the
        // gateway BEGINNING to send is work, and this branch returns before that
        // one. A no-op on the ordinary order, where the message precedes the
        // `finishing` and there is no promise to cancel.
        this.noteGatewayResumedWork(events, now);
        const { text: visible, unreadable } = this.messageToolText(data.args);
        if (visible) {
          this.hasVisibleToolText = true;
          this.applyVisible(visible, true, false, now, events);
        } else if (unreadable) {
          // The reply mechanism ran and we cannot read what it sent. LOUD, once
          // per turn: silence here is exactly how a turn ended blank with no
          // trace of why. Recovery from the transcript is the same path the
          // gateway-run message tool already uses.
          this.msgtoolUnreadableArgs++;
          if (this.msgtoolUnreadableArgs === 1) {
            console.warn(
              `[normalizer] message-tool args UNREADABLE (session=${this.sessionKey}) — the reply text may be lost; falling back to transcript recovery`,
            );
          }
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
        // A TOOL START AFTER "FINISHING" IS PROOF THE GATEWAY WENT BACK TO WORK.
        //
        // The same reasoning the compaction branch already states — "a compaction in
        // flight is proof the gateway is not silent" — and it was never applied to
        // ordinary work. `lifecycle_finishing` promises a terminal within 60 s and,
        // on expiry, closes the turn as `final`: a SUCCESS, on the premise written
        // there that "the answer is already written". That premise fails outright
        // when the gateway resumes: production, 2026-09-21 — the agent's
        // `sessions_yield` was REFUSED, so it carried on with forty more `exec` and
        // `sessions_history` calls. A single `exec` longer than the grace looks
        // exactly like silence, the 60 s fired, and Atrium settled the bubble as
        // finished — with no text — while the gateway worked another seventeen
        // minutes and the Control UI showed the run plainly still going.
        //
        // Cleared on the START only, never on a result: a straggler result for a
        // tool that began BEFORE the finishing is the tail of the turn, and dropping
        // the bound for it would give back the very defect the 60 s grace exists to
        // fix (G-20). A start is new work, and unambiguous. The turn then falls back
        // to the ordinary silence budget, which activity refreshes and whose expiry
        // opens recovery instead of declaring success.
        this.noteGatewayResumedWork(events, now);
        if (toolCallId) {
          if (
            !this.capReached(
              "toolArgs",
              this.toolArgs.size,
              Normalizer.MAX_TOOL_ARGS,
            )
          ) {
            this.toolArgs.set(toolCallId, data.args);
          }
          events.push({
            type: EVENT_TOOL_STATUS,
            name: name ?? null,
            phase: "start",
            toolCallId,
            // Sanitized on EVERY phase, not just the terminal one. The sink writes
            // a card for `start` too, so an acknowledgment carrying a `MEDIA:`
            // directive or an absolute `/home/node/.openclaw/...` path reached the
            // database and the screen on the start frame, to be replaced only when
            // the result landed — and if the turn died first, or the anti-spinner
            // guard re-wrote the open card, the raw value was what stayed.
            input:
              name === "sessions_yield"
                ? (this.sanitizeYieldAcknowledgment(data.args) ?? undefined)
                : (data.args ?? undefined),
            runId: this.currentRunId,
          });
        }
        // No toolCallId: keep the coalesced single-card behavior (no orphan).
      } else if (isToolProgressPhase(phase)) {
        // PROGRESS, not completion. The pre-1.0 code treated EVERY non-start
        // phase as terminal, so a mid-execution `update` closed the card as
        // "completed" AND consumed the buffered args — the real `result` then
        // landed without its input, and the turn's tool count was inflated
        // (which in turn defeated the spawn/yield gates in turn-sink). Proved by
        // execution against this normalizer. Upstream v2026.7.1 emits exactly
        // four phases on `stream:"tool"` (enumerated from every emission site:
        // start ×62, result ×28, update ×3, chunk ×1) and the completion ALSO
        // rides the `item` stream as `phase:"end"`, which we consume separately.
        // Keep the card LIVE and the args buffered; a progress frame is a
        // keep-alive, so refresh the silence budget like any other activity.
        this.armRecv(now);
        if (toolCallId) {
          events.push({
            type: EVENT_TOOL_STATUS,
            name: name ?? null,
            phase: "start", // the card stays in its running state
            toolCallId,
            // Same rule on a progress frame — it re-emits the buffered args.
            input:
              name === "sessions_yield"
                ? (this.sanitizeYieldAcknowledgment(
                    this.toolArgs.get(toolCallId) ?? data.args,
                  ) ?? undefined)
                : (this.toolArgs.get(toolCallId) ?? data.args ?? undefined),
            runId: this.currentRunId,
          });
        }
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
          // The hand-off's waiting reply becomes visible text downstream, so it is
          // sanitized like text. `sessions_yield` only — see the method's note.
          input:
            name === "sessions_yield"
              ? (this.sanitizeYieldAcknowledgment(input) ?? undefined)
              : (input ?? undefined),
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
      // Between-turns (threshold) compaction: nothing to guard on a finished
      // turn — the next turn's preflight rotation detector reports a SUCCESS on
      // its own message. But a FAILURE has no such fallback (the rotation only
      // happens when the compaction worked), and it is exactly the state the
      // next turn inherits: record the verdict, which is chat-scoped and needs
      // no active turn (codex P2).
      // (Between turns the RUN MANAGER routes this — the frame's background run
      // is foreign to the admission policy, so it never reaches us here. Kept
      // for the case where our own run is finalized but its frames still flow.)
      if (compactionFailedForGood(data)) {
        events.push({
          type: EVENT_SESSION_OVERFULL,
          overfull: true,
          observedAt: observedAtMs(now),
        });
      }
      return;
    }
    // A HOOK RELAY IS NOT A COMPACTION EVENT — not for the verdict, and not for the state
    // machine either. Upstream reuses this stream to forward whatever a
    // `before_compaction`/`after_compaction` hook printed, as `{phase:"start"|"end",
    // messages}`. Left to fall through, a plugin's text STARTED a compaction here (widening
    // the silence budget and suspending the finishing grace) or ENDED one (closing that
    // budget and re-arming the grace) — state changes nothing in the gateway had made.
    // Found by grepping for every place a compaction decision is recomposed, after a review
    // showed the verdict itself had two copies.
    if (isCompactionHookRelay(data)) return;
    const phase = data.phase;
    if (phase === "start") {
      this.explicitCompaction = "active";
      // A NEW compaction attempt must earn its own admission proof.
      this.replayExpected = false;
    this.replaySameRun = false;
      this.compactionPending = true; // widened recv budget while the gateway summarizes
      this.armRecv(now);
      // A COMPACTION IN FLIGHT IS PROOF THE GATEWAY IS NOT SILENT.
      //
      // `lifecycle_finishing` bounds one thing: the gateway said it was finishing and
      // then said nothing more. It fires after 60 s and closes the turn as `final`.
      // But a compaction gets a 900-second door (`compactionPending`, right above), so
      // the two deadlines disagree by a factor of fifteen — and the shorter one wins,
      // closing the turn as finished while the gateway is demonstrably still
      // summarizing. Nothing else cleared this wait: only the real terminal and a new
      // run did.
      //
      // SUSPENDED, not disarmed. Clearing it outright looked safe because the recv
      // deadline just armed is wider — but when the compaction SETTLES without a replay,
      // `compactionPending` goes back to false and the recv budget narrows to normal,
      // and a recv expiry does not finalize: it opens the recovery path and leaves the
      // turn running. So `finishing -> start -> end -> silence` silently lost the 60 s
      // bound that `finishing` had explicitly established (raised in review). The wait is
      // remembered here and re-armed at the real end.
      this.suspendFinishingGrace(now);
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
      // `completed` is the gateway's own verdict on whether the compaction
      // actually produced a result (upstream: `completed: hasResult &&
      // !wasAborted`). It was ignored, so a FAILED compaction was indistinguishable
      // from a successful one — the run went back to its normal silence budget with
      // a session that had not shrunk, and the next turn hit the context wall with
      // no prior signal (the recurring production symptom). A failure that will NOT
      // be retried is the actionable one: name it.
      // THE SHARED RULE, not a second copy of it. This line used to recompute
      // `completed === false && willRetry !== true` inline while the between-turns path
      // called `compactionFailedForGood` — so the hook-relay guard added to that function
      // simply did not exist here, and a relay carrying `completed:false` still raised
      // `session.overfull` on the active path. The verdict file says in its own header
      // that two copies would drift; there were two (raised in review).
      //
      // NOT provable by a test any more, and that is worth saying: the hook-relay
      // short-circuit above now intercepts the only frames on which the two formulations
      // differ, so putting the rule back inline here would keep every test green. The
      // delegation is kept because one rule with one home is how the next divergence is
      // avoided — not because a red test is holding it in place.
      const failedForGood = compactionFailedForGood(data);
      if (failedForGood) {
        events.push({ type: EVENT_CONTEXT_COMPACTION, phase: "failed" });
      }
      // The VERDICT the NEXT turn inherits (G-08). Emitted on BOTH outcomes: a
      // later compaction that actually completed has to be able to clear a
      // warning an earlier failure raised, and the success path deliberately
      // adds no thread marker of its own (codex P2).
      // Stamped from the FRAME's own receipt (codex P2): the sink would
      // otherwise substitute its later write time, and a verdict observed before
      // a session reset would slip past the reset fence and warn the fresh one.
      if (compactionCompleted(data)) {
        events.push({
          type: EVENT_SESSION_OVERFULL,
          overfull: false,
          observedAt: observedAtMs(now),
        });
      } else if (failedForGood) {
        events.push({
          type: EVENT_SESSION_OVERFULL,
          overfull: true,
          observedAt: observedAtMs(now),
        });
      }
      if (data.willRetry === true) {
        // Overflow replay in flight on the same run: stay in the widened
        // budget; resumed content restores the normal one. The gateway has now
        // ANNOUNCED a replay, so a new runId carrying it is admissible (G-12) —
        // this path normally keeps the same run, but the announcement is exactly
        // the proof the policy asks for and older gateways may rotate.
        this.replayExpected = true;
        this.replaySameRun = true; // upstream continues on the SAME run
        this.armRecv(now);
        // The replay SUPERSEDES the deferred terminal: the run is producing again, so
        // the `finishing` promise this compaction suspended no longer stands and must
        // not be re-armed by a LATER compaction. Leaving the flag set did exactly that —
        // a 60 s grace resurrected for a turn that had gone back to work.
        this.finishingSuspended = false;
      } else {
        // Compaction settled with no replay (threshold/manual): the run
        // resumes its normal cadence.
        this.compactionPending = false;
        this.armRecv(now);
        // …and the finishing bound this compaction suspended comes back with it. The
        // gateway said it was finishing before it compacted; having finished compacting
        // it owes a terminal, and that promise is what the 60 s grace holds it to.
        this.rearmFinishingIfReleased(now);
      }
    }
  }

  /**
   * The gateway said it was FINISHING and then started new work.
   *
   * `lifecycle_finishing` promises a terminal within 60 s and, on expiry, closes the
   * turn as `final` — a SUCCESS — on the premise stated there that "the answer is
   * already written". A tool STARTING after that says the gateway went back to work,
   * so the premise is void and the bound must go: the turn falls back to the ordinary
   * silence budget, which activity refreshes and whose expiry opens recovery instead
   * of declaring success.
   *
   * BOTH LANES. The first version of this lived in the tool-frame handler alone — and
   * a DELIVERY run receives no `tool` frames at all, only `item` ones. That is exactly
   * the lane the production incident ran on (an `announce:requester-settle:` turn), so
   * the repair missed the case that produced it, and the test that "proved" it used the
   * ordinary lane.
   *
   * The SUSPENDED flag is cleared too: while a compaction holds the grace,
   * `deadlines` no longer carries it, and leaving the flag set let the compaction's
   * exit re-arm a 60 s bound for a turn that had demonstrably gone back to work.
   */
  /**
   * Give the finishing promise back — but only once NOBODY still holds it.
   *
   * `finishingSuspended` is one boolean standing for two holders: a compaction in
   * flight and an approval awaiting a human. Each release site used to consume it on
   * its own, so with `approval requested -> compaction start -> finishing` the FIRST
   * holder to let go armed a 60 s deadline while the other was demonstrably still
   * working — closing the turn as a success mid-compaction or mid-approval. A shared
   * flag needs a shared release.
   */
  private rearmFinishingIfReleased(now: number): void {
    if (!this.finishingSuspended) return;
    if (this.humanWaitPending() || this.compactionPending) return;
    this.finishingSuspended = false;
    this.arm("lifecycle_finishing", now + LIFECYCLE_FINISHING_GRACE);
  }

  /** Consume the finishing promise, saying whether there was one. PURE — it never
   *  touches the label, because the callers disagree about what the turn should then
   *  be called: a resumption says `generating`, an approval says `awaiting_approval`,
   *  a provider back-off says `retrying`. */
  private cancelFinishingGrace(now: number): boolean {
    // The recovery window IS the finishing promise, in its second act: the grace
    // expired and handed its remaining time to the transcript fetch. Work resuming
    // ends both, or the twelve seconds become a shorter road to the same wrong
    // success the sixty were.
    const recovering = this.deadlines.has("history_recovery");
    if (recovering) this.clearWait("history_recovery");
    // …and every OTHER synthetic success this turn is holding. `empty_final` waits
    // 90 s for content after a blank final and then closes the turn as a success: a
    // tool that started in between makes that premise false exactly as it does for
    // the finishing promise, and the turn could no longer be completed by what the
    // tool went on to produce. `lifecycle_end` is the same shape. The silence budget
    // is the right home for a turn whose gateway is demonstrably working: its expiry
    // opens recovery instead of declaring an answer.
    const hadTerminalGrace =
      this.deadlines.has("empty_final") || this.deadlines.has("lifecycle_end");
    if (hadTerminalGrace) {
      this.clearWait("empty_final");
      this.clearWait("lifecycle_end");
      this.armRecv(now);
    }
    const hadPromise =
      this.deadlines.has("lifecycle_finishing") || this.finishingSuspended;
    // Only a promise we actually tore down revokes the authority — and only then is
    // there a question to answer. A recovery dispatched with no promise in the first
    // place (the connection died mid-turn) is the turn's ending, and must stay
    // allowed to say so.
    // Unconditional: every caller here is proof the gateway went back to work, and
    // an in-flight fetch must lose its right to close whatever this call finds armed.
    // Safe to count freely now that each attempt carries its own token — a recovery
    // dispatched AFTER the resumption binds the new count and keeps its authority.
    this.workResumeCount += 1;
    if (!hadPromise) {
      return recovering;
    }
    this.clearWait("lifecycle_finishing");
    this.finishingSuspended = false;
    return true;
  }

  /**
   * Release ONE approval named by any of its aliases (`toolCallId`, `approvalId`), and
   * the turn with it once nobody else holds it. Shared by the gateway's own
   * `approval:resolved` frame and by an answer given from Atrium — the latter because
   * an exec approval's allow is carried by a follow-up run, not by a `resolved` frame
   * on the run that asked, so without it the turn would sit until `approval_wait`.
   */
  private releaseApproval(aliases: string[], now: number, events: BridgeEvent[]): void {
    const record = aliases
      .map((alias) => this.approvalAliases.get(alias))
      .find((found) => found !== undefined);
    if (record !== undefined) {
      this.pendingApprovalIds.delete(record);
      for (const [alias, target] of this.approvalAliases) {
        if (target === record) this.approvalAliases.delete(alias);
      }
    } else if (
      this.anonymousApprovals > 0 &&
      aliases.length === 0
    ) {
      // An unnamed request answered by an unnamed resolution — the only pairing
      // a count can justify. A NAMED resolution that matches no alias is a
      // request whose `requested` we never saw; spending the anonymous token on
      // it would release an approval a human is demonstrably still holding.
      this.anonymousApprovals -= 1;
    }
    // A resolution that correlates with NOTHING releases nothing: it is either a
    // request whose `requested` frame we never saw — in which case there is
    // nothing of ours to release — or a stray, and treating it as "release
    // everything" is how one answer used to close a turn over someone else's
    // still-pending authorisation. The 900 s `approval_wait` remains the bound,
    // and it ends with a NAMED cause rather than a silent success.
    if (this.approvalPending()) return; // someone else is still waiting
    this.clearWait("approval_wait");
    // The last approval is answered, but a QUESTION may still hold the turn: its
    // own bound (question_wait) and label stay in charge.
    if (this.humanWaitPending()) {
      events.push({ type: EVENT_TURN_PHASE, phase: "awaiting_input" });
      return;
    }
    this.armRecv(now);
    // …and the finishing promise this approval suspended comes back with it: the
    // gateway said it was finishing before it asked, so having been answered it
    // owes a terminal. Only if no OTHER holder still has it.
    this.rearmFinishingIfReleased(now);
    events.push({ type: EVENT_TURN_PHASE, phase: "generating" });
  }

  /** An approval of this turn was settled OUTSIDE the frame stream (answered from
   *  Atrium, or its resolved broadcast). No-op for an id this turn never asked. */
  noteApprovalSettled(approvalId: string, now: number): BridgeEvent[] {
    if (this.finalized || !this.approvalAliases.has(approvalId)) return [];
    const events: BridgeEvent[] = [];
    this.releaseApproval([approvalId], now, events);
    return stampReceived(events, now);
  }

  /** Is a human still being asked to authorise something? */
  private approvalPending(): boolean {
    return this.pendingApprovalCount() > 0;
  }

  /** Is a human being asked ANYTHING — to authorise a command, or to answer a
   *  question? Every site that asks "may this turn be closed now?" asks this, not the
   *  approval-only form: a question blocks the run exactly as an approval does. */
  private humanWaitPending(): boolean {
    return this.approvalPending() || this.pendingQuestionIds.size > 0;
  }

  /**
   * A human is being asked a question by THIS turn's run.
   *
   * `expiresInSec` is the time left before the GATEWAY gives up on it (computed by the
   * caller from the record's epoch deadline — this clock is not an epoch). Like an
   * approval it suspends the silence clock and borrows the finishing promise; unlike
   * an approval its expiry is NOT a verdict: at its deadline the gateway unblocks the
   * tool with "no answer" and the agent carries on, so the turn goes back to its
   * ordinary budget rather than ending.
   */
  noteQuestionRequested(id: string, expiresInSec: number | null, now: number): BridgeEvent[] {
    if (this.finalized) return [];
    const fresh = !this.pendingQuestionIds.has(id);
    this.pendingQuestionIds.add(id);
    this.clearWait("recv");
    if (fresh) this.suspendFinishingGrace(now);
    const wait =
      expiresInSec !== null && Number.isFinite(expiresInSec) && expiresInSec > 0
        ? Math.min(expiresInSec, QUESTION_WAIT_MAX)
        : QUESTION_WAIT_DEFAULT;
    const until = now + wait + QUESTION_WAIT_MARGIN;
    const current = this.deadlines.get("question_wait");
    // Several questions: the turn waits for the LAST deadline among them.
    this.arm("question_wait", current !== undefined && current > until ? current : until);
    this.arm("human_beat", now + HUMAN_WAIT_BEAT);
    return stampReceived([{ type: EVENT_TURN_PHASE, phase: "awaiting_input" }], now);
  }

  /** The question was answered, cancelled or expired (the gateway's own verdict). */
  noteQuestionSettled(id: string, now: number): BridgeEvent[] {
    if (!this.pendingQuestionIds.delete(id)) return [];
    if (this.finalized || this.pendingQuestionIds.size > 0) return [];
    this.clearWait("question_wait");
    if (!this.approvalPending()) this.clearWait("human_beat");
    if (this.approvalPending()) {
      return stampReceived([{ type: EVENT_TURN_PHASE, phase: "awaiting_approval" }], now);
    }
    this.armRecv(now);
    this.rearmFinishingIfReleased(now);
    return stampReceived([{ type: EVENT_TURN_PHASE, phase: "generating" }], now);
  }

  /** Is a question of this turn still waiting on a human? */
  get questionPending(): boolean {
    return this.pendingQuestionIds.size > 0;
  }

  /** HOW MANY — content can stand in for a resolution only when there is exactly
   *  one request it could possibly be answering. */
  private pendingApprovalCount(): number {
    return this.pendingApprovalIds.size + this.anonymousApprovals;
  }

  /** Every pending approval is released — the turn ended, or real content proved the
   *  run resumed. A content resume cannot name WHICH request was answered, so it
   *  answers all of them; that is the same reading the compaction release makes. */
  private clearApprovals(): void {
    this.pendingApprovalIds.clear();
    this.approvalAliases.clear();
    this.anonymousApprovals = 0;
  }

  /**
   * HOLD the finishing promise instead of destroying it.
   *
   * A resumption CANCELS it — the gateway went back to work and owes nothing. A
   * holder (a compaction, an approval) only borrows it: when the holder lets go the
   * gateway still owes the terminal it announced. Cancelling outright at
   * `approval:requested` left `rearmFinishingIfReleased` with nothing to give back,
   * so `finishing -> requested -> resolved` dropped the 60 s bound for good and fell
   * through to the 240 s recovery.
   */
  private suspendFinishingGrace(now: number): void {
    if (this.cancelFinishingGrace(now)) this.finishingSuspended = true;
  }

  private noteGatewayResumedWork(events: BridgeEvent[], now: number): void {
    if (!this.cancelFinishingGrace(now)) return;
    // …AND THE LABEL MUST STOP SAYING "Finishing up…" — unless something with a
    // stronger claim on it is already speaking.
    //
    // A bare `generating` wipes WHATEVER phase is stored; this file learned that once
    // already and answered it with a qualifier (`clearRetryingPhase`, just above).
    // The case here is approval: the gateway is asking a human to authorise a
    // command, the turn is legitimately labelled `awaiting_approval`, and a tool
    // starting must not erase that — least of all while `approvalPending` is still
    // true and nothing has released it.
    if (this.humanWaitPending() || this.inRetryingPhase) return;
    //
    // `finishing` publishes `post_processing`, and the only thing that took it back
    // to `generating` was a new lifecycle `start` — gated on the very deadline this
    // helper removes. So cancelling the grace silently disarmed the reset too, and
    // the turn kept telling the reader it was wrapping up for the whole resumed
    // stretch. A lot whose point is to stop misreporting a turn's state cannot leave
    // its label lying; the cancellation and the label are one fact and move together.
    events.push({ type: EVENT_TURN_PHASE, phase: "generating" });
  }

  private handleLifecycle(_payload: JsonObject, data: JsonObject, now: number, events: BridgeEvent[]): void {
    const phase = data.phase;
    // TERMINAL METADATA (G-20). Upstream ships these on every deferred terminal
    // (`DEFERRED_TERMINAL_METADATA_KEYS`, verified in the deployed build) and we
    // read none of them: a run killed by the provider timeout was
    // indistinguishable from one that simply finished. Absent on a NOMINAL end —
    // `buildLifecycleTerminalMeta` returns nothing unless the run timed out or
    // was aborted — so every read is guarded.
    if (phase === "finishing" || phase === "end" || phase === "error") {
      if (isString(data.stopReason)) {
        this.diagStopReason = bucketStopReason(data.stopReason);
      }
      if (isString(data.timeoutPhase)) {
        this.diagTimeoutPhase = bucketTimeoutPhase(data.timeoutPhase);
      }
      if (typeof data.providerStarted === "boolean") {
        this.diagProviderStarted = data.providerStarted;
      }
      if (data.aborted === true) this.diagAborted = true;
      // The gateway's OWN hand-off signal, and the PRIMARY one: the
      // `sessions_yield` tool heuristic stays as the multi-version fallback
      // (same pattern as the explicit compaction stream vs `abandoned`).
      if (data.yielded === true) this.sawYielded = true;
    }
    if (phase === "finishing") {
      // PRE-terminal, never a terminal: the run produced everything it will
      // produce and the real `end` follows. Say so instead of going silent, and
      // bound the wait — 240 s of nothing was the whole defect.
      //
      // SYMMETRIC with the compaction handler, and the asymmetry was a real hole: that
      // side suspends the grace when a compaction starts AFTER a `finishing`, but this
      // side armed it unconditionally, so `compaction start -> finishing -> silence`
      // closed the turn at 60 s while the gateway was still summarizing — the same
      // defect from the other end, and nothing upstream forbids that order (raised in
      // review). While a compaction is pending the promise is RECORDED, not armed; the
      // compaction's own exit arms it.
      // …AND SYMMETRIC FOR APPROVAL TOO, which is the same hole one step further.
      // The comment above records that arming unconditionally was wrong for a
      // compaction already in flight; an approval already pending is no different.
      // `requested -> finishing` armed the 60 s promise AND replaced the
      // `awaiting_approval` label with `post_processing`, so the turn settled as a
      // success one minute later while a human was still being asked. The promise is
      // RECORDED in both cases and re-armed when the holder releases.
      if (this.compactionPending || this.humanWaitPending()) {
        this.finishingSuspended = true;
      } else {
        this.arm("lifecycle_finishing", now + LIFECYCLE_FINISHING_GRACE);
      }
      // The label only moves when nothing with a stronger claim holds it.
      if (!this.humanWaitPending()) {
        events.push({ type: EVENT_TURN_PHASE, phase: "post_processing" });
      }
      return;
    }
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
      // Through the arbitration, like `chat:error`: this terminal closes the sink
      // just as hard, and the message-tool reply still being read out of the
      // transcript was lost to it. The error survives; so does the delivery.
      this.finalizeOrHoldWith(now, events, (at) =>
        this.finalize(at, "error", message, kind, "gateway_error"),
      );
      return;
    }
    if (phase === "end") {
      this.clearWait("lifecycle_finishing"); // the real terminal arrived
      // …and nothing may re-arm it — UNLESS this end is not the terminal at all. When a
      // compaction is active, the `abandoned` branch below hands the turn back to the
      // compaction machinery and returns; dropping the suspension here meant the real
      // `compaction end` could no longer restore the 60 s bound, and
      // `finishing -> start -> abandoned end -> compaction end -> silence` was left
      // holding nothing (raised in review).
      const compactionGoverns =
        data.livenessState === "abandoned" && this.explicitCompaction === "active";
      if (!compactionGoverns) this.finishingSuspended = false;
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
        // The gateway ABANDONED the run to replay it: a new runId for THIS turn
        // is now expected, which is the positive proof the admission policy
        // requires (G-12). Without it, `compactionPending` alone would hold a
        // 900-second door open for any run of the session.
        this.replayExpected = true;
        this.replaySameRun = false; // the gateway restarts on a NEW runId here
        this.resetForCompaction(now);
        // The abandoned run's deltas/snapshot are ALREADY persisted in Convex;
        // resetForCompaction only clears the normalizer's internal buffers. Emit
        // an empty snapshot so the sink CLEARS that stale liveText too — otherwise
        // a replay that yields no new text would let stream.finalize fall back to
        // the invalidated prefix. The replay refills it when real text resumes.
        events.push({ type: EVENT_MESSAGE_SNAPSHOT, text: "", replace: true });
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
      // A new run STARTS after a deferred terminal: the "Finishing up…" label
      // belongs to the run that just ended. Nothing else clears a phase — deltas
      // do not — so without this the resumed turn keeps showing it (codex P2).
      // Through the primitive, not by hand: a direct `clearWait` reaches only the
      // 60 s promise and left the recovery window it had already handed off to —
      // `finishing -> 60 s -> window -> lifecycle:start` then closed the turn as a
      // success twelve seconds into a run that had only just begun.
      if (this.cancelFinishingGrace(now)) {
        events.push({ type: EVENT_TURN_PHASE, phase: "generating" });
      }
      this.finishingSuspended = false; // a new run owns the turn now
      if (this.compactionPending) {
        this.compactionPending = false;
        this.armRecv(now);
      }
      this.clearWait("lifecycle_end");
      events.push({ type: EVENT_RUN_STATUS, status: "running", runId: this.currentRunId });
    }
  }

  // -- visible-text state machine ------------------------------------------

  /**
   * ADMISSION POLICY for a frame of an UNKNOWN run on our own session (G-12).
   *
   * Returns `null` to admit, or the REASON to refuse. Before this, any unknown
   * run was adopted as long as a grace window happened to be open — and the
   * compaction grace is 900 seconds. A frame of a foreign run then became the
   * user's answer and closed their turn; the case is reproducible.
   *
   * Three families can never be this turn's continuation, whatever window is
   * open, and each is recognized POSITIVELY rather than guessed:
   *  - heartbeat runs (`isHeartbeat` on the agent stream);
   *  - gateway-minted turns — announce / task delivery / talk consult / a
   *    `chat.inject` broadcast, which mints `inject-<messageId>` and sends a
   *    `chat` FINAL on this very session;
   *  - during a compaction, anything arriving before the gateway told us a
   *    replay was coming.
   */
  private foreignRunRefusal(runId: string): string | null {
    if (this.heartbeatRunIds.has(runId)) return "heartbeat";
    if (isGatewayInitiatedRunId(runId)) return "gateway_initiated";
    // The COMPACTION rule is tested FIRST because it is the STRICTER one and the
    // two windows overlap: a normal lifecycle end arms its 10 s grace without
    // clearing it, so a compaction starting during that grace would otherwise be
    // decided by the looser rule and admit an unannounced run (codex P1).
    if (this.compactionPending) {
      // 900 s. POSITIVE proof required: the gateway either abandoned the run for
      // a replay (heuristic path) or announced `compaction end willRetry:true`.
      return this.replayExpected ? null : "compaction_no_replay_signal";
    }
    if (this.deadlines.has("lifecycle_end")) {
      // Short (10 s) follow-on window: unchanged apart from the family checks
      // above — a follow-on run of the same turn legitimately lands here.
      return null;
    }
    return "no_grace";
  }

  /** Count a refused foreign-run frame; logs the first of each reason. */
  private noteForeignRunRejection(reason: string): void {
    const seen = this.foreignRunRejections.get(reason) ?? 0;
    this.foreignRunRejections.set(reason, seen + 1);
    if (seen === 0) {
      console.warn(
        `[normalizer] foreign run REFUSED (session=${this.sessionKey}, reason=${reason}) — it will not become this turn's answer`,
      );
    }
  }

  /**
   * Move `key` to the most-recent end of a bounded Set, evicting the oldest past
   * `cap`. `Set.add` on a key already present does NOT reorder it, so without the
   * delete this would be a FIFO wearing an LRU's name (codex P2) — and a still
   * ACTIVE entry could be evicted by 64 newer ones.
   */
  private static touch(set: Set<string>, key: string, cap: number): void {
    set.delete(key);
    set.add(key);
    while (set.size > cap) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  /** Record (or refresh) a chat dedup key within MAX_DEDUP_KEYS. */
  private noteDedupKey(key: string): void {
    Normalizer.touch(this.seenDedupKeys, key, Normalizer.MAX_DEDUP_KEYS);
  }

  /** True while `recoverVisibleTextAt` is the one writing — its own application must
   *  not count as the gateway resuming work. */
  private applyingRecovery = false;
  /** A delivery recovered from the transcript AFTER work resumed. It is held OUT of
   *  the live buffer — the run that resumed owns that — and materialised at the
   *  turn's terminal.
   *
   *  Appending it into the stream was wrong twice: it split the current answer in
   *  two (A + recovered + C), and the next ordinary SNAPSHOT replaced the buffer
   *  outright, erasing the recovered delivery for good. It really was sent to the
   *  user, so it survives to the end; it simply never competes with the answer being
   *  written. */
  private recoveredTails: string[] = [];
  /** The finalize cause of the grace `markRecoveryAttempted` converted into the
   *  recovery window, so the trace still names the wait that actually closed. */
  private recoveryWindowCause: FinalizeCause | null = null;
  /** A terminal the gateway already delivered, held back while a transcript fetch is
   *  still on the wire. Consumed the moment that fetch lands or its window expires —
   *  never dropped, and never left to the silence budget. */
  private pendingFinal: ((at: number) => BridgeEvent[]) | null = null;
  /** The `workResumeCount` at the instant that terminal was held. A held cause is as
   *  revocable as the fetch it waits for: work resuming after it means the gateway is
   *  no longer finished, and consuming it then closed the turn as a success over live
   *  work — the defect this whole repair exists to prevent, reached through the door
   *  the repair itself added. */
  private pendingFinalMark = -1;

  private applyVisible(
    candidate: string,
    isSnapshot: boolean,
    isFinal: boolean,
    now: number,
    events: BridgeEvent[],
    /** This snapshot is ALLOWED to shorten the persisted reply. Only the
     *  upstream `ChatDeltaEventSchema.replace` refresh sets it: everything else
     *  on this path is the gateway's growing view of the same answer, and a
     *  shrink there is a stale/out-of-order frame that Convex must refuse
     *  (G-14). Never widen this without an upstream signal to point at. */
    authorizedShrink = false,
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
          this.finalizeOrHold(now, "lifecycle_final", events);
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
    // An ADOPTED run's snapshot that is not a continuation of what we already
    // hold is APPENDED, never substituted (G-12): its content is additional, and
    // a stranger that slipped through the admission policy still cannot erase
    // the delivered answer. A continuation (the same text plus more) replaces as
    // usual — that is the compaction replay and the ordinary follow-on.
    // A DELTA from an adopted run is additive too (codex P1): when the first
    // reply arrived as a snapshot, `hasSnapshot` is set and the lock below would
    // drop those deltas outright — losing the follow-on's content entirely.
    const forcedAppend =
      this.frameRunAdopted &&
      this.text !== "" &&
      (isSnapshot ? !candidate.startsWith(this.text) : this.hasSnapshot);
    if (forcedAppend) {
      isSnapshot = false;
    }
    if (this.frameRunAdopted && this.adoptedSeparatorOwed.has(this.frameRunId)) {
      // FIRST write of this adopted run, whatever form it takes. Consumed here
      // either way, so the boundary is marked ONCE and never again inside the
      // run's own stream ("réponse complète" then "." must not become
      // "réponse complète\n\n." — codex P2).
      this.adoptedSeparatorOwed.delete(this.frameRunId);
      // Only an APPEND needs the boundary: two independent replies concatenated
      // raw read as one corrupted sentence. This covers the demoted snapshot AND
      // a plain delta onto text another run produced (codex P2). A continuation
      // SNAPSHOT replaces the text outright, so it has no boundary to mark.
      if (
        !isSnapshot &&
        this.text !== "" &&
        !/\s$/.test(this.text) &&
        !/^\s/.test(candidate)
      ) {
        candidate = "\n\n" + candidate;
      }
    }
    if (isSnapshot) {
      this.hasSnapshot = true;
      this.text = candidate;
      emitted = candidate;
      eventType = EVENT_MESSAGE_SNAPSHOT;
    } else {
      // …but the snapshot LOCK must not then swallow it (codex P1): when the
      // first reply itself arrived as a snapshot, dropping the demoted content
      // here would lose the follow-on entirely AND skip the finalization below,
      // leaving the turn to close on a grace timeout. A demotion is a decision
      // about the WRITE, never a reason to discard.
      if (this.hasSnapshot && !forcedAppend) {
        return; // an authoritative snapshot already won; ignore deltas
      }
      this.text += candidate;
      emitted = candidate;
      eventType = EVENT_MESSAGE_DELTA;
    }
    // VISIBLE CONTENT REVOKES AN IN-FLIGHT RECOVERY — and only HERE, where the
    // write is known to have been accepted.
    //
    // The token mechanism caught tool starts and lifecycle starts, and missed the
    // plainest proof of all: the run is writing its answer right now. A transcript
    // fetch returning afterwards held an OLDER delivery and, still believing itself
    // authoritative, replaced the buffer with it and closed the turn. Counting it
    // earlier was wrong in the other direction: a delta the snapshot lock discards
    // changes nothing on screen, and must not revoke a recovery on its way back.
    // The recovery's OWN write is exempt — it is not the gateway resuming anything.
    if (!this.applyingRecovery) {
      this.workResumeCount += 1;
      // …and the window this recovery was given dies with its authority. Revoking
      // the fetch while leaving its 12 s armed left the other door open: the grace
      // expired mid-stream and finalized the turn as a success over deltas still
      // arriving, which were then refused for landing on a finalized turn.
      this.clearWait("history_recovery");
      // …and the finishing promise SLIDES. It does not cancel — that text IS the
      // answer being written, which is the grace's own premise — but it must measure
      // silence since the last write, not absolute time since `finishing`. Measured
      // from `finishing`, a delta at 59.9 s did not stop the bound firing at 60: the
      // turn closed mid-sentence and every frame after it was refused. A turn that
      // really does fall silent still closes sixty seconds later.
      if (this.deadlines.has("lifecycle_finishing")) {
        this.arm("lifecycle_finishing", now + LIFECYCLE_FINISHING_GRACE);
      }
    }
    this.pendingAckText = "";
    this.clearWait("empty_final");
    this.clearWait("private_ack");
    if (this.pendingApprovalCount() === 1 && this.approvalsRequested === 1) {
      // Real content resumed: the approval was answered somewhere (the gateway's
      // own `resolved` may not reach us on every version). Release the wait the
      // same way resumed content releases a compaction.
      //
      // ONE request, for the whole turn. Content says "an approval was answered"; it
      // cannot say WHICH — the door the id correlation had just closed on the
      // explicit `resolved` path, standing open on the implicit one. Counting only
      // the PENDING ones is not enough either: after `requested(a), requested(b),
      // resolved(a)`, b is alone, and the text that follows is far more likely to be
      // a's newly authorised output than an answer to b. A turn that asked twice
      // waits for correlated resolutions, bounded by the 900 s `approval_wait` and
      // its named cause.
      this.clearApprovals();
      this.clearWait("approval_wait");
      // The frame's own re-arm ran BEFORE this (with the flag still set, so it
      // deleted the deadline): put the normal silence budget back now.
      this.armRecv(now);
      // …and the finishing promise this approval suspended, exactly as the explicit
      // `resolved` path does. Without it `requested -> finishing -> content` lost the
      // 60 s bound altogether and fell back to the 240 s recovery — the very defect
      // the bound exists to prevent, reached through the implicit door.
      this.rearmFinishingIfReleased(now);
    }
    if (this.compactionPending) {
      // Real content resumed ⇒ the compaction (incl. an overflow replay on the
      // same run, which has no lifecycle start to clear this) is over: restore
      // the normal silence budget.
      this.compactionPending = false;
      // …and, like a replay, visible content SUPERSEDES the deferred terminal: the run
      // is producing again, so the `finishing` promise a compaction suspended no longer
      // stands and must not be re-armed by a later one. This exit was not consuming the
      // marker — found by enumerating the ways a compaction ends rather than reading the
      // one branch that names itself `end`.
      this.finishingSuspended = false;
      // …and the replay it announced has ARRIVED. Left standing, a second
      // compaction later in the same turn would inherit an admission proof it
      // never earned, re-opening the foreign-run path (codex P1).
      this.replayExpected = false;
    this.replaySameRun = false;
      this.armRecv(now);
    }
    // REAL OUTPUT ENDS THE BACK-OFF, whatever the status frames did. The clear used
    // to depend solely on the next bare `status`, and those are sent `dropIfSlow` — so
    // a dropped one left "retrying 2/10" on screen for the whole generation, since the
    // label is honoured even once text exists. Upstream treats visible assistant
    // activity as its authoritative resume signal (ui/.../tool-stream-status.ts maps
    // `stream:"assistant"` to `{state:"activity"}`); this is the same rule, and it is
    // the one that cannot be lost, because it rides the text itself (raised in review).
    this.clearRetryingPhase(events);
    events.push({
      type: eventType,
      text: this.safeSanitizeText(emitted),
      ...(isSnapshot && authorizedShrink ? { replace: true } : {}),
    });
    // A MEDIA: directive (or a bare outbound path) in the VISIBLE reply is a real
    // attachment — emit a media event so it renders as a downloadable part. We
    // scan the RAW `candidate` (the directive is dropped from the sanitized text).
    // collectMedia dedups by path, so this is harmless when the same path also
    // surfaced from a tool result.
    this.collectMedia([candidate], events);
    if (isFinal) {
      this.finalizeOrHold(now, "gateway_final", events);
    }
  }

  /**
   * Close the turn as a SUCCESS — unless a transcript fetch is still on the wire,
   * in which case the terminal WAITS for it.
   *
   * `recoveredTails` only ever protected the order "recovery returns, then the
   * terminal". Reversed — the resumed run finishes first — the answer came back to a
   * finalized turn and both guards refused it (`RunManager` because the sink is
   * closed, the normalizer because `finalized` is set), and a message the user had
   * really been sent disappeared from Atrium.
   *
   * Every success path goes through here, not just the one that revealed it: the ack
   * and the empty-final-with-content branches close the sink exactly as hard, and
   * `finishing -> message-tool -> fetch -> new message-tool -> "Envoyé…"` reached the
   * same loss through the ack door. The wait is bounded by the window the fetch
   * already owns, and the held cause is revocable: work resuming after it means the
   * gateway is not finished after all.
   */
  private finalizeOrHold(
    now: number,
    cause: FinalizeCause,
    events: BridgeEvent[],
  ): void {
    this.finalizeOrHoldWith(now, events, (at) =>
      this.finalize(at, "final", null, null, cause),
    );
  }

  /** The same arbitration for a terminal of any SHAPE — the post-reply `complete`
   *  carries its own status and a diagnostic stamp, and closes the sink just as
   *  hard, so it cannot be the one path that runs ahead of a fetch on the wire. */
  private finalizeOrHoldWith(
    now: number,
    events: BridgeEvent[],
    run: (at: number) => BridgeEvent[],
  ): void {
    if (this.applyingRecovery || this.recoveryAttempts.size === 0) {
      events.push(...run(now));
      return;
    }
    this.pendingFinal = run;
    this.pendingFinalMark = this.workResumeCount;
    this.arm("history_recovery", now + HISTORY_RECOVERY_GRACE);
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
      if (
        this.capReached(
          "mediaPaths",
          this.mediaPaths.size,
          Normalizer.MAX_MEDIA_PATHS,
        )
      ) {
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

  /**
   * Visible reply text carried by a message-tool call.
   *
   * `unreadable` separates "we COULD NOT READ these arguments" from the several
   * deliberate "this is not the visible reply" outcomes (an external target, a
   * foreign channel, another action). Only the first means the reply text may
   * have been LOST — it used to return "" like all the others, so the turn ended
   * blank with nothing to diagnose (G-16). The caller recovers the text from the
   * transcript, exactly as it already does for a gateway-run message tool.
   */
  private messageToolText(argsIn: Json): { text: string; unreadable: boolean } {
    let args: Json = argsIn;
    if (isString(args)) {
      try {
        args = JSON.parse(args);
      } catch {
        return { text: "", unreadable: true };
      }
    }
    if (!isObject(args)) {
      return { text: "", unreadable: true };
    }
    const action = args.action;
    if (action !== "send" && action !== "thread-reply" && action !== undefined && action !== null) {
      return { text: "", unreadable: false };
    }
    for (const key of EXTERNAL_TARGET_KEYS) {
      if (args[key]) {
        // Explicit external destination -> not the current reply.
        return { text: "", unreadable: false };
      }
    }
    for (const key of ["channel", "provider"]) {
      const value = args[key];
      if (value && !CURRENT_CHAT_CHANNELS.has(String(value).toLowerCase())) {
        return { text: "", unreadable: false };
      }
    }
    for (const key of VISIBLE_TEXT_KEYS) {
      const text = textFromContent(args[key]);
      if (text) {
        return { text, unreadable: false };
      }
    }
    // Readable arguments with no text under any known key: a shape question, not
    // a parse failure (a media-only send lands here legitimately). Deliberately
    // NOT flagged unreadable — a false "content lost" alarm on every such call
    // would be worse than the gap it claims to cover.
    return { text: "", unreadable: false };
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
    cause: FinalizeCause | null = null,
  ): BridgeEvent[] {
    if (this.finalized) {
      return [];
    }
    this.finalizeCause = cause;
    this.finalized = true;
    this.turnActive = false;
    this.compactionPending = false;
    this.deadlines = new Map();
    // Deliveries recovered after work resumed are materialised HERE, at the turn's
    // boundary — never inside the stream the resumed run was writing, where a later
    // snapshot would simply replace them away.
    // A G-13 truncated final is a PROJECTION of this very text: the first 8 000
    // characters plus the marker. Appending the full reply after it would ship the
    // same 8 000 characters twice, so the segment that EXTENDS the projection
    // replaces it — and it is resolved FIRST, against the original text. Resolved in
    // order instead, an unrelated delivery materialised ahead of it removed the
    // marker from the end of `this.text`, the extension stopped being recognised,
    // and the duplication came back with the other reply wedged in between.
    const cut = this.text.endsWith(TRUNCATED_FINAL_MARKER)
      ? this.text.slice(0, -TRUNCATED_FINAL_MARKER.length)
      : null;
    const extendsCut =
      cut === null
        ? -1
        : this.recoveredTails.findIndex((held) => held.startsWith(cut));
    if (extendsCut >= 0) {
      this.text = this.recoveredTails[extendsCut]!;
    }
    this.recoveredTails.forEach((held, i) => {
      if (i === extendsCut || holdsDelivery(this.text, held)) return;
      this.text = this.text === "" ? held : `${this.text}\n\n${held}`;
    });
    this.recoveredTails = [];
    const text = this.text || this.pendingAckText;
    const finalEvent: BridgeEvent = {
      type: EVENT_MESSAGE_FINAL,
      text: this.safeSanitizeText(text),
      diagnosticStopReason: this.diagStopReason,
      diagnosticTimeoutPhase: this.diagTimeoutPhase,
      diagnosticProviderStarted: this.diagProviderStarted,
      diagnosticAborted: this.diagAborted,
      // The gateway said the turn HANDED OFF: the empty-response guard must
      // exempt it even when no `sessions_yield` tool frame was seen.
      gatewayYielded: this.sawYielded,
      diagnosticUsage: this.diagUsage,
      diagnosticFinalizeCause: this.finalizeCause,
      // Native media generation with NO delivery directive (no MEDIA:/outbound):
      // the sink's empty-result guard needs this AT finalize time (the separate
      // EVENT_MEDIA_UNDELIVERED below is pushed AFTER run.status, too late).
      mediaGeneratedUndelivered:
        (this.sawMediaGeneration || this.mediaDeliveryRun) &&
        this.mediaPaths.size === 0,
      observedChildKeys: [...this.observedChildKeys],
      // …and whether that list is COMPLETE: the sink's empty-response guard makes a
      // negative decision from it, which an incomplete list cannot support.
      observedChildKeysTruncated: this.observedChildKeysTruncated,
      // The turn's reply may have gone out through a message-tool call we could
      // not read: the empty-response verdict must name THAT instead of claiming
      // the agent produced nothing (G-16 / P8).
      msgtoolArgsUnreadable: this.msgtoolUnreadableArgs,
      // Count only — the text itself is conversational content (SOC2).
      truncatedFinals: this.truncatedFinals,
      // Foreign-run frames refused this turn, by reason. The exposure was never
      // measured; this counter IS the measurement (G-12).
      foreignRunRejections: Object.fromEntries(this.foreignRunRejections),
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
      // as bare text. What this mints is NOT restricted to the gateway's own
      // `errorKind` enum — `auth_profile_cooldown` and the storage classes are
      // ours, minted from the sentence; every consumer downstream treats the field
      // as "a stable class", never as that enum, and `unknown` is excluded (codex). Pin the known overflow phrasings to context_length so
      // the actionable headline + pressure-trace marker still fire. Same for
      // the session-init OCC conflict — the stable code Convex's bounded
      // auto-retry keys on (only ever fired for a ZERO-content turn there).
      // ONE classifier, shared with the sub-agent path (W2 / G-11): a second
      // copy would drift and only one side would ever be fixed.
      errorKind = classifyFailureText(error);
      // The writer-claim rebound TEXT is thrown both before generation and at commits
      // after the model ran, so the classifier returns the class sized for the worse
      // case. The STREAM can tell them apart, and only here: every generating run emits
      // `lifecycle start` before it generates (upstream agent-core agent-loop.ts
      // `agent_start`), and only status frames precede it. A rebound on a turn that
      // provably saw none of that is a pre-generation session conflict, the class the
      // bounded auto-retry keys on. The true class stays on the trace channel.
      if (errorKind === "session_write_conflict" && this.writeReboundBeforeGeneration()) {
        (finalEvent as { diagnosticErrorKind?: string | null }).diagnosticErrorKind =
          "session_write_conflict";
        errorKind = "session_init_conflict";
      }
    }
    if (
      error !== null &&
      // Through the SAME normalization as every other decision: this downgrade clears
      // the error AND its class, and a quoted value carrying the lock phrase — in a
      // credential sentence or any other — erased its own failure (codex).
      EMBEDDED_LOCK_CONFLICT_RE.test(withoutOperatorData(error)) &&
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
      // error badge; see docs/UPSTREAM_INTERPRETATION.md
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
      // The STABLE failure class: the gateway's own `errorKind`
      // (refusal|timeout|rate_limit|context_length) when it sends one, otherwise a
      // class this build minted from the sentence (`auth_profile_cooldown`, the
      // storage classes). `unknown` is excluded above. Rides message.final
      // so the sink can persist it as the message's stable errorCode —
      // `context_length` is the hard-overflow signal the context-overflow
      // observability chain keys on.
      finalEvent.errorKind = errorKind;
    }
    // The conversation the gateway was asked to continue NO LONGER EXISTS, and upstream
    // says so definitively — its own helper calls this class a proof that "the
    // provider-side conversation can no longer be resumed". Atrium's stored session is
    // therefore worthless, and keeping it is what made every retry meet the same dead
    // conversation, leaving a non-technical reader with the gateway's own `/new` as the
    // only way out (prod-ms717cxh…, prod-ms7ctxqf…, prod-ms760bt1…).
    //
    // NAMED, not a bare flag: the Convex side matches the id before clearing, so an
    // unnamed clear could drop a binding a newer turn already made. With no stored
    // session there is nothing to drop, and the class is then carried for the card
    // alone — it CAN arise on a chat with an empty slot, because the id the gateway
    // could not find is its own, not necessarily one Atrium had recorded.
    //
    // No recovery handle is set here. `recoverableSession` is a DIFFERENT mechanism
    // (a session that lost a reply, kept for one read-only harvest); this session
    // holds nothing to harvest — the gateway says it does not exist (codex).
    if (errorKind === "session_gone" && this.providerSessionId !== null) {
      (finalEvent as { clearProviderSession?: string }).clearProviderSession =
        this.providerSessionId;
    }
    // Open tool cards close FIRST (see the flush above), then the terminal.
    const result: BridgeEvent[] = [finalEvent, statusEvent];
    // The agent ran native media generation this turn but delivered NO media
    // (no MEDIA:/mediaUrls/outbound path) -> emit a content-free diagnostic so the
    // gap (agent omitted the delivery directive) is visible to the #7 loop.
    if (
      (this.sawMediaGeneration || this.mediaDeliveryRun) &&
      this.mediaPaths.size === 0
    ) {
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
    this.seenDedupKeys = new Set();
    this.lastDedupKey = null;
    this.deadlines.delete("empty_final");
    this.deadlines.delete("private_ack");
    this.deadlines.delete("lifecycle_end");
    // …and the truncated-final wait (codex P2): the replay invalidates the cut
    // final that armed it, so leaving it running would let its 20 s expire on a
    // replay still in flight and finalize the turn on partial or empty text.
    this.deadlines.delete("truncated_final");
    // …and the transcript-recovery window, for the same reason: the replay
    // invalidates the message-tool delivery that opened it, so its 12 s would expire
    // on a replay still in flight.
    this.deadlines.delete("history_recovery");
    this.sawTruncatedFinal = false;
    // The abandoned attempt's DIAGNOSTICS are invalidated with its content
    // (codex P2): kept, they would let an empty replay be classed
    // `msgtool_args_unreadable` with no unreadable call of its own, and its trace
    // would report a truncation the reply we keep never had.
    this.truncatedFinals = 0;
    this.msgtoolUnreadableArgs = 0;
    // …and the abandoned attempt's TERMINAL metadata (codex P2): a clean replay
    // would otherwise publish the dead attempt's timeoutPhase / providerStarted /
    // aborted at its own final, describing a run the user never sees.
    this.diagTimeoutPhase = null;
    this.diagProviderStarted = null;
    this.diagAborted = false;
    this.sawYielded = false;
    // A recovery in flight belongs to the abandoned attempt; the replay is
    // entitled to its own attempt.
    this.recoveryGeneration++;
    this.recoveryAttempted = false;
    this.armRecv(now);
  }

  private armRecv(now: number): void {
    if (this.finalized) {
      return;
    }
    if (this.humanWaitPending()) {
      // A tool is waiting on a HUMAN (G-21). Keep-alive traffic — heartbeats,
      // health frames — would otherwise re-arm the 240 s silence budget, which
      // then fires long before the approval wait and closes the turn as a
      // recv_timeout instead of naming what it was waiting for (codex P2).
      this.deadlines.delete("recv");
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

  /**
   * The ONE tool argument that becomes VISIBLE REPLY TEXT.
   *
   * `sessions_yield.acknowledgment` is the sentence a handing-off parent writes
   * for the reader, and the sink promotes it into the bubble when the turn is
   * otherwise silent. Every other route to the bubble passes through
   * `safeSanitizeText`; this one arrived straight from the tool call's arguments
   * and did not — so a `MEDIA:` directive or an absolute
   * `/home/node/.openclaw/...` path written into it reached the browser verbatim,
   * and a dropped directive would have printed a dead link beside a real
   * attachment.
   *
   * NARROW ON PURPOSE. Sanitizing the whole tool input would also rewrite paths
   * the sink CORRELATES on (`noteTurnArtifacts` reads the call's arguments to
   * learn which files this turn produced) — a display fix that silently changed
   * ownership detection. Only the field that is displayed as prose is treated as
   * prose.
   */
  private sanitizeYieldAcknowledgment(input: unknown): unknown {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return input;
    }
    const args = input as Record<string, unknown>;
    const ack = args.acknowledgment;
    if (typeof ack !== "string" || ack === "") return input;
    return { ...args, acknowledgment: this.safeSanitizeText(ack) };
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
