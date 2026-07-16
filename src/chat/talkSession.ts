// Realtime voice ("talk") — the PURE lifecycle core of a browser talk session.
//
// The component (TalkControl) owns the WebRTC objects; THIS module owns the
// decisions: state transitions, generation guards (a stale session's async
// callback must never touch a newer session — the detached-composer lesson,
// worse here because WebRTC teardown is multi-async), and the SDP handshake
// against the gateway-minted ephemeral session (fetch injected for tests).
//
// Shape probed LIVE on OpenClaw 2026.7.1: the mint carries {clientSecret,
// offerUrl, model, voice, expiresAt}; the browser POSTs its SDP offer to
// offerUrl with `Authorization: Bearer <clientSecret>` (Content-Type
// application/sdp) and receives the answer SDP.

/** Talk session phases (one-way progress; `ending` only goes to `idle`). */
export type TalkPhase =
  | "idle"
  | "minting" // asking Convex/bridge/gateway for the ephemeral session
  | "connecting" // getUserMedia + SDP handshake in flight
  | "live" // audio flowing
  | "ending"; // teardown requested — ignore late async results

export type TalkStatus = {
  phase: TalkPhase;
  /** Human-facing detail for the panel (model/voice once known). */
  model: string | null;
  voice: string | null;
  /** Mic muted locally (sender track disabled) — the session stays live. */
  muted: boolean;
  /** Last terminal error code (cleared on the next start). */
  errorCode: string | null;
};

export const INITIAL_TALK_STATUS: TalkStatus = {
  phase: "idle",
  model: null,
  voice: null,
  muted: false,
  errorCode: null,
};

/** Legal transitions — everything else is a stale/buggy caller and is refused.
 *  Pure so the matrix is table-testable. */
export function nextTalkPhase(
  current: TalkPhase,
  event:
    | "start" // user pressed talk
    | "minted" // session material arrived
    | "connected" // SDP answered + tracks flowing
    | "hangup" // user pressed stop (or navigation/unmount)
    | "failed" // any step errored
    | "ended", // teardown finished
): TalkPhase | null {
  switch (event) {
    case "start":
      return current === "idle" ? "minting" : null;
    case "minted":
      return current === "minting" ? "connecting" : null;
    case "connected":
      return current === "connecting" ? "live" : null;
    case "hangup":
      return current === "minting" || current === "connecting" || current === "live"
        ? "ending"
        : null;
    case "failed":
      // A failure mid-teardown stays "ending" (the teardown finishes anyway).
      return current === "minting" || current === "connecting" || current === "live"
        ? "ending"
        : null;
    case "ended":
      return current === "ending" ? "idle" : null;
  }
}

/** The call URL: the provider's documented WebRTC flow passes the MODEL as a
 *  query parameter on the calls endpoint (omitting it 500s on the real offer —
 *  live repro 2026-07-16); the mint carries the model for exactly this. Pure. */
export function buildCallUrl(offerUrl: string, model: string | null): string {
  if (model === null || model === "") return offerUrl;
  const sep = offerUrl.includes("?") ? "&" : "?";
  return `${offerUrl}${sep}model=${encodeURIComponent(model)}`;
}

/**
 * SDP handshake against the provider's realtime endpoint. `fetchImpl` is
 * injected (tests + future transports). Returns the answer SDP, or a coded
 * error — NEVER throws (component code stays branch-simple).
 * The clientSecret is used ONLY as the Authorization header here — never
 * logged, never persisted.
 */
export async function exchangeSdp(
  session: { offerUrl: string; clientSecret: string; model?: string | null },
  offerSdp: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; answerSdp: string } | { ok: false; code: string }> {
  try {
    const res = await fetchImpl(buildCallUrl(session.offerUrl, session.model ?? null), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offerSdp,
    });
    if (!res.ok) {
      // 401 = the ephemeral secret expired before the user finished connecting
      // (expiresAt) — surfaced distinctly so the UI can offer a clean retry.
      return {
        ok: false,
        code: res.status === 401 ? "talk_secret_expired" : `sdp_${res.status}`,
      };
    }
    const answerSdp = await res.text();
    if (answerSdp.trim() === "") return { ok: false, code: "sdp_empty" };
    return { ok: true, answerSdp };
  } catch {
    return { ok: false, code: "sdp_unreachable" };
  }
}

/** The gateway's realtime voice allowlist — MEASURED on OpenClaw 2026.7.1
 *  (OPENAI_REALTIME_VOICES in the gateway dist; mirrored by the official talk
 *  docs). Order: the two the docs RECOMMEND first, then the rest. An unknown
 *  value never breaks anything — the gateway falls back to its configured
 *  default. */
export const TALK_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;

const TALK_VOICE_KEY = "oc.talk.voice";
const TALK_VAD_KEY = "oc.talk.vad";

/** Mic-sensitivity presets -> the provider's server_vad `threshold` (0..1 —
 *  HIGHER threshold = needs LOUDER speech = LESS sensitive; provider default
 *  ~0.5). "" = don't send, the gateway/provider default applies. */
export const TALK_VAD_LEVELS = [
  { id: "low", threshold: 0.8 }, // noisy room: only clear speech triggers
  { id: "medium", threshold: 0.5 },
  { id: "high", threshold: 0.3 }, // quiet room: picks up soft speech
] as const;
export type TalkVadLevel = (typeof TALK_VAD_LEVELS)[number]["id"];

/** Sanitize a stored value to a known level id, or "" (= provider default). */
export function sanitizeTalkVad(value: string | null | undefined): string {
  return TALK_VAD_LEVELS.some((l) => l.id === value) ? (value as string) : "";
}

/** The provider threshold for a stored level ("" -> null = don't send). */
export function talkVadThreshold(level: string): number | null {
  const found = TALK_VAD_LEVELS.find((l) => l.id === level);
  return found ? found.threshold : null;
}

export function loadTalkVad(): string {
  try {
    return sanitizeTalkVad(localStorage.getItem(TALK_VAD_KEY));
  } catch {
    return "";
  }
}

export function saveTalkVad(level: string): void {
  try {
    if (sanitizeTalkVad(level) === "") localStorage.removeItem(TALK_VAD_KEY);
    else localStorage.setItem(TALK_VAD_KEY, level);
  } catch {
    /* storage unavailable — the pick just doesn't persist */
  }
}

/** Sanitize a stored/user value to a known voice, or "" (= gateway default). */
export function sanitizeTalkVoice(value: string | null | undefined): string {
  return (TALK_VOICES as readonly string[]).includes(value ?? "")
    ? (value as string)
    : "";
}

/** The user's persisted voice pick ("" = gateway default). Never throws. */
export function loadTalkVoice(): string {
  try {
    return sanitizeTalkVoice(localStorage.getItem(TALK_VOICE_KEY));
  } catch {
    return "";
  }
}

export function saveTalkVoice(voice: string): void {
  try {
    if (sanitizeTalkVoice(voice) === "") localStorage.removeItem(TALK_VOICE_KEY);
    else localStorage.setItem(TALK_VOICE_KEY, voice);
  } catch {
    /* storage unavailable — the pick just doesn't persist */
  }
}

/** A voice-model TOOL CALL surfaced on the provider's data channel — the
 *  browser must relay `openclaw_agent_consult` to the gateway (a real agent
 *  run) and feed the result back as function_call_output. */
export type TalkToolCall = {
  callId: string;
  name: string;
  /** The model's arguments, parsed (invalid JSON -> {}). */
  args: Record<string, unknown>;
};

/**
 * Parse one data-channel message into a tool call, or null for everything
 * else (audio transcripts, deltas, lifecycle…). Handles BOTH provider event
 * shapes that carry completed function-call arguments:
 *  - response.output_item.done  {item:{type:"function_call", call_id, name, arguments}}
 *  - response.function_call_arguments.done  {call_id, name?, arguments}
 * Pure and total — never throws on garbage input. The CALLER dedupes by
 * callId (both events can fire for the same call).
 */
export function parseTalkToolCall(raw: string): TalkToolCall | null {
  let evt: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    evt = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  let callId: unknown;
  let name: unknown;
  let argsJson: unknown;
  if (evt.type === "response.output_item.done") {
    const item = evt.item as Record<string, unknown> | undefined;
    if (!item || item.type !== "function_call") return null;
    callId = item.call_id;
    name = item.name;
    argsJson = item.arguments;
  } else if (evt.type === "response.function_call_arguments.done") {
    callId = evt.call_id;
    name = evt.name;
    argsJson = evt.arguments;
  } else {
    return null;
  }
  if (typeof callId !== "string" || callId === "") return null;
  if (typeof name !== "string" || name === "") return null;
  let args: Record<string, unknown> = {};
  if (typeof argsJson === "string" && argsJson !== "") {
    try {
      const parsed: unknown = JSON.parse(argsJson);
      if (parsed !== null && typeof parsed === "object") {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // model emitted malformed JSON — relay with empty args (the gateway
      // validates and answers cleanly)
    }
  }
  return { callId, name, args };
}

/** Map a talk error code to the i18n message KEY the panel shows. Pure, total:
 *  unknown codes collapse onto the generic entry (never a raw code in the UI). */
export function talkErrorKey(
  code: string,
):
  | "talk_error_disabled"
  | "talk_error_unsupported"
  | "talk_error_mic_denied"
  | "talk_error_secret_expired"
  | "talk_error_generic" {
  switch (code) {
    case "talk_disabled":
      return "talk_error_disabled";
    case "talk_unsupported":
    case "provider_unsupported":
      return "talk_error_unsupported";
    case "mic_denied":
      return "talk_error_mic_denied";
    case "talk_secret_expired":
      return "talk_error_secret_expired";
    default:
      return "talk_error_generic";
  }
}
