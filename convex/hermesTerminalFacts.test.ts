/// <reference types="vite/client" />
//
// The terminal facts must be ORDERED, and a counted compaction must be SEEN (lot 39, G-50).
//
// Two failures the first cut of this lot had, both raised in review:
//
//  * the four fields arrive on a turn's TERMINAL, off the ordered chain and un-awaited, so
//    two reports can land inverted — and nothing stopped `compactionCount` from walking
//    BACKWARDS. A session that compacted three times reported as having compacted twice is
//    worse than no record at all, because it reads as authoritative.
//
//  * the count was stored and nothing acted on it. The entire reason it is worth reading is
//    that Atrium's live compaction marker rides a `status.update` upstream broadcasts
//    `dropIfSlow` — so a slow consumer never learns the session forgot half its history.
//    Saving the number without showing anything would have repeated the mistake of saving
//    text nobody renders.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

async function seedChat(t: T, withSettledTurn = true) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    if (withSettledTurn) {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "voilà",
        updatedAt: 1,
      });
    }
    return chatId;
  });
}

const metaOf = async (t: T, chatId: Id<"chats">) =>
  await t.run(async (ctx) => {
    const c = await ctx.db.get(chatId);
    return (c?.sessionMeta ?? {}) as Record<string, number | undefined>;
  });

const compactionParts = async (t: T) =>
  await t.run(async (ctx) =>
    (await ctx.db.query("messageParts").collect()).filter(
      (p) => (p.part as { kind?: string }).kind === "compaction",
    ),
  );

async function report(t: T, chatId: Id<"chats">, meta: Record<string, number>) {
  await t.mutation(internal.stream.setSessionMeta, { chatId, meta });
}

describe("cumulative counters only ever grow", () => {
  test("an out-of-order report cannot walk the compaction count backwards", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await report(t, chatId, { compactionCount: 3, apiCalls: 40 });
    // A second terminal, reporting an EARLIER state, lands afterwards.
    await report(t, chatId, { compactionCount: 2, apiCalls: 12 });
    const meta = await metaOf(t, chatId);
    expect(meta.compactionCount, "a compaction cannot un-happen").toBe(3);
    expect(meta.apiCalls).toBe(40);
  });

  test("a genuine rise is recorded", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await report(t, chatId, { compactionCount: 1 });
    await report(t, chatId, { compactionCount: 4 });
    expect((await metaOf(t, chatId)).compactionCount).toBe(4);
  });
});

describe("point-in-time facts follow the observation clock", () => {
  test("a STALE report does not restore an old percentage", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await report(t, chatId, { contextPercent: 70, activeSubagents: 2, observedAt: 2000 });
    await report(t, chatId, { contextPercent: 10, activeSubagents: 9, observedAt: 1000 });
    const meta = await metaOf(t, chatId);
    expect(meta.contextPercent, "the fresher reading wins").toBe(70);
    expect(meta.activeSubagents).toBe(2);
  });

  test("…but a FRESH one may legitimately fall", async () => {
    // Unlike the counters, occupancy really does go down — after a compaction.
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await report(t, chatId, { contextPercent: 90, observedAt: 1000 });
    await report(t, chatId, { contextPercent: 20, observedAt: 2000 });
    expect((await metaOf(t, chatId)).contextPercent).toBe(20);
  });
});

describe("a counted compaction reaches the thread", () => {
  test("a RISE marks the last settled turn", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await report(t, chatId, { compactionCount: 1 });
    // First sighting establishes the baseline — nothing to announce yet.
    expect(await compactionParts(t)).toHaveLength(0);
    await report(t, chatId, { compactionCount: 2 });
    const parts = await compactionParts(t);
    expect(parts, "a compaction whose live marker was lost must still show").
      toHaveLength(1);
    expect((parts[0]!.part as { phase?: string }).phase).toBe("counted");
  });

  test("a jump of many writes ONE marker, and says so", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await report(t, chatId, { compactionCount: 1 });
    await report(t, chatId, { compactionCount: 9 });
    const parts = await compactionParts(t);
    expect(parts).toHaveLength(1);
    expect((parts[0]!.part as { phase?: string }).phase).toBe("counted-multiple");
  });

  test("a STREAMING turn is left alone — its own live marker owns that bubble", async () => {
    const t = convexTest(schema, modules);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const id = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      await ctx.db.insert("messages", {
        chatId: id,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      });
      return id;
    });
    await report(t, chatId, { compactionCount: 1 });
    await report(t, chatId, { compactionCount: 2 });
    expect(await compactionParts(t), "would double-show the same event").toHaveLength(0);
  });
});

describe("a session RESET starts the counters over", () => {
  test("the old maximum no longer caps the new session", async () => {
    // The counters are floored by their own previous value — a guard against out-of-order
    // terminals — so leaving them across a reset meant the NEW session's low count stayed
    // capped by a tally that no longer describes anything, and its compactions produced no
    // marker until it overtook the old one (raised in review).
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await report(t, chatId, { compactionCount: 7, apiCalls: 300 });
    await t.mutation(internal.stream.clearSessionStateAfterReset, {
      chatId,
      resetStartedAt: Date.now(),
    });
    const cleared = await metaOf(t, chatId);
    expect(cleared.compactionCount, "a new session has not compacted 7 times").
      toBeUndefined();
    expect(cleared.apiCalls).toBeUndefined();
    // …and the fresh session's own rise is visible again.
    await report(t, chatId, { compactionCount: 1 });
    await report(t, chatId, { compactionCount: 2 });
    expect((await metaOf(t, chatId)).compactionCount).toBe(2);
  });
});

describe("one event, one marker", () => {
  test("a turn that already carries a compaction part is not marked twice", async () => {
    // The count POST travels off the ordered chain, so it can land AFTER the finalize — by
    // which time the turn's own LIVE marker may already sit on this message. A second part
    // for one event hid in the data, since the renderer shows only the first.
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await report(t, chatId, { compactionCount: 1 });
    // The live marker lands first.
    await t.run(async (ctx) => {
      const msg = await ctx.db.query("messages").first();
      await ctx.db.insert("messageParts", {
        messageId: msg!._id,
        order: 1,
        part: { kind: "compaction" as const, phase: "inflight", at: 1 },
      });
    });
    await report(t, chatId, { compactionCount: 2 });
    const parts = await compactionParts(t);
    expect(parts, "one compaction, one marker").toHaveLength(1);
    expect((parts[0]!.part as { phase?: string }).phase).toBe("inflight");
  });
});
