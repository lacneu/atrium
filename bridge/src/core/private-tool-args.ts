// THE HAND-OFF NOTE THE USER WAS NEVER MEANT TO READ.
//
// `sessions_yield` takes two strings with OPPOSITE contracts, stated by upstream's
// own schema (src/agents/tools/sessions-yield-tool.ts:25-31):
//
//   message        — "Private context for the resumed turn; not sent to the user."
//   acknowledgment — "Optional waiting reply for an otherwise-silent interactive
//                     parent turn."
//
// Atrium persisted the call's arguments WHOLE and the chat renders them: the tool
// card shows `input` in a <pre>, `toolPreview` can lift the first argument into the
// collapsed header, and `formatToolResult` prints the output. So the parent's
// private instructions to its future self were on screen — including, in a
// production conversation, a note naming the exact checks the agent intended to
// run before answering. Nothing was exploited; it was simply shown, and the code
// that captured the acknowledgment carried a comment asserting the opposite
// invariant ("never from `message`, which upstream declares private").
//
// Closed HERE, at the sink, rather than in the renderer: a value that is not
// stored cannot be displayed by the next reader, and there have now been three
// readers (args, argsText, result). The acknowledgment is untouched — showing it
// is what it is for.
//
// The gateway also ECHOES the call's JSON back inside the tool result's text
// content, so redacting only the structured copy would move the leak rather than
// close it. Both are handled.

/** Tool name -> argument keys that must never be persisted. Allowlisted by tool
 *  on purpose: a blanket "drop every key named `message`" would gut the
 *  `message` pseudo-tool and any legitimate tool that takes one. */
export const PRIVATE_TOOL_ARG_KEYS: ReadonlyMap<string, readonly string[]> =
  new Map([["sessions_yield", ["message"] as readonly string[]]]);

/** Depth bound: tool payloads are gateway-shaped, not adversarial, but a cyclic
 *  or pathological value must never cost the turn. Past the bound the subtree is
 *  dropped, not passed through — fail CLOSED, this is a privacy guard. */
const MAX_DEPTH = 8;

function stripInJsonText(text: string, keys: readonly string[]): string {
  if (!keys.some((k) => text.includes(`"${k}"`))) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(stripDeep(parsed, keys, 0), null, 2);
  } catch {
    // It names a private key and is not JSON: refuse it whole rather than guess
    // where the value ends. Only reachable for allowlisted tools.
    return "";
  }
}

function stripDeep(value: unknown, keys: readonly string[], depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.map((v) => stripDeep(v, keys, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(k)) continue;
    // The gateway's `content: [{type:"text", text:"<json echo>"}]` envelope.
    out[k] = typeof v === "string" ? stripInJsonText(v, keys) : stripDeep(v, keys, depth + 1);
  }
  return out;
}

/**
 * The value to PERSIST for `toolName`'s input/output: unchanged for every tool
 * that declares no private argument, and stripped of those keys (structured copy
 * AND the gateway's JSON echo) for the ones that do.
 */
export function redactPrivateToolArgs(
  toolName: string,
  value: unknown,
): unknown {
  const keys = PRIVATE_TOOL_ARG_KEYS.get(toolName);
  if (keys === undefined || value === undefined) return value;
  return stripDeep(value, keys, 0);
}
