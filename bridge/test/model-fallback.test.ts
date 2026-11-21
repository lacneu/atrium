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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConvexIngestError, HttpConvexWriter, type ConvexWriter, type ToolPart } from "../src/convex-writer.js";
import { modelFallbackFromFrame } from "../src/providers/openclaw/model-fallback.js";
import { protocolDrift } from "../src/providers/openclaw/protocol-drift.js";
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

/** Records the writes and answers like Convex: the bubble named, else the run's own
 *  bubble, else null — it never makes one. */
class FallbackWriter implements ConvexWriter {
  readonly noted: Noted[] = [];
  readonly marked: (string | null)[] = [];
  /** What actually landed on a bubble, in order (an attempt that found none is absent). */
  readonly effects: string[] = [];
  readonly notices: { runId: string; messageId: string | null; text: string }[] = [];
  readonly opened: (string | null)[] = [];
  readonly finals: string[] = [];
  readonly lateFinals: string[] = [];
  private readonly bubbleOfRun = new Map<string, string>();
  private n = 0;
  async startAssistant(_chatId: string, runId: string | null): Promise<string> {
    this.opened.push(runId);
    const id = `msg_${++this.n}`;
    if (runId !== null) this.bubbleOfRun.set(runId, id);
    return id;
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
  /** Writes that fail before any succeeds (a Convex write that timed out). */
  failWrites = 0;
  async noteModelFallback(_chatId: string, data: Noted): Promise<string | null> {
    this.noted.push({ ...data });
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("ingest timed out");
    }
    const bubble = data.messageId ?? this.bubbleOfRun.get(data.runId) ?? null;
    this.marked.push(bubble);
    if (bubble !== null) this.effects.push(`fallback ${data.state} ${data.model} → ${bubble}`);
    return bubble;
  }
  async noteGatewayNotice(
    _chatId: string,
    data: { runId: string; messageId: string | null; sessionKey: string | null; text: string },
  ): Promise<string | null> {
    this.notices.push({ runId: data.runId, messageId: data.messageId, text: data.text });
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("ingest timed out");
    }
    const bubble = data.messageId ?? this.bubbleOfRun.get(data.runId) ?? null;
    if (bubble !== null) this.effects.push(`notice ${data.text} → ${bubble}`);
    return bubble;
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
    // A second delivery is a second frame (its own object), as the socket hands it.
    await manager.feed(structuredClone(FALLBACK), 1_030);
    await manager.runFactsIdle();
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

describe("a fallback that PRECEDES its run's bubble", () => {
  it("the answer and its fallback race the chat.send ACK: the marker lands once the bubble exists", async () => {
    // Reproduced by the review: both frames arrive between `chat.send` and its ACK. The
    // answer waits in the pre-ACK buffer; the fallback was read at once, found no bubble,
    // and was gone when the replay created the answer.
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-f7", SK, writer);
    manager.armReplayBuffer();
    await manager.feed(chat(RUN, "final", "BENCH_FALLBACK_OK"), 1_000);
    await manager.feed(FALLBACK, 1_001);
    expect(writer.marked.filter((m) => m !== null), "no bubble yet").toStrictEqual([]);
    await manager.beginTurn(1_010, RUN, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await settle(writer, 1);
    for (let i = 0; i < 40 && !writer.marked.includes("msg_1"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(writer.finals).toStrictEqual(["msg_1:complete"]);
    expect(writer.opened).toStrictEqual([RUN]);
    expect(writer.noted.at(-1)).toStrictEqual({
      runId: RUN,
      messageId: "msg_1",
      sessionKey: SK,
      state: "active",
      model: "openai/gpt-6.1-sol",
      selected: "openai/gpt-5.5",
    });
    expect(writer.marked.at(-1)).toBe("msg_1");
  });

  it("a fallback read before any turn of its run is kept for that run only", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-f7", SK, writer);
    await manager.feed(FALLBACK, 1_000);
    // Another run's turn settles: the held fallback is not its to carry.
    await manager.beginTurn(1_010, NEXT_RUN, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(chat(NEXT_RUN, "final", "REPLAY_OK"), 1_020);
    await settle(writer, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(writer.marked.filter((m) => m !== null)).toStrictEqual([]);
    // Its own run's turn settles: now it lands.
    await manager.beginTurn(2_000, RUN, { expectedSessionId: null, dispatchOutboxId: "ob-2" });
    await manager.feed(chat(RUN, "final", "BENCH_FALLBACK_OK"), 2_010);
    await settle(writer, 2);
    for (let i = 0; i < 40 && !writer.marked.includes("msg_2"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(writer.noted.at(-1)).toMatchObject({ runId: RUN, messageId: "msg_2" });
  });

  it("a fallback of a run the turn ADOPTED lands on that turn's bubble", async () => {
    // The turn moved to a second run on the gateway's word (an announced overflow
    // replay); the bubble still carries the first run's id. The bridge knows which
    // bubble the adopted run wrote into: the frames say it.
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-f7", SK, writer);
    const ADOPTED = "8d1f5a60-3a55-4c0c-9d3e-0f6f3a6f8f21";
    const compaction = (data: Record<string, unknown>) => ({
      type: "event" as const,
      event: "agent",
      payload: { runId: RUN, sessionKey: SK, stream: "compaction", data },
    });
    await manager.beginTurn(1_000, RUN, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(chat(RUN, "delta", "Bonjour"), 1_010);
    await manager.feed(compaction({ phase: "start" }), 1_020);
    await manager.feed(compaction({ phase: "end", completed: true, willRetry: true, outcome: "completed" }), 1_030);
    await manager.feed(lifecycle(ADOPTED, { phase: "start", startedAt: 2 }), 1_040);
    await manager.feed(chat(ADOPTED, "final", "Bonjour, voici la suite."), 1_050);
    await settle(writer, 1);
    const late = structuredClone(FALLBACK);
    late.payload.runId = ADOPTED;
    await manager.feed(late, 1_060);
    expect(writer.noted.at(-1)).toMatchObject({ runId: ADOPTED, messageId: "msg_1" });
  });
});

/**
 * The gateway's STATUS NOTICES. After the run's answer the gateway may send a second `chat`
 * final whose blocks are all marked `openclawStatusNotice` (2026.9.6+,
 * src/gateway/server-methods/chat-assistant-content.ts): the fallback notice, a usage
 * line, a diagnostic. It is broadcast, not written to the transcript (no `session.message`
 * row carries it in either capture). Upstream: "status notices remain visible but do not
 * define the terminal reply they accompany"
 * (packages/gateway-client/src/session-projection-message-content.ts).
 *
 * Frames verbatim from the bench (run 2026-11-20T22-44-24-741Z, envelope seq 137-139):
 * the answer's final, the fallback, then the notice final. The usage-line notice is
 * shape-faithful (src/auto-reply/reply/agent-runner-usage-line.ts), never captured.
 */
describe("the gateway's status notice after the answer", () => {
  const LIVE_SK = "agent:alice:atrium:chat:u-repro:turn-nx7cv8n6dvrfzkasc5bebdffnx8jkzn9";
  const LIVE_RUN = "webchat-1f2908ac9be371f1559266ad9d7e757a0086b87cf20f4d91eae7b5201f1e54d4";
  const NOTICE_TEXT = "↪️ Model Fallback: openai/gpt-6.1-sol (selected openai/gpt-5.5; model not found)";
  /** Verbatim, seq 137. */
  const ANSWER = {
    type: "event",
    event: "chat",
    payload: {
      runId: LIVE_RUN,
      sessionKey: LIVE_SK,
      agentId: "alice",
      seq: 29,
      state: "final",
      stopReason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: "BENCH_FALLBACK_OK" }], timestamp: 1795214787000 },
    },
    seq: 137,
  };
  /** Verbatim keys, seq 138 (reasons masked). */
  const LIVE_FALLBACK = {
    type: "event",
    event: "agent",
    payload: {
      runId: LIVE_RUN,
      sessionKey: LIVE_SK,
      stream: "lifecycle",
      data: {
        phase: "fallback",
        selectedProvider: "openai",
        selectedModel: "gpt-5.5",
        activeProvider: "openai",
        activeModel: "gpt-6.1-sol",
        reasonSummary: "<text>",
        attemptSummaries: ["<text>"],
        attempts: [],
      },
      seq: 1,
    },
    seq: 138,
  };
  /** Verbatim, seq 139. */
  const noticeFinal = (blocks: { text: string; notice?: boolean }[]) => ({
    type: "event",
    event: "chat",
    payload: {
      runId: LIVE_RUN,
      sessionKey: LIVE_SK,
      seq: 2,
      state: "final",
      message: {
        role: "assistant",
        content: blocks.map((b) => ({
          type: "text",
          text: b.text,
          ...(b.notice === false ? {} : { openclawStatusNotice: true }),
        })),
        text: blocks.map((b) => b.text).join("\n"),
        timestamp: 1795214787121,
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
      },
    },
    seq: 139,
  });
  const USAGE_LINE = "Usage: 1230 in / 10 out";

  async function answered(writer: FallbackWriter): Promise<RunManager> {
    const manager = new RunManager("chat-notice", LIVE_SK, writer);
    await manager.beginTurn(1_000, LIVE_RUN, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(ANSWER, 1_010);
    await settle(writer, 1);
    return manager;
  }

  it("the captured order: one marker — the notice is neither glued to the answer nor shown twice", async () => {
    const writer = new FallbackWriter();
    const manager = await answered(writer);
    await manager.feed(LIVE_FALLBACK, 1_020);
    await manager.feed(noticeFinal([{ text: NOTICE_TEXT }]), 1_030);
    expect(writer.noted.map((n) => `${n.state}:${n.model}→${n.messageId}`)).toStrictEqual([
      "active:openai/gpt-6.1-sol→msg_1",
    ]);
    expect(writer.lateFinals, "never appended to the answer's text").toStrictEqual([]);
    expect(writer.notices, "the marker already says it").toStrictEqual([]);
    expect(writer.opened, "and no bubble of its own").toStrictEqual([LIVE_RUN]);
  });

  it("a notice with no fallback before it is a notice line on the run's bubble", async () => {
    const writer = new FallbackWriter();
    const manager = await answered(writer);
    await manager.feed(noticeFinal([{ text: USAGE_LINE }]), 1_020);
    expect(writer.notices).toStrictEqual([{ runId: LIVE_RUN, messageId: "msg_1", text: USAGE_LINE }]);
    expect(writer.lateFinals).toStrictEqual([]);
    expect(writer.opened).toStrictEqual([LIVE_RUN]);
  });

  it("after a fallback, only the FIRST notice is the fallback's own: the others are shown", async () => {
    // The fallback notice is prepended to the run's reply payloads
    // (agent-runner-result-payloads.ts), so it is the first block.
    const writer = new FallbackWriter();
    const manager = await answered(writer);
    await manager.feed(LIVE_FALLBACK, 1_020);
    await manager.feed(noticeFinal([{ text: NOTICE_TEXT }, { text: USAGE_LINE }]), 1_030);
    expect(writer.notices.map((n) => n.text)).toStrictEqual([USAGE_LINE]);
    // …and it is consumed once: a later notice of the run is a notice.
    await manager.feed(noticeFinal([{ text: "Diagnostics: ok" }]), 1_040);
    expect(writer.notices.map((n) => n.text)).toStrictEqual([USAGE_LINE, "Diagnostics: ok"]);
    expect(writer.lateFinals).toStrictEqual([]);
  });

  it("a run that left no bubble gets no bubble made for its notice", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-notice", LIVE_SK, writer);
    await manager.beginTurn(1_000, LIVE_RUN, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    // A turn that ends having shown nothing: no bubble is born.
    await manager.feed(
      { type: "event", event: "chat", payload: { runId: LIVE_RUN, sessionKey: LIVE_SK, state: "final" } },
      1_010,
    );
    await new Promise((r) => setTimeout(r, 20));
    const before = writer.opened.length;
    await manager.feed(noticeFinal([{ text: USAGE_LINE }]), 1_020);
    expect(writer.lateFinals).toStrictEqual([]);
    expect(writer.opened).toHaveLength(before);
  });

  it("a server path in a notice never reaches the conversation", async () => {
    const writer = new FallbackWriter();
    const manager = await answered(writer);
    await manager.feed(noticeFinal([{ text: "Wrote /home/node/.openclaw/media/outbound/report.pdf" }]), 1_020);
    expect(writer.notices).toHaveLength(1);
    expect(writer.notices[0]!.text).not.toContain("/home/node/.openclaw");
  });

  it("a late final that MIXES answer text and a notice is still a late piece of the answer", async () => {
    // Not notice-only: the Control UI shows such a message whole, and so does Atrium.
    const writer = new FallbackWriter();
    const manager = await answered(writer);
    await manager.feed(noticeFinal([{ text: "Un complément de réponse.", notice: false }, { text: USAGE_LINE }]), 1_020);
    expect(writer.notices).toStrictEqual([]);
    expect(writer.lateFinals).toHaveLength(1);
  });

  it("an unmarked late final (a gateway before 2026.9.6) keeps the late-final path", async () => {
    const writer = new FallbackWriter();
    const manager = await answered(writer);
    await manager.feed(noticeFinal([{ text: NOTICE_TEXT, notice: false }]), 1_020);
    expect(writer.notices).toStrictEqual([]);
    expect(writer.lateFinals).toStrictEqual([NOTICE_TEXT]);
  });
});

/**
 * ONE PATH for what the gateway states about a run. The same frames must give the same
 * writes, in the same order, whether they arrive during the run's turn, before the
 * `chat.send` ACK (while the answer waits in the pre-ACK buffer), or after the terminal.
 */
describe("facts about a run: one ordered path, on either side of the ACK", () => {
  const SK2 = "agent:alice:atrium:chat:u-repro:turn-nx7cv8n6dvrfzkasc5bebdffnx8jkzn9";
  const R = "webchat-1f2908ac9be371f1559266ad9d7e757a0086b87cf20f4d91eae7b5201f1e54d4";
  const NOTICE_TEXT = "↪️ Model Fallback: openai/gpt-6.1-sol (selected openai/gpt-5.5; model not found)";
  const USAGE = "Usage: 1230 in / 10 out";
  const on = (sk: string, runId: string) => ({
    delta: (text: string) => ({
      type: "event",
      event: "chat",
      payload: { runId, sessionKey: sk, state: "delta", message: { role: "assistant", content: [{ type: "text", text }] } },
    }),
    answer: (text: string) => ({
      type: "event",
      event: "chat",
      payload: { runId, sessionKey: sk, state: "final", message: { role: "assistant", content: [{ type: "text", text }] } },
    }),
    notice: (...texts: string[]) => ({
      type: "event",
      event: "chat",
      payload: {
        runId,
        sessionKey: sk,
        seq: 2,
        state: "final",
        message: {
          role: "assistant",
          content: texts.map((text) => ({ type: "text", text, openclawStatusNotice: true })),
          text: texts.join("\n"),
        },
      },
    }),
    fallback: (selected: string, active: string) => ({
      type: "event",
      event: "agent",
      payload: {
        runId,
        sessionKey: sk,
        stream: "lifecycle",
        data: {
          phase: "fallback",
          selectedProvider: "openai",
          selectedModel: selected,
          activeProvider: "openai",
          activeModel: active,
          reasonSummary: "<text>",
        },
        seq: 1,
      },
    }),
    cleared: (selected: string) => ({
      type: "event",
      event: "agent",
      payload: {
        runId,
        sessionKey: sk,
        stream: "lifecycle",
        data: {
          phase: "fallback_cleared",
          selectedProvider: "openai",
          selectedModel: selected,
          activeProvider: "openai",
          activeModel: selected,
        },
        seq: 1,
      },
    }),
    reroute: (from: string, to: string) => ({
      type: "event",
      event: "agent",
      payload: { runId, sessionKey: sk, stream: "fallback", data: { fromModel: from, toModel: to } },
    }),
  });
  const f = on(SK2, R);

  async function quiet(writer: FallbackWriter): Promise<void> {
    let seen = -1;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const now = writer.effects.length + writer.finals.length + writer.noted.length + writer.notices.length;
      if (now === seen && i > 4) return;
      seen = now;
    }
  }

  /** Feed `before` ahead of the ACK and `after` once the turn has begun. */
  async function play(sk: string, runId: string, before: unknown[], after: unknown[]): Promise<FallbackWriter> {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-facts", sk, writer);
    let now = 1_000;
    manager.armReplayBuffer();
    for (const frame of before) await manager.feed(frame, (now += 10));
    await manager.beginTurn((now += 10), runId, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    for (const frame of after) await manager.feed(frame, (now += 10));
    await quiet(writer);
    return writer;
  }

  it("a final answer then a notice, both before the ACK: the notice is not lost", async () => {
    // The review's sequence: both sat in the pre-ACK buffer and the replay read the
    // notice as a second final of a finished turn.
    const writer = await play(SK2, R, [f.answer("BENCH_FALLBACK_OK"), f.notice(USAGE)], []);
    expect(writer.finals).toStrictEqual(["msg_1:complete"]);
    expect(writer.effects).toStrictEqual([`notice ${USAGE} → msg_1`]);
    expect(writer.lateFinals).toStrictEqual([]);
    expect(writer.opened).toStrictEqual([R]);
  });

  it("two reroutes separated by the ACK: the bubble ends on the LAST one", async () => {
    // The review's sequence: A waited, B was written at once, and A was written over B
    // when the turn closed.
    const writer = await play(
      SK2,
      R,
      [f.reroute("gpt-6.1", "model-A")],
      [f.delta("Bonjour"), f.reroute("gpt-6.1", "model-B"), f.answer("Bonjour.")],
    );
    expect(writer.effects).toStrictEqual(["fallback active model-A → msg_1", "fallback active model-B → msg_1"]);
  });

  it("a fallback then its clearing across the ACK: cleared is what stands", async () => {
    const writer = await play(
      SK2,
      R,
      [f.fallback("gpt-5.5", "gpt-6.1-sol")],
      [f.delta("Bonjour"), f.cleared("gpt-5.5"), f.answer("Bonjour.")],
    );
    expect(writer.effects).toStrictEqual([
      "fallback active openai/gpt-6.1-sol → msg_1",
      "fallback cleared openai/gpt-5.5 → msg_1",
    ]);
  });

  it("answer, fallback, notice before the ACK: the fallback's own notice is left to the marker", async () => {
    const writer = await play(
      SK2,
      R,
      [f.answer("BENCH_FALLBACK_OK"), f.fallback("gpt-5.5", "gpt-6.1-sol"), f.notice(NOTICE_TEXT, USAGE)],
      [],
    );
    expect(writer.effects).toStrictEqual([
      "fallback active openai/gpt-6.1-sol → msg_1",
      `notice ${USAGE} → msg_1`,
    ]);
  });

  it("answer, notice, fallback before the ACK: a notice that came first is not the fallback's", async () => {
    const writer = await play(
      SK2,
      R,
      [f.answer("BENCH_FALLBACK_OK"), f.notice(USAGE), f.fallback("gpt-5.5", "gpt-6.1-sol")],
      [],
    );
    expect(writer.effects).toStrictEqual([
      `notice ${USAGE} → msg_1`,
      "fallback active openai/gpt-6.1-sol → msg_1",
    ]);
  });

  it("a write that fails drops that fact alone: the next fact of the run still lands, never ahead of it", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-facts", SK2, writer);
    const realWarn = console.warn;
    const warned: string[] = [];
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      await manager.beginTurn(1_000, R, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
      // Both wait for the bubble; the first write, once it opens, fails.
      await manager.feed(f.reroute("m", "model-A"), 1_010);
      await manager.feed(f.reroute("m", "model-B"), 1_020);
      writer.failWrites = 1;
      await manager.feed(f.delta("Bonjour"), 1_030);
      await manager.runFactsIdle();
      expect(writer.noted.map((n) => n.model), "A was tried first, once").toStrictEqual(["model-A", "model-B"]);
      expect(writer.effects).toStrictEqual(["fallback active model-B → msg_1"]);
      expect(warned.filter((w) => w.includes("[run-facts]") && w.includes("dropped"))).toHaveLength(1);
    } finally {
      console.warn = realWarn;
    }
  });

  it("a fact that waited for the bubble lands as soon as the bubble opens, without another frame", async () => {
    // The turn is still running in both cases: nothing later would carry the fact.
    const openedByReplay = await play(SK2, R, [f.reroute("m", "model-A"), f.delta("Bonjour")], []);
    expect(openedByReplay.effects).toStrictEqual(["fallback active model-A → msg_1"]);
    expect(openedByReplay.finals).toStrictEqual([]);
    const openedLive = await play(SK2, R, [f.reroute("m", "model-A")], [f.delta("Bonjour")]);
    expect(openedLive.effects).toStrictEqual(["fallback active model-A → msg_1"]);
  });

  it("a notice after a turn that ended WITHOUT a final (aborted) is still beside it, not a late answer", async () => {
    const aborted = { type: "event", event: "chat", payload: { runId: R, sessionKey: SK2, state: "aborted" } };
    const again = new FallbackWriter();
    const m2 = new RunManager("chat-facts", SK2, again);
    await m2.beginTurn(1_000, R, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await m2.feed(f.delta("Bonjour"), 1_010);
    await m2.feed(aborted, 1_020);
    await quiet(again);
    await m2.feed(f.notice(USAGE), 1_030);
    await quiet(again);
    expect(again.effects).toStrictEqual([`notice ${USAGE} → msg_1`]);
    expect(again.lateFinals).toStrictEqual([]);
  });

  it("a notice-only final that is the run's FIRST final is its reply, on either side", async () => {
    // A command's answer: the notice IS the terminal reply (upstream leaves a message
    // made only of notices unchanged).
    for (const [before, after] of [
      [[f.notice("Model set for this session.")], []],
      [[], [f.notice("Model set for this session.")]],
    ]) {
      const writer = await play(SK2, R, before!, after!);
      expect(writer.effects).toStrictEqual([]);
      expect(writer.finals).toStrictEqual(["msg_1:complete"]);
    }
  });

  // The same frames, cut at every point between "before the ACK" and "after it", must
  // write the same things in the same order as when all of them arrive during the turn.
  const captured0711 = on(SK, RUN);
  const SEQUENCES: { name: string; sk: string; runId: string; frames: unknown[] }[] = [
    {
      name: "captured 2026-11-20 (seq 137-139): answer, fallback, its notice",
      sk: SK2,
      runId: R,
      frames: [f.answer("BENCH_FALLBACK_OK"), f.fallback("gpt-5.5", "gpt-6.1-sol"), f.notice(NOTICE_TEXT)],
    },
    {
      name: "captured 2026-11-07 (seq 154-155): answer, fallback",
      sk: SK,
      runId: RUN,
      frames: [captured0711.answer("BENCH_FALLBACK_OK"), FALLBACK],
    },
    {
      name: "captured 2026-11-07, next run (seq 20-21): answer, fallback cleared",
      sk: SK,
      runId: NEXT_RUN,
      frames: [on(SK, NEXT_RUN).answer("REPLAY_OK"), CLEARED],
    },
    { name: "answer, usage notice", sk: SK2, runId: R, frames: [f.answer("Bonjour."), f.notice(USAGE)] },
    {
      name: "text, reroute A, reroute B, answer",
      sk: SK2,
      runId: R,
      frames: [f.delta("Bon"), f.reroute("m", "model-A"), f.reroute("m", "model-B"), f.answer("Bonjour.")],
    },
    {
      name: "fallback, text, cleared, answer, notice",
      sk: SK2,
      runId: R,
      frames: [
        f.fallback("gpt-5.5", "gpt-6.1-sol"),
        f.delta("Bon"),
        f.cleared("gpt-5.5"),
        f.answer("Bonjour."),
        f.notice("Diagnostics: ok", USAGE),
      ],
    },
    {
      name: "answer, notice, fallback, second notice",
      sk: SK2,
      runId: R,
      frames: [f.answer("Bonjour."), f.notice(USAGE), f.fallback("gpt-5.5", "gpt-6.1-sol"), f.notice(NOTICE_TEXT, "Diagnostics: ok")],
    },
  ];
  it.each(SEQUENCES)("replay equivalence — $name", async ({ sk, runId, frames }) => {
    const live = await play(sk, runId, [], frames);
    expect(live.effects.length, "the sequence writes something").toBeGreaterThan(0);
    for (let cut = 1; cut <= frames.length; cut++) {
      const split = await play(sk, runId, frames.slice(0, cut), frames.slice(cut));
      expect(split.effects, `first ${cut} frame(s) before the ACK`).toStrictEqual(live.effects);
      expect(split.finals, `first ${cut} frame(s) before the ACK`).toStrictEqual(live.finals);
      expect(split.lateFinals).toStrictEqual([]);
      expect(split.opened).toStrictEqual(live.opened);
    }
  });

  it("the queue is bounded per run, oldest first, and says what it drops", async () => {
    const warned: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      const before: unknown[] = [];
      for (let i = 0; i < 20; i++) before.push(f.reroute("m", `model-${i}`));
      const writer = await play(SK2, R, before, [f.answer("Bonjour.")]);
      // 16 kept: the four oldest are gone, the order of the rest is theirs.
      expect(writer.effects).toHaveLength(16);
      expect(writer.effects[0]).toBe("fallback active model-4 → msg_1");
      expect(writer.effects.at(-1)).toBe("fallback active model-19 → msg_1");
      expect(warned.some((w) => w.includes("[run-facts]") && w.includes("dropped, oldest first"))).toBe(true);
    } finally {
      console.warn = real;
    }
  });

  it("runs waiting for a bubble are bounded too: the oldest run's facts are dropped, and said", async () => {
    const warned: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      const writer = new FallbackWriter();
      const manager = new RunManager("chat-facts", SK2, writer);
      for (let i = 0; i < 40; i++) {
        await manager.feed(on(SK2, `webchat-orphan-${i}`).reroute("m", `model-${i}`), 1_000 + i);
      }
      expect(warned.filter((w) => w.includes("dropped with their run"))).toHaveLength(8);
      // A kept run still gets its fact when its turn comes; a dropped one does not.
      await manager.beginTurn(2_000, "webchat-orphan-39", { expectedSessionId: null, dispatchOutboxId: "ob-1" });
      await manager.feed(on(SK2, "webchat-orphan-39").answer("ok"), 2_010);
      await quiet(writer);
      expect(writer.effects).toStrictEqual(["fallback active model-39 → msg_1"]);
    } finally {
      console.warn = real;
    }
  });

  it("a run that settles without a bubble drops its facts, and says so", async () => {
    const warned: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      const writer = await play(SK2, R, [f.reroute("m", "model-A")], [
        { type: "event", event: "chat", payload: { runId: R, sessionKey: SK2, state: "final" } },
      ]);
      expect(writer.effects).toStrictEqual([]);
      expect(warned.some((w) => w.includes("the run left no bubble"))).toBe(true);
    } finally {
      console.warn = real;
    }
  });
});

/**
 * EVERY FRAME IS OBSERVED AND CLASSIFIED ONCE, at arrival. A stash hands the same frame
 * back later — through `feed` for the announce stash and the preemption copy, through
 * the live frame's unit past its observation for the pre-ACK buffer, as parsed parts for
 * provenance, on its lane
 * for a run the transcript closed. Whatever the path, the frame gives what it would have
 * given live, and what is counted at observation is counted once.
 */
describe("a frame replayed from a stash is the frame that arrived", () => {
  const SKS = "agent:alice:atrium:chat:u-repro:turn-stash";
  const A = "webchat-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "announce:v1:agent:alice:subagent:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
  const text = (runId: string, state: "delta" | "final", t: string) => ({
    type: "event",
    event: "chat",
    payload: { runId, sessionKey: SKS, state, message: { role: "assistant", content: [{ type: "text", text: t }] } },
  });
  /** A reply made ONLY of status notices, as a run's first final (a command's answer). */
  const noticeOnly = (runId: string, t: string) => ({
    type: "event",
    event: "chat",
    payload: {
      runId,
      sessionKey: SKS,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: t, openclawStatusNotice: true }] },
    },
  });
  const observations = (frame: object) => observeSpy.mock.calls.filter((call) => call[0] === frame).length;
  let observeSpy: { mock: { calls: unknown[][] }; mockRestore(): void };
  beforeEach(() => {
    observeSpy = vi.spyOn(protocolDrift, "observe");
  });
  afterEach(() => {
    observeSpy.mockRestore();
  });
  async function idle(writer: FallbackWriter, finals: number): Promise<void> {
    for (let i = 0; i < 60 && writer.finals.length < finals; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 15));
  }

  it("announce stash: B's notice-only FIRST final, waiting behind turn A, is still B's reply when A ends", async () => {
    // The review's sequence. Its first pass recorded "B's final was seen" and stashed
    // the frame; replayed through `feed` at the end of A, the same final read as a
    // notice BESIDE an answer: no bubble for B, a notice addressed to nothing.
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-stash", SKS, writer);
    await manager.beginTurn(1_000, A, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(text(A, "delta", "Bonjour"), 1_010);
    const waiting = noticeOnly(B, "Model set for this session.");
    await manager.feed(waiting, 1_020);
    expect(writer.opened, "B waits: A is still writing").toStrictEqual([A]);
    await manager.feed(text(A, "final", "Bonjour."), 1_030);
    await idle(writer, 2);
    expect(writer.finals).toStrictEqual(["msg_1:complete", "msg_2:complete"]);
    expect(writer.opened).toStrictEqual([A, B]);
    expect(writer.notices, "it is a reply, not a notice beside one").toStrictEqual([]);
    expect(observations(waiting), "observed once, at arrival").toBe(1);
  });

  it("announce stash: the replayed frame gives what it gives when it arrives with nothing in the way", async () => {
    const live = new FallbackWriter();
    const m1 = new RunManager("chat-stash", SKS, live);
    await m1.feed(noticeOnly(B, "Model set for this session."), 1_000);
    await idle(live, 1);
    const stashed = new FallbackWriter();
    const m2 = new RunManager("chat-stash", SKS, stashed);
    await m2.beginTurn(1_000, A, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await m2.feed(text(A, "delta", "x"), 1_010);
    await m2.feed(noticeOnly(B, "Model set for this session."), 1_020);
    await m2.feed(text(A, "final", "x."), 1_030);
    await idle(stashed, 2);
    expect(stashed.finals.slice(1).map((f) => f.split(":")[1])).toStrictEqual(live.finals.map((f) => f.split(":")[1]));
    expect(stashed.opened.slice(1)).toStrictEqual(live.opened);
    expect(stashed.notices).toStrictEqual(live.notices);
    expect(stashed.effects).toStrictEqual(live.effects);
  });

  it("preemption copy: frames already fed to an unopened announce turn, requeued by a real send, are not observed again", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-stash", SKS, writer);
    // An announce turn opens (deferred: no bubble yet) on a frame that shows nothing.
    const first = {
      type: "event",
      event: "agent",
      payload: { runId: B, sessionKey: SKS, stream: "lifecycle", data: { phase: "start", startedAt: 1 } },
    };
    await manager.feed(first, 1_000);
    expect(writer.opened).toStrictEqual([]);
    // A real send preempts it before it showed anything: its frames go back to the stash.
    await manager.beginTurn(1_010, A, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(text(A, "final", "Réponse."), 1_020);
    await idle(writer, 1);
    const last = text(B, "final", "Rapport du sous-agent.");
    await manager.feed(last, 1_030);
    await idle(writer, 2);
    expect(writer.finals).toHaveLength(2);
    expect(observations(first), "the requeued frame was observed once").toBe(1);
    expect(observations(last)).toBe(1);
  });

  it("pre-ACK buffer: a buffered frame is observed once and replayed to the turn", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-stash", SKS, writer);
    manager.armReplayBuffer();
    const early = text(A, "final", "Réponse.");
    await manager.feed(early, 1_000);
    await manager.beginTurn(1_010, A, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await idle(writer, 1);
    expect(writer.finals).toStrictEqual(["msg_1:complete"]);
    expect(observations(early)).toBe(1);
  });

  it("provenance stash: a report that precedes its turn is observed once and lands on it once", async () => {
    const writer = new FallbackWriter();
    const provenance: unknown[] = [];
    (writer as unknown as { addProvenancePart: (m: string, part: unknown) => Promise<void> }).addProvenancePart =
      async (_m, part) => void provenance.push(part);
    const manager = new RunManager("chat-stash", SKS, writer);
    const report = {
      type: "event",
      event: "agent",
      payload: {
        runId: A,
        sessionKey: SKS,
        stream: "provenance-probe.provenance",
        data: {
          v: 1,
          source: "memory",
          kind: "memory",
          injected: true,
          retrieval: { mode: "semantic" },
          items: [],
          pluginId: "provenance-probe",
          pluginName: "Probe",
        },
      },
    };
    await manager.feed(report, 1_000);
    await manager.beginTurn(1_010, A, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(text(A, "final", "Réponse."), 1_020);
    await idle(writer, 1);
    expect(observations(report)).toBe(1);
    expect(provenance.length).toBeLessThanOrEqual(1);
  });

  it("lane of a run the transcript closed: a frame that waits for the run's bubble is observed once and applied once", async () => {
    const writer = new FallbackWriter();
    const closed: string[] = [];
    let bubble: string | null = null;
    const w = writer as unknown as {
      findProjectedBubble: () => Promise<string | null>;
      finalizeClosedRun: (messageId: string, runId: string, status: string) => Promise<void>;
    };
    w.findProjectedBubble = async () => bubble;
    w.finalizeClosedRun = async (messageId, runId, status) => void closed.push(`${messageId}:${runId === A}:${status}`);
    const manager = new RunManager("chat-stash", SKS, writer);
    // A turn that has shown nothing here when the transcript says its run is over.
    await manager.beginTurn(1_000, A, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    expect(await manager.settleFromTranscript([A], 1_010)).toBe(true);
    // The run's live terminal arrives before the transcript's bubble can be found: it waits.
    const terminal = text(A, "final", "Réponse.");
    await manager.feed(terminal, 1_020);
    await new Promise((r) => setTimeout(r, 15));
    expect(closed).toStrictEqual([]);
    // The bubble exists now; the next frame of the run lets what waited through, first.
    bubble = "msg_transcript";
    await manager.feed(
      { type: "event", event: "agent", payload: { runId: A, sessionKey: SKS, stream: "lifecycle", data: { phase: "end" } } },
      1_030,
    );
    await new Promise((r) => setTimeout(r, 15));
    expect(closed).toStrictEqual(["msg_transcript:true:complete"]);
    expect(observations(terminal)).toBe(1);
  });

  it("the same frame OBJECT fed twice is one frame; a second delivery is a second object", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-stash", SKS, writer);
    await manager.beginTurn(1_000, A, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(text(A, "final", "Réponse."), 1_010);
    await idle(writer, 1);
    const fallback = {
      type: "event",
      event: "agent",
      payload: { runId: A, sessionKey: SKS, stream: "fallback", data: { fromModel: "m", toModel: "model-A" } },
    };
    await manager.feed(fallback, 1_020);
    await manager.feed(fallback, 1_030);
    expect(writer.effects).toStrictEqual(["fallback active model-A → msg_1"]);
    expect(observations(fallback)).toBe(1);
  });
});

/**
 * FACTS ARE METADATA. Their writes are detached from the frame path: no frame waits for
 * one, nothing here retries one (the writer does, bounded), and a write that does not
 * land drops that one fact with one trace. "The run has no bubble" is an answer from
 * Convex; a write that failed is not one.
 */
describe("a fact's write never holds the stream", () => {
  const SKW = "agent:alice:atrium:chat:u-repro:turn-writes";
  const W = "webchat-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const V = "webchat-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const reroute = (to: string, runId = W) => ({
    type: "event",
    event: "agent",
    payload: { runId, sessionKey: SKW, stream: "fallback", data: { fromModel: "m", toModel: to } },
  });
  const chatOf = (runId: string, state: "delta" | "final", text: string) => ({
    type: "event",
    event: "chat",
    payload: { runId, sessionKey: SKW, state, message: { role: "assistant", content: [{ type: "text", text }] } },
  });
  const answer = chatOf(W, "final", "Réponse.");
  const noticeOf = (runId: string, ...texts: string[]) => ({
    type: "event",
    event: "chat",
    payload: {
      runId,
      sessionKey: SKW,
      state: "final",
      message: { role: "assistant", content: texts.map((text) => ({ type: "text", text, openclawStatusNotice: true })) },
    },
  });
  const tool = (runId: string, phase: "start" | "result") => ({
    type: "event",
    event: "agent",
    payload: {
      runId,
      sessionKey: SKW,
      stream: "tool",
      data: { phase, name: "exec", toolCallId: "tc-1", ...(phase === "start" ? { args: { command: "ls" } } : { result: "ok" }) },
    },
  });
  let warned: string[];
  let unhandled: unknown[];
  let realWarn: typeof console.warn;
  let realError: typeof console.error;
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  beforeEach(() => {
    warned = [];
    unhandled = [];
    realWarn = console.warn;
    realError = console.error;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    console.error = () => {};
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 5));
    process.off("unhandledRejection", onUnhandled);
    console.warn = realWarn;
    console.error = realError;
    expect(unhandled, "no unhandled rejection").toStrictEqual([]);
  });
  const dropped = () => warned.filter((w) => w.includes("[run-facts]") && w.includes("dropped"));
  const beat = () => new Promise((r) => setTimeout(r, 5));

  /** A writer whose marker write does not answer until released. */
  function holding(writer: FallbackWriter, onlyRun?: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = writer.noteModelFallback.bind(writer);
    let asked = 0;
    writer.noteModelFallback = async (chatId, data) => {
      asked++;
      if (onlyRun === undefined || data.runId === onlyRun) await gate;
      return real(chatId, data);
    };
    return { release, asked: () => asked };
  }

  it("deltas, a tool and the terminal are all processed while a marker write is held", async () => {
    const writer = new FallbackWriter();
    let tools = 0;
    writer.addToolPart = async () => void tools++;
    const { release, asked } = holding(writer);
    const manager = new RunManager("chat-writes", SKW, writer);
    await manager.beginTurn(1_000, W, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(chatOf(W, "delta", "Ré"), 1_010);
    // Every one of these feeds RETURNS while the write below it is still unanswered.
    await manager.feed(reroute("model-A"), 1_020);
    await beat();
    expect(asked(), "the write is in flight").toBe(1);
    await manager.feed(chatOf(W, "delta", "Répon"), 1_030);
    await manager.feed(tool(W, "start"), 1_040);
    await manager.feed(tool(W, "result"), 1_050);
    await manager.feed({ type: "event", event: "tick", payload: { ts: 1 } }, 1_055);
    await manager.feed(answer, 1_060);
    await settle(writer, 1);
    expect(writer.finals).toStrictEqual(["msg_1:complete"]);
    expect(tools).toBeGreaterThan(0);
    expect(writer.effects, "still held").toStrictEqual([]);
    release();
    await manager.runFactsIdle();
    expect(writer.effects).toStrictEqual(["fallback active model-A → msg_1"]);
    expect(dropped()).toStrictEqual([]);
  });

  it("a blocked write of one run: another run's facts land once each, in order, after the release", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-writes", SKW, writer);
    await manager.beginTurn(1_000, W, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(answer, 1_010);
    await settle(writer, 1);
    const { release } = holding(writer, W);
    await manager.feed(reroute("model-A"), 1_020);
    // The next turn runs to its end behind that held write.
    await manager.beginTurn(1_030, V, { expectedSessionId: null, dispatchOutboxId: "ob-2" });
    await manager.feed(chatOf(V, "delta", "Se"), 1_040);
    await manager.feed(reroute("model-1", V), 1_041);
    await manager.feed(chatOf(V, "delta", "Seco"), 1_042);
    await manager.feed(reroute("model-2", V), 1_043);
    await manager.feed(chatOf(V, "delta", "Second"), 1_044);
    await manager.feed(chatOf(V, "delta", "Seconde"), 1_045);
    await manager.feed(chatOf(V, "final", "Seconde."), 1_046);
    await manager.feed(noticeOf(V, "↪️ Model Fallback: model-2", "Usage: 1 in / 1 out"), 1_047);
    await settle(writer, 2);
    expect(writer.finals).toStrictEqual(["msg_1:complete", "msg_2:complete"]);
    expect(writer.effects).toStrictEqual([]);
    release();
    await manager.runFactsIdle();
    expect(writer.effects).toStrictEqual([
      "fallback active model-A → msg_1",
      "fallback active model-1 → msg_2",
      "fallback active model-2 → msg_2",
      "notice Usage: 1 in / 1 out → msg_2",
    ]);
    expect(writer.noted.map((n) => n.model), "each marker posted once").toStrictEqual(["model-A", "model-1", "model-2"]);
    expect(writer.notices).toHaveLength(1);
  });

  it("frames arriving while the chain is held stack no pass: a waiting fact is asked for once, not once per frame", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-writes", SKW, writer);
    await manager.beginTurn(1_000, W, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(answer, 1_010);
    await settle(writer, 1);
    const real = writer.noteModelFallback.bind(writer);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    writer.noteModelFallback = async (chatId, data) => {
      if (data.runId === W) await gate;
      // Convex does not find V's bubble (yet): an answer, and the fact waits.
      if (data.runId === V) {
        writer.noted.push({ ...data });
        return null;
      }
      return real(chatId, data);
    };
    await manager.feed(reroute("model-A"), 1_020);
    await manager.beginTurn(1_030, V, { expectedSessionId: null, dispatchOutboxId: "ob-2" });
    await manager.feed(chatOf(V, "delta", "S"), 1_040);
    await manager.feed(reroute("model-1", V), 1_041);
    for (let i = 0; i < 6; i++) await manager.feed(chatOf(V, "delta", `Seconde ${i}`), 1_042 + i);
    release();
    await manager.runFactsIdle();
    expect(writer.noted.filter((n) => n.runId === V), "one pass waited, whatever the frames").toHaveLength(1);
    expect(dropped()).toStrictEqual([]);
  });

  /** The real writer's post path for the two fact ops, behind a scripted Convex. */
  function scripted(statuses: number[]) {
    const posts: { op: string; model?: string; text?: string; status: number }[] = [];
    const fetchImpl = (async (_url: unknown, init: { body: unknown }) => {
      const body = JSON.parse(init.body as string) as { op: string; model?: string; text?: string; messageId?: string };
      const status = statuses.shift() ?? 200;
      posts.push({ op: body.op, ...(body.model ? { model: body.model } : {}), ...(body.text ? { text: body.text } : {}), status });
      return new Response(
        JSON.stringify(status === 200 ? { ok: true, messageId: body.messageId ?? "msg_1" } : { error: "unknown op" }),
        { status },
      );
    }) as unknown as typeof fetch;
    const http = new HttpConvexWriter({ convexHttpActionsUrl: "http://test.invalid", ingestSecret: "s", fetchImpl });
    const writer = new FallbackWriter();
    writer.noteModelFallback = async (chatId, data) => {
      const id = await http.noteModelFallback(chatId, { ...data, state: data.state as "active" | "cleared" });
      if (id !== null) writer.effects.push(`fallback ${data.state} ${data.model} → ${id}`);
      return id;
    };
    writer.noteGatewayNotice = async (chatId, data) => {
      const id = await http.noteGatewayNotice(chatId, data);
      if (id !== null) writer.effects.push(`notice ${data.text} → ${id}`);
      return id;
    };
    return { writer, posts };
  }
  async function settledTurn(writer: FallbackWriter): Promise<RunManager> {
    const manager = new RunManager("chat-writes", SKW, writer);
    await manager.beginTurn(1_000, W, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(answer, 1_010);
    await settle(writer, 1);
    return manager;
  }
  /** Let the writer's back-off (0.5 s, then 2 s) elapse. */
  async function pastBackoff(manager: RunManager): Promise<void> {
    const idle = manager.runFactsIdle();
    await vi.advanceTimersByTimeAsync(3_000);
    await idle;
  }

  it("a transient failure: the writer retries it, bounded, and the order is kept", async () => {
    const { writer, posts } = scripted([503]);
    const manager = await settledTurn(writer);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await manager.feed(reroute("model-A"), 1_020);
    await manager.feed(reroute("model-B"), 1_021);
    await pastBackoff(manager);
    expect(posts.map((p) => [p.model, p.status])).toStrictEqual([
      ["model-A", 503],
      ["model-A", 200],
      ["model-B", 200],
    ]);
    expect(writer.effects).toStrictEqual(["fallback active model-A → msg_1", "fallback active model-B → msg_1"]);
    expect(dropped()).toStrictEqual([]);
  });

  it("a failure that lasts: the writer's attempts, then that fact is dropped with one trace — the next one lands", async () => {
    const { writer, posts } = scripted([503, 503, 503]);
    const manager = await settledTurn(writer);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await manager.feed(reroute("model-A"), 1_020);
    await manager.feed(noticeOf(W, "↪️ Model Fallback: model-A", "Usage: 1 in / 1 out"), 1_021);
    await pastBackoff(manager);
    expect(posts.filter((p) => p.model === "model-A").map((p) => p.status)).toStrictEqual([503, 503, 503]);
    expect(dropped()).toHaveLength(1);
    expect(dropped()[0]).toContain("its write failed");
    expect(dropped()[0]).not.toContain("left no bubble");
    expect(writer.effects).toStrictEqual(["notice Usage: 1 in / 1 out → msg_1"]);
    // Nothing is left to try: later frames attempt nothing more.
    const before = posts.length;
    await manager.feed({ type: "event", event: "tick", payload: { ts: 1 } }, 1_100);
    await pastBackoff(manager);
    expect(posts).toHaveLength(before);
  });

  it("a refusal (4xx — a Convex that does not know the op): one attempt, one trace, and the next fact lands", async () => {
    const { writer, posts } = scripted([400]);
    const manager = await settledTurn(writer);
    await manager.feed(reroute("model-A"), 1_020);
    await manager.feed(reroute("model-B"), 1_021);
    await manager.runFactsIdle();
    expect(posts.map((p) => [p.model, p.status])).toStrictEqual([
      ["model-A", 400],
      ["model-B", 200],
    ]);
    expect(dropped()).toHaveLength(1);
    expect(dropped()[0]).toContain("Convex refused it (HTTP 400, not retried)");
    expect(writer.effects).toStrictEqual(["fallback active model-B → msg_1"]);
  });

  it("a refusal is told from a failure by the writer's own error, whatever threw it", async () => {
    const writer = new FallbackWriter();
    const manager = await settledTurn(writer);
    writer.noteGatewayNotice = async () => {
      throw new ConvexIngestError("gatewayNotice", 404, "ingest gatewayNotice -> HTTP 404");
    };
    await manager.feed(noticeOf(W, "Usage: 1 in / 1 out"), 1_020);
    await manager.runFactsIdle();
    expect(dropped()).toHaveLength(1);
    expect(dropped()[0]).toContain("a gateway notice dropped: Convex refused it (HTTP 404, not retried)");
  });

  it("`no bubble` is Convex's answer: final for a settled run, said as such; a failure is never read as it", async () => {
    const writer = new FallbackWriter();
    const manager = new RunManager("chat-writes", SKW, writer);
    // A turn that shows nothing: no bubble.
    await manager.beginTurn(1_000, W, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed({ type: "event", event: "chat", payload: { runId: W, sessionKey: SKW, state: "final" } }, 1_010);
    await beat();
    await manager.feed(reroute("model-A"), 1_020);
    await manager.runFactsIdle();
    expect(warned.filter((w) => w.includes("left no bubble"))).toHaveLength(1);
    await manager.feed({ type: "event", event: "tick", payload: { ts: 1 } }, 1_100);
    await manager.runFactsIdle();
    expect(writer.noted, "dropped: not asked again").toHaveLength(1);
  });

  it("a `no bubble` answered BEFORE the turn settled is not its last word: the settle asks again", async () => {
    const writer = new FallbackWriter();
    const real = writer.noteModelFallback.bind(writer);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let asked = 0;
    writer.noteModelFallback = async (chatId, data) => {
      // The first lookup is made before the run has a bubble, and answered late.
      if (asked++ === 0) {
        writer.noted.push({ ...data });
        await gate;
        return null;
      }
      return real(chatId, data);
    };
    const manager = new RunManager("chat-writes", SKW, writer);
    // No dispatch in flight (a fact stated ahead of a run the gateway starts by itself):
    // during one, a fact of a run that is not the open turn's waits for the ACK instead
    // of asking (see "a fact stated before the ACK of a turn re-using a settled run id").
    await manager.feed(reroute("model-A"), 1_000);
    await beat();
    await manager.beginTurn(1_010, W, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
    await manager.feed(answer, 1_020);
    await settle(writer, 1);
    release();
    await manager.runFactsIdle();
    expect(writer.effects).toStrictEqual(["fallback active model-A → msg_1"]);
    expect(warned.filter((w) => w.includes("left no bubble"))).toStrictEqual([]);
  });

  it("a fact stated before the ACK of a turn re-using a settled run id goes on THAT turn's bubble, not the earlier one", async () => {
    const writer = new FallbackWriter();
    const manager = await settledTurn(writer);
    // The same run id is sent again; its fallback races the ACK.
    manager.armReplayBuffer();
    await manager.feed(reroute("model-A"), 1_020);
    await manager.runFactsIdle();
    // Nothing yet: until the ACK, the run named is the one that settled msg_1.
    expect(writer.effects).toStrictEqual([]);
    await manager.beginTurn(1_030, W, { expectedSessionId: null, dispatchOutboxId: "ob-2" });
    await manager.feed(answer, 1_040);
    await settle(writer, 2);
    await manager.runFactsIdle();
    expect(writer.effects).toStrictEqual(["fallback active model-A → msg_2"]);
  });

  it("a fact beside a settled run, stated while ANOTHER send is in flight, lands once that send has begun or failed", async () => {
    for (const fails of [false, true]) {
      const writer = new FallbackWriter();
      const manager = await settledTurn(writer);
      manager.armReplayBuffer();
      await manager.feed(reroute("model-A"), 1_020);
      await manager.runFactsIdle();
      expect(writer.effects).toStrictEqual([]);
      if (fails) manager.disarmReplayBuffer(1_030);
      else await manager.beginTurn(1_030, "run-other", { expectedSessionId: null, dispatchOutboxId: "ob-2" });
      await manager.runFactsIdle();
      expect(writer.effects).toStrictEqual(["fallback active model-A → msg_1"]);
    }
  });

  it("facts stated together are written one at a time, each once, in order", async () => {
    // Writes that take time: the second fact arrives while the first is being written.
    const writer = new FallbackWriter();
    const slow = writer.noteModelFallback.bind(writer);
    let inFlight = 0;
    let maxInFlight = 0;
    writer.noteModelFallback = async (chatId, data) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => setTimeout(r, 20));
      inFlight--;
      return slow(chatId, data);
    };
    const manager = await settledTurn(writer);
    const first = manager.feed(reroute("model-A"), 1_020);
    const second = manager.feed(reroute("model-B"), 1_021);
    // The first notice after a stated fallback is the fallback's own: the second lands.
    const third = manager.feed(noticeOf(W, "↪️ Model Fallback: model-B", "Usage: 1 in / 1 out"), 1_022);
    await Promise.all([first, second, third]);
    await manager.runFactsIdle();
    expect(maxInFlight, "one write at a time").toBe(1);
    expect(writer.effects).toStrictEqual([
      "fallback active model-A → msg_1",
      "fallback active model-B → msg_1",
      "notice Usage: 1 in / 1 out → msg_1",
    ]);
  });

  it("a writer that throws outside its promise breaks nothing: the pass is contained, the next fact lands", async () => {
    const writer = new FallbackWriter();
    const manager = await settledTurn(writer);
    const real = writer.noteModelFallback.bind(writer);
    let calls = 0;
    writer.noteModelFallback = ((...args: Parameters<typeof real>) => {
      if (calls++ === 0) throw new Error("synchronous");
      return real(...args);
    }) as typeof writer.noteModelFallback;
    await manager.feed(reroute("model-A"), 1_020);
    await manager.feed(reroute("model-B"), 1_021);
    await manager.runFactsIdle();
    expect(writer.effects).toStrictEqual(["fallback active model-B → msg_1"]);
  });

  it("the bound applied while a write is in flight drops queued facts only, never the one being written twice over", async () => {
    const writer = new FallbackWriter();
    const manager = await settledTurn(writer);
    const { release } = holding(writer);
    for (let i = 0; i <= 17; i++) await manager.feed(reroute(`model-${i}`), 1_020 + i);
    release();
    await manager.runFactsIdle();
    // model-0 was being written; of the 17 behind it the bound (16) dropped the oldest.
    expect(writer.effects).toStrictEqual(
      [0, ...Array.from({ length: 16 }, (_, i) => i + 2)].map((i) => `fallback active model-${i} → msg_1`),
    );
  });

  it("a pass that throws does not break the chain: the passes behind it still run", async () => {
    const writer = new FallbackWriter();
    const manager = await settledTurn(writer);
    const sink = (manager as unknown as { sink: { writeRunFallback: (...a: unknown[]) => Promise<unknown> } }).sink;
    const real = sink.writeRunFallback.bind(sink);
    let calls = 0;
    sink.writeRunFallback = async (...a) => {
      if (calls++ === 0) throw new Error("the sink itself failed");
      return real(...a);
    };
    await manager.feed(reroute("model-A"), 1_020);
    await manager.runFactsIdle();
    await manager.feed(reroute("model-B"), 1_021);
    await manager.runFactsIdle();
    expect(writer.effects).toStrictEqual(["fallback active model-B → msg_1"]);
  });
});

describe("the writer posts it by run (writer → Convex)", () => {
  it.each([
    ["modelFallback", (w: HttpConvexWriter) => w.noteModelFallback("c1", { runId: RUN, messageId: "m1", sessionKey: SK, state: "active", model: "b" })],
    ["gatewayNotice", (w: HttpConvexWriter) => w.noteGatewayNotice("c1", { runId: RUN, messageId: "m1", sessionKey: SK, text: "Usage: 1 in / 1 out" })],
  ])("%s: a transient failure is retried (the op is idempotent in Convex), a refusal is not", async (_op, post) => {
    const realError = console.error;
    console.error = () => {};
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const run = async (statuses: number[]) => {
        let posts = 0;
        const fetchImpl = (async () => {
          const status = statuses[posts++] ?? 200;
          return new Response(JSON.stringify(status === 200 ? { ok: true, messageId: "m1" } : { error: "x" }), { status });
        }) as unknown as typeof fetch;
        const w = new HttpConvexWriter({ convexHttpActionsUrl: "http://test.invalid", ingestSecret: "s", fetchImpl });
        const outcome = post(w).then(
          (id) => id,
          (err: unknown) => err,
        );
        await vi.advanceTimersByTimeAsync(3_000);
        return { outcome: await outcome, posts };
      };
      expect(await run([503])).toStrictEqual({ outcome: "m1", posts: 2 });
      const lasting = await run([503, 503, 503, 503]);
      expect(lasting.posts, "one try and the two retries of the writer's budget").toBe(3);
      expect(lasting.outcome).toBeInstanceOf(ConvexIngestError);
      const refused = await run([400]);
      expect(refused.posts).toBe(1);
      expect((refused.outcome as ConvexIngestError).status).toBe(400);
    } finally {
      vi.useRealTimers();
      console.error = realError;
    }
  });


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
