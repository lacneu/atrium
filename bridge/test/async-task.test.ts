// Background-task engagement contract, pinned against REAL frames captured
// live on OpenClaw 2026.7.1-beta.2 (2026-07-12): the async tool ack
// ({async:true, taskId}) and the task-delivery run id family
// (`image_generate:<uuid>:ok`). Each test fails if the correlation regressed.

import { describe, expect, it } from "vitest";
import {
  asyncTaskStartFromTool,
  taskChildKey,
  taskDeliveryRunFromRunId,
} from "../src/core/async-task.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type {
  ConvexWriter,
  FinalizeStatus,
  SubAgentRecord,
  ToolPart,
} from "../src/convex-writer.js";

// Verbatim (trimmed) from the capture: the image_generate ack.
const ASYNC_ACK_OUTPUT = {
  content: [
    {
      type: "text",
      text: "Background task started for image generation (c3e21208-67c2-40ca-b9a4-7368a7109605). Do not call image_generate again for this request. Wait for the completion event; the completion agent will send the finished image here when it's ready.",
    },
  ],
  details: {
    async: true,
    status: "started",
    taskId: "c3e21208-67c2-40ca-b9a4-7368a7109605",
    runId: "tool:image",
  },
};
const DELIVERY_RUN = "image_generate:c3e21208-67c2-40ca-b9a4-7368a7109605:ok";

describe("asyncTaskStartFromTool (real captured ack)", () => {
  it("detects the structured async ack", () => {
    expect(
      asyncTaskStartFromTool("image_generate", "completed", ASYNC_ACK_OUTPUT),
    ).toEqual({
      taskId: "c3e21208-67c2-40ca-b9a4-7368a7109605",
      toolName: "image_generate",
    });
  });
  it("ignores sync results, errors, and text-only bodies", () => {
    expect(
      asyncTaskStartFromTool("image_generate", "completed", {
        content: [],
        details: { status: "done" },
      }),
    ).toBeNull();
    expect(
      asyncTaskStartFromTool("image_generate", "error", ASYNC_ACK_OUTPUT),
    ).toBeNull();
    expect(asyncTaskStartFromTool("exec", "completed", "plain text")).toBeNull();
  });
});

describe("taskDeliveryRunFromRunId (real captured run id)", () => {
  it("parses the delivery family, both outcomes", () => {
    expect(taskDeliveryRunFromRunId(DELIVERY_RUN)).toEqual({
      toolName: "image_generate",
      taskId: "c3e21208-67c2-40ca-b9a4-7368a7109605",
      outcome: "ok",
    });
    expect(
      taskDeliveryRunFromRunId(
        "video_generate:c3e21208-67c2-40ca-b9a4-7368a7109605:error",
      )?.outcome,
    ).toBe("error");
  });
  it("never matches ordinary run families", () => {
    for (const rid of [
      "webchat-0ad6c740504bd56662d39314b2ee513e994d51f9",
      "announce:v1:agent:files:subagent:abc:def",
      "cron:10f525c0-5085-480c-9a8c-c7c246954a3f:1783877963955",
      "image_generate:not-a-uuid:ok",
      null,
      undefined,
    ]) {
      expect(taskDeliveryRunFromRunId(rid as never)).toBeNull();
    }
  });
});

// --- sink integration on captured shapes --------------------------------

const SESSION_KEY = "agent:alice:atrium:chat:olivier:asyncchat1";

function agentFrame(runId: string, data: Record<string, unknown>): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId,
      stream: data.stream ?? "tool",
      sessionKey: SESSION_KEY,
      isHeartbeat: false,
      data,
    },
  };
}
function chatFinal(runId: string): unknown {
  // Real 5.19+ shape (fixtures): state:"final" + a full message snapshot.
  // An EMPTY content list = the silent turn under test.
  return {
    type: "event",
    event: "chat",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      seq: 9,
      state: "final",
      message: { role: "assistant", content: [] },
    },
  };
}

class AsyncWriter implements ConvexWriter {
  upserts: SubAgentRecord[] = [];
  finals: { status: FinalizeStatus; error: string | null }[] = [];
  started = 0;
  async startAssistant(): Promise<string> {
    this.started++;
    return `msg_async_${this.started}`;
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
  async finalize(
    _m: string,
    status: FinalizeStatus,
    _t: string,
    error: string | null = null,
  ): Promise<void> {
    this.finals.push({ status, error });
  }
  async getRehydrationContext(): Promise<{
    history: string | null;
    turnCount: number;
  }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(record: SubAgentRecord): Promise<void> {
    this.upserts.push(record);
  }
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

describe("turn-sink: async engagement lifecycle (captured flow)", () => {
  it("async ack -> task row anchored to the turn; silent turn stays COMPLETE", async () => {
    const writer = new AsyncWriter();
    const manager = new RunManager("asyncchat1", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), "webchat-asyncrun1");
    await manager.feed(
      agentFrame("webchat-asyncrun1", {
        name: "image_generate",
        phase: "start",
        toolCallId: "c1|f1",
        args: { action: "generate" },
      }),
      (now += 1),
    );
    await manager.feed(
      agentFrame("webchat-asyncrun1", {
        name: "image_generate",
        phase: "result",
        toolCallId: "c1|f1",
        isError: false,
        result: ASYNC_ACK_OUTPUT,
      }),
      (now += 1),
    );
    await manager.feed(chatFinal("webchat-asyncrun1"), (now += 1));
    await manager.feed(
      agentFrame("webchat-asyncrun1", { stream: "lifecycle", phase: "end" }),
      (now += 1),
    );
    await manager.tick(now + 100_000); // resolve the lifecycle-end deadline
    // Engagement row anchored to the turn's message.
    const task = writer.upserts.find((u) => u.kind === "task");
    expect(task).toMatchObject({
      childSessionKey: taskChildKey("c3e21208-67c2-40ca-b9a4-7368a7109605"),
      status: "running",
      parentMessageId: "msg_async_1",
      taskName: "image_generate",
    });
    // The silent turn (only the async ack, no text) is NOT an empty_response.
    expect(writer.finals).toHaveLength(1);
    expect(writer.finals[0]?.status).toBe("complete");
    expect(writer.finals[0]?.error).toBeNull();
  });

  it("codex P2: a spontaneous run whose only output is a native PLAN still reaches the thread", async () => {
    const writer = new AsyncWriter();
    const manager = new RunManager("planchat1", SESSION_KEY, writer);
    let now = 1000;
    await manager.feed(
      {
        event: "agent",
        payload: {
          runId: DELIVERY_RUN,
          sessionKey: SESSION_KEY,
          stream: "plan",
          data: {
            phase: "update",
            steps: [{ step: "Analyser le rapport", status: "in_progress" }],
          },
        },
      },
      (now += 1),
    );
    await manager.feed(chatFinal(DELIVERY_RUN), (now += 1));
    await manager.tick(now + 100_000);
    // A plan is visible work: the `update_plan` TOOL path opens a bubble, and
    // the native stream must not be the one output that silently disappears.
    expect(writer.started).toBe(1);
  });

  it("a NO_REPLY delivery run still SETTLES the engagement (no bubble)", async () => {
    const writer = new AsyncWriter();
    const manager = new RunManager("asyncchat1", SESSION_KEY, writer);
    let now = 1000;
    // No active turn: the delivery run arrives spontaneously, does invisible
    // work (a tool call) and ends with no visible content.
    await manager.feed(
      agentFrame(DELIVERY_RUN, {
        name: "sessions_spawn",
        phase: "start",
        toolCallId: "s1|f1",
        args: { task: "integrate" },
      }),
      (now += 1),
    );
    await manager.feed(chatFinal(DELIVERY_RUN), (now += 1));
    await manager.feed(
      agentFrame(DELIVERY_RUN, { stream: "lifecycle", phase: "end" }),
      (now += 1),
    );
    await manager.tick(now + 100_000);
    // No bubble was opened...
    expect(writer.started).toBe(0);
    // ...but the engagement settled as done.
    const settled = writer.upserts.find(
      (u) => u.kind === "task" && u.status === "done",
    );
    expect(settled?.childSessionKey).toBe(
      taskChildKey("c3e21208-67c2-40ca-b9a4-7368a7109605"),
    );
  });

});

// THE REAL FRAME, PINNED.
//
// The bound is only worth reading if the gateway actually sends it where we look.
// This `details` object is the SHAPE CAPTURED IN PRODUCTION on 2026-08-08 (the
// image_generate ack of the 47-hour incident, taken from the feedback report's
// frozen forensic snapshot) — not a hand-made object. The golden fixture pinned
// before this lot carries no `timeoutMs` at all, so nothing in the corpus
// exercised the extraction (codex P1).
describe("the declared bound is read from the frame the gateway really sends", () => {
  const productionDetails = {
    aspectRatio: "3:2",
    async: true,
    background: "opaque",
    filename: "R002-flan-patissier-vanille-hero.png",
    model: "openai/gpt-image-1.5",
    outputFormat: "png",
    quality: "high",
    runId: "tool:image_generate:26570655-ad4a-4d1c-b25d-cf7435db88fc",
    size: "1536x1024",
    status: "started",
    task: {
      runId: "tool:image_generate:26570655-ad4a-4d1c-b25d-cf7435db88fc",
      taskId: "8074f478-9142-420e-88fa-e473ea4c27e4",
    },
    taskId: "8074f478-9142-420e-88fa-e473ea4c27e4",
    timeoutMs: 300000,
  };

  it("extracts the 300000 ms the incident's own ack carried", () => {
    const start = asyncTaskStartFromTool("image_generate", "completed", {
      content: [{ type: "text", text: "Background task started…" }],
      details: productionDetails,
    });
    expect(start?.taskId).toBe("8074f478-9142-420e-88fa-e473ea4c27e4");
    expect(
      start?.timeoutMs,
      "the bound is not where we look, so nothing downstream can ever use it",
    ).toBe(300000);
  });

  it("an ack WITHOUT a bound still starts a task, simply unbounded", () => {
    const { timeoutMs: _drop, ...noBound } = productionDetails;
    const start = asyncTaskStartFromTool("image_generate", "completed", {
      details: noBound,
    });
    expect(start?.taskId).toBe("8074f478-9142-420e-88fa-e473ea4c27e4");
    expect(start?.timeoutMs).toBeUndefined();
  });
});
