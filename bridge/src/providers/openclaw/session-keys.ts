// OpenClaw session-key construction. Faithful port of
// backend/app/session_keys.py: the gateway routes messages by this key, and the
// normalizer's isolation gate compares `payload.sessionKey` against it, so the
// shape must match what the gateway emits EXACTLY:
//   agent:<agentId>:webchat:chat:<canonical>:<chatId>
// e.g. agent:main:webchat:chat:u-testuser01:own-chat (see the test fixtures).

const SAFE_PART_RE = /[^A-Za-z0-9_.-]+/g;

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
    `webchat:chat:${safeSessionPart(canonical)}:` +
    `${safeSessionPart(chatId)}`
  );
}
