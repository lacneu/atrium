// What a bubble says of a turn the gateway cut — the UI hop (the facts come from Convex:
// convex/restartRecovery.test.ts ends with exactly these `interruption` values).

import { describe, expect, it } from "vitest";
import { m } from "@/paraglide/messages.js";
import { activityBlock, groupOutcome } from "./activityBlock";
import { toolCardPhase } from "./ToolCard";
import { blockInterrupted, interruptedCalls, turnInterrupted, turnInterruptionText } from "./turnInterruptionView";

describe("turnInterruptionText", () => {
  it("restart, then the gateway's recovery (bench proof C2-3a): the restart, and that the agent resumed", () => {
    expect(turnInterruptionText({ shutdown: "restart", recoveryRunId: "r" }, "complete")).toBe(
      m.turn_interrupted_restart_recovered(),
    );
  });
  it("stop, then the recovery (C2-3d): never worded as a restart", () => {
    const text = turnInterruptionText({ shutdown: "stop", recoveryRunId: "r" }, "complete");
    expect(text).toBe(m.turn_interrupted_stop_recovered());
    expect(text).not.toBe(m.turn_interrupted_restart_recovered());
  });
  it("a recovery with no shutdown seen by the bridge: the interruption, without naming a cause", () => {
    expect(turnInterruptionText({ recoveryRunId: "r" }, "complete")).toBe(m.turn_interrupted_recovered());
  });
  it("an announced shutdown alone says nothing, restart or stop: only the gateway's recovery states an interruption", () => {
    expect(turnInterruptionText({ shutdown: "restart" }, "complete")).toBeNull();
    expect(turnInterruptionText({ shutdown: "stop" }, "aborted")).toBeNull();
    expect(turnInterrupted({ shutdown: "restart" }, "complete")).toBe(false);
    // Call ids without the recovery they belong to state nothing either.
    expect(turnInterruptionText({ shutdown: "stop", cutCallIds: ["c1"] }, "complete")).toBeNull();
    expect(turnInterruptionText(undefined, "complete")).toBeNull();
  });
  it("nothing is said while the bubble still streams", () => {
    expect(turnInterruptionText({ shutdown: "restart", recoveryRunId: "r" }, "streaming")).toBeNull();
    expect(turnInterrupted({ shutdown: "restart", recoveryRunId: "r" }, undefined)).toBe(false);
  });
  it("no sentence invites the reader to send again", () => {
    for (const text of [m.turn_interrupted_restart_recovered(), m.turn_interrupted_stop_recovered(), m.turn_interrupted_recovered()]) {
      expect(text).not.toMatch(/retry|resend|send again|try again|renvoy|réessay/i);
    }
  });
});

describe("a tool call the interrupted turn left without a result", () => {
  it("is interrupted, not completed", () => {
    expect(toolCardPhase("started", false, true, true)).toBe("interrupted");
    // The same card on a turn that simply settled keeps its old reading.
    expect(toolCardPhase("started", false, true, false)).toBe("completed");
  });
  it("a call that has its result, or failed, is unchanged", () => {
    expect(toolCardPhase("completed", true, true, true)).toBe("completed");
    expect(toolCardPhase("started", true, true, true)).toBe("completed");
    expect(toolCardPhase("error", false, true, true)).toBe("error");
  });
  it("is one of the calls Convex PROVED the cut left open — by id, never every call of the bubble", () => {
    const cut = interruptedCalls({ shutdown: "restart", recoveryRunId: "r", cutCallIds: ["c9"] }, "complete");
    expect([...cut]).toEqual(["c9"]);
    // An earlier call of the same bubble shown without a result (its result was never
    // read) is not among them.
    expect(cut.has("c4")).toBe(false);
  });
  it("no call is interrupted without a recovery, without proven ids, or while the bubble streams", () => {
    expect(interruptedCalls({ recoveryRunId: "r" }, "complete").size).toBe(0);
    expect(interruptedCalls({ shutdown: "restart", cutCallIds: ["c9"] }, "complete").size).toBe(0);
    expect(interruptedCalls({ recoveryRunId: "r", cutCallIds: ["c9"] }, "streaming").size).toBe(0);
    expect(interruptedCalls(undefined, "complete").size).toBe(0);
  });
  it("the block that holds it does not read as all done", () => {
    const cut = new Set(["c9"]);
    expect(blockInterrupted([{ toolCallId: "c1", phase: "completed" }, { toolCallId: "c9", phase: "start" }], cut)).toBe(true);
    // A block of another group of the same bubble, without the cut call, keeps its check.
    expect(blockInterrupted([{ toolCallId: "c1", phase: "completed" }, { toolCallId: "c4", phase: "start" }], cut)).toBe(false);
    // A proven id whose card has a result or an outcome reads as the card does.
    expect(blockInterrupted([{ toolCallId: "c9", phase: "start", result: { ok: true } }], cut)).toBe(false);
    expect(blockInterrupted([{ toolCallId: "c9", phase: "completed" }], cut)).toBe(false);
    expect(blockInterrupted([{ toolCallId: "c9", phase: "error" }], cut)).toBe(false);
    expect(blockInterrupted([{ toolCallId: "c9", phase: "start" }], new Set())).toBe(false);
  });

  // Seen on the live app: "… · 1 en échec" followed by a check.
  it("a group that holds a failed call ends on the failure, never on a check", () => {
    const none = new Set<string>();
    expect(groupOutcome([{ toolCallId: "c1", phase: "completed" }, { toolCallId: "c2", phase: "error" }], none)).toBe("failed");
    expect(groupOutcome([{ toolCallId: "c1", phase: "completed" }], none)).toBe("done");
    // A command that completed with a nonzero exit is what the summary calls failed too.
    const parts = [
      { toolCallId: "c1", toolName: "read", phase: "completed", result: "ok" },
      { toolCallId: "c2", toolName: "exec", phase: "completed", result: { status: "completed", exitCode: 2, durationMs: 5 } },
    ];
    const block = activityBlock(parts as never, true);
    expect(block.summary).toContain(m.activity_summary_failed({ count: "1" }));
    expect(block.failed).toBe(1);
    expect(groupOutcome(parts, none, block.failed)).toBe("failed");
  });
  it("interrupted and failed: the failure; interrupted alone stays interrupted", () => {
    const cut = new Set(["c9"]);
    expect(groupOutcome([{ toolCallId: "c9", phase: "start" }, { toolCallId: "c2", phase: "error" }], cut)).toBe("failed");
    expect(groupOutcome([{ toolCallId: "c9", phase: "start" }, { toolCallId: "c2", phase: "completed" }], cut)).toBe("interrupted");
  });
});
