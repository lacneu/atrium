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
import { resolveTargetForChat, resolveTargetForTurn } from "./routing";
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
      presentInLastOk: present, enabled: true,
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

describe("resolveTargetForTurn (per-turn multi-agent router)", () => {
  const resolveTurn = (
    t: ReturnType<typeof convexTest>,
    chat: Doc<"chats">,
    userId: string,
    chosen: { instanceName: string; agentId: string } | null,
  ) => t.run((ctx) => resolveTargetForTurn(ctx, chat, userId as never, chosen));

  // THE blocking regression (advisor): the per-turn entry must NOT quietly unlock a
  // revoked agent. With no turn-agent chosen it delegates to resolveTargetForChat, so a
  // single-agent chat bound to a now-revoked agent STILL reads agent_restricted.
  test("chosen=null → legacy path: a REVOKED single-agent chat STILL reads agent_restricted", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "bob", true); // only bob granted now
    await seedAgent(t, "prod", "alice", true); // alice still EXISTS, just not granted
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const r = await resolveTurn(t, chat, uid, null);
    // Delete the `chosen===null` delegation and this regresses to target=bob — proving
    // the read-only cascade survives the per-turn refactor.
    expect(r.target).toBeNull();
    expect(r.failReason).toBe("agent_restricted");
  });

  test("chosen = an entitled, present agent → routed to it, NEVER a rebind", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedUA(t, uid, "prod", "bob", false);
    await seedAgent(t, "prod", "alice", true);
    await seedAgent(t, "prod", "bob", true);
    await seedDiscovery(t, "prod", true);
    // The chat is bound to alice; the user routes THIS turn to bob (a per-turn switch).
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const r = await resolveTurn(t, chat, uid, { instanceName: "prod", agentId: "bob" });
    expect(r.target?.agentId).toBe("bob");
    expect(r.rebind).toBeNull(); // per-turn routing NEVER re-binds the chat
    expect(r.failReason).toBeNull();
  });

  test("chosen = an agent the user is NOT entitled to → agent_restricted (IDOR defense at the boundary)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "ghost", true); // exists but NOT granted to this user
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    // A modified client submits an un-granted agent — the trust boundary rejects it,
    // it is NOT merely filtered in the composer.
    const r = await resolveTurn(t, chat, uid, { instanceName: "prod", agentId: "ghost" });
    expect(r.target).toBeNull();
    expect(r.failReason).toBe("agent_restricted");
  });

  test("chosen = an entitled but DELETED agent → no_agent", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "alice", false); // granted but gone on the gateway
    await seedDiscovery(t, "prod", true);
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const r = await resolveTurn(t, chat, uid, { instanceName: "prod", agentId: "alice" });
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

  test("getChatRouting signals the re-key (routedSwitch) while a FORK's first turn is pending, then stops", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "alice", true);
    await seedDiscovery(t, "prod", true);

    // A branched chat (chatFork) with the one-shot flag armed: the gateway
    // auto-creates the fork's brand-new session row (systemSent truthy) during
    // the pre-describe sessions.patch, so WITHOUT the explicit re-key signal
    // the first turn is misread as warm and the agent starts COLD.
    const fork = await makeChat(t, uid, {
      instanceName: "prod",
      agentId: "alice",
      forkPendingRehydration: true,
    });
    const armed = await t.query(internal.bridge.getChatRouting, {
      chatId: fork._id,
      userId: uid as never,
    });
    expect(armed?.configOverrides?.routedSwitch).toBe(true);
    // The rehydration ENABLE knob is NOT forced: operator kill-switches
    // (admin rehydration:false / env off) must still win over a fork's
    // grounding — the fork only re-keys, the knob decides.
    expect(armed?.configOverrides?.rehydration).toBeUndefined();
    // …and tells the dispatch to consume at the OpenClaw ACK (no instances row
    // in this seed → the openclaw default).
    expect(armed?.forkFresh).toBe(true);

    // Flag consumed (the dispatch, at the gateway ACK) → back to the plain
    // path: no re-key signal, or a later bridge restart would re-prepend the
    // whole history onto the now-warm session (duplicate).
    await t.run(async (ctx) => {
      await ctx.db.patch(fork._id, { forkPendingRehydration: undefined });
    });
    const consumed = await t.query(internal.bridge.getChatRouting, {
      chatId: fork._id,
      userId: uid as never,
    });
    expect(consumed?.configOverrides?.rehydration).toBeUndefined();
    expect(consumed?.configOverrides?.routedSwitch).toBeUndefined();
    expect(consumed?.forkFresh).toBe(false);
  });

  test("a HERMES fork never asks the dispatch to consume (a /send 200 is not delivery there)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "herm", "hermes-agent", true);
    await seedAgent(t, "herm", "hermes-agent", true);
    await seedDiscovery(t, "herm", true);
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "herm",
        gatewayUrl: "ws://gw",
        kind: "hermes" as const,
      });
    });
    const fork = await makeChat(t, uid, {
      instanceName: "herm",
      agentId: "hermes-agent",
      forkPendingRehydration: true,
    });
    const r = await t.query(internal.bridge.getChatRouting, {
      chatId: fork._id,
      userId: uid as never,
    });
    // The knob is untouched (operator config wins; Hermes freshness is
    // bridge-side prior===null, so the fork grounds through the env default)…
    expect(r?.configOverrides?.rehydration).toBeUndefined();
    // …and the flag is NEVER consumed on Hermes: a WS submit-failure ACKs 200
    // without delivering — a lingering flag is inert there.
    expect(r?.forkFresh).toBe(false);
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

  const seedMsg = (
    t: ReturnType<typeof convexTest>,
    chatId: string,
    userId: string,
  ) =>
    t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: chatId as never,
        userId: userId as never,
        role: "user" as const,
        status: "complete" as const,
        text: "x",
        updatedAt: 1,
      }),
    );

  test("beginTurnRouting: first turn flips perTurnRouting + sets the epoch segment; a switch RE-KEYS, a same-agent turn KEEPS it (epoch-on-switch)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedUA(t, uid, "prod", "bob", false);
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });

    // First per-turn turn → route to bob (≠ primary alice) → switch → segment = turn:<m1>.
    // The mutation RETURNS the switched-from agent (codex P2: drives `routedSwitch`).
    const m1 = await seedMsg(t, chat._id, uid);
    const sw1 = await t.mutation(internal.bridge.beginTurnRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "bob" },
      turnId: m1,
    });
    // beginTurnRouting RETURNS the ephemeral segment + persists ONLY perTurnRouting —
    // the routingSegment/lastRouted* tuple advances atomically only on confirm.
    expect(sw1).toEqual({
      isSwitch: true,
      segment: `turn:${m1}`, // a NEW segment on a switch
      switchedFromInstanceName: "prod",
      switchedFromAgentId: "alice", // switched FROM the primary
    });
    let c = (await t.run((ctx) => ctx.db.get(chat._id))) as Doc<"chats">;
    expect(c.perTurnRouting).toBe(true);
    expect(c.routingSegment).toBeUndefined(); // NOT persisted before confirm
    // Confirm the dispatch SUCCEEDED → advances the WHOLE tuple {segment, lastRouted*}.
    await t.mutation(internal.bridge.confirmTurnRouting, {
      chatId: chat._id,
      routedAgent: { instanceName: "prod", agentId: "bob" },
      segment: sw1!.segment,
    });
    c = (await t.run((ctx) => ctx.db.get(chat._id))) as Doc<"chats">;
    expect(c.routingSegment).toBe(`turn:${m1}`); // confirmed
    expect(c.lastRoutedAgentId).toBe("bob"); // confirmed

    // Same agent (bob) again → NO re-key (warm run): reuses the CONFIRMED segment.
    const m2 = await seedMsg(t, chat._id, uid);
    const sw2 = await t.mutation(internal.bridge.beginTurnRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "bob" },
      turnId: m2,
    });
    expect(sw2).toEqual({
      isSwitch: false, // same-agent follow-up is NOT a switch → routedSwitch=false
      segment: `turn:${m1}`, // REUSES the confirmed segment (warm), not a new one
      switchedFromInstanceName: null,
      switchedFromAgentId: null,
    });

    // Switch back to alice → re-key (fresh segment → the bridge rehydrates alice).
    const m3 = await seedMsg(t, chat._id, uid);
    const sw3 = await t.mutation(internal.bridge.beginTurnRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "alice" },
      turnId: m3,
    });
    expect(sw3).toEqual({
      isSwitch: true,
      segment: `turn:${m3}`, // a NEW segment on the switch back
      switchedFromInstanceName: "prod",
      switchedFromAgentId: "bob", // switched FROM bob
    });
    await t.mutation(internal.bridge.confirmTurnRouting, {
      chatId: chat._id,
      routedAgent: { instanceName: "prod", agentId: "alice" },
      segment: sw3!.segment,
    });
    c = (await t.run((ctx) => ctx.db.get(chat._id))) as Doc<"chats">;
    expect(c.routingSegment).toBe(`turn:${m3}`); // RE-KEYED on the switch (confirmed)
    expect(c.lastRoutedAgentId).toBe("alice"); // confirmed
  });

  test("codex P2.B: a LEGACY/unbound chat's first per-turn selection (no chat.agentId, no predecessor) is STILL a switch — isSwitch=true with switchedFrom NULL → routedSwitch must be true so the novel segment rehydrates", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "bob", false);
    // Unbound/legacy chat: NO agentId, NO lastRoutedAgentId (schema-supported).
    const chat = await makeChat(t, uid, {});
    const m1 = await seedMsg(t, chat._id, uid);
    const sw = await t.mutation(internal.bridge.beginTurnRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "bob" },
      turnId: m1,
    });
    // It re-keyed (minted a segment) → isSwitch=true → routedSwitch=true → fresh →
    // rehydrate. switchedFrom is NULL (no known predecessor) — the decoupling (P2.B).
    expect(sw).toEqual({
      isSwitch: true,
      segment: `turn:${m1}`,
      switchedFromInstanceName: null,
      switchedFromAgentId: null,
    });
    const c = (await t.run((ctx) => ctx.db.get(chat._id))) as Doc<"chats">;
    expect(c.perTurnRouting).toBe(true);
    expect(c.routingSegment).toBeUndefined(); // segment is RETURNED, persisted on confirm
  });

  test("codex P2 (failed-first-routed): a routed switch whose dispatch FAILED (no confirmTurnRouting) does NOT 'use up' the switch — a retry to the SAME agent is STILL a switch (isSwitch=true) + re-keys, so the still-unestablished session rehydrates", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedUA(t, uid, "prod", "bob", false);
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });

    // First routed turn alice→bob: a switch. Segment minted. NO confirmTurnRouting →
    // the dispatch FAILED (e.g. oversized attachment / gateway refusal pre-ack).
    const m1 = await seedMsg(t, chat._id, uid);
    const first = await t.mutation(internal.bridge.beginTurnRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "bob" },
      turnId: m1,
    });
    expect(first?.isSwitch).toBe(true);
    expect(first?.segment).toBe(`turn:${m1}`);
    let c = (await t.run((ctx) => ctx.db.get(chat._id))) as Doc<"chats">;
    // NOTHING in the persisted tuple advanced — the dispatch was never confirmed.
    expect(c.routingSegment).toBeUndefined();
    expect(c.lastRoutedAgentId).toBeUndefined();

    // RETRY to the SAME agent (bob) — a NEW send. Because the tuple was never confirmed,
    // prevAgent is still the primary → isSwitch=TRUE again → a NEW segment → fresh
    // session → rehydrate. (The bug: optimistic advance → isSwitch=false → empty context.)
    const m2 = await seedMsg(t, chat._id, uid);
    const retry = await t.mutation(internal.bridge.beginTurnRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "bob" },
      turnId: m2,
    });
    expect(retry?.isSwitch).toBe(true); // <- the P2 fix: retry is STILL a switch
    expect(retry?.segment).toBe(`turn:${m2}`); // RE-KEYED → novel bridge session → fresh
  });

  test("codex (atomic-on-confirm): an A→B switch whose dispatch FAILS leaves the WHOLE tuple at A → a RETURN to A reuses A's CONFIRMED segment (its real warm session), not the unconfirmed B segment", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedUA(t, uid, "prod", "bob", false);
    // Chat already CONFIRMED on alice: segment turn:A0, lastRouted=alice.
    const chat = await makeChat(t, uid, {
      instanceName: "prod",
      agentId: "alice",
      perTurnRouting: true,
      routingSegment: "turn:A0",
      lastRoutedInstanceName: "prod",
      lastRoutedAgentId: "alice",
    });

    // A→B switch — its dispatch FAILS (no confirm). The segment turn:<m1> is RETURNED
    // (for the live send) but NOT persisted.
    const m1 = await seedMsg(t, chat._id, uid);
    const toB = await t.mutation(internal.bridge.beginTurnRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "bob" },
      turnId: m1,
    });
    expect(toB).toMatchObject({ isSwitch: true, segment: `turn:${m1}` });
    const cAfterFail = (await t.run((ctx) => ctx.db.get(chat._id))) as Doc<"chats">;
    expect(cAfterFail.routingSegment).toBe("turn:A0"); // UNCHANGED — failed switch persisted nothing
    expect(cAfterFail.lastRoutedAgentId).toBe("alice");

    // RETURN to A: NOT a switch (lastRouted still alice, segment still turn:A0) → it
    // reuses A's CONFIRMED segment turn:A0 (A's real warm session) — NOT the failed B
    // segment turn:<m1>. (The bug: optimistic B segment → A reuses it → empty context.)
    const m2 = await seedMsg(t, chat._id, uid);
    const backToA = await t.mutation(internal.bridge.beginTurnRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "alice" },
      turnId: m2,
    });
    expect(backToA).toMatchObject({ isSwitch: false, segment: "turn:A0" });
  });

  test("getChatRouting: a perTurnRouting chat keys on its epoch segment + forces rehydration ON", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "alice", true);
    await seedDiscovery(t, "prod", true);
    const chat = await makeChat(t, uid, {
      instanceName: "prod",
      agentId: "alice",
      perTurnRouting: true,
      routingSegment: "turn:abc",
      openclawChatId: "warm-thread", // must be IGNORED for a per-turn chat
    });
    // codex P2: routedSwitch is emitted ONLY when the caller flags an actual switch.
    const rSwitch = await t.query(internal.bridge.getChatRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "alice" },
      routedSwitch: true,
    });
    expect(rSwitch?.openclawChatId).toBe("turn:abc"); // the epoch segment, NOT the warm thread
    expect(rSwitch?.configOverrides?.rehydration).toBe(true); // enable knob always forced
    expect(rSwitch?.configOverrides?.routedSwitch).toBe(true); // actual switch → fresh
    expect(rSwitch?.target?.agentId).toBe("alice");
    expect(rSwitch?.rebind).toBeNull(); // per-turn never rebinds the chat

    // A NON-switch routed dispatch (same-agent follow-up): rehydration still ENABLED
    // (the knob), but routedSwitch ABSENT → the bridge keeps a warm gateway session
    // (no duplicate re-inject after a bridge restart). This is the codex P2 guard.
    const rSame = await t.query(internal.bridge.getChatRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "alice" },
      routedSwitch: false,
    });
    expect(rSame?.configOverrides?.rehydration).toBe(true);
    expect(rSame?.configOverrides?.routedSwitch).toBeUndefined();
  });

  // Codex P2-1: a forged / since-revoked routedAgent must NOT reconfigure the chat.
  test("beginTurnRouting: an UNAUTHORIZED routed agent leaves the chat untouched (no state corruption)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true); // only alice granted
    await seedAgent(t, "prod", "ghost", true); // exists but NOT granted to the user
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const m1 = await seedMsg(t, chat._id, uid);
    await t.mutation(internal.bridge.beginTurnRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "ghost" }, // not entitled
      turnId: m1,
    });
    const c = (await t.run((ctx) => ctx.db.get(chat._id))) as Doc<"chats">;
    // The chat must NOT have been flipped/segmented by an unauthorized agent.
    expect(c.perTurnRouting).toBeUndefined();
    expect(c.routingSegment).toBeUndefined();
    expect(c.lastRoutedAgentId).toBeUndefined();
  });

  // Codex P2-4: explicitly routing to the chat's OWN primary agent (single-agent chat)
  // must NOT flip multi-agent mode or fork the warm session.
  test("beginTurnRouting: routing to the chat's PRIMARY agent leaves it single-agent (no fork)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    const chat = await makeChat(t, uid, { instanceName: "prod", agentId: "alice" });
    const m1 = await seedMsg(t, chat._id, uid);
    await t.mutation(internal.bridge.beginTurnRouting, {
      chatId: chat._id,
      userId: uid as never,
      routedAgent: { instanceName: "prod", agentId: "alice" }, // == the primary
      turnId: m1,
    });
    const c = (await t.run((ctx) => ctx.db.get(chat._id))) as Doc<"chats">;
    expect(c.perTurnRouting).toBeUndefined(); // stays single-agent
    expect(c.routingSegment).toBeUndefined(); // no fork of the warm session
  });

  // Codex P2-2: a no-routedAgent call (session patch/reset/compact) on a per-turn chat must
  // NOT inherit the last routed turn's segment — it targets the chat's binding, legacy id.
  test("getChatRouting WITHOUT routedAgent on a per-turn chat → legacy session id, rehydration NOT forced", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    await seedUA(t, uid, "prod", "alice", true);
    await seedAgent(t, "prod", "alice", true);
    await seedDiscovery(t, "prod", true);
    const chat = await makeChat(t, uid, {
      instanceName: "prod",
      agentId: "alice",
      perTurnRouting: true,
      routingSegment: "turn:bob-segment", // a prior turn routed to bob
      openclawChatId: "alice-thread",
    });
    // No routedAgent → a management/no-agent call: resolves to the binding (alice) and must
    // use alice's real session, NOT bob's turn segment.
    const r = await t.query(internal.bridge.getChatRouting, {
      chatId: chat._id,
      userId: uid as never,
    });
    expect(r?.openclawChatId).toBe("alice-thread"); // legacy id, NOT "turn:bob-segment"
    expect(r?.configOverrides?.rehydration).toBeUndefined(); // not a routed send
    expect(r?.target?.agentId).toBe("alice");
  });
});
