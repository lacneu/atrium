// THE SEND IDENTITY (transcript redesign, phase 1).
//
// One string names a send end to end: it is the `idempotencyKey` of the gateway's
// `chat.send`, the gateway turns it into the run id of that send (upstream
// `src/gateway/server-methods/chat-send-session.ts`: `clientRunId = p.idempotencyKey`)
// and into the user row it persists (`__openclaw.idempotencyKey = "<runId>:user"`,
// `chat-user-turn-recorder.ts`). Atrium reconciles the transcript on it — never on
// position, content or time (Control UI: `history-message-identity.ts`, "Submission
// proof uses the recorded key").
//
// WHY THE SESSION KEY IS PART OF IT. The gateway's send dedupe is PROCESS-GLOBAL, keyed
// `chat:${clientRunId}` (`chat-send-pre-admission.ts` `readChatSendDedupeResponse`,
// `resolveChatSendRequestConflict`), and the request identity it compares
// (`chat-send-request.ts` `requestIdentity` = sha256 of message + mentions) does not
// include the session. The same key sent to ANOTHER session of the same gateway would
// therefore be answered from the first one and never run. So the identity stays exactly
// the bridge's historical derivation — `webchat-` + sha256("<sessionKey>|<dispatch key>")
// (bridge/src/providers/openclaw/openclaw-client.ts `idempotencyKey`) — computed HERE so
// Convex knows it before the gateway answers, stable across every re-POST of the same
// outbox row to the same session, and different on another session.
//
// The bridge recomputes it from what it actually sends and reports the key it used; a
// mismatch is logged there and corrected here (bridge.markOutbox), never guessed.

/** The shape of an identity minted by Atrium (`webchat-` + 64 lowercase hex). A
 *  transcript user row whose send key has this shape and no outbox row is a send Atrium
 *  cannot account for; any other key is input from another client (Control UI, a
 *  channel, the gateway itself). */
export const ATRIUM_SEND_ID_RE = /^webchat-[0-9a-f]{64}$/;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `webchat-` + sha256("<sessionKey>|<dispatchKey>") — byte-identical to the bridge's
 *  `idempotencyKey(sessionKey, clientMessageId)` for a non-empty dispatch key. */
export async function sendIdentityFor(
  sessionKey: string,
  dispatchKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${sessionKey}|${dispatchKey}`),
  );
  return `webchat-${hex(digest)}`;
}

/** Most earlier send identities a user message keeps (`messages.priorSendIds`); older ones
 *  are still reached through its outbox rows by the deletion's follow-up. */
export const MAX_PRIOR_SEND_IDS = 32;

/** The patch that moves a user message to a new send identity, keeping the one it
 *  replaces (a regenerate or a corrected key: the old send may have run at the gateway)
 *  — ONLY in a conversation that stored transcript text (`keepPrior`, the caller's
 *  `transcriptStoredText` on the chat it already holds): an earlier send of any other
 *  conversation never stored anything to tombstone, and its patch stays what it was
 *  before phase 4 (codex phase 4 pass 14). */
export function sendIdChange(
  message: { sendId?: string; priorSendIds?: string[] },
  next: string,
  keepPrior: boolean,
): { sendId: string; priorSendIds?: string[] } {
  if (!keepPrior || message.sendId === undefined || message.sendId === next) return { sendId: next };
  const prior = [...(message.priorSendIds ?? []).filter((s) => s !== message.sendId && s !== next), message.sendId];
  return { sendId: next, priorSendIds: prior.slice(-MAX_PRIOR_SEND_IDS) };
}

/** Every send identity a user message carried: its current one and the earlier ones. */
export function sendIdsOf(message: { sendId?: string; priorSendIds?: string[] }): string[] {
  return [...new Set([...(message.priorSendIds ?? []), ...(message.sendId !== undefined ? [message.sendId] : [])])];
}
