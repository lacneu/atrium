import {
  shortenSubAgentError,
  type SubAgentRow,
} from "./subAgentActivityView";

// Pure decision logic for the assistant "empty bubble" state.
//
// THE BUG IT FIXES: a main agent delegates to a sub-agent, then yields/ends its
// own turn ("J'attends le retour du sous-agent"). The parent assistant message
// finalizes as status="complete" with EMPTY text (verified on the live dev chat:
// textLenBucket "0", carrying a `sessions_spawn` + `sessions_yield` tool part).
// RunStatus renders nothing for a "complete" message, so the body is a BLANK
// bubble -- the user has no idea a sub-agent is running, failed, or hung.
//
// This module decides what to show WHERE THE ANSWER WOULD BE for such a turn,
// from data the AssistantMessage already has (status, whether there is visible
// content, the turn's tool parts) joined with the chat's sub-agent store. It is
// pure + unit tested so every branch (running / failed / generic / has-answer) is
// covered without a DOM harness.
//
// CORRELATION: the sub-agent observer does NOT populate `parentMessageId` in
// increment 1 (session.ts calls observe() without it -> the column is null), so a
// turn cannot be matched to its children by message id. Instead we read the
// `childSessionKey` the `sessions_spawn` tool output carries and match it against
// the `subAgents` rows -- a precise, per-turn join that needs no bridge change.
// If extraction fails (output elided / odd shape), the join is simply empty and
// the turn falls back to the generic state -- still never a blank bubble.

/** The minimal tool-part shape this module reads (a structural subset of
 *  toolActivityView.ToolActivityPart) so the helper stays trivially testable. */
export type EmptyStateToolPart = {
  toolName: string;
  /** The tool output. For `sessions_spawn` it mirrors the gateway frame the
   *  bridge observer parses: `{ contentItems: [{ text: "<json>" }] }`. */
  result?: unknown;
};

/** The message facts the decision needs (derived by the caller from the
 *  assistant-ui message: its lifecycle status + whether it shows any answer). */
export type EmptyStateMessage = {
  /** The Convex message lifecycle status ("complete" | "streaming" | ...). */
  status?: string;
  /** A non-empty text answer is present. */
  hasText: boolean;
  /** At least one delivered media/file part is present (also a visible answer). */
  hasMedia: boolean;
};

/** The discriminated render decision. `none` = render normally (there is an
 *  answer, or the turn is not a settled-empty one). */
export type AssistantEmptyState =
  | { kind: "none" }
  | { kind: "waiting"; taskName?: string }
  | { kind: "failed"; taskName?: string; reason: string }
  | { kind: "generic" };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pull the childSessionKey(s) this turn spawned out of its `sessions_spawn` tool
 * part(s). Mirrors the bridge observer's `extractChildSessionKey`: the output is
 * `{ contentItems: [{ text: "<json with childSessionKey>" }] }`. Fully defensive
 * -- a missing / elided (string note) / oddly-shaped output yields no key and
 * NEVER throws.
 */
export function extractSpawnedChildKeys(
  toolParts: readonly EmptyStateToolPart[],
): string[] {
  const keys: string[] = [];
  for (const part of toolParts) {
    if (part.toolName !== "sessions_spawn") continue;
    const result = part.result;
    if (!isObject(result)) continue; // elided output is a string note -> skip
    const items = result.contentItems;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const text = isObject(item) ? item.text : undefined;
      if (typeof text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(text);
        const key = isObject(parsed) ? parsed.childSessionKey : undefined;
        if (typeof key === "string" && key !== "") keys.push(key);
      } catch {
        // Non-JSON content item -- skip.
      }
    }
  }
  return keys;
}

/** Trim a task name to a clean label, or undefined when blank. */
function cleanTaskName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Decide the empty-bubble state for an assistant turn.
 *
 * Rules (in order):
 *  - There IS a visible answer (text or a delivered file) -> none (render normally).
 *  - The turn is NOT settled-complete (streaming / error / aborted / placeholder)
 *    -> none: the thinking indicator / RunStatus error card already cover it.
 *  - Settled-complete with NO answer (the blank-bubble bug). Correlate the turn's
 *    spawned children to the chat's sub-agent rows by childSessionKey:
 *      * a correlated child still RUNNING  -> waiting (with its task name if known)
 *      * a correlated child FAILED/aborted -> failed (+ a SHORT, clean reason)
 *      * no correlated child               -> generic (the agent acted but returned
 *        nothing) -- so a blank complete bubble is NEVER shown.
 */
export function assistantEmptyState(
  message: EmptyStateMessage,
  toolParts: readonly EmptyStateToolPart[],
  subAgents: readonly SubAgentRow[],
): AssistantEmptyState {
  if (message.hasText || message.hasMedia) return { kind: "none" };
  if (message.status !== "complete") return { kind: "none" };

  const keys = new Set(extractSpawnedChildKeys(toolParts));
  const mine =
    keys.size > 0 ? subAgents.filter((s) => keys.has(s.childSessionKey)) : [];

  // A still-running child takes precedence: the parent yielded and the gateway
  // resumes it when the child returns, so "waiting" is the truthful state even if
  // a sibling already failed.
  const running = mine.find((s) => s.status === "running");
  if (running) return { kind: "waiting", taskName: cleanTaskName(running.taskName) };

  const failed = mine.find(
    (s) => s.status === "error" || s.status === "aborted",
  );
  if (failed) {
    return {
      kind: "failed",
      taskName: cleanTaskName(failed.taskName),
      reason: shortenSubAgentError(failed.errorMessage),
    };
  }

  return { kind: "generic" };
}
