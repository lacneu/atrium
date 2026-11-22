// What a bubble says of a turn the gateway cut — the UI hop (the facts come from Convex:
// convex/restartRecovery.test.ts ends with exactly these `interruption` values).

import { describe, expect, it } from "vitest";
import { m } from "@/paraglide/messages.js";
import { toolCardPhase } from "./ToolCard";
import { interruptedCalls, turnInterrupted, turnInterruptionText } from "./turnInterruptionView";

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
});
