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

/** The material the handshake needs, on either lane (see convex/lib/talk.ts). */
export type TalkHandshakeSession = {
  /** Direct lane: the provider's https endpoint + the ephemeral secret. */
  offerUrl?: string | null;
  clientSecret?: string | null;
  offerHeaders?: Record<string, string> | null;
  model?: string | null;
  /** Relayed lane (GPT Live): the opaque handle the bridge issued. */
  offerRelay?: { relayId: string } | null;
};

/**
 * What to do with a session the mint just returned, given whether the user is still
 * on the line. A RELAYED session is a call the GATEWAY owns and holds open on the
 * bridge's socket; if the user hung up while the mint was in flight, nobody will ever
 * connect to it and nobody would ever close it — it would sit on one of the two
 * reservations the gateway allows per socket until its TTL (codex P1, 2026-09-19).
 * So an owned session arriving after a hangup is hung up AT ONCE. A direct session is
 * the browser's own; unused, it simply expires. Pure, so the race is table-testable.
 */
export function mintedSessionDisposition(
  session: { offerRelay?: { relayId: string } | null },
  stillCurrent: boolean,
): "connect" | "hangup-now" | "drop" {
  if (stillCurrent) return "connect";
  return session.offerRelay ? "hangup-now" : "drop";
}

/** The headers the direct-lane handshake sets itself; a provider header of the same
 *  name, in any spelling, is never merged beside them. */
const RESERVED_OFFER_HEADERS = new Set(["authorization", "content-type"]);

/**
 * Hang up a gateway-owned call with BOUNDED retries. The hangup is fire-and-forget
 * from the UI's point of view, but forgetting it on the first network blip would
 * leave the call held on the bridge's socket until the gateway's own TTL (codex P2,
 * pass 5). A refusal (`ok:false`) and a rejection are both retried; the gateway's
 * close is idempotent, so a duplicate costs nothing. Delays are injected for tests.
 */
export async function hangupWithRetry(
  attempt: () => Promise<{ ok: boolean }>,
  delaysMs: readonly number[] = [1_000, 3_000],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (let i = 0; ; i += 1) {
    try {
      if ((await attempt()).ok) return true;
    } catch {
      /* retried below */
    }
    if (i >= delaysMs.length) return false;
    await sleep(delaysMs[i]!);
  }
}

/** How a RELAYED offer travels: the Convex action that posts it through the bridge
 *  to the gateway's own route. Injected so this module stays pure. */
export type TalkOfferRelay = (
  relayId: string,
  offerSdp: string,
) => Promise<{ ok: true; answerSdp: string } | { ok: false; code: string }>;

/**
 * SDP handshake, on whichever lane the mint chose. `fetchImpl` (direct lane) and
 * `relayImpl` (relayed lane) are injected. Returns the answer SDP, or a coded
 * error — NEVER throws (component code stays branch-simple).
 *
 * Direct lane: the clientSecret is used ONLY as the Authorization header here —
 * never logged, never persisted — and the provider's extra offer headers ride
 * beside it (the gateway strips its server-only ones before handing them over).
 * Relayed lane: the browser never held a secret; it presents the handle and its
 * SDP, and the bridge does the rest.
 */
export async function exchangeSdp(
  session: TalkHandshakeSession,
  offerSdp: string,
  fetchImpl: typeof fetch = fetch,
  relayImpl?: TalkOfferRelay,
): Promise<{ ok: true; answerSdp: string } | { ok: false; code: string }> {
  if (session.offerRelay) {
    if (!relayImpl) return { ok: false, code: "relay_unavailable" };
    try {
      const res = await relayImpl(session.offerRelay.relayId, offerSdp);
      if (!res.ok) return res;
      if (res.answerSdp.trim() === "") return { ok: false, code: "sdp_empty" };
      return res;
    } catch {
      return { ok: false, code: "relay_failed" };
    }
  }
  if (!session.offerUrl || !session.clientSecret) {
    return { ok: false, code: "talk_malformed" };
  }
  try {
    // The provider's extra headers ride along, EXCEPT the two this handshake owns.
    // HTTP header names are case-insensitive and Fetch COMBINES same-name entries:
    // an `authorization` (lowercase) beside our `Authorization` would reach the wire
    // as `Bearer stale, Bearer ours` (codex P2, pass 4). Dropped by lowercase name,
    // so ours are the only ones there whatever the spelling.
    const extra = Object.fromEntries(
      Object.entries(session.offerHeaders ?? {}).filter(
        ([name]) => !RESERVED_OFFER_HEADERS.has(name.toLowerCase()),
      ),
    );
    const res = await fetchImpl(buildCallUrl(session.offerUrl, session.model ?? null), {
      method: "POST",
      headers: {
        ...extra,
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

/**
 * Should the voice control render NOTHING?
 *
 * `available` is ONE server answer — the per-instance admin gate AND the gateway
 * capability, both evaluated for the instance the session would actually reach and
 * both FAIL CLOSED (the standing policy for talk: a button on a gateway without the
 * surface hard-fails at the mint). `undefined` is the query in flight, which is not
 * a yes.
 *
 * NEVER TRUE OUTSIDE `idle`. That answer is reactive and can flip while a
 * conversation is UP. Rendering null does not unmount this component — React keeps
 * it and its effects, so the microphone and the peer connection survive — it removes
 * the CONTROLS, leaving the user in a live call with no way to mute or hang up. (The
 * parent's remount key is a different mechanism: unmounting DOES run the teardown
 * effect, which is why changing chat correctly ends the call.)
 */
export function hidesTalkControl(state: {
  phase: TalkPhase;
  /** `talkAvailable` — undefined while the query is in flight. */
  available: boolean | undefined;
}): boolean {
  if (state.phase !== "idle") return false;
  return state.available !== true;
}

/**
 * Is this failure TERMINAL for the CALL IN PROGRESS? Only consult failures reach
 * here; a mint that fails never opened a call.
 *
 * The line between the two lists is whether the NEXT consult could plausibly
 * succeed. Terminal means a right or a session is gone for good:
 *
 *   talk_session_stale   the server no longer recognises the session this call was
 *                        opened on (handle expired, row lost);
 *   agent_restricted     the agent this call was pinned to was revoked, deleted or
 *                        retyped mid-call;
 *   talk_disabled        the instance's talk gate was switched off;
 *   talk_unsupported     the target has no talk surface at all (Hermes);
 *   provider_unsupported the bridge's spelling of the same;
 *   no_agent             no routable agent remains for this chat.
 *
 * None of these is permanent in principle — a grant can be given back, talk can be
 * switched on again, a roster can refill. What they share is that nothing the USER
 * can do from inside the call changes them, so every later consult fails identically
 * while the voice model apologises once per question. The call is ended instead and
 * the failure is surfaced as a toast — `talkErrorMessage` gives several of these
 * codes the generic wording plus the technical code, which is what a screenshot
 * needs to pinpoint the step.
 *
 * Everything else — a relay that failed, an unreachable or erroring bridge, a bad
 * argument, a one-off gateway error — is a SINGLE consult failing. Those can be
 * transient or specific to the question asked, so the voice model is told and the
 * conversation continues.
 */
const TERMINAL_TALK_CODES = new Set([
  "talk_session_stale",
  "agent_restricted",
  "talk_disabled",
  "talk_unsupported",
  // The bridge's own spelling of the same thing, from /talk-toolcall: a target with
  // no talk surface. `talkErrorKey` already treats the two as one; this must too, or
  // a bridge redeploy under a live call leaves every consult failing identically.
  "provider_unsupported",
  "no_agent",
]);
// NOT here: `talk_owner_unconfirmed`. It is a MINT failure (the bridge could not
// prove it scoped the session), and this predicate only ever sees a consult failing
// — there is no call to end. It reaches the user through the mint's own error path.

export function endsTheCall(code: string): boolean {
  return TERMINAL_TALK_CODES.has(code);
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
  | "talk_error_session_stale"
  | "talk_error_generic" {
  switch (code) {
    case "talk_disabled":
      return "talk_error_disabled";
    case "talk_session_stale":
      return "talk_error_session_stale";
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
