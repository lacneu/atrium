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
