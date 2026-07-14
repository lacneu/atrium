import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// The context gauge's activeTokens lifecycle. Discriminating properties:
//   - a sessions.get refresh PRESERVES the per-turn stamp (replace semantics
//     must not wipe it between turns);
//   - a refresh describing a NEW session (cumulative counter FELL) drops it
//     (a fresh session must not wear the dead session's fill);
//   - out-of-order fire-and-forget stamps: the stale observation loses.

async function seedChat(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    return ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "alice",
    });
  });
}

describe("setSessionActiveTokens / setSessionMeta lifecycle", () => {
  test("a meta refresh preserves the stamp; a NEW session (counter fell) drops it", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 112000,
      observedAt: 1000,
    });
    // Same session, refreshed meta (cumulative counter grew): stamp survives.
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: { model: "gpt-5.5", totalTokens: 500000, contextTokens: 272000 },
    });
    let sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.activeTokens).toBe(112000);
    // NEW session: the gateway counter FELL below the stamp -> drop it.
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: { model: "gpt-5.5", totalTokens: 4000, contextTokens: 272000 },
    });
    sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.activeTokens).toBeUndefined();
  });

  test("a PRE-turn snapshot landing AFTER the stamp must not drop it (out-of-order meta)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    // End-of-turn stamp observed at t=5000.
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 200000,
      observedAt: 5000,
    });
    // The PRE-turn snapshot (observed at t=4000, smaller counter) lands late:
    // its fallen counter must NOT read as a new session.
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        model: "gpt-5.5",
        totalTokens: 90000,
        contextTokens: 272000,
        observedAt: 4000,
      },
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.activeTokens).toBe(200000);
  });

  test("a NEWER snapshot with NO counter (fresh session describe) drops the stamp", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 200000,
      observedAt: 5000,
    });
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: { model: "gpt-5.5", contextTokens: 272000, observedAt: 6000 },
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.activeTokens).toBeUndefined();
  });

  test("after a new-session drop, a stale in-flight stamp from the DEAD session keeps losing", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 200000,
      observedAt: 5000,
    });
    // A newer fresh-session snapshot clears the stamp…
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: { model: "gpt-5.5", contextTokens: 272000, observedAt: 6000 },
    });
    // …then a DELAYED end-of-turn POST from the dead session lands: its
    // observation predates the snapshot — it must stay rejected.
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 200000,
      observedAt: 5500,
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.activeTokens).toBeUndefined();
  });

  test("the watermark survives LATER stampless snapshots (stale POST still loses)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 200000,
      observedAt: 5000,
    });
    // A fresh-session snapshot drops the stamp (watermark parked at 6000)...
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: { model: "gpt-5.5", contextTokens: 272000, observedAt: 6000 },
    });
    // ...then ANOTHER routine stampless refresh lands (no active value)...
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: { model: "gpt-5.5", contextTokens: 272000, observedAt: 7000 },
    });
    // ...and only then the dead session's delayed POST: it must STILL lose.
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 200000,
      observedAt: 5500,
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.activeTokens).toBeUndefined();
    // A genuinely NEW turn's stamp (observed after everything) still lands.
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 12000,
      observedAt: 8000,
    });
    const sm2 = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm2?.activeTokens).toBe(12000);
  });

  test("an out-of-order stale stamp must not overwrite a newer one", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 200000,
      observedAt: 2000,
    });
    // The FIRST turn's delayed POST lands after the second's.
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 90000,
      observedAt: 1000,
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.activeTokens).toBe(200000);
  });
});
