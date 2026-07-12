// cronPartFromTool contract, pinned against REAL frames captured live on
// OpenClaw 2026.7.1 (2026-07-12): the coalesced tool.status (input = the
// start frame's args, output = the result frame's result) of the `cron` tool.
// Each test would fail if the extraction regressed on that captured shape.

import { describe, expect, it } from "vitest";
import {
  cronPartFromTool,
  printableCronSchedule,
} from "../src/core/cron-part.js";

// Verbatim (trimmed) from the capture: cron add result.
const ADD_INPUT = {
  action: "add",
  job: {
    name: "rappel-cafe",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Toronto" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "Rappelle a Olivier de faire un cafe.",
      timeoutSeconds: 60,
    },
    delivery: { mode: "announce" },
    enabled: true,
  },
};
const ADD_OUTPUT = {
  content: [{ type: "text", text: "{...job json...}" }],
  details: {
    id: "10f525c0-5085-480c-9a8c-c7c246954a3f",
    agentId: "alice",
    name: "rappel-cafe",
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Toronto" },
    payload: { kind: "agentTurn", message: "Rappelle a Olivier de faire un cafe." },
    delivery: { mode: "announce" },
    state: { nextRunAtMs: 1783947600000 },
  },
};

describe("cronPartFromTool (real captured shapes)", () => {
  it("add -> created, RESULT job authoritative (server id, schedule, nextRun)", () => {
    const p = cronPartFromTool("cron", "completed", ADD_INPUT, ADD_OUTPUT);
    expect(p).toEqual({
      kind: "cron",
      op: "created",
      jobId: "10f525c0-5085-480c-9a8c-c7c246954a3f",
      name: "rappel-cafe",
      enabled: true,
      schedule: "cron 0 9 * * * (America/Toronto)",
      message: "Rappelle a Olivier de faire un cafe.",
      deliveryMode: "announce",
      agentId: "alice",
      nextRunAtMs: 1783947600000,
    });
  });

  it("update -> updated, jobId from the input when the result lacks it", () => {
    const p = cronPartFromTool(
      "cron",
      "completed",
      {
        action: "update",
        jobId: "10f525c0-5085-480c-9a8c-c7c246954a3f",
        patch: { schedule: { kind: "cron", expr: "30 9 * * *", tz: "UTC" } },
      },
      { content: [], details: {} }, // a degenerate result body
    );
    expect(p?.op).toBe("updated");
    expect(p?.jobId).toBe("10f525c0-5085-480c-9a8c-c7c246954a3f");
    expect(p?.schedule).toBe("cron 30 9 * * * (UTC)");
  });

  it("remove -> removed with the input jobId (result carries no job body)", () => {
    const p = cronPartFromTool(
      "cron",
      "completed",
      { action: "remove", jobId: "779162a8" },
      { content: [{ type: "text", text: '{"removed":true}' }], details: { removed: true } },
    );
    expect(p).toEqual({ kind: "cron", op: "removed", jobId: "779162a8" });
  });

  it("falls back to the result's TEXT content JSON when details is absent", () => {
    const p = cronPartFromTool(
      "cron",
      "completed",
      { action: "add", job: { name: "x" } },
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id: "abc", name: "x", enabled: false }),
          },
        ],
      },
    );
    expect(p?.jobId).toBe("abc");
    expect(p?.enabled).toBe(false);
  });

  it("read-only actions yield null (list/get/status/runs/wake)", () => {
    for (const action of ["list", "get", "status", "runs", "wake"]) {
      expect(
        cronPartFromTool("cron", "completed", { action }, { details: {} }),
      ).toBeNull();
    }
  });

  it("an ERRORED call yields null (nothing was mutated)", () => {
    expect(cronPartFromTool("cron", "error", ADD_INPUT, ADD_OUTPUT)).toBeNull();
  });

  it("other tools yield null", () => {
    expect(
      cronPartFromTool("web_search", "completed", { action: "add" }, {}),
    ).toBeNull();
  });

  it("caps the message and field lengths (bounded part by construction)", () => {
    const p = cronPartFromTool(
      "cron",
      "completed",
      {
        action: "add",
        job: {
          name: "n".repeat(500),
          payload: { message: "m".repeat(1000) },
        },
      },
      {},
    );
    expect(p?.name?.length).toBe(200);
    expect(p?.message?.length).toBe(300);
  });
});

describe("printableCronSchedule", () => {
  it("renders every-ms cadences in human units", () => {
    expect(printableCronSchedule({ kind: "every", everyMs: 3_600_000 })).toBe(
      "every 1h",
    );
    expect(printableCronSchedule({ kind: "every", everyMs: 90_000 })).toBe(
      "every 90s",
    );
  });
  it("renders at-timestamps and bare strings", () => {
    expect(printableCronSchedule({ kind: "at", at: "2026-08-01T09:00:00Z" })).toBe(
      "at 2026-08-01T09:00:00Z",
    );
    expect(printableCronSchedule("every 1h")).toBe("every 1h");
  });
});

// --- integration: RunManager feeds the captured frames -> addCronPart --------

import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type {
  ConvexWriter,
  FinalizeStatus,
  ToolPart,
} from "../src/convex-writer.js";
import type { CronPart } from "../src/core/cron-part.js";

const SESSION_KEY = "agent:alice:atrium:chat:olivier:cronchat1";
const RUN_ID = "webchat-cronrun1";

function agentToolFrame(data: Record<string, unknown>): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: RUN_ID,
      stream: "tool",
      sessionKey: SESSION_KEY,
      isHeartbeat: false,
      data,
    },
  };
}

class SinkWriter implements ConvexWriter {
  toolParts: ToolPart[] = [];
  cronParts: CronPart[] = [];
  async startAssistant(): Promise<string> {
    return "msg_cron_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<void> {}
  async addToolPart(_m: string, p: ToolPart): Promise<void> {
    this.toolParts.push(p);
  }
  async addCronPart(_m: string, p: CronPart): Promise<void> {
    this.cronParts.push(p);
  }
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
  ): Promise<void> {}
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

describe("turn-sink integration: cron tool frames emit ONE cron part", () => {
  it("start(args)+result(job) -> tool part AND cron part; list stays tool-only", async () => {
    const writer = new SinkWriter();
    const manager = new RunManager("cronchat1", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), RUN_ID);
    // A read-only list call first (must NOT produce a cron part).
    await manager.feed(
      agentToolFrame({
        name: "cron",
        phase: "start",
        toolCallId: "call_L|fc_L",
        args: { action: "list", includeDisabled: true },
      }),
      (now += 1),
    );
    await manager.feed(
      agentToolFrame({
        name: "cron",
        phase: "result",
        toolCallId: "call_L|fc_L",
        isError: false,
        result: { content: [], details: { jobs: [] } },
      }),
      (now += 1),
    );
    // Then the real add (captured shape).
    await manager.feed(
      agentToolFrame({
        name: "cron",
        phase: "start",
        toolCallId: "call_A|fc_A",
        args: ADD_INPUT,
      }),
      (now += 1),
    );
    await manager.feed(
      agentToolFrame({
        name: "cron",
        phase: "result",
        toolCallId: "call_A|fc_A",
        isError: false,
        result: ADD_OUTPUT,
      }),
      (now += 1),
    );
    expect(writer.toolParts.filter((t) => t.name === "cron")).toHaveLength(2);
    expect(writer.cronParts).toHaveLength(1);
    expect(writer.cronParts[0]).toMatchObject({
      kind: "cron",
      op: "created",
      jobId: "10f525c0-5085-480c-9a8c-c7c246954a3f",
      name: "rappel-cafe",
    });
  });
});
