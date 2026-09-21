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
// run before answering.
//
// TWO WRITERS, NOT ONE. The first version of this guard was applied in the sink and
// its comment claimed to cover "the only layer that writes it". It did not: the
// sub-agent observer persists a CHILD's tool arguments on its own path
// (providers/openclaw/sub-agent-observer.ts, `argsText`), and a child that yields
// to its parent writes exactly this note. Both writers go through here now.

/** Tool name -> argument keys that must never be persisted. Allowlisted by tool
 *  on purpose: a blanket "drop every key named `message`" would gut the
 *  `message` pseudo-tool and any legitimate tool that takes one. */
export const PRIVATE_TOOL_ARG_KEYS: ReadonlyMap<string, readonly string[]> =
  new Map([["sessions_yield", ["message"] as readonly string[]]]);

/**
 * When the same key must ALSO be stripped from the tool's RESULT.
 *
 * Not always, and the difference is upstream's. A SUCCESSFUL yield echoes the call
 * back — older gateways included `message` in it (captured in production) — so on
 * `status: "yielded"` the echo must be cleaned. But `message` is also upstream's
 * own PUBLIC explanation on the refusal paths: `{status:"deferred", message:
 * "Earlier async tool results are still being delivered…"}`
 * (sessions-yield-tool.ts:66-72). Stripping that one deleted the only sentence
 * telling the reader why the card says "deferred" — censoring a public message in
 * the name of a private one. The status decides.
 */
const OUTPUT_STRIP_WHEN: ReadonlyMap<string, (status: string | null) => boolean> =
  new Map([["sessions_yield", (status) => status === "yielded"]]);

/** Depth bound: tool payloads are gateway-shaped, not adversarial, but a cyclic
 *  or pathological value must never cost the turn. Past the bound the subtree is
 *  dropped, not passed through — fail CLOSED, this is a privacy guard. */
const MAX_DEPTH = 8;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The `status` an envelope reports: `details` first, else the first text block
 *  that parses as JSON — the two places the gateway carries it. */
export function toolResultStatus(value: unknown): string | null {
  return envelopeStatus(value);
}

/**
 * Did this `sessions_yield` actually hand off?
 *
 * ONLY `status:"yielded"` did. A gateway that REFUSES a yield answers through
 * `jsonResult` (upstream tool-results.ts), which sets no `isError` — so the refusal
 * arrives as a technically SUCCESSFUL call in phase "completed" carrying
 * `{status:"error"}`, and every reader that keyed on the phase read it as a
 * success. A `deferred` is not a hand-off either: it asks the agent to finish its
 * response first. A result stating NO status is a generation we cannot read, and the
 * phase stands — the behaviour that shipped before this rule.
 *
 * TWIN: `convex/lib/toolOutcome.ts` answers the same question on the stored part.
 * Two roots, no shared build; if one changes the other must.
 */
export function yieldHandedOff(
  phase: string | null | undefined,
  result: unknown,
): boolean {
  if (phase !== "completed") return false;
  const status = envelopeStatus(result);
  return status === null || status === "yielded";
}

function envelopeStatus(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const details = value.details;
  if (isRecord(details) && typeof details.status === "string") {
    return details.status;
  }
  // BOTH array keys. `contentItems` is the name up to gateway 2026.6.5 — inside the
  // supported range, and present in this repo's own captured fixtures, where a
  // `sessions_yield` carries its private `message` in exactly that envelope. Reading
  // only `content` made the status unreadable there, so the gate fell through and
  // the output was persisted whole: the leak this guard exists to close, on the one
  // generation that actually produces it.
  for (const key of ["content", "contentItems"] as const) {
    const blocks = value[key];
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!isRecord(block) || typeof block.text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(block.text);
        if (isRecord(parsed) && typeof parsed.status === "string") {
          return parsed.status;
        }
      } catch {
        /* not JSON — keep scanning */
      }
    }
  }
  return null;
}

/** Does this text NAME a private key, in either form?
 *
 *  The cheap guard used to look for `"key"` only. A nested JSON document — which is
 *  exactly what a stored envelope is, the call re-serialized inside `content[0].text`
 *  — escapes its quotes, so the literal characters are `\"key\"` and the guard
 *  missed every one of them. It then returned the text untouched: the fast path
 *  became the leak. Both forms are checked now. */
function namesPrivateKey(text: string, keys: readonly string[]): boolean {
  return keys.some((k) => text.includes(`"${k}"`) || text.includes(`\\"${k}\\"`));
}

/**
 * A string is rewritten ONLY when it is itself a JSON document carrying a private
 * key — the gateway's own echo. Prose is left alone.
 *
 * The first version blanked any string that merely CONTAINED `"message"`, on a
 * fail-closed argument. The argument was wrong here: the one tool this runs for has
 * a free-prose field written by the model, so an acknowledgment that happens to
 * quote the word — `Je vérifie le champ "message" du formulaire` — was silently
 * replaced by an empty string. A guard that deletes the very sentence it exists to
 * protect is not closed, it is broken.
 */
function stripInJsonText(text: string, keys: readonly string[]): string {
  if (!namesPrivateKey(text, keys)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // prose that quotes the key, not an echo of the call
  }
  if (!isRecord(parsed) && !Array.isArray(parsed)) return text;
  return JSON.stringify(stripDeep(parsed, keys, 0), null, 2);
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
    out[k] = typeof v === "string" ? stripInJsonText(v, keys) : stripDeep(v, keys, depth + 1);
  }
  return out;
}

/**
 * The value to PERSIST for `toolName`'s input or output: unchanged for every tool
 * that declares no private argument, and stripped of those keys for the ones that
 * do. `slot` decides — an OUTPUT is only cleaned when the tool's own status says
 * the call succeeded, so upstream's public refusal text survives.
 */
export function redactPrivateToolArgs(
  toolName: string,
  value: unknown,
  slot: "input" | "output" = "input",
): unknown {
  const keys = PRIVATE_TOOL_ARG_KEYS.get(toolName);
  if (keys === undefined || value === undefined) return value;
  if (slot === "output") {
    const decide = OUTPUT_STRIP_WHEN.get(toolName);
    if (decide === undefined || !decide(envelopeStatus(value))) return value;
  }
  return stripDeep(value, keys, 0);
}
