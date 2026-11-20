/**
 * A model fallback is shown on the bubble of the run it is about.
 *
 * The frames, verbatim from the bench (run 2026-11-07T18-04-14-703Z, scenario
 * `lifecycle-error-fallback-probe`, gateway 2026.9.36), free text masked:
 *   - `lifecycle` `fallback` arrived 67 ms AFTER the run's `lifecycle end` and
 *     `chat final`, with the run's seq back at 1 and no `agentId`;
 *   - `lifecycle` `fallback_cleared` arrived the same way on the next run;
 *   - `lifecycle` `fallback_step` precedes them inside the run.
 * `stream:"fallback"` (the Codex harness's provider reroute) was never captured: its frame
 * is built from `handleModelRerouted`
 * (extensions/codex/src/app-server/event-projector-events.ts).
 *
 * The reading is the Control UI's `handleLifecycleFallbackEvent`
 * (ui/src/pages/chat/tool-stream-status.ts): "Fallback active: {active}", "Fallback
 * cleared: {selected}", nothing when the two names are equal, nothing for a step.
 */

import { describe, expect, it } from "vitest";

import { HttpConvexWriter, type ConvexWriter, type ToolPart } from "../src/convex-writer.js";
import { modelFallbackFromFrame } from "../src/providers/openclaw/model-fallback.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";

const SK = "agent:alice:atrium:chat:u-repro:turn-nx79mkhktt778b53ksc5p0gfqx8hrk98";
const RUN = "webchat-34a22df1907f603c485a6c9ba6786784b8651b3e66d887368baa3eae3a89f539";
const NEXT_RUN = "webchat-5c0a0537d50d4f355e8cf96b2f51f088148172ef1ac7215607e5e617cca3cd48";

/** Verbatim, envelope seq 155; `reasonSummary`, `attemptSummaries` and `error` masked. */
const FALLBACK = {
  type: "event",
  event: "agent",
  payload: {
    runId: RUN,
    sessionKey: SK,
    stream: "lifecycle",
    data: {
      phase: "fallback",
      selectedProvider: "openai",
      selectedModel: "gpt-5.5",
      activeProvider: "openai",
      activeModel: "gpt-6.1-sol",
      reasonSummary: "<text>",
      attemptSummaries: ["<text>"],
      attempts: [
        {
          provider: "openai",
          model: "gpt-5.5",
          error: "<text>",
          reason: "model_not_found",
          status: 404,
          code: "model_not_found",
        },
      ],
    },
    seq: 1,
    ts: 1794075482583,
  },
  seq: 155,
};

/** Verbatim, envelope seq 21 of the next run. */
const CLEARED = {
  type: "event",
  event: "agent",
  payload: {
    runId: NEXT_RUN,
    sessionKey: SK,
    stream: "lifecycle",
    data: {
      phase: "fallback_cleared",
      selectedProvider: "openai",
      selectedModel: "gpt-6.1-sol",
      activeProvider: "openai",
      activeModel: "gpt-6.1-sol",
      previousActiveModel: "openai/gpt-6.1-sol",
    },
    seq: 1,
    ts: 1794075508066,
  },
  seq: 21,
};

/** Verbatim keys, envelope seq 152 (the failure detail masked). */
const STEP = {
  type: "event",
  event: "agent",
  payload: {
    runId: RUN,
    sessionKey: SK,
    stream: "lifecycle",
    data: {
      phase: "fallback_step",
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: "openai/gpt-5.5",
      fallbackStepToModel: "openai/gpt-6.1-sol",
      fallbackStepFromFailureReason: "model_not_found",
      fallbackStepFromFailureDetail: "<text>",
      fallbackStepChainPosition: 2,
      fallbackStepFinalOutcome: "succeeded",
    },
    seq: 28,
  },
  seq: 152,
};

/** Source-derived: the Codex harness's `handleModelRerouted`. */
const rerouted = (runId: string, data: Record<string, unknown>) => ({
  type: "event" as const,
  event: "agent",
  payload: { runId, sessionKey: SK, stream: "fallback", data },
});

const lifecycle = (runId: string, data: Record<string, unknown>) => ({
  type: "event" as const,
  event: "agent",
  payload: { runId, sessionKey: SK, agentId: "alice", stream: "lifecycle", data },
});
const chat = (runId: string, state: "delta" | "final", text: string, extra: Record<string, unknown> = {}) => ({
  type: "event" as const,
  event: "chat",
  payload: {
    runId,
    sessionKey: SK,
    state,
    message: { role: "assistant", content: [{ type: "text", text, ...extra }] },
  },
});

describe("reading the frame (the Control UI's rule)", () => {
  it("the captured fallback names the active model, and the one that was selected", () => {
    expect(modelFallbackFromFrame(FALLBACK, SK)).toStrictEqual({
      runId: RUN,
      state: "active",
      model: "openai/gpt-6.1-sol",
      selected: "openai/gpt-5.5",
    });
  });

  it("the captured clearing names the selected model", () => {
    expect(modelFallbackFromFrame(CLEARED, SK)).toStrictEqual({
      runId: NEXT_RUN,
      state: "cleared",
      model: "openai/gpt-6.1-sol",
    });
  });

  it("…the SELECTED one, also when the frame still names another active model", () => {
    // Shape-faithful, not captured: the Control UI prints `selected` for a clearing
    // whatever `active` says.
    const stillOther = structuredClone(CLEARED);
    stillOther.payload.data.selectedModel = "gpt-5.5";
    expect(modelFallbackFromFrame(stillOther, SK)).toStrictEqual({
      runId: NEXT_RUN,
      state: "cleared",
      model: "openai/gpt-5.5",
    });
  });

  it("a step of the chain is not a fallback notice", () => {
    expect(modelFallbackFromFrame(STEP, SK)).toBeNull();
    // …by its phase, not by what it happens to lack: a step naming both models
    // (shape-faithful, not captured) is still only a step.
    const named = structuredClone(STEP) as { payload: { data: Record<string, unknown> } };
    Object.assign(named.payload.data, {
      selectedProvider: "openai",
      selectedModel: "gpt-5.5",
      activeProvider: "openai",
      activeModel: "gpt-6.1-sol",
    });
    expect(modelFallbackFromFrame(named, SK)).toBeNull();
  });

  it("a fallback whose selected and active names are equal says nothing", () => {
    const same = structuredClone(FALLBACK);
    same.payload.data.activeModel = "gpt-5.5";
    expect(modelFallbackFromFrame(same, SK)).toBeNull();
    // …also when one side already carries its provider.
    same.payload.data.activeModel = "OpenAI/gpt-5.5";
    same.payload.data.selectedProvider = "OpenAI";
    same.payload.data.activeProvider = "OpenAI";
    expect(modelFallbackFromFrame(same, SK)).toBeNull();
  });

  it("the Codex harness's reroute reads from/to", () => {
    expect(
      modelFallbackFromFrame(rerouted(RUN, { fromModel: "gpt-6.1", toModel: "gpt-6.1-mini", reason: "<text>" }), SK),
    ).toStrictEqual({ runId: RUN, state: "active", model: "gpt-6.1-mini", selected: "gpt-6.1" });
  });

  it("nothing leaves but model names: no reason, no attempt, no error text", () => {
    const withProse = structuredClone(FALLBACK);
    withProse.payload.data.reasonSummary = "SECRET provider prose";
    withProse.payload.data.attempts[0]!.error = "SECRET provider error";
    expect(JSON.stringify(modelFallbackFromFrame(withProse, SK))).not.toContain("SECRET");
    expect(
      JSON.stringify(modelFallbackFromFrame(rerouted(RUN, { fromModel: "a", toModel: "b", reason: "SECRET" }), SK)),
    ).not.toContain("SECRET");
  });

  it("a frame that names no model, no run, another session, or a name too long says nothing", () => {
    const noActive = structuredClone(FALLBACK) as { payload: { data: Record<string, unknown> } };
    delete noActive.payload.data.activeModel;
    expect(modelFallbackFromFrame(noActive, SK)).toBeNull();
    const noRun = structuredClone(FALLBACK) as { payload: Record<string, unknown> };
    delete noRun.payload.runId;
    expect(modelFallbackFromFrame(noRun, SK)).toBeNull();
    expect(modelFallbackFromFrame(FALLBACK, "agent:bob:atrium:chat:other")).toBeNull();
    const long = structuredClone(FALLBACK);
    long.payload.data.activeModel = "m".repeat(400);
    expect(modelFallbackFromFrame(long, SK)).toBeNull();
    expect(modelFallbackFromFrame(lifecycle(RUN, { phase: "end" }), SK)).toBeNull();
    expect(modelFallbackFromFrame(chat(RUN, "final", "x"), SK)).toBeNull();
  });
});

type Noted = {
  runId: string;
  messageId: string | null;
  sessionKey: string | null;
  state: string;
  model: string;
  selected?: string;
};

class FallbackWriter implements ConvexWriter {
  readonly noted: Noted[] = [];
  readonly opened: (string | null)[] = [];
  readonly finals: string[] = [];
  readonly lateFinals: string[] = [];
  private n = 0;
  async startAssistant(_chatId: string, runId: string | null): Promise<string> {
    this.opened.push(runId);
    return `msg_${++this.n}`;
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(_m: string, _p: ToolPart): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async noteFrameGap(): Promise<void> {}
  async noteModelFallback(_chatId: string, data: Noted): Promise<void> {
    this.noted.push({ ...data });
  }
  async appendLateFinal(args: { messageId: string | null; text: string }): Promise<string | null> {
    this.lateFinals.push(args.text);
    return args.messageId;
  }
  async finalize(messageId: string, status: string): Promise<void> {
    this.finals.push(`${messageId}:${status}`);
  }
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

async function settle(writer: FallbackWriter, finals: number): Promise<void> {
  for (let i = 0; i < 40 && writer.finals.length < finals; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The captured order of the run's last frames: end, final, THEN the fallback. */
async function runThenLateFallback(writer: FallbackWriter): Promise<RunManager> {
  const manager = new RunManager("chat-f7", SK, writer);
  manager.setGatewayVersionSource(() => "2026.9.36");
  await manager.beginTurn(1_000, RUN, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
  await manager.feed(lifecycle(RUN, { phase: "start", startedAt: 1 }), 1_010);
  await manager.feed(STEP, 1_015);
  await manager.feed(lifecycle(RUN, { phase: "end", stopReason: "stop", livenessState: "working" }), 1_020);
  await manager.feed(chat(RUN, "final", "BENCH_FALLBACK_OK"), 1_021);
  await settle(writer, 1);
  await manager.feed(FALLBACK, 1_022);
  return manager;
}

describe("a fallback that follows its run's terminal (the captured order)", () => {
  it("lands on that run's bubble, by its run", async () => {
    const writer = new FallbackWriter();
    await runThenLateFallback(writer);
    expect(writer.noted).toStrictEqual([
      {
        runId: RUN,
        messageId: "msg_1",
        sessionKey: SK,
        state: "active",
        model: "openai/gpt-6.1-sol",
        selected: "openai/gpt-5.5",
      },
    ]);
  });

  it("reopens nothing: no second bubble, no second terminal", async () => {
    const writer = new FallbackWriter();
    await runThenLateFallback(writer);
    await new Promise((r) => setTimeout(r, 20));
    expect(writer.opened).toStrictEqual([RUN]);
    expect(writer.finals).toStrictEqual(["msg_1:complete"]);
  });

  it("still lands on its own run's bubble when the NEXT turn is already running", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-f7", SK, writer);
    await manager.beginTurn(1_000, RUN, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(chat(RUN, "final", "BENCH_FALLBACK_OK"), 1_010);
    await settle(writer, 1);
    await manager.beginTurn(2_000, NEXT_RUN, { expectedSessionId: null, dispatchOutboxId: "ob-2" });
    await manager.feed(chat(NEXT_RUN, "delta", "REPLAY"), 2_010);
    await manager.feed(FALLBACK, 2_020);
    expect(writer.noted.map((n) => `${n.runId}→${n.messageId}`)).toStrictEqual([`${RUN}→msg_1`]);
    // …and the running turn is untouched: it ends on its own terminal, on its own bubble.
    await manager.feed(chat(NEXT_RUN, "final", "REPLAY_OK"), 2_030);
    await settle(writer, 2);
    expect(writer.finals).toStrictEqual(["msg_1:complete", "msg_2:complete"]);
  });

  it("the clearing lands on the run that carries it", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-f7", SK, writer);
    await manager.beginTurn(1_000, NEXT_RUN, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(chat(NEXT_RUN, "final", "REPLAY_OK"), 1_010);
    await settle(writer, 1);
    await manager.feed(CLEARED, 1_020);
    expect(writer.noted).toStrictEqual([
      { runId: NEXT_RUN, messageId: "msg_1", sessionKey: SK, state: "cleared", model: "openai/gpt-6.1-sol" },
    ]);
  });

  it("a run this bridge holds no bubble for is left to Convex to find, by its run", async () => {
    // A restart between the terminal and the frame, or a bubble the transcript made.
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-f7", SK, writer);
    await manager.feed(FALLBACK, 1_000);
    expect(writer.noted).toStrictEqual([
      {
        runId: RUN,
        messageId: null,
        sessionKey: SK,
        state: "active",
        model: "openai/gpt-6.1-sol",
        selected: "openai/gpt-5.5",
      },
    ]);
    // It opened no turn of its own.
    expect(writer.opened).toStrictEqual([]);
  });

  it("the same frame delivered twice writes the same marker twice — Convex keeps one", async () => {
    const writer = new FallbackWriter();
    const manager = await runThenLateFallback(writer);
    await manager.feed(FALLBACK, 1_030);
    expect(writer.noted.map((n) => n.messageId)).toStrictEqual(["msg_1", "msg_1"]);
  });
});

describe("a fallback stated while its run is the live turn's", () => {
  it("waits for the bubble, then lands on it — and the turn goes on", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-f7", SK, writer);
    await manager.beginTurn(1_000, RUN, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(lifecycle(RUN, { phase: "start", startedAt: 1 }), 1_010);
    await manager.feed(rerouted(RUN, { fromModel: "gpt-6.1", toModel: "gpt-6.1-mini" }), 1_020);
    expect(writer.noted, "no bubble yet: nothing written").toStrictEqual([]);
    await manager.feed(chat(RUN, "delta", "Bonjour"), 1_030);
    expect(writer.noted).toStrictEqual([
      { runId: RUN, messageId: "msg_1", sessionKey: SK, state: "active", model: "gpt-6.1-mini", selected: "gpt-6.1" },
    ]);
    await manager.feed(chat(RUN, "final", "Bonjour."), 1_040);
    await settle(writer, 1);
    expect(writer.finals).toStrictEqual(["msg_1:complete"]);
  });

  it("a silent turn that never opens a bubble writes no marker", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-f7", SK, writer);
    await manager.beginTurn(1_000, "announce:v1:agent:alice:subagent:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222", {
      expectedSessionId: null,
      spontaneous: true,
    });
    const ANNOUNCE = "announce:v1:agent:alice:subagent:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    await manager.feed(rerouted(ANNOUNCE, { fromModel: "a", toModel: "b" }), 1_010);
    await manager.feed(chat(ANNOUNCE, "final", "NO_REPLY"), 1_020);
    await new Promise((r) => setTimeout(r, 20));
    expect(writer.noted).toStrictEqual([]);
  });
});

describe("the gateway's own notice text is a separate fact", () => {
  it("the late notice final still reaches the late-final path, untouched by this change", async () => {
    // Captured right after the fallback frame (envelope seq 156): a second `chat final`
    // whose only block is marked `openclawStatusNotice`.
    const writer = new FallbackWriter();
    const manager = await runThenLateFallback(writer);
    await manager.feed(
      chat(RUN, "final", "↪️ Model Fallback: openai/gpt-6.1-sol (selected openai/gpt-5.5; <text>)", {
        openclawStatusNotice: true,
      }),
      1_030,
    );
    expect(writer.lateFinals).toHaveLength(1);
    expect(writer.noted).toHaveLength(1);
  });
});

describe("the writer posts it by run (writer → Convex)", () => {
  it("posts `modelFallback`, with the bubble only when it knows one", async () => {
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
    await w.noteModelFallback("c1", {
      runId: RUN,
      messageId: "m1",
      sessionKey: SK,
      state: "active",
      model: "openai/gpt-6.1-sol",
      selected: "openai/gpt-5.5",
    });
    await w.noteModelFallback("c1", {
      runId: NEXT_RUN,
      messageId: null,
      sessionKey: null,
      state: "cleared",
      model: "openai/gpt-6.1-sol",
    });
    expect(sent).toStrictEqual([
      {
        op: "modelFallback",
        chatId: "c1",
        runId: RUN,
        messageId: "m1",
        sessionKey: SK,
        state: "active",
        model: "openai/gpt-6.1-sol",
        selected: "openai/gpt-5.5",
      },
      { op: "modelFallback", chatId: "c1", runId: NEXT_RUN, state: "cleared", model: "openai/gpt-6.1-sol" },
    ]);
  });
});
