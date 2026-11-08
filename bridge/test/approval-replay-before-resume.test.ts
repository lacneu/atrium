// A RESUMED TURN IS HELD BY THE APPROVAL ITS RUN WAITS ON — even when the reconnection's
// replay listed that approval BEFORE the turn came back (lot « trames 1 », 0.103.5).
//
// At a reconnection the new socket's consumer replays the pending approvals at once
// (session.ts startConsumer), while `/resume` is still reading `chat.history` before it
// calls `resumeTurn` (server.ts admitResume -> planProjectedSend). When the list answers
// first, the run's approval is seen with no turn active. The observer sees each request
// once (its card memory), and the run's own `waiting-approval` went to the socket that
// closed: dropped there, the hold was lost for good — no `awaiting_approval`, and the
// resumed turn fell to the 240 s silence recovery. It is kept instead, and applied to the
// turn that resumes its run, until the approval's own deadline (N3).
//
// Real RunManager and observer, wired as session.ts wires them; the list entry and the
// `approval.get` answer are the captured 2026.9.36 shapes (helpers/approval-frames-2026.9.36.ts).
import { describe, expect, it, vi } from "vitest";

import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { OpenClawAgentRequestObserver } from "../src/providers/openclaw/agent-request-observer.js";
import { APPROVAL_WAIT_MARGIN, BASE_RECV_TIMEOUT } from "../src/providers/openclaw/normalizer.js";
import type { ConvexWriter, FinalizeStatus, ToolPart } from "../src/convex-writer.js";
import {
  execApprovalRequestedFrame,
  execApprovalRequestedPayload,
  execApprovalResolvedFrame,
  pendingApprovalGet,
  type ApprovalIds,
} from "./helpers/approval-frames-2026.9.36.js";

const KEY = "agent:alice:atrium:chat:u:c1";
/** The gateway's epoch when the list is read. */
const EPOCH_MS = 1_793_658_291_800;
/** What the request has left then (the captured timeout is 30 min from its creation). */
const LEFT = 600;

const waiting: ApprovalIds = {
  sessionKey: KEY,
  runId: "runA",
  approvalId: "a0000000-0000-4000-8000-0000000000r1",
  toolCallId: "tool_call:call_r:exec:1",
  createdAtMs: EPOCH_MS + LEFT * 1000 - 1_800_000,
};

class FakeWriter implements ConvexWriter {
  readonly phases: Array<[string, string]> = [];
  readonly finals: Array<[string, FinalizeStatus, string | null | undefined]> = [];
  private n = 0;
  async startAssistant(): Promise<string | null> {
    return `msg${++this.n}`;
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(_messageId: string, _p: ToolPart): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  setPhase(messageId: string, phase: string): void {
    this.phases.push([messageId, phase]);
  }
  async finalize(
    messageId: string,
    status: FinalizeStatus,
    _text: string,
    _error: string | null,
    errorKind?: string | null,
  ): Promise<void> {
    this.finals.push([messageId, status, errorKind]);
  }
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionRoster(): Promise<void> {}
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

/** The conversation's observer, wired to `rm` as session.ts wires it. `listGate` holds the
 *  exec list's answer; `failApprovalGet` makes every `approval.get` fail. */
function observerFor(
  rm: RunManager,
  clock: () => number,
  pending: ApprovalIds[],
  gw: { listGate?: Promise<void>; failApprovalGet?: boolean; methods?: string[] } = {},
) {
  return new OpenClawAgentRequestObserver({
    chatId: "c1",
    sessionKey: KEY,
    agentId: "alice",
    gateway: {
      request: async (method: string, params: Record<string, unknown>) => {
        gw.methods?.push(method);
        let payload: unknown = null;
        if (method === "approval.get") {
          if (gw.failApprovalGet === true) throw new Error("request timed out");
          // The request the gateway holds under that id now: the latest one.
          const ids = [...pending].reverse().find((x) => x.approvalId === params.id);
          payload = ids === undefined ? null : pendingApprovalGet(ids);
        } else if (method === "exec.approval.list") {
          await gw.listGate;
          payload = pending.map(execApprovalRequestedPayload);
        } else if (method === "plugin.approval.list" || method === "openclaw.approval.list") {
          payload = [];
        } else if (method === "question.list") {
          payload = { questions: [] };
        }
        return { type: "res", ok: true, payload };
      },
    },
    upsert: async () => ({ recorded: true }),
    // The card the closed socket recorded, open: closed by it.
    settle: async () => ({ outcome: "settled" }),
    currentMessageId: () => (rm.turnActive ? rm.currentMessageId : null),
    noteQuestion: (id, expiresInSec) => rm.noteHumanQuestion(id, expiresInSec, clock()),
    noteQuestionSettled: (id) => rm.noteHumanQuestionSettled(id, clock()),
    noteApprovalSettled: (id, generation) => rm.noteApprovalSettled(id, clock(), generation),
    noteApprovalRequested: (id, facts) => rm.noteApprovalRequested(id, facts, clock()),
    wake: () => {},
    nowMs: () => EPOCH_MS,
  });
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe("a resumed turn is held by its run's approval, though the replay listed it first", () => {
  it("the replay ends before the resume: the resumed turn is held — labelled, no silence at 241 s — until the approval's own deadline", async () => {
    const w = new FakeWriter();
    const rm = new RunManager("c1", KEY, w);
    let now = 1_000;
    const obs = observerFor(rm, () => now, [waiting]);
    // The reconnection's replay answers first: no turn here yet.
    await obs.replayPending();
    await flush();
    expect(rm.turnActive).toBe(false);
    // …then `/resume` puts the run's turn back.
    await rm.resumeTurn(now, "bubbleA", "runA");
    expect(w.phases).toContainEqual(["bubbleA", "awaiting_approval"]);
    // Past the 240 s silence budget: still held, no silence recovery asked for.
    now += BASE_RECV_TIMEOUT + 1;
    await rm.tick(now);
    expect(rm.takeRecvSilence()).toBe(false);
    expect(w.finals).toEqual([]);
    // Up to the approval's own deadline (+ the delivery margin)…
    now = 1_000 + LEFT + APPROVAL_WAIT_MARGIN - 1;
    await rm.tick(now);
    expect(w.finals).toEqual([]);
    // …then a NAMED end, as for any approval that ran out.
    now = 1_000 + LEFT + APPROVAL_WAIT_MARGIN + 1;
    await rm.tick(now);
    expect(w.finals).toEqual([["bubbleA", expect.any(String), "awaiting_approval"]]);
  });

  it("an approval decided before the resume does not hold the turn", async () => {
    const w = new FakeWriter();
    const rm = new RunManager("c1", KEY, w);
    let now = 1_000;
    const obs = observerFor(rm, () => now, [waiting]);
    await obs.replayPending();
    await flush();
    await obs.observe(execApprovalResolvedFrame(waiting));
    await flush();
    await rm.resumeTurn(now, "bubbleA", "runA");
    expect(w.phases).not.toContainEqual(["bubbleA", "awaiting_approval"]);
    now += BASE_RECV_TIMEOUT + 1;
    await rm.tick(now);
    expect(rm.takeRecvSilence(), "an ordinary silence, nothing waits on a person").toBe(true);
  });

  it("an approval decided while the replay's list was on the wire is never held again — not by that list, nor by the resume", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const w = new FakeWriter();
      const rm = new RunManager("c1", KEY, w);
      let now = 1_000;
      let answerList: () => void = () => {};
      const listGate = new Promise<void>((r) => (answerList = r));
      const methods: string[] = [];
      const obs = observerFor(rm, () => now, [waiting], { listGate, failApprovalGet: true, methods });
      // The reconnection's replay asks for the lists; the gateway is slow to answer.
      const replay = obs.replayPending();
      await vi.advanceTimersByTimeAsync(0);
      // Meanwhile the approval is decided: its one resolution reaches this socket first,
      // before any generation of its id was announced here.
      await obs.observe(execApprovalResolvedFrame(waiting));
      await vi.advanceTimersByTimeAsync(0);
      // The list, read before the decision, answers now — still naming it pending: that entry
      // IS the decided request (its generation found), not one to read or to wait on.
      answerList();
      await replay;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(methods.filter((m) => m === "approval.get")).toEqual([]);
      // `/resume` puts the run's turn back: nothing waits on a person.
      await rm.resumeTurn(now, "bubbleA", "runA");
      expect(w.phases).not.toContainEqual(["bubbleA", "awaiting_approval"]);
      now += BASE_RECV_TIMEOUT + 1;
      await rm.tick(now);
      expect(rm.takeRecvSilence(), "an ordinary silence at 241 s, not a held turn").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("…nor by that list while a turn is active", async () => {
    const w = new FakeWriter();
    const rm = new RunManager("c1", KEY, w);
    let now = 1_000;
    let answerList: () => void = () => {};
    const listGate = new Promise<void>((r) => (answerList = r));
    const obs = observerFor(rm, () => now, [waiting], { listGate, failApprovalGet: true });
    await rm.resumeTurn(now, "bubbleA", "runA");
    const replay = obs.replayPending();
    await flush();
    await obs.observe(execApprovalResolvedFrame(waiting));
    await flush();
    answerList();
    await replay;
    await flush();
    expect(w.phases).not.toContainEqual(["bubbleA", "awaiting_approval"]);
    now += BASE_RECV_TIMEOUT + 1;
    await rm.tick(now);
    expect(rm.takeRecvSilence()).toBe(true);
  });

  it("…nor when its id was announced here first, its card write failing, the list's read failing too", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const w = new FakeWriter();
      const rm = new RunManager("c1", KEY, w);
      let now = 1_000;
      const methods: string[] = [];
      const gw: { listGate?: Promise<void>; failApprovalGet?: boolean; methods?: string[] } = { failApprovalGet: true, methods };
      const obs = observerFor(rm, () => now, [waiting], gw);
      // Its broadcast, with no turn here: kept for the turn that resumes its run; its card
      // write fails (every read does).
      await obs.observe(execApprovalRequestedFrame(waiting));
      await vi.advanceTimersByTimeAsync(5_000);
      // The reconnection's replay asks for the lists, slow to answer; the resolution comes.
      let answerList: () => void = () => {};
      gw.listGate = new Promise<void>((r) => (answerList = r));
      const replay = obs.replayPending();
      await vi.advanceTimersByTimeAsync(0);
      await obs.observe(execApprovalResolvedFrame(waiting));
      await vi.advanceTimersByTimeAsync(0);
      // The list still names it; its read fails again, every attempt.
      answerList();
      await replay;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(methods.filter((m) => m === "approval.get").length).toBeGreaterThan(3);
      await rm.resumeTurn(now, "bubbleA", "runA");
      expect(w.phases).not.toContainEqual(["bubbleA", "awaiting_approval"]);
      now += BASE_RECV_TIMEOUT + 1;
      await rm.tick(now);
      expect(rm.takeRecvSilence(), "an ordinary silence at 241 s, not a held turn").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("another run's approval does not hold the turn resumed for this run", async () => {
    const w = new FakeWriter();
    const rm = new RunManager("c1", KEY, w);
    const now = 1_000;
    const obs = observerFor(rm, () => now, [{ ...waiting, runId: "runOld" }]);
    await obs.replayPending();
    await flush();
    await rm.resumeTurn(now, "bubbleA", "runA");
    expect(w.phases).not.toContainEqual(["bubbleA", "awaiting_approval"]);
  });
});

// A reused id is ANOTHER request: the gateway takes an explicit approval id from its caller
// (src/gateway/server-methods/exec-approval.ts:172, 292-298 at v2026.9.36) and may give it
// again once it has forgotten the old one. The new request carries another generation
// (`createdAtMs`), and no mark of the old one blocks it (approval-identity.ts).
describe("a new generation of an id is never blocked by the old one's decision", () => {
  /** A — decided — then B under the same id, 300 s later, on the run that resumes. */
  const LEFT_A = 300;
  const first: ApprovalIds = { ...waiting, createdAtMs: EPOCH_MS + LEFT_A * 1000 - 1_800_000 };
  const second: ApprovalIds = {
    ...waiting,
    runId: "runB",
    toolCallId: "tool_call:call_b:exec:1",
    createdAtMs: EPOCH_MS + LEFT * 1000 - 1_800_000,
  };

  it("A resolved with no turn active, then B under the same id: B holds its resumed turn until its own deadline", async () => {
    const w = new FakeWriter();
    const rm = new RunManager("c1", KEY, w);
    let now = 1_000;
    const pending: ApprovalIds[] = [first];
    const obs = observerFor(rm, () => now, pending);
    await obs.observe(execApprovalRequestedFrame(first));
    await flush();
    await obs.observe(execApprovalResolvedFrame(first));
    await flush();
    // The gateway forgets A and gives its id to B.
    pending.splice(0, pending.length, second);
    await obs.observe(execApprovalRequestedFrame(second));
    await flush();
    // A late repeat of A's decision (an answer given here, a duplicate broadcast) is A's.
    await rm.noteApprovalSettled(first.approvalId, now, first.createdAtMs!);
    await rm.resumeTurn(now, "bubbleB", "runB");
    expect(w.phases).toContainEqual(["bubbleB", "awaiting_approval"]);
    // Past the 240 s silence budget, with 600 s left to B: held, not a lost run.
    now += BASE_RECV_TIMEOUT + 1;
    await rm.tick(now);
    expect(rm.takeRecvSilence()).toBe(false);
    expect(w.finals).toEqual([]);
    // …until B's own deadline (+ the delivery margin).
    now = 1_000 + LEFT + APPROVAL_WAIT_MARGIN + 1;
    await rm.tick(now);
    expect(w.finals).toEqual([["bubbleB", expect.any(String), "awaiting_approval"]]);
  });

  it("…and on a turn active throughout: A decided, then B under the same id on that run holds it again", async () => {
    const w = new FakeWriter();
    const rm = new RunManager("c1", KEY, w);
    let now = 1_000;
    const onThisRun: ApprovalIds = { ...second, runId: "runA" };
    const pending: ApprovalIds[] = [first];
    const obs = observerFor(rm, () => now, pending);
    await rm.resumeTurn(now, "bubbleA", "runA");
    await obs.observe(execApprovalRequestedFrame(first));
    await flush();
    await obs.observe(execApprovalResolvedFrame(first));
    await flush();
    expect(w.phases.at(-1)).toEqual(["bubbleA", "generating"]);
    pending.splice(0, pending.length, onThisRun);
    await obs.observe(execApprovalRequestedFrame(onThisRun));
    await flush();
    expect(w.phases.at(-1)).toEqual(["bubbleA", "awaiting_approval"]);
    now += BASE_RECV_TIMEOUT + 1;
    await rm.tick(now);
    expect(rm.takeRecvSilence()).toBe(false);
    // A late repeat of A's decision does not release B.
    await rm.noteApprovalSettled(first.approvalId, now, first.createdAtMs!);
    now += 60;
    await rm.tick(now);
    expect(w.phases.at(-1)).not.toEqual(["bubbleA", "generating"]);
    expect(rm.takeRecvSilence()).toBe(false);
  });
});

describe("a decision that names no generation is about the one waiting", () => {
  it("an answer without its generation releases the request kept for the resumed turn", async () => {
    const w = new FakeWriter();
    const rm = new RunManager("c1", KEY, w);
    const now = 1_000;
    await rm.noteApprovalRequested(
      waiting.approvalId,
      { kind: "exec", runId: "runA", toolCallId: waiting.toolCallId, expiresInSec: LEFT, generation: waiting.createdAtMs! },
      now,
    );
    await rm.noteApprovalSettled(waiting.approvalId, now, null);
    await rm.resumeTurn(now, "bubbleA", "runA");
    expect(w.phases).not.toContainEqual(["bubbleA", "awaiting_approval"]);
  });
});
