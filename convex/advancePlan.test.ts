import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

// advancePlanPart — the plan-progress path for DELIVERY runs (sub-agent
// announce / task delivery): those runs carry no tool frames, so only "the
// plan moved N times this turn" reaches the wire (the item meta names the
// plan's FIRST step — useless for targeting). The mutation advances the
// message's last known plan one step per call — or SETTLES it when the turn
// left the pipeline idle — and stamps the new part `estimated`.

const STEPS = [
  { step: "Auditer les slides", status: "completed" as const },
  { step: "Reconstruire les cinq slides", status: "in_progress" as const },
  { step: "Controler le rendu", status: "pending" as const },
  { step: "Livrer le PPTX final", status: "pending" as const },
];

async function seedPlanMessage(
  t: ReturnType<typeof convexTest>,
  opts?: {
    runId?: string;
    withPlan?: boolean;
    steps?: typeof STEPS;
    withRunningChild?: boolean;
  },
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "Plan posé.",
      runId: opts?.runId ?? "webchat-plan-run",
      updatedAt: 1000,
    });
    if (opts?.withPlan !== false) {
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: { kind: "plan" as const, steps: opts?.steps ?? STEPS },
      });
    }
    if (opts?.withRunningChild) {
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "agent:files:subagent:run-1111-2222-3333-444455556666",
        status: "running" as const,
        createdAt: 900,
        updatedAt: 950,
      });
    }
    return { chatId, messageId };
  });
}

async function planParts(
  t: ReturnType<typeof convexTest>,
  messageId: Id<"messages">,
) {
  return t.run(async (ctx) => {
    // collect+filter: the untyped test ctx erases the schema's index types.
    const rows = await ctx.db.query("messageParts").collect();
    return rows
      .filter((r) => r.messageId === messageId && r.part.kind === "plan")
      .sort((a, b) => a.order - b.order)
      .map((r) => r.part);
  });
}

function statuses(part: { kind: string; steps?: { status: string }[] }) {
  if (part.kind !== "plan" || part.steps === undefined) {
    throw new Error("expected a plan part");
  }
  return part.steps.map((s) => s.status);
}

describe("stream.advancePlanPart", () => {
  test("one call advances one step: current completed, next in_progress, stamped estimated", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedPlanMessage(t, { withRunningChild: true });
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 1,
    });
    const parts = await planParts(t, messageId);
    expect(parts).toHaveLength(2);
    expect(statuses(parts[1] as never)).toEqual([
      "completed",
      "completed",
      "in_progress",
      "pending",
    ]);
    expect((parts[1] as { estimated?: boolean }).estimated).toBe(true);
  });

  test("count is bounded and cumulative (two calls advance two steps)", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedPlanMessage(t, { withRunningChild: true });
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 2,
    });
    const parts = await planParts(t, messageId);
    expect(statuses(parts[1] as never)).toEqual([
      "completed",
      "completed",
      "completed",
      "in_progress",
    ]);
  });

  test("settleIfIdle + no running child settles the whole plan", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedPlanMessage(t);
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 1,
      settleIfIdle: true,
    });
    const parts = await planParts(t, messageId);
    expect(statuses(parts[1] as never)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
  });

  test("settleIfIdle with a RUNNING child falls back to advance-by-one", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedPlanMessage(t, { withRunningChild: true });
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 1,
      settleIfIdle: true,
    });
    const parts = await planParts(t, messageId);
    expect(statuses(parts[1] as never)).toEqual([
      "completed",
      "completed",
      "in_progress",
      "pending",
    ]);
  });

  test("no-ops on zero count, no plan part, or an already-final plan", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedPlanMessage(t);
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 0,
    });
    expect(await planParts(t, messageId)).toHaveLength(1);
    const bare = await seedPlanMessage(t, { withPlan: false });
    await t.mutation(internal.stream.advancePlanPart, {
      messageId: bare.messageId,
      count: 1,
    });
    expect(await planParts(t, bare.messageId)).toHaveLength(0);
    const finalPlan = await seedPlanMessage(t, {
      steps: STEPS.map((s) => ({ ...s, status: "completed" as const })),
    });
    await t.mutation(internal.stream.advancePlanPart, {
      messageId: finalPlan.messageId,
      count: 1,
    });
    expect(await planParts(t, finalPlan.messageId)).toHaveLength(1);
  });

  test("an ARMED replay window dedupes the rebroadcast's advance (same announce run)", async () => {
    const t = convexTest(schema, modules);
    const RUN = "announce:v1:agent:files:subagent:x:y";
    const { messageId } = await seedPlanMessage(t, {
      runId: RUN,
      withRunningChild: true,
    });
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 1,
    });
    expect(await planParts(t, messageId)).toHaveLength(2);
    // Bridge restart -> the announce rebroadcasts: the reopen arms the replay
    // window, then the replayed frames re-request the same advance.
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, {
        announceReplayArmed: Date.now() + 60_000,
        announceReplayRun: RUN,
      });
    });
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 1,
    });
    expect(await planParts(t, messageId)).toHaveLength(2);
    // Window expired -> a NEW legitimate advance still lands.
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, {
        announceReplayArmed: undefined,
        announceReplayRun: undefined,
      });
    });
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 1,
    });
    expect(await planParts(t, messageId)).toHaveLength(3);
  });

  test("an advance from a run ALREADY MERGED into the bubble survives the runId rotation", async () => {
    const t = convexTest(schema, modules);
    const RUN_N = "announce:v1:agent:files:subagent:x:turnN";
    const RUN_N1 = "announce:v1:agent:files:subagent:y:turnN1";
    const { messageId } = await seedPlanMessage(t, {
      runId: RUN_N1,
      withRunningChild: true,
    });
    // Turn N merged here, then turn N+1 reopened the bubble (runId rotated)
    // before turn N's advance landed.
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { mergedAnnounceRuns: [RUN_N] });
    });
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 1,
      expectedRunId: RUN_N,
    });
    expect(await planParts(t, messageId)).toHaveLength(2);
    // A run foreign to the bubble stays rejected.
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 1,
      expectedRunId: "announce:v1:agent:files:subagent:z:foreign",
    });
    expect(await planParts(t, messageId)).toHaveLength(2);
  });

  test("generation guard: a stale run must not advance a re-owned message", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedPlanMessage(t, {
      runId: "announce:v1:agent:files:subagent:x:y",
      withRunningChild: true,
    });
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 1,
      expectedRunId: "announce:v1:agent:files:subagent:x:STALE",
    });
    expect(await planParts(t, messageId)).toHaveLength(1);
    await t.mutation(internal.stream.advancePlanPart, {
      messageId,
      count: 1,
      expectedRunId: "announce:v1:agent:files:subagent:x:y",
    });
    expect(await planParts(t, messageId)).toHaveLength(2);
  });
});
