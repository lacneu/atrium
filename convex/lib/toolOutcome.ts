// WHAT A TOOL RESULT SAYS ABOUT ITSELF — read from the payload, never from the card.
//
// A gateway tool that REFUSES still answers through `jsonResult`
// (openclaw src/agents/tools/tool-results.ts), which sets no `isError`. So the
// refusal arrives as a technically SUCCESSFUL call whose payload carries
// `{status:"error"}` — and every reader that keyed on the card's phase read it as a
// success. `sessions_yield` alone has five such refusals (bad `waitFor`, no session
// context, unsupported context, undelivered async results, no pending child
// completion), plus a `{status:"deferred"}`.
//
// Twice now a repair in this area encoded a PROXY for that fact — the lifecycle
// phase — instead of the fact. One reader, here, so the two sides of the boundary
// cannot drift: `convex/stream.ts` decides whether a delivery is exempt from the
// empty verdict, and `src/chat/assistantEmptyState.ts` decides what the bubble says.
//
// The payload carries its status in up to three places, and which one depends on the
// gateway generation: `details` (destructured, 2026.6.10+), and a JSON echo inside
// `content` (2026.6.10+) or `contentItems` (up to 2026.6.5 — still inside the
// supported range, and present in the repo's own captured fixtures).

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The `status` a tool result reports, or null when it states none. */
export function toolResultStatus(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const details = result.details;
  if (isRecord(details) && typeof details.status === "string") {
    return details.status;
  }
  // The payload ITSELF, unwrapped. A stored sub-agent detail is sometimes the
  // serialized payload rather than the envelope around it, and there the status
  // sits at the root — a reader that only knew the envelope found none and called
  // a successful call a refusal. Placed after `details` so the canonical copy
  // still wins when both are present.
  if (typeof result.status === "string") return result.status;
  for (const key of ["content", "contentItems"] as const) {
    const blocks = result[key];
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

/**
 * Did this `sessions_yield` actually hand off?
 *
 * ONLY `status:"yielded"` did. A refusal (`error`) handed nothing to anyone, and a
 * `deferred` explicitly asks the agent to finish its response first — neither may
 * exempt a delivery from the empty verdict, nor tell a reader that work is in
 * flight. A result that states NO status is a gateway generation we cannot read;
 * the phase then stands, which is the behaviour that shipped before this rule.
 */
export function yieldHandedOff(
  phase: string | undefined,
  result: unknown,
): boolean {
  if (phase !== "completed") return false;
  const status = toolResultStatus(result);
  return status === null || status === "yielded";
}
