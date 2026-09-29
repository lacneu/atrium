/// <reference types="vite/client" />
//
// LIVE-TURN DIFFICULTY end to end on the store: parts written through the REAL ingest
// path (stream.addPart, start then error upserted on the provider's toolCallId), read
// by the query the sidebar and the bubble subscribe to (chatReads.liveTurnDifficulty),
// by the diagnostic chat-state, and classified by diagnose. Synthetic ids and paths.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assessChat } from "./lib/diagnose";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { LIVE_ACTIVITY_STAMP_MS } from "./lib/liveTurnDifficulty";
import { turnDifficultyVerdict } from "./lib/turnDifficulty";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type T = ReturnType<typeof convexTest>;

async function seed(t: T, opts: { runId?: string } = {}) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    });
    await ctx.db.insert("streamingText", {
      messageId,
      chatId,
      userId,
      text: "",
      updatedAt: 1,
    });
    return { userId, chatId, messageId };
  });
}

/** One tool call through the real ingest: its start, then its outcome. */
async function call(
  t: T,
  messageId: Id<"messages">,
  id: string,
  name: string,
  outcome: "completed" | "error" | "start",
) {
  await t.mutation(internal.stream.addPart, {
    messageId,
    part: { kind: "tool", name, phase: "start", toolCallId: id, input: { path: "/tmp/x.png" } },
  });
  if (outcome === "start") return;
  await t.mutation(internal.stream.addPart, {
    messageId,
    part: {
      kind: "tool",
      name,
      phase: outcome,
      toolCallId: id,
      output: outcome === "error" ? { status: "error", error: "refused" } : { ok: true },
    },
  });
}

const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s` });

describe("chatReads.liveTurnDifficulty", () => {
  test("three failed view_image calls flag the live turn; a success clears it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const q = () => as(t, s.userId).query(api.chatReads.liveTurnDifficulty, { chatIds: [s.chatId] });

    await call(t, s.messageId, "c1", "view_image", "error");
    await call(t, s.messageId, "c2", "view_image", "error");
    // Two failures: rule 1 waits for the third. What the server reports is only the
    // rule-3 CANDIDATE — and its verdict is null: the failure is fresh.
    const two = await q();
    expect(two.map((r) => r.facts.kind)).toEqual(["failed_then_quiet"]);
    expect(turnDifficultyVerdict(two[0]!.facts, Date.now())).toBeNull();
    await call(t, s.messageId, "c3", "view_image", "error");
    expect(await q()).toEqual([
      {
        chatId: s.chatId,
        messageId: s.messageId,
        facts: { kind: "repeated_failures", tool: "view_image", failures: 3, sameTool: true },
      },
    ]);
    // A fourth attempt in flight does not clear it…
    await call(t, s.messageId, "c4", "view_image", "start");
    expect((await q())[0]?.facts).toMatchObject({ failures: 3 });
    // …its success does: progress resumed.
    await call(t, s.messageId, "c4", "view_image", "completed");
    expect(await q()).toEqual([]);
  });

  test("the turn ending clears it (only streaming turns are judged)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (const id of ["a", "b", "c"]) await call(t, s.messageId, id, "web_fetch", "error");
    await t.mutation(internal.stream.finalize, {
      messageId: s.messageId,
      status: "complete",
      text: "fini",
    });
    expect(
      await as(t, s.userId).query(api.chatReads.liveTurnDifficulty, { chatIds: [s.chatId] }),
    ).toEqual([]);
  });

  test("ONE failure then silence: the silence counts from the failure's write", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await call(t, s.messageId, "v1", "view_image", "error");
    const failedAt = 1_789_133_350_000;
    await t.run(async (ctx) => {
      await ctx.db.patch(s.messageId, { updatedAt: failedAt });
    });
    expect(
      await as(t, s.userId).query(api.chatReads.liveTurnDifficulty, { chatIds: [s.chatId] }),
    ).toEqual([
      {
        chatId: s.chatId,
        messageId: s.messageId,
        facts: { kind: "failed_then_quiet", tool: "view_image", quietSince: failedAt },
      },
    ]);
  });

  test("text streamed AFTER the failure moves the silence's start — through the throttled stamp", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await call(t, s.messageId, "v1", "view_image", "error");
    await t.run(async (ctx) => {
      await ctx.db.patch(s.messageId, { updatedAt: 1 });
    });
    // The agent writes its answer after the failure (the real ingest path).
    await t.mutation(internal.stream.appendDelta, { messageId: s.messageId, text: "Je ne " });
    const stamped = await t.run(
      async (ctx) => (await ctx.db.query("liveTurnActivity").collect())[0]!,
    );
    expect(stamped.at).toBeTypeOf("number");
    const [row] = await as(t, s.userId).query(api.chatReads.liveTurnDifficulty, {
      chatIds: [s.chatId],
    });
    // A stamp covers up to one interval after it: never an alarm earlier than the truth.
    expect(row?.facts).toEqual({
      kind: "failed_then_quiet",
      tool: "view_image",
      quietSince: stamped.at! + LIVE_ACTIVITY_STAMP_MS,
    });
  });

  test("the stamp is THROTTLED: tokens within the interval write nothing; past it, one write", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.appendDelta, { messageId: s.messageId, text: "a" });
    const first = await t.run(async (ctx) => await ctx.db.query("liveTurnActivity").collect());
    expect(first).toHaveLength(1);
    for (const text of ["b", "c", "d"]) {
      await t.mutation(internal.stream.appendDelta, { messageId: s.messageId, text });
    }
    await t.mutation(internal.stream.setSnapshot, { messageId: s.messageId, text: "abcde" });
    const still = await t.run(async (ctx) => await ctx.db.query("liveTurnActivity").collect());
    // Same row, same stamp: the per-token writes never touched it.
    expect(still).toEqual(first);
    // Move the cursor one interval back: the next token stamps again.
    const movedBack = first[0]!.at! - LIVE_ACTIVITY_STAMP_MS;
    await t.run(async (ctx) => {
      const live = (await ctx.db.query("streamingText").collect())[0]!;
      await ctx.db.patch(live._id, {
        activityStampedAt: live.activityStampedAt! - LIVE_ACTIVITY_STAMP_MS,
      });
      const act = (await ctx.db.query("liveTurnActivity").collect())[0]!;
      await ctx.db.patch(act._id, { at: movedBack });
    });
    await t.mutation(internal.stream.appendDelta, { messageId: s.messageId, text: "f" });
    const after = await t.run(async (ctx) => await ctx.db.query("liveTurnActivity").collect());
    expect(after).toHaveLength(1);
    expect(after[0]!.at).toBeGreaterThan(movedBack);
  });

  test("the turn ending deletes its activity row", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.appendDelta, { messageId: s.messageId, text: "a" });
    await t.mutation(internal.stream.finalize, {
      messageId: s.messageId,
      status: "complete",
      text: "a",
    });
    expect(
      await t.run(async (ctx) => await ctx.db.query("liveTurnActivity").collect()),
    ).toEqual([]);
  });

  test("silence under a declared wait (a question to the person) is not a stall", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await call(t, s.messageId, "q1", "exec", "error");
    const q = () =>
      as(t, s.userId).query(api.chatReads.liveTurnDifficulty, { chatIds: [s.chatId] });
    // The phase reaches the activity row through the real phase write.
    await t.mutation(internal.stream.setPhase, {
      messageId: s.messageId,
      phase: "awaiting_input",
    });
    expect(await q()).toEqual([]);
    // The person answered, the agent resumes: the wait is over, the candidate is back.
    await t.mutation(internal.stream.setPhase, { messageId: s.messageId, phase: "generating" });
    expect((await q()).map((r) => r.facts.kind)).toEqual(["failed_then_quiet"]);
  });

  test("the loader never reads the per-token live-text row (it would re-run on every token)", () => {
    const file = "convex/lib/liveTurnDifficulty.ts";
    const sf = ts.createSourceFile(
      file,
      readFileSync(join(process.cwd(), file), "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const tables: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "query" &&
        n.arguments[0] !== undefined &&
        ts.isStringLiteral(n.arguments[0])
      ) {
        tables.push(n.arguments[0].text);
      }
      ts.forEachChild(n, visit);
    };
    const loader = sf.statements.find(
      (st) => ts.isFunctionDeclaration(st) && st.name?.text === "loadLiveTurnDifficultyFacts",
    );
    expect(loader).toBeDefined();
    visit(loader!);
    expect(tables.sort()).toEqual(["liveTurnActivity", "messageParts"]);
  });

  test("a reopened bubble does not inherit the struggle of the run that opened it", async () => {
    const t = convexTest(schema, modules);
    // The parent's OWN three failures (unstamped), then a delegated result reopened
    // the bubble: the run streaming now is the delivery.
    const s = await seed(t);
    for (const id of ["p1", "p2", "p3"]) await call(t, s.messageId, id, "sessions_spawn", "error");
    await t.run(async (ctx) => {
      await ctx.db.patch(s.messageId, {
        runId: "announce:v1:agent:main:subagent:child-1:run-1",
      });
    });
    expect(
      await as(t, s.userId).query(api.chatReads.liveTurnDifficulty, { chatIds: [s.chatId] }),
    ).toEqual([]);
  });

  test("a chat the caller cannot reach is skipped, never reported", async () => {
    const t = convexTest(schema, modules);
    const owner = await seed(t);
    const intruder = await seed(t);
    for (const id of ["a", "b", "c"]) await call(t, owner.messageId, id, "browser", "error");
    expect(
      await as(t, intruder.userId).query(api.chatReads.liveTurnDifficulty, {
        chatIds: [owner.chatId],
      }),
    ).toEqual([]);
    expect(
      await as(t, owner.userId).query(api.chatReads.liveTurnDifficulty, {
        chatIds: [owner.chatId],
      }),
    ).toHaveLength(1);
  });
});

describe("chat-state + diagnose read the same facts", () => {
  test("liveDifficulty on the streaming message, and the agent_struggling class", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await call(t, s.messageId, "ok", "read", "completed");
    for (const id of ["a", "b", "c", "d"]) await call(t, s.messageId, id, "web_fetch", "error");
    const state = await t.query(internal.messages.chatStateInternal, {
      chatId: s.chatId,
      includeParts: false,
    });
    if (!state.ok) throw new Error("chat-state refused");
    const live = state.messages.find((m) => m.messageId === s.messageId);
    expect(live?.liveDifficulty).toEqual({
      kind: "repeated_failures",
      tool: "web_fetch",
      failures: 4,
      sameTool: true,
    });
    const assessment = assessChat(state, {
      known: true,
      available: true,
      degraded: false,
      reason: null,
    });
    expect(assessment.class).toBe("agent_struggling");
    expect(assessment.reason).toContain("4 failed `web_fetch` calls");
  });

  test("a settled turn carries no liveDifficulty field at all", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (const id of ["a", "b", "c"]) await call(t, s.messageId, id, "web_fetch", "error");
    await t.mutation(internal.stream.finalize, {
      messageId: s.messageId,
      status: "complete",
      text: "fini",
    });
    const state = await t.query(internal.messages.chatStateInternal, { chatId: s.chatId });
    if (!state.ok) throw new Error("chat-state refused");
    const settled = state.messages.find((m) => m.messageId === s.messageId);
    expect(settled && "liveDifficulty" in settled).toBe(false);
  });
});
