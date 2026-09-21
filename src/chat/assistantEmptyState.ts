import {
  childAgentIdFromKey,
  shortenSubAgentError,
  type SubAgentRow,
} from "./subAgentActivityView";
import {
  toolResultStatus,
  yieldHandedOff,
} from "../../convex/lib/toolOutcome";

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
  /** The structured remnant of an output the window read elided for size — the
   *  only place a big spawn's child key survives. */
  resultDetails?: unknown;
  /** The normalizer's lifecycle phase ("completed" | "error" | …). The caller
   *  already carries it (ToolActivityPart); reading it is what separates a tool
   *  that DID the thing from one that was refused. */
  phase?: string;
  /** The tool output. For `sessions_spawn` it mirrors the gateway frame the
   *  bridge observer parses: `{ content: [{ text: "<json>" }] }` (2026.6.10+),
   *  or `contentItems` on gateways up to 2026.6.5. */
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
  /** When this bubble SETTLED (the Convex message `updatedAt`). Bounds the
   *  unbacked waiting note; absent = no grace, the terminal verdict stands. */
  settledAt?: number;
};

/** The discriminated render decision. `none` = render normally (there is an
 *  answer, or the turn is not a settled-empty one). */
export type AssistantEmptyState =
  | { kind: "none" }
  /** `recheckAt` is set ONLY for the unbacked case: the turn provably delegated,
   *  but no sub-agent row correlates to it YET. A note that no event can ever
   *  close is a lie with no end date, so this one expires back to the terminal
   *  verdict. A waiting backed by a real RUNNING row carries no deadline — that
   *  row's own transition ends it. */
  | { kind: "waiting"; taskName?: string; recheckAt?: number }
  /** The child finished but the parent's ANNOUNCE merge is still expected:
   *  showing the child's raw result now would get REWRITTEN by the merged
   *  reply moments later (live 2026-07-19 — the "block rewrote itself"
   *  report). Hold a composing note until `recheckAt`, then fall back. */
  | { kind: "composing"; taskName?: string; recheckAt: number }
  | {
      kind: "done";
      taskName?: string;
      resultText?: string;
      /** The delegated agent whose answer this IS — so the reader is told the
       *  reply comes from the agent the current one asked, not from it. */
      agentId?: string;
    }
  | { kind: "failed"; taskName?: string; reason: string }
  | { kind: "generic" };

/** How long after the child completes we still EXPECT the announce merge to
 *  deliver the parent's own reply (it can be delayed behind queued turns —
 *  the stash flushes between turns). Past this, the child's raw result is
 *  surfaced as the answer (the pre-merge fallback, gateways without announce). */
export const ANNOUNCE_COMPOSE_GRACE_MS = 180_000;

/** How long a turn that provably delegated may say "waiting" with NO sub-agent
 *  row to back it. The bridge writes the row from the spawn RESULT, during the
 *  turn — so a missing row at settle time is a lag, not a state. Well past that
 *  lag the honest answer is the terminal one: the agent acted and nothing came
 *  back. Deliberately short: this covers a query that has not caught up, never a
 *  delegation whose row will never exist. */
export const UNBACKED_DELEGATION_GRACE_MS = 30_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pull the childSessionKey(s) this turn spawned out of its `sessions_spawn` tool
 * part(s). Mirrors the bridge observer's `extractChildSessionKey`: the output is
 * `{ content: [{ text: "<json with childSessionKey>" }] }`. Fully defensive
 * -- a missing / elided (string note) / oddly-shaped output yields no key and
 * NEVER throws.
 *
 * THE ARRAY KEY CHANGED UPSTREAM and this reader was not told. It is
 * `contentItems` up to gateway 2026.6.5 and `content` from 2026.6.10 on — the
 * bridge's own twin was corrected for exactly that drift and says so
 * (providers/openclaw/sub-agent-observer.ts:1655-1657, "Verified live on 6.10:
 * result.content"). This copy kept reading only the old key, so on every gateway
 * since 2026.6.10 — which is every gateway in production — it returned NO keys at
 * all. Correlation then rested entirely on `parentMessageId`, and in the window
 * before the bridge tags the child's row the turn looked like a delegation to
 * nowhere: the bubble told the reader "the agent performed some actions but did
 * not return a response", then replaced it with "waiting" a few seconds later
 * (production, 2026-09-21). Both keys are read now, as upstream drift demands and
 * as the bridge already does.
 */
export function extractSpawnedChildKeys(
  toolParts: readonly EmptyStateToolPart[],
): string[] {
  const keys: string[] = [];
  for (const part of toolParts) {
    if (part.toolName !== "sessions_spawn") continue;
    // The elided case FIRST: an oversized result is absent from `result`, and this
    // is where its structured copy landed.
    const elided = (part.resultDetails as { childSessionKey?: unknown } | undefined)
      ?.childSessionKey;
    if (typeof elided === "string" && elided !== "") {
      keys.push(elided);
      continue;
    }
    const result = part.result;
    if (!isObject(result)) {
      // Not a record: either no output at all, or the window read replaced it with
      // the size note because the payload exceeded the projection cap. NOT "a
      // string note" as an earlier comment here claimed — an oversized output is
      // simply ABSENT from the row (convex/messages.ts sets `outputOmitted` and
      // drops the value). Either way there is no key to read; `resultDetails`
      // below is what survives that case.
      continue;
    }
    // `details` FIRST — the structured copy, and the canonical one. The gateway
    // sends the same object twice (destructured under `details`, re-serialized
    // inside `content[0].text`) and upstream's own normalizer reads only the
    // first. Parsing the pretty-printed echo is the fragile road: its array key was
    // renamed `contentItems` -> `content` at 2026.6.10 and this reader spent months
    // not noticing. Reading `details` is immune to the next rename.
    const fromDetails = (result.details as { childSessionKey?: unknown } | undefined)
      ?.childSessionKey;
    if (typeof fromDetails === "string" && fromDetails !== "") {
      keys.push(fromDetails);
      continue;
    }
    const items = Array.isArray(result.content)
      ? result.content
      : Array.isArray(result.contentItems)
        ? result.contentItems
        : null;
    if (items === null) continue;
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

/** The statuses a spawn result uses to say it took the work. Allowlisted rather
 *  than "anything that is not an error": upstream's refusal vocabulary is open
 *  (`error`, `rejected`, `failed`, `deferred`…) and guessing at it has already
 *  cost one wrong verdict. An UNKNOWN status falls open — a generation we cannot
 *  read must not be called a refusal. */
const ACCEPTED_SPAWN_STATUS: ReadonlySet<string> = new Set([
  "accepted",
  "ok",
  "started",
  "running",
]);

/** Whether a spawn on this turn was ACCEPTED.
 *
 *  `toolPartsHaveSpawn` answers "was the tool called", which is not the same
 *  question and is the wrong one here: a spawn the gateway refused answers through
 *  `jsonResult` like any other refusal — a successful call carrying
 *  `{status:"error"}` — so a refused spawn followed by a refused yield read as a
 *  hand-off and put a waiting note on a turn that delegated nothing. A key in the
 *  result is the acceptance signal the bridge itself trusts
 *  (providers/openclaw/sub-agent-observer.ts: "childSessionKey presence is the only
 *  reliable success signal", because the codex runtime flags a SUCCESSFUL spawn as
 *  errored). Falling back to a non-error status keeps a gateway that names no child
 *  from being called a refusal. */
function spawnAccepted(toolParts: readonly EmptyStateToolPart[]): boolean {
  // A named child is the acceptance signal itself — nothing else to check.
  if (extractSpawnedChildKeys(toolParts).length > 0) return true;
  return toolParts.some((p) => {
    if (!SPAWN_TOOL_NAMES.has(p.toolName)) return false;
    // A refusal is a refusal whatever word it uses. Keying on "not exactly
    // `error`" let `{status:"rejected", reason:"quota"}` through — a shape this
    // repo already carries — and with a stale completed yield on a merged bubble
    // that was enough to manufacture a hand-off. The phase must agree too: the
    // normalizer does classify a rejected spawn as `error`.
    if (p.phase === "error") return false;
    // `resultDetails` FIRST: when the window read elided the output, `result` is
    // the size NOTE (a string), and reading it would find no status and fail open
    // on exactly the big delegations this field exists to rescue.
    const status = toolResultStatus(p.resultDetails ?? p.result);
    return status === null || ACCEPTED_SPAWN_STATUS.has(status);
  });
}

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
 *  - There IS a visible answer (text or a delivered file) -> none (render normally),
 *    EXCEPT when that answer is a hand-off's waiting reply: see `handedOff` below.
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
  /** UNDEFINED = not answered yet, which is NOT the same as "this chat has no
   *  sub-agents". The callers used to collapse the two with `?? []`, so a turn
   *  whose delegation simply had not loaded was judged to have delegated to
   *  nothing. A verdict on absent data is a guess, and this one accuses. */
  subAgents: readonly SubAgentRow[] | undefined,
  messageId?: string,
  now: number = Date.now(),
): AssistantEmptyState {
  // UNKNOWN is not "none", and it is not "no sub-agents" either.
  //
  // Collapsing `undefined` into `[]` made a settled hand-off read as a turn that
  // returned nothing. Returning `none` outright traded that for the opposite
  // regression: on a cold load — and for as long as the query stays unresolved —
  // a settled, textless bubble rendered NOTHING at all, which in the clean view
  // (tool cards hidden) is the blank bubble this whole component exists to
  // prevent. So the unknown state only suspends the verdict for the turns whose
  // own parts prove a delegation; every other settled-empty turn keeps its
  // terminal answer, which needs no sub-agent row to be true.
  const rows = subAgents ?? [];
  // A BUBBLE THAT SPEAKS CAN STILL BE WAITING.
  //
  // Until the hand-off's acknowledgment was surfaced, a yielded turn arrived
  // blank and this decision supplied the only thing the reader had: "waiting on
  // <task>", or "<task> failed: <reason>". Showing the acknowledgment filled
  // `hasText`, which switched this off — so the bubble now states that the work is
  // being prepared, and then states it forever, whether the child is running,
  // finished or dead. That is the exact complaint still open from a user whose
  // delegated document never arrived and was never mentioned again: the silence
  // became a sentence, which is worse.
  //
  // So a turn that HANDED OFF keeps the two delegation facts even with text. Only
  // those two: `composing`, `done` and `generic` are about supplying an answer the
  // bubble does not have, and this bubble has one.
  const spoke = message.hasText || message.hasMedia;
  // A HAND-OFF IS A YIELD THAT SUCCEEDED, ON A TURN THAT ACTUALLY DELEGATED.
  //
  // Matching the tool NAME alone was wrong twice over. `sessions_yield` has five
  // refusals upstream — bad `waitFor`, no session context, unsupported context,
  // undelivered async results, and no pending child completion — and every one of
  // them returns through `jsonResult`, i.e. as a SUCCESSFUL tool result carrying
  // `status:"error"`. So a yield the gateway refused still wrote a card, and a turn
  // that delegated nothing at all was read as a hand-off. The parts also outlive
  // their run on a merged bubble, so "this turn yielded" had to mean "and it got
  // somewhere": a spawn, or a gateway background task.
  const handedOff =
    toolParts.some((p) =>
      p.toolName === "sessions_yield"
        ? yieldHandedOff(p.phase, p.resultDetails ?? p.result)
        : false,
    ) && (spawnAccepted(toolParts) || toolPartsStartedAsyncTask(toolParts));
  if (spoke && !handedOff) return { kind: "none" };
  if (message.status !== "complete") return { kind: "none" };

  // PRIMARY correlation = parentMessageId (the bridge tags every child with its
  // spawning message — robust, message-precise). FALLBACK = the childSessionKey the
  // spawn output carried (covers a row written before parentMessageId tagging).
  const keys = new Set(extractSpawnedChildKeys(toolParts));
  const mine = rows.filter(
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
      reason: shortenSubAgentError(failed.errorMessage, failed.errorCode),
    };
  }

  // The bubble already carries the hand-off's waiting reply, and no child is
  // running or broken. Everything below supplies an ANSWER — the bubble has one.
  if (spoke) return { kind: "none" };

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
      agentId: childAgentIdFromKey(done.childSessionKey),
    };
  }

  // A DELEGATION WHOSE ROW HAS NOT ARRIVED YET — FOR A BOUNDED MOMENT.
  //
  // Reaching here means the turn ended with no answer. For an ordinary turn that is
  // the honest verdict: the agent acted and produced nothing. For a turn that
  // provably delegated AND whose children we could not correlate at all, it is
  // premature — the row is written from the spawn result and can lag the bubble.
  //
  // Bounded on purpose. An unbacked "waiting" that no event can ever close is a lie
  // with no end date: it would spin under a settled bubble forever whenever the row
  // never comes. Past the grace the terminal verdict stands.
  //
  // Only when NOTHING correlated. If we DID find rows and none is running, failed or
  // a non-task done, the delegation is known and settled — the module's own rule
  // above (a task that settled silently carries no resultText, "the generic state is
  // honest") decides, and this must not overrule it.
  if (handedOff && mine.length === 0) {
    // The list has not answered yet: this turn provably delegated, so its rows may
    // simply not have arrived. Suspend the verdict rather than guess either way.
    if (subAgents === undefined) return { kind: "none" };
    if (message.settledAt !== undefined) {
      const recheckAt = message.settledAt + UNBACKED_DELEGATION_GRACE_MS;
      if (now < recheckAt) return { kind: "waiting", recheckAt };
    }
  }
  return { kind: "generic" };
}
