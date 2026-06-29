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
