// Realtime voice ("talk") — pure helpers for the gateway-minted ephemeral
// browser session (gateway talk.client.create, relayed by the bridge
// /talk-session route). PURE module (no Convex imports) so the projection is
// unit-testable.
//
// TWO LANES, decided by the gateway PER MINT and told apart by what the bridge
// answers (OpenClaw >= 2026.9.5; shapes probed live 2026-07-16 and 2026-09-19):
//
//   - DIRECT: `{ provider, transport, clientSecret: "ek_…", offerUrl: "https://…",
//     offerHeaders?, model, voice, expiresAt, voiceSessionId? }` — the classic
//     realtime model (`talk.realtime.model` pinned). The browser POSTs its SDP
//     offer to the provider itself, with the secret. Unchanged since 2026.7.1.
//   - RELAYED: `{ provider, transport, offerRelay: { relayId, expiresAt }, model,
//     voice, expiresAt, voiceSessionId }` — GPT Live, the 2026.9.5 DEFAULT. The
//     offer is a path ON THE GATEWAY, which the browser cannot reach, so the bridge
//     kept the secret and hands out an opaque id; the browser sends its SDP through
//     `relayTalkOffer`. No secret ever reaches the browser on this lane.

/** The session material the browser needs to open the realtime connection.
 *  `clientSecret` is a SHORT-LIVED provider credential (direct lane only): it
 *  transits to the authenticated chat owner and must never be logged or persisted. */
export type TalkSession = {
  provider: string;
  transport: string;
  /** Direct lane: the ephemeral provider secret. Relayed lane: null — the bridge holds it. */
  clientSecret: string | null;
  /** Direct lane: the provider's https offer endpoint. Relayed lane: null. */
  offerUrl: string | null;
  /** Direct lane: headers the provider wants on the offer POST beside Authorization
   *  and Content-Type (the gateway strips its server-only ones). Empty when none. */
  offerHeaders: Record<string, string>;
  /** Relayed lane: the opaque handle the browser presents with its SDP. */
  offerRelay: { relayId: string; expiresAt: number | null } | null;
  model: string | null;
  voice: string | null;
  expiresAt: number | null;
  /** The gateway's id for the LOGICAL voice session — what a hangup closes. */
  voiceSessionId: string | null;
};

function stringRecord(v: unknown): Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

/**
 * Validate/project the bridge's /talk-session response body. Strict on the
 * load-bearing fields of WHICHEVER lane the bridge chose — direct: a non-empty
 * clientSecret + an https offerUrl (the browser posts its SDP offer there, so a
 * non-https value is refused outright); relayed: a non-empty relayId and NO secret
 * (a secret on the relayed lane means a bridge that did not keep it, which is the
 * one thing the lane exists to guarantee). Tolerant on the descriptive rest.
 * Returns null on any mismatch so the caller answers with a clean code instead of
 * relaying a half-shaped session.
 */
export function parseTalkSessionResponse(data: unknown): TalkSession | null {
  const session = (data as { session?: unknown } | null)?.session;
  if (session === null || typeof session !== "object") return null;
  const s = session as Record<string, unknown>;
  const descriptive = {
    provider: typeof s.provider === "string" ? s.provider : "",
    transport: typeof s.transport === "string" ? s.transport : "",
    model: typeof s.model === "string" ? s.model : null,
    voice: typeof s.voice === "string" ? s.voice : null,
    expiresAt: typeof s.expiresAt === "number" ? s.expiresAt : null,
    voiceSessionId:
      typeof s.voiceSessionId === "string" && s.voiceSessionId !== ""
        ? s.voiceSessionId
        : null,
  };
  const relay = s.offerRelay;
  if (relay !== undefined) {
    if (relay === null || typeof relay !== "object") return null;
    const r = relay as Record<string, unknown>;
    if (typeof r.relayId !== "string" || r.relayId === "") return null;
    if ("clientSecret" in s || "offerUrl" in s) return null;
    // A gateway-owned call is closed BY its voiceSessionId (the vendored WebRTC
    // mint schema requires it non-empty): a relayed session without one could never
    // be hung up — refused, not projected (codex P2, pass 2).
    if (descriptive.voiceSessionId === null) return null;
    return {
      ...descriptive,
      clientSecret: null,
      offerUrl: null,
      offerHeaders: {},
      offerRelay: {
        relayId: r.relayId,
        expiresAt: typeof r.expiresAt === "number" ? r.expiresAt : null,
      },
    };
  }
  if (typeof s.clientSecret !== "string" || s.clientSecret === "") return null;
  if (typeof s.offerUrl !== "string" || !s.offerUrl.startsWith("https://")) {
    return null;
  }
  return {
    ...descriptive,
    clientSecret: s.clientSecret,
    offerUrl: s.offerUrl,
    offerHeaders: stringRecord(s.offerHeaders),
    offerRelay: null,
  };
}
