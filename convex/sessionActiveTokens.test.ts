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

  // BUDGET-ESTIMATE ordering. The pre-prompt estimate (the gauge's primary
  // source) and the post-turn usage stamp are BOTH fire-and-forget writes, so
  // either can land late. Whoever is the more recent OBSERVATION must win — a
  // stale write must neither erase a live overflow nor resurrect an old one.
  test("a post-turn stamp CLEARS the estimate it postdates (fresh measure wins)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        estimatedPromptTokens: 358960,
        promptBudgetBeforeReserve: 308000,
        observedAt: 1000,
      },
    });
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 120000,
      observedAt: 2000, // AFTER the estimate: it describes the previous turn
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.estimatedPromptTokens).toBeUndefined();
    expect(sm?.promptBudgetBeforeReserve).toBeUndefined();
    expect(sm?.activeTokens).toBe(120000);
  });

  test("a LATE post-turn stamp does NOT erase a newer estimate (would hide an overflow)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    // Turn N+1's describe already landed with a live over-budget estimate…
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        estimatedPromptTokens: 400000,
        promptBudgetBeforeReserve: 308000,
        observedAt: 5000,
      },
    });
    // The describe ALSO advanced the usage watermark (a snapshot with no counter
    // drops the stamp and records its own observation time) — pinned here because
    // that is WHY the late stamp below is rejected, and the reason must not be
    // rediscovered by argument later.
    const mid = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(mid?.activeTokensAt).toBe(5000);
    // …and turn N's stamp arrives late.
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 90000,
      observedAt: 3000,
    });
    // It never lands: neither as a stamp, nor as an estimate-clearing write.
    const after = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(after?.activeTokens).toBeUndefined();
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.estimatedPromptTokens).toBe(400000);
  });

  test("an OUT-OF-ORDER describe does not resurrect an older estimate", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        estimatedPromptTokens: 300000,
        observedAt: 9000,
      },
    });
    // A stale snapshot (older observation) carrying a different estimate.
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        estimatedPromptTokens: 100000,
        observedAt: 4000,
      },
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.estimatedPromptTokens).toBe(300000);
  });

  test("a recent describe WITHOUT an estimate wins over an older one that had it", async () => {
    // After a compaction or a model change the gateway clears its budget
    // assessment, so a current describe legitimately carries NO estimate. That
    // absence must win the ordering: otherwise an older POST still in flight
    // resurrects the stale figure (codex P2) — sessionMeta is replaced wholesale,
    // so the watermark has to survive the absence.
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        estimatedPromptTokens: 350000,
        observedAt: 1000,
      },
    });
    // Current describe: compaction cleared the assessment.
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: { contextTokens: 372000, observedAt: 2000 },
    });
    let sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.estimatedPromptTokens).toBeUndefined();
    // An OLDER snapshot still in flight must not bring the old figure back.
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        estimatedPromptTokens: 350000,
        observedAt: 1500,
      },
    });
    sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.estimatedPromptTokens).toBeUndefined();
  });

  test("clearing an estimate ADVANCES the watermark: a delayed describe cannot resurrect it", async () => {
    // The post-turn stamp supersedes the estimate; if the clear dropped the
    // watermark, a describe delayed past it would look current and bring the
    // stale figure back (codex P1).
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        estimatedPromptTokens: 350000,
        observedAt: 1000,
      },
    });
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 120000,
      observedAt: 2000,
    });
    // Delayed describe from BEFORE the clear.
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        estimatedPromptTokens: 350000,
        observedAt: 1500,
      },
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.estimatedPromptTokens).toBeUndefined();
  });

  test("an older snapshot cannot flip the freshness flag back to fresh", async () => {
    // The flag is describe-sourced, so it obeys the same ordering: a stale
    // "fresh:true" must not overwrite a newer "fresh:false", or the gauge shows a
    // number the gateway had just disowned (codex P2).
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        totalTokens: 200000,
        totalTokensFresh: false,
        observedAt: 5000,
      },
    });
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        totalTokens: 200000,
        totalTokensFresh: true,
        observedAt: 3000,
      },
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.totalTokensFresh).toBe(false);
  });

  test("a stale describe updates NO describe-sourced field (flag and counter stay paired)", async () => {
    // A recent "the counter is stale" must not end up qualifying an OLD counter
    // written by the same stale snapshot (codex P2): the block moves as one unit.
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        totalTokens: 250000,
        totalTokensFresh: false,
        observedAt: 5000,
      },
    });
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 272000,
        totalTokens: 90000,
        totalTokensFresh: true,
        observedAt: 3000,
      },
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.totalTokensFresh).toBe(false);
    expect(sm?.totalTokens).toBe(250000);
    expect(sm?.contextTokens).toBe(372000);
  });

  test("a late post-turn stamp does NOT erase a NEWER describe's estimate (2nd turn on)", async () => {
    // The usage watermark alone does not order this: a describe whose counter did
    // not fall carries the PREVIOUS stamp forward instead of advancing it, so from
    // the second turn on a delayed post-turn POST passes the ordering check. The
    // estimate must then be defended by its OWN clock (codex P1).
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    // Turn 1 measured its window fill.
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 50000,
      observedAt: 1000,
    });
    // Turn 2's pre-prompt describe: counter RISES (no drop → the old stamp and its
    // watermark are carried forward) and it brings a fresh over-budget estimate.
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: {
        contextTokens: 372000,
        totalTokens: 60000,
        estimatedPromptTokens: 358960,
        promptBudgetBeforeReserve: 308000,
        observedAt: 2000,
      },
    });
    const mid = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(mid?.activeTokensAt).toBe(1000); // the watermark did NOT advance
    // Turn 1's stamp finally lands — newer than the watermark, older than the estimate.
    await t.mutation(internal.stream.setSessionActiveTokens, {
      chatId,
      activeTokens: 55000,
      observedAt: 1500,
    });
    const sm = await t.run(async (ctx) => (await ctx.db.get(chatId))!.sessionMeta);
    expect(sm?.estimatedPromptTokens).toBe(358960);
    expect(sm?.promptBudgetBeforeReserve).toBe(308000);
    expect(sm?.activeTokens).toBe(55000); // the measure itself still lands
  });
});
