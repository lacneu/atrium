/// <reference types="vite/client" />
//
// Sub-agent observation store (increment 1 of the sub-agent monitor).
//
// Pins:
//   - upsertSubAgent UPSERTS by childSessionKey (insert, then patch the same row).
//   - the reorder-tolerance guard: a terminal status (done) is never downgraded
//     back to running by a late registration.
//   - listSubAgents is OWNER-SCOPED (the per-user access boundary): the owner sees
//     their chat's rows; a non-owner is rejected.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { mergeSubAgentTools } from "./subAgents";

const modules = import.meta.glob("./**/*.ts");

async function seedUserAndChat(t: ReturnType<typeof convexTest>, canonical = "alice") {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user", canonical });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    return { userId, chatId };
  });
}

const CHILD = "agent:alice:subagent:50a9857b-5b2f-40ce-867d-2e20d2e2b737";

describe("subAgents.upsertSubAgent", () => {
  test("insert then update BY childSessionKey (one row, patched in place)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);

    // First sight: register (running) + task name.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      taskName: "do the thing",
      status: "running" as const,
    });
    // Later child frame: terminal result.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "done" as const,
      resultText: "SUBAGENT_PONG_42",
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .collect(),
    );
    // Exactly ONE row (upsert, not append).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      childSessionKey: CHILD,
      status: "done",
      resultText: "SUBAGENT_PONG_42",
      taskName: "do the thing", // preserved from the registration insert
    });
    // createdAt set on insert, updatedAt advanced on patch.
    expect(rows[0]!.updatedAt).toBeGreaterThanOrEqual(rows[0]!.createdAt);
  });

  test("a terminal status is never downgraded back to running (reorder-tolerance)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);

    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "done" as const,
      resultText: "FINAL",
    });
    // A late spawn-registration arriving out of order must NOT un-finalize it.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .unique(),
    );
    expect(row!.status).toBe("done");
    expect(row!.resultText).toBe("FINAL");
  });

  test("sessionMeta MERGES last-known (a later partial never wipes a captured field)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
      sessionMeta: { model: "gpt-5.5", thinkingLevel: "high" },
    });
    // A later frame carries only a NEW field — it must merge, not replace.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
      sessionMeta: { fastMode: false, controlScope: "none" },
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .unique(),
    );
    expect(row!.sessionMeta).toEqual({
      model: "gpt-5.5", // preserved across the second upsert
      thinkingLevel: "high",
      fastMode: false, // merged in
      controlScope: "none",
    });
  });
});

describe("subAgents.listSubAgents — owner scoping", () => {
  test("the owner sees their chat's sub-agents", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
      taskName: "task A",
    });

    const as = t.withIdentity({ subject: `${userId}|session` });
    const rows = await as.query(api.subAgents.listSubAgents, { chatId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.childSessionKey).toBe(CHILD);
  });

  test("a NON-owner is rejected (the access boundary)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t, "alice");
    // A second, unrelated user.
    const otherUserId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "bob" });
      return uid as Id<"users">;
    });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
    });

    const asOther = t.withIdentity({ subject: `${otherUserId}|session` });
    await expect(
      asOther.query(api.subAgents.listSubAgents, { chatId }),
    ).rejects.toThrow(/not owned/i);
  });

  test("returns [] for a chat with no sub-agents", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    expect(await as.query(api.subAgents.listSubAgents, { chatId })).toEqual([]);
  });
});

// codex P1: the store holds chat content (result/error text) -> it must not outlive its chat.
describe("subAgents cleanup (no orphaned chat content)", () => {
  test("deleting a chat PURGES its sub-agent rows (cascade)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    // Raw count via the chat-scoped index (a deleted chat would make the owner-scoped
    // listSubAgents throw, so we read the table directly with the schema-bound `t`).
    const countRows = () =>
      t.run((ctx) =>
        ctx.db
          .query("subAgents")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect(),
      );
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "done" as const,
      resultText: "private result text",
    });
    expect(await countRows()).toHaveLength(1);
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chats.deleteChat, { chatId });
    expect(await countRows()).toHaveLength(0); // no orphan left
  });

  test("upsert for a VANISHED chat is ignored (a late child frame never recreates an orphan)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chats.deleteChat, { chatId });
    // A child frame arrives AFTER the chat is gone.
    const ret = await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
    });
    expect(ret).toBeNull(); // ignored, not re-inserted
    const orphans = await t.run((ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .collect(),
    );
    expect(orphans).toHaveLength(0);
  });
});

describe("subAgents.upsertSubAgentToolPart — per-tool detail (args + result)", () => {
  test("start INSERTS args (running); result PATCHES the SAME row to done + keeps args", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);
    // start frame: args known, running.
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "running" as const,
      argsText: '{"command":"echo hi"}',
    });
    // result frame: output known, done — args omitted (must NOT be wiped).
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "done" as const,
      resultText: "hi",
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("subAgentToolParts")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .collect(),
    );
    expect(rows).toHaveLength(1); // upsert by (child, toolCallId) — not appended
    expect(rows[0]).toMatchObject({
      toolCallId: "call_1",
      status: "done",
      argsText: '{"command":"echo hi"}', // set-once survives the result patch
      resultText: "hi",
    });
  });

  test("a terminal tool part is never downgraded back to running (reorder-tolerance)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "done" as const,
      resultText: "OK",
    });
    // A late running frame for the same call must not un-finish it.
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "running" as const,
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query("subAgentToolParts")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .first(),
    );
    expect(row!.status).toBe("done");
    expect(row!.resultText).toBe("OK");
  });

  test("listSubAgentToolParts is OWNER-SCOPED (owner sees, non-owner rejected)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t, "alice");
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "web_search",
      status: "done" as const,
      argsText: '{"query":"news"}',
      resultText: "results...",
    });
    const otherUserId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "bob" });
      return uid as Id<"users">;
    });

    const asOwner = t.withIdentity({ subject: `${userId}|session` });
    const rows = await asOwner.query(api.subAgents.listSubAgentToolParts, {
      chatId,
      childSessionKey: CHILD,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "web_search", resultText: "results..." });

    const asOther = t.withIdentity({ subject: `${otherUserId}|session` });
    await expect(
      asOther.query(api.subAgents.listSubAgentToolParts, {
        chatId,
        childSessionKey: CHILD,
      }),
    ).rejects.toThrow(/not owned/i);
  });

  test("deleting a chat PURGES its tool-part rows (cascade — no orphaned content)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "done" as const,
      resultText: "private tool output",
    });
    const count = () =>
      t.run((ctx) =>
        ctx.db
          .query("subAgentToolParts")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect(),
      );
    expect(await count()).toHaveLength(1);
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chats.deleteChat, { chatId });
    expect(await count()).toHaveLength(0); // purged with the chat
  });

  test("upsert for a VANISHED chat is ignored (no orphan tool detail re-created)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chats.deleteChat, { chatId });
    const ret = await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "running" as const,
      argsText: "{}",
    });
    expect(ret).toBeNull();
    const orphans = await t.run((ctx) =>
      ctx.db
        .query("subAgentToolParts")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .collect(),
    );
    expect(orphans).toHaveLength(0);
  });
});

describe("mergeSubAgentTools (Inc 4 — reorder-tolerant child-tool merge)", () => {
  test("appends a new tool, keeping first-seen order", () => {
    expect(
      mergeSubAgentTools(
        [{ name: "exec", status: "done", toolCallId: "c1" }],
        [{ name: "web_search", status: "running", toolCallId: "c2" }],
      ),
    ).toEqual([
      { name: "exec", status: "done", toolCallId: "c1" },
      { name: "web_search", status: "running", toolCallId: "c2" },
    ]);
  });

  test("running -> done flips the same tool (deduped by toolCallId)", () => {
    expect(
      mergeSubAgentTools(
        [{ name: "exec", status: "running", toolCallId: "c1" }],
        [{ name: "exec", status: "done", toolCallId: "c1" }],
      ),
    ).toEqual([{ name: "exec", status: "done", toolCallId: "c1" }]);
  });

  test("a LATE running frame never un-finishes a done tool (the whole point)", () => {
    expect(
      mergeSubAgentTools(
        [{ name: "exec", status: "done", toolCallId: "c1" }],
        [{ name: "exec", status: "running", toolCallId: "c1" }],
      ),
    ).toEqual([{ name: "exec", status: "done", toolCallId: "c1" }]);
  });

  test("undefined incoming leaves the stored list unchanged (same reference)", () => {
    const existing = [{ name: "exec", status: "done" as const, toolCallId: "c1" }];
    expect(mergeSubAgentTools(existing, undefined)).toBe(existing);
  });
});
