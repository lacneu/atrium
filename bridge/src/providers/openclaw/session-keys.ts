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
 * Build the gateway session key from the routing identity. `agentId` and
 * `canonical` come from the (single-instance) bridge config; `chatId` is the
 * OpenClaw-side chat id passed by Convex on the send.
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
