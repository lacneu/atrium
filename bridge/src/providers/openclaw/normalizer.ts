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
  type BridgeEvent,
} from "../../core/events.js";
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
export const BASE_RECV_TIMEOUT = 180.0; // max gap between frames during an active turn
export const COMPACTION_RECV_TIMEOUT = 900.0; // widened gap budget while compaction is pending
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
const CONTEXT_OVERFLOW_TEXT_RE =
  /context overflow|prompt too large|maximum context length|context[- ]length exceeded/i;

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
  private recoveryAttempted = false;
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
    this.deadlines = new Map();
  }

  // -- turn lifecycle (called from the browser->gateway task) ---------------

  /** Reset per-turn state when the user sends a message (before chat.send). */
  beginTurn(now: number): void {
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
    this.recoveryAttempted = false;
    this.suppressNextRotation = false;
    this.compactionSignaled = false;
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

  /** Finalize the active turn explicitly (e.g. on chat.abort or a send error). */
  endTurn(now: number, status = "final", error: string | null = null): BridgeEvent[] {
    return this.finalize(now, status, error);
  }

  /** Finalize the active turn as failed after a per-message upstream error. */
  failTurn(now: number, message: string): BridgeEvent[] {
    return this.finalize(now, "error", message);
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
      events.push(...this.finalize(now));
    } else if (expired.has("empty_final") || expired.has("lifecycle_end") || expired.has("recv")) {
      events.push(...this.finalize(now));
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
        // An abort while a COMPACTION is pending is the gateway abandoning the
        // run to compact (it resumes after the replay) — terminalizing it here
        // froze real turns as "Interrompu" (live report 2026-07-04). Let the
        // widened compaction grace keep the turn open instead.
        if (this.compactionPending) {
          return;
        }
        events.push(...this.finalize(now, "aborted"));
        return;
      }
      const reason = isString(payload.errorMessage)
        ? payload.errorMessage
        : textFromMessage(message);
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
        ),
      );
      return;
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
        events.push(...this.finalize(now));
      } else {
        this.arm("empty_final", now + EMPTY_FINAL_GRACE);
      }
    }
  }

  // -- agent (5.7 legacy + tool/lifecycle streams) --------------------------

  private handleAgent(payload: JsonObject, data: JsonObject, now: number, events: BridgeEvent[]): void {
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
      // Real tools (web_search, web_fetch, …): coalesce start(args)+result(result)
      // into ONE `completed`/`error` event carrying input+output, so the thread
      // renders a single clean card per tool. (Live v2026.5.19 emits these as
      // `agent` `stream:"tool"` with phase start|result — see OPENCLAW fixtures.)
      if (phase === "start") {
        if (toolCallId) this.toolArgs.set(toolCallId, data.args);
        // Do not emit yet — the card is emitted once on the result.
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

  private handleLifecycle(_payload: JsonObject, data: JsonObject, now: number, events: BridgeEvent[]): void {
    const phase = data.phase;
    if (phase === "error") {
      const message = extractLifecycleError(data.error);
      events.push(...this.finalize(now, "error", message));
      return;
    }
    if (phase === "end") {
      // ONLY livenessState == "abandoned" signals an imminent compaction
      // restart. A plain replayInvalid with livenessState == "working" is a
      // normal terminal end (cache invalidated, no restart) and must NOT reset
      // buffers.
      if (data.livenessState === "abandoned") {
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
          events.push(...this.finalize(now));
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
    events.push({ type: eventType, text: this.safeSanitizeText(emitted) });
    // A MEDIA: directive (or a bare outbound path) in the VISIBLE reply is a real
    // attachment — emit a media event so it renders as a downloadable part. We
    // scan the RAW `candidate` (the directive is dropped from the sanitized text).
    // collectMedia dedups by path, so this is harmless when the same path also
    // surfaced from a tool result.
    this.collectMedia([candidate], events);
    if (isFinal) {
      events.push(...this.finalize(now));
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
  ): BridgeEvent[] {
    if (this.finalized) {
      return [];
    }
    this.finalized = true;
    this.turnActive = false;
    this.compactionPending = false;
    this.deadlines = new Map();
    const text = this.text || this.pendingAckText;
    const finalEvent: BridgeEvent = {
      type: EVENT_MESSAGE_FINAL,
      text: this.safeSanitizeText(text),
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
      // the actionable headline + pressure-trace marker still fire.
      errorKind = CONTEXT_OVERFLOW_TEXT_RE.test(error) ? "context_length" : null;
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
