// What a bubble says of a turn the gateway cut — the UI hop (the facts come from Convex:
// convex/restartRecovery.test.ts ends with exactly these `interruption` values).

import { describe, expect, it } from "vitest";
import { m } from "@/paraglide/messages.js";
import { toolCardPhase } from "./ToolCard";
import { turnInterrupted, turnInterruptionText } from "./turnInterruptionView";

describe("turnInterruptionText", () => {
  it("restart, then the gateway's recovery (bench proof C2-3a): the restart, and that the agent resumed", () => {
    expect(turnInterruptionText({ shutdown: "restart", recoveryRunId: "r", unanswered: true }, "complete")).toBe(
      m.turn_interrupted_restart_recovered(),
    );
  });
  it("stop, then the recovery (C2-3d): never worded as a restart", () => {
    const text = turnInterruptionText({ shutdown: "stop", recoveryRunId: "r", unanswered: true }, "complete");
    expect(text).toBe(m.turn_interrupted_stop_recovered());
    expect(text).not.toBe(m.turn_interrupted_restart_recovered());
  });
  it("a recovery with no shutdown seen by the bridge: the interruption, without naming a cause", () => {
    expect(turnInterruptionText({ recoveryRunId: "r" }, "complete")).toBe(m.turn_interrupted_recovered());
  });
  it("no recovery: the announced shutdown and that no answer was written — for a restart and for a stop", () => {
    expect(turnInterruptionText({ shutdown: "restart", unanswered: true }, "complete")).toBe(m.turn_interrupted_restart());
    expect(turnInterruptionText({ shutdown: "stop", unanswered: true }, "aborted")).toBe(m.turn_interrupted_stop());
  });
  it("an announced shutdown alone says nothing: the turn may have answered, or go on", () => {
    expect(turnInterruptionText({ shutdown: "restart" }, "complete")).toBeNull();
    expect(turnInterruptionText({ unanswered: true }, "complete")).toBeNull();
    expect(turnInterruptionText(undefined, "complete")).toBeNull();
  });
  it("nothing is said while the bubble still streams", () => {
    expect(turnInterruptionText({ shutdown: "restart", recoveryRunId: "r" }, "streaming")).toBeNull();
    expect(turnInterrupted({ shutdown: "restart", unanswered: true }, undefined)).toBe(false);
  });
  it("no sentence invites the reader to send again", () => {
    for (const text of [
      m.turn_interrupted_restart_recovered(),
      m.turn_interrupted_stop_recovered(),
      m.turn_interrupted_recovered(),
      m.turn_interrupted_restart(),
      m.turn_interrupted_stop(),
    ]) {
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
});
