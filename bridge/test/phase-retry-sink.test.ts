// THE SINK HOP OF THE BACK-OFF COUNTER.
//
// The lot was described as "proven per hop" while this hop had no test at all, and a
// review said so. That mattered: the very next hop down (convertConvexMessage) was
// dropping the counter outright, and nothing in the suite could see it because every
// test either stopped above this line or started below it.
//
// What the sink owes: forward `retry` ALONGSIDE the phase, and forward nothing when
// the event does not carry one — a phase that invents a counter is worse than a phase
// without one.

import { describe, expect, it } from "vitest";
import type { ConvexWriter } from "../src/convex-writer.js";
import { TurnSink } from "../src/core/turn-sink.js";

type PhaseCall = {
  phase: string;
  retry?: { attempt: number; maxAttempts: number };
  onlyIfRetrying?: boolean;
};

class PhaseWriter implements ConvexWriter {
  calls: PhaseCall[] = [];
  /** Phases whose POST should report failure, by name — lets a test make the scoped
   *  clear fail exactly once. */
  failPhases = new Set<string>();
  async startAssistant(): Promise<string> {
    return "msg_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addPlanPart(): Promise<void> {}
  async addToolPart(): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async finalize(): Promise<void> {}
  async heartbeat(): Promise<void> {}
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionRoster(): Promise<void> {}
  async reportSessionMeta(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  emitRehydrateTrace(): void {}
  async setPhase(
    _messageId: string,
    phase: string,
    retry?: { attempt: number; maxAttempts: number },
    onlyIfRetrying?: boolean,
  ): Promise<boolean> {
    // The fourth argument is CAPTURED. The earlier fake took three, so the scoped-clear
    // flag could be dropped at the sink, in the writer's payload or in the ingest op and
    // every test stayed green — a whole chain with no proof behind it (raised in review).
    this.calls.push({
      phase,
      ...(retry ? { retry } : {}),
      ...(onlyIfRetrying === undefined ? {} : { onlyIfRetrying }),
    });
    if (this.failPhases.has(phase)) {
      this.failPhases.delete(phase);
      return false;
    }
    return true;
  }
}

async function phasesFor(events: Array<Record<string, unknown>>): Promise<PhaseCall[]> {
  const writer = new PhaseWriter();
  const sink = new TurnSink("chat_retry", writer);
  await sink.beginTurn("webchat-retry");
  await sink.apply([
    ...events,
    { type: "message.final", text: "done" },
    { type: "run.status", status: "final" },
  ] as never);
  return writer.calls;
}

describe("the sink carries the back-off counter with its phase", () => {
  it("forwards attempt and maxAttempts to setPhase", async () => {
    const calls = await phasesFor([
      { type: "turn.phase", phase: "retrying", retry: { attempt: 2, maxAttempts: 10 } },
    ]);
    expect(calls).toContainEqual({
      phase: "retrying",
      retry: { attempt: 2, maxAttempts: 10 },
      onlyIfRetrying: false,
    });
  });

  it("forwards NO counter when the event carries none", async () => {
    const calls = await phasesFor([{ type: "turn.phase", phase: "post_processing" }]);
    const call = calls.find((c) => c.phase === "post_processing");
    expect(call).toBeDefined();
    expect(call?.retry).toBeUndefined();
  });

  it("refuses a malformed counter rather than passing it on", async () => {
    // The event shape is permissive by design (`{type} + arbitrary fields`), so the
    // sink is the boundary: a half-built counter must not reach a mutation that would
    // store it and a label that would render "2/undefined".
    const bad = [
      { attempt: 2 }, // half-built
      "2/10", // not an object
      { attempt: -1, maxAttempts: 0 }, // out of the contract's 1..10
      { attempt: 2.5, maxAttempts: 10 }, // not an integer
      { attempt: 9, maxAttempts: 2 }, // attempt beyond the bound
    ];
    const calls = await phasesFor(
      bad.map((retry) => ({ type: "turn.phase", phase: "retrying", retry })),
    );
    const retrying = calls.filter((c) => c.phase === "retrying");
    // COUNT first: the earlier version filtered and then asserted over the survivors,
    // so an implementation that dropped the events entirely passed just as well
    // (raised in review). The phase must still be forwarded — only the counter dies.
    expect(retrying).toHaveLength(bad.length);
    for (const call of retrying) expect(call.retry).toBeUndefined();
  });

  it("carries the SCOPED-clear flag, so the clear cannot widen on the way down", async () => {
    const calls = await phasesFor([
      { type: "turn.phase", phase: "generating", onlyIfRetrying: true },
    ]);
    expect(calls).toContainEqual({ phase: "generating", onlyIfRetrying: true });
  });

  it("…and does not invent the flag on an ordinary phase", async () => {
    // `generating` without the flag is Hermes' resume signal and legitimately clears
    // whatever phase is stored. Sending the flag there would silently narrow it.
    const calls = await phasesFor([{ type: "turn.phase", phase: "generating" }]);
    const call = calls.find((c) => c.phase === "generating");
    expect(call?.onlyIfRetrying).toBe(false);
  });

  it("re-sends a back-off clear whose write did not land", async () => {
    // The normalizer consumes its own flag when it emits the clear, so a lost POST was
    // never retried and "retrying 2/10" stayed on screen for the rest of the turn
    // (raised in review). The re-send rides the next phase event: one extra request
    // after a failure, none at all otherwise.
    const writer = new PhaseWriter();
    writer.failPhases.add("generating");
    const sink = new TurnSink("chat_owed", writer);
    await sink.beginTurn("webchat-owed");
    await sink.apply([
      { type: "turn.phase", phase: "generating", onlyIfRetrying: true },
      { type: "turn.phase", phase: "post_processing" },
      { type: "message.final", text: "done" },
      { type: "run.status", status: "final" },
    ] as never);
    const scoped = writer.calls.filter(
      (c) => c.phase === "generating" && c.onlyIfRetrying === true,
    );
    expect(scoped).toHaveLength(2);
  });

  it("…and does not re-send one that DID land", async () => {
    const writer = new PhaseWriter();
    const sink = new TurnSink("chat_ok", writer);
    await sink.beginTurn("webchat-ok");
    await sink.apply([
      { type: "turn.phase", phase: "generating", onlyIfRetrying: true },
      { type: "turn.phase", phase: "post_processing" },
      { type: "message.final", text: "done" },
      { type: "run.status", status: "final" },
    ] as never);
    const scoped = writer.calls.filter(
      (c) => c.phase === "generating" && c.onlyIfRetrying === true,
    );
    expect(scoped).toHaveLength(1);
  });
});
