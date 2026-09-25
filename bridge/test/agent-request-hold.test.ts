// A TURN HELD BY A HUMAN is not a silent turn.
//
// Prod 2026-09-22 (ataraxis, denis): the agent called `ask_user` at 20:42:28. Atrium
// could not show the question, so nobody answered; the gateway waited its 15 minutes
// (`embedded-question-broker.ts:115`) — and our own clocks declared the turn dead long
// before: 240 s of silence, a 6.5 min transcript recovery, then a false
// `response_timeout` at 20:52:59, over a run that resumed at 20:59.
//
// These drive the normalizer the way the session does: the question arrives from
// OUTSIDE the frame stream (`question.requested` is a broadcast), through
// `noteQuestionRequested`, and the turn's clocks must bow to it exactly as they do to
// an approval — with one difference: the question's expiry is not a verdict.
import { describe, expect, it } from "vitest";
import {
  BASE_RECV_TIMEOUT,
  HUMAN_WAIT_BEAT,
  QUESTION_WAIT_MARGIN,
  Normalizer,
} from "../src/providers/openclaw/normalizer.js";
import type { BridgeEvent } from "../src/core/events.js";

const SESSION_KEY = "agent:denis:atrium:chat:denis:c1";
const RUN = "webchat-run-1";

function startTurn() {
  const n = new Normalizer(SESSION_KEY);
  let now = 1000;
  n.beginTurn(now);
  n.noteRunStarted(RUN, now);
  return {
    n,
    at: (t: number) => (now = 1000 + t),
  };
}

const phases = (events: BridgeEvent[]) =>
  events.filter((e) => e.type === "turn.phase").map((e) => (e as { phase?: string }).phase);
const finals = (events: BridgeEvent[]) =>
  events.filter((e) => e.type === "message.final" || e.type === "run.status");

function lifecycle(data: Record<string, unknown>) {
  return { event: "agent", payload: { runId: RUN, sessionKey: SESSION_KEY, stream: "lifecycle", data } };
}

function approval(phase: "requested" | "resolved", ids: { toolCallId?: string; approvalId?: string }) {
  return {
    event: "agent",
    payload: { runId: RUN, sessionKey: SESSION_KEY, stream: "approval", data: { phase, ...ids } },
  };
}

describe("a question put to a person holds the turn", () => {
  it("the silence clock stops: no recovery at 240 s, nor at 12 minutes", () => {
    const { n, at } = startTurn();
    const asked = n.noteQuestionRequested("ask_1", 900, at(5));
    expect(phases(asked)).toEqual(["awaiting_input"]);
    expect(n.recvDeadlineArmed, "a turn waiting on a human is not silent").toBe(false);
    for (const t of [BASE_RECV_TIMEOUT + 10, 400, 720]) {
      const ev = n.tick(at(t));
      expect(finals(ev)).toEqual([]);
    }
    expect(n.finalized).toBe(false);
    expect(n.takeRecvSilence?.() ?? false).toBe(false);
  });

  it("the finishing promise is borrowed, not spent", () => {
    // `finishing -> ask_user`: without the hold, the 60 s grace would settle the turn
    // as a success while the person is still being asked.
    const { n, at } = startTurn();
    n.feed(lifecycle({ phase: "finishing" }), at(1));
    n.noteQuestionRequested("ask_1", 900, at(2));
    expect(finals(n.tick(at(70)))).toEqual([]);
    expect(n.finalized).toBe(false);
    // …and given back when the question is answered.
    const back = n.noteQuestionSettled("ask_1", at(80));
    expect(phases(back)).toEqual(["generating"]);
    const closed = n.tick(at(80 + 61));
    expect(closed.some((e) => e.type === "message.final")).toBe(true);
  });

  it("the phase is re-published every minute — the streaming row's heartbeat", () => {
    const { n, at } = startTurn();
    n.noteQuestionRequested("ask_1", 900, at(0));
    expect(phases(n.tick(at(HUMAN_WAIT_BEAT)))).toEqual(["awaiting_input"]);
    expect(phases(n.tick(at(HUMAN_WAIT_BEAT * 2)))).toEqual(["awaiting_input"]);
  });

  it("an answer gives the ordinary budget back", () => {
    const { n, at } = startTurn();
    n.noteQuestionRequested("ask_1", 900, at(0));
    const answered = n.noteQuestionSettled("ask_1", at(30));
    expect(phases(answered)).toEqual(["generating"]);
    expect(n.recvDeadlineArmed).toBe(true);
    // …and stops the heartbeat: nothing is waiting any more.
    expect(phases(n.tick(at(30 + HUMAN_WAIT_BEAT)))).toEqual([]);
  });

  it("an EXPIRED question is not a verdict: the gateway unblocks and the agent carries on", () => {
    const { n, at } = startTurn();
    n.noteQuestionRequested("ask_1", 900, at(0));
    const past = n.tick(at(900 + QUESTION_WAIT_MARGIN + 1));
    expect(finals(past), "the turn must not be closed by the question's own deadline").toEqual([]);
    expect(phases(past)).toContain("generating");
    expect(n.finalized).toBe(false);
    expect(n.recvDeadlineArmed, "the ordinary budget restarts from here").toBe(true);
  });

  it("an unreadable deadline is bounded, never infinite", () => {
    const { n, at } = startTurn();
    n.noteQuestionRequested("ask_1", null, at(0));
    const timeout = n.nextTimeout(at(0));
    expect(timeout).not.toBeNull();
    expect(timeout!).toBeLessThanOrEqual(HUMAN_WAIT_BEAT);
  });

  it("a settle for a question this turn never saw changes nothing", () => {
    const { n, at } = startTurn();
    expect(n.noteQuestionSettled("never-asked", at(1))).toEqual([]);
    expect(n.recvDeadlineArmed).toBe(true);
  });
});

describe("questions and approvals share the hold", () => {
  it("the last approval answered while a question waits keeps the question's label and bound", () => {
    const { n, at } = startTurn();
    n.feed(approval("requested", { toolCallId: "tc-1", approvalId: "ap-1" }), at(1));
    n.noteQuestionRequested("ask_1", 900, at(2));
    const released = n.feed(approval("resolved", { toolCallId: "tc-1" }), at(3));
    expect(phases(released)).toEqual(["awaiting_input"]);
    // The approval's 600 s bound must be gone with it — it would otherwise close the
    // turn as `awaiting_approval` over a question still being asked.
    const later = n.tick(at(700));
    expect(finals(later)).toEqual([]);
    expect(n.finalized).toBe(false);
  });

  it("an approval answered from Atrium releases the turn by its approval id", () => {
    // An exec approval's allow is carried by a follow-up run, not by a `resolved` frame
    // on the run that asked: without this release the turn sat until approval_wait.
    const { n, at } = startTurn();
    n.feed(approval("requested", { toolCallId: "tc-1", approvalId: "ap-1" }), at(1));
    const released = n.noteApprovalSettled("ap-1", at(2));
    expect(phases(released)).toEqual(["generating"]);
    expect(n.recvDeadlineArmed).toBe(true);
    // Idempotent: the gateway's own `resolved` arriving after is a no-op.
    expect(n.noteApprovalSettled("ap-1", at(3))).toEqual([]);
  });
});
