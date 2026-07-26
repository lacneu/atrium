/// <reference types="vite/client" />
//
// UI-3 write-back: unit tests for `chats.setSessionKnob` (the Convex half).
//
// Pins the two properties the live browser run does NOT prove deterministically:
// (1) MERGE — changing one knob must never drop the other; (2) OWNERSHIP — a user
// cannot patch another user's chat. The scheduled `dispatchPatch` (which POSTs to
// the bridge) is NOT flushed here: convex-test does not auto-run scheduled
// functions, so these assert the mutation's DB effect + access gate in isolation.

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/** Seed an ACTIVE (role "user") account and return an identity-bound client. */
async function seedUser(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" });
    return userId;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

async function readSettings(
  t: ReturnType<typeof convexTest>,
  chatId: Id<"chats">,
) {
  return await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionSettings ?? null);
}

describe("chats.setSessionKnob", () => {
  test("changing one knob never drops the other (merge)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "low" });
    expect(await readSettings(t, chatId)).toEqual({ thinkingLevel: "low" });

    // Patching ONLY the model must preserve the previously-set reasoning level.
    await as.mutation(api.chats.setSessionKnob, { chatId, model: "gpt-5.5" });
    expect(await readSettings(t, chatId)).toEqual({
      thinkingLevel: "low",
      model: "gpt-5.5",
    });

    // Re-patching reasoning keeps the model.
    await as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "high" });
    expect(await readSettings(t, chatId)).toEqual({
      thinkingLevel: "high",
      model: "gpt-5.5",
    });
  });

  test("a user cannot patch another user's chat (ownership)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t);
    const intruder = await seedUser(t);
    const chatId = (await owner.as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await expect(
      intruder.as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "low" }),
    ).rejects.toThrow();

    // The owner's chat is untouched.
    expect(await readSettings(t, chatId)).toBeNull();
  });

  test("rejects an over-long knob value (defensive bound)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await expect(
      as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "x".repeat(65) }),
    ).rejects.toThrow(/invalid/i);
  });

  test("fastMode merges like the other knobs", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "low" });
    await as.mutation(api.chats.setSessionKnob, { chatId, fastMode: true });
    expect(await readSettings(t, chatId)).toEqual({
      thinkingLevel: "low",
      fastMode: true,
    });
  });

  test("null UNSETS a knob: key removed, others kept, clear PERSISTED in the intent", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await as.mutation(api.chats.setSessionKnob, {
      chatId,
      thinkingLevel: "low",
      model: "gpt-5.5",
      fastMode: true,
    });

    // Unset reasoning + speed in one call; the model override must survive AND
    // the cleared field names are persisted IN the intent (P2-4: unsets must
    // survive a bridge outage exactly like sets — re-applied per turn).
    await as.mutation(api.chats.setSessionKnob, {
      chatId,
      thinkingLevel: null,
      fastMode: null,
    });
    expect(await readSettings(t, chatId)).toEqual({
      model: "gpt-5.5",
      clears: ["thinkingLevel", "fastMode"],
    });

    // The scheduled dispatchPatch carries NO transient clears arg anymore —
    // it reads the persisted intent (one source of truth).
    const jobs = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const patches = jobs.filter((j) => j.name.includes("dispatchPatch"));
    expect(patches.length).toBeGreaterThan(0);
    const last = patches[patches.length - 1]!;
    expect(last.args[0]).toMatchObject({ chatId });
    expect(
      (last.args[0] as { clears?: unknown }).clears,
    ).toBeUndefined();
  });

  test("re-setting a cleared knob removes it from clears (set wins)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "low" });
    await as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: null });
    expect(await readSettings(t, chatId)).toEqual({ clears: ["thinkingLevel"] });

    await as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "high" });
    // The pending unset is cancelled by the new set — no clears key left.
    expect(await readSettings(t, chatId)).toEqual({ thinkingLevel: "high" });
  });
});

// CONF-4b "Réinitialiser la session": the public, owner-scoped entry point that
// schedules the SAME internal.bridge.dispatchReset used by message deletion.
describe("chats.resetSession", () => {
  test("a reset CLEARS the session-overfull verdict (a fresh session is not overfull)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
        observedAt: 1_000,
      });
    });

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
        chatId,
        resetStartedAt: 2_000,
      });
    });

    // No turn event fires for a reset, so nothing else can clear it — and every
    // later meta refresh copies the verdict forward (codex P2).
    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull).toBeUndefined();
  });

  test("codex P2: a verdict OBSERVED BEFORE the reset cannot warn the new session", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    const before = Date.now();
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
        chatId,
        resetStartedAt: Date.now(),
      });
    });
    // A compaction event of the OLD session was already in flight.
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
        observedAt: before - 1,
      });
    });

    // Nothing would ever clear it: every later meta refresh preserves it.
    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull).toBeUndefined();
  });

  test("a verdict observed AFTER the reset still applies (the fence is not a mute)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
        chatId,
        resetStartedAt: Date.now(),
      });
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
        observedAt: Date.now() + 1_000,
      });
    });

    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull).toBe(true);
  });

  test("codex P2: a stale `false` cannot erase a NEWER real warning", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
        observedAt: 2_000,
      });
      // An OLDER "all clear" lands afterwards: independent POSTs reorder.
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: false,
        observedAt: 1_000,
      });
    });

    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull).toBe(true);
  });

  test("codex P2: a reset also purges the session's context ESTIMATES", async () => {
    const t = convexTest(schema, modules);
    const { as, userId } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    void userId;
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, {
        sessionMeta: {
          model: "gpt-5",
          contextTokens: 272_000,
          // The warning ALSO fires on this pair, with no verdict involved.
          estimatedPromptTokens: 358_960,
          promptBudgetBeforeReserve: 308_000,
        },
      });
    });

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
        chatId,
        resetStartedAt: Date.now(),
      });
    });

    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    // A brand-new session must not keep saying the conversation no longer fits.
    expect(meta?.estimatedPromptTokens).toBeUndefined();
    expect(meta?.promptBudgetBeforeReserve).toBeUndefined();
    // …while the static budget the rehydration needs survives.
    expect(meta?.contextTokens).toBe(272_000);
  });

  test("codex P2: an all-clear ADVANCES the watermark, so an older failure cannot re-raise it", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await t.run(async (ctx) => {
      // The FIRST verdict is an all-clear: implicitly the current value, so the
      // no-churn path used to return without stamping anything.
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: false,
        observedAt: 2_000,
      });
      // …and an OLDER failure lands afterwards.
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
        observedAt: 1_000,
      });
    });

    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull ?? false).toBe(false);
  });

  test("codex P2: a describe snapshot OBSERVED BEFORE the reset cannot restore the old estimate", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    const before = Date.now() - 1;
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
        chatId,
        resetStartedAt: Date.now(),
      });
    });
    // The pre-reset describe was already in flight.
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: {
          estimatedPromptTokens: 358_960,
          promptBudgetBeforeReserve: 308_000,
          observedAt: before,
        },
      });
    });

    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    // Restored, it would immediately re-raise "no longer fits" on an empty session.
    expect(meta?.estimatedPromptTokens).toBeUndefined();
  });

  test("codex P2: the reset fence DISARMS, so a lagging bridge clock cannot starve a session", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    // A reset that happened long ago (the fence covers in-flight writes only).
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, {
        sessionMeta: { sessionResetAt: Date.now() - 10 * 60 * 1000 },
      });
    });

    // A bridge whose clock runs behind stamps an "old" time for a CURRENT write.
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "gpt-5", contextTokens: 272_000, observedAt: 1_000 },
      });
    });

    // Armed forever, the fresh session would sit with no meta and no gauge until
    // the drift caught up.
    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.model).toBe("gpt-5");
  });

  test("codex P1: scheduling a reset does NOT clear the session state (the gateway may refuse it)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
      });
    });

    await as.mutation(api.chats.resetSession, { chatId });

    // The bridge REFUSES a reset when a turn goes live in the schedule→execute
    // window. Clearing eagerly would show a fresh, un-warned session while the
    // gateway still held the old, overfull one.
    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull).toBe(true);
  });

  test("codex P2: the all-clear WATERMARK survives a meta refresh (an older failure cannot return)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await t.run(async (ctx) => {
      // First verdict: an all-clear. It stamps a watermark while leaving
      // `sessionOverfull` absent.
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: false,
        observedAt: 2_000,
      });
      // An ordinary describe refresh runs in between.
      await ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "gpt-5" },
      });
      // …and the OLDER failure POST finally lands.
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
        observedAt: 1_000,
      });
    });

    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull ?? false).toBe(false);
  });

  test("codex P2: the post-reset clear KEEPS meta a newer session already wrote", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    // The panel does not reserve the chat: the user can send while the reset is
    // in flight, and that turn's describe lands FIRST.
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: {
          estimatedPromptTokens: 12_000,
          promptBudgetBeforeReserve: 308_000,
          totalTokens: 11_500,
          estimatedCostUsd: 0.02,
          observedAt: 5_000,
        },
      });
      await ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
        chatId,
        resetStartedAt: 4_000,
      });
    });

    // Wiping it would leave the NEW session with no gauge until another send.
    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.estimatedPromptTokens).toBe(12_000);
    // The counters ride the SAME describe: dropping them would leave the new
    // session with an estimate but no gauge and no cost (codex P2).
    expect(meta?.totalTokens).toBe(11_500);
    expect(meta?.estimatedCostUsd).toBe(0.02);
  });

  test("codex P2: an OLDER reset settling last cannot weaken the fence", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    // Inside the fence's live window (it disarms after two minutes).
    const t0 = Date.now();
    await t.run(async (ctx) => {
      // Two resets are scheduled; the NEWER one settles first.
      await ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
        chatId,
        resetStartedAt: t0,
      });
      await ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
        chatId,
        resetStartedAt: t0 - 3_000,
      });
      // A verdict of the OLD session, observed between the two.
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
        observedAt: t0 - 1_500,
      });
    });

    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull ?? false).toBe(false);
  });

  test("codex P2: a straggler of the OLD session received DURING the reset is still fenced", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    const t0 = Date.now();

    await t.run(async (ctx) => {
      // The reset was dispatched at t0-4s and CONFIRMED at t0: the background
      // compaction of the old session was received in between.
      await ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
        chatId,
        resetStartedAt: t0 - 4_000,
        resetCompletedAt: t0,
      });
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
        observedAt: t0 - 2_000,
      });
    });

    // With the dispatch stamp alone it read as "after the reset" and warned a
    // session that no longer exists.
    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull ?? false).toBe(false);
  });

  test("codex P2: a verdict that landed DURING the reset is dropped, while the gauge is kept", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    const t0 = Date.now();

    await t.run(async (ctx) => {
      // Both landed between the dispatch and the confirmation.
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
        observedAt: t0 - 2_000,
      });
      await ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: {
          estimatedPromptTokens: 9_000,
          promptBudgetBeforeReserve: 308_000,
          observedAt: t0 - 2_000,
        },
      });
      await ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
        chatId,
        resetStartedAt: t0 - 4_000,
        resetCompletedAt: t0,
      });
    });

    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    // A false "no longer fits" is worse than a missing one: the next compaction
    // re-raises it.
    expect(meta?.sessionOverfull ?? false).toBe(false);
    // A missing GAUGE is worse than a briefly stale one, and it self-heals.
    expect(meta?.estimatedPromptTokens).toBe(9_000);
  });

  test("the owner schedules a bridge reset (dispatchReset, no regenerate)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await as.mutation(api.chats.resetSession, { chatId });

    const jobs = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const resets = jobs.filter((j) => j.name.includes("dispatchReset"));
    expect(resets.length).toBe(1);
    expect(resets[0]!.args[0]).toMatchObject({ chatId });
    // No regenerate outbox: a panel-initiated reset only realigns the session.
    expect(
      (resets[0]!.args[0] as { regenerateOutboxId?: unknown }).regenerateOutboxId,
    ).toBeUndefined();
  });

  test("a BUSY chat (streaming turn) refuses the reset — no dispatchReset scheduled", async () => {
    // A reset during an active turn resets the very session the run writes
    // (session-lock conflict family, prod report ms746b01…): the server must
    // refuse rather than rely on the user knowing not to.
    const t = convexTest(schema, modules);
    const { userId, as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      });
    });

    const res = await as.mutation(api.chats.resetSession, { chatId });
    expect(res).toEqual({ ok: false, reason: "busy" });

    const jobs = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs.filter((j) => j.name.includes("dispatchReset")).length).toBe(0);
  });

  test("a chat that becomes busy AFTER scheduling abandons the reset at execution (codex P1)", async () => {
    // The resetSession busy check runs at SCHEDULE time; a send landing before
    // the scheduled dispatchReset executes would have its fresh turn killed by
    // the /reset — the action must re-validate and abandon (traced).
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { userId, as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    const res = await as.mutation(api.chats.resetSession, { chatId });
    expect(res).toEqual({ ok: true });
    // A turn starts inside the schedule→execution window.
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const traces = await t.run(async (ctx) =>
      ctx.db
        .query("traceEvents")
        .filter((q) => q.eq(q.field("kind"), "openclaw.reset"))
        .collect(),
    );
    expect(traces).toHaveLength(1);
    expect(JSON.parse(traces[0]!.meta ?? "{}").resetStatus).toBe(
      "abandoned_busy",
    );
    vi.useRealTimers();
  });

  test("a non-owner cannot reset another user's session", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t);
    const intruder = await seedUser(t);
    const chatId = (await owner.as.mutation(api.chats.createChat, {})) as Id<"chats">;

    await expect(
      intruder.as.mutation(api.chats.resetSession, { chatId }),
    ).rejects.toThrow();

    const jobs = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs.filter((j) => j.name.includes("dispatchReset")).length).toBe(0);
  });
});

// The internalAction half: dispatchPatch reads the PERSISTED intent (sets +
// clears, P2-4 single source of truth) and forwards it COMPLETE as the nested
// `sessionSettings` of the bridge POST /patch body — and must still POST when
// the intent holds only clears (the old "nothing to apply" guard would skip it).
describe("bridge.dispatchPatch — persisted-intent forwarding", () => {
  /** Stub BRIDGE_* env + global fetch, capturing each POSTed JSON body. */
  function stubBridge() {
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : {},
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    return {
      calls,
      restore: () => {
        vi.unstubAllGlobals();
        if (prevUrl === undefined) delete process.env.BRIDGE_URL;
        else process.env.BRIDGE_URL = prevUrl;
        if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
        else process.env.BRIDGE_SHARED_SECRET = prevSecret;
      },
    };
  }

  /** Seed a routed user (profile + default userAgents row) and a chat. */
  async function seedRouted(
    t: ReturnType<typeof convexTest>,
    sessionSettings?: {
      thinkingLevel?: string;
      model?: string;
      fastMode?: boolean;
      clears?: string[];
    },
  ) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user", canonical: "alice" });
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "main",
        agentId: "alice",
        isDefault: true,
        source: "manual",
        createdAt: Date.now(),
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        instanceName: "main",
        agentId: "alice",
        archived: false,
        updatedAt: Date.now(),
        ...(sessionSettings ? { sessionSettings } : {}),
      });
      return { userId, chatId };
    });
  }

  test("forwards the persisted intent COMPLETE (sets + clears, nested)", async () => {
    const t = convexTest(schema, modules);
    const bridge = stubBridge();
    try {
      const { userId, chatId } = await seedRouted(t, {
        model: "gpt-5.5",
        fastMode: true,
        clears: ["thinkingLevel"],
      });
      await t.action(internal.bridge.dispatchPatch, { chatId, userId });
      const patch = bridge.calls.find((c) => c.url.endsWith("/patch"));
      expect(patch).toBeTruthy();
      expect(patch!.body).toMatchObject({
        sessionSettings: {
          model: "gpt-5.5",
          fastMode: true,
          clears: ["thinkingLevel"],
        },
      });
    } finally {
      bridge.restore();
    }
  });

  test("still POSTs when the intent holds ONLY clears", async () => {
    const t = convexTest(schema, modules);
    const bridge = stubBridge();
    try {
      const { userId, chatId } = await seedRouted(t, { clears: ["model"] });
      await t.action(internal.bridge.dispatchPatch, { chatId, userId });
      const patch = bridge.calls.find((c) => c.url.endsWith("/patch"));
      expect(patch).toBeTruthy();
      expect(patch!.body).toMatchObject({
        sessionSettings: { clears: ["model"] },
      });
    } finally {
      bridge.restore();
    }
  });

  test("no intent at all -> no bridge call (unchanged guard)", async () => {
    const t = convexTest(schema, modules);
    const bridge = stubBridge();
    try {
      const { userId, chatId } = await seedRouted(t);
      await t.action(internal.bridge.dispatchPatch, { chatId, userId });
      expect(bridge.calls.length).toBe(0);
    } finally {
      bridge.restore();
    }
  });

  // P2-4 end-to-end (Convex half): a ↺ unset PERSISTS in the intent — it is
  // re-POSTed by a LATER dispatchPatch with no transient arg, and rides the
  // routing every /send consumes (getChatRouting.sessionSettings), so a clear
  // lost to a bridge outage is repaired on the next turn like a set.
  test("a clear persists in the intent and re-travels on the next dispatch", async () => {
    const t = convexTest(schema, modules);
    const bridge = stubBridge();
    try {
      const { userId, chatId } = await seedRouted(t);
      const as = t.withIdentity({ subject: `${userId}|session` });
      await as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: "low" });
      await as.mutation(api.chats.setSessionKnob, { chatId, thinkingLevel: null });

      // The clear is in the durable intent — the SAME object /send dispatch
      // forwards for the per-turn re-apply.
      const routing = await t.query(internal.bridge.getChatRouting, {
        chatId,
        userId,
      });
      expect(routing?.sessionSettings).toEqual({ clears: ["thinkingLevel"] });

      // A later dispatch (no clears arg exists anymore) still carries it.
      bridge.calls.length = 0;
      await t.action(internal.bridge.dispatchPatch, { chatId, userId });
      const patch = bridge.calls.find((c) => c.url.endsWith("/patch"));
      expect(patch!.body).toMatchObject({
        sessionSettings: { clears: ["thinkingLevel"] },
      });
    } finally {
      bridge.restore();
    }
  });
});
