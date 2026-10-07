// The CU-22 resume TRANSITION (codex pass 5). A /resume used to switch the session's
// projection on before knowing whether it would resume anything, and left it on when
// it answered not-resumed: an `off` send prepared at that moment then ran with the
// projection on, and its empty terminal carried `dropIfEmpty` — the bubble was deleted
// and the legacy recovery never ran. The resume is now serialized with the chat's
// sends, and the switch stays on only for a resume that was admitted.

import { describe, expect, it } from "vitest";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { admitResume, ChatTransitionGate } from "../src/server.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const KEY = "agent:alice:atrium:chat:u:c1";

function sessionWith(historyPayload: unknown) {
  const rm = new RunManager("c1", KEY, {} as ConvexWriter);
  return {
    rm,
    session: {
      runManager: rm,
      transcriptShadow: null,
      clock: () => 1_000,
      sessionKey: KEY,
      wake: () => {},
      connection: { request: async () => ({ payload: historyPayload }) },
    } as unknown as Parameters<typeof admitResume>[0],
  };
}

describe("admitResume — the projection switch outlives only an admitted resume", () => {
  it("the gateway no longer runs the bubble's run: not resumed, the switch is put back off", async () => {
    const { rm, session } = sessionWith({ messages: [], inFlightRun: null });
    expect(rm.projectionOn).toBe(false);
    const resumed = await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true);
    expect(resumed).toBe(false);
    expect(rm.projectionOn).toBe(false);
  });

  it("a session already `on` keeps its switch when nothing is resumed", async () => {
    const { rm, session } = sessionWith({ messages: [], inFlightRun: null });
    rm.setProjection(true);
    await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true);
    expect(rm.projectionOn).toBe(true);
  });

  it("the history read fails: not resumed, the switch is put back off", async () => {
    const { rm, session } = sessionWith(null);
    (session as unknown as { connection: { request: () => Promise<never> } }).connection.request =
      async () => {
        throw new Error("socket closed");
      };
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      false,
    );
    expect(rm.projectionOn).toBe(false);
  });
});

describe("ChatTransitionGate — a resume and the chat's sends never interleave", () => {
  it("a resume is refused while a send to the chat is being prepared, admitted once it has left", async () => {
    const gate = new ChatTransitionGate();
    const leave = await gate.enterSend("c1");
    expect(gate.tryBeginResume("c1")).toBeNull();
    // Another chat is not concerned.
    const other = gate.tryBeginResume("c2");
    expect(other).not.toBeNull();
    other!();
    leave();
    const r = gate.tryBeginResume("c1");
    expect(r).not.toBeNull();
    r!();
  });

  it("a send arriving during a resume waits for the resume to decide", async () => {
    const gate = new ChatTransitionGate();
    const leaveResume = gate.tryBeginResume("c1")!;
    let entered = false;
    const send = gate.enterSend("c1").then((leave) => {
      entered = true;
      return leave;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(entered).toBe(false);
    leaveResume();
    const leave = await send;
    expect(entered).toBe(true);
    // …and while that send prepares, no new resume starts.
    expect(gate.tryBeginResume("c1")).toBeNull();
    leave();
  });

  it("two resumes of one chat never run together", () => {
    const gate = new ChatTransitionGate();
    const first = gate.tryBeginResume("c1")!;
    expect(gate.tryBeginResume("c1")).toBeNull();
    first();
    expect(gate.tryBeginResume("c1")).not.toBeNull();
  });
});
