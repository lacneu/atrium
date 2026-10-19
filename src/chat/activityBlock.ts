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

import { resolveCompletedActivityWrappers, summarizeToolGroup, type ActivityItem } from "./activitySummary";
import type { ToolActivityPart } from "./toolActivityView";
import { groupToolCalls, type ToolCallGroup } from "../vendor/upstream-activity/src/chat/tool-call-grouping";

export type ActivityNode = { part: ToolActivityPart; children: ActivityNode[] };

/** A block's run: the cards of one block all belong to one bubble, i.e. one run. */
const BLOCK_RUN = "block";

/** The Control UI's item status for a card (AgentActivityItemSchema `status`). */
function itemStatus(phase: string | undefined, settled: boolean): string {
  if (phase === "error") return "failed";
  if (phase === "completed" || settled) return "completed";
  return "running";
}

export function activityBlock(
  parts: readonly ToolActivityPart[],
  settled: boolean,
): { roots: ActivityNode[]; visible: ToolActivityPart[]; summary: string } {
  const calls = parts.map((part) => ({
    runId: BLOCK_RUN,
    callId: part.toolCallId,
    ...(part.parentToolCallId !== undefined ? { parentToolCallId: part.parentToolCallId } : {}),
    part,
    activity: { status: itemStatus(part.phase, settled) },
  }));
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
    ...(wrappers.has(c) ? { hideFromChannelProgress: true } : {}),
  }));
  return {
    roots,
    visible: calls.filter((c) => !wrappers.has(c)).map((c) => c.part),
    summary: summarizeToolGroup(items),
  };
}
