/// <reference types="vite/client" />
//
// ONE ANSWER PER DELEGATION CHAIN, COMPUTED FROM THE TRANSCRIPT — the Convex half
// (transcript redesign phase 5, design §14). On a projected conversation a delivery run
// opens its OWN bubble and the display groups it with its chain from identities: the
// launch rows the transcript shows, the task's starting run. `shadow` (and a rollback)
// keep 0.96.0's reopen, pinned next to it.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { regroupChat } from "./displayGroups";
import { cascadeDeleteChat } from "./chats";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Mode = "on" | "shadow";

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

const SK = "agent:main:atrium:chat:u:c1";
const P = "sendA";
const CHILD = "agent:files:subagent:0d59e951-cbaa-44f1-92e5-33b9729d096e";
const CHILD_RUN = "742ca132-060c-4cf8-8c0a-3f1377095ea3";
const A = `announce:v1:${CHILD}:${CHILD_RUN}`;
const CHILD_B = "agent:files:subagent:b";
const CHILD_C = "agent:files:subagent:c";
const TASK = "bf66f802-e5a6-4394-9815-40c4bcd28dae";

type Row = Record<string, unknown>;
const userRow = (entryId: string, seq: number, sendId: string): Row => ({
  entryId,
  seq,
  role: "user",
  runId: sendId,
  sendId,
  hidden: false,
  visible: true,
});
const said = (entryId: string, seq: number, runId: string, text: string): Row => ({
  entryId,
  seq,
  role: "assistant",
  runId,
  hidden: false,
  visible: true,
  text,
});
const launch = (entryId: string, seq: number, runId: string, childSessionKey: string, childRunId: string): Row => ({
  entryId,
  seq,
  role: "custom",
  runId,
  hidden: false,
  visible: true,
  spawns: [{ childSessionKey, childRunId }],
});

async function seed(t: T, mode: Mode) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "main", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: mode } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    const userMessageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "délègue",
      sendId: P,
      updatedAt: 1,
    });
    return { userId, chatId, userMessageId };
  });
  await apply(t, ids.chatId, [], { kind: "page" });
  return ids;
}

function apply(t: T, chatId: Id<"chats">, rows: Row[], extra: Record<string, unknown> = {}) {
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "delta",
    deltaCursor: `c:${Math.random()}`,
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    ...extra,
  } as never);
}

const start = (t: T, chatId: Id<"chats">, runId: string) =>
  t.mutation(internal.stream.startAssistant, { chatId, runId, turnSessionKey: SK, boundInstanceName: "prod" }) as Promise<Id<"messages"> | null>;
const finish = (t: T, messageId: Id<"messages">, text: string) =>
  t.mutation(internal.stream.finalize, { messageId, status: "complete", text } as never);
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const msg = (t: T, id: Id<"messages">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"messages">>;
const assistants = (t: T, chatId: Id<"chats">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter(
      (m) => m.role === "assistant",
    ),
  );

/** The turn P: its live bubble, its words and its launch row, settled by its terminal. */
async function turnWithLaunch(t: T, chatId: Id<"chats">, opts: { launchRead?: boolean } = {}) {
  const mP = (await start(t, chatId, P))!;
  await finish(t, mP, "Je délègue.");
  await apply(
    t,
    chatId,
    [
      userRow("u1", 1, P),
      said("a1", 2, P, "Je délègue."),
      ...(opts.launchRead === false ? [] : [launch("n1", 3, P, CHILD, CHILD_RUN)]),
    ],
    { terminals: [{ runId: P, status: "completed", at: Date.now() }] },
  );
  await settle(t);
  return mP;
}

describe("projection `on`: a delivery opens its own bubble, grouped with its chain", () => {
  test("announce: own bubble, then one display group keyed by the turn's bubble", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    const mA = await start(t, chatId, A);
    expect(mA).not.toBeNull();
    expect(mA).not.toBe(mP);
    expect((await msg(t, mA!)).deliveryOwnBubble).toBe(true);
    // The parent was NOT reopened: no merge history, its text intact.
    const parent = await msg(t, mP);
    expect(parent.mergedAnnounceRuns).toBeUndefined();
    expect(parent.status).toBe("complete");
    await settle(t);
    expect((await msg(t, mP)).displayGroupId).toBe(mP);
    expect((await msg(t, mA!)).displayGroupId).toBe(mP);
    // The message list carries the group to the reader.
    const { userId } = (await t.run((ctx) => ctx.db.get(chatId)))!;
    const view = (await t.withIdentity({ subject: `${userId}|session` }).query(api.messages.listByChat, {
      chatId: chatId as string,
    })) as Array<{ _id: string; displayGroupId?: string }>;
    expect(view.filter((m) => m.displayGroupId === mP).map((m) => m._id)).toEqual([mP, mA]);
  });

  test("shadow keeps 0.96.0's reopen (the same announce merges into the parent)", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "shadow");
    const mP = (await start(t, chatId, P))!;
    await finish(t, mP, "Je délègue.");
    await t.run((ctx) =>
      ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: mP, anchorExact: true, childSessionKey: CHILD, childRunId: CHILD_RUN, kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 }),
    );
    expect(await start(t, chatId, A)).toBe(mP);
    expect((await msg(t, mP)).mergedAnnounceRuns).toEqual([A]);
    expect(await t.run((ctx) => ctx.db.query("transcriptSpawns").collect())).toHaveLength(0);
  });

  test("Q2 — a message of the user between the launch and the delivery: its own bubble below it", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "autre chose", sendId: "sendB", updatedAt: 2 }),
    );
    const mA = (await start(t, chatId, A))!;
    await settle(t);
    expect((await msg(t, mP)).displayGroupId).toBeUndefined();
    expect((await msg(t, mA)).displayGroupId).toBeUndefined();
  });

  test("the launch row read AFTER the delivery's bubble opened: the group converges", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId, { launchRead: false });
    const mA = (await start(t, chatId, A))!;
    await settle(t);
    expect((await msg(t, mA)).displayGroupId).toBeUndefined();
    await apply(t, chatId, [launch("n1", 3, P, CHILD, CHILD_RUN)]);
    await settle(t);
    expect((await msg(t, mP)).displayGroupId).toBe(mP);
    expect((await msg(t, mA)).displayGroupId).toBe(mP);
  });

  test("a settle wake WITHOUT yield over children launched inside the announce: same group (spawn-parallel-merge)", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await finish(t, mA, "Je lance B et C.");
    await apply(t, chatId, [
      said("a2", 5, A, "Je lance B et C."),
      launch("n2", 6, A, CHILD_B, "run-b"),
      launch("n3", 7, A, CHILD_C, "run-c"),
    ]);
    const mB = (await start(t, chatId, `announce:v1:${CHILD_B}:run-b`))!;
    await finish(t, mB, "B fini.");
    const wake = `announce:requester-settle:main:${SK}:run-b,run-c`;
    const mW = (await start(t, chatId, wake))!;
    await finish(t, mW, "PARALLEL_DONE");
    await settle(t);
    for (const id of [mP, mA, mB, mW]) expect((await msg(t, id)).displayGroupId).toBe(mP);
  });

  test("a background task's delivery: grouped through the run that started it", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId, { launchRead: false });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      parentMessageId: mP,
      anchorExact: true,
      childSessionKey: `task:${TASK}`,
      kind: "task",
      taskName: "image_generate",
      startRunId: P,
      status: "running",
    });
    const mT = (await start(t, chatId, `image_generate:${TASK}:ok`))!;
    expect(mT).not.toBe(mP);
    await settle(t);
    expect((await msg(t, mT)).displayGroupId).toBe(mP);
    // …and without the starting run (an older bridge, a run never followed): alone.
    const t2 = convexTest({ schema, modules });
    const s2 = await seed(t2, "on");
    const mP2 = await turnWithLaunch(t2, s2.chatId, { launchRead: false });
    await t2.mutation(internal.subAgents.upsertSubAgent, {
      chatId: s2.chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      parentMessageId: mP2,
      anchorExact: true,
      childSessionKey: `task:${TASK}`,
      kind: "task",
      taskName: "image_generate",
      status: "running",
    });
    const mT2 = (await start(t2, s2.chatId, `image_generate:${TASK}:ok`))!;
    await settle(t2);
    expect((await msg(t2, mT2)).displayGroupId).toBeUndefined();
  });

  test("an own delivery that brought nothing is not painted as a failed delivery", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await t.mutation(internal.stream.finalize, { messageId: mA, status: "complete" } as never);
    const m = await msg(t, mA);
    expect(m.status).toBe("complete");
    expect(m.errorCode).toBeUndefined();
  });

  test("the replay of an own delivery that ended in error resumes ITS bubble, never a second", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await t.mutation(internal.stream.finalize, { messageId: mA, status: "error", error: "boom" } as never);
    await apply(t, chatId, [said("a2", 5, A, "partiel")], { terminals: [{ runId: A, status: "error", at: Date.now() }] });
    await settle(t);
    expect((await msg(t, mA)).status).toBe("error");
    expect(await start(t, chatId, A)).toBe(mA);
    expect((await msg(t, mA)).status).toBe("streaming");
    expect((await assistants(t, chatId)).filter((m) => m.runId === A)).toHaveLength(1);
  });

  test("rollback to shadow: a planned regroup writes nothing, and the next delivery reopens as in 0.96.0", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await t.run(async (ctx) => {
      const inst = (await ctx.db.query("instances").collect())[0]!;
      await ctx.db.patch(inst._id, { config: { transcriptProjection: "shadow" } as never });
    });
    await settle(t);
    expect((await msg(t, mA)).displayGroupId).toBeUndefined();
    await finish(t, mA, "résultat A");
    await t.run((ctx) =>
      ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: mP, anchorExact: true, childSessionKey: CHILD_B, childRunId: "run-b", kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 }),
    );
    // 0.96.0's reopen gates on the parent being the conversation's newest bubble or an
    // anchored one; the delivery of B targets P, anchored: it is merged there.
    expect(await start(t, chatId, `announce:v1:${CHILD_B}:run-b`)).toBe(mP);
  });

  test("deleting a bubble regroups what is left (a member left alone is cleared)", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    // A stale cache the deletion cannot widen across (a message of the user in between).
    await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "autre", sendId: "sendB", updatedAt: 2 }),
    );
    const mA = (await start(t, chatId, A))!;
    await finish(t, mA, "résultat");
    await settle(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(mP, { displayGroupId: mP });
      await ctx.db.patch(mA, { displayGroupId: mP });
    });
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.messages.deleteMessage, { messageId: mA });
    expect(await t.run((ctx) => ctx.db.get(mP))).not.toBeNull();
    await settle(t);
    expect((await msg(t, mP)).displayGroupId).toBeUndefined();
  });

  test("a sub-agent is anchored to the bubble of the run its launch row names — and stays there", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    // The bridge saw the child first, anchored by position to a WRONG bubble.
    const wrong = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "autre", runId: "other", turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 }),
    );
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      parentMessageId: wrong,
      childSessionKey: CHILD,
      childRunId: CHILD_RUN,
      kind: "subagent",
      status: "running",
    });
    const mP = await turnWithLaunch(t, chatId);
    const row = async () =>
      (await t.run((ctx) => ctx.db.query("subAgents").withIndex("by_child", (q) => q.eq("childSessionKey", CHILD)).first()))!;
    expect((await row()).parentMessageId).toBe(mP);
    expect((await row()).anchorExact).toBe(true);
    // A later observation with the bridge's guess never moves it back.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      parentMessageId: wrong,
      anchorExact: true,
      childSessionKey: CHILD,
      kind: "subagent",
      status: "done",
    });
    expect((await row()).parentMessageId).toBe(mP);
  });

  test("a sub-agent first observed AFTER its launch row: born with the transcript's anchor", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    const wrong = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "autre", runId: "other", turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 }),
    );
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      parentMessageId: wrong,
      childSessionKey: CHILD,
      childRunId: CHILD_RUN,
      kind: "subagent",
      status: "running",
    });
    const row = (await t.run((ctx) => ctx.db.query("subAgents").withIndex("by_child", (q) => q.eq("childSessionKey", CHILD)).first()))!;
    expect(row.parentMessageId).toBe(mP);
    expect(row.anchorExact).toBe(true);
  });

  test("shadow: launch facts are neither stored nor read", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "shadow");
    await apply(t, chatId, [userRow("u1", 1, P), launch("n1", 3, P, CHILD, CHILD_RUN)]);
    await settle(t);
    expect(await t.run((ctx) => ctx.db.query("transcriptSpawns").collect())).toHaveLength(0);
    const row = await t.run((ctx) =>
      ctx.db.query("transcriptRows").withIndex("by_chat_session_entry", (q) => q.eq("chatId", chatId).eq("sessionKey", SK).eq("entryId", "n1")).first(),
    );
    expect(row).not.toBeNull();
    expect((row as Record<string, unknown>).spawns).toBeUndefined();
  });

  test("a replayed launch row stores its fact once", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    await apply(t, chatId, [launch("n1", 3, P, CHILD, CHILD_RUN)]);
    await apply(t, chatId, [launch("n1", 3, P, CHILD, CHILD_RUN)], { kind: "live", deltaCursor: undefined });
    expect(await t.run((ctx) => ctx.db.query("transcriptSpawns").collect())).toHaveLength(1);
  });

  test("the conversation's purge takes its launch facts", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    expect(await t.run((ctx) => ctx.db.query("transcriptSpawns").collect())).toHaveLength(1);
    await t.run((ctx) => cascadeDeleteChat(ctx, chatId, { inline: false }));
    await settle(t);
    expect(await t.run((ctx) => ctx.db.query("transcriptSpawns").collect())).toHaveLength(0);
  });

  test("regroupChat is idempotent", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    await start(t, chatId, A);
    await settle(t);
    expect(await t.run((ctx) => regroupChat(ctx, chatId))).toBe(0);
  });
});

// ── codex phase 5 pass 1 ───────────────────────────────────────────────────────────────

/** A sub-agent row as a bridge writes it (instance, child run). */
const child = (t: T, chatId: Id<"chats">, userId: Id<"users">, extra: Partial<Doc<"subAgents">> = {}) =>
  t.run((ctx) =>
    ctx.db.insert("subAgents", {
      chatId,
      userId,
      instanceName: "prod",
      childSessionKey: CHILD,
      childRunId: CHILD_RUN,
      kind: "subagent" as const,
      status: "running" as const,
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    }),
  );
const rowOf = (t: T, id: Id<"subAgents">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"subAgents">>;
const otherBubble = (t: T, chatId: Id<"chats">, userId: Id<"users">) =>
  t.run((ctx) =>
    ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "autre", runId: "other", turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 }),
  );

describe("#1 a launch is a proof only in its own scope", () => {
  test("it never moves a sub-agent another instance wrote, nor one of another child run", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const elsewhere = await otherBubble(t, chatId, userId);
    const foreign = await child(t, chatId, userId, { instanceName: "other", parentMessageId: elsewhere, anchorExact: true });
    await turnWithLaunch(t, chatId);
    expect((await rowOf(t, foreign)).parentMessageId).toBe(elsewhere);
    // Same instance, but the fact names ANOTHER run of that child key.
    const t2 = convexTest({ schema, modules });
    const s2 = await seed(t2, "on");
    const e2 = await otherBubble(t2, s2.chatId, s2.userId);
    const stale = await child(t2, s2.chatId, s2.userId, { childRunId: "an-older-run", parentMessageId: e2, anchorExact: true });
    await turnWithLaunch(t2, s2.chatId);
    expect((await rowOf(t2, stale)).parentMessageId).toBe(e2);
  });

  test("a first observation by another instance never takes this instance's launch as its anchor", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const elsewhere = await otherBubble(t, chatId, userId);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      instanceName: "other",
      parentMessageId: elsewhere,
      childSessionKey: CHILD,
      childRunId: CHILD_RUN,
      kind: "subagent",
      status: "running",
    });
    const row = (await t.run((ctx) => ctx.db.query("subAgents").withIndex("by_child", (q) => q.eq("childSessionKey", CHILD)).first()))!;
    expect(row.parentMessageId).toBe(elsewhere);
  });

  test("a launch another instance stated never groups this instance's delivery", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId, { launchRead: false });
    await t.run((ctx) =>
      ctx.db.insert("transcriptSpawns", { chatId, instanceName: "other", sessionKey: SK, parentRunId: P, childSessionKey: CHILD, childRunId: CHILD_RUN, entryId: "n9", seq: 3, createdAt: 1 }),
    );
    const mA = (await start(t, chatId, A))!;
    await settle(t);
    expect((await msg(t, mA)).displayGroupId).toBeUndefined();
    expect((await msg(t, mP)).displayGroupId).toBeUndefined();
  });
});

describe("#1 a launch row is stored in its own scope", () => {
  test("the same entry id stated by another instance does not stand for this instance's row", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    await t.run((ctx) =>
      ctx.db.insert("transcriptSpawns", { chatId, instanceName: "other", sessionKey: SK, parentRunId: "webchat-x", childSessionKey: CHILD, childRunId: CHILD_RUN, entryId: "n1", seq: 3, createdAt: 1 }),
    );
    await turnWithLaunch(t, chatId);
    const mine = (await t.run((ctx) => ctx.db.query("transcriptSpawns").collect())).filter((f) => f.instanceName === "prod");
    expect(mine.map((f) => f.parentRunId)).toEqual([P]);
  });
});

describe("#2 one read budget for anchoring, facts and grouping", () => {
  test("32 launches of 32 distinct ~700 KiB parents: anchored across continuations, never over the read limit", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { chatId, userId } = await seed(t, "on");
    const big = "x".repeat(700 * 1024);
    const spawnIds: Array<Id<"transcriptSpawns">> = [];
    const rows: Array<Id<"subAgents">> = [];
    const parents: Array<Id<"messages">> = [];
    for (let i = 0; i < 32; i++) {
      await t.run(async (ctx) => {
        parents.push(
          await ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: big, runId: `p${i}`, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 }),
        );
        spawnIds.push(
          await ctx.db.insert("transcriptSpawns", { chatId, instanceName: "prod", sessionKey: SK, parentRunId: `p${i}`, childSessionKey: `agent:files:subagent:k${i}`, childRunId: `c${i}`, entryId: `e${i}`, seq: 10 + i, createdAt: 1 }),
        );
        rows.push(
          await ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", childSessionKey: `agent:files:subagent:k${i}`, childRunId: `c${i}`, kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 }),
        );
      });
    }
    await t.mutation(internal.displayGroups.regroup, { chatId, spawnIds });
    await settle(t);
    for (let i = 0; i < 32; i++) expect((await rowOf(t, rows[i]!)).parentMessageId).toBe(parents[i]);
  }, 120_000);
});

describe("#5 a list fuller than read is never a proof", () => {
  test("five launches by P read, a sixth by Q unread: the delivery is not grouped, the child not anchored", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    // The wrong anchor sits BEFORE the turn: nothing is displayed between P and the delivery.
    const elsewhere = await otherBubble(t, chatId, userId);
    const mP = await turnWithLaunch(t, chatId, { launchRead: false });
    const row = await child(t, chatId, userId, { parentMessageId: elsewhere });
    const ids: Array<Id<"transcriptSpawns">> = [];
    await t.run(async (ctx) => {
      // Read in index order: the five by P fill the read (and its sentinel), Q's is beyond.
      for (let i = 0; i < 6; i++) {
        ids.push(
          await ctx.db.insert("transcriptSpawns", { chatId, instanceName: "prod", sessionKey: SK, parentRunId: i < 5 ? P : "webchat-q", childSessionKey: CHILD, childRunId: CHILD_RUN, entryId: `n${i}`, seq: 3 + i, createdAt: i }),
        );
      }
    });
    await t.mutation(internal.displayGroups.regroup, { chatId, spawnIds: ids.slice(0, 1) });
    const mA = (await start(t, chatId, A))!;
    await settle(t);
    expect((await msg(t, mA)).displayGroupId).toBeUndefined();
    expect((await msg(t, mP)).displayGroupId).toBeUndefined();
    expect((await rowOf(t, row)).parentMessageId).toBe(elsewhere);
  });
});

describe("#6 a launch read before its run's bubble keeps its anchor for later", () => {
  /** P's launch row read while P is still working: no bubble of P exists yet. */
  async function launchFirst(t: T, chatId: Id<"chats">) {
    await apply(t, chatId, [userRow("u1", 1, P), launch("n1", 2, P, CHILD, CHILD_RUN)], { hasActiveRun: true, activeRunIds: [P] });
    await settle(t);
  }

  test("the sub-agent already observed: anchored when the bubble of P opens", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const elsewhere = await otherBubble(t, chatId, userId);
    const row = await child(t, chatId, userId, { parentMessageId: elsewhere });
    await launchFirst(t, chatId);
    expect((await rowOf(t, row)).anchorPending).toBe(true);
    const mP = (await start(t, chatId, P))!;
    await settle(t);
    const after = await rowOf(t, row);
    expect(after.parentMessageId).toBe(mP);
    expect(after.anchorPending).toBeUndefined();
  });

  test("the sub-agent observed only AFTER the launch, before the bubble: anchored when the bubble opens", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    await launchFirst(t, chatId);
    const elsewhere = await otherBubble(t, chatId, userId);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      parentMessageId: elsewhere,
      childSessionKey: CHILD,
      childRunId: CHILD_RUN,
      kind: "subagent",
      status: "running",
    });
    const row = (await t.run((ctx) => ctx.db.query("subAgents").withIndex("by_child", (q) => q.eq("childSessionKey", CHILD)).first()))!;
    expect(row.anchorPending).toBe(true);
    const mP = (await start(t, chatId, P))!;
    await settle(t);
    expect((await rowOf(t, row._id)).parentMessageId).toBe(mP);
  });

  test("an observation of the child after the bubble opened takes the anchor too", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const elsewhere = await otherBubble(t, chatId, userId);
    const row = await child(t, chatId, userId, { parentMessageId: elsewhere });
    await launchFirst(t, chatId);
    // The bubble opens with no regroup behind it (an older path, a lost task).
    const mP = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "streaming" as const, text: "", runId: P, turnSessionKey: SK, boundInstance: "prod", updatedAt: 2 }),
    );
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      childSessionKey: CHILD,
      kind: "subagent",
      status: "running",
    });
    const after = await rowOf(t, row);
    expect(after.parentMessageId).toBe(mP);
    expect(after.anchorPending).toBeUndefined();
  });

  test("a launch whose run never shows a bubble gives up after a bounded number of tries", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    await child(t, chatId, userId);
    await launchFirst(t, chatId);
    for (let i = 0; i < 20; i++) await t.mutation(internal.displayGroups.regroup, { chatId });
    const fact = (await t.run((ctx) => ctx.db.query("transcriptSpawns").first()))!;
    expect(fact.anchorPending).toBeUndefined();
    expect(fact.anchorTries).toBe(16);
  });
});

describe("#4 Delete / Regenerate of a delegation's answer starts at its first bubble", () => {
  test("[question, parent, delivery]: deleting the delivery removes the parent too and regenerates", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await finish(t, mA, "résultat");
    await settle(t);
    expect((await msg(t, mA)).displayGroupId).toBe(mP);
    const outboxBefore = (await t.run((ctx) => ctx.db.query("outbox").collect())).length;
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.messages.deleteMessage, { messageId: mA });
    expect(await t.run((ctx) => ctx.db.get(mP))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(mA))).toBeNull();
    // The question is regenerated: a new send leaves for the gateway.
    expect((await t.run((ctx) => ctx.db.query("outbox").collect())).length).toBeGreaterThan(outboxBefore);
  });
});

describe("codex phase 5 pass 2 #1 — a delivery's own bubble is found whatever the transcript read and the mode", () => {
  test("replayed BEFORE its transcript terminal: the same bubble resumes, no second one", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await t.mutation(internal.stream.finalize, { messageId: mA, status: "error", error: "boom" } as never);
    expect(await start(t, chatId, A)).toBe(mA);
    expect((await msg(t, mA)).status).toBe("streaming");
    expect((await assistants(t, chatId)).filter((m) => m.runId === A)).toHaveLength(1);
  });

  test("terminal recorded, then a rollback to shadow: the own bubble resumes, the parent is not reopened", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    await child(t, chatId, userId, { parentMessageId: mP, anchorExact: true });
    const mA = (await start(t, chatId, A))!;
    await t.mutation(internal.stream.finalize, { messageId: mA, status: "error", error: "boom" } as never);
    await apply(t, chatId, [said("a2", 5, A, "partiel")], { terminals: [{ runId: A, status: "error", at: Date.now() }] });
    await settle(t);
    await t.run(async (ctx) => {
      const inst = (await ctx.db.query("instances").collect())[0]!;
      await ctx.db.patch(inst._id, { config: { transcriptProjection: "shadow" } as never });
    });
    expect(await start(t, chatId, A)).toBe(mA);
    expect((await msg(t, mA)).status).toBe("streaming");
    expect((await msg(t, mP)).mergedAnnounceRuns).toBeUndefined();
    expect((await msg(t, mP)).status).toBe("complete");
  });
});

describe("codex phase 5 pass 2 #2 — a child correlated late still takes its launch's anchor", () => {
  const observe = (t: T, chatId: Id<"chats">, extra: Record<string, unknown>) =>
    t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      childSessionKey: CHILD,
      kind: "subagent",
      status: "running",
      ...extra,
    } as never);
  const row = (t: T) =>
    t.run((ctx) => ctx.db.query("subAgents").withIndex("by_child", (q) => q.eq("childSessionKey", CHILD)).first()) as Promise<Doc<"subAgents">>;

  test("observed without its run id, launch read, then the run id, then the parent's bubble: anchored there", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const elsewhere = await otherBubble(t, chatId, userId);
    await observe(t, chatId, { parentMessageId: elsewhere });
    expect((await row(t)).anchorPending).toBe(true);
    await apply(t, chatId, [userRow("u1", 1, P), launch("n1", 2, P, CHILD, CHILD_RUN)], { hasActiveRun: true, activeRunIds: [P] });
    await settle(t);
    await observe(t, chatId, { childRunId: CHILD_RUN });
    const mP = (await start(t, chatId, P))!;
    await settle(t);
    expect((await row(t)).parentMessageId).toBe(mP);
    expect((await row(t)).anchorPending).toBeUndefined();
  });

  test("an observation that still lacks the run id keeps the child waiting", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    const elsewhere = await otherBubble(t, chatId, userId);
    await observe(t, chatId, { parentMessageId: elsewhere });
    await observe(t, chatId, { status: "running", phase: "tool" });
    expect((await row(t)).anchorPending).toBe(true);
    await observe(t, chatId, { childRunId: CHILD_RUN });
    expect((await row(t)).parentMessageId).toBe(mP);
  });

  test("a row written before the conversation stored text is marked by the launch that may name it", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const elsewhere = await otherBubble(t, chatId, userId);
    // No run id, no mark: written while nothing was projected.
    const id = await child(t, chatId, userId, { childRunId: undefined, parentMessageId: elsewhere });
    const mP = await turnWithLaunch(t, chatId);
    expect((await rowOf(t, id)).anchorPending).toBe(true);
    await observe(t, chatId, { childRunId: CHILD_RUN });
    expect((await rowOf(t, id)).parentMessageId).toBe(mP);
  });

  test("the parent's bubble already there: the observation that brings the run id anchors it", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const elsewhere = await otherBubble(t, chatId, userId);
    await observe(t, chatId, { parentMessageId: elsewhere });
    const mP = await turnWithLaunch(t, chatId);
    expect((await row(t)).parentMessageId).toBe(elsewhere);
    await observe(t, chatId, { childRunId: CHILD_RUN });
    expect((await row(t)).parentMessageId).toBe(mP);
    expect((await row(t)).anchorPending).toBeUndefined();
  });
});

describe("codex phase 5 pass 2 #3 — a report on a display group freezes the whole answer", () => {
  async function groupedAnswer(t: T) {
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await t.mutation(internal.stream.addPart, {
      messageId: mA,
      part: { kind: "tool", name: "exec", phase: "result", toolCallId: "call-del", input: { command: "ls" } },
    } as never);
    await t.mutation(internal.stream.addPart, {
      messageId: mA,
      part: { kind: "tool", name: "sessions_yield", phase: "result", toolCallId: "call-y", input: { message: "NOTE PRIVEE" } },
    } as never);
    await finish(t, mA, "Résultat.");
    await settle(t);
    expect((await msg(t, mA)).displayGroupId).toBe(mP);
    return { chatId, userId, mP, mA };
  }

  for (const named of ["head", "last"] as const) {
    test(`reported from the ${named} bubble: every member's text, parts and run — redacted alike`, async () => {
      const t = convexTest({ schema, modules });
      const { chatId, userId, mP, mA } = await groupedAnswer(t);
      await t.withIdentity({ subject: `${userId}|session` }).mutation(api.feedback.submitFeedback, {
        chatId,
        messageId: named === "head" ? mP : mA,
        category: "incorrect",
        client: { displayedText: "Je délègue.\n\nRésultat." },
      });
      const fb = (await t.run((ctx) => ctx.db.query("feedback").first()))!;
      expect(fb.snapshot.messageText).toBe("Je délègue.\n\nRésultat.");
      expect(fb.snapshot.displayedMatchesStored).toBe(true);
      expect(fb.snapshot.groupMessageIds).toEqual([mP, mA]);
      expect(fb.snapshot.groupRunIds).toEqual([P, A]);
      expect(fb.snapshot.partsJson).toContain("call-del");
      expect(fb.snapshot.partsJson).not.toContain("NOTE PRIVEE");
      // The context leads to the answer, whose members stand in by reference (their text
      // is `messageText`, never copied twice — codex pass 3 #2).
      const ctx = JSON.parse(fb.snapshot.contextJson!) as Array<{ role: string; text: string }>;
      expect(ctx.map((c) => c.text)).toEqual(["délègue", "[the reported answer — see messageText]", "[the reported answer — see messageText]"]);
    });
  }
});

describe("codex phase 5 pass 3 #1 — a delivery's later segment resumes ITS bubble", () => {
  async function segmentedDelivery(t: T) {
    const { chatId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const seg0 = (await start(t, chatId, A))!;
    await t.mutation(internal.stream.appendDelta, { messageId: seg0, text: "avant" } as never);
    const seg1 = (await t.mutation(internal.stream.splitSegment, { messageId: seg0, text: "avant" }))!;
    expect((await msg(t, seg1)).deliveryOwnBubble).toBe(true);
    await t.mutation(internal.stream.finalize, { messageId: seg1, status: "error", error: "boom" } as never);
    return { chatId, seg0, seg1 };
  }
  const startSegment = (t: T, chatId: Id<"chats">, runSegment: number) =>
    t.mutation(internal.stream.startAssistant, { chatId, runId: A, turnSessionKey: SK, boundInstanceName: "prod", runSegment }) as Promise<Id<"messages"> | null>;

  test("before its transcript terminal: segment 1 resumes, segment 0 untouched", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, seg0, seg1 } = await segmentedDelivery(t);
    expect(await startSegment(t, chatId, 1)).toBe(seg1);
    expect((await msg(t, seg1)).status).toBe("streaming");
    expect((await msg(t, seg0)).status).toBe("complete");
    expect((await assistants(t, chatId)).filter((m) => m.runId === A)).toHaveLength(2);
  });

  test("after a rollback to shadow: the same", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, seg0, seg1 } = await segmentedDelivery(t);
    await t.run(async (ctx) => {
      const inst = (await ctx.db.query("instances").collect())[0]!;
      await ctx.db.patch(inst._id, { config: { transcriptProjection: "shadow" } as never });
    });
    expect(await startSegment(t, chatId, 1)).toBe(seg1);
    expect((await msg(t, seg1)).status).toBe("streaming");
    expect((await msg(t, seg0)).status).toBe("complete");
  });
});

describe("codex phase 5 pass 3 #2/#3 — a group report fits one document, and finds an older group", () => {
  test("#2 two ~300 KiB members: the report is stored, under 1 MiB, its cut marked", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await finish(t, mA, "R".repeat(300 * 1024));
    await settle(t);
    await t.run((ctx) => ctx.db.patch(mP, { text: "D".repeat(300 * 1024) }));
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: mP,
      category: "incorrect",
    });
    const fb = (await t.run((ctx) => ctx.db.query("feedback").first()))!;
    const bytes = new TextEncoder().encode(JSON.stringify(fb)).length;
    expect(bytes).toBeLessThan(1024 * 1024);
    expect(fb.snapshot.groupTruncated).toBe(true);
    expect(fb.snapshot.messageText).toMatch(/\[… truncated for the report: \d+ bytes in all\]$/);
    expect(fb.snapshot.groupMessageIds).toEqual([mP, mA]);
  });

  test("#3 a group older than the context scan, still on screen: its whole answer is reported", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await finish(t, mA, "la vraie réponse");
    await settle(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 61; i++) {
        await ctx.db.insert("messages", { chatId, userId, role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), status: "complete" as const, text: `m${i}`, updatedAt: 3 });
      }
    });
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: mP,
      category: "incorrect",
    });
    const fb = (await t.run((ctx) => ctx.db.query("feedback").first()))!;
    expect(fb.snapshot.groupMessageIds).toEqual([mP, mA]);
    expect(fb.snapshot.messageText).toBe("Je délègue.\n\nla vraie réponse");
  });
});

describe("codex phase 5 pass 4 #1 — a resumed delivery does not attach its file twice", () => {
  for (const rollback of [false, true]) {
    test(`re-uploaded after an error (${rollback ? "after a rollback to shadow" : "on"}): one part, one file`, async () => {
      const t = convexTest({ schema, modules });
      const { chatId } = await seed(t, "on");
      await turnWithLaunch(t, chatId);
      const mA = (await start(t, chatId, A))!;
      const s1 = await t.run((ctx) => ctx.storage.store(new Blob(["v1"])));
      await t.mutation(internal.stream.addPart, {
        messageId: mA,
        part: { kind: "media" as const, storageId: s1, filename: "report.pdf", mimeType: "application/pdf" },
      });
      await t.mutation(internal.stream.finalize, { messageId: mA, status: "error", error: "boom" } as never);
      if (rollback) {
        await t.run(async (ctx) => {
          const inst = (await ctx.db.query("instances").collect())[0]!;
          await ctx.db.patch(inst._id, { config: { transcriptProjection: "shadow" } as never });
        });
      }
      expect(await start(t, chatId, A)).toBe(mA);
      const s2 = await t.run((ctx) => ctx.storage.store(new Blob(["v1"])));
      await t.mutation(internal.stream.addPart, {
        messageId: mA,
        part: { kind: "media" as const, storageId: s2, filename: "report.pdf", mimeType: "application/pdf" },
      });
      const parts = await t.run((ctx) => ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", mA)).collect());
      expect(parts.filter((p) => p.part.kind === "media")).toHaveLength(1);
      const files = await t.run((ctx) => ctx.db.query("files").collect());
      expect(files.filter((f) => (f as { messageId?: string }).messageId === mA)).toHaveLength(1);
    });
  }
});

describe("codex phase 5 pass 4 #2 — a group report reads under one budget", () => {
  test("members of 192 / 768 KiB and 32 parts of 450 KiB: the report is stored, marked cut", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { chatId, userId } = await seed(t, "on");
    const mP = await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await finish(t, mA, "R".repeat(768 * 1024));
    await settle(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(mP, { text: "D".repeat(192 * 1024) });
      for (let i = 0; i < 32; i++) {
        await ctx.db.insert("messageParts", {
          messageId: mA,
          order: i,
          part: { kind: "tool", name: "exec", phase: "result", toolCallId: `c${i}`, output: "O".repeat(450 * 1024) },
        } as never);
      }
    });
    expect((await msg(t, mA)).displayGroupId).toBe(mP);
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: mP,
      category: "incorrect",
    });
    const fb = (await t.run((ctx) => ctx.db.query("feedback").first()))!;
    expect(fb.snapshot.groupTruncated).toBe(true);
    expect(fb.snapshot.groupMessageIds).toEqual([mP, mA]);
  }, 120_000);
});

describe("codex phase 5 pass 5 #2 — a replayed COMPLETE delivery does not attach its file twice", () => {
  for (const settledByTranscript of [false, true]) {
    for (const rollback of [false, true]) {
      test(`after success (${settledByTranscript ? "settled by the transcript" : "not yet read"}, ${rollback ? "after a rollback" : "on"})`, async () => {
        const t = convexTest({ schema, modules });
        const { chatId } = await seed(t, "on");
        await turnWithLaunch(t, chatId);
        const mA = (await start(t, chatId, A))!;
        const s1 = await t.run((ctx) => ctx.storage.store(new Blob(["v1"])));
        await t.mutation(internal.stream.addPart, {
          messageId: mA,
          part: { kind: "media" as const, storageId: s1, filename: "report.pdf", mimeType: "application/pdf" },
        });
        await finish(t, mA, "Voici le rapport.");
        if (settledByTranscript) {
          await apply(t, chatId, [said("a2", 5, A, "Voici le rapport.")], { terminals: [{ runId: A, status: "completed", at: Date.now() }] });
          await settle(t);
        }
        if (rollback) {
          await t.run(async (ctx) => {
            const inst = (await ctx.db.query("instances").collect())[0]!;
            await ctx.db.patch(inst._id, { config: { transcriptProjection: "shadow" } as never });
          });
        }
        expect(await start(t, chatId, A)).toBe(mA);
        const s2 = await t.run((ctx) => ctx.storage.store(new Blob(["v1"])));
        await t.mutation(internal.stream.addPart, {
          messageId: mA,
          part: { kind: "media" as const, storageId: s2, filename: "report.pdf", mimeType: "application/pdf" },
        });
        const parts = await t.run((ctx) => ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", mA)).collect());
        expect(parts.filter((p) => p.part.kind === "media")).toHaveLength(1);
      });
    }
  }
});

describe("codex phase 5 pass 5 #1 — every group read is paid for before it happens", () => {
  test("24 members, 12 parts of 900 KiB on the second and one on each of the next 22: stored, marked cut", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { chatId, userId } = await seed(t, "on");
    const ids: Array<Id<"messages">> = [];
    const head = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "tête", runId: P, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 }),
    );
    ids.push(head);
    await t.run((ctx) => ctx.db.patch(head, { displayGroupId: head }));
    for (let i = 1; i < 24; i++) {
      ids.push(
        await t.run((ctx) =>
          ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: `m${i}`, runId: `announce:v1:agent:files:subagent:k${i}:r${i}`, turnSessionKey: SK, boundInstance: "prod", displayGroupId: head, updatedAt: 1 }),
        ),
      );
    }
    const big = "O".repeat(900 * 1024);
    const addPart = (messageId: Id<"messages">, i: number) =>
      t.run((ctx) =>
        ctx.db.insert("messageParts", { messageId, order: i, part: { kind: "tool", name: "exec", phase: "result", toolCallId: `c${i}`, output: big } } as never),
      );
    for (let i = 0; i < 12; i++) await addPart(ids[1]!, i);
    for (let m = 2; m < 24; m++) await addPart(ids[m]!, 0);
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: head,
      category: "incorrect",
    });
    const fb = (await t.run((ctx) => ctx.db.query("feedback").first()))!;
    expect(fb.snapshot.groupTruncated).toBe(true);
    expect(fb.snapshot.groupMessageIds).toHaveLength(24);
  }, 180_000);
});

describe("codex phase 5 pass 6 #1 — a delivery is found by its IDENTITY (a `:retry-N` is the same delivery)", () => {
  const W1 = `announce:requester-settle:main:${SK}:${CHILD_RUN}:yield-1`;
  const W1R = `${W1}:retry-1`;
  const rollbackTo = (t: T) =>
    t.run(async (ctx) => {
      const inst = (await ctx.db.query("instances").collect())[0]!;
      await ctx.db.patch(inst._id, { config: { transcriptProjection: "shadow" } as never });
    });

  for (const rollback of [false, true]) {
    test(`a retry of a batch that ANSWERED is handed the same bubble (${rollback ? "after a rollback" : "on"})`, async () => {
      const t = convexTest({ schema, modules });
      const { chatId } = await seed(t, "on");
      const mP = await turnWithLaunch(t, chatId);
      const mW = (await start(t, chatId, W1))!;
      await finish(t, mW, "SYNTHESE: fini.");
      if (rollback) await rollbackTo(t);
      expect(await start(t, chatId, W1R)).toBe(mW);
      expect((await msg(t, mW)).status).toBe("complete");
      expect((await msg(t, mW)).text).toBe("SYNTHESE: fini.");
      expect((await msg(t, mP)).text).toBe("Je délègue.");
      expect((await assistants(t, chatId)).filter((m) => m.runId?.startsWith("announce:requester-settle:"))).toHaveLength(1);
    });

    test(`a retry after an ERROR resumes that bubble under the new run (${rollback ? "after a rollback" : "on"})`, async () => {
      const t = convexTest({ schema, modules });
      const { chatId } = await seed(t, "on");
      const mP = await turnWithLaunch(t, chatId);
      const mW = (await start(t, chatId, W1))!;
      await t.mutation(internal.stream.finalize, { messageId: mW, status: "error", error: "boom" } as never);
      if (rollback) await rollbackTo(t);
      expect(await start(t, chatId, W1R)).toBe(mW);
      expect((await msg(t, mW)).status).toBe("streaming");
      expect((await msg(t, mW)).runId).toBe(W1R);
      expect((await msg(t, mP)).mergedAnnounceRuns).toBeUndefined();
    });
  }

  test("a retry of a batch that answered NOTHING (tool cards only) brings the answer in that bubble", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const mW = (await start(t, chatId, W1))!;
    await t.mutation(internal.stream.addPart, {
      messageId: mW,
      part: { kind: "tool", name: "exec", phase: "result", toolCallId: "c1" },
    } as never);
    await finish(t, mW, "");
    expect(await start(t, chatId, W1R)).toBe(mW);
    expect((await msg(t, mW)).status).toBe("streaming");
    expect((await msg(t, mW)).runId).toBe(W1R);
  });

  test("a retry racing its first attempt (still streaming) joins it, never a second bubble", async () => {
    const t = convexTest({ schema, modules });
    const { chatId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const mW = (await start(t, chatId, W1))!;
    expect(await start(t, chatId, W1R)).toBe(mW);
    expect((await msg(t, mW)).runId).toBe(W1);
  });
});

describe("codex phase 5 passes 7 and 15 — after a rollback, an own bubble is never merged into (§14.26)", () => {
  const B = `announce:v1:${CHILD_B}:run-b`;
  const setMode = (t: T, mode: Mode) =>
    t.run(async (ctx) => {
      const inst = (await ctx.db.query("instances").collect())[0]!;
      await ctx.db.patch(inst._id, { config: { transcriptProjection: mode } as never });
    });
  const partsOf = (t: T, id: Id<"messages">) =>
    t.run((ctx) => ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", id)).collect());
  /** A's own bubble (on), then — after a rollback — B, whose child is anchored there: 0.96.0's
   *  path cannot merge into an own bubble, so B gets a bubble of its own; it ends in error. */
  async function separateAfterRollback(t: T) {
    const { chatId, userId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await finish(t, mA, "résultat A");
    await setMode(t, "shadow");
    await t.run((ctx) =>
      ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: mA, anchorExact: true, childSessionKey: CHILD_B, childRunId: "run-b", kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 }),
    );
    const mB = (await start(t, chatId, B))!;
    expect(mB).not.toBe(mA);
    await t.mutation(internal.stream.finalize, { messageId: mB, status: "error", error: "boom B", expectedRunId: B } as never);
    return { chatId, mA, mB };
  }
  const untouchedA = async (t: T, mA: Id<"messages">) => {
    const a = await msg(t, mA);
    expect({ runId: a.runId, status: a.status, text: a.text, merged: a.mergedAnnounceRuns, prefix: a.announcePrefix }).toEqual({
      runId: A,
      status: "complete",
      text: "résultat A",
      merged: undefined,
      prefix: undefined,
    });
  };

  for (const mode of ["shadow", "on"] as const) {
    test(`A's replay lands on A's own bubble, untouched; B's error stands on B's (${mode})`, async () => {
      const t = convexTest({ schema, modules });
      const { chatId, mA, mB } = await separateAfterRollback(t);
      await untouchedA(t, mA);
      if (mode === "on") await setMode(t, "on");
      expect(await start(t, chatId, A)).toBe(mA);
      await untouchedA(t, mA);
      expect((await msg(t, mB)).status).toBe("error");
    });
  }

  test("reverse order (on again): B's replay resumes B's bubble, A's later replay changes nothing", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, mA, mB } = await separateAfterRollback(t);
    await setMode(t, "on");
    expect(await start(t, chatId, B)).toBe(mB);
    expect((await msg(t, mB)).status).toBe("streaming");
    expect(await start(t, chatId, A)).toBe(mA);
    await untouchedA(t, mA);
  });

  // Codex pass 15: a requester-settle B that would have merged into A's own bubble, produced
  // only tool cards, then was retried — the retry's resumed stream started empty and the
  // finalize erased "résultat A". Now B never shares A's bubble.
  const CR_B = "b-run-1";
  const W_B = `announce:requester-settle:main:${SK}:${CR_B}:yield-1`;
  async function settleToolsOnly(t: T) {
    const { chatId, userId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await finish(t, mA, "résultat A");
    await setMode(t, "shadow");
    await t.run((ctx) =>
      ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: mA, anchorExact: true, childSessionKey: CHILD_C, childRunId: CR_B, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 }),
    );
    const mB = (await start(t, chatId, W_B))!;
    expect(mB).not.toBe(mA);
    await t.mutation(internal.stream.addPart, { messageId: mB, part: { kind: "tool", toolCallId: "c1", name: "exec", phase: "result", textOffset: 0 }, expectedRunId: W_B } as never);
    await t.mutation(internal.stream.finalize, { messageId: mB, status: "complete", expectedRunId: W_B } as never);
    return { chatId, mA, mB };
  }
  for (const mode of ["shadow", "on"] as const) {
    test(`settle B with tools only, then its :retry-1 — A's text is kept, B's answer lands (${mode})`, async () => {
      const t = convexTest({ schema, modules });
      const { chatId, mA, mB } = await settleToolsOnly(t);
      if (mode === "on") await setMode(t, "on");
      const retry = `${W_B}:retry-1`;
      const landed = (await start(t, chatId, retry))!;
      expect(landed).not.toBe(mA);
      // The retry resumes B's bubble — an own bubble since 0.96.0's path refused to merge it
      // into A's (§14.27), found by its delivery's identity in either mode.
      expect(landed).toBe(mB);
      await t.mutation(internal.stream.appendDelta, { messageId: landed, text: "réponse B", expectedRunId: retry } as never);
      await t.mutation(internal.stream.finalize, { messageId: landed, status: "complete", text: "réponse B", expectedRunId: retry } as never);
      await untouchedA(t, mA);
      expect((await msg(t, landed)).text).toBe("réponse B");
      // Nothing B wrote is lost: its tool card stays on its first bubble.
      expect((await partsOf(t, mB)).map((p) => (p.part as { toolCallId?: string }).toolCallId)).toEqual(["c1"]);
    });
  }
});

describe("codex phase 5 pass 16 — a delivery refused a merge into an own bubble is an own bubble (§14.27)", () => {
  const B = `announce:v1:${CHILD_B}:run-b`;
  const setMode = (t: T, mode: Mode) =>
    t.run(async (ctx) => {
      const inst = (await ctx.db.query("instances").collect())[0]!;
      await ctx.db.patch(inst._id, { config: { transcriptProjection: mode } as never });
    });
  const bubblesOf = async (t: T, chatId: Id<"chats">, runPrefix: string) =>
    (await assistants(t, chatId)).filter((m) => m.runId !== undefined && m.runId.startsWith(runPrefix));
  async function bAfterRollback(t: T, runB: string, childRunId: string) {
    const { chatId, userId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const mA = (await start(t, chatId, A))!;
    await finish(t, mA, "résultat A");
    await setMode(t, "shadow");
    await t.run((ctx) =>
      ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: mA, anchorExact: true, childSessionKey: CHILD_B, childRunId, kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 }),
    );
    const mB = (await start(t, chatId, runB))!;
    expect(mB).not.toBe(mA);
    const doc = await msg(t, mB);
    expect(doc.deliveryOwnBubble).toBe(true);
    expect(doc.deliveryKey).toBeDefined();
    return { chatId, mA, mB };
  }

  test("B complete, replayed in shadow, then `on` again and replayed: one B bubble at every step", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, mA, mB } = await bAfterRollback(t, B, "run-b");
    await t.mutation(internal.stream.appendDelta, { messageId: mB, text: "réponse B", expectedRunId: B } as never);
    await t.mutation(internal.stream.finalize, { messageId: mB, status: "complete", text: "réponse B", expectedRunId: B } as never);
    expect(await start(t, chatId, B)).toBe(mB);
    expect((await bubblesOf(t, chatId, B)).map((m) => m._id)).toEqual([mB]);
    await setMode(t, "on");
    expect(await start(t, chatId, B)).toBe(mB);
    expect((await bubblesOf(t, chatId, B)).map((m) => [m._id, m.text])).toEqual([[mB, "réponse B"]]);
    expect((await msg(t, mA)).text).toBe("résultat A");
  });

  test("B in error, its :retry-1 in shadow resumes it, then `on` again: one B bubble at every step", async () => {
    const t = convexTest({ schema, modules });
    const crB = "b-err-1";
    const W_B = `announce:requester-settle:main:${SK}:${crB}:yield-1`;
    const { chatId, mA, mB } = await bAfterRollback(t, W_B, crB);
    await t.mutation(internal.stream.finalize, { messageId: mB, status: "error", error: "boom", expectedRunId: W_B } as never);
    const retry = `${W_B}:retry-1`;
    expect(await start(t, chatId, retry)).toBe(mB);
    expect((await msg(t, mB)).status).toBe("streaming");
    await t.mutation(internal.stream.appendDelta, { messageId: mB, text: "réponse B", expectedRunId: retry } as never);
    await t.mutation(internal.stream.finalize, { messageId: mB, status: "complete", text: "réponse B", expectedRunId: retry } as never);
    expect((await bubblesOf(t, chatId, W_B)).map((m) => m._id)).toEqual([mB]);
    await setMode(t, "on");
    expect(await start(t, chatId, `${W_B}:retry-2`)).toBe(mB);
    expect((await bubblesOf(t, chatId, W_B)).map((m) => [m._id, m.text])).toEqual([[mB, "réponse B"]]);
    expect((await msg(t, mA)).text).toBe("résultat A");
  });

  test("an own bubble opened in shadow that brings nothing gets 0.96.0's verdict (not rebuilt from rows there)", async () => {
    const t = convexTest({ schema, modules });
    const { mB } = await bAfterRollback(t, B, "run-b");
    await t.mutation(internal.stream.finalize, { messageId: mB, status: "complete", expectedRunId: B } as never);
    expect((await msg(t, mB)).status).toBe("error");
  });
});

describe("codex phase 5 pass 7 #2 — a parent recovered AFTER its delivery (created later, placed earlier)", () => {
  async function recoveredParent(t: T) {
    const { chatId, userId, userMessageId } = await seed(t, "on");
    const qCt = (await msg(t, userMessageId))._creationTime;
    const mA = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Résultat.", runId: A, turnSessionKey: SK, boundInstance: "prod", deliveryOwnBubble: true, updatedAt: 2 }),
    );
    const aCt = (await msg(t, mA))._creationTime;
    // The transcript recovers P later: a later _creationTime, an orderTime between the
    // question and A (where its row sits).
    const mP = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Je délègue.", runId: P, turnSessionKey: SK, boundInstance: "prod", orderTime: (qCt + aCt) / 2, updatedAt: 3 }),
    );
    expect((await msg(t, mP))._creationTime).toBeGreaterThan(aCt);
    await t.run(async (ctx) => {
      await ctx.db.patch(mP, { displayGroupId: mP });
      await ctx.db.patch(mA, { displayGroupId: mP });
    });
    return { chatId, userId, mP, mA };
  }

  test("the report on the group's head holds the delivered result", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId, mP, mA } = await recoveredParent(t);
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: mP,
      category: "incorrect",
      client: { displayedText: "Je délègue.\n\nRésultat." },
    });
    const fb = (await t.run((ctx) => ctx.db.query("feedback").first()))!;
    expect(fb.snapshot.groupMessageIds).toEqual([mP, mA]);
    expect(fb.snapshot.messageText).toBe("Je délègue.\n\nRésultat.");
    expect(fb.snapshot.displayedMatchesStored).toBe(true);
  });

  test("deleting from the delivery starts at that head too", async () => {
    const t = convexTest({ schema, modules });
    const { userId, mP, mA } = await recoveredParent(t);
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.messages.deleteMessage, { messageId: mA });
    expect(await t.run((ctx) => ctx.db.get(mP))).toBeNull();
  });
});

describe("codex phase 5 pass 7 #2 — consecutiveness is judged in DISPLAY order", () => {
  test("a stale group across a message of the user the parent was recovered before: the report does not join them", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const mA = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Résultat.", runId: A, turnSessionKey: SK, boundInstance: "prod", deliveryOwnBubble: true, updatedAt: 2 }),
    );
    const firstCt = (await t.run((ctx) => ctx.db.query("messages").collect()))[0]!._creationTime;
    // P displayed BEFORE the question (an orderTime earlier than it), the cache still grouping P and A.
    const mP = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Je délègue.", runId: P, turnSessionKey: SK, boundInstance: "prod", orderTime: firstCt - 1, updatedAt: 3 }),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(mP, { displayGroupId: mP });
      await ctx.db.patch(mA, { displayGroupId: mP });
    });
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: mP,
      category: "incorrect",
    });
    const fb = (await t.run((ctx) => ctx.db.query("feedback").first()))!;
    expect(fb.snapshot.groupMessageIds).toBeUndefined();
    expect(fb.snapshot.messageText).toBe("Je délègue.");
  });
});

describe("codex phase 5 pass 8 #1 — a replay never touches another gateway's bubble", () => {
  test("A's history lookup ignores B's bubble: no window armed there, B's later file is kept", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const B = `announce:v1:${CHILD_B}:run-b`;
    // A bubble of ANOTHER gateway that A's run once wrote in (a record pointing there).
    const mX = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "B",
        runId: B,
        turnSessionKey: SK,
        boundInstance: "other",
        deliveryOwnBubble: true,
        deliveryKey: `run:${B}`,
        updatedAt: 1,
      });
      await ctx.db.insert("runBubbles", { chatId, runId: A, messageId: id, createdAt: 1 });
      return id;
    });
    const s1 = await t.run((ctx) => ctx.storage.store(new Blob(["v1"])));
    await t.mutation(internal.stream.addPart, {
      messageId: mX,
      part: { kind: "media" as const, storageId: s1, filename: "report.pdf", mimeType: "application/pdf" },
      expectedRunId: B,
    } as never);
    const mA = await start(t, chatId, A);
    expect(mA).not.toBe(mX);
    expect((await msg(t, mX)).announceReplayArmed).toBeUndefined();
    const s2 = await t.run((ctx) => ctx.storage.store(new Blob(["v2"])));
    await t.mutation(internal.stream.addPart, {
      messageId: mX,
      part: { kind: "media" as const, storageId: s2, filename: "report.pdf", mimeType: "application/pdf" },
      expectedRunId: B,
    } as never);
    const parts = await t.run((ctx) => ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", mX)).collect());
    expect(parts.filter((p) => p.part.kind === "media")).toHaveLength(2);
  });

  test("armReplayWindow refuses a bubble another gateway owns", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    // A's own bubble record names a bubble stamped for another gateway (settled for A).
    const mX = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId, userId, role: "assistant" as const, status: "complete" as const, text: "A", runId: A, turnSessionKey: SK,
        boundInstance: "other", deliveryOwnBubble: true, deliveryKey: `run:${A}`, updatedAt: 1,
      });
      return id;
    });
    // Out of scope for `prod`: the lookup never returns it, a new bubble opens instead.
    const opened = await start(t, chatId, A);
    expect(opened).not.toBe(mX);
    expect((await msg(t, mX)).announceReplayArmed).toBeUndefined();
  });
});

describe("codex phase 5 pass 8 #2 — deleting a group member reads the conversation once", () => {
  test("14 old answers of 650 KiB, a question, 2 small grouped bubbles: deleting the LAST bubble succeeds", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { chatId, userId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      return { userId, chatId };
    });
    for (let i = 0; i < 14; i++) {
      await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "o".repeat(650 * 1024), updatedAt: 1 }));
    }
    await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "délègue", updatedAt: 1 }));
    const mP = await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Je délègue.", runId: P, turnSessionKey: SK, updatedAt: 1 }));
    await t.run((ctx) => ctx.db.patch(mP, { displayGroupId: mP }));
    const mA = await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Résultat.", runId: A, turnSessionKey: SK, displayGroupId: mP, updatedAt: 1 }));
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.messages.deleteMessage, { messageId: mA });
    expect(await t.run((ctx) => ctx.db.get(mP))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(mA))).toBeNull();
  }, 120_000);
});

describe("codex phase 5 pass 8 #3 — a group is reported only when what lies between its bubbles was read whole", () => {
  async function groupPD(t: T) {
    const { chatId, userId } = await seed(t, "on");
    const mP = await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Je délègue.", runId: P, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 }));
    const mD = await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Résultat.", runId: A, turnSessionKey: SK, boundInstance: "prod", deliveryOwnBubble: true, updatedAt: 1 }));
    await t.run(async (ctx) => {
      await ctx.db.patch(mP, { displayGroupId: mP });
      await ctx.db.patch(mD, { displayGroupId: mP });
    });
    return { chatId, userId, mP, mD };
  }
  const report = async (t: T, chatId: Id<"chats">, userId: Id<"users">, messageId: Id<"messages">) => {
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.feedback.submitFeedback, { chatId, messageId, category: "incorrect" });
    return (await t.run((ctx) => ctx.db.query("feedback").first()))!;
  };

  test("an answer placed between P and D after 61 newer messages: P is reported alone, as the reader sees it", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId, mP, mD } = await groupPD(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 61; i++) {
        await ctx.db.insert("messages", { chatId, userId, role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), status: "complete" as const, text: `m${i}`, updatedAt: 2 });
      }
    });
    const pCt = (await msg(t, mP))._creationTime;
    const dCt = (await msg(t, mD))._creationTime;
    await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "X", runId: "webchat-x", turnSessionKey: SK, boundInstance: "prod", orderTime: (pCt + dCt) / 2, updatedAt: 3 }),
    );
    const fb = await report(t, chatId, userId, mP);
    expect(fb.snapshot.messageText).toBe("Je délègue.");
    expect(fb.snapshot.groupMessageIds).toBeUndefined();
  });

  test("more between them than one read may take (queued messages placed later): reported alone, marked cut", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const mP = await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Je délègue.", runId: P, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 }));
    // Created between P and D, displayed after both (the queue's placement).
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) {
        await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: `q${i}`, orderTime: Number.MAX_SAFE_INTEGER, updatedAt: 2 });
      }
    });
    const mD = await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Résultat.", runId: A, turnSessionKey: SK, boundInstance: "prod", deliveryOwnBubble: true, updatedAt: 1 }));
    await t.run(async (ctx) => {
      await ctx.db.patch(mP, { displayGroupId: mP });
      await ctx.db.patch(mD, { displayGroupId: mP });
    });
    const fb = await report(t, chatId, userId, mP);
    expect(fb.snapshot.messageText).toBe("Je délègue.");
    expect(fb.snapshot.groupTruncated).toBe(true);
  });

  test("nothing between them: the group is reported whole", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId, mP, mD } = await groupPD(t);
    const fb = await report(t, chatId, userId, mP);
    expect(fb.snapshot.groupMessageIds).toEqual([mP, mD]);
    expect(fb.snapshot.groupTruncated).toBeUndefined();
  });
});

describe("codex phase 5 pass 9 #2 — many tool cards are not an answer", () => {
  const W1 = `announce:requester-settle:main:${SK}:${CHILD_RUN}:yield-1`;
  async function toolHeavy(t: T, extraFile: boolean) {
    const { chatId } = await seed(t, "on");
    await turnWithLaunch(t, chatId);
    const mW = (await start(t, chatId, W1))!;
    await t.run(async (ctx) => {
      for (let i = 0; i < 65; i++) {
        await ctx.db.insert("messageParts", { messageId: mW, order: i, announceRun: W1, part: { kind: "tool", name: "exec", phase: "result", toolCallId: `c${i}` } } as never);
      }
      if (extraFile) {
        // Stamped with its delivery, as `addPart` stamps every part of a delivery run.
        const storageId = await ctx.storage.store(new Blob(["pdf"]));
        await ctx.db.insert("messageParts", { messageId: mW, order: 65, announceRun: W1, part: { kind: "media", storageId, filename: "r.pdf", mimeType: "application/pdf" } } as never);
      }
    });
    await finish(t, mW, "");
    return { chatId, mW };
  }
  test("65 tool cards, nothing delivered: the retry resumes the bubble to bring the answer", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, mW } = await toolHeavy(t, false);
    expect(await start(t, chatId, `${W1}:retry-1`)).toBe(mW);
    expect((await msg(t, mW)).status).toBe("streaming");
    expect((await msg(t, mW)).runId).toBe(`${W1}:retry-1`);
  });
  test("…and a file beyond the first page of parts IS an answer: handed back unchanged", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, mW } = await toolHeavy(t, true);
    expect(await start(t, chatId, `${W1}:retry-1`)).toBe(mW);
    expect((await msg(t, mW)).status).toBe("complete");
    expect((await msg(t, mW)).runId).toBe(W1);
  });
});

describe("codex phase 5 pass 9 #1 — deleting the clicked bubble never crosses a message the client could not see", () => {
  test("P and D placed around an old question X: deleting D keeps X and P", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await seed(t, "on");
    const X = await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "question X", updatedAt: 1 }));
    const xCt = (await msg(t, X))._creationTime;
    const mP = await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "P", runId: P, turnSessionKey: SK, boundInstance: "prod", orderTime: xCt - 1, updatedAt: 2 }));
    const mD = await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "D", runId: A, turnSessionKey: SK, boundInstance: "prod", orderTime: xCt + 1, updatedAt: 2 }));
    await t.run(async (ctx) => {
      await ctx.db.patch(mP, { displayGroupId: mP });
      await ctx.db.patch(mD, { displayGroupId: mP });
    });
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.messages.deleteMessage, { messageId: mD });
    expect(await t.run((ctx) => ctx.db.get(X))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(mP))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(mD))).toBeNull();
  });
});

// ── codex phase 5 pass 12 #2: the bench's dev probe ─────────────────────────────────────
describe("dev.peekSubAgents — the last display group, read only when there is one", () => {
  async function seed(t: T, opts: { grouped: boolean; memberBytes?: number; members?: number }) {
    const { userId, chatId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "q", updatedAt: 1 });
      return { userId, chatId };
    });
    // One transaction per member: a heavy group weighs more than one may write.
    const ids: Id<"messages">[] = [];
    for (let i = 0; i < (opts.members ?? 3); i++) {
      ids.push(
        await t.run((ctx) =>
          ctx.db.insert("messages", {
            chatId,
            userId,
            role: "assistant" as const,
            status: "complete" as const,
            text: "x".repeat(opts.memberBytes ?? 4),
            runId: i === 0 ? "turn" : `announce:v1:${CHILD}-${i}:${CHILD_RUN}`,
            turnSessionKey: SK,
            ...(opts.grouped && i > 0 ? { displayGroupId: ids[0]! } : {}),
            updatedAt: 1,
          }),
        ),
      );
      if (opts.grouped && i === 0) await t.run((ctx) => ctx.db.patch(ids[0]!, { displayGroupId: ids[0]! }));
    }
    return { chatId, ids };
  }

  test("ungrouped: the last message alone (0.96.0's single read)", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, ids } = await seed(t, { grouped: false });
    const r = await t.query(api.dev.peekSubAgents, { chatId });
    expect(r.lastMessage).toMatchObject({ id: ids[2], groupMemberIds: [ids[2]], displayGroupId: null, groupCut: false, mergedAnnounceRuns: [] });
  });

  test("grouped: every member, in display order, and every member's run", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, ids } = await seed(t, { grouped: true });
    const r = await t.query(api.dev.peekSubAgents, { chatId });
    expect(r.lastMessage?.groupMemberIds).toEqual(ids);
    expect(r.lastMessage?.mergedAnnounceRuns).toEqual(["turn", `announce:v1:${CHILD}-1:${CHILD_RUN}`, `announce:v1:${CHILD}-2:${CHILD_RUN}`]);
    expect(r.lastMessage?.groupCut).toBe(false);
  });

  test("a group heavier than the probe's budget: reported cut, under the real read limit", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { chatId, ids } = await seed(t, { grouped: true, members: 20, memberBytes: 650 * 1024 });
    const r = await t.query(api.dev.peekSubAgents, { chatId });
    expect(r.lastMessage).toMatchObject({ id: ids[19], groupMemberIds: [ids[19]], groupCut: true });
  });
});
