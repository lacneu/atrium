// OpenClaw correlation handle for trace enrichment.
//
// OpenClaw tags every trace it emits (e.g. the plugins' Opik spans) with a
// `thread_id` that IS the gateway session key — the SAME string the bridge builds
// to route a turn. So Atrium can RECONSTRUCT it deterministically from a chat's
// routing identity and find OpenClaw's own traces for that chat, instead of
// parsing a fragile format.
//
// CONTRACT (must match the gateway EXACTLY — it routes by this key):
//   agent:<agentId>:atrium:chat:<canonical>:<chatId>
// This mirrors `bridge/src/providers/openclaw/session-keys.ts` (itself a port of
// the gateway's backend/app/session_keys.py). The two MUST stay byte-identical.
//
// VERSION-AWARENESS: this is a single stable contract today. When preparing
// compatibility for a NEW OpenClaw/Hermes version, RE-VERIFY the format against
// that gateway's source / docs / an empirical trace (a real `thread_id` from its
// Opik project) before trusting reconstruction — and branch here if it changed.
// The fallback when reconstruction yields nothing is a plugin-emitted correlationId
// tag (see enrich.ts) — kept as the secondary handle so a format drift degrades to
// "no OpenClaw spans", never to wrong data.

const SAFE_PART_RE = /[^A-Za-z0-9_.-]+/g;

// The OpenClaw channel segment. MUST stay byte-identical with the bridge's
// session-keys.ts OC_CHANNEL — the gateway round-trips it verbatim (LIVE-VERIFIED
// on 2026.6.10: a sessionKey sent with "atrium" is echoed with "atrium"). "atrium"
// namespaces Atrium distinctly from the Open WebUI pipe (also client.mode=cli).
const OC_CHANNEL = "atrium";

/** Sanitize one session-key segment — mirror of the bridge's `safeSessionPart`
 *  (and the gateway's `safe_session_part`). Keep in lockstep. */
export function safeSessionPart(value: string): string {
  const collapsed = value.trim().replace(SAFE_PART_RE, "-");
  const cleaned = collapsed.replace(/^[-._]+/, "").replace(/[-._]+$/, "");
  return cleaned || "unknown";
}

/**
 * Reconstruct the OpenClaw `thread_id` (== gateway session key) for a chat. All
 * three inputs are known to Convex: the chat's resolved agent, the owner's
 * canonical, and the OpenClaw-side chat id. Returns null if any is missing (then
 * the thread-search is skipped — we never query with a partial/guessed key).
 */
export function buildOpenClawThreadId(opts: {
  agentId: string | null | undefined;
  canonical: string | null | undefined;
  chatId: string | null | undefined;
}): string | null {
  const { agentId, canonical, chatId } = opts;
  if (!agentId || !canonical || !chatId) return null;
  return (
    `agent:${safeSessionPart(agentId)}:` +
    `${OC_CHANNEL}:chat:${safeSessionPart(canonical)}:` +
    `${safeSessionPart(chatId)}`
  );
}
