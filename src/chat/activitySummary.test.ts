// The Control UI's activity summary, ported (src/chat/activitySummary.ts): the cases of the
// upstream test ui/src/lib/chat/tool-call-grouping.test.ts (v2026.9.33), one for one, with the
// Control UI's own French strings in place of its English ones.

import { describe, expect, it } from "vitest";
import { resolveCompletedActivityWrappers, summarizeToolGroup, type ActivityItem } from "./activitySummary";

describe("summarizeToolGroup (upstream ui/src/lib/chat/tool-call-grouping.test.ts)", () => {
  const prepared = (itemId: string, title: string, extra: Partial<ActivityItem> = {}): ActivityItem => ({
    itemId,
    title,
    status: "completed",
    ...extra,
  });

  it("counts prepared operations without copying their free-form titles", () => {
    expect(
      summarizeToolGroup([
        prepared("first", "Check samples", { name: "custom_tool" }),
        prepared("second", "Edit report", { name: "edit" }),
        prepared("third", "Check samples"),
      ]),
    ).toBe("1 modification · 2 autres opérations");
  });

  it("replaces running state with the same operation's outcome without counting suppressed siblings", () => {
    expect(
      summarizeToolGroup([
        prepared("tool:call", "Inspect", { toolCallId: "call", status: "running" }),
        prepared("tool:call", "Inspect", { toolCallId: "call", status: "failed" }),
        prepared("command:call", "Command", { toolCallId: "call", suppressChannelProgress: true }),
      ]),
    ).toBe("1 autre opération · 1 en échec");
  });

  it("keeps failure, approval, skipped, and unknown outcomes while quiet work stays out", () => {
    expect(
      summarizeToolGroup([
        prepared("quiet", "Wait", { hideFromChannelProgress: true }),
        prepared("failure", "Check process", { status: "failed" }),
        prepared("approval", "Write report", { status: "blocked" }),
        prepared("steering", "Read context", { status: "skipped" }),
        prepared("unknown", "Outcome unknown", { status: undefined }),
      ]),
    ).toBe("4 autres opérations · 1 en échec · 1 bloqués · 1 ignorés · 1 inconnus");
  });

  it("keeps the diagnostic disclosure label when all prepared work is quiet", () => {
    expect(summarizeToolGroup([])).toBe(summarizeToolGroup([prepared("quiet", "Wait", { hideFromChannelProgress: true })]));
    expect(summarizeToolGroup([])).not.toBe("");
  });

  it("bounds dense summaries independently of command, title, and custom-name length", () => {
    const items = Array.from({ length: 500 }, (_, index) =>
      prepared(`call-${index}`, `print text → ${"/workspace/deep/path ".repeat(100)}`, {
        name: index % 2 === 0 ? "exec" : `custom_${"long".repeat(100)}_${index}`,
      }),
    );
    expect(summarizeToolGroup(items)).toBe("250 commandes · 250 autres opérations");
    expect(summarizeToolGroup([prepared("custom", "constructor", { name: "constructor" })])).toBe("1 autre opération");
    expect(summarizeToolGroup([prepared("command", "Native command", { commandBearing: true })])).toBe("1 commande");
  });
});

describe("resolveCompletedActivityWrappers (upstream agent-activity-presentation.ts:7-22)", () => {
  const call = (callId: string, status: string, parentToolCallId?: string) => ({
    runId: "run",
    callId,
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
    activity: { status },
  });

  it("a completed call with recorded children is a wrapper; a lone call is not", () => {
    const outer = call("outer", "completed");
    const child = call("child", "completed", "outer");
    const lone = call("lone", "completed");
    expect([...resolveCompletedActivityWrappers([outer, child, lone])]).toEqual([outer]);
  });

  it("a wrapper still running, or failed, keeps its own place", () => {
    const running = call("outer", "running");
    const failed = call("outer2", "failed");
    expect(resolveCompletedActivityWrappers([running, call("c1", "completed", "outer"), failed, call("c2", "completed", "outer2")]).size).toBe(0);
  });

  it("nested wrappers are both wrappers", () => {
    const a = call("a", "completed");
    const b = call("b", "completed", "a");
    const c = call("c", "completed", "b");
    expect(resolveCompletedActivityWrappers([a, b, c])).toEqual(new Set([a, b]));
  });
});
