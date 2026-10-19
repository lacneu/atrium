// ONE ACTIVITY BLOCK OF A BUBBLE SHOWN ROW BY ROW (projection `on`), AS THE CONTROL UI
// BUILDS ITS ACTIVITY GROUP (ui/src/pages/chat/components/chat-message-group.ts:204-283,
// OpenClaw v2026.9.33):
//   - the cards are ranked by their recorded nesting: a call run from the code of a code-mode
//     `exec` sits under that `exec` (`groupToolCalls`, vendored with its upstream test);
//   - a completed call whose children were recorded is a WRAPPER: its children say what it
//     did, so it is not counted in the summary (`resolveCompletedActivityWrappers`, the
//     upstream rule that marks it `hideFromChannelProgress`, src/infra/agent-activity-events.ts
//     :337, and the summary skips it, ui/src/pages/chat/components/chat-message-group.ts:242-244);
//   - the summary counts the visible operations by family (`summarizeToolGroup`). Pure.

import {
  isProcessPollResultDetails,
  projectAgentActivityItem,
  resolveCompletedActivityWrappers,
  summarizeToolGroup,
  type ActivityItem,
} from "./activitySummary";
import type { ToolActivityPart } from "./toolActivityView";
import { groupToolCalls, type ToolCallGroup } from "../vendor/upstream-activity/src/chat/tool-call-grouping";

export type ActivityNode = { part: ToolActivityPart; children: ActivityNode[] };

/** A block's run: the cards of one block all belong to one bubble, i.e. one run. */
const BLOCK_RUN = "block";

/** The Control UI's item status for a card (AgentActivityItemSchema `status`). A call with
 *  no result is still `running`, settled bubble or not: upstream's history projection gives
 *  a call without a result phase `start` (src/infra/agent-activity-events.ts:286-334 →
 *  `projectAgentToolActivity`, status `running`), so an `exec` interrupted after its code
 *  launched children is NOT a completed wrapper and stays in the count
 *  (src/agents/embedded-agent-subscribe.tool-result-ordering.test.ts:161, "incomplete"). */
function itemStatus(phase: string | undefined): string {
  if (phase === "error") return "failed";
  if (phase === "completed") return "completed";
  return "running";
}

/** The result as upstream's projection reads it (`result.details`): a transcript row's
 *  output carries its `details`; a live exec card on this lane carries the bare outcome
 *  envelope `{status, exitCode, durationMs}` (toolActivityView), and an elided one its
 *  `resultDetails` — both are those details. */
function asDetails(result: unknown): unknown {
  return (result as { details?: unknown } | undefined)?.details;
}

function resultFacts(part: ToolActivityPart): unknown {
  const r = part.result as Record<string, unknown> | undefined;
  if (r !== null && typeof r === "object" && !Array.isArray(r)) {
    if ("details" in r) return r;
    if ("exitCode" in r && "status" in r) return { details: r };
  }
  return part.resultDetails !== undefined ? { details: part.resultDetails } : undefined;
}

export function activityBlock(
  parts: readonly ToolActivityPart[],
  // Kept for the callers: a settled bubble no longer changes a card's status (itemStatus).
  _settled: boolean,
): { roots: ActivityNode[]; visible: ToolActivityPart[]; summary: string } {
  const calls = parts.map((part) => {
    const status = itemStatus(part.phase);
    const result = resultFacts(part);
    const name = part.toolName;
    // The prepared item, as upstream prepares history activity (agent-activity-events.ts
    // :308-334): a process poll is recognised by its result, `collab.wait` is the native wait.
    const activity = projectAgentActivityItem(
      { kind: "tool", name, status, phase: status === "running" ? "start" : "end" },
      {
        args: part.args,
        result,
        ...(name === "collab.wait"
          ? { nativeOperation: "wait" as const }
          : name === "process" && isProcessPollResultDetails(asDetails(result))
            ? { nativeOperation: "process.poll" as const }
            : {}),
      },
    );
    return {
      runId: BLOCK_RUN,
      callId: part.toolCallId,
      ...(part.parentToolCallId !== undefined ? { parentToolCallId: part.parentToolCallId } : {}),
      part,
      activity,
    };
  });
  const toNode = (g: ToolCallGroup<(typeof calls)[number]>): ActivityNode => ({
    part: g.card.part,
    children: g.children.map(toNode),
  });
  const roots = groupToolCalls(calls).map(toNode);
  const wrappers = resolveCompletedActivityWrappers(calls);
  const items: ActivityItem[] = calls.map((c) => ({
    itemId: c.callId,
    toolCallId: c.callId,
    title: c.part.toolName,
    name: c.part.toolName,
    status: c.activity.status,
    ...(wrappers.has(c) || c.activity.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
  }));
  return {
    roots,
    visible: calls.filter((c) => !wrappers.has(c)).map((c) => c.part),
    summary: summarizeToolGroup(items),
  };
}
