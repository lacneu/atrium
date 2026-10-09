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

import { messageDisplayText, sanitizeDisplay } from "./normalizer.js";

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

/** Tool call ids a row carries (`toolCallId` on a tool result, `id` on call blocks). */
export function rowToolCallIds(message: unknown): string[] {
  const record = asRecord(message);
  if (record === null) return [];
  const out = new Set<string>();
  const direct = projString(record.toolCallId) ?? projString(record.tool_call_id);
  if (direct) out.add(direct);
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      const b = asRecord(block);
      if (b === null) continue;
      if (isToolCallType(b.type) || isToolResultType(b.type)) {
        const id = projString(b.id) ?? projString(b.toolCallId) ?? projString(b.toolUseId);
        if (id) out.add(id);
      }
    }
  }
  return [...out].slice(0, 32);
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
};

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
  const toolCallIds = rowToolCallIds(message);
  let runId = id.runId;
  let shown: { text?: string; yieldAck?: string } = {};
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
  }
  return {
    entryId: id.id,
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
  };
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
};

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
  const info = readSessionInfo(p);
  return {
    kind: delta ? "delta" : "page",
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
