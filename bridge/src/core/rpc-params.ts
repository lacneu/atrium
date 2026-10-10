// OUTBOUND RPC parameter builders — the bodies the bridge SENDS to a gateway.
//
// One home, and a NEUTRAL one: these were inline in `server.ts` handlers, where the only
// way to test them was to transcribe them (which tests the transcription). Extracted as
// pure functions so `outbound-ratchet.test.ts` validates the REAL construction against
// every vendored TypeBox schema — and placed here rather than in `server.ts` because
// `session.ts` sends some of them too and cannot import the server without a cycle.
//
// Every schema they answer to is `additionalProperties: false`. One extra field in one of
// these objects makes the call fail INVALID_REQUEST on every gateway that predates it —
// which is exactly why they are worth a module and a gate of their own.

import {
  CHAT_HISTORY_INPUT_RUN_IDS_SINCE,
  CHAT_HISTORY_MAX_BYTES_SINCE,
  gatewayAtLeast,
} from "../compat.js";

/** `sessions.get` params: read one session's transcript. Upstream parses this by hand
 *  and publishes NO schema for it, so the outbound ratchet cannot validate the body —
 *  but it captures it, so a change here is at least VISIBLE. */
export function sessionsGetParams(sessionKey: string): Record<string, unknown> {
  return { key: sessionKey };
}

/** `tts.*` params. `convert` carries the text; `status` and `providers` take none.
 *  Upstream schematizes only `tts.speak`, which Atrium never calls, so these three are
 *  unvalidatable by construction — captured for visibility, like `sessions.get`. */
export function ttsParams(method: string, text: string): Record<string, unknown> {
  return method === "convert" ? { text } : {};
}

/** `chat.abort` params. With a runId the gateway cancels the NAMED run — immune to a
 *  newer run having started on the session meanwhile; without one it cancels whatever is
 *  active. Extracted for the outbound ratchet: this body is built in an HTTP handler, and
 *  `ChatAbortParams` is `additionalProperties:false` like the rest. */
export function chatAbortParams(
  sessionKey: string,
  runId: string | null,
  opts?: { discardPendingInput?: true },
): Record<string, unknown> {
  return {
    sessionKey,
    ...(runId ? { runId } : {}),
    // 2026.9.7+ only (`ChatAbortParamsSchema.discardPendingInput`, logs-chat.ts:342 at
    // v2026.9.8; absent at v2026.9.6): the CALLER gates it, the schema is CLOSED.
    ...(runId && opts?.discardPendingInput === true ? { discardPendingInput: true } : {}),
  };
}

/** `sessions.abort` for a key-only stop that also discards the session's followup
 *  queue (`SessionsAbortParamsSchema.clearQueued`: schema/sessions.ts:503 at v2026.8.2,
 *  :468 at v2026.9.6, present at v2026.9.8). */
export function sessionsAbortParams(sessionKey: string): Record<string, unknown> {
  return { key: sessionKey, clearQueued: true };
}

/**
 * THE CONTROL UI'S STOP (transcript projection `on`, phase 3, design §3.4), ported from
 * `requestChatAbort` (ui/src/pages/chat/chat-abort-request.ts:58-95 at v2026.9.8):
 *   - a run in the foreground → `chat.abort {sessionKey, runId}`;
 *   - no run in the foreground → `sessions.abort {key, clearQueued:true}` — a key-only
 *     stop also discards the session's followup queue (`queuedSessionAbortParams`
 *     :97-107; Atrium's conversation sessions are never the global one);
 *   - discarding ONE queued input (9.7+) → `chat.abort {sessionKey, runId,
 *     discardPendingInput:true}`.
 */
export function projectedAbortTarget(args: {
  runId: string | null;
  discardPendingInput?: boolean;
}): { kind: "run"; runId: string; discardPendingInput: boolean } | { kind: "session" } {
  if (args.runId === null) return { kind: "session" };
  return { kind: "run", runId: args.runId, discardPendingInput: args.discardPendingInput === true };
}

/**
 * WHICH RUN a projected stop names. The Control UI pairs a `runId` only with the
 * session that owns it and stops any other session by key
 * (ui/src/pages/chat/chat-abort-request.ts:58-84 at v2026.9.8). The bridge's live
 * session for a chat may be ANOTHER session than the one the stop targets — the
 * parent's, while the stop is for a sub-agent working at the same time — so its
 * foreground run is used only when its session IS the target (`ownsLive`).
 * Discarding a queued input names the input's own run, whatever runs here.
 */
export function projectedStopRun(args: {
  targetSessionKey: string;
  live: { sessionKey: string; foregroundRunId: string | null } | null;
  bodyRunId: string | null;
  discardPendingInput: boolean;
}): { ownsLive: boolean; runId: string | null } {
  const ownsLive = args.live !== null && args.live.sessionKey === args.targetSessionKey;
  if (args.discardPendingInput) return { ownsLive, runId: args.bodyRunId };
  const foreground = ownsLive ? (args.live?.foregroundRunId ?? null) : null;
  return { ownsLive, runId: foreground ?? args.bodyRunId };
}

/** `talk.client.create` params: the browser-held realtime session. Only `transport` is
 *  always sent; voice and the VAD threshold ride along when the caller chose them, and
 *  are OMITTED otherwise so the gateway default applies. Extracted for the outbound
 *  ratchet — `additionalProperties:false` makes an extra field here a hard refusal.
 *
 *  `sessionKey` NAMES THE OWNER. The gateway derives a Talk session's agent from an
 *  agent-scoped key (`agent:<id>:…`, upstream `resolveTalkSessionAgentId`) and,
 *  without one, falls back to `config.talk.agentId` — refusing outright only when
 *  several agents exist and no such fallback is set: "Talk session ownership has no
 *  explicit owner" (live prod 2026-09-17, six and seven agents, voice unavailable).
 *  BOTH outcomes are wrong for Atrium: the refusal kills voice, and the fallback
 *  answers as one arbitrary agent instead of the chat's. Optional here, and omitted
 *  when the caller named no owner at all, so a single-agent gateway and an older
 *  Convex keep the previous behaviour. */
export function talkClientCreateParams(
  transport: string,
  voice: string | null,
  vadThreshold: number | null,
  sessionKey: string | null = null,
): Record<string, unknown> {
  return {
    transport,
    ...(sessionKey !== null ? { sessionKey } : {}),
    ...(voice !== null ? { voice } : {}),
    ...(vadThreshold !== null ? { vadThreshold } : {}),
  };
}

/** `talk.client.toolCall` params: a voice consult, addressed by the AGENT session key so
 *  it lands in the same session as a typed turn. The tool name is fixed. */
export function talkToolCallParams(
  sessionKey: string,
  callId: string,
  args: unknown,
): Record<string, unknown> {
  return { sessionKey, callId, name: "openclaw_agent_consult", args };
}

/** `talk.client.close` params: end the LOGICAL voice session the gateway owns for
 *  a GPT Live call, addressed like the create was — by the agent session key — plus
 *  the `voiceSessionId` the mint returned. Idempotent upstream
 *  (docs/gateway/protocol/rpc-talk-config-and-agents.md, v2026.9.5). */
export function talkClientCloseParams(
  sessionKey: string,
  voiceSessionId: string,
): Record<string, unknown> {
  return { sessionKey, voiceSessionId };
}

/** `tasks.get` params. Extracted so the OUTBOUND ratchet validates the REAL body
 *  against every vendored schema — these live inside an HTTP handler, and a body built
 *  inline can only be tested by transcribing it, which tests the transcription. */
export function taskGetParams(taskId: string): Record<string, unknown> {
  return { taskId };
}

/** `tasks.list` params: the live engagements of ONE session key. `status` is narrowed
 *  on the wire rather than filtered locally — a finished task is not the bridge's
 *  business here, and the cap bounds a session with a long task history. */
export function taskListParams(sessionKey: string): Record<string, unknown> {
  return { sessionKey, status: ["queued", "running"], limit: 50 };
}

/** The page the Control UI reads (ui/src/pages/chat/chat-history-request.ts:35-36:
 *  `CHAT_HISTORY_REQUEST_LIMIT = 80`, `CHAT_HISTORY_REQUEST_MAX_BYTES = 256 * 1024`). */
export const CHAT_HISTORY_PAGE_LIMIT = 80;
export const CHAT_HISTORY_PAGE_MAX_BYTES = 256 * 1024;

/** `chat.history` params (`ChatHistoryParamsSchema`, CLOSED upstream). `cursor` resumes a
 *  delta read (2026.8.1+; incompatible with `offset`/`messageId`, chat-history-handler.ts
 *  :123); `maxBytes` exists only from 2026.9.2, so it is sent ONLY to a gateway KNOWN to
 *  be at least that version — an older one would refuse the whole read over the key, and
 *  an unknown version gets the conservative body. */
export function chatHistoryParams(
  p: {
    sessionKey: string;
    cursor?: string | null;
    limit: number;
    maxChars?: number;
    maxBytes?: number;
    /** Send identities whose custody the reply should report (`inputReceipts`). The
     *  upstream array is `minItems: 1`, so an empty list is omitted, never sent. */
    inputRunIds?: readonly string[];
  },
  gatewayVersion: string | null,
): Record<string, unknown> {
  return {
    sessionKey: p.sessionKey,
    ...(p.cursor ? { cursor: p.cursor } : {}),
    limit: p.limit,
    ...(p.maxChars === undefined ? {} : { maxChars: p.maxChars }),
    ...(p.maxBytes !== undefined &&
    gatewayAtLeast(gatewayVersion, CHAT_HISTORY_MAX_BYTES_SINCE) === true
      ? { maxBytes: p.maxBytes }
      : {}),
    ...(p.inputRunIds !== undefined &&
    p.inputRunIds.length > 0 &&
    gatewayAtLeast(gatewayVersion, CHAT_HISTORY_INPUT_RUN_IDS_SINCE) === true
      ? { inputRunIds: [...p.inputRunIds] }
      : {}),
  };
}
