/// <reference types="vite/client" />
//
// Routing v2 — the security/robustness crux of the multi-agent redesign:
//  - createChat AUTHORIZES the binding against userAgents (IDOR gate).
//  - resolveTargetForChat distinguishes STALE (failed poll → serve binding) from
//    DELETED (successful poll omits it → re-bind to default), never crashes, and
//    only ever returns a target the user is authorized for.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { resolveTargetForChat } from "./routing";
import type { Doc } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

async function seedUser(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "alice" });
    return uid;
  });
}
const seedUA = (
  t: ReturnType<typeof convexTest>,
  userId: string,
  instanceName: string,
  agentId: string,
  isDefault: boolean,
) =>
  t.run((ctx) =>
    ctx.db.insert("userAgents", {
      userId: userId as never,
      instanceName,
      agentId,
      isDefault,
      source: "manual",
      createdAt: 1,
    }),
  );
const seedAgent = (
  t: ReturnType<typeof convexTest>,
  instanceName: string,
  agentId: string,
  present: boolean,
) =>
  t.run((ctx) =>
    ctx.db.insert("agents", {
      instanceName,
      agentId,
      source: "discovered",
      presentInLastOk: present,
      firstSeenAt: 1,
      lastSeenAt: 1,
    }),
  );
const seedDiscovery = (
  t: ReturnType<typeof convexTest>,
  instanceName: string,
  ok: boolean,
) =>
  t.run((ctx) =>
    ctx.db.insert("instanceDiscovery", {
      instanceName,
      lastPollAt: 1,
      lastPollOk: ok,
      lastOkAt: ok ? 1 : undefined,
    }),
  );
async function makeChat(
  t: ReturnType<typeof convexTest>,
  userId: string,
  fields: Record<string, unknown>,
) {
  const id = await t.run((ctx) =>
    ctx.db.insert("chats", { userId: userId as never, updatedAt: 1, ...fields }),
  );
  return (await t.run((ctx) => ctx.db.get(id))) as Doc<"chats">;
}
const resolve = (
  t: ReturnType<typeof convexTest>,
  chat: Doc<"chats">,
  userId: string,
) => t.run((ctx) => resolveTargetForChat(ctx, chat, userId as never));

describe("createChat authorization (IDOR gate)", () => {
  test("rejects binding to an UNassigned agent", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    const as = t.withIdentity({ subject: `${uid}|session` });
    await expect(
      as.mutation(api.chats.createChat, {
        instanceName: "prod",
        agentId: "alice",
      }),
    ).rejects.toThrow(/not assigned/);
  });

  test("binds when the agent IS assigned", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    const as = t.withIdentity({ subject: `${uid}|session` });
    const chatId = await as.mutation(api.chats.createChat, {
      instanceName: "prod",
      agentId: "alice",
    });
    const chat = (await t.run((ctx) => ctx.db.get(chatId))) as Doc<"chats">;
    expect(chat.instanceName).toBe("prod");
    expect(chat.agentId).toBe("alice");
  });

  test("rejects a half-specified binding (both-or-neither)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    const as = t.withIdentity({ subject: `${uid}|session` });
    await expect(
      as.mutation(api.chats.createChat, { instanceName: "prod" }),
    ).rejects.toThrow(/together/);
  });
});

describe("resolveTargetForChat", () => {
  test("bound + present + successful poll → serve the binding, no rebind", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "alice", true);
    await seedDiscovery(t, "prod", true);
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const r = await resolve(t, chat, uid);
    expect(r.target?.agentId).toBe("alice");
    expect(r.target?.source).toBe("chat-binding");
    expect(r.target?.canonical).toBe("alice");
    expect(r.rebind).toBeNull();
    expect(r.failReason).toBeNull();
  });

  test("bound + DELETED (successful poll omits it) → re-bind to default", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "bob", true); // default
    await seedUA(t, uid, "prod", "alice", false); // bound, but gone
    await seedAgent(t, "prod", "alice", false); // absent in last successful poll
    await seedAgent(t, "prod", "bob", true);
    await seedDiscovery(t, "prod", true);
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const r = await resolve(t, chat, uid);
    expect(r.target?.agentId).toBe("bob");
    expect(r.target?.source).toBe("user-default");
    expect(r.rebind).toEqual({ instanceName: "prod", agentId: "bob" });
  });

  test("bound + STALE (failed poll) → serve the binding (blip must not break it)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "alice", true); // last-good present
    await seedDiscovery(t, "prod", false); // FAILED poll
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const r = await resolve(t, chat, uid);
    expect(r.target?.agentId).toBe("alice");
    expect(r.rebind).toBeNull();
  });

  test("DELETED, THEN a failed poll → still re-binds (blip must NOT resurrect — Codex P2)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "bob", true); // present default
    await seedUA(t, uid, "prod", "alice", false); // bound, deleted by a prior OK poll
    await seedAgent(t, "prod", "alice", false); // presentInLastOk=false (reliable deletion)
    await seedAgent(t, "prod", "bob", true);
    await seedDiscovery(t, "prod", false); // a LATER poll FAILED (outage)
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const r = await resolve(t, chat, uid);
    expect(r.target?.agentId).toBe("bob"); // NOT the resurrected deleted agent
    expect(r.rebind).toEqual({ instanceName: "prod", agentId: "bob" });
  });

  test("revoked binding (agent no longer in the user's set) → READ-ONLY agent_restricted, NEVER a silent re-route", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "bob", true); // only bob assigned now (no group)
    await seedAgent(t, "prod", "alice", true); // alice still EXISTS, just not granted
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const r = await resolve(t, chat, uid);
    // The user is no longer entitled to "alice" (which still exists): the chat is
    // READ-ONLY. It must NOT silently re-route to "bob" (a different agent
    // mid-conversation) — the explicit product decision. Delete the agent_restricted
    // branch and this flips back to target=bob/rebind, proving it discriminates.
    expect(r.target).toBeNull();
    expect(r.rebind).toBeNull();
    expect(r.failReason).toBe("agent_restricted");
  });

  test("unbound legacy chat → default + rebind (stable next turn)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    const chat = await makeChat(t, uid, {});
    const r = await resolve(t, chat, uid);
    expect(r.target?.agentId).toBe("alice");
    expect(r.rebind).toEqual({ instanceName: "prod", agentId: "alice" });
  });

  test("deleted DEFAULT → falls back to another PRESENT assigned agent (Codex P2)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true); // default, but deleted
    await seedUA(t, uid, "prod", "bob", false); // present alternative
    await seedAgent(t, "prod", "alice", false); // absent in last successful poll
    await seedAgent(t, "prod", "bob", true);
    await seedDiscovery(t, "prod", true);
    const chat = await makeChat(t, uid, {});
    const r = await resolve(t, chat, uid);
    expect(r.target?.agentId).toBe("bob"); // NOT the deleted default
    expect(r.rebind).toEqual({ instanceName: "prod", agentId: "bob" });
  });

  test("ALL assigned agents deleted → no_agent (never dispatch to an absent agent)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "alice", false); // deleted
    await seedDiscovery(t, "prod", true); // successful poll proves deletion
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const r = await resolve(t, chat, uid);
    expect(r.target).toBeNull();
    expect(r.failReason).toBe("no_agent");
  });

  test("RESILIENT to DUPLICATE instance names (live-caught bug): never throws", async () => {
    // Two instances/discovery rows share a name (admin error / migration drift /
    // the dev harness). `.unique()` would throw and crash the whole sidebar; the
    // resolver/cache use `.first()` so a duplicate degrades gracefully.
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "alice", true);
    await seedDiscovery(t, "prod", true);
    await seedDiscovery(t, "prod", true); // DUPLICATE discovery row for "prod"
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://b", kind: "openclaw" }),
    );
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://a", kind: "openclaw" }),
    ); // DUPLICATE instance row
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const r = await resolve(t, chat, uid); // must NOT throw
    expect(r.target?.agentId).toBe("alice");
  });

  test("no userAgents, no legacy → no_agent (clear, never silent)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    const chat = await makeChat(t, uid, {});
    const r = await resolve(t, chat, uid);
    expect(r.target).toBeNull();
    expect(r.failReason).toBe("no_agent");
  });
});

describe("getChatRouting / bindChatTarget — drop stale provider id on rebind (Codex P1)", () => {
  test("getChatRouting keeps openclawChatId when honored, NULLs it on rebind", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "alice", true);
    await seedAgent(t, "prod", "ghost", true); // exists but NOT granted -> restricted
    await seedDiscovery(t, "prod", true);

    // (1) honored binding → the provider thread id is preserved (continuity).
    const bound = await makeChat(t, uid, {
      instanceName: "prod",
      agentId: "alice",
      openclawChatId: "thread-1",
    });
    const r1 = await t.query(internal.bridge.getChatRouting, {
      chatId: bound._id,
      userId: uid as never,
    });
    expect(r1?.rebind).toBeNull();
    expect(r1?.openclawChatId).toBe("thread-1");

    // (2) revoked binding (agent ∉ the user's set) → READ-ONLY: no target, no
    // rebind, agent_restricted. The chat is NOT silently re-routed to a different
    // agent — so there is nothing to rebind and no provider-id swap.
    const revoked = await makeChat(t, uid, {
      instanceName: "prod",
      agentId: "ghost",
      openclawChatId: "old-thread",
    });
    const r2 = await t.query(internal.bridge.getChatRouting, {
      chatId: revoked._id,
      userId: uid as never,
    });
    expect(r2?.target).toBeNull();
    expect(r2?.rebind).toBeNull();
    expect(r2?.failReason).toBe("agent_restricted");
  });

  test("getChatRouting forces rehydration OFF for a documentary chat (stateless fetch), not for normal chats", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "alice", true);
    await seedDiscovery(t, "prod", true);

    const normal = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const rNormal = await t.query(internal.bridge.getChatRouting, {
      chatId: normal._id,
      userId: uid as never,
    });
    // A normal chat keeps the bridge's own rehydration behavior — no forced override.
    expect(rNormal?.configOverrides?.rehydration).toBeUndefined();

    const doc = await makeChat(t, uid, {
      instanceName: "prod",
      agentId: "alice",
      kind: "documentary",
    });
    const rDoc = await t.query(internal.bridge.getChatRouting, {
      chatId: doc._id,
      userId: uid as never,
    });
    // A documentary fetch is stateless → rehydration forced OFF, so the bridge never
    // re-prepends prior fetch turns (which would defeat the rotated fresh session).
    expect(rDoc?.configOverrides?.rehydration).toBe(false);
  });

  test("bindChatTarget clears the stale provider id when it rebinds to a new agent", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    const chat = await makeChat(t, uid, {
      instanceName: "prod",
      agentId: "alice",
      openclawChatId: "old-thread",
    });
    await t.mutation(internal.bridge.bindChatTarget, {
      chatId: chat._id,
      instanceName: "prod",
      agentId: "bob",
    });
    const after = (await t.run((ctx) => ctx.db.get(chat._id))) as Doc<"chats">;
    expect(after.agentId).toBe("bob");
    expect(after.openclawChatId).toBeUndefined(); // stale old-agent thread cleared
  });
});
