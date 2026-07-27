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
): Record<string, unknown> {
  return { sessionKey, ...(runId ? { runId } : {}) };
}

/** `talk.client.create` params: the browser-held realtime session. Only `transport` is
 *  always sent; voice and the VAD threshold ride along when the caller chose them, and
 *  are OMITTED otherwise so the gateway default applies. Extracted for the outbound
 *  ratchet — `additionalProperties:false` makes an extra field here a hard refusal. */
export function talkClientCreateParams(
  transport: string,
  voice: string | null,
  vadThreshold: number | null,
): Record<string, unknown> {
  return {
    transport,
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
