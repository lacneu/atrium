/// <reference types="vite/client" />
//
// A PRIVATE ANNOUNCE TURN, FROM THE TRANSCRIPT ALONE (OpenClaw 2026.10.33). A sub-agent
// spawned with `completionTarget:"parent"` returns its result in a private requester turn:
// the gateway broadcasts no `agent` and no `chat` frame for the run `announce:v1:…`
// (src/agents/command/session-preparation.ts:160-174). No live bubble is ever opened for
// it; what reaches Convex is the reconciler's reads — the session's `hasActiveRun` /
// `activeRunIds`, then the rows.
//
// The applies replayed here are the bridge hop's own output for the sequence captured on
// the bench (bridge/test/private-announce-turn.test.ts →
// bridge/test/fixtures/private-announce-projected-2026.10.33.json). The parent's turn
// before it is built by hand (it is not in the capture).
//
// Pinned: the conversation is held busy by the gateway's fact from the first read; the
// answer is born from the rows when the idle read comes, in the parent's display group,
// with its tool cards; the run's spawn is recorded under it. Fixed here: the work plan the
// turn advanced (`progress_card`) is on the born bubble — the live path reads it from the
// `plan` stream, which a private run does not have.

import { readFileSync } from "node:fs";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { currentPlanIndex } from "./lib/planOrder";
import { planPartOfRowTool } from "./lib/rowParts";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Apply = Record<string, unknown> & { kind: string; rows: Array<Record<string, unknown>>; hasActiveRun?: boolean };

const projected = JSON.parse(
  readFileSync(new URL("../bridge/test/fixtures/private-announce-projected-2026.10.33.json", import.meta.url), "utf8"),
) as { sessionKey: string; announceRunId: string; applies: Apply[] };

const SK = projected.sessionKey;
const ANNOUNCE = projected.announceRunId;
const SESSION_ID = "aaaaaaaa-0000-4000-8000-000000000001";
/** The parent's own run, and the child whose result the announce run brings back. */
const ROOT = "webchat-root-run";
const CHILD_KEY = "agent:files:subagent:aaaaaaaa-0000-4000-8000-000000000002";
const CHILD_RUN = "aaaaaaaa-0000-4000-8000-000000000003";
const SPAWNED = { childSessionKey: "agent:files:subagent:aaaaaaaa-0000-4000-8000-000000000011", childRunId: "aaaaaaaa-0000-4000-8000-000000000012" };
const ANSWER = "La première tâche est terminée ; la seconde est lancée.";
const ADVANCED = [
  { step: "Étape A : première tâche files", status: "completed" },
  { step: "Étape B : seconde tâche files", status: "in_progress" },
  { step: "Étape C : réponse finale", status: "pending" },
];

const firstIdle = projected.applies.findIndex((a) => a.hasActiveRun === false);
const DURING = projected.applies.slice(0, firstIdle);
const AFTER = projected.applies.slice(firstIdle);

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
  vi.useFakeTimers();
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  vi.useRealTimers();
});

const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

function applyRaw(t: T, chatId: Id<"chats">, body: Record<string, unknown>) {
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: SESSION_ID,
    terminals: [],
    unidentified: 0,
    ...body,
    chatId,
  } as never);
}
/** One apply of the capture, as the bridge posted it. */
const replay = async (t: T, chatId: Id<"chats">, applies: readonly Apply[]) => {
  for (const a of applies) await applyRaw(t, chatId, a);
};

/**
 * The conversation as the parent's turn left it: the user's message, the parent's answer
 * followed LIVE (its bubble, its plan from the `plan` stream — stamped by the sink) and
 * settled by its terminal, and the row by which that run launched the sub-agent.
 */
async function seed(t: T) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "alice", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "alice" });
    await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "mission", sendId: ROOT, updatedAt: 1 });
    return { userId, chatId };
  });
  await applyRaw(t, ids.chatId, { kind: "page", rows: [], readAt: 900, hasActiveRun: true, activeRunIds: [ROOT] });
  const root = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: ROOT, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
  await t.mutation(internal.stream.addPart, {
    messageId: root,
    part: {
      kind: "plan",
      steps: [
        { step: "Étape A : première tâche files", status: "in_progress" },
        { step: "Étape B : seconde tâche files", status: "pending" },
        { step: "Étape C : réponse finale", status: "pending" },
      ],
      explanation: "0/3 complete",
      stamp: Date.now() / 1000,
    },
    boundInstanceName: "prod",
  } as never);
  await t.mutation(internal.stream.finalize, { messageId: root, status: "complete", text: "La première tâche est lancée.", expectedRunId: ROOT, boundInstanceName: "prod" } as never);
  await applyRaw(t, ids.chatId, {
    kind: "delta",
    deltaCursor: "cursor-0",
    readAt: 950,
    rows: [
      { entryId: "root-spawn", seq: 88, role: "custom", runId: ROOT, hidden: false, visible: false, spawns: [{ childSessionKey: CHILD_KEY, childRunId: CHILD_RUN }] },
      { entryId: "root-answer", seq: 90, role: "assistant", runId: ROOT, hidden: false, visible: true, text: "La première tâche est lancée.", stopReason: "stop" },
    ],
    terminals: [{ runId: ROOT, status: "completed", at: 940 }],
    hasActiveRun: false,
    activeRunIds: [],
  });
  await settle(t);
  return { ...ids, root };
}

const bubblesOf = (t: T, chatId: Id<"chats">, runId: string) =>
  t.run(async (ctx) => (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter((m) => m.runId === runId));
const partsOf = (t: T, messageId: Id<"messages">) =>
  t.run(async (ctx) => (await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect()).sort((a, b) => a.order - b.order));
const plansOf = (parts: Doc<"messageParts">[]) => parts.flatMap((p) => (p.part.kind === "plan" ? [p.part] : []));
const workingUntil = async (t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }) =>
  ((await t.withIdentity({ subject: ids.userId }).query(api.followUp.followUpState, { chatId: ids.chatId })) as { workingUntil?: number | null }).workingUntil ?? null;
const announceRun = (t: T, chatId: Id<"chats">) =>
  t.run((ctx) => ctx.db.query("transcriptRuns").withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", ANNOUNCE)).first());

describe("the fixture is the capture's private announce turn", () => {
  test("reads that say the run works, then the idle read — and no terminal anywhere", () => {
    expect(DURING.length).toBeGreaterThan(0);
    expect(AFTER.length).toBeGreaterThan(0);
    expect(DURING.filter((a) => a.kind === "delta").every((a) => a.hasActiveRun === true)).toBe(true);
    expect(projected.applies.flatMap((a) => (a.terminals as unknown[]) ?? [])).toEqual([]);
  });
});

describe("while the private turn runs", () => {
  test("the conversation is held by the gateway's fact from the FIRST read, before any row", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    expect(await workingUntil(t, ids)).toBeNull();
    expect(DURING[0]!.rows).toEqual([]);
    await replay(t, ids.chatId, DURING.slice(0, 1));
    expect(await workingUntil(t, ids)).not.toBeNull();
  });

  test("it stays held through every read of the turn, and no bubble exists for the run yet", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    for (const a of DURING) {
      await applyRaw(t, ids.chatId, a);
      expect(await workingUntil(t, ids)).not.toBeNull();
    }
    await settle(t);
    // A bubble is born from rows only once its run is over (lib/bubbleProjection.ts).
    expect(await bubblesOf(t, ids.chatId, ANNOUNCE)).toEqual([]);
    expect((await announceRun(t, ids.chatId))?.settledAt).toBeUndefined();
    // The hold names the run, so a send made now is the gateway's to queue.
    const cursor = await t.run((ctx) => ctx.db.query("transcriptCursors").withIndex("by_chat_updated", (q) => q.eq("chatId", ids.chatId)).order("desc").first());
    expect(cursor).toMatchObject({ hasActiveRun: true, activeRunIds: [ANNOUNCE] });
  });
});

describe("when the read that follows `phase:end` finds the session idle", () => {
  async function ended(t: T) {
    const ids = await seed(t);
    await replay(t, ids.chatId, DURING);
    await replay(t, ids.chatId, AFTER.slice(0, 1));
    await settle(t);
    return ids;
  }

  test("the conversation is released", async () => {
    const t = convexTest(schema, modules);
    const ids = await ended(t);
    expect(await workingUntil(t, ids)).toBeNull();
    expect((await announceRun(t, ids.chatId))?.settledAt).toBeDefined();
  });

  test("ONE bubble is born for the run, complete, with the answer and its tool cards", async () => {
    const t = convexTest(schema, modules);
    const ids = await ended(t);
    const born = await bubblesOf(t, ids.chatId, ANNOUNCE);
    expect(born.length).toBe(1);
    expect(born[0]).toMatchObject({ role: "assistant", status: "complete", text: ANSWER, finalizeCause: "transcript_settled" });
    // No terminal of the run was observed: its `complete` is the idle read's inference.
    expect(born[0]!.closeInferred).toBe(true);
    const tools = (await partsOf(t, born[0]!._id)).flatMap((p) => (p.part.kind === "tool" ? [`${p.part.name}:${p.part.phase}`] : []));
    expect(tools.sort()).toEqual(["exec:completed", "exec:completed", "message:completed", "progress_card:completed", "sessions_spawn:completed"]);
  });

  test("it joins the parent's answer in ONE display group, and its launch is recorded under it", async () => {
    const t = convexTest(schema, modules);
    const ids = await ended(t);
    const [born] = await bubblesOf(t, ids.chatId, ANNOUNCE);
    const root = await t.run((ctx) => ctx.db.get(ids.root));
    expect(root?.displayGroupId).toBeDefined();
    expect(born!.displayGroupId).toBe(root!.displayGroupId);
    const spawns = await t.run((ctx) => ctx.db.query("transcriptSpawns").collect());
    expect(spawns.filter((s) => s.childRunId === SPAWNED.childRunId)).toMatchObject([{ parentRunId: ANNOUNCE, childSessionKey: SPAWNED.childSessionKey }]);
  });

  test("the plan the turn advanced is on the born bubble", async () => {
    const t = convexTest(schema, modules);
    const ids = await ended(t);
    const [born] = await bubblesOf(t, ids.chatId, ANNOUNCE);
    expect(plansOf(await partsOf(t, born!._id))).toEqual([{ kind: "plan", steps: ADVANCED }]);
    // The parent's own plan, read from its live stream, is untouched.
    const rootPlans = plansOf(await partsOf(t, ids.root));
    expect(rootPlans.length).toBe(1);
    expect(rootPlans[0]).toMatchObject({ explanation: "0/3 complete" });
  });

  test("the reads that follow change nothing: one bubble, one plan", async () => {
    const t = convexTest(schema, modules);
    const ids = await ended(t);
    await replay(t, ids.chatId, AFTER.slice(1));
    // …and the whole turn read again (a reconnect's replay).
    await replay(t, ids.chatId, projected.applies.map((a, i) => ({ ...a, readAt: 5000 + i })));
    await settle(t);
    const born = await bubblesOf(t, ids.chatId, ANNOUNCE);
    expect(born.length).toBe(1);
    const parts = await partsOf(t, born[0]!._id);
    expect(plansOf(parts).length).toBe(1);
    expect(parts.filter((p) => p.part.kind === "tool").length).toBe(5);
    expect(await workingUntil(t, ids)).toBeNull();
  });
});

describe("a run followed LIVE keeps the plan of its stream", () => {
  const RUN = "webchat-live-run";
  const CALL = "tool_call:call_x_fc_y:abc:progress_card:1";
  const rows = [
    {
      entryId: "p1",
      seq: 201,
      role: "custom",
      runId: RUN,
      hidden: false,
      visible: false,
      blocks: [
        { type: "tool", toolCallId: CALL, name: "progress_card", status: "call", input: { plan: ADVANCED } },
        { type: "tool", toolCallId: CALL, name: "progress_card", status: "result", output: { content: [] } },
      ],
    },
    { entryId: "p2", seq: 202, role: "assistant", runId: RUN, hidden: false, visible: true, text: "fait", blocks: [{ type: "text", text: "fait" }], stopReason: "stop" },
  ];
  const over = { kind: "delta", deltaCursor: "cursor-live", readAt: 2000, rows, terminals: [{ runId: RUN, status: "completed", at: 1990 }], hasActiveRun: false, activeRunIds: [] };

  async function liveBubble(t: T, chatId: Id<"chats">, parts: Array<Record<string, unknown>>) {
    const m = (await t.mutation(internal.stream.startAssistant, { chatId, runId: RUN, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    for (const part of parts) await t.mutation(internal.stream.addPart, { messageId: m, part, boundInstanceName: "prod" } as never);
    await t.mutation(internal.stream.finalize, { messageId: m, status: "complete", text: "fait", expectedRunId: RUN, boundInstanceName: "prod" } as never);
    return m;
  }
  const livePlan = { kind: "plan", steps: ADVANCED, explanation: "1/3 complete", stamp: 1_700_000_000 };

  test("its card was shown live: the rows add neither a card nor a plan", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await liveBubble(t, ids.chatId, [livePlan, { kind: "tool", name: "progress_card", phase: "completed", toolCallId: CALL, textOffset: 0 }]);
    await applyRaw(t, ids.chatId, over);
    await settle(t);
    const parts = await partsOf(t, m);
    expect(plansOf(parts)).toEqual([livePlan]);
    expect(parts.filter((p) => p.part.kind === "tool").length).toBe(1);
  });

  test("its plan came by the stream but the card did not: the rows give the card, never a second plan", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await liveBubble(t, ids.chatId, [livePlan]);
    await applyRaw(t, ids.chatId, over);
    await settle(t);
    const parts = await partsOf(t, m);
    expect(parts.filter((p) => p.part.kind === "tool").map((p) => (p.part.kind === "tool" ? p.part.toolCallId : null))).toEqual([CALL]);
    expect(plansOf(parts)).toEqual([livePlan]);
  });
});

describe("a card the live stream left OPEN, completed by the rows (the socket closed while the tool ran)", () => {
  const RUN = "webchat-cut-run";
  const CALL = "tool_call:call_x_fc_y:abc:progress_card:1";
  const rows = [
    {
      entryId: "c1",
      seq: 401,
      role: "custom",
      runId: RUN,
      hidden: false,
      visible: false,
      blocks: [
        { type: "tool", toolCallId: CALL, name: "progress_card", status: "call", input: { plan: ADVANCED } },
        { type: "tool", toolCallId: CALL, name: "progress_card", status: "result", output: { content: [] } },
      ],
    },
    { entryId: "c2", seq: 402, role: "assistant", runId: RUN, hidden: false, visible: true, text: "fait", blocks: [{ type: "text", text: "fait" }], stopReason: "stop" },
  ];
  const over = { kind: "delta", deltaCursor: "cursor-cut", readAt: 4000, rows, terminals: [{ runId: RUN, status: "completed", at: 3990 }], hasActiveRun: false, activeRunIds: [] };

  /** The bubble as the dead socket left it: streaming, its one card `started`, no plan. */
  async function cutBubble(t: T, chatId: Id<"chats">) {
    const m = (await t.mutation(internal.stream.startAssistant, { chatId, runId: RUN, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    await t.mutation(internal.stream.addPart, {
      messageId: m,
      part: { kind: "tool", name: "progress_card", phase: "started", toolCallId: CALL, textOffset: 0 },
      boundInstanceName: "prod",
    } as never);
    return m;
  }

  test("the card gets its arguments and result, AND the plan its call states is derived — once", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await cutBubble(t, ids.chatId);
    await applyRaw(t, ids.chatId, over);
    await settle(t);
    let parts = await partsOf(t, m);
    expect(parts.filter((p) => p.part.kind === "tool").map((p) => (p.part.kind === "tool" ? [p.part.toolCallId, p.part.phase, p.part.input] : null))).toEqual([
      [CALL, "completed", { plan: ADVANCED }],
    ]);
    expect(plansOf(parts)).toEqual([{ kind: "plan", steps: ADVANCED }]);
    // Read again (a reconnect's replay): the card and the plan are found, not doubled.
    await applyRaw(t, ids.chatId, { ...over, deltaCursor: "cursor-cut-2", readAt: 4100 });
    await settle(t);
    parts = await partsOf(t, m);
    expect(parts.filter((p) => p.part.kind === "tool").length).toBe(1);
    expect(plansOf(parts).length).toBe(1);
  });
});

describe("a `progress_card` call that CLEARS the checklist (`plan: []`)", () => {
  const RUN = "announce:v1:agent:files:subagent:k:clear";
  const call = (n: number, plan: unknown) => {
    const id = `tool_call:call_x_fc_y:abc:progress_card:${n}`;
    return [
      { type: "tool", toolCallId: id, name: "progress_card", status: "call", input: { plan } },
      { type: "tool", toolCallId: id, name: "progress_card", status: "result", output: { content: [] } },
    ];
  };

  test("after a plan in the same bubble: an empty plan is derived, and it is the current one", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await applyRaw(t, ids.chatId, {
      kind: "delta",
      deltaCursor: "cursor-clear",
      readAt: 3000,
      rows: [
        { entryId: "k1", seq: 301, role: "custom", runId: RUN, hidden: false, visible: false, blocks: call(1, ADVANCED) },
        { entryId: "k2", seq: 302, role: "custom", runId: RUN, hidden: false, visible: false, blocks: call(2, []) },
        { entryId: "k3", seq: 303, role: "assistant", runId: RUN, hidden: false, visible: true, text: "fin", blocks: [{ type: "text", text: "fin" }], stopReason: "stop" },
      ],
      hasActiveRun: false,
      activeRunIds: [],
    });
    await settle(t);
    const [born] = await bubblesOf(t, ids.chatId, RUN);
    const plans = plansOf(await partsOf(t, born!._id));
    expect(plans).toEqual([{ kind: "plan", steps: ADVANCED }, { kind: "plan", steps: [] }]);
    expect(currentPlanIndex(plans)).toBe(1);
  });
});

describe("only a call the transcript gives a result to states a plan", () => {
  const RUN = "announce:v1:agent:files:subagent:k:r";
  const CALL = "tool_call:call_x_fc_y:abc:progress_card:1";
  const bornFrom = async (t: T, second: Record<string, unknown> | null) => {
    const ids = await seed(t);
    const blocks: Array<Record<string, unknown>> = [{ type: "tool", toolCallId: CALL, name: "progress_card", status: "call", input: { plan: ADVANCED } }];
    if (second !== null) blocks.push({ type: "tool", toolCallId: CALL, name: "progress_card", ...second });
    await applyRaw(t, ids.chatId, {
      kind: "delta",
      deltaCursor: "cursor-born",
      readAt: 3000,
      rows: [
        { entryId: "q1", seq: 301, role: "custom", runId: RUN, hidden: false, visible: false, blocks },
        { entryId: "q2", seq: 302, role: "assistant", runId: RUN, hidden: false, visible: true, text: "fin", blocks: [{ type: "text", text: "fin" }], stopReason: "stop" },
      ],
      hasActiveRun: false,
      activeRunIds: [],
    });
    await settle(t);
    const [born] = await bubblesOf(t, ids.chatId, RUN);
    return partsOf(t, born!._id);
  };

  test("a call with its result: the plan", async () => {
    const parts = await bornFrom(convexTest(schema, modules), { status: "result", output: { content: [] } });
    expect(plansOf(parts)).toEqual([{ kind: "plan", steps: ADVANCED }]);
  });

  test("a call the run ended without a result for: its card, no plan", async () => {
    const parts = await bornFrom(convexTest(schema, modules), null);
    expect(parts.filter((p) => p.part.kind === "tool").length).toBe(1);
    expect(plansOf(parts)).toEqual([]);
  });

  test("a call that failed: no plan", async () => {
    const parts = await bornFrom(convexTest(schema, modules), { status: "error", output: { content: [] } });
    expect(plansOf(parts)).toEqual([]);
  });
});

describe("planPartOfRowTool — the plan a row's call states", () => {
  test("reads `progress_card` and `update_plan` arguments, and nothing else", () => {
    expect(planPartOfRowTool("progress_card", { plan: ADVANCED })).toEqual({ kind: "plan", steps: ADVANCED });
    expect(planPartOfRowTool("update_plan", { explanation: "note", plan: ADVANCED })).toEqual({ kind: "plan", steps: ADVANCED, explanation: "note" });
    expect(planPartOfRowTool("exec", { plan: ADVANCED })).toBeNull();
    expect(planPartOfRowTool(undefined, { plan: ADVANCED })).toBeNull();
    expect(planPartOfRowTool("progress_card", undefined)).toBeNull();
    expect(planPartOfRowTool("progress_card", "plan")).toBeNull();
  });

  test("an unknown status is not done; malformed steps are skipped; the bounds are the live reader's", () => {
    expect(
      planPartOfRowTool("progress_card", { plan: [{ step: "a", status: "done" }, { step: "" }, null, { step: 3 }, { step: "b", status: "completed" }] }),
    ).toEqual({ kind: "plan", steps: [{ step: "a", status: "pending" }, { step: "b", status: "completed" }] });
    const many = Array.from({ length: 80 }, (_, i) => ({ step: `s${i}`.padEnd(400, "x"), status: "pending" }));
    const out = planPartOfRowTool("progress_card", { plan: many })!;
    expect(out.steps.length).toBe(50);
    expect(out.steps[0]!.step.length).toBe(300);
  });

  test("a `progress_card` without steps replaces the card: an empty plan; an unreadable one says nothing", () => {
    expect(planPartOfRowTool("progress_card", { markdown: "note" })).toEqual({ kind: "plan", steps: [] });
    expect(planPartOfRowTool("progress_card", { plan: "x" })).toBeNull();
    // An EMPTY array clears the checklist as an absent one does (upstream
    // `normalizeProgressCardInput`: no step → no `steps`, and the put replaces the card).
    expect(planPartOfRowTool("progress_card", { plan: [] })).toEqual({ kind: "plan", steps: [] });
    expect(planPartOfRowTool("update_plan", {})).toBeNull();
  });
});
