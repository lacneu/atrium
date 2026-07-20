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
// CORRELATION: the bridge tags every child with `parentMessageId` (the spawning
// assistant message — session.ts passes runManager.currentMessageId to observe()),
// so the PRIMARY join is message-precise: `s.parentMessageId === messageId`. The
// `childSessionKey` parsed from the `sessions_spawn` tool output is kept as a
// FALLBACK (covers a row written before tagging, or odd shapes). If neither matches
// the join is empty and the turn falls back to the generic state — never a blank
// bubble. (The earlier toolPart-only join failed live: the gateway's sessions_spawn
// tool part carries NO result/childSessionKey, so the key set was always empty.)

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
  /** The child finished but the parent's ANNOUNCE merge is still expected:
   *  showing the child's raw result now would get REWRITTEN by the merged
   *  reply moments later (live 2026-07-19 — the "block rewrote itself"
   *  report). Hold a composing note until `recheckAt`, then fall back. */
  | { kind: "composing"; taskName?: string; recheckAt: number }
  | { kind: "done"; taskName?: string; resultText?: string }
  | { kind: "failed"; taskName?: string; reason: string }
  | { kind: "generic" };

/** How long after the child completes we still EXPECT the announce merge to
 *  deliver the parent's own reply (it can be delayed behind queued turns —
 *  the stash flushes between turns). Past this, the child's raw result is
 *  surfaced as the answer (the pre-merge fallback, gateways without announce). */
export const ANNOUNCE_COMPOSE_GRACE_MS = 180_000;

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

/** The tool names that mean "this turn delegated to other agents", per provider:
 *  OpenClaw `sessions_spawn`, Hermes `delegate_task`, and the bridge-synthesized
 *  `mixture_of_agents` marker on Hermes MoA turns. The sub-agent UI gates on
 *  these NAMES (always present) rather than a parseable spawn output. */
const SPAWN_TOOL_NAMES = new Set([
  "sessions_spawn",
  "delegate_task",
  "mixture_of_agents",
]);

/** Whether this turn delegated at all — see SPAWN_TOOL_NAMES. */
export function toolPartsHaveSpawn(
  toolParts: readonly EmptyStateToolPart[],
): boolean {
  return toolParts.some((p) => SPAWN_TOOL_NAMES.has(p.toolName));
}

/** Whether this turn STARTED a gateway background task (an async tool ack —
 *  result.details {async:true, taskId}): its engagement row lives in the
 *  same monitor, so the monitor gate must open for it too. */
export function toolPartsStartedAsyncTask(
  toolParts: readonly EmptyStateToolPart[],
): boolean {
  return toolParts.some((p) => {
    const result = p.result;
    if (typeof result !== "object" || result === null) return false;
    const details = (result as { details?: unknown }).details;
    if (typeof details !== "object" || details === null) return false;
    const d = details as { async?: unknown; taskId?: unknown };
    return d.async === true && typeof d.taskId === "string";
  });
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
  messageId?: string,
  now: number = Date.now(),
): AssistantEmptyState {
  if (message.hasText || message.hasMedia) return { kind: "none" };
  if (message.status !== "complete") return { kind: "none" };

  // PRIMARY correlation = parentMessageId (the bridge tags every child with its
  // spawning message — robust, message-precise). FALLBACK = the childSessionKey the
  // spawn output carried (covers a row written before parentMessageId tagging).
  const keys = new Set(extractSpawnedChildKeys(toolParts));
  const mine = subAgents.filter(
    (s) =>
      (messageId !== undefined && s.parentMessageId === messageId) ||
      keys.has(s.childSessionKey),
  );

  // A still-running child takes precedence: the parent yielded and the gateway
  // resumes it when the child returns, so "waiting" is the truthful state even if
  // a sibling already failed. Background-task rows COUNT here — a silent turn
  // that started an async tool is genuinely waiting on its delivery.
  const running = mine.find((s) => s.status === "running");
  if (running) return { kind: "waiting", taskName: cleanTaskName(running.taskName) };

  // TERMINAL states consider only real delegation children: a task settled
  // silently (NO_REPLY) carries no resultText — surfacing it as done/failed
  // would render an empty or misleading bubble (the generic state is honest).
  const settled = mine.filter((s) => s.kind !== "task");

  const failed = settled.find(
    (s) => s.status === "error" || s.status === "aborted",
  );
  if (failed) {
    return {
      kind: "failed",
      taskName: cleanTaskName(failed.taskName),
      reason: shortenSubAgentError(failed.errorMessage),
    };
  }

  // A child that FINISHED with a result. On modern gateways the parent's
  // ANNOUNCE merge follows and writes the REAL reply into this bubble —
  // surfacing the child's raw result immediately would show one text and then
  // rewrite it (the double-reveal report, live 2026-07-19). Hold a
  // "composing" note during the grace window; past it (announce lost / old
  // gateway) the child's OWN result IS this turn's answer — the pre-merge
  // fallback, never a blank bubble for a real delegation.
  const done = settled.find((s) => s.status === "done");
  if (done) {
    const recheckAt = done.updatedAt + ANNOUNCE_COMPOSE_GRACE_MS;
    if (now < recheckAt) {
      return {
        kind: "composing",
        taskName: cleanTaskName(done.taskName),
        recheckAt,
      };
    }
    return {
      kind: "done",
      taskName: cleanTaskName(done.taskName),
      resultText: done.resultText,
    };
  }

  return { kind: "generic" };
}
