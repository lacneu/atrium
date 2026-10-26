// The CU-22 resume TRANSITION (codex pass 5). A /resume is serialized with the chat's
// sends. Since 0.102.1 the gateway's state decides three outcomes: still running
// (resumed, reconciler on), no longer running (reconciler on and one transcript read
// awaited, which settles the bubble), or no proof either way (`unknown`: Convex leaves the
// bubble streaming; the reconciler is switched on so the gateway's later proof ends it —
// Codex pass 3). A socket that moved on switches nothing on.

import { describe, expect, it } from "vitest";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { admitResume, ChatTransitionGate, resumeAnswerBody } from "../src/server.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const KEY = "agent:alice:atrium:chat:u:c1";

function sessionWith(historyPayload: unknown, readApplies = true) {
  const rm = new RunManager("c1", KEY, {} as ConvexWriter);
  const configured: unknown[] = [];
  const reads: string[] = [];
  let idleAwaited = 0;
  return {
    rm,
    configured,
    reads,
    idleAwaited: () => idleAwaited,
    session: {
      runManager: rm,
      transcriptShadow: {
        configure: (opts: unknown) => configured.push(opts),
        requestRead: (why: string) => reads.push(why),
        idle: async () => {
          idleAwaited++;
        },
        // A read requested, awaited, and whether it was read AND applied (Codex pass 7).
        readNow: async (why: string) => {
          reads.push(why);
          idleAwaited++;
          return readApplies;
        },
      },
      clock: () => 1_000,
      sessionKey: KEY,
      wake: () => {},
      connection: { request: async () => ({ payload: historyPayload }) },
    } as unknown as Parameters<typeof admitResume>[0],
  };
}

describe("admitResume — the gateway's state decides (0.102.1, the Control UI's reconnect hydration)", () => {
  it("the gateway still runs the bubble's run: resumed, the turn active, the reconciler on", async () => {
    const { rm, session, configured } = sessionWith({
      messages: [],
      sessionInfo: { hasActiveRun: true, activeRunIds: ["runA"] },
      inFlightRun: { runId: "runA" },
    });
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe("resumed");
    expect(rm.turnActive).toBe(true);
    expect(configured).toEqual([{ cursor: null }]);
  });

  it("the gateway no longer runs it: not_running — no turn, and ONE transcript read awaited before answering", async () => {
    const { rm, session, configured, reads, idleAwaited } = sessionWith({
      messages: [],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
      inFlightRun: null,
    });
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      "not_running",
    );
    expect(rm.turnActive).toBe(false);
    // The idle read is what settles the bubble from the run's rows (Convex closes only
    // what it left streaming).
    expect(configured).toEqual([{ cursor: null }]);
    expect(reads).toEqual(["resume"]);
    expect(idleAwaited()).toBe(1);
  });

  it("Codex pass 7 — over by the facts, but the transcript read FAILED: unknown (nothing closed without the proof applied)", async () => {
    const { session, configured, reads } = sessionWith(
      { messages: [], sessionInfo: { hasActiveRun: false, activeRunIds: [] } },
      false,
    );
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe("unknown");
    expect(configured).toEqual([{ cursor: null }]); // still listening
    expect(reads).toEqual(["resume"]);
  });

  it("an idle session proves it over on its own, even without a list (`hasActiveRun: false`)", async () => {
    const { session } = sessionWith({ messages: [], sessionInfo: { hasActiveRun: false } });
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      "not_running",
    );
  });

  it("another run is active, not this one: not_running", async () => {
    const { session } = sessionWith({
      messages: [],
      sessionInfo: { hasActiveRun: true, activeRunIds: ["runB"] },
      inFlightRun: { runId: "runB" },
    });
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      "not_running",
    );
  });

  it("Codex pass 1 — active, with NO exact run set (activeRunIds and inFlightRun omitted): unknown, never not_running", async () => {
    // The gateway omits `activeRunIds` while its identities are incomplete — a terminal
    // still being persisted, an embedded or projected run (session-active-runs.ts:273-283
    // at v2026.9.33). This run may be the one it did not name: closing it would lose the
    // answer it is about to give.
    const { session, configured, reads } = sessionWith({
      messages: [],
      sessionInfo: { hasActiveRun: true },
    });
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      "unknown",
    );
    // …but LISTENED to (Codex pass 3): the reconciler goes on, its subscription with it,
    // and the gateway's later proof settles the bubble. Nothing is read or awaited here.
    expect(configured).toEqual([{ cursor: null }]);
    expect(reads).toEqual([]);
  });

  it("…the same with another run in flight and no exact set: unknown", async () => {
    const { session } = sessionWith({
      messages: [],
      sessionInfo: { hasActiveRun: true },
      inFlightRun: { runId: "runB" },
    });
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      "unknown",
    );
  });

  it("…an active list at the read bound may have been cut: unknown", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `run-${i}`);
    const { session } = sessionWith({ messages: [], sessionInfo: { hasActiveRun: true, activeRunIds: ids } });
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      "unknown",
    );
  });

  it("…no `hasActiveRun` and no list at all proves nothing: unknown", async () => {
    const { session } = sessionWith({ messages: [], sessionInfo: {} });
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      "unknown",
    );
  });

  it("the history read fails: unknown — never taken for « over », and the session listened to", async () => {
    const { session, configured, reads } = sessionWith(null);
    (session as unknown as { connection: { request: () => Promise<never> } }).connection.request =
      async () => {
        throw new Error("socket closed");
      };
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true)).toBe(
      "unknown",
    );
    expect(configured).toEqual([{ cursor: null }]);
    expect(reads).toEqual([]);
  });

  it("the socket moved on while reading: unknown, nothing switched on", async () => {
    const { session, configured } = sessionWith({
      messages: [],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    });
    expect(await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => false)).toBe(
      "unknown",
    );
    expect(configured).toEqual([]);
  });

  it("a transcript read that never ends does not hold the answer past its budget — and proves nothing", async () => {
    const { session } = sessionWith({ messages: [], sessionInfo: { hasActiveRun: false, activeRunIds: [] } });
    (session as unknown as { transcriptShadow: { readNow: () => Promise<boolean> } }).transcriptShadow.readNow = () =>
      new Promise<boolean>(() => {});
    expect(
      await admitResume(session, "c1", { messageId: "m1", runId: "runA" }, () => true, 5),
    ).toBe("unknown");
  });
});

describe("resumeAnswerBody — the answer Convex reads (stuckStreams.resumeVerdict)", () => {
  it("names why a bubble was not resumed; a pre-0.102.1 bridge named nothing", () => {
    expect(resumeAnswerBody("resumed")).toEqual({ ok: true, resumed: true });
    expect(resumeAnswerBody("not_running")).toEqual({ ok: true, resumed: false, reason: "not_running" });
    expect(resumeAnswerBody("unknown")).toEqual({ ok: true, resumed: false, reason: "unknown" });
    expect(resumeAnswerBody("stale")).toEqual({ ok: true, resumed: false, reason: "stale" });
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
