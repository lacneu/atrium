// Realtime voice ("talk") — the SDP offer relay for GATEWAY-OWNED browser sessions.
//
// Two mint shapes exist on OpenClaw >= 2026.9.5, decided by the gateway per mint:
//
//   - `offerUrl: "https://api.openai.com/v1/realtime/calls"` — the classic realtime
//     model (`talk.realtime.model` pinned). The browser POSTs its SDP offer to the
//     provider DIRECTLY with the ephemeral secret, exactly as before. Nothing here
//     is involved.
//   - `offerUrl: "/plugins/openai/realtime/calls"` — GPT Live, the 2026.9.5 DEFAULT
//     when no model is configured (`resolveOpenAIRealtimeVoiceConfig`, new in that
//     tag). The path is RELATIVE TO THE GATEWAY: the gateway serves it itself
//     (`api.registerHttpRoute`, auth "plugin", exact match, query ignored) and
//     brokers the call. In Atrium's deployment the browser cannot reach the gateway
//     — only the bridge can — so the offer has to be RELAYED. Verified at the tag:
//     `extensions/openai/index.ts:75-80`, `realtime-quicksilver-session.ts:300-390`,
//     `src/gateway/server/plugins-http/route-auth.ts:46-49`.
//
// The relay keeps the ephemeral secret ON THE BRIDGE: the browser receives an
// opaque `relayId` and hands back only its SDP. The secret was minted here and is
// spent here; it never crosses to a browser, and Convex only ever sees the id.
//
// Limits are the gateway's own, copied by value with their upstream name so a
// drift is a diff and not a guess:
//   - one offer per token, 60 s to present it   (OPENAI_QUICKSILVER_PENDING_TTL_MS)
//   - SDP body <= 256 KiB                        (OPENAI_QUICKSILVER_MAX_SDP_BYTES)
//   - upstream answer within 30 s                (OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS)
//   - a live call lasts at most 30 min            (OPENAI_QUICKSILVER_SESSION_TTL_MS)
// PURE module: no server, no registry, no globals. The server owns one registry
// instance; tests own their clock.

import { randomBytes } from "node:crypto";

export const TALK_RELAY_TTL_MS = 60_000;
export const TALK_OFFER_MAX_SDP_BYTES = 256 * 1024;
export const TALK_OFFER_TIMEOUT_MS = 30_000;
export const TALK_CALL_HOLD_MS = 30 * 60_000;
/**
 * How long the minting socket is held BEFORE the offer arrives: the gateway's own
 * pending-offer window plus a margin. The 30-minute call TTL is armed only when the
 * offer is spent — the gateway arms its own at call allocation, not at mint
 * (codex P2, 2026-09-19); a mint nobody follows up must not pin the socket 30 min.
 *
 * DELIBERATELY SHORTER THAN `TALK_DIRECT_HOLD_MS`, and not an oversight: the two
 * guard different hazards. This one covers the gap between a mint and its offer —
 * bounded by the relay handle's own 60-second life, so double that is generous. A
 * send arriving after it has lapsed can only cut a call whose offer never came,
 * i.e. one the browser has already lost (its handle expired). The direct lane has no
 * offer step at all, so nothing bounds its gap but the send's own deadline, which is
 * why that one is sized against `SEND_POST_TIMEOUT_MS` instead.
 */
export const TALK_PENDING_HOLD_MS = 2 * 60_000;
/**
 * How long a DIRECT mint holds the socket.
 *
 * Sized against ONE number: how long a `/send` may legitimately still be in flight.
 * Convex allows a send POST four minutes (`SEND_POST_TIMEOUT_MS`), and that clock
 * starts before the request leaves — so a dispatch which read "no call" just before
 * the mint can still arrive minutes later. The hold exists precisely to refuse that
 * arrival, so anything shorter than the send's own deadline reopens the hand-off it
 * was written to prevent (codex P1, pass 14).
 *
 * NOT the call window: the direct lane's media is the browser's, Convex's freeze owns
 * the steady state, and a hold nobody can release — a mint whose response was lost
 * writes no row — should cost minutes, not half an hour (codex P2, pass 11). A
 * consult extends it up to the call's own ceiling when one really is live.
 */
export const TALK_DIRECT_HOLD_MS = 5 * 60_000;

/** A gateway-relative offer path: absolute path, not a scheme-relative URL. */
export function isGatewayRelativeOffer(offerUrl: unknown): offerUrl is string {
  return (
    typeof offerUrl === "string" &&
    offerUrl.startsWith("/") &&
    !offerUrl.startsWith("//")
  );
}

export interface TalkRelayEntry {
  relayId: string;
  instanceName: string;
  chatId: string;
  sessionKey: string;
  voiceSessionId: string | null;
  /** The ephemeral provider secret. Never logged, never sent to Convex or a browser. */
  clientSecret: string;
  /** The gateway-relative offer path, verbatim from the mint. */
  offerPath: string;
  /** The gateway's HTTP origin (no trailing slash) the path is resolved against. */
  gatewayHttpBase: string;
  expiresAtMs: number;
}

/** Single-use, time-bounded handles for pending offers. One instance per bridge. */
export class TalkRelayRegistry {
  private readonly entries = new Map<string, TalkRelayEntry>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Register a minted secret; returns the opaque id the browser will hold. */
  issue(
    entry: Omit<TalkRelayEntry, "relayId" | "expiresAtMs"> & { expiresAtMs?: number },
  ): TalkRelayEntry {
    this.prune();
    const relayId = randomBytes(24).toString("base64url");
    const issued: TalkRelayEntry = {
      ...entry,
      relayId,
      expiresAtMs: entry.expiresAtMs ?? this.now() + TALK_RELAY_TTL_MS,
    };
    this.entries.set(relayId, issued);
    return issued;
  }

  /**
   * Spend a handle. Unknown, expired, already spent, issued for ANOTHER instance or
   * for ANOTHER chat all read the same — `null` — so a caller cannot probe which of
   * these it hit. The gateway's own token is single-use for the same reason ("a
   * captured browser request cannot join twice"); a relay that could be replayed
   * would undo that. The CHAT is part of the key because Convex proves the caller
   * owns a session on that chat, not on every chat of the instance: a handle that
   * leaked from one person's browser must not be spendable by another person who
   * merely shares the gateway (codex P1, 2026-09-19).
   */
  take(
    relayId: string,
    instanceName: string,
    chatId: string,
    sessionKey: string,
  ): TalkRelayEntry | null {
    this.prune();
    const entry = this.entries.get(relayId);
    // The SESSION KEY, not just the chat: Convex re-authorizes the agent of the row
    // the caller presents, and a handle minted for a since-revoked agent on the same
    // chat must not be spendable through another row of that chat (codex P1, pass 2).
    if (
      !entry ||
      entry.instanceName !== instanceName ||
      entry.chatId !== chatId ||
      entry.sessionKey !== sessionKey
    ) {
      return null;
    }
    this.entries.delete(relayId);
    return entry;
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(id);
    }
  }
}

export type TalkOfferRelayResult =
  | { ok: true; status: number; answerSdp: string }
  | { ok: false; code: string; status?: number };

/**
 * POST the browser's SDP offer to the gateway on the browser's behalf, with the
 * secret the gateway minted. The status codes mirror `exchangeSdp` in the browser
 * so the UI keeps ONE vocabulary whichever lane the call took.
 *
 * No `?model=` on the relayed URL: the gateway's offer handler binds the model to
 * the token at mint time and never reads the query (`realtime-quicksilver-session.ts`
 * reads the model off the pending offer it stored), and its route matcher compares
 * the pathname only.
 */
export async function relayTalkOffer(
  entry: Pick<TalkRelayEntry, "clientSecret" | "offerPath" | "gatewayHttpBase">,
  offerSdp: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TalkOfferRelayResult> {
  if (Buffer.byteLength(offerSdp, "utf8") > TALK_OFFER_MAX_SDP_BYTES) {
    return { ok: false, code: "sdp_too_large" };
  }
  if (offerSdp.trim() === "") return { ok: false, code: "sdp_empty_offer" };
  try {
    const res = await fetchImpl(`${entry.gatewayHttpBase}${entry.offerPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${entry.clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offerSdp,
      signal: AbortSignal.timeout(TALK_OFFER_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 401 = the single-use token expired or was already spent — the browser can
      // mint again cleanly. Everything else keeps its status in the code.
      return {
        ok: false,
        code: res.status === 401 ? "talk_secret_expired" : `sdp_${res.status}`,
        status: res.status,
      };
    }
    const answerSdp = await res.text();
    if (answerSdp.trim() === "") return { ok: false, code: "sdp_empty", status: res.status };
    return { ok: true, status: res.status, answerSdp };
  } catch {
    return { ok: false, code: "sdp_unreachable" };
  }
}
