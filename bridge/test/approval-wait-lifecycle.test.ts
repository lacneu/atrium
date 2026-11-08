// THE RUN WAITS ON AN APPROVAL (F5) — UNTIL THE REQUEST'S OWN DEADLINE (N3). Lot « trames 1 ».
//
// F5. On 2026.9.36 an exec that needs an approval keeps its run and says so on the run's
// OWN lifecycle: `waiting-approval` then `approval-resolved`, `{approvalId, toolCallId}`
// (src/agents/bash-tools.exec-host-gateway.ts:1313-1337). The Control UI keys its "waiting
// for approval" state on these (ui/src/pages/chat/tool-stream-status.ts:357-380). Atrium
// listened to `stream:"approval"` alone — never emitted in any capture from 7.1 to 9.36 —
// so the turn was never labelled and its silence clock kept running. The frames below are
// the captured ones (helpers/approval-frames-2026.9.36.ts: bench GO 2026-11-02T22-06-41-810Z).
//
// N3. The wait was capped at 600 s by Atrium; the gateway keeps an exec approval for 30 min
// by default (src/infra/exec-approvals-core.ts:296) and every request carries its own
// deadline (`expiresAtMs`, captured: createdAtMs + 1 800 000). The bound now follows it.
import { describe, expect, it } from "vitest";

import {
  APPROVAL_WAIT_DEFAULT,
  APPROVAL_WAIT_MARGIN,
  BASE_RECV_TIMEOUT,
  HUMAN_WAIT_BEAT,
  Normalizer,
} from "../src/providers/openclaw/normalizer.js";
import type { BridgeEvent } from "../src/core/events.js";
import { approvalLifecycleFrame, type ApprovalIds } from "./helpers/approval-frames-2026.9.36.js";

const IDS: ApprovalIds = {
  sessionKey: "agent:alice:atrium:chat:u-repro:turn-1",
  runId: "webchat-abce0715",
  approvalId: "a4111261-c014-4dbd-807b-f38febaaf53d",
  toolCallId: "tool_call:call_d18f:exec:1",
};

function startTurn() {
  const n = new Normalizer(IDS.sessionKey);
  const t0 = 1000;
  n.beginTurn(t0);
  n.noteRunStarted(IDS.runId, t0);
  return { n, at: (s: number) => t0 + s };
}

const phases = (events: BridgeEvent[]) =>
  events.filter((e) => e.type === "turn.phase").map((e) => (e as { phase?: string }).phase);
const closed = (events: BridgeEvent[]) => events.some((e) => e.type === "message.final");

describe("F5 — the run's own `waiting-approval` holds the turn", () => {
  it("labels the turn, stops the silence clock, and heartbeats while a person decides", () => {
    const { n, at } = startTurn();
    const asked = n.feed(approvalLifecycleFrame(IDS, "waiting-approval"), at(1));
    expect(phases(asked)).toEqual(["awaiting_approval"]);
    expect(n.recvDeadlineArmed, "a turn waiting on a human is not silent").toBe(false);
    // The streaming row's heartbeat: the phase again every minute.
    expect(phases(n.tick(at(1 + HUMAN_WAIT_BEAT)))).toEqual(["awaiting_approval"]);
    // Past the 240 s silence budget, past Convex's 12 min watchdog, past the old 10 min
    // cap: still waiting, nothing closed.
    for (const s of [BASE_RECV_TIMEOUT + 30, 12 * 60 + 5, 600 + 5, 29 * 60]) {
      expect(closed(n.tick(at(s)))).toBe(false);
    }
    expect(n.finalized).toBe(false);
    expect(n.takeRecvSilence()).toBe(false);
  });

  it("`approval-resolved` gives the turn back to its ordinary clock", () => {
    const { n, at } = startTurn();
    n.feed(approvalLifecycleFrame(IDS, "waiting-approval"), at(1));
    const back = n.feed(approvalLifecycleFrame(IDS, "approval-resolved", 14), at(7));
    expect(phases(back)).toEqual(["generating"]);
    expect(n.recvDeadlineArmed).toBe(true);
    // Nothing waits any more: no heartbeat, and the approval bound is gone with it.
    expect(phases(n.tick(at(7 + HUMAN_WAIT_BEAT)))).toEqual([]);
    expect(closed(n.tick(at(APPROVAL_WAIT_DEFAULT + APPROVAL_WAIT_MARGIN + 10)))).toBe(false);
  });

  it("its broadcast twin answering first leaves the frame nothing to do (no second release)", () => {
    const { n, at } = startTurn();
    n.feed(approvalLifecycleFrame(IDS, "waiting-approval"), at(1));
    // `exec.approval.resolved` reaches the observer → noteApprovalSettled by approval id.
    expect(phases(n.noteApprovalSettled(IDS.approvalId, at(6)))).toEqual(["generating"]);
    expect(phases(n.feed(approvalLifecycleFrame(IDS, "approval-resolved", 14), at(6.01)))).toEqual([]);
  });

  it("a frame naming no approval holds nothing (the Control UI ignores it too)", () => {
    const { n, at } = startTurn();
    const frame = approvalLifecycleFrame(IDS, "waiting-approval") as { payload: { data: Record<string, unknown> } };
    delete frame.payload.data.approvalId;
    expect(phases(n.feed(frame, at(1)))).toEqual([]);
    expect(n.recvDeadlineArmed).toBe(true);
  });
});

describe("N3 — the wait follows the request's own deadline", () => {
  it("unknown deadline: the gateway's default (30 min) plus the delivery margin, then a NAMED end", () => {
    const { n, at } = startTurn();
    n.feed(approvalLifecycleFrame(IDS, "waiting-approval"), at(0));
    const bound = APPROVAL_WAIT_DEFAULT + APPROVAL_WAIT_MARGIN;
    expect(closed(n.tick(at(bound - 1)))).toBe(false);
    const ev = n.tick(at(bound + 1));
    expect(ev.find((e) => e.type === "message.final")).toMatchObject({
      errorKind: "awaiting_approval",
      diagnosticFinalizeCause: "approval_timeout",
    });
  });

  it("the deadline the request announced replaces the default — a SHORTER one included", () => {
    const { n, at } = startTurn();
    // The broadcast first (it precedes the run's frame on the socket): 120 s left.
    n.noteApprovalRequested(
      IDS.approvalId,
      { kind: "exec", runId: IDS.runId, toolCallId: IDS.toolCallId, expiresInSec: 120 },
      at(0),
    );
    n.feed(approvalLifecycleFrame(IDS, "waiting-approval"), at(0.1));
    expect(closed(n.tick(at(120 + APPROVAL_WAIT_MARGIN - 1)))).toBe(false);
    expect(closed(n.tick(at(120 + APPROVAL_WAIT_MARGIN + 1)))).toBe(true);
  });

  it("a deadline LATER than the default is honoured too (an operator's longer timeout)", () => {
    const { n, at } = startTurn();
    n.feed(approvalLifecycleFrame(IDS, "waiting-approval"), at(0));
    n.noteApprovalRequested(
      IDS.approvalId,
      { kind: "exec", runId: IDS.runId, toolCallId: IDS.toolCallId, expiresInSec: 2 * 3600, hold: false },
      at(1),
    );
    expect(closed(n.tick(at(APPROVAL_WAIT_DEFAULT + APPROVAL_WAIT_MARGIN + 60)))).toBe(false);
    expect(closed(n.tick(at(1 + 2 * 3600 + APPROVAL_WAIT_MARGIN + 1)))).toBe(true);
  });
});

describe("the request itself, read off its broadcast or the pending list", () => {
  it("an exec request naming THIS turn's run holds it — the reconnection case, no lifecycle frame", () => {
    const { n, at } = startTurn();
    const ev = n.noteApprovalRequested(
      IDS.approvalId,
      { kind: "exec", runId: IDS.runId, toolCallId: IDS.toolCallId, expiresInSec: 1700 },
      at(1),
    );
    expect(phases(ev)).toEqual(["awaiting_approval"]);
    expect(n.recvDeadlineArmed).toBe(false);
  });

  it("…and with its lifecycle frame after it, it is ONE request, not two", () => {
    const { n, at } = startTurn();
    n.noteApprovalRequested(
      IDS.approvalId,
      { kind: "exec", runId: IDS.runId, toolCallId: IDS.toolCallId, expiresInSec: 1700 },
      at(1),
    );
    expect(phases(n.feed(approvalLifecycleFrame(IDS, "waiting-approval"), at(1.1)))).toEqual([]);
    // One release frees the turn: had it been counted twice, the turn would still wait.
    expect(phases(n.feed(approvalLifecycleFrame(IDS, "approval-resolved", 14), at(5)))).toEqual(["generating"]);
    expect(n.recvDeadlineArmed).toBe(true);
  });

  it("a request on ANOTHER run of the session does not hold this turn", () => {
    const { n, at } = startTurn();
    const ev = n.noteApprovalRequested(
      IDS.approvalId,
      { kind: "exec", runId: "cron-run-9", toolCallId: IDS.toolCallId, expiresInSec: 1700 },
      at(1),
    );
    expect(phases(ev)).toEqual([]);
    expect(n.recvDeadlineArmed).toBe(true);
  });

  it("a request already decided is never held again (a list read just before the answer)", () => {
    const { n, at } = startTurn();
    n.noteApprovalSettled(IDS.approvalId, at(1));
    const ev = n.noteApprovalRequested(
      IDS.approvalId,
      { kind: "exec", runId: IDS.runId, toolCallId: IDS.toolCallId, expiresInSec: 1700 },
      at(2),
    );
    expect(phases(ev)).toEqual([]);
    expect(n.recvDeadlineArmed).toBe(true);
  });
});

describe("a run's own frame names no generation: it is about the one announced (approval-identity.ts)", () => {
  const GA = 1_793_658_291_732;
  it("the frame of a request already decided does not hold the turn", () => {
    const { n, at } = startTurn();
    n.noteApprovalRequested(
      IDS.approvalId,
      { kind: "exec", runId: "cron-run-9", toolCallId: IDS.toolCallId, expiresInSec: 1700, generation: GA },
      at(1),
    );
    n.noteApprovalSettled(IDS.approvalId, at(2), GA);
    expect(phases(n.feed(approvalLifecycleFrame(IDS, "waiting-approval"), at(3)))).toEqual([]);
    expect(n.recvDeadlineArmed).toBe(true);
  });

  it("…while the frame of a NEW generation under the same id does, its request announced first", () => {
    const { n, at } = startTurn();
    n.noteApprovalSettled(IDS.approvalId, at(1), GA);
    const reused = { ...IDS, toolCallId: "tool_call:call_e:exec:2" };
    n.noteApprovalRequested(
      reused.approvalId,
      { kind: "exec", runId: "cron-run-9", toolCallId: reused.toolCallId, expiresInSec: 1700, generation: GA + 300_000 },
      at(2),
    );
    expect(phases(n.feed(approvalLifecycleFrame(reused, "waiting-approval"), at(3)))).toEqual(["awaiting_approval"]);
    expect(n.recvDeadlineArmed).toBe(false);
  });
});
