// WHY a foreign-run refusal happened has to survive the turn sink.
//
// The normalizer has always counted refusals BY REASON (normalizer.test.ts pins
// that map). The turn sink then summed it to one number before the trace, so the
// operator surface could say "21 frames were refused" and nothing else.
//
// Those 21 are two opposite facts. An announce chain, a task delivery or a
// heartbeat is its own turn: refusing it is the guard stopping someone else's
// text from closing the user's turn, and a session with twenty sub-agents makes
// dozens. A `no_grace` refusal is a frame this turn could have used. Production,
// 2026-09-20: a turn ended `empty_final_timeout` carrying exactly that number,
// and the chat contained BOTH shapes — so the trace raised the alarm and then
// could not answer it.

import { describe, expect, it } from "vitest";

import type { ConvexWriter, ToolPart } from "../src/convex-writer.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";

const SK = "agent:main:atrium:chat:u-test:c-1";
const OWN = "webchat-own-run";

class TraceWriter implements ConvexWriter {
  readonly pressures: Record<string, unknown>[] = [];
  async startAssistant(): Promise<string> {
    return "msg_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(_m: string, _p: ToolPart): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(
    _chatId: string,
    _messageId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.pressures.push(data);
  }
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async noteFrameGap(): Promise<void> {}
  async finalize(): Promise<void> {}
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async reportSessionRoster(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  async emitRehydrateTrace(): Promise<void> {}
}

const chatFinal = (runId: string, text: string) => ({
  type: "event" as const,
  event: "chat",
  payload: {
    runId,
    sessionKey: SK,
    state: "final",
    message: { role: "assistant", content: [{ type: "text", text }] },
  },
});

const heartbeat = (runId: string) => ({
  type: "event" as const,
  event: "agent",
  payload: { runId, sessionKey: SK, isHeartbeat: true, stream: "lifecycle", data: {} },
});

describe("the gateway-pressure trace carries WHY a foreign run was refused", () => {
  it("keeps the reasons, and the total still equals their sum", async () => {
    const writer = new TraceWriter();
    const manager = new RunManager("chat-1", SK, writer);
    await manager.beginTurn(1000, OWN);
    // A heartbeat run and a gateway-minted inject run, both refused.
    await manager.feed(heartbeat("hb-1"), 1010);
    await manager.feed(chatFinal("inject-abc", "not your answer"), 1020);
    await manager.feed(chatFinal(OWN, "the real answer"), 1100);
    await new Promise((r) => setTimeout(r, 0)); // the trace is fire-and-forget

    expect(writer.pressures).toHaveLength(1);
    const p = writer.pressures[0]!;
    const by = p.foreignRunRefusalCounts as Record<string, number> | undefined;
    expect(by, "the reason map must reach the trace").toBeDefined();
    // The two families are DISTINGUISHABLE — that is the whole point.
    expect(Object.keys(by!).sort()).toEqual(["gateway_initiated", "heartbeat"]);
    // …and the number that already existed is still the sum of them, so nothing
    // downstream that reads only the total changes meaning.
    const sum = Object.values(by!).reduce((n, v) => n + v, 0);
    expect(p.foreignRunsRefused).toBe(sum);
  });

  it("a turn with NOTHING to report writes no trace at all — absent is not zero", async () => {
    // Written as an assertion about the SINK, not about the fields: a clean turn
    // with no pressure signal of any kind emits no record, so "no refusals" reads
    // as no record rather than as a record saying zero. A reader counting traces
    // must not mistake silence for a measured zero, and the surface that reads
    // `foreignRunsRefused` must treat its absence the same way.
    const writer = new TraceWriter();
    const manager = new RunManager("chat-2", SK, writer);
    await manager.beginTurn(1000, OWN);
    await manager.feed(chatFinal(OWN, "clean"), 1100);
    await new Promise((r) => setTimeout(r, 0));

    expect(writer.pressures).toEqual([]);
  });
});

// WHY the counters are null (prod 2026-10-01: 3 of 4 `chat.gateway_pressure` traces with
// null pressure, read by the watcher agent as lost telemetry). A gateway-initiated run —
// requester-settle, a talk consult — opens with no pre-send describe and the gateway
// stamps no usage on its agent events: its counters are null by construction, and the
// trace now says so, with who started the turn.
describe("the gateway-pressure trace says where its counters came from", () => {
  const finalWithStop = (runId: string) => ({
    type: "event" as const,
    event: "chat",
    payload: {
      runId,
      sessionKey: SK,
      state: "final",
      stopReason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: "delivered" }] },
    },
  });

  it("a gateway-initiated turn: no describe, so `absent` / `gateway_initiated` — never backfilled", async () => {
    const writer = new TraceWriter();
    const manager = new RunManager("chat-3", SK, writer);
    // A dispatched turn first, WITH pressure: its figures must not leak into the next.
    await manager.beginTurn(1000, OWN, {
      expectedSessionId: null,
      pressure: { totalTokens: 5_000, contextTokens: 100_000, fillPct: 5, fillSource: "counter" },
      dispatchOutboxId: "ob-1",
    });
    await manager.feed(finalWithStop(OWN), 1100);
    const settle = "announce:requester-settle:abc";
    // No turn is active: the run manager opens the SPONTANEOUS turn itself, as it
    // does for a requester-settle delivery in production.
    await manager.feed(finalWithStop(settle), 2100);
    for (let i = 0; i < 20 && writer.pressures.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(writer.pressures).toHaveLength(2);
    expect(writer.pressures[0]).toMatchObject({
      pressureSource: "presend_describe",
      turnOrigin: "dispatch",
      totalTokens: 5_000,
    });
    expect(writer.pressures[1]).toMatchObject({
      pressureSource: "absent",
      turnOrigin: "gateway_initiated",
      totalTokens: null,
      contextTokens: null,
    });
    expect(writer.pressures[1]?.fillPct).toBeUndefined();
  });
});
