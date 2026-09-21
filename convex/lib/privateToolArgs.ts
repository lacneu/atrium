// THE LEAK THAT IS ALREADY IN THE DATABASE.
//
// The bridge stops writing `sessions_yield.message` — the note an agent leaves for
// its own resumed turn, which upstream declares private to it. That protects new
// turns and nothing else: every conversation that ran before the repair still holds
// the value, and the read projections handed it straight back to the chat, where
// `ToolCard` renders it. Reopening an old conversation showed it again.
//
// Closed on READ, here, so history is covered without a migration and so a row that
// somehow slips past the writers is still not displayable. The stored value is NOT
// removed by this — see the note in the release: a backfill remains owed, and this
// makes the leak unreachable in the meantime.
//
// TWIN: `bridge/src/core/private-tool-args.ts` applies the same rule on the write
// side. Two roots, no shared build; if one changes the other must.

import { toolResultStatus } from "./toolOutcome";

/** Tool name -> argument keys that must never reach a reader. Allowlisted by tool:
 *  a blanket "drop every key named `message`" would gut the `message` pseudo-tool,
 *  which IS the visible reply. */
const PRIVATE_TOOL_ARG_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["sessions_yield", ["message"] as readonly string[]],
]);

const MAX_DEPTH = 8;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

/** Rewrite a string ONLY when it is itself a JSON document carrying a private key —
 *  the gateway's own echo of the call. Prose that merely quotes the word is left
 *  alone: the one tool this runs for has a free-prose field written by the model. */
function stripInJsonText(text: string, keys: readonly string[]): string {
  if (!namesPrivateKey(text, keys)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(parsed) && !Array.isArray(parsed)) return text;
  return JSON.stringify(strip(parsed, keys, 0), null, 2);
}

function strip(value: unknown, keys: readonly string[], depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((v) => strip(v, keys, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(k)) continue;
    out[k] = typeof v === "string" ? stripInJsonText(v, keys) : strip(v, keys, depth + 1);
  }
  return out;
}

/**
 * The value a READER may see for `toolName`'s input or output.
 *
 * An OUTPUT is only cleaned when the tool's own status says the call succeeded:
 * `message` is also upstream's PUBLIC explanation on a refusal
 * (`{status:"deferred", message:"Earlier async tool results…"}`), and deleting that
 * would censor the only sentence telling the reader why the card says "deferred".
 */
export function readableToolValue(
  toolName: string,
  value: unknown,
  slot: "input" | "output",
): unknown {
  const keys = PRIVATE_TOOL_ARG_KEYS.get(toolName);
  if (keys === undefined || value === undefined) return value;
  if (slot === "output" && toolResultStatus(value) !== "yielded") return value;
  return strip(value, keys, 0);
}

/** The same rule for a flat DETAIL STRING (the sub-agent panel stores its tool
 *  args/result as text, not as a value): the whole string is a JSON echo there. */
export function readableToolText(
  toolName: string,
  text: string | undefined,
  slot: "input" | "output",
): string | undefined {
  const keys = PRIVATE_TOOL_ARG_KEYS.get(toolName);
  if (keys === undefined || text === undefined) return text;
  // SAME rule as the structured path, which this one contradicted: an OUTPUT is
  // only cleaned when the call SUCCEEDED. `message` is upstream's own public
  // explanation on a refusal (`{status:"deferred", message:"Earlier async tool
  // results…"}`), and stripping it from the sub-agent panel deleted the one
  // sentence saying why the card reads "deferred" — while the value path kept it.
  if (!namesPrivateKey(text, keys)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // TRUNCATED, therefore UNPARSEABLE — and it names a private key.
    //
    // This path is not prose. The sub-agent observer JSON-serializes the call and
    // then CUTS it at 2 000 / 4 000 characters, so a historic detail routinely
    // fails to parse while still carrying the whole private note. The nested-string
    // rule fails OPEN because there a string is the model's own prose and blanking
    // it would delete the sentence we protect; here the string IS the echo, and
    // failing open hands the note to the panel and to the archive export.
    //
    // Dropped rather than cut: there is no honest place to cut a truncated JSON
    // document, and this only fires for an allowlisted tool on a row written before
    // the write-side guard existed.
    return undefined;
  }
  // An OUTPUT is only cleaned when the call SUCCEEDED: `message` is upstream's own
  // public explanation on a refusal (`{status:"deferred", message:"Earlier async
  // tool results…"}`), and stripping it deleted the one sentence saying why the
  // card reads "deferred" — while the value path kept it.
  // Read with the SAME reader as the structured path, not from the root key. A
  // historic detail is the whole envelope — `{contentItems:[{text:"{…status:
  // yielded, message:…}"}]}` — so the status sits nested and a root-level check
  // found none, called the call a refusal, and returned the note untouched. The
  // reader that already knows all three places is `toolResultStatus`; not using it
  // here was the gap.
  if (slot === "output" && toolResultStatus(parsed) !== "yielded") return text;
  return stripInJsonText(text, keys);
}
