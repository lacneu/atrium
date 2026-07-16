// Realtime voice ("talk") — pure helpers for the gateway-minted ephemeral
// browser session (gateway talk.client.create, relayed by the bridge
// /talk-session route). Shape probed LIVE on OpenClaw 2026.7.1 (2026-07-16):
//   { provider, transport, clientSecret: "ek_…", offerUrl, model, voice,
//     expiresAt }
// PURE module (no Convex imports) so the projection is unit-testable.

/** The session material the browser needs to open the realtime connection.
 *  `clientSecret` is a SHORT-LIVED provider credential: it transits to the
 *  authenticated chat owner and must never be logged or persisted. */
export type TalkSession = {
  provider: string;
  transport: string;
  clientSecret: string;
  offerUrl: string;
  model: string | null;
  voice: string | null;
  expiresAt: number | null;
};

/**
 * Validate/project the bridge's /talk-session response body. Strict on the
 * two load-bearing fields (a non-empty clientSecret + an https offerUrl — the
 * browser posts its SDP offer there, so a non-https value is refused outright);
 * tolerant on the descriptive rest. Returns null on any mismatch so the caller
 * answers with a clean code instead of relaying a half-shaped session.
 */
export function parseTalkSessionResponse(data: unknown): TalkSession | null {
  const session = (data as { session?: unknown } | null)?.session;
  if (session === null || typeof session !== "object") return null;
  const s = session as Record<string, unknown>;
  if (typeof s.clientSecret !== "string" || s.clientSecret === "") return null;
  if (typeof s.offerUrl !== "string" || !s.offerUrl.startsWith("https://")) {
    return null;
  }
  return {
    provider: typeof s.provider === "string" ? s.provider : "",
    transport: typeof s.transport === "string" ? s.transport : "",
    clientSecret: s.clientSecret,
    offerUrl: s.offerUrl,
    model: typeof s.model === "string" ? s.model : null,
    voice: typeof s.voice === "string" ? s.voice : null,
    expiresAt: typeof s.expiresAt === "number" ? s.expiresAt : null,
  };
}
