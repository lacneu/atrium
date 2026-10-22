// The CU-22 resume TRANSITION (codex pass 5). A /resume is serialized with the chat's
// sends, and it switches the session's reconciler on only for a resume that was
// admitted: a not-resumed answer leaves the session as it was.

import { describe, expect, it } from "vitest";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { admitResume, ChatTransitionGate } from "../src/server.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const KEY = "agent:alice:atrium:chat:u:c1";

function sessionWith(historyPayload: unknown) {
  const rm = new RunManager("c1", KEY, {} as ConvexWriter);
  const configured: unknown[] = [];
  return {
    rm,
    configured,
    session: {
      runManager: rm,
      transcriptShadow: { configure: (opts: unknown) => configured.push(opts) },
      clock: () => 1_000,
      sessionKey: KEY,
      wake: () => {},
      connection: { request: async () => ({ payload: historyPayload }) },
    } as unknown as Parameters<typeof admitResume>[0],
  };
}

describe("admitResume — only an admitted resume switches the reconciler on", () => {
  it("the gateway no longer runs the bubble's run: not resumed, no turn, the reconciler untouched", async () => {
    const { rm, session, configured } = sessionWith({ messages: [], inFlightRun: null });
    const resumed = await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true);
    expect(resumed).toBe(false);
    expect(rm.turnActive).toBe(false);
    expect(configured).toEqual([]);
  });

  it("the history read fails: not resumed, the reconciler untouched", async () => {
    const { session, configured } = sessionWith(null);
    (session as unknown as { connection: { request: () => Promise<never> } }).connection.request =
      async () => {
        throw new Error("socket closed");
      };
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      false,
    );
    expect(configured).toEqual([]);
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
