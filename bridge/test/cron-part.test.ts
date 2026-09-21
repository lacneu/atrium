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

  it("reads the 2026.8.x wire name `automations` exactly like `cron` (captured 2026-09-02)", () => {
    // Same args, same job JSON result — only the tool name changed at 2026.8.1.
    expect(cronPartFromTool("automations", "completed", ADD_INPUT, ADD_OUTPUT)).toEqual(
      cronPartFromTool("cron", "completed", ADD_INPUT, ADD_OUTPUT),
    );
    expect(cronPartFromTool("automations", "completed", ADD_INPUT, ADD_OUTPUT)?.op).toBe(
      "created",
    );
    // Fail closed: no other spelling is the scheduler tool.
    expect(cronPartFromTool("automation", "completed", ADD_INPUT, ADD_OUTPUT)).toBeNull();
    expect(cronPartFromTool("cron_add", "completed", ADD_INPUT, ADD_OUTPUT)).toBeNull();
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
  async setSnapshot(): Promise<boolean> {
    return true;
  }
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
  async reportSessionRoster(): Promise<void> {}
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
    // Each cron call now emits start + completed (same toolCallId — Convex's
    // upsert collapses the pair into one card): 2 calls -> 4 raw parts.
    const cronParts = writer.toolParts.filter((t) => t.name === "cron");
    expect(cronParts).toHaveLength(4);
    expect(cronParts.map((t) => t.phase)).toEqual([
      "start",
      "completed",
      "start",
      "completed",
    ]);
    expect(cronParts[0]!.toolCallId).toBe(cronParts[1]!.toolCallId);
    expect(cronParts[2]!.toolCallId).toBe(cronParts[3]!.toolCallId);
    expect(writer.cronParts).toHaveLength(1);
    expect(writer.cronParts[0]).toMatchObject({
      kind: "cron",
      op: "created",
      jobId: "10f525c0-5085-480c-9a8c-c7c246954a3f",
      name: "rappel-cafe",
    });
  });
});

describe("declarative convergence: the job arrives WRAPPED", () => {
  // Upstream declares TWO shapes for the same `add`, in its own output contract
  // (src/agents/tools/cron-tool.output-contract.test.ts:95-104):
  //   plain creation          -> { ...job, deliveryPreview }   — the job FLAT
  //   declarative convergence -> { created, updated, job, … }  — the job NESTED
  // The second is what an `add` carrying a `declarationKey` answers. Reading only
  // the flat shape, the extraction returned nothing and the card fell back to the
  // INPUT — losing the SERVER-ASSIGNED id, which is what every later operation
  // addresses the job by. Captured on the live bench, 2026-09-20.
  const DECLARATIVE_INPUT = {
    action: "add",
    job: {
      name: "bench-cron",
      declarationKey: "bench-cron",
      schedule: { kind: "cron", expr: "0 5 1 1 *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "bench" },
    },
  };
  const WRAPPED = {
    created: true,
    job: {
      id: "d47d5e1c-6b66-4717-b127-6616efc77a9e",
      declarationKey: "bench-cron",
      name: "bench-cron",
      agentId: "alice",
      enabled: true,
      schedule: { kind: "cron", expr: "0 5 1 1 *", tz: "UTC" },
    },
    deliveryPreview: { mode: "announce" },
  };

  it("takes the server id out of the wrapper, from `details`", () => {
    const part = cronPartFromTool("automations", "completed", DECLARATIVE_INPUT, {
      content: [{ type: "text", text: JSON.stringify(WRAPPED) }],
      details: WRAPPED,
    });
    expect(part).toMatchObject({
      kind: "cron",
      op: "created",
      jobId: "d47d5e1c-6b66-4717-b127-6616efc77a9e",
      name: "bench-cron",
      enabled: true,
    });
  });

  it("…and from the TEXT block when `details` is absent", () => {
    // The two carriers must be unwrapped by the same rule: a gateway that sends
    // only the text block must not lose the id the other path keeps.
    const part = cronPartFromTool("automations", "completed", DECLARATIVE_INPUT, {
      content: [{ type: "text", text: JSON.stringify(WRAPPED) }],
    });
    expect(part?.jobId).toBe("d47d5e1c-6b66-4717-b127-6616efc77a9e");
  });

  it("a FLAT job is still read flat — the wrapper is tried second", () => {
    // Order matters: a job that legitimately carried a `job` field of its own must
    // never be mistaken for the wrapper.
    const flat = { id: "flat-1", name: "plain", job: { id: "decoy" } };
    const part = cronPartFromTool("automations", "completed", DECLARATIVE_INPUT, {
      content: [],
      details: flat,
    });
    expect(part?.jobId).toBe("flat-1");
  });

  it("a wrapper carrying NO job leaves the extraction empty, not wrong", () => {
    const part = cronPartFromTool("automations", "completed", DECLARATIVE_INPUT, {
      content: [],
      details: { created: false, updated: false },
    });
    // The input has no id to fall back on either, so the card simply carries none —
    // never an id invented from the wrapper.
    expect(part?.jobId).toBeUndefined();
  });
});

// THE CARD THAT SAID "CREATED" WHEN NOTHING WAS CREATED.
//
// The op was read from `input.action` — what the AGENT ASKED FOR — and the
// scheduler does not always do it:
//
//   * A DECLARATIVE `add` (one carrying a `declarationKey`) CONVERGES. Upstream
//     answers `{created, updated?, job, deliveryPreview}`: `created:false,
//     updated:true` when it rewrote an existing job, and `created:false,
//     updated:false` when the job already matched. Both rendered "Created".
//   * `remove` answers `{ok, removed}` and does NOT throw when there was nothing
//     to remove. `removed:false` rendered "Removed".
//
// A scheduler card is read exactly once — to check the job is there. A false
// creation is only discovered when it fails to fire.
describe("the cron card states what the scheduler DID", () => {
  const JOB = { id: "j-1", name: "rapport", schedule: "0 8 * * *", enabled: true };
  const out = (details: Record<string, unknown>) => ({
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  });

  it("a declarative add that only UPDATED says Updated, not Created", () => {
    const part = cronPartFromTool(
      "automations",
      "completed",
      { action: "add", declarationKey: "daily-report", job: JOB },
      out({ ...JOB, created: false, updated: true, job: JOB }),
    );
    expect(part?.op).toBe("updated");
  });

  it("a declarative add that converged to a NO-OP says neither", () => {
    const part = cronPartFromTool(
      "automations",
      "completed",
      { action: "add", declarationKey: "daily-report", job: JOB },
      out({ ...JOB, created: false, updated: false, job: JOB }),
    );
    expect(part?.op).toBe("unchanged");
  });

  it("a genuine creation is untouched", () => {
    const part = cronPartFromTool(
      "automations",
      "completed",
      { action: "add", job: JOB },
      out({ ...JOB, created: true, job: JOB }),
    );
    expect(part?.op).toBe("created");
    expect(part?.jobId).toBe("j-1");
  });

  it("an UNSUCCESSFUL remove never reaches this verdict at all", () => {
    // Written first as "removed:false must say Unchanged, not Removed" — a repair
    // for a defect that does not exist. Verified upstream: the gateway answers
    // CRON_JOB_NOT_FOUND when nothing was removed (server-methods/cron.ts:1155-1158),
    // so the TOOL errors and the phase is never "completed". The card that said
    // "Removed" for a deletion that never happened was never produced.
    expect(
      cronPartFromTool(
        "cron",
        "error",
        { action: "remove", jobId: "j-gone" },
        out({ ok: false, removed: false }),
      ),
      "an errored call changes nothing worth surfacing",
    ).toBeNull();
  });

  it("a real removal still says Removed", () => {
    const part = cronPartFromTool(
      "cron",
      "completed",
      { action: "remove", jobId: "j-1" },
      out({ ok: true, removed: true }),
    );
    expect(part?.op).toBe("removed");
  });

  it("a gateway that states NO verdict keeps the asked-for op", () => {
    // An older generation answers with a bare job body. Silence is not evidence
    // that nothing happened, and inventing "unchanged" there would be the same
    // class of false fact in the other direction.
    const part = cronPartFromTool(
      "cron",
      "completed",
      { action: "add", job: JOB },
      out({ ...JOB }),
    );
    expect(part?.op).toBe("created");
  });

  it("the verdict is read from the TEXT block when `details` is absent", () => {
    // The two readers must never take the verdict and the job body from
    // different copies of the same answer.
    const body = { ...JOB, created: false, updated: true, job: JOB };
    const part = cronPartFromTool(
      "automations",
      "completed",
      { action: "add", declarationKey: "k", job: JOB },
      { content: [{ type: "text", text: JSON.stringify(body) }] },
    );
    expect(part?.op).toBe("updated");
    expect(part?.name).toBe("rapport");
  });
});
