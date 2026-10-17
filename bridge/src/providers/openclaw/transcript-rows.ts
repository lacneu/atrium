// THE SESSION TRANSCRIPT, READ AS IDENTITIES (transcript redesign, phase 1).
//
// Pure, vendor-coupled readers for what `chat.history` returns: the transcript rows'
// identity facts, the Control UI's display predicates (hidden / visible), the reply
// envelope (page, delta, reset), and the mapping of a terminal chat frame onto a run
// status. Every rule here MIRRORS an upstream function at v2026.9.6 — cited where it is
// applied — and nothing is inferred from position, content or time except the two
// display predicates, which are the Control UI's own.
//
// Nothing in this module writes anything: transcript-shadow.ts orchestrates the reads
// and posts the result to Convex, which never edits a bubble in shadow mode.

import { createHash } from "node:crypto";

import { messageDisplayText, sanitizeDisplay } from "./normalizer.js";
import { blocksBytes, rowBlocks, withoutBlockTexts, withoutToolPayloads, type RowBlock } from "./row-blocks.js";
import { resolveToolCallId, resolveToolName, toolItemCallIds } from "./tool-call-id.js";

const asRecord = (x: unknown): Record<string, unknown> | null =>
  typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

/** `readSessionProjectionString` (upstream
 *  packages/gateway-client/src/session-projection-message-identity.ts:27-29): a trimmed
 *  non-empty string, else null. */
function projString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** `normalizeSessionProjectionRunId` (session-projection-message-identity.ts:43-46): a
 *  user-turn key `"<runId>:user"` names the run `<runId>`. */
export function normalizeRunId(value: unknown): string | null {
  const runId = projString(value);
  return runId?.endsWith(":user") ? runId.slice(0, -":user".length) || null : runId;
}

/** The `session.message` envelope a delta row arrives in (upstream
 *  src/gateway/session-transcript-message.ts `projectSessionMessagePayload`:
 *  `{sessionKey, message, messageId?, messageSeq?, runId?, …sessionSnapshot}`). */
export type TranscriptEnvelope = {
  messageId?: unknown;
  messageSeq?: unknown;
  runId?: unknown;
  idempotencyKey?: unknown;
  clientRunId?: unknown;
};

export type TranscriptIdentity = {
  /** Lower-cased role, as upstream compares it. */
  role: string;
  id: string | null;
  seq: number | null;
  idempotencyKey: string | null;
  /** User rows: the send identity (the key minus `:user`). */
  sendId: string | null;
  /** The run that produced the row. */
  runId: string | null;
  steerTargetRunId: string | null;
  mirrorOrigin: string | null;
  runTerminal: boolean;
  isImported: boolean;
};

/**
 * Mirror of upstream `readSessionMessageIdentity`
 * (packages/gateway-client/src/session-projection-message-identity.ts:49-118 at
 * v2026.9.6): persisted row facts win; an assistant row's run comes from its producer
 * (`__openclaw.runId`), a user row's from its persisted send key. Plus the two facts the
 * Control UI reads beside it: `steerTargetRunId` (ui/src/pages/chat/
 * stream-causal-boundary.ts:38-41 `persistedSteerTargetRunId`) and the mirror
 * attestation (`mirrorOrigin` / `runTerminal`, packages/gateway-client/src/
 * session-projection.ts:264-265).
 */
export function readTranscriptIdentity(
  message: unknown,
  envelope?: TranscriptEnvelope,
): TranscriptIdentity | null {
  const record = asRecord(message);
  const role = projString(record?.role)?.toLowerCase();
  if (!record || !role) return null;
  const metadata = asRecord(record["__openclaw"]);
  const importedFrom = projString(metadata?.importedFrom);
  const cliSessionId = projString(metadata?.cliSessionId);
  const externalId = projString(metadata?.externalId);
  const position = asRecord(metadata?.transcriptPosition);
  const positionSource = projString(position?.source);
  const hasCanonicalPosition =
    positionSource !== null &&
    positionSource.length <= 128 &&
    typeof position?.rawSeq === "number" &&
    Number.isSafeInteger(position.rawSeq) &&
    position.rawSeq >= 0;
  const isImported = !hasCanonicalPosition && Boolean(importedFrom || cliSessionId || externalId);
  const idempotencyKey =
    projString(metadata?.idempotencyKey) ??
    projString(record.idempotencyKey) ??
    projString(envelope?.idempotencyKey) ??
    projString(envelope?.clientRunId);
  const persistedRunId = normalizeRunId(idempotencyKey);
  const envelopeRunId = normalizeRunId(envelope?.runId);
  const metadataRunId = normalizeRunId(metadata?.runId);
  const fallbackRunId = normalizeRunId(asRecord(record.openclawStreamFallback)?.runId);
  const mirrorOrigin = projString(metadata?.mirrorOrigin);
  const mirroredMessage = mirrorOrigin !== null;
  const isCliAssistant =
    role === "assistant" && projString(record.api)?.toLowerCase() === "cli";
  const canonicalPersistedRunId =
    isCliAssistant && persistedRunId?.startsWith("cli-assistant:")
      ? projString(persistedRunId.slice("cli-assistant:".length))
      : persistedRunId;
  const runId =
    role === "assistant"
      ? (metadataRunId ??
        envelopeRunId ??
        fallbackRunId ??
        (isCliAssistant || !mirroredMessage ? canonicalPersistedRunId : null))
      : (metadataRunId ?? canonicalPersistedRunId ?? envelopeRunId);
  return {
    role,
    id: projString(metadata?.id) ?? projString(envelope?.messageId),
    seq: positiveSafeInteger(metadata?.seq) ?? positiveSafeInteger(envelope?.messageSeq),
    idempotencyKey,
    sendId: role === "user" ? (persistedRunId ?? runId) : null,
    runId,
    steerTargetRunId: projString(metadata?.steerTargetRunId),
    mirrorOrigin,
    runTerminal: metadata?.runTerminal === true,
    isImported,
  };
}

// ── Display predicates (the Control UI's own) ─────────────────────────────────────────

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/; // ui/src/lib/chat/message-visibility.ts:14
const HEARTBEAT_TOKEN = "HEARTBEAT_OK"; // src/auto-reply/tokens.ts:5
const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300; // src/auto-reply/heartbeat.ts:27

/** Tool block type spellings (upstream src/chat/tool-content.ts:22-31). */
function normalizeToolType(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
function isToolCallType(value: unknown): boolean {
  const t = normalizeToolType(value);
  return t === "toolcall" || t === "tool_call" || t === "tooluse" || t === "tool_use";
}
function isToolResultType(value: unknown): boolean {
  const t = normalizeToolType(value);
  return t === "toolresult" || t === "tool_result";
}

/** The row's text blocks, joined (the raw content; upstream's display extraction also
 *  strips phase/commentary wrappers, which never turn an empty row into a visible one). */
function rowText(record: Record<string, unknown>): string {
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return typeof record.text === "string" ? record.text : "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

/** `stripTokenAtEdges` (upstream src/auto-reply/heartbeat.ts:121-167). */
function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) return { text: "", didStrip: false };
  const token = HEARTBEAT_TOKEN;
  const tokenAtEnd = /HEARTBEAT_OK[^\w]{0,4}$/;
  if (!text.includes(token)) return { text, didStrip: false };
  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(token)) {
      text = next.slice(token.length).trimStart();
      didStrip = true;
      changed = true;
      continue;
    }
    if (tokenAtEnd.test(next)) {
      const idx = next.lastIndexOf(token);
      const before = next.slice(0, idx).trimEnd();
      if (!before) {
        text = "";
      } else {
        const after = next.slice(idx + token.length).trimStart();
        text = `${before}${after}`.trimEnd();
      }
      didStrip = true;
      changed = true;
    }
  }
  return { text: text.replace(/\s+/g, " ").trim(), didStrip };
}

/** `stripHeartbeatToken(raw, {mode:"message"})` (heartbeat.ts:170-235) followed by the
 *  display rule `stripHeartbeatTokenForDisplay` (ui/src/lib/chat/heartbeat-display.ts:8-18). */
function heartbeatSkipForDisplay(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (!trimmed.includes(HEARTBEAT_TOKEN)) return false;
  const stripMarkup = (t: string) =>
    t
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, "");
  const original = stripTokenAtEdges(trimmed);
  const normalized = stripTokenAtEdges(stripMarkup(trimmed));
  const picked = original.didStrip && original.text ? original : normalized;
  if (!picked.didStrip) return false;
  if (!picked.text) return true;
  const rest = picked.text.trim();
  const display = /^[*`~_]+$/.test(rest) ? "" : rest;
  return display.length <= DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
}

/** Content a reader sees: text, or a block that is neither tool activity nor thinking
 *  (upstream ui/src/lib/chat/message-visibility.ts:20-37 `resolveMessageVisibleContent`). */
function hasVisibleContent(record: Record<string, unknown>): boolean {
  const content = record.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = asRecord(block);
      if (b === null) continue;
      if (b.type === "text") {
        if (typeof b.text === "string" && b.text.trim()) return true;
      } else if (
        b.type !== "thinking" &&
        b.type !== "reasoning" &&
        !isToolCallType(b.type) &&
        !isToolResultType(b.type)
      ) {
        return true;
      }
    }
    return false;
  }
  return typeof record.text === "string" && record.text.trim().length > 0;
}

/**
 * The two display facts the projection stores for a row:
 *  - `hidden`: an assistant row the Control UI never shows — exact `NO_REPLY`
 *    (message-visibility.ts:44-59, `entry.text` taking precedence) or a heartbeat
 *    acknowledgement (heartbeat-display.ts:43-64, no sender label, no non-text content);
 *  - `visible`: the row carries something a reader sees, or is a tool result.
 */
export function rowDisplayFacts(message: unknown): { hidden: boolean; visible: boolean } {
  const record = asRecord(message);
  if (record === null) return { hidden: false, visible: false };
  const role = projString(record.role)?.toLowerCase() ?? "";
  if (role === "toolresult" || role === "tool") return { hidden: false, visible: true };
  if (role !== "assistant") return { hidden: false, visible: hasVisibleContent(record) };
  const text = typeof record.text === "string" ? record.text : rowText(record);
  const silent = SILENT_REPLY_PATTERN.test(text);
  const labelled = typeof record.senderLabel === "string" && record.senderLabel.trim() !== "";
  const visible = hasVisibleContent(record);
  let heartbeat = false;
  if (!labelled && !silent) {
    const content = record.content;
    let nonText = false;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = asRecord(block);
        if (b !== null && b.type !== "text" && b.type !== "thinking" && b.type !== "reasoning") {
          nonText = true;
        }
      }
    } else if (content != null && typeof content !== "string") {
      nonText = true;
    }
    const t = rowText(record);
    heartbeat = !nonText && t.trim().length > 0 && heartbeatSkipForDisplay(t);
  }
  return { hidden: silent || heartbeat, visible };
}

/** Tool call ids a row carries, read by the ONE identity the tool blocks use
 *  (tool-call-id.ts `resolveToolCallId`, upstream tool-cards.ts:224): the message's own on
 *  a tool result (:499), each tool content item's — its id, its legacy `callId`, then the
 *  message's — otherwise (:386, :409). */
export function rowToolCallIds(message: unknown, rowKey?: string): string[] {
  const record = asRecord(message);
  if (record === null) return [];
  const out = new Set<string>();
  const meta = asRecord(record.__openclaw);
  const key = rowKey ?? (typeof meta?.id === "string" && meta.id.trim() !== "" ? meta.id.trim() : "row");
  const direct = resolveToolCallId({}, record);
  const role = typeof record.role === "string" ? record.role.toLowerCase() : "";
  if (role === "toolresult" || role === "tool_result" || role === "tool") {
    // The row's one card, keyed as its block is (row-blocks.ts; tool-cards.ts:494-500).
    out.add(direct ?? `${key}#${resolveToolName({}, record)}:0`);
    return [...out];
  }
  if (direct) out.add(direct);
  if (Array.isArray(record.content)) {
    // The same pairing the tool blocks are keyed by (row-blocks.ts), id-less calls included.
    for (const id of toolItemCallIds(record, record.content, key).values()) out.add(id);
  }
  return [...out].slice(0, 32);
}

// ── Launches (transcript redesign, phase 5) ───────────────────────────────────────────

/** Most launches one row may state (convex/lib/transcriptProjection.ts
 *  `MAX_SPAWNS_PER_ROW`). */
export const MAX_SPAWNS_PER_ROW = 8;

/** A child run id as upstream mints it (convex/lib/deliveryRuns.ts `CHILD_RUN_ID_RE`). */
const CHILD_RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type SpawnFact = { childSessionKey: string; childRunId: string };

/** The text blocks of a tool result's `content`, joined. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

/** An ACCEPTED `sessions_spawn` result, read from the JSON the TOOL wrote — `jsonResult`
 *  (src/agents/tools/tool-results.ts:10-12 at v2026.9.8) of a `SpawnSubagentResult`
 *  (src/agents/subagents/spawn/subagent-spawn-contract.ts:65-88). Anything else — an error,
 *  a refusal, a text cut by the history's display limit — states nothing. */
function acceptedSpawn(text: string): SpawnFact | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const r = asRecord(parsed);
  if (r?.status !== "accepted") return null;
  const childSessionKey = projString(r.childSessionKey);
  const childRunId = projString(r.runId);
  if (childSessionKey === null || childSessionKey.length > 256) return null;
  if (childRunId === null || !CHILD_RUN_ID_RE.test(childRunId)) return null;
  return { childSessionKey, childRunId };
}

/**
 * PROJECTION `on` (phase 5): the sub-agents a transcript row says its run LAUNCHED. Two
 * shapes, both written by the gateway, never by the model:
 *  - a direct call: a `toolResult` row of `sessions_spawn` (sessions-spawn-tool.ts:670);
 *  - a nested call (code mode): the `openclaw.nested-tool.v1` custom row
 *    (src/sessions/nested-tool-activity.ts:5-70), which history and `session.message`
 *    project as `content:[toolCall, toolResult{toolName}]`, owned by the calling run
 *    (src/gateway/chat-display-projection.core.ts:439-457).
 * The result `details` never reach us (chat-display-projection.sanitize.ts:447-466 keeps
 * an allow-list), so the identities are read from the result text — the tool's JSON. The
 * output of `exec` (the agent's own code) is never read.
 */
export function spawnFacts(message: unknown): SpawnFact[] {
  const record = asRecord(message);
  if (record === null) return [];
  const role = projString(record.role)?.toLowerCase();
  const texts: string[] = [];
  if ((role === "toolresult" || role === "tool_result") && record.toolName === "sessions_spawn") {
    if (record.isError !== true) texts.push(blockText(record.content));
  } else if (role === "custom" && record.customType === "openclaw.nested-tool.v1" && Array.isArray(record.content)) {
    for (const block of record.content) {
      const b = asRecord(block);
      if (b === null || !isToolResultType(b.type) || b.toolName !== "sessions_spawn" || b.isError === true) continue;
      texts.push(blockText(b.content));
    }
  }
  const out: SpawnFact[] = [];
  for (const text of texts) {
    const fact = acceptedSpawn(text);
    if (fact === null) continue;
    if (out.some((f) => f.childRunId === fact.childRunId && f.childSessionKey === fact.childSessionKey)) continue;
    out.push(fact);
    if (out.length >= MAX_SPAWNS_PER_ROW) break;
  }
  return out;
}

// ── Rows and replies ──────────────────────────────────────────────────────────────────

/** One durable row, as identities: what Convex stores (convex/transcriptProjection.ts). */
export type TranscriptRow = {
  entryId: string;
  seq: number;
  role: string;
  runId?: string;
  sendId?: string;
  steerTargetRunId?: string;
  mirrorOrigin?: string;
  runTerminal?: boolean;
  hidden: boolean;
  visible: boolean;
  toolCallIds?: string[];
  /** PROJECTION `on` (phase 4): what the row shows — set only when the read asked for it. */
  text?: string;
  yieldAck?: string;
  /** PROJECTION `on` (phase 5): the sub-agents the row's run launched — set only when the
   *  read asked for what rows say (`spawnFacts`). */
  spawns?: SpawnFact[];
  // PROJECTION `on` (final design §3.3-§3.5, step 1) — set only when the read asked for
  // what rows say. Display facts: none of them decides where a row is placed.
  /** What the row shows, in order: text, files, tool blocks (row-blocks.ts `rowBlocks`). */
  blocks?: RowBlock[];
  /** The row carried more blocks than MAX_ROW_BLOCKS: the first ones are kept. */
  blocksTruncated?: true;
  /** The gateway's display position (`__openclaw.transcriptPosition`, upstream
   *  src/chat/transcript-display-position.ts) — the order the Control UI shows rows in. */
  transcriptPosition?: TranscriptPosition;
  /** What the row's idempotency key says it is (`idempotencyKindOf`). */
  idempotencyKind?: IdempotencyKind;
  /** `model === "delivery-mirror"`: a row the gateway wrote ON BEHALF of a run. */
  deliveryMirror?: true;
  stopReason?: string;
  /** The row's own error text (`errorMessage`), sanitized like the text. */
  errorMessage?: string;
  /** `provenance.kind` / `provenance.sourceTool`, read-only diagnostics. */
  provenanceKind?: string;
  provenanceSourceTool?: string;
  /** A STREAM SEGMENT the gateway split out of its transcript row (`streamSegmentEntryId`):
   *  shown right before the row that owns it. */
  streamSegment?: true;
  /** Its place among the segments of the same row, as `chat.history` lists them — the
   *  items' order (`projectAssistantCommentaryFallbacks`, codex review 10): what breaks the
   *  tie between segments of one `seq`, never their identity. */
  segmentOrder?: number;
};

/**
 * THE STREAM SEGMENT'S OWN IDENTITY (projection `on`). `chat.history` splits an assistant
 * row whose provider items carry commentary/segment text into an assistant message of its
 * own, `openclawStreamFallback: {source: "segment", itemId}`, placed BEFORE the rest of the
 * row — both with the row's `__openclaw` meta, same `id`, same `seq`
 * (src/gateway/chat-display-projection.commentary.ts:96-125 at v2026.9.33). The Control UI
 * shows both, and gives the segment a display identity of its own, its `itemId` — "a
 * commentary item's display identity is separate from the transcript row that later owns
 * it" (packages/gateway-client/src/session-projection-message-identity.ts:116-131). Keyed
 * by the row's id alone, the second message overwrote the first: its text and its
 * `MEDIA:` file were lost (bench run 2026-10-16T20-26-29-405Z, yield-settle-media). The
 * segment's key is the row's id plus a digest of its item id (bounded: Convex keeps
 * 128 characters of an entry id). Null for any other message.
 */
export function streamSegmentEntryId(message: unknown, rowId: string): string | null {
  const record = asRecord(message);
  if (projString(record?.role)?.toLowerCase() !== "assistant") return null;
  const fallback = asRecord(record?.openclawStreamFallback);
  if (fallback?.source !== "segment") return null;
  const itemId = projString(fallback.itemId);
  if (itemId === null) return null;
  return `${rowId}:segment:${createHash("sha256").update(itemId).digest("hex").slice(0, 32)}`;
}

/** `__openclaw.transcriptPosition` (upstream src/chat/transcript-display-position.ts:36
 *  `composeTranscriptDisplay` reads `{source, rawSeq, activity?}`). */
export type TranscriptPosition = {
  source: string;
  rawSeq: number;
  activity?: { afterRawSeq: number | null; scopeId: string; startOrder: number };
};

/** What an idempotency key names, by the shapes upstream mints:
 *  `${runId}:message-tool:…` (src/agents/tools/message-tool-execution.ts:546),
 *  `…:internal-source-reply:…` (message-tool.internal-source-reply.integration.test.ts:82),
 *  `${runId}:user` (session-projection-message-identity.ts:43-46),
 *  `${runId}:settled-finalization-fallback` (settled-turn-finalization.ts:608). */
export type IdempotencyKind =
  | "message-tool"
  | "internal-source-reply"
  | "user"
  | "settled-finalization-fallback"
  | "other";

export function idempotencyKindOf(key: string | null): IdempotencyKind | null {
  if (key === null) return null;
  if (key.includes(":message-tool:")) return "message-tool";
  if (key.includes(":internal-source-reply:")) return "internal-source-reply";
  if (key.endsWith(":user")) return "user";
  if (key.endsWith(":settled-finalization-fallback")) return "settled-finalization-fallback";
  return "other";
}

const safeNonNegativeInt = (x: unknown): number | null =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null;

/** The row's display position — upstream `readTranscriptDisplayPosition`
 *  (src/chat/transcript-display-position.ts:24-34 at v2026.9.33): `source` 1-128 chars, a
 *  non-negative `rawSeq`, an optional `activity` {`afterRawSeq` non-negative or null,
 *  `scopeId` 1-1024 chars, `startOrder`}, refused whole when `afterRawSeq >= rawSeq`. */
export function readTranscriptPosition(message: unknown): TranscriptPosition | null {
  const position = asRecord(asRecord(asRecord(message)?.["__openclaw"])?.transcriptPosition);
  if (position === null) return null;
  const source = typeof position.source === "string" ? position.source : null;
  const rawSeq = safeNonNegativeInt(position.rawSeq);
  if (source === null || source.length < 1 || source.length > 128 || rawSeq === null) return null;
  if (position.activity === undefined) return { source, rawSeq };
  const activity = asRecord(position.activity);
  const afterRawSeq = activity?.afterRawSeq === null ? null : safeNonNegativeInt(activity?.afterRawSeq);
  const scopeId = typeof activity?.scopeId === "string" ? activity.scopeId : null;
  const startOrder = safeNonNegativeInt(activity?.startOrder);
  if (
    activity === null ||
    (afterRawSeq === null && activity.afterRawSeq !== null) ||
    scopeId === null ||
    scopeId.length < 1 ||
    scopeId.length > 1024 ||
    startOrder === null ||
    (afterRawSeq !== null && afterRawSeq >= rawSeq)
  ) {
    return null;
  }
  return { source, rawSeq, activity: { afterRawSeq, scopeId, startOrder } };
}

/** Most an error text keeps (UTF-8 bytes); a longer one is not sent (never cut). */
export const ROW_ERROR_MAX_BYTES = 4096;
/** The custom row type the gateway writes when a run ends before a reply
 *  (src/sessions/session-run-error.ts:15 at v2026.9.33). */
export const RUN_FAILED_BEFORE_REPLY = "run-failed-before-reply";

/** PROJECTION `on` (phase 4): read what a row SAYS, for the session it belongs to. */
export type RowDisplay = { sessionKey: string };

/** Most a row may SAY, in UTF-8 bytes, text and acknowledgment together — ONE budget,
 *  Convex's too (convex/lib/transcriptProjection.ts `MAX_ROW_TEXT_BYTES` = the largest
 *  text a bubble is ever composed from rows with). A text over it is not sent (never
 *  cut): it could never make or rewrite a bubble, so its bubble keeps the live text.
 *  Bounded in BYTES, not characters (codex phase 4 pass 7: a 32 769-character answer the
 *  live frames missed got no bubble at all under the old 32 Ki-character bound). */
export const ROW_TEXT_MAX_BYTES = 768 * 1024;

const utf8Length = (s: string): number => Buffer.byteLength(s, "utf8");

/** The suffix of the row the gateway writes ON BEHALF of a run whose turn settled without
 *  a final summary (`${runId}:settled-finalization-fallback`, upstream
 *  src/agents/embedded-agent-runner/run/settled-turn-finalization.ts:608 at v2026.9.8). It
 *  carries no `__openclaw.runId`: the run is read from its key. Atrium shows that sentence
 *  in the run's own bubble (0.95.0, CU-8) — the projection keeps it there. */
const SETTLED_FALLBACK_SUFFIX = ":settled-finalization-fallback";

/** A `sessions_yield` call's acknowledgment in an assistant row (the sentence the sink
 *  promotes into an otherwise silent bubble — core/turn-sink.ts), sanitized like text. */
function yieldAcknowledgment(record: Record<string, unknown>, display: RowDisplay): string | null {
  if (!Array.isArray(record.content)) return null;
  for (const block of record.content) {
    const b = asRecord(block);
    if (b === null || !isToolCallType(b.type) || b.name !== "sessions_yield") continue;
    const args = asRecord(b.arguments) ?? asRecord(b.input);
    const ack = args?.acknowledgment;
    if (typeof ack !== "string" || ack.trim() === "" || ack.trim() === "NO_REPLY") continue;
    return sanitizeDisplay(ack, display.sessionKey);
  }
  return null;
}

/** A row the Control UI keeps: it needs an id and a sequence to be placed by identity
 *  (upstream session-message-apply.ts:65-188 drops rows without id/key/seq). Imported
 *  rows (CLI history) live in another identity namespace and are skipped here. */
export function toTranscriptRow(
  message: unknown,
  envelope?: TranscriptEnvelope,
  display?: RowDisplay,
): TranscriptRow | null {
  const id = readTranscriptIdentity(message, envelope);
  if (id === null || id.isImported || id.id === null || id.seq === null) return null;
  const facts = rowDisplayFacts(message);
  const toolCallIds = rowToolCallIds(message, id.id);
  let runId = id.runId;
  let shown: { text?: string; yieldAck?: string; errorMessage?: string; blocks?: RowBlock[] } = {};
  let content: ContentFacts = {};
  // Launches are a fact about the row's RUN: only a row attributed to one states any.
  const spawns = display !== undefined && id.runId !== null && id.role !== "user" ? spawnFacts(message) : [];
  if (display !== undefined && id.role === "assistant") {
    if (runId?.endsWith(SETTLED_FALLBACK_SUFFIX)) {
      runId = runId.slice(0, -SETTLED_FALLBACK_SUFFIX.length) || null;
    }
    const record = asRecord(message)!;
    if (facts.visible && !facts.hidden) {
      const text = messageDisplayText(record, display.sessionKey);
      // A text over the bound is not sent at all: Convex keeps the live text then.
      if (utf8Length(text) <= ROW_TEXT_MAX_BYTES) shown = { text };
    }
    const ack = yieldAcknowledgment(record, display);
    // The acknowledgment only while it fits beside the text (shown only for a run with no
    // text of its own: beside a text it would never be shown).
    if (ack !== null && utf8Length(shown.text ?? "") + utf8Length(ack) <= ROW_TEXT_MAX_BYTES) {
      shown = { ...shown, yieldAck: ack };
    }
    const error = typeof record.errorMessage === "string" ? sanitizeDisplay(record.errorMessage, display.sessionKey) : "";
    // The error text only while it fits beside the text and acknowledgment (never cut).
    if (
      error.trim() !== "" &&
      utf8Length(error) <= ROW_ERROR_MAX_BYTES &&
      rowContentBytes({ ...shown, errorMessage: error }) <= ROW_TEXT_MAX_BYTES
    ) {
      shown = { ...shown, errorMessage: error };
    }
  }
  // THE ROW THAT STATES A RUN'S FAILURE (final design step 4, « l'erreur vient de la
  // ligne »): the gateway appends a `custom` row `run-failed-before-reply` whose content is
  // the public summary (src/sessions/session-run-error.ts:35-62 at v2026.9.33), projected
  // with its run (`GW/chat-display-projection.state-contention.test.ts:5`: `content`,
  // `__openclaw.runId`, raw diagnostics never) — the row the Control UI shows as the error
  // (ui/src/pages/chat/components/chat-message-group.ts:410-425). Its text is carried as
  // the row's error text, bounded like any other.
  if (display !== undefined && id.role === "custom" && asRecord(message)?.customType === RUN_FAILED_BEFORE_REPLY) {
    const error = sanitizeDisplay(blockText(asRecord(message)!.content), display.sessionKey);
    if (error.trim() !== "" && utf8Length(error) <= ROW_ERROR_MAX_BYTES) shown = { errorMessage: error };
  }
  if (display !== undefined) {
    content = contentFacts(message, id.idempotencyKey);
    // Blocks for the rows the Control UI shows content of: assistant rows, tool results and
    // nested-tool rows — never a hidden one (`NO_REPLY`, heartbeat acknowledgment).
    const role = id.role;
    if (!facts.hidden && (role === "assistant" || role === "toolresult" || role === "tool_result" || role === "tool" || role === "custom")) {
      // KNOWN BUT EMPTY is a fact, never "absent" (codex review 4, finding 2): a row whose
      // whole text is inbound metadata normalizes to nothing (`stripMessageDisplayMetadata`,
      // message-normalizer.ts:368) and shows nothing — its raw text is never the fallback.
      // Only a row with no `blocks` at all (a 0.100.1 bridge) falls back to its text.
      const { blocks, truncated } = rowBlocks(message, display.sessionKey, id.id);
      shown = boundRowContent({ ...shown, blocks });
      if (truncated) content = { ...content, blocksTruncated: true };
    }
  }
  // Projection `on` only: off/shadow keep the identities they always stored.
  const segmentId = display !== undefined ? streamSegmentEntryId(message, id.id) : null;
  return {
    entryId: segmentId ?? id.id,
    ...(segmentId !== null ? { streamSegment: true as const } : {}),
    seq: id.seq,
    role: id.role,
    ...(runId === null ? {} : { runId }),
    ...(id.sendId === null ? {} : { sendId: id.sendId }),
    ...(id.steerTargetRunId === null ? {} : { steerTargetRunId: id.steerTargetRunId }),
    ...(id.mirrorOrigin === null ? {} : { mirrorOrigin: id.mirrorOrigin }),
    ...(id.runTerminal ? { runTerminal: true } : {}),
    hidden: facts.hidden,
    visible: facts.visible,
    ...(toolCallIds.length > 0 ? { toolCallIds } : {}),
    ...shown,
    ...(spawns.length > 0 ? { spawns } : {}),
    ...content,
  };
}

/** The identity facts a row states beside what it shows (projection `on`). */
type ContentFacts = Pick<
  TranscriptRow,
  | "transcriptPosition"
  | "idempotencyKind"
  | "deliveryMirror"
  | "stopReason"
  | "provenanceKind"
  | "provenanceSourceTool"
  | "blocksTruncated"
>;

const shortString = (x: unknown, max: number): string | null => {
  const s = projString(x);
  return s !== null && s.length <= max ? s : null;
};

function contentFacts(message: unknown, idempotencyKey: string | null): ContentFacts {
  const record = asRecord(message);
  const position = readTranscriptPosition(message);
  const kind = idempotencyKindOf(idempotencyKey);
  const stopReason = shortString(record?.stopReason, 32);
  const provenance = asRecord(record?.provenance);
  const provenanceKind = shortString(provenance?.kind, 64);
  const sourceTool = shortString(provenance?.sourceTool, 64);
  return {
    ...(position !== null ? { transcriptPosition: position } : {}),
    ...(kind !== null ? { idempotencyKind: kind } : {}),
    ...(projString(record?.model) === "delivery-mirror" ? { deliveryMirror: true as const } : {}),
    ...(stopReason !== null ? { stopReason } : {}),
    ...(provenanceKind !== null ? { provenanceKind } : {}),
    ...(sourceTool !== null ? { provenanceSourceTool: sourceTool } : {}),
  };
}

/** What a row's content weighs against ROW_TEXT_MAX_BYTES: text, acknowledgment, error text
 *  and blocks (their JSON). Mirrored by convex/lib/transcriptProjection.ts `rowContentBytes`. */
export function rowContentBytes(r: {
  text?: string;
  yieldAck?: string;
  errorMessage?: string;
  blocks?: readonly RowBlock[];
}): number {
  return (
    utf8Length(r.text ?? "") +
    utf8Length(r.yieldAck ?? "") +
    utf8Length(r.errorMessage ?? "") +
    blocksBytes(r.blocks ?? [])
  );
}

/**
 * Bound one row's content under ROW_TEXT_MAX_BYTES, never by cutting a text:
 *   1. everything when it fits;
 *   1b. else the tool blocks lose their arguments and results, marked cut with their size;
 *   2. else the blocks lose their text segments (`omitted`) — a row's FILES and TOOL blocks
 *      are never dropped for the size of its text;
 *   3. else (the text alone leaves no room for them) the text, acknowledgment and error text
 *      go — exactly what an over-bound text always did (its bubble keeps the live text).
 * Mirrored by convex/lib/transcriptProjection.ts `boundRowContent`.
 */
export function boundRowContent<
  R extends { text?: string; yieldAck?: string; errorMessage?: string; blocks?: RowBlock[] },
>(r: R): R {
  if (r.blocks === undefined || rowContentBytes(r) <= ROW_TEXT_MAX_BYTES) return r;
  // 2. the tool payloads go first (codex review 11): the cards stay, marked cut.
  const lean = { ...r, blocks: withoutToolPayloads(r.blocks) };
  if (rowContentBytes(lean) <= ROW_TEXT_MAX_BYTES) return lean;
  const stripped = { ...r, blocks: withoutBlockTexts(withoutToolPayloads(r.blocks)) };
  if (rowContentBytes(stripped) <= ROW_TEXT_MAX_BYTES) return stripped;
  const { text: _t, yieldAck: _a, errorMessage: _e, ...rest } = stripped;
  return rest as R;
}

export type HistoryRead = {
  kind: "page" | "delta" | "reset";
  rows: TranscriptRow[];
  /** Durable rows that could not be placed by identity (no id or seq). */
  unidentified: number;
  deltaCursor: string | null;
  sessionId: string | null;
  activeRunIds: string[] | null;
  hasActiveRun: boolean | null;
  /** The session's queue mode as the gateway projects it (`sessionInfo.queueMode` — the
   *  session's own override — and `effectiveQueueMode`, session-utils-row.ts:553-557 at
   *  v2026.9.8): what the composer shows a send made while the agent works will do. */
  queueMode: string | null;
  effectiveQueueMode: string | null;
  /** The gateway's custody of accepted inputs (null when the reply carried none). */
  pendingInputs: PendingInputsFacts | null;
  /** Receipts for the `inputRunIds` the read asked about (null when absent: the read
   *  asked nothing, or the gateway answers none for this session). */
  inputReceipts: InputReceipt[] | null;
  /** Receipts the reply carried but Atrium could not interpret (an unknown `state`,
   *  protocol drift): the ids are OBSERVED, never absent. */
  unreadableReceipts: UnreadableReceipts;
  /** Projection `on` only: the session's LAST run, when it ended failed or timed out, with
   *  the error the gateway recorded (`sessionInfo.lastRunId/status/lastRunError`). */
  lastRunFailure?: LastRunFailure;
};

/** THE RUN'S OWN ERROR (final design step 4). A run that failed with nothing written is
 *  shown by the gateway's `run-failed-before-reply` row; one that wrote anything first —
 *  the embedded runner always appends its `aborted` assistant row, so this is the common
 *  case (bench 2026-10-16, a run timeout: `stopReason: "aborted"`, empty) — has no such
 *  row, and the Control UI takes the terminal's error from the session row:
 *  `failureMessage ?? sessionInfo.lastRunError` for a failed/timeout status
 *  (ui/src/pages/chat/chat-history-stream.ts:233-247 at v2026.9.33). Bounded. */
export type LastRunFailure = { runId: string; status: "failed" | "timeout"; error: string };
export const LAST_RUN_ERROR_MAX_CHARS = 1024;

function readLastRunFailure(payload: Record<string, unknown>, display: RowDisplay): LastRunFailure | undefined {
  const info = asRecord(payload.sessionInfo);
  const runId = normalizeRunId(info?.lastRunId);
  const status = info?.status;
  const raw = projString(info?.lastRunError);
  if (runId === null || (status !== "failed" && status !== "timeout") || raw === null) return undefined;
  const error = sanitizeDisplay(raw, display.sessionKey).trim();
  if (error === "" || error.length > LAST_RUN_ERROR_MAX_CHARS) return undefined;
  return { runId, status, error };
}

export type UnreadableReceipts = {
  /** Ids of receipts whose state is not one Atrium knows. */
  ids: string[];
  /** Receipts with no readable id at all: no asked id can be proven absent then. */
  unattributed: number;
  /** The unknown state values (for the drift sensor, bounded). */
  states: string[];
};

const NO_UNREADABLE: UnreadableReceipts = { ids: [], unattributed: 0, states: [] };

/** The receipts `readInputReceipts` could not keep: an entry whose `state` is neither
 *  `pending` nor `consumed` (`ChatInputReceiptsSchema`, logs-chat.ts — a new state is
 *  protocol drift), or an entry that is not a record with a usable id. */
export function readUnreadableReceipts(value: unknown): UnreadableReceipts {
  if (!Array.isArray(value)) return NO_UNREADABLE;
  const ids: string[] = [];
  const states: string[] = [];
  let unattributed = 0;
  for (const raw of value.slice(0, INPUT_RUN_IDS_MAX)) {
    const r = asRecord(raw);
    const state = r?.state;
    if (state === "pending" || state === "consumed") {
      if (boundedRunId(r?.runId) === null) unattributed++;
      continue;
    }
    const runId = boundedRunId(r?.runId);
    if (runId === null) unattributed++;
    else ids.push(runId);
    if (states.length < 10) states.push(typeof state === "string" ? state : `<${typeof state}>`);
  }
  return { ids, unattributed, states };
}

// ── The input guard (custody), as identities ──────────────────────────────────────────

/** Upstream bounds (packages/gateway-protocol/src/schema/chat-history-constants.ts:
 *  `CHAT_INPUT_RECEIPT_MAX_RUN_IDS` = 50, `CHAT_INPUT_RUN_ID_MAX_CHARS` = 256) and the
 *  pending-inputs page cap (`ChatPendingInputsPageSchema.items` maxItems 20,
 *  logs-chat.ts; `readChatPendingInputs` limit, chat-pending-inputs.ts). */
export const INPUT_RUN_IDS_MAX = 50;
export const INPUT_RUN_ID_MAX_CHARS = 256;
export const PENDING_INPUT_ITEMS_MAX = 20;

export type PendingInputState = "queued" | "cancelled" | "interrupted";

/** One `pendingInputs.items[]` entry, identity only (never its `message`). */
export type PendingInputItem = {
  runId?: string;
  state: PendingInputState;
  /** 2026.9.7+: the input waits in the gateway's own queue (`queued: true`). */
  queued?: true;
};

export type PendingInputsFacts = {
  total: number;
  /** 2026.9.7+ (`ChatPendingInputsPageSchema.queuedCount`). */
  queuedCount?: number;
  items: PendingInputItem[];
  /** The page is the WHOLE list — no older page (`nextBefore` absent) and every item
   *  kept — the Control UI's `completePage` (ui/src/pages/chat/chat-pending-inputs.ts:62
   *  at v2026.9.8). Only then does an input's absence from it say it is in no queue. */
  complete?: true;
};

/** `ChatInputReceiptsSchema` (logs-chat.ts): `pending` (with the 9.7+ `queued` /
 *  `cancelled` flags) or `consumed`. */
export type InputReceipt = {
  runId: string;
  state: "pending" | "consumed";
  queued?: true;
  cancelled?: true;
};

const boundedRunId = (x: unknown): string | null =>
  typeof x === "string" && x.length > 0 && x.length <= INPUT_RUN_ID_MAX_CHARS ? x : null;

const nonNegativeInt = (x: unknown): number | null =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null;

/** `pendingInputs` of a `chat.history` reply (chat-history-handler.ts builds it for the
 *  current session; `readChatPendingInputs`, chat-pending-inputs.ts). Identity only. */
export function readPendingInputs(value: unknown): PendingInputsFacts | null {
  const page = asRecord(value);
  if (page === null || !Array.isArray(page.items)) return null;
  const items: PendingInputItem[] = [];
  let dropped = Math.max(0, page.items.length - PENDING_INPUT_ITEMS_MAX);
  for (const raw of page.items.slice(0, PENDING_INPUT_ITEMS_MAX)) {
    const item = asRecord(raw);
    const state = item?.state;
    if (state !== "queued" && state !== "cancelled" && state !== "interrupted") {
      dropped++;
      continue;
    }
    const runId = boundedRunId(item?.runId);
    // An item whose identity was dropped cannot be matched: the page names it unseen.
    if (item?.runId !== undefined && runId === null) dropped++;
    items.push({
      ...(runId === null ? {} : { runId }),
      state,
      ...(item?.queued === true ? { queued: true as const } : {}),
    });
  }
  const total = nonNegativeInt(page.total) ?? items.length;
  const queuedCount = nonNegativeInt(page.queuedCount);
  const complete =
    page.nextBefore === undefined && dropped === 0 && nonNegativeInt(page.total) === page.items.length;
  return {
    total,
    ...(queuedCount === null ? {} : { queuedCount }),
    items,
    ...(complete ? { complete: true as const } : {}),
  };
}

/** `inputReceipts` of a `chat.history` reply (present only when the read sent
 *  `inputRunIds`, chat-history-handler.ts). */
export function readInputReceipts(value: unknown): InputReceipt[] | null {
  if (!Array.isArray(value)) return null;
  const out: InputReceipt[] = [];
  for (const raw of value.slice(0, INPUT_RUN_IDS_MAX)) {
    const r = asRecord(raw);
    const runId = boundedRunId(r?.runId);
    if (runId === null) continue;
    if (r?.state === "consumed") out.push({ runId, state: "consumed" });
    else if (r?.state === "pending") {
      out.push({
        runId,
        state: "pending",
        ...(r.queued === true ? { queued: true as const } : {}),
        ...(r.cancelled === true ? { cancelled: true as const } : {}),
      });
    }
  }
  return out;
}

function readSessionInfo(payload: Record<string, unknown>): {
  sessionId: string | null;
  activeRunIds: string[] | null;
  hasActiveRun: boolean | null;
  queueMode: string | null;
  effectiveQueueMode: string | null;
} {
  const info = asRecord(payload.sessionInfo);
  const activeRaw = info?.activeRunIds;
  const mode = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 && v.length <= 32 ? v : null;
  return {
    queueMode: mode(info?.queueMode),
    effectiveQueueMode: mode(info?.effectiveQueueMode),
    sessionId: projString(payload.sessionId) ?? projString(info?.sessionId),
    // A list longer than the bound is CUT, and a cut list is not the complete one the
    // gateway sent (a run cut off would read as over): it is reported as unknown.
    activeRunIds:
      Array.isArray(activeRaw) && activeRaw.length <= 50
        ? activeRaw.filter((x): x is string => typeof x === "string" && x.length > 0)
        : null,
    hasActiveRun: typeof info?.hasActiveRun === "boolean" ? info.hasActiveRun : null,
  };
}

/**
 * Parse a `chat.history` reply (upstream src/gateway/server-methods/
 * chat-history-handler.ts:599-679 at v2026.9.6):
 *  - with a cursor: `{kind:"delta", messages: session.message envelopes, deltaCursor,
 *    sessionInfo, …}` or `{kind:"reset"}` (packages/gateway-protocol/src/schema/
 *    logs-chat.ts `ChatHistoryCursorResultSchema`);
 *  - without one (a tail page): `{sessionKey, sessionId, messages: display messages
 *    carrying `__openclaw`, deltaCursor?, sessionInfo, …}`.
 * Null when the reply is not one of these.
 */
export function parseHistoryReply(payload: unknown, display?: RowDisplay): HistoryRead | null {
  const p = asRecord(payload);
  if (p === null) return null;
  if (p.kind === "reset") {
    return {
      kind: "reset",
      rows: [],
      unidentified: 0,
      deltaCursor: null,
      sessionId: null,
      activeRunIds: null,
      hasActiveRun: null,
      queueMode: null,
      effectiveQueueMode: null,
      pendingInputs: null,
      inputReceipts: null,
      unreadableReceipts: NO_UNREADABLE,
    };
  }
  if (!Array.isArray(p.messages)) return null;
  const delta = p.kind === "delta";
  const rows: TranscriptRow[] = [];
  let unidentified = 0;
  for (const item of p.messages) {
    let row: TranscriptRow | null;
    if (delta) {
      const env = asRecord(item);
      row = env === null ? null : toTranscriptRow(env.message, env as TranscriptEnvelope, display);
    } else {
      row = toTranscriptRow(item, undefined, display);
    }
    if (row === null) unidentified++;
    else rows.push(row);
  }
  // The segments of one row, in the order the read lists them (codex review 10).
  const segmentsSeen = new Map<string, number>();
  for (const row of rows) {
    if (row.streamSegment !== true) continue;
    const at = row.entryId.indexOf(":segment:");
    const owner = at < 0 ? row.entryId : row.entryId.slice(0, at);
    const n = segmentsSeen.get(owner) ?? 0;
    row.segmentOrder = n;
    segmentsSeen.set(owner, n + 1);
  }
  const info = readSessionInfo(p);
  const lastRunFailure = display !== undefined ? readLastRunFailure(p, display) : undefined;
  return {
    kind: delta ? "delta" : "page",
    ...(lastRunFailure !== undefined ? { lastRunFailure } : {}),
    rows,
    unidentified,
    deltaCursor: typeof p.deltaCursor === "string" && p.deltaCursor !== "" ? p.deltaCursor : null,
    ...info,
    pendingInputs: readPendingInputs(p.pendingInputs),
    inputReceipts: readInputReceipts(p.inputReceipts),
    unreadableReceipts: readUnreadableReceipts(p.inputReceipts),
  };
}

/** The status a TERMINAL chat frame sets on its run — upstream
 *  packages/gateway-client/src/session-projection-run-event.ts:50-71
 *  (`reduceSessionProjectionRunEvent`). Null for a delta or an unreadable frame. */
export function runTerminalStatus(event: {
  state?: unknown;
  yielded?: unknown;
  stopReason?: unknown;
  errorKind?: unknown;
  message?: unknown;
}): "completed" | "error" | "aborted" | "timeout" | "yielded" | null {
  if (event.state !== "final" && event.state !== "error" && event.state !== "aborted") {
    return null;
  }
  const message = asRecord(event.message);
  const stopReason = projString(event.stopReason) ?? projString(message?.stopReason);
  const errorKind = projString(event.errorKind);
  if (event.state === "aborted") return "aborted";
  if (event.state === "error") return errorKind === "timeout" ? "timeout" : "error";
  if (event.yielded === true && stopReason === "end_turn") return "yielded";
  return stopReason === "error" ? "error" : "completed";
}

// ── Session events (redesign phase 2): what a `session.message` / `sessions.changed`
//    asks of the reconciler ─────────────────────────────────────────────────────────────

/** Does a content block carry a gateway-stored image (`artifactId`)? */
function hasArtifactImage(message: Record<string, unknown>): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some((part) => {
    const block = asRecord(part);
    return (
      block?.type === "image" && typeof block.artifactId === "string" && block.artifactId.trim() !== ""
    );
  });
}

export type LiveAdmission = {
  /** The row, when it is identified (entry id + seq) — null otherwise. */
  row: TranscriptRow | null;
  /** The Control UI applies it now (CU-16); otherwise only a read brings it. */
  admitted: boolean;
  why:
    | "user"
    | "previous_run"
    | "producer"
    | "tool_image"
    | "unadmitted"
    | "unidentified"
    | "imported"
    | "unreadable";
  role: string | null;
  /** `hasActiveRun` of the session snapshot the event carries (null: absent). */
  hasActiveRun: boolean | null;
};

/**
 * CU-16, the admission of a LIVE `session.message` — mirror of upstream
 * `applySessionMessagePayload` with `source.kind === "live"`
 * (ui/src/pages/chat/session-message-apply.ts:65-130 at v2026.9.8; same rule at
 * v2026.9.6 :82-133; v2026.8.2 lacks only the tool-image admission, :98-105):
 *   - a user row is always admitted;
 *   - a non-user row only when it is a sequenced assistant row of a run other than the
 *     foreground one (`isPreviousRunAssistant`), or its producer is PROVEN by the event
 *     (`incoming.runId === event.runId`) and that run is the one the pane is finishing
 *     (`finishingChatRunId`), or it is a sequenced tool row of a proven producer with a
 *     stored image;
 *   - a row with neither id, key nor seq is dropped (:130), and so is an imported row
 *     (its identity lives in another namespace — `toTranscriptRow` skips it anyway).
 * NOT mirrored: `finishingChatRunId`'s last branch, which admits a producer-less legacy
 * row when its TEXT equals the projected reply of the finished run — the shadow holds no
 * text; such a row reaches the store through the read the same event triggers.
 */
export function admitLiveRow(
  payload: unknown,
  ctx: {
    /** The run in the foreground of this session's turn (the pane's `chatRunId`). */
    activeRunId: string | null;
    /** The last foreground run whose terminal was observed (`lastLocalTerminalReconcile`). */
    recentTerminalRunId: string | null;
    /** PROJECTION `on`: read what the row says too. */
    display?: RowDisplay;
  },
): LiveAdmission {
  const event = asRecord(payload);
  const message = asRecord(event?.message);
  const hasActiveRun = typeof event?.hasActiveRun === "boolean" ? event.hasActiveRun : null;
  if (event === null || message === null) {
    return { row: null, admitted: false, why: "unreadable", role: null, hasActiveRun };
  }
  const id = readTranscriptIdentity(message, event as TranscriptEnvelope);
  if (id === null) {
    return { row: null, admitted: false, why: "unreadable", role: null, hasActiveRun };
  }
  const base = { role: id.role, hasActiveRun };
  if (id.isImported) return { ...base, row: null, admitted: false, why: "imported" };
  if (id.id === null && id.idempotencyKey === null && id.seq === null) {
    return { ...base, row: null, admitted: false, why: "unidentified" };
  }
  const row = toTranscriptRow(message, event as TranscriptEnvelope, ctx.display);
  if (id.role === "user") return { ...base, row, admitted: true, why: "user" };
  const eventRunId = projString(event.runId);
  const producerRunId = id.runId !== null && id.runId === eventRunId ? id.runId : null;
  const finishing = (producer: string | null): string | null => {
    if (ctx.activeRunId !== null) {
      return producer !== null && producer !== ctx.activeRunId ? null : ctx.activeRunId;
    }
    const recent = ctx.recentTerminalRunId;
    if (recent === null || producer === null) return null;
    return producer === recent ? recent : null;
  };
  const previousRun =
    id.role === "assistant" &&
    id.seq !== null &&
    id.runId !== null &&
    ctx.activeRunId !== null &&
    id.runId !== ctx.activeRunId;
  if (previousRun) return { ...base, row, admitted: true, why: "previous_run" };
  const runActive = hasActiveRun;
  const owner =
    id.role === "assistant" &&
    id.id !== null &&
    (producerRunId !== null || (id.runId === null && runActive !== true))
      ? finishing(producerRunId)
      : null;
  if (owner !== null) return { ...base, row, admitted: true, why: "producer" };
  const isTool = id.role === "toolresult" || id.role === "tool";
  const toolImage =
    isTool && id.id !== null && id.seq !== null && producerRunId !== null && hasArtifactImage(message)
      ? finishing(producerRunId)
      : null;
  if (toolImage !== null) return { ...base, row, admitted: true, why: "tool_image" };
  return { ...base, row, admitted: false, why: "unadmitted" };
}

/** What a `sessions.changed` asks of the reconciler. */
export type SessionsChangedAction = {
  /** The transcript of the session was replaced: drop the cursor, read a fresh page. */
  reset: boolean;
  /** Read the transcript back (coalesced like every read). */
  read: boolean;
  why: "reset" | "new" | "compact" | "message_batch" | "custody" | "run_end" | null;
};

/** `sessions.changed` reasons after which custody may have changed without a transcript
 *  append (upstream `PENDING_INPUT_REASONS`, ui/src/pages/chat/chat-state-events.ts:71
 *  at v2026.9.8; :72 at v2026.9.6). */
const PENDING_INPUT_REASONS = new Set(["send", "agent.run.started", "agent.input.settled"]);

/**
 * The Control UI's `handleSessionsChangedEvent` (chat-state-events.ts:343-457 at
 * v2026.9.8), reduced to what a reconciler that holds no display state needs:
 *   - `reason:"reset"` / `phase:"reset"` → `sessionReset`, then a read (:356, :372-377,
 *     :412-416);
 *   - `reason:"new"` → the same (DESIGN §4.1, literal: the Control UI only retires its
 *     companion there, :357-366 — a new session restarts `seq`, so the old cursor names
 *     nothing in it);
 *   - `reason:"compact"` → a read (:412);
 *   - `phase:"message"` with no `message`/`messageId`/`messageSeq` → a read (a batch
 *     write that proves no individual cursor, :418-431);
 *   - `reason` ∈ `send` / `agent.run.started` / `agent.input.settled` → a read (custody
 *     changed, :433-444);
 *   - `phase` ∈ `end` / `error` (run lifecycle, src/gateway/server-chat.ts:683-703) → a
 *     read: the Control UI reconciles a finished run from its row
 *     (`finishSessionMessageRunReconcile`, :447-455), which reads history.
 * Anything else (patch, title, archive, …) asks nothing.
 */
export function classifySessionsChanged(payload: unknown): SessionsChangedAction {
  const p = asRecord(payload);
  const reason = typeof p?.reason === "string" ? p.reason : null;
  const phase = typeof p?.phase === "string" ? p.phase : null;
  if (reason === "reset" || phase === "reset") return { reset: true, read: true, why: "reset" };
  if (reason === "new") return { reset: true, read: true, why: "new" };
  if (reason === "compact") return { reset: false, read: true, why: "compact" };
  if (
    phase === "message" &&
    p?.message === undefined &&
    p?.messageId === undefined &&
    p?.messageSeq === undefined
  ) {
    return { reset: false, read: true, why: "message_batch" };
  }
  if (reason !== null && PENDING_INPUT_REASONS.has(reason)) {
    return { reset: false, read: true, why: "custody" };
  }
  if (phase === "end" || phase === "error") return { reset: false, read: true, why: "run_end" };
  return { reset: false, read: false, why: null };
}

/** The session key a session event names (`sessionKey`, a trimmed non-empty string). */
export function sessionEventKey(payload: unknown): string | null {
  return projString(asRecord(payload)?.sessionKey);
}
