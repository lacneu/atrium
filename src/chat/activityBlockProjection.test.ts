// The activity block's count, prepared as upstream prepares activity (0.101.2 audit):
//   - routine work stays out — `sessions_yield`, a `process` poll, the native wait, the plan
//     tools (projectAgentActivityItem, src/agents/agent-activity-presentation.ts:24-64;
//     ui/src/lib/chat/tool-call-grouping.test.ts:40 "quiet work stays out");
//   - an exec that exits nonzero is `failed` (same function, :38-50);
//   - an exec interrupted after its code launched children is not a completed wrapper: it
//     stays counted once the bubble settles (embedded-agent-subscribe.tool-result-ordering
//     .test.ts:161, "incomplete").
import { describe, expect, it } from "vitest";
import { activityBlock } from "./activityBlock";
import { projectAgentActivityItem } from "./activitySummary";
import type { ToolActivityPart } from "./toolActivityView";

const part = (toolCallId: string, toolName: string, extra: Partial<ToolActivityPart> = {}): ToolActivityPart => ({
  toolCallId,
  toolName,
  phase: "completed",
  ...extra,
});

describe("projectAgentActivityItem (upstream agent-activity-presentation.ts:24-64)", () => {
  it("a completed exec/bash/process with a nonzero exit is failed; a manual cancel is not", () => {
    for (const name of ["exec", "bash", "process"]) {
      expect(
        projectAgentActivityItem(
          { name, status: "completed", phase: "end" },
          { result: { details: { status: "completed", exitCode: 1 } } },
        ).status,
      ).toBe("failed");
    }
    expect(
      projectAgentActivityItem(
        { name: "exec", status: "completed", phase: "end" },
        { result: { details: { status: "completed", exitCode: 1, exitReason: "manual-cancel" } } },
      ).status,
    ).toBe("completed");
    expect(
      projectAgentActivityItem(
        { name: "read", status: "completed", phase: "end" },
        { result: { details: { status: "completed", exitCode: 1 } } },
      ).status,
    ).toBe("completed");
  });
  it("routine work is hidden while running or completed, never when it failed", () => {
    const hidden = (item: Parameters<typeof projectAgentActivityItem>[0], facts = {}) =>
      projectAgentActivityItem(item, facts).hideFromChannelProgress === true;
    expect(hidden({ name: "sessions_yield", status: "completed" })).toBe(true);
    expect(hidden({ name: "update_plan", status: "running" })).toBe(true);
    expect(hidden({ name: "Progress_Card", status: "completed" })).toBe(true);
    expect(hidden({ name: "process", status: "completed" }, { args: { action: "poll" } })).toBe(true);
    expect(hidden({ name: "process", status: "completed" }, { args: { action: "kill" } })).toBe(false);
    expect(hidden({ name: "anything", status: "completed" }, { nativeOperation: "wait" })).toBe(true);
    expect(hidden({ name: "sessions_yield", status: "failed" })).toBe(false);
    expect(hidden({ name: "exec", status: "completed" })).toBe(false);
  });
});

describe("the activity block's summary", () => {
  it("a hand-off exec → sessions_spawn → sessions_yield: the yield is not counted", () => {
    const view = activityBlock(
      [
        part("e1", "exec"),
        part("e2", "exec"),
        part("s1", "sessions_spawn", { parentToolCallId: "e2" }),
        part("y1", "sessions_yield"),
      ],
      true,
    );
    expect(view.summary).toBe("1 commande · 1 autre opération");
  });
  it("process polls, collab.wait and plan tools stay out of the count", () => {
    const view = activityBlock(
      [
        part("p1", "process", { args: { action: "poll" } }),
        part(
          "p2",
          "process",
          { result: { details: { sessionId: "s", status: "running", aggregated: "…" } } },
        ),
        part("w1", "collab.wait"),
        part("u1", "update_plan"),
        part("e1", "exec"),
      ],
      true,
    );
    expect(view.summary).toBe("1 commande");
  });
  it("an exec that exits nonzero is counted failed — from a row's details or a live outcome envelope", () => {
    expect(activityBlock([part("e1", "exec", { result: { details: { status: "completed", exitCode: 2 } } })], true).summary).toBe(
      "1 commande · 1 en échec",
    );
    expect(activityBlock([part("e1", "exec", { result: { status: "completed", exitCode: 2, durationMs: 5 } })], true).summary).toBe(
      "1 commande · 1 en échec",
    );
  });
  it("an exec interrupted after launching children stays counted once the bubble settles", () => {
    const parts = [part("e1", "exec", { phase: "started" }), part("s1", "sessions_spawn", { parentToolCallId: "e1" })];
    const settled = activityBlock(parts, true);
    expect(settled.visible.map((p) => p.toolCallId)).toEqual(["e1", "s1"]);
    expect(settled.summary).toBe("1 commande · 1 autre opération");
    // …whereas a completed exec with recorded children is a wrapper, out of the count.
    const done = activityBlock([part("e1", "exec"), part("s1", "sessions_spawn", { parentToolCallId: "e1" })], true);
    expect(done.visible.map((p) => p.toolCallId)).toEqual(["s1"]);
  });
});
