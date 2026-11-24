/**
 * The gateway's `seq gap` report is not a frame lost on the way to Atrium.
 *
 * Single writer: the gateway's agent-event handler (src/gateway/server-chat.ts, the
 * `last > 0 && evt.seq !== last + 1` branch, v2026.8.2 to v2026.9.36) compares the seq of
 * the event it is handling with the last one IT handled for that run, and broadcasts
 * `{stream:"error", data:{reason:"seq gap", expected: last + 1, received: evt.seq}}`. That
 * seq is the runtime's per-run emission counter (src/infra/agent-events.ts), which also
 * counts emissions this handler never sees. Both counters live inside the gateway: the
 * report says nothing about the socket. A frame lost to a client leaves a hole in the
 * per-connection ENVELOPE seq (src/gateway/server-broadcast.ts), a different counter. The
 * Control UI never reads the report.
 *
 * Atrium counted each report as a lost frame of the turn: `framesLost` on the pressure
 * trace (which nothing else ever fed) and an `openclaw.frame_gap` trace.
 *
 * The first frame below is verbatim from the bench (run 2026-11-02T22-06-41-810Z); the
 * whole corpus holds 805 such frames in 35 runs and every one has received = expected − 1.
 * The `received > expected` shape is upstream's own unit-test shape, never captured.
 */

import { describe, expect, it } from "vitest";

import { HttpConvexWriter, type ConvexWriter, type ToolPart } from "../src/convex-writer.js";
import { Normalizer } from "../src/providers/openclaw/normalizer.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";

const SK = "agent:alice:atrium:chat:u-repro:turn-nx770ygwmrbryqgw9pnc2s45ex8hej9k";
const RUN = "69758b77-b176-47da-b2d3-e195b38980c6";

/** Verbatim (bench run 2026-11-02T22-06-41-810Z, envelope seq 262). */
const CAPTURED = {
  type: "event",
  event: "agent",
  payload: {
    runId: RUN,
    stream: "error",
    ts: 1793657792110,
    sessionKey: SK,
    isHeartbeat: false,
    data: { reason: "seq gap", expected: 12, received: 11 },
  },
  seq: 262,
};

const report = (runId: string, expected: unknown, received: unknown) => ({
  type: "event" as const,
  event: "agent",
  payload: {
    runId,
    stream: "error",
    ts: 0,
    sessionKey: SK,
    isHeartbeat: false,
    data: { reason: "seq gap", expected, received },
  },
});

const chat = (runId: string, state: "delta" | "final", text: string) => ({
  type: "event" as const,
  event: "chat",
  payload: {
    runId,
    sessionKey: SK,
    state,
    message: { role: "assistant", content: [{ type: "text", text }] },
  },
});

describe("the normalizer reports it as what it is", () => {
  function open(): Normalizer {
    const n = new Normalizer(SK);
    n.beginTurn(1_000);
    n.noteRunStarted(RUN, 1_001);
    return n;
  }

  it("the captured frame is a sequence report, not a frame gap", () => {
    const events = open().feed(CAPTURED as never, 1_002);
    expect(events.filter((e) => e.type === "frame.gap")).toStrictEqual([]);
    const reports = events.filter((e) => e.type === "gateway.seq_report");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ expected: 12, received: 11, runId: RUN });
    // …and it still fails nothing.
    expect(events.some((e) => e.type === "run.status" || e.type === "message.final")).toBe(false);
  });

  it("the report is attributed to the run the FRAME names", () => {
    // A turn adopts a second run only on the gateway's word — here an overflow replay it
    // announced (`compaction end willRetry:true`). The first run's report, arriving after
    // the turn moved on, is still the first run's.
    const n = open();
    const compaction = (data: Record<string, unknown>) => ({
      type: "event",
      event: "agent",
      payload: { runId: RUN, sessionKey: SK, stream: "compaction", data },
    });
    n.feed(compaction({ phase: "start" }) as never, 1_002);
    n.feed(
      compaction({ phase: "end", completed: true, willRetry: true, outcome: "completed" }) as never,
      1_003,
    );
    const SECOND = "8d1f5a60-3a55-4c0c-9d3e-0f6f3a6f8f21";
    n.feed(
      {
        type: "event",
        event: "agent",
        payload: { runId: SECOND, sessionKey: SK, stream: "lifecycle", data: { phase: "start" } },
      } as never,
      1_004,
    );
    expect(n.ownRunIds.has(SECOND), "the second run is part of the turn").toBe(true);
    const reports = n
      .feed(report(RUN, 7, 6) as never, 1_005)
      .filter((e) => e.type === "gateway.seq_report");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ expected: 7, received: 6, runId: RUN });
  });

  it("a report that names no run is attributed to none, not to the last run seen", () => {
    const n = open();
    n.feed(chat(RUN, "delta", "Bonjour") as never, 1_002);
    const anonymous = {
      type: "event",
      event: "agent",
      payload: {
        stream: "error",
        ts: 0,
        sessionKey: SK,
        data: { reason: "seq gap", expected: 4, received: 3 },
      },
    };
    const reports = n.feed(anonymous as never, 1_003).filter((e) => e.type === "gateway.seq_report");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ expected: 4, received: 3, runId: null });
  });

  it("counters that are not numbers are carried as unknown, never guessed", () => {
    const events = open().feed(report(RUN, "12", null) as never, 1_002);
    const reports = events.filter((e) => e.type === "gateway.seq_report");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ expected: null, received: null, runId: RUN });
  });
});

type SeqCall = { expected: number | null; received: number | null; runId: string | null; messageId: string | null };

class ReportWriter implements ConvexWriter {
  readonly reports: SeqCall[] = [];
  readonly gaps: unknown[] = [];
  readonly pressures: Record<string, unknown>[] = [];
  async startAssistant(): Promise<string> {
    return "msg_seq_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(_m: string, _p: ToolPart): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(_c: string, _m: string, data: Record<string, unknown>): Promise<void> {
    this.pressures.push(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
  }
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async noteFrameGap(_c: string, data: unknown): Promise<void> {
    this.gaps.push(data);
  }
  async noteGatewaySeqReport(
    _chatId: string,
    data: { expected: number | null; received: number | null; runId: string | null },
    messageId?: string | null,
  ): Promise<void> {
    this.reports.push({ ...data, messageId: messageId ?? null });
  }
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

const PRESSURE = {
  totalTokens: 40_000,
  contextTokens: 272_000,
  fillPct: 15,
  fillSource: "gateway_estimate" as const,
  model: "gpt-5.5",
};

async function settled(writer: ReportWriter): Promise<void> {
  for (let i = 0; i < 40 && writer.pressures.length < 1; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("the turn says how many reports it saw, and loses no frame for them (sink → writer)", () => {
  async function turn(frames: unknown[], withPressure = true): Promise<ReportWriter> {
    const writer = new ReportWriter();
    const manager = new RunManager("chat-f6", SK, writer);
    manager.setGatewayVersionSource(() => "2026.9.36");
    let now = 1_000;
    await manager.beginTurn(now, RUN, {
      expectedSessionId: null,
      ...(withPressure ? { pressure: PRESSURE } : {}),
      dispatchOutboxId: "ob-1",
    });
    for (const f of frames) await manager.feed(f, (now += 10));
    await new Promise((r) => setTimeout(r, 0));
    return writer;
  }

  it("a duplicate-seq report (every captured one) is no lost frame", async () => {
    const writer = await turn([
      chat(RUN, "delta", "Voici"),
      CAPTURED,
      report(RUN, 13, 12),
      chat(RUN, "final", "Voici le résultat."),
    ]);
    await settled(writer);
    expect(writer.gaps).toStrictEqual([]);
    expect(writer.reports).toStrictEqual([
      { expected: 12, received: 11, runId: RUN, messageId: "msg_seq_1" },
      { expected: 13, received: 12, runId: RUN, messageId: "msg_seq_1" },
    ]);
    expect(writer.pressures).toHaveLength(1);
    expect(Object.hasOwn(writer.pressures[0]!, "framesLost")).toBe(false);
    expect(writer.pressures[0]).toMatchObject({ gatewaySeqReports: 2 });
  });

  it("a report that skips ahead is no lost frame either", async () => {
    // Upstream's own test shape (expected 2, received 5): the handler did not see three
    // of the runtime's emissions. Nothing was dropped on the client's socket.
    const writer = await turn([
      chat(RUN, "delta", "Voici"),
      report(RUN, 2, 5),
      chat(RUN, "final", "Voici le résultat."),
    ]);
    await settled(writer);
    expect(writer.gaps).toStrictEqual([]);
    expect(Object.hasOwn(writer.pressures[0]!, "framesLost")).toBe(false);
    expect(writer.pressures[0]).toMatchObject({ gatewaySeqReports: 1 });
    expect(writer.reports).toStrictEqual([
      { expected: 2, received: 5, runId: RUN, messageId: "msg_seq_1" },
    ]);
  });

  it("a turn with no report carries no such counter", async () => {
    const writer = await turn([chat(RUN, "final", "Voici le résultat.")]);
    await settled(writer);
    expect(Object.hasOwn(writer.pressures[0]!, "gatewaySeqReports")).toBe(false);
  });

  it("reports alone do not force a pressure trace: they are not a loss to explain", async () => {
    const writer = await turn(
      [chat(RUN, "delta", "Voici"), CAPTURED, chat(RUN, "final", "Voici le résultat.")],
      false,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(writer.reports).toHaveLength(1);
    expect(writer.pressures).toStrictEqual([]);
  });
});

describe("the writer posts it under its own name (writer → Convex)", () => {
  it("posts `gatewaySeqReportTrace` with the run the report names", async () => {
    const sent: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init: { body: unknown }) => {
      sent.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const w = new HttpConvexWriter({
      convexHttpActionsUrl: "http://test.invalid",
      ingestSecret: "s",
      fetchImpl,
    });
    await w.noteGatewaySeqReport("c1", { expected: 12, received: 11, runId: RUN }, "m1");
    await w.noteGatewaySeqReport("c1", { expected: null, received: null, runId: null });
    expect(sent).toStrictEqual([
      { op: "gatewaySeqReportTrace", chatId: "c1", messageId: "m1", runId: RUN, expected: 12, received: 11 },
      { op: "gatewaySeqReportTrace", chatId: "c1" },
    ]);
  });

  it("an envelope hole still posts `frameGapTrace`, at chat level", async () => {
    const sent: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init: { body: unknown }) => {
      sent.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const w = new HttpConvexWriter({
      convexHttpActionsUrl: "http://test.invalid",
      ingestSecret: "s",
      fetchImpl,
    });
    await w.noteFrameGap("c1", { source: "envelope", expected: 5, received: 7, missing: 2 });
    expect(sent).toStrictEqual([
      { op: "frameGapTrace", chatId: "c1", source: "envelope", expected: 5, received: 7, missing: 2 },
    ]);
  });
});
