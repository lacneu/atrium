// The plan stamp's UNIT. The normalizer's clock counts SECONDS and is NOT
// monotonic — it reads the wall clock (src/session.ts `Clock`, and the limits
// listed in convex/lib/planOrder.ts) — and the stamp lives in the same field
// for every producer. A sink-side fallback on `Date.now()` — milliseconds — would put an
// unstamped producer's part ~1000x ahead of every real one and pin it as "the
// current plan" forever (codex). No stamp is the safe answer: the part then
// orders by arrival, exactly as it did before stamps existed.
import { describe, expect, it } from "vitest";
import { TurnSink } from "../src/core/turn-sink.js";
import type { ConvexWriter, FinalizeStatus } from "../src/convex-writer.js";
import type { PlanPart } from "../src/core/plan-part.js";

class PlanWriter implements ConvexWriter {
  planParts: PlanPart[] = [];
  async startAssistant(): Promise<string> {
    return "msg_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addPlanPart(_messageId: string, part: PlanPart): Promise<void> {
    this.planParts.push(part);
  }
  async addToolPart(): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async finalize(
    _m: string,
    _s: FinalizeStatus,
    _t: string,
    _e: string | null = null,
  ): Promise<void> {}
  async getRehydrationContext(): Promise<{
    history: string | null;
    turnCount: number;
  }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

describe("a plan from a producer that carries no receive stamp", () => {
  it("is written WITHOUT a stamp — never with the sink's millisecond clock", async () => {
    const writer = new PlanWriter();
    const sink = new TurnSink("chat_units", writer);
    await sink.beginTurn("webchat-units");
    await sink.apply([
      {
        type: "plan",
        plan: { kind: "plan", steps: [{ step: "a", status: "pending" }] },
      },
      { type: "message.final", text: "done" },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.planParts).toHaveLength(1);
    expect(writer.planParts[0]?.stamp).toBeUndefined();
  });

  it("keeps a receive stamp when the producer supplies one, in ITS unit", async () => {
    const writer = new PlanWriter();
    const sink = new TurnSink("chat_units2", writer);
    await sink.beginTurn("webchat-units2");
    await sink.apply([
      {
        type: "plan",
        recvAt: 1_788_581_688.302,
        plan: { kind: "plan", steps: [{ step: "a", status: "pending" }] },
      },
      { type: "message.final", text: "done" },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.planParts[0]?.stamp).toBe(1_788_581_688.302);
  });
});
