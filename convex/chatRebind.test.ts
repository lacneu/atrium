/// <reference types="vite/client" />
//
// Getting OUT of a conversation opened on the wrong agent (2026-07-31).
//
// PRODUCTION REPORT. A user started a chat, picked an agent from the creation dialog
// without knowing that agent's gateway was down, and landed in a conversation with a
// greyed-out composer AND a greyed-out agent selector. The only exit was to delete
// the conversation. A chat binds its agent at creation and the send-rule never routes
// turn 1, so the per-turn selector cannot help there — only replacing the binding can.
//
// What is asserted here is the mutation's TWO refusals as much as its success: it must
// reach the binding by exactly the right `requireAgentMembership` gate `createChat`
// uses (this is a second door onto the same field — an easier one would be an IDOR),
// and it must refuse the moment the thread holds anything, because message attribution
// falls back to the chat's primary agent and a rebind would re-label who spoke.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A user entitled to `agentIds` on instance "prod", plus a chat factory. */
async function seedUser(t: TestConvex<typeof schema>, agentIds: string[]) {
  const userId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: uid,
      role: "user",
      canonical: "u",
    });
    await ctx.db.insert("instances", {
      name: "prod",
      gatewayUrl: "ws://x",
      kind: "openclaw",
    });
    for (let i = 0; i < agentIds.length; i += 1) {
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: agentIds[i],
        source: "discovered",
        presentInLastOk: true,
        enabled: true,
        displayName: agentIds[i].toUpperCase(),
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      await ctx.db.insert("userAgents", {
        userId: uid,
        instanceName: "prod",
        agentId: agentIds[i],
        isDefault: i === 0,
        source: "manual",
        createdAt: i,
      });
    }
    return uid;
  });
  const as = t.withIdentity({ subject: `${userId}|session` });
  const mkChat = (agentId: string) =>
    t.run((ctx) =>
      ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId,
      }),
    );
  return { userId, as, mkChat };
}

const bindingOf = async (t: TestConvex<typeof schema>, chatId: Id<"chats">) =>
  await t.run(async (ctx) => {
    const chat = await ctx.db.get(chatId);
    return { instanceName: chat?.instanceName, agentId: chat?.agentId };
  });

describe("a chat that has said nothing can change agent", () => {
  test("the binding moves to the chosen agent", async () => {
    const t = convexTest(schema, modules);
    const { as, mkChat } = await seedUser(t, ["down", "healthy"]);
    const chatId = await mkChat("down");
    await as.mutation(api.chats.rebindChatAgent, {
      chatId,
      instanceName: "prod",
      agentId: "healthy",
    });
    expect(await bindingOf(t, chatId)).toEqual({
      instanceName: "prod",
      agentId: "healthy",
    });
  });

  test("the previous agent's provider conversation id is dropped", async () => {
    // Delegated to `bindChatTarget` rather than patched here. If this mutation ever
    // starts writing the binding itself, this is the invariant it will lose: the
    // next turn would resume the OLD agent's thread on the new agent.
    const t = convexTest(schema, modules);
    const { as, mkChat } = await seedUser(t, ["down", "healthy"]);
    const chatId = await mkChat("down");
    await t.run((ctx) => ctx.db.patch(chatId, { openclawChatId: "old-thread" }));
    await as.mutation(api.chats.rebindChatAgent, {
      chatId,
      instanceName: "prod",
      agentId: "healthy",
    });
    const stale = await t.run(async (ctx) =>
      (await ctx.db.get(chatId))?.openclawChatId,
    );
    expect(stale ?? null).toBeNull();
  });
});

describe("a rebind leaves no routing history behind", () => {
  test("an emptied multi-agent chat does not keep routing to its old agent", async () => {
    // A thread reaches "no messages" by having its first turn DELETED — the
    // truncation removes them all — while `perTurnRouting` and `lastRouted*` survive
    // on the chat. Without this clear: the composer's default falls back to the
    // persisted lastRouted, so the chip shows the OLD agent; turn 1 goes to the new
    // binding (it carries no routedAgent); and turn 2, still perTurnRouting, is
    // stamped explicitly for the old one. The user moves the conversation and their
    // messages quietly go back.
    const t = convexTest(schema, modules);
    const { as, mkChat } = await seedUser(t, ["down", "healthy"]);
    const chatId = await mkChat("down");
    await t.run((ctx) =>
      ctx.db.patch(chatId, {
        perTurnRouting: true,
        lastRoutedInstanceName: "prod",
        lastRoutedAgentId: "down",
        routingSegment: "turn:old",
      }),
    );
    await as.mutation(api.chats.rebindChatAgent, {
      chatId,
      instanceName: "prod",
      agentId: "healthy",
    });
    const after = await t.run((ctx) => ctx.db.get(chatId));
    expect(after?.agentId).toBe("healthy");
    expect(
      after?.lastRoutedAgentId ?? null,
      "the old agent must not remain the composer's default",
    ).toBeNull();
    expect(
      after?.perTurnRouting ?? null,
      "turn 2 would be stamped for the old agent",
    ).toBeNull();
    expect(after?.routingSegment ?? null).toBeNull();
  });
});

describe("what a rebind may not do", () => {
  test("a thread that already holds a message is REFUSED", async () => {
    // The guard is "no message at all", not "no user turn": a message with no
    // routing stamp is attributed to the chat's primary agent, so moving the
    // binding under it would re-label who spoke.
    const t = convexTest(schema, modules);
    const { userId, as, mkChat } = await seedUser(t, ["down", "healthy"]);
    const chatId = await mkChat("down");
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user",
        text: "bonjour",
        status: "complete",
        updatedAt: 1,
      }),
    );
    await expect(
      as.mutation(api.chats.rebindChatAgent, {
        chatId,
        instanceName: "prod",
        agentId: "healthy",
      }),
    ).rejects.toThrow(/already has messages/);
    expect((await bindingOf(t, chatId)).agentId).toBe("down");
  });

  test("an assistant-only thread (a spontaneous announce) is REFUSED too", async () => {
    const t = convexTest(schema, modules);
    const { userId, as, mkChat } = await seedUser(t, ["down", "healthy"]);
    const chatId = await mkChat("down");
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        text: "annonce",
        status: "complete",
        updatedAt: 1,
      }),
    );
    await expect(
      as.mutation(api.chats.rebindChatAgent, {
        chatId,
        instanceName: "prod",
        agentId: "healthy",
      }),
    ).rejects.toThrow(/already has messages/);
  });

  test("an agent the user is NOT entitled to is refused", async () => {
    // Same gate as createChat. This mutation reaches the field the bridge routes
    // by, so a weaker check here would be a way around the entitlement entirely.
    const t = convexTest(schema, modules);
    const { as, mkChat } = await seedUser(t, ["down"]);
    await t.run((ctx) =>
      ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "someone-elses",
        source: "discovered",
        presentInLastOk: true,
        enabled: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      }),
    );
    const chatId = await mkChat("down");
    await expect(
      as.mutation(api.chats.rebindChatAgent, {
        chatId,
        instanceName: "prod",
        agentId: "someone-elses",
      }),
    ).rejects.toThrow(/not assigned/);
  });

  test("an agent DELETED on its gateway is refused", async () => {
    // The picker disables these rows, so the UI never offers one — but entitlement
    // alone would have let a stale client or a direct call bind a chat to an agent
    // no dispatch can reach. The server refuses what the picker refuses.
    const t = convexTest(schema, modules);
    const { as, mkChat } = await seedUser(t, ["down", "healthy"]);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) =>
          q.eq("instanceName", "prod").eq("agentId", "healthy"),
        )
        .first();
      if (row !== null) await ctx.db.patch(row._id, { presentInLastOk: false });
    });
    const chatId = await mkChat("down");
    await expect(
      as.mutation(api.chats.rebindChatAgent, {
        chatId,
        instanceName: "prod",
        agentId: "healthy",
      }),
    ).rejects.toThrow(/deleted on its gateway/);
    expect((await bindingOf(t, chatId)).agentId).toBe("down");
  });

  test("another user's chat is refused", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, ["down", "healthy"]);
    const foreignChat = await t.run(async (ctx) => {
      const other = await ctx.db.insert("users", {});
      return await ctx.db.insert("chats", {
        userId: other,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "down",
      });
    });
    await expect(
      as.mutation(api.chats.rebindChatAgent, {
        chatId: foreignChat,
        instanceName: "prod",
        agentId: "healthy",
      }),
    ).rejects.toThrow();
  });
});
