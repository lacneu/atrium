import { describe, expect, it } from "vitest";
import { composerQueueState } from "./composerQueueState";

// Pure-logic tests for the composer's send-vs-queue decision + the hold REASON
// (the visible-hold fix: a parked follow-up the user can't see is worse than the
// bug). No i18n here — the helper returns the structural decision; the component
// attaches the localized label.

describe("composerQueueState (send-vs-queue + hold reason)", () => {
  it("idle (nothing busy) => send", () => {
    expect(
      composerQueueState({ turnRunning: false, hasRunningSubAgent: false }),
    ).toEqual({ mode: "send", reason: null });
  });

  it("an in-flight turn => queue with reason 'turn'", () => {
    expect(
      composerQueueState({ turnRunning: true, hasRunningSubAgent: false }),
    ).toEqual({ mode: "queue", reason: "turn" });
  });

  it("a running sub-agent (no in-flight turn) => queue with reason 'subagent'", () => {
    // The headline case: the parent turn finalized but a child still runs, so a
    // follow-up must be HELD and the hold made visible with its own reason.
    expect(
      composerQueueState({ turnRunning: false, hasRunningSubAgent: true }),
    ).toEqual({ mode: "queue", reason: "subagent" });
  });

  it("an in-flight turn WINS the attribution over a running sub-agent", () => {
    // Discriminating: both busy -> the active turn is the immediate blocker, so the
    // 'subagent' hint would be misleading mid-turn.
    expect(
      composerQueueState({ turnRunning: true, hasRunningSubAgent: true }),
    ).toEqual({ mode: "queue", reason: "turn" });
  });
});
