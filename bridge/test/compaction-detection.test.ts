// Gateway compaction detection (Inc 1/2 of the gateway-observability initiative).
//
// Frame shapes are PINNED ON LIVE CAPTURE (2026-07-03, OpenClaw 2026.6.11,
// scratchpad compaction-checkpoint-fixture.json): a PREFLIGHT compaction leaves
// NO marker in the frame stream — the only observable signal is the session id
// ROTATION (pre-send describe sessionId "9629dc55…" vs run frames' payload
// .sessionId "f2591abe…", confirmed by the checkpoint's pre/postCompaction ids).
// A MID-TURN compaction surfaces as lifecycle end with livenessState "abandoned"
// (the pre-existing resetForCompaction path).

import { describe, expect, it } from "vitest";
import { Normalizer } from "../src/providers/openclaw/normalizer.js";
import type { BridgeEvent } from "../src/core/events.js";
import { TurnSink } from "../src/core/turn-sink.js";
import type {
  CompactionPart,
  ConvexWriter,
  FinalizeStatus,
} from "../src/convex-writer.js";

const SESSION_KEY = "agent:alice:atrium:chat:olivier:chatcompaction001";
const RUN = "webchat-compaction-run-1";
// Real ids from the live capture's checkpoint (pre/postCompaction).
const PRE_SESSION_ID = "9629dc55-ae59-4753-9656-dd1475814866";
const POST_SESSION_ID = "f2591abe-bcf6-4eb7-a568-c6472ab58483";

/** A lifecycle frame as captured live (payload.sessionId TOP-LEVEL). */
function lifecycleFrame(
  sessionId: string,
  data: Record<string, unknown>,
): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: RUN,
      sessionKey: SESSION_KEY,
      sessionId,
      agentId: "alice",
      stream: "lifecycle",
      data,
    },
  };
}

function assistantFrame(sessionId: string, text: string): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: RUN,
      sessionKey: SESSION_KEY,
      sessionId,
      stream: "assistant",
      data: { text, delta: text },
    },
  };
}

function startTurn(expected: string | null): Normalizer {
  const n = new Normalizer(SESSION_KEY);
  n.beginTurn(0);
  n.noteExpectedSessionId(expected);
  n.noteRunStarted(RUN, 0);
  return n;
}

function compactionEvents(events: BridgeEvent[]): BridgeEvent[] {
  return events.filter((e) => e.type === "context.compaction");
}

describe("compaction-by-rotation (preflight)", () => {
  it("rotated session id on the first own frame -> ONE preflight signal", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = [
      ...n.feed(lifecycleFrame(POST_SESSION_ID, { phase: "start" }), 1),
      ...n.feed(assistantFrame(POST_SESSION_ID, "Bonjour"), 2),
    ];
    const comp = compactionEvents(ev);
    expect(comp).toHaveLength(1);
    expect(comp[0]?.phase).toBe("preflight");
  });

  it("same session id -> no signal", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = [
      ...n.feed(lifecycleFrame(PRE_SESSION_ID, { phase: "start" }), 1),
      ...n.feed(assistantFrame(PRE_SESSION_ID, "Bonjour"), 2),
    ];
    expect(compactionEvents(ev)).toHaveLength(0);
  });

  it("no expectation seeded (fresh session / no describe) -> adopt silently", () => {
    const n = startTurn(null);
    const ev = [
      ...n.feed(lifecycleFrame(POST_SESSION_ID, { phase: "start" }), 1),
      ...n.feed(assistantFrame(POST_SESSION_ID, "Bonjour"), 2),
    ];
    expect(compactionEvents(ev)).toHaveLength(0);
  });

  it("signal fires at most once per turn (id keeps flapping)", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = [
      ...n.feed(assistantFrame(POST_SESSION_ID, "a"), 1),
      ...n.feed(assistantFrame(PRE_SESSION_ID, "b"), 2),
      ...n.feed(assistantFrame(POST_SESSION_ID, "c"), 3),
    ];
    expect(compactionEvents(ev)).toHaveLength(1);
  });

  it("frames without a sessionId never trigger (older gateways)", () => {
    const n = startTurn(PRE_SESSION_ID);
    const bare = {
      type: "event",
      event: "agent",
      payload: {
        runId: RUN,
        sessionKey: SESSION_KEY,
        stream: "assistant",
        data: { text: "x", delta: "x" },
      },
    };
    expect(compactionEvents(n.feed(bare, 1))).toHaveLength(0);
  });
});

describe("mid-turn compaction (livenessState abandoned)", () => {
  it("abandoned end -> ONE midturn signal; the follow-up rotation is suppressed", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev: BridgeEvent[] = [
      ...n.feed(assistantFrame(PRE_SESSION_ID, "partial"), 1),
      // The gateway abandons the run to compact (real midturn shape).
      ...n.feed(
        lifecycleFrame(PRE_SESSION_ID, {
          phase: "end",
          livenessState: "abandoned",
          replayInvalid: true,
        }),
        2,
      ),
      // The replay run arrives on the ROTATED id — same compaction, no 2nd signal.
      ...n.feed(assistantFrame(POST_SESSION_ID, "resumed"), 3),
    ];
    const comp = compactionEvents(ev);
    expect(comp).toHaveLength(1);
    expect(comp[0]?.phase).toBe("midturn");
  });

  it("a normal lifecycle end (working) never signals", () => {
    const n = startTurn(PRE_SESSION_ID);
    const ev = [
      ...n.feed(assistantFrame(PRE_SESSION_ID, "done"), 1),
      ...n.feed(
        lifecycleFrame(PRE_SESSION_ID, {
          phase: "end",
          stopReason: "stop",
          livenessState: "working",
        }),
        2,
      ),
    ];
    expect(compactionEvents(ev)).toHaveLength(0);
  });
});

// --- TurnSink: the signal becomes ONE persisted part + the pressure trace ----

type SinkCall =
  | ["addCompactionPart", string, string]
  | [
      "recordGatewayPressure",
      string,
      string,
      {
        totalTokens: number | null;
        contextTokens: number | null;
        compaction: string | null;
      },
    ]
  | ["finalize", string, FinalizeStatus];

class SinkFakeWriter implements ConvexWriter {
  readonly calls: SinkCall[] = [];
  async startAssistant(): Promise<string> {
    return "msg_compact_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<void> {}
  async addToolPart(): Promise<void> {}
  async addCompactionPart(
    messageId: string,
    part: CompactionPart,
  ): Promise<void> {
    this.calls.push(["addCompactionPart", messageId, part.phase]);
  }
  async recordGatewayPressure(
    chatId: string,
    messageId: string,
    data: {
      totalTokens: number | null;
      contextTokens: number | null;
      compaction: string | null;
    },
  ): Promise<void> {
    this.calls.push(["recordGatewayPressure", chatId, messageId, data]);
  }
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async finalize(messageId: string, status: FinalizeStatus): Promise<void> {
    this.calls.push(["finalize", messageId, status]);
  }
  async getRehydrationContext(): Promise<{
    history: string | null;
    turnCount: number;
  }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

async function settle(): Promise<void> {
  // recordGatewayPressure is fire-and-forget (void promise) — let it land.
  await new Promise((r) => setTimeout(r, 0));
}

describe("TurnSink compaction part + pressure trace", () => {
  it("context.compaction -> ONE compaction part; finalize ships the pressure trace with the phase", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_c1", writer);
    await sink.beginTurn(RUN, { totalTokens: 19698, contextTokens: 272000 });
    await sink.apply([
      { type: "context.compaction", phase: "preflight" },
      // A duplicate signal must not create a second part.
      { type: "context.compaction", phase: "preflight" },
      { type: "message.final", text: "ok" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    const parts = writer.calls.filter((c) => c[0] === "addCompactionPart");
    expect(parts).toHaveLength(1);
    expect(parts[0]?.[2]).toBe("preflight");
    const traces = writer.calls.filter(
      (c) => c[0] === "recordGatewayPressure",
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]?.[3]).toEqual({
      totalTokens: 19698,
      contextTokens: 272000,
      costUsd: null, // pressure seeded without a cost in this fixture
      compaction: "preflight",
      errorKind: null, // no hard overflow this turn (compaction handled it)
    });
  });

  it("no compaction -> no part; the trace still records the fill counters", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_c2", writer);
    await sink.beginTurn(RUN, { totalTokens: 1000, contextTokens: 272000 });
    await sink.apply([
      { type: "message.final", text: "ok" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    expect(
      writer.calls.filter((c) => c[0] === "addCompactionPart"),
    ).toHaveLength(0);
    const traces = writer.calls.filter(
      (c) => c[0] === "recordGatewayPressure",
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]?.[3].compaction).toBeNull();
  });

  it("no pressure AND no compaction (legacy path) -> no trace at all", async () => {
    const writer = new SinkFakeWriter();
    const sink = new TurnSink("chat_c3", writer);
    await sink.beginTurn(RUN);
    await sink.apply([
      { type: "message.final", text: "ok" },
      { type: "run.status", status: "final" },
    ]);
    await settle();
    expect(
      writer.calls.filter((c) => c[0] === "recordGatewayPressure"),
    ).toHaveLength(0);
  });
});
