// Multi-chat UX plumbing (increment 4):
//   1. stream.finalize stamps chats.lastAssistantAt on COMPLETE — and ONLY on
//      complete (an error/aborted turn must never read as "a reply arrived").
//   2. markChatSeen upserts the per-user read watermark, owner-scoped, and is
//      monotonic (a racing late call can never move it backwards).
//   3. myChatReads returns the user's own map — and never another user's rows.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seedChatWithStreaming(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "u",
    });
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
      liveText: "réponse en cours",
      updatedAt: 1,
    });
    return { userId, chatId, messageId };
  });
}

describe("chats.lastAssistantAt (arrival signal)", () => {
  test("finalize COMPLETE stamps the chat; error does NOT", async () => {
    const t = convexTest(schema, modules);
    const a = await seedChatWithStreaming(t);
    await t.mutation(internal.stream.finalize, {
      messageId: a.messageId,
      status: "complete",
      text: "voilà",
    });
    const chatA = await t.run((ctx) => ctx.db.get(a.chatId));
    expect(chatA?.lastAssistantAt).toBeTypeOf("number");

    const b = await seedChatWithStreaming(t);
    await t.mutation(internal.stream.finalize, {
      messageId: b.messageId,
      status: "error",
      error: "boom",
    });
    const chatB = await t.run((ctx) => ctx.db.get(b.chatId));
    expect(chatB?.lastAssistantAt).toBeUndefined();
  });

  test("a REDELIVERED finalize(complete) does not re-stamp (idempotent arrivals)", async () => {
    const t = convexTest(schema, modules);
    const a = await seedChatWithStreaming(t);
    await t.mutation(internal.stream.finalize, {
      messageId: a.messageId,
      status: "complete",
      text: "voilà",
    });
    const first = (await t.run((ctx) => ctx.db.get(a.chatId)))!.lastAssistantAt;
    // Same-status redelivery is supported by finalize's idempotence guard —
    // it must NOT move the arrival stamp (would resurrect the unread dot /
    // replay the sound for a reply the user already saw).
    await new Promise((r) => setTimeout(r, 5));
    await t.mutation(internal.stream.finalize, {
      messageId: a.messageId,
      status: "complete",
      text: "voilà",
    });
    const second = (await t.run((ctx) => ctx.db.get(a.chatId)))!.lastAssistantAt;
    expect(second).toBe(first);
  });
});

describe("chatReads (per-user read state)", () => {
  test("markChatSeen upserts; myChatReads returns ONLY the caller's rows", async () => {
    const t = convexTest(schema, modules);
    const a = await seedChatWithStreaming(t);
    const other = await seedChatWithStreaming(t); // a second user + chat
    const asA = t.withIdentity({ subject: `${a.userId}|s` });
    const asOther = t.withIdentity({ subject: `${other.userId}|s` });

    await asA.mutation(api.chatReads.markChatSeen, { chatId: a.chatId });
    await asOther.mutation(api.chatReads.markChatSeen, {
      chatId: other.chatId,
    });

    const mineA = await asA.query(api.chatReads.myChatReads, {});
    expect(mineA.map((r) => r.chatId)).toEqual([a.chatId]);
    const firstSeen = mineA[0]!.lastSeenAt;

    // Re-mark: the row is PATCHED (still one row), watermark moves forward.
    await asA.mutation(api.chatReads.markChatSeen, { chatId: a.chatId });
    const mineA2 = await asA.query(api.chatReads.myChatReads, {});
    expect(mineA2).toHaveLength(1);
    expect(mineA2[0]!.lastSeenAt).toBeGreaterThanOrEqual(firstSeen);
  });

  test("marking a chat you do not own is Forbidden", async () => {
    const t = convexTest(schema, modules);
    const a = await seedChatWithStreaming(t);
    const intruder = await seedChatWithStreaming(t);
    const asIntruder = t.withIdentity({ subject: `${intruder.userId}|s` });
    await expect(
      asIntruder.mutation(api.chatReads.markChatSeen, { chatId: a.chatId }),
    ).rejects.toThrow(/not owned/i);
  });

  test("markChatSeen is a NO-OP under impersonation (admin viewing must not consume unread)", async () => {
    const t = convexTest(schema, modules);
    const target = await seedChatWithStreaming(t);
    // Admin impersonating the target (effective identity flips to target).
    const adminUserId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "admin" as const,
        canonical: "adm",
        impersonatingUserId: target.userId,
      });
      return userId;
    });
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s` });
    await asAdmin.mutation(api.chatReads.markChatSeen, {
      chatId: target.chatId,
    });
    const rows = await t.run((ctx) => ctx.db.query("chatReads").collect());
    expect(rows).toHaveLength(0); // nothing written for anyone
  });

  test("deleting a chat purges its chatReads row (no orphans)", async () => {
    const t = convexTest(schema, modules);
    const a = await seedChatWithStreaming(t);
    const asA = t.withIdentity({ subject: `${a.userId}|s` });
    await asA.mutation(api.chatReads.markChatSeen, { chatId: a.chatId });
    expect(
      await t.run(async (ctx) => (await ctx.db.query("chatReads").collect()).length),
    ).toBe(1);
    await asA.mutation(api.chats.deleteChat, { chatId: a.chatId });
    expect(
      await t.run(async (ctx) => (await ctx.db.query("chatReads").collect()).length),
    ).toBe(0);
  });
});
