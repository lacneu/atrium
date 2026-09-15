// History recovery for gateway-delivered replies (the webchat "sink").
//
// On 2026.6.5 the agent can deliver its real answer through the gateway
// message-tool: the gateway executes it itself ({deliveryStatus:"sent",
// channel:"webchat", target:"current-run", sourceReplySink:"internal-ui"})
// and the run only streams a private ack ("Envoyé dans le webchat."). The
// delivered text exists NOWHERE in the run frames — only in the session
// transcript, which `sessions.get {key}` returns. This module extracts those
// deliveries from the transcript payload; the session loop feeds the result
// back into the normalizer (recoverVisibleText) before the ack-grace expires.

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: Json): v is string {
  return typeof v === "string";
}

// Channels/targets the gateway uses for "this very conversation". Anything
// else (telegram, whatsapp, an explicit peer id…) is a REAL external delivery
// and must never be folded back into the webchat answer.
const CURRENT_CHANNELS = new Set(["atrium", "webchat", "chat", "current"]);
const CURRENT_TARGETS = new Set(["current-run", "current", "current-session"]);

/** Parse one message-tool RESULT json (string) → delivered text, or null. */
function deliveredTextFromResult(raw: string): string | null {
  let parsed: Json;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (parsed.deliveryStatus !== "sent") return null;
  const channel = parsed.channel;
  if (isString(channel) && !CURRENT_CHANNELS.has(channel.toLowerCase())) {
    return null;
  }
  const target = parsed.target;
  if (isString(target) && !CURRENT_TARGETS.has(target.toLowerCase())) {
    return null;
  }
  const reply = parsed.sourceReply;
  if (isObject(reply) && isString(reply.text) && reply.text.trim()) {
    return reply.text;
  }
  return null;
}

/** Every string carried by a transcript entry's `content` (string or parts). */
function contentStrings(content: Json): string[] {
  if (isString(content)) return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (isString(part)) {
      out.push(part);
    } else if (isObject(part)) {
      if (isString(part.text)) out.push(part.text);
      else if (isString(part.content)) out.push(part.content);
    }
  }
  return out;
}

/**
 * Extract the text(s) the CURRENT turn delivered via the gateway message-tool
 * from a `sessions.get` payload. Scans backwards to the latest `user` entry
 * (the turn boundary), collects message-tool results addressed to the current
 * conversation, and returns them in chronological order joined by blank lines.
 * Empty string when nothing recoverable is found (caller degrades to the ack).
 */
export function extractMessageToolReplies(payload: Json): string {
  const messages = isObject(payload) && Array.isArray(payload.messages)
    ? payload.messages
    : [];
  const collected: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (!isObject(entry)) continue;
    const role = entry.role;
    if (role === "user") break; // current-turn boundary
    if (role !== "toolResult") continue;
    const toolName = entry.toolName ?? entry.name;
    if (toolName !== "message") continue;
    for (const s of contentStrings(entry.content)) {
      const text = deliveredTextFromResult(s);
      if (text) {
        collected.push(text);
        break; // one delivery per toolResult entry
      }
    }
  }
  collected.reverse();
  return collected.join("\n\n");
}

/**
 * Extract the assistant reply of the CURRENT turn from a `sessions.get`
 * payload — the transcript-recovery half of gateway restart-recovery. When the
 * gateway is SIGTERMed mid-turn it marks the orphaned main session for restart
 * recovery, resumes the run after boot, and the finished answer lands ONLY in
 * the session transcript (the bridge socket died with the old gateway — live
 * CSV evidence 2026-07-04: a 429s resumed run delivered to the Control UI
 * while Atrium showed nothing). Scans backwards to the latest `user` entry
 * (the turn boundary) collecting `assistant` texts; empty string while the
 * resumed run hasn't answered yet (the caller keeps polling).
 */
export function extractLatestAssistantReply(payload: Json): string {
  const messages = isObject(payload) && Array.isArray(payload.messages)
    ? payload.messages
    : [];
  const collected: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (!isObject(entry)) continue;
    const role = entry.role;
    if (role === "user") break; // current-turn boundary
    if (role !== "assistant") continue;
    // A FAILED attempt, never a reply. Since 2026.9.3 (read at v2026.9.4; absent from the
    // v2026.9.1 and v2026.9.2 sources), when a run fails the gateway appends that attempt's
    // partial text to the transcript as an assistant entry with `stopReason: "error"`
    // (upstream src/agents/assistant-error-transcript.ts:26-72 records it, :105-113
    // persists it under `<runId>:terminal-error`), and sessions.get returns the stored
    // message with its `content` and `stopReason` intact (session-transcript-readers.ts:158,167
    // → projectTranscriptEntryMessage, which only attaches `__openclaw` metadata). Read as a
    // reply, a resumed run that failed would be delivered as a COMPLETE answer made of its
    // truncated attempt. Skipped, that entry is never taken as the reply: another valid
    // reply or message-tool delivery of the turn still comes back, and with none the
    // recovery keeps polling and settles with its honest cause.
    if (entry.stopReason === "error") continue;
    const text = contentStrings(entry.content).join("").trim();
    if (text) collected.push(text);
  }
  collected.reverse();
  return collected.join("\n\n");
}

/** Text of the LAST `user` entry in a `sessions.get` payload — the turn-boundary
 *  anchor the orphan recovery validates against (a STALE transcript served
 *  mid-reboot may predate the current turn; matching the anchor prevents
 *  finalizing the PREVIOUS turn's reply as the current one). */
export function lastUserEntryText(payload: Json): string {
  const messages = isObject(payload) && Array.isArray(payload.messages)
    ? payload.messages
    : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (!isObject(entry) || entry.role !== "user") continue;
    return contentStrings(entry.content).join("");
  }
  return "";
}

/** Number of transcript entries in a `sessions.get` payload (0 when malformed).
 *  The orphan recovery's STRUCTURAL baseline for anchor-less turns: a resumed
 *  run always GROWS the transcript, a stale one never does. */
export function transcriptEntryCount(payload: Json): number {
  return isObject(payload) && Array.isArray(payload.messages)
    ? payload.messages.length
    : 0;
}
