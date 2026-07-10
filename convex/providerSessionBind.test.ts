import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

// The Hermes post-ACK session bind vs /reset race (codex P1): the bind is
// fire-and-forget on the bridge, so ONLY the Convex mutation can close the
// window atomically. clearProviderChat bumps the reset EPOCH even when the
// slot was empty (a not-yet-bound first turn is exactly the dangerous case —
// a slot-value CAS could not tell "initial null" from "reset-to-null");
// bindProviderChat refuses a bind carrying a stale epoch.

async function seedChat(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    return await ctx.db.insert("chats", { userId, updatedAt: 1 });
  });
}

describe("bindProviderChat reset-epoch guard", () => {
  test("a bind under the CURRENT epoch persists the session id", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.bridge.bindProviderChat, {
      chatId: chatId as Id<"chats">,
      providerChatId: "api_1_abcd",
      resetCount: 0,
    });
    const chat = await t.run((ctx) => ctx.db.get(chatId as Id<"chats">));
    expect(chat!.openclawChatId).toBe("api_1_abcd");
  });

  test("a /reset during the bind's network flight wins: the stale-epoch bind stands down (even on an EMPTY slot)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    // The turn started under epoch 0; the user resets while the bind is in
    // flight — the slot was still EMPTY (first turn), so only the epoch bump
    // records the reset intent.
    await t.mutation(internal.bridge.clearProviderChat, {
      chatId: chatId as Id<"chats">,
    });
    // The late bind arrives with the epoch it started under → refused.
    await t.mutation(internal.bridge.bindProviderChat, {
      chatId: chatId as Id<"chats">,
      providerChatId: "api_1_abcd",
      resetCount: 0,
    });
    const chat = await t.run((ctx) => ctx.db.get(chatId as Id<"chats">));
    expect(chat!.openclawChatId).toBeUndefined();
    expect(chat!.providerResetCount).toBe(1);

    // The NEXT turn (dispatched after the reset) carries the bumped epoch and
    // binds normally — the guard never wedges legitimate continuity.
    await t.mutation(internal.bridge.bindProviderChat, {
      chatId: chatId as Id<"chats">,
      providerChatId: "api_2_beef",
      resetCount: 1,
    });
    const after = await t.run((ctx) => ctx.db.get(chatId as Id<"chats">));
    expect(after!.openclawChatId).toBe("api_2_beef");
  });

  test("an OLD bridge (no epoch on the wire) keeps the unguarded pre-existing behavior", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.bridge.clearProviderChat, {
      chatId: chatId as Id<"chats">,
    });
    await t.mutation(internal.bridge.bindProviderChat, {
      chatId: chatId as Id<"chats">,
      providerChatId: "api_1_abcd",
    });
    const chat = await t.run((ctx) => ctx.db.get(chatId as Id<"chats">));
    expect(chat!.openclawChatId).toBe("api_1_abcd");
  });
});
