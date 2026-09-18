// OpenClaw session-key construction. Faithful port of
// backend/app/session_keys.py: the gateway routes messages by this key, and the
// normalizer's isolation gate compares `payload.sessionKey` against it, so the
// shape must match what the gateway emits EXACTLY:
//   agent:<agentId>:atrium:chat:<canonical>:<chatId>
// e.g. agent:main:atrium:chat:u-testuser01:own-chat (see the test fixtures).

const SAFE_PART_RE = /[^A-Za-z0-9_.-]+/g;

// The OpenClaw channel segment Atrium presents in the sessionKey. MUST stay in
// lockstep with convex/lib/openclawThread.ts AND match the channel the gateway
// classifies for this connection (LIVE-VERIFIED) — a mismatch breaks the
// normalizer isolation gate (the gateway echoes its own sessionKey, the bridge
// compares). Was "webchat"; "atrium" namespaces Atrium distinctly from the Open
// WebUI pipe (which is also client.mode=cli → webchat).
const OC_CHANNEL = "atrium";

/** Sanitize one session-key segment (mirror of `safe_session_part`). */
export function safeSessionPart(value: string): string {
  const collapsed = value.trim().replace(SAFE_PART_RE, "-");
  // Strip leading/trailing -, _ and . (Python str.strip("-._")).
  const cleaned = collapsed.replace(/^[-._]+/, "").replace(/[-._]+$/, "");
  return cleaned || "unknown";
}

/**
 * Build the gateway session key from the routing identity. All three parts are
 * RESOLVED BY CONVEX and passed on the request — `agentId` and `canonical` from the
 * chat's routing (the dispatch's own authorization), `chatId` being the OpenClaw-side
 * conversation id. The bridge composes, it does not decide.
 */
export function buildSessionKey(
  chatId: string,
  agentId: string,
  canonical: string,
): string {
  return (
    `agent:${safeSessionPart(agentId)}:` +
    `${OC_CHANNEL}:chat:${safeSessionPart(canonical)}:` +
    `${safeSessionPart(chatId)}`
  );
}

/**
 * WHO owns a Talk session, decided from the ingredients Convex sends.
 *
 * The gateway reads a Talk session's owning agent OFF an agent-scoped session key
 * (upstream `resolveTalkSessionAgentId`) and, without one, falls back to
 * `config.talk.agentId` — refusing outright when several agents are configured and
 * no such fallback is set. Both outcomes are wrong for Atrium: the refusal kills
 * voice (live prod 2026-09-17), and the fallback answers as ONE arbitrary agent
 * rather than the chat's. Three outcomes, deliberately distinct:
 *
 *  - `scoped`: the key Convex named for this chat's CURRENT agent. When that agent
 *    already has a conversation, it is the key its typed turns use, so voice lands
 *    where the thread lives; for an agent nothing has run for yet, Convex sends no
 *    conversation and this keys on the chat id — its own session, never another
 *    agent's (see `resolveTalkRouting` for why that limit is deliberate).
 *  - `unscoped`: the caller named NOTHING — no owner field at all. That is a
 *    Convex older than this contract, not a malformed request, and the create goes
 *    out as it always did (still correct on a single-agent gateway). Fail-open on
 *    purpose, and the narrowest possible opening: the bridge and Convex ship from
 *    one repo but deploy separately, so this window is a version skew, and closing
 *    it would take voice away from single-agent deployments during that window. It
 *    is LOGGED so a skew is visible instead of silent.
 *  - `incomplete`: an owner was named PARTIALLY. A partial set would mint a key for
 *    a DIFFERENT session — a voice conversation attached to the wrong agent or the
 *    wrong chat — so the route refuses under its own name instead of letting the
 *    gateway arbitrate. `missing` names what was absent.
 *
 * `unscoped` means the body carried NO owner field AT ALL — that is what
 * `anyFieldPresent` is for. Any owner field that is merely INVALID (a number, a
 * blank string, `openclawChatId` alone) is a caller that meant to scope the session
 * and failed: `incomplete`, never the pre-contract case. Normalizing first and
 * counting nulls afterwards would have turned every one of those into a fail-open
 * create under the banner of backward compatibility.
 *
 * Pure: the route's success path needs a live gateway, so the decision is proven
 * here rather than at the socket.
 */
export type TalkSessionOwner =
  | { kind: "scoped"; sessionKey: string }
  | { kind: "unscoped" }
  | { kind: "incomplete"; missing: string[] };

export function talkSessionOwner(
  parts: {
    chatId: string | null;
    openclawChatId?: string | null;
    /** The caller sent `openclawChatId`, and normalization rejected its value. */
    openclawChatIdInvalid?: boolean;
    canonical: string | null;
    agentId: string | null;
  },
  /** Did the RAW body carry any owner field, whatever its value? The caller knows;
   *  by the time the values are normalized a bad one is indistinguishable from an
   *  absent one. Defaults to "whatever survived normalization" for pure callers. */
  anyFieldPresent?: boolean,
): TalkSessionOwner {
  const { chatId, canonical, agentId } = parts;
  const missing = [
    ...(chatId ? [] : ["chatId"]),
    ...(canonical ? [] : ["canonical"]),
    ...(agentId ? [] : ["agentId"]),
    // `openclawChatId` is OPTIONAL, but a caller that supplied it and got nothing
    // usable out of it named a conversation we cannot honour. Falling back to the
    // chat id would silently open a DIFFERENT session from the one asked for, which
    // is the same class of mistake as a partial owner.
    ...(parts.openclawChatIdInvalid ? ["openclawChatId"] : []),
  ];
  const named =
    anyFieldPresent ??
    Boolean(chatId || canonical || agentId || parts.openclawChatId);
  if (missing.length === 3 && !named) return { kind: "unscoped" };
  if (missing.length > 0) return { kind: "incomplete", missing };
  // The chat's CURRENT gateway conversation when Convex resolved one (a per-turn
  // routed chat carries its segment), else the Convex chat id. `??` — the SAME
  // operator the typed-turn send uses (session.ts), so a caller that ever sends
  // an empty string cannot make voice and text key differently; the route
  // normalizes blanks to null before calling, which is what makes the two agree.
  return {
    kind: "scoped",
    sessionKey: buildSessionKey(
      parts.openclawChatId ?? chatId!,
      agentId!,
      canonical!,
    ),
  };
}
