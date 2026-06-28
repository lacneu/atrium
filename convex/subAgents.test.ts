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
