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
};

/** A row the Control UI keeps: it needs an id and a sequence to be placed by identity
 *  (upstream session-message-apply.ts:65-188 drops rows without id/key/seq). Imported
 *  rows (CLI history) live in another identity namespace and are skipped here. */
export function toTranscriptRow(
  message: unknown,
  envelope?: TranscriptEnvelope,
): TranscriptRow | null {
  const id = readTranscriptIdentity(message, envelope);
  if (id === null || id.isImported || id.id === null || id.seq === null) return null;
  const facts = rowDisplayFacts(message);
  const toolCallIds = rowToolCallIds(message);
  return {
    entryId: id.id,
    seq: id.seq,
    role: id.role,
    ...(id.runId === null ? {} : { runId: id.runId }),
    ...(id.sendId === null ? {} : { sendId: id.sendId }),
    ...(id.steerTargetRunId === null ? {} : { steerTargetRunId: id.steerTargetRunId }),
    ...(id.mirrorOrigin === null ? {} : { mirrorOrigin: id.mirrorOrigin }),
    ...(id.runTerminal ? { runTerminal: true } : {}),
    hidden: facts.hidden,
    visible: facts.visible,
    ...(toolCallIds.length > 0 ? { toolCallIds } : {}),
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
};

function readSessionInfo(payload: Record<string, unknown>): {
  sessionId: string | null;
  activeRunIds: string[] | null;
  hasActiveRun: boolean | null;
} {
  const info = asRecord(payload.sessionInfo);
  const activeRaw = info?.activeRunIds;
  return {
    sessionId: projString(payload.sessionId) ?? projString(info?.sessionId),
    activeRunIds: Array.isArray(activeRaw)
      ? activeRaw.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 50)
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
export function parseHistoryReply(payload: unknown): HistoryRead | null {
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
      row = env === null ? null : toTranscriptRow(env.message, env as TranscriptEnvelope);
    } else {
      row = toTranscriptRow(item);
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
