/// <reference types="vite/client" />
//
// THE PRIMARY AGENT, chosen in the conversation panel — and the session every
// operation on the conversation reaches.
//
// Pinned here:
//   - `chatAgents.setPrimaryAgent` makes a ROOM agent the primary at any point: the
//     former primary joins the room, the history keeps its authors, the chat routes
//     per turn from then on, and the summaries follow the new primary;
//   - only the owner, only a room agent, never mid-turn nor during another agent's
//     call;
//   - on a per-turn routed chat, a reset, a knob patch and a compaction reach the
//     CURRENT routed session, not the primary's legacy one;
//   - the routed-switch signal is sent for a Hermes target like any other.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { PRIMARY_PIN_BATCH, pinUnroutedBatch } from "./chatAgents";
import type { MutationCtx } from "./_generated/server";
import { attributeHistoryAgents } from "./lib/rehydration";

const modules = import.meta.glob("./**/*.ts");
// Typed WITH the schema: `convex deploy` typechecks test files too.
type T = TestConvex<typeof schema>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function seedUser(t: T, canonical: string): Promise<Id<"users">> {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user",
      canonical,
      name: canonical,
      email: `${canonical}@example.com`,
    });
    return userId;
  });
}

async function seedAgent(
  t: T,
  instanceName: string,
  agentId: string,
  opts: { kind?: "openclaw" | "hermes"; present?: boolean } = {},
) {
  await t.run(async (ctx) => {
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    if (instance === null) {
      await ctx.db.insert("instances", {
        name: instanceName,
        gatewayUrl: "ws://gw",
        ...(opts.kind ? { kind: opts.kind } : {}),
      });
    }
    await ctx.db.insert("agents", {
      instanceName,
      agentId,
      displayName: agentId,
      enabled: true,
      source: "discovered" as const,
      presentInLastOk: opts.present ?? true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
  });
}

const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: userId });

/** An owner's chat bound to alpha/alice, with bob (and carol, not in the room). */
async function room(t: T, fields: Partial<Doc<"chats">> = {}) {
  const owner = await seedUser(t, "owner");
  await seedAgent(t, "alpha", "alice");
  await seedAgent(t, "alpha", "bob");
  await seedAgent(t, "alpha", "carol");
  const chatId = await t.run(async (ctx) =>
    ctx.db.insert("chats", {
      userId: owner,
      updatedAt: 1,
      instanceName: "alpha",
      agentId: "alice",
      ...fields,
    }),
  );
  await as(t, owner).mutation(api.chatAgents.addChatAgent, {
    chatId,
    instanceName: "alpha",
    agentId: "bob",
  });
  return { owner, chatId };
}

type Seed = {
  role: "user" | "assistant";
  text: string;
  routed?: { instanceName: string; agentId: string };
  status?: "complete" | "streaming";
};

async function seedMessages(t: T, chatId: Id<"chats">, owner: Id<"users">, rows: Seed[]) {
  return t.run(async (ctx) => {
    const ids: Id<"messages">[] = [];
    for (const r of rows) {
      ids.push(
        await ctx.db.insert("messages", {
          chatId,
          userId: owner,
          role: r.role,
          status: r.status ?? "complete",
          text: r.text,
          updatedAt: 1,
          ...(r.routed
            ? { routedInstanceName: r.routed.instanceName, routedAgentId: r.routed.agentId }
            : {}),
        }),
      );
    }
    return ids;
  });
}

const bob = { instanceName: "alpha", agentId: "bob" };
const alice = { instanceName: "alpha", agentId: "alice" };

describe("setPrimaryAgent — a room agent becomes the primary at any point", () => {
  test("the binding moves, the former primary joins the room, the chat routes per turn", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t, {
      openclawChatId: "legacy-alice-session",
      // The session actually in use — alice's, confirmed. It survives the change.
      perTurnRouting: true,
      lastRoutedInstanceName: "alpha",
      lastRoutedAgentId: "alice",
      routingSegment: "turn:seg-alice",
    });
    await seedMessages(t, chatId, owner, [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
    ]);
    await expect(
      as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob }),
    ).resolves.toEqual({ changed: true });

    const chat = (await t.run((ctx) => ctx.db.get(chatId)))!;
    expect({ instanceName: chat.instanceName, agentId: chat.agentId }).toEqual(bob);
    expect(chat.perTurnRouting).toBe(true);
    // The non-routed session id was alice's: dropped.
    expect(chat.openclawChatId).toBeUndefined();
    // The confirmed routing tuple names the session in use, whoever is primary.
    expect(chat.lastRoutedAgentId).toBe("alice");
    expect(chat.routingSegment).toBe("turn:seg-alice");
    const roster = await t.run((ctx) =>
      ctx.db
        .query("chatAgents")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect(),
    );
    expect(roster.map((r) => r.agentId)).toEqual(["alice"]);
    expect(roster[0]!.addedBy).toBe(owner);
    const listed = await as(t, owner).query(api.chatAgents.listChatAgents, {
      chatId: chatId as string,
    });
    expect(listed?.primary?.agentId).toBe("bob");
    expect(listed?.agents.map((a) => a.agentId)).toEqual(["alice"]);
  });

  test("a single-agent chat switches to per-turn routing", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t, { openclawChatId: "legacy-alice-session" });
    await seedMessages(t, chatId, owner, [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
    ]);
    await as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob });
    const chat = (await t.run((ctx) => ctx.db.get(chatId)))!;
    expect(chat.perTurnRouting).toBe(true);
    // The first turn to the new primary is a SWITCH: a fresh segment, re-hydrated —
    // never alice's legacy session.
    const [turn] = await seedMessages(t, chatId, owner, [
      { role: "user", text: "q2", routed: bob },
    ]);
    const began = await t.mutation(internal.bridge.beginTurnRouting, {
      chatId,
      userId: owner,
      routedAgent: bob,
      turnId: turn!,
    });
    expect(began).toMatchObject({ isSwitch: true, segment: `turn:${turn}` });
    const routing = await t.query(internal.bridge.getChatRouting, {
      chatId,
      userId: owner,
      routedAgent: bob,
      routedSwitch: true,
      routingSegment: `turn:${turn}`,
    });
    expect(routing?.openclawChatId).toBe(`turn:${turn}`);
    expect(routing?.target?.agentId).toBe("bob");
    expect(routing?.configOverrides).toMatchObject({ rehydration: true, routedSwitch: true });
  });

  test("the history keeps its authors: unstamped turns are pinned to the former primary", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const [announce, q1, a1, q2, a2] = await seedMessages(t, chatId, owner, [
      // A spontaneous announce before any user turn: nothing to inherit from.
      { role: "assistant", text: "hello" },
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      // A turn explicitly routed to bob, and its reply (inherits bob).
      { role: "user", text: "q2", routed: bob },
      { role: "assistant", text: "a2" },
    ]);
    await as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob });
    const rows = await t.run(async (ctx) => {
      const out: Doc<"messages">[] = [];
      for (const id of [announce, q1, a1, q2, a2]) out.push((await ctx.db.get(id!))!);
      return out;
    });
    // Attribution as every reader computes it — the primary is now bob.
    const agents = attributeHistoryAgents(
      rows.map((m) => ({ ...m, _id: m._id as string })),
      bob,
    );
    expect(agents.get(announce!)).toEqual(alice);
    expect(agents.get(q1!)).toEqual(alice);
    expect(agents.get(a1!)).toEqual(alice);
    expect(agents.get(q2!)).toEqual(bob);
    expect(agents.get(a2!)).toEqual(bob);
    // The replies to pinned turns keep INHERITING — only turns and a leading
    // announce carry the stamp.
    expect(rows[2]!.routedAgentId).toBeUndefined();
    expect(rows[4]!.routedAgentId).toBeUndefined();
  });

  test("a long thread is pinned whole, across scheduled batches", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const n = PRIMARY_PIN_BATCH + 40;
    await seedMessages(
      t,
      chatId,
      owner,
      Array.from({ length: n }, (_, i) => ({ role: "user" as const, text: `q${i}` })),
    );
    await as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const unpinned = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("messages")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect()
      ).filter((m) => m.routedAgentId !== "alice"),
    );
    expect(unpinned).toHaveLength(0);
  });

  test("an empty thread just moves the binding — nothing to carry, no per-turn routing", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    await as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob });
    const chat = (await t.run((ctx) => ctx.db.get(chatId)))!;
    expect(chat.agentId).toBe("bob");
    expect(chat.perTurnRouting).toBeUndefined();
  });

  test("the summaries follow the new primary", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("bridgeCompat", {
        key: "singleton",
        reachable: true,
        bridgeVersion: "0.20.0",
        turnSessionEcho: true,
        protocolVersion: 2,
        compat: null,
        targets: [],
        fetchedAt: 1,
      });
    });
    await seedMessages(
      t,
      chatId,
      owner,
      Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        text: `${"x".repeat(6000)} ${i}`,
      })),
    );
    await as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob });
    const { outcome } = await as(t, owner).mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(outcome).toBe("dispatched");
    const hidden = await t.run(async (ctx) =>
      ctx.db
        .query("chats")
        .withIndex("by_user_kind", (q) => q.eq("userId", owner).eq("kind", "summarizer"))
        .first(),
    );
    expect(hidden?.agentId).toBe("bob");
  });
});

describe("setPrimaryAgent — who, which agent, and when", () => {
  test("only the owner — a manager is refused", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const manager = await seedUser(t, "manager");
    await as(t, owner).mutation(api.chatParticipants.addMember, {
      chatId,
      memberId: manager,
      role: "manager",
    });
    await expect(
      as(t, manager).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob }),
    ).rejects.toThrow(/not owned/);
  });

  test("only an agent already in the room", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    await expect(
      as(t, owner).mutation(api.chatAgents.setPrimaryAgent, {
        chatId,
        instanceName: "alpha",
        agentId: "carol",
      }),
    ).rejects.toThrow(/not part of this conversation/);
  });

  test("not an agent deleted on its gateway", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    await t.run(async (ctx) => {
      // A direct grant outlives the agent on its gateway — the case the state check
      // exists for (the pooled grant would simply drop it).
      await ctx.db.insert("userAgents", {
        userId: owner,
        ...bob,
        isDefault: false,
        source: "manual",
        createdAt: 1,
      });
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) => q.eq("instanceName", "alpha").eq("agentId", "bob"))
        .first();
      await ctx.db.patch(row!._id, { presentInLastOk: false });
    });
    await expect(
      as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob }),
    ).rejects.toThrow(/deleted/);
  });

  test("not while a turn runs — nothing moves", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    await seedMessages(t, chatId, owner, [
      { role: "user", text: "q1" },
      { role: "assistant", text: "", status: "streaming" },
    ]);
    await expect(
      as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob }),
    ).resolves.toEqual({ changed: false, reason: "busy" });
    const chat = (await t.run((ctx) => ctx.db.get(chatId)))!;
    expect(chat.agentId).toBe("alice");
    expect(chat.perTurnRouting).toBeUndefined();
  });

  test("not during a call on another agent", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("talkSessions", {
        userId: owner,
        chatId,
        instanceName: "alpha",
        agentId: "alice",
        canonical: "owner",
        conversation: "c",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
    });
    await expect(
      as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob }),
    ).rejects.toThrow(/TALK_CALL_ACTIVE/);
  });

  test("the current primary is reported as such", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    await expect(
      as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...alice }),
    ).resolves.toEqual({ changed: false, reason: "already-primary" });
  });
});

// ── The session an operation on the conversation reaches ──────────────────

/** A per-turn routed chat whose CURRENT session is bob's confirmed segment, while the
 *  primary alice still carries her legacy session id. */
async function routedRoom(t: T) {
  return room(t, {
    openclawChatId: "legacy-alice-session",
    perTurnRouting: true,
    lastRoutedInstanceName: "alpha",
    lastRoutedAgentId: "bob",
    routingSegment: "turn:seg-bob",
    sessionSettings: { thinkingLevel: "high" },
  });
}

function stubBridge() {
  const prevUrl = process.env.BRIDGE_URL;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  process.env.BRIDGE_URL = "http://bridge.test";
  process.env.BRIDGE_SHARED_SECRET = "s3cret";
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
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

describe("a session operation reaches the CURRENT routed session", () => {
  test("getChatRouting: currentSession resolves the confirmed routed agent and segment", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await routedRoom(t);
    const current = await t.query(internal.bridge.getChatRouting, {
      chatId,
      userId: owner,
      currentSession: true,
    });
    expect(current?.target?.agentId).toBe("bob");
    expect(current?.openclawChatId).toBe("turn:seg-bob");
    // Without the flag — the dispatch of an unrouted turn — nothing changes.
    const legacy = await t.query(internal.bridge.getChatRouting, { chatId, userId: owner });
    expect(legacy?.target?.agentId).toBe("alice");
    expect(legacy?.openclawChatId).toBe("legacy-alice-session");
  });

  test("no confirmed route, or one the owner lost: the primary's session, unchanged", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t, { openclawChatId: "legacy-alice-session" });
    const single = await t.query(internal.bridge.getChatRouting, {
      chatId,
      userId: owner,
      currentSession: true,
    });
    expect(single?.target?.agentId).toBe("alice");
    expect(single?.openclawChatId).toBe("legacy-alice-session");
    // The last-routed agent no longer resolves for the owner (a group grants alice only).
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, {
        perTurnRouting: true,
        lastRoutedInstanceName: "alpha",
        lastRoutedAgentId: "bob",
        routingSegment: "turn:seg-bob",
      });
      const groupId = await ctx.db.insert("groups", {
        key: "g",
        name: "g",
        createdBy: owner,
        createdAt: 1,
      });
      await ctx.db.insert("groupAgents", { groupId, ...alice, createdAt: 1 });
      await ctx.db.insert("groupMembers", { groupId, userId: owner, joinedAt: 1 });
    });
    const lost = await t.query(internal.bridge.getChatRouting, {
      chatId,
      userId: owner,
      currentSession: true,
    });
    expect(lost?.target?.agentId).toBe("alice");
    expect(lost?.openclawChatId).toBe("legacy-alice-session");
  });

  test("a session-knob patch reaches the current routed session", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await routedRoom(t);
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatchPatch, { chatId, userId: owner });
      const call = bridge.calls.find((c) => c.url.endsWith("/patch"));
      expect(call?.body).toMatchObject({
        openclawChatId: "turn:seg-bob",
        agentId: "bob",
      });
    } finally {
      bridge.restore();
    }
  });

  test("the panel's reset reaches the current routed session", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await routedRoom(t);
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatchReset, { chatId, userId: owner });
      const call = bridge.calls.find((c) => c.url.endsWith("/reset"));
      expect(call?.body).toMatchObject({
        openclawChatId: "turn:seg-bob",
        agentId: "bob",
        refuseIfActive: true,
      });
    } finally {
      bridge.restore();
    }
  });

  test("a manual compaction reaches the current routed session", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await routedRoom(t);
    const bridge = stubBridge();
    try {
      await as(t, owner).action(api.agentFiles.compactSession, { chatId });
      const call = bridge.calls.find((c) => c.url.endsWith("/compact"));
      expect(call?.body).toMatchObject({
        openclawChatId: "turn:seg-bob",
        agentId: "bob",
      });
    } finally {
      bridge.restore();
    }
  });
});

describe("the routed-switch signal does not depend on the provider", () => {
  test("a Hermes agent addressed after another agent spoke is told so", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t, {
      perTurnRouting: true,
      lastRoutedInstanceName: "alpha",
      lastRoutedAgentId: "bob",
      routingSegment: "turn:seg-bob",
    });
    await seedAgent(t, "herm", "hera", { kind: "hermes" });
    const hera = { instanceName: "herm", agentId: "hera" };
    await as(t, owner).mutation(api.chatAgents.addChatAgent, { chatId, ...hera });
    const [turn] = await seedMessages(t, chatId, owner, [
      { role: "user", text: "q", routed: hera },
    ]);
    const began = await t.mutation(internal.bridge.beginTurnRouting, {
      chatId,
      userId: owner,
      routedAgent: hera,
      turnId: turn!,
    });
    expect(began).toMatchObject({ isSwitch: true });
    const routing = await t.query(internal.bridge.getChatRouting, {
      chatId,
      userId: owner,
      routedAgent: hera,
      routedSwitch: true,
      routingSegment: `turn:${turn}`,
    });
    expect(routing?.target?.instanceName).toBe("herm");
    expect(routing?.configOverrides).toMatchObject({ routedSwitch: true });
  });
});

// ── Codex pass 1 (2026-09-26), P2 ×2 ─────────────────────────────────────────
describe("a primary change never re-attributes what another change is still pinning", () => {
  test("A→B then B→C before A's pin finished: every turn A answered stays A's", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const carol = { instanceName: "alpha", agentId: "carol" };
    await as(t, owner).mutation(api.chatAgents.addChatAgent, { chatId, ...carol });
    const n = PRIMARY_PIN_BATCH + 40;
    const ids = await seedMessages(
      t,
      chatId,
      owner,
      Array.from({ length: n }, (_, i) => ({ role: "user" as const, text: `q${i}` })),
    );
    // A→B: the first batch is pinned now, the rest by a scheduled continuation that
    // has not run yet.
    await as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob });
    // B→C at once. Whatever it answers, the continuations may run in any order —
    // one scheduled later may commit first — so bob's pin, if any, goes first here.
    await as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...carol });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    for (const s of scheduled) {
      const args = s.args[0] as { agent?: { agentId: string } } | undefined;
      if (s.name.includes("continuePinUnroutedHistory") && args?.agent?.agentId === "bob") {
        await t.mutation(internal.chatAgents.continuePinUnroutedHistory, s.args[0] as never);
      }
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const stamps = await t.run(async (ctx) =>
      Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.routedAgentId)),
    );
    expect(stamps.filter((a) => a !== "alice")).toEqual([]);
    // Once the pin is done, the change goes through, and still re-attributes nothing.
    await as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...carol });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const chat = (await t.run((ctx) => ctx.db.get(chatId)))!;
    expect(chat.agentId).toBe("carol");
    const after = await t.run(async (ctx) =>
      Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.routedAgentId)),
    );
    expect(after.filter((a) => a !== "alice")).toEqual([]);
  });
});

describe("a queued turn goes to the agent its message is attributed to", () => {
  test("a message waiting in the queue (held for a call): the primary does not change under it", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    // A turn accepted with no agent named — the primary's — parked `queued` while
    // nothing streams (the bridge refused it to keep a call alive; it drains later).
    const [messageId] = await seedMessages(t, chatId, owner, [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
    ]).then((ids) => [ids[2]!]);
    const outboxId = await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "held-1",
        messageId,
        text: "q2",
        attachmentIds: [],
        status: "queued",
      }),
    );
    const change = await as(t, owner).mutation(api.chatAgents.setPrimaryAgent, {
      chatId,
      ...bob,
    });
    // The held turn drains, and goes where its message says it went.
    await t.run((ctx) => ctx.db.patch(outboxId, { status: "pending", pendingSince: Date.now() }));
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatch, { outboxId });
      const chat = (await t.run((ctx) => ctx.db.get(chatId)))!;
      const message = (await t.run((ctx) => ctx.db.get(messageId!)))!;
      const attributed = message.routedAgentId ?? chat.agentId;
      const sends = bridge.calls.filter((c) => c.url.endsWith("/send"));
      expect(sends.map((c) => c.body.agentId)).toEqual([attributed]);
    } finally {
      bridge.restore();
    }
    // Refused as "busy" — the panel's existing answer (conversation_primary_busy).
    expect(change).toEqual({ changed: false, reason: "busy" });
  });
});

// ── Codex pass 2 (2026-09-26), P2 ────────────────────────────────────────────
// Every reader of the thread attributes an unstamped message to the chat's CURRENT
// primary (rehydration, labels, export, regenerate, fork, the thread's chips). So at
// no moment may an unstamped message belong to anyone else — not even while a long
// thread's pin is still running in scheduled batches.
describe("no reader ever sees the former primary's turns as the new one's", () => {
  async function attribution(t: T, chatId: Id<"chats">) {
    return t.run(async (ctx) => {
      const chat = (await ctx.db.get(chatId))!;
      const all = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const primary =
        chat.instanceName && chat.agentId
          ? { instanceName: chat.instanceName, agentId: chat.agentId }
          : null;
      return [...attributeHistoryAgents(all, primary).values()].map((a) => a?.agentId);
    });
  }

  test("a long thread: right after the change is asked, and after every batch", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const n = PRIMARY_PIN_BATCH + 40;
    await seedMessages(
      t,
      chatId,
      owner,
      Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `m${i}`,
      })),
    );
    await as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob });
    // Before any scheduled batch: a send now would rehydrate the newest replies.
    expect((await attribution(t, chatId)).filter((a) => a !== "alice")).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await attribution(t, chatId)).filter((a) => a !== "alice")).toEqual([]);
    // Asked again once the history is pinned, the change is made in one transaction.
    await expect(
      as(t, owner).mutation(api.chatAgents.setPrimaryAgent, { chatId, ...bob }),
    ).resolves.toEqual({ changed: true });
    expect((await t.run((ctx) => ctx.db.get(chatId)))!.agentId).toBe("bob");
    expect((await attribution(t, chatId)).filter((a) => a !== "alice")).toEqual([]);
  });
});

// ── Codex pass 3 (2026-09-26), P2 ────────────────────────────────────────────
// `_creationTime` is NOT unique per table: the local backend holds two messages with
// the very same value (measured, see the report). convex-test cannot produce a tie
// (it bumps every insert by 0.001 ms), so the batch runs here on an in-memory table
// with the index order Convex uses — (chatId, _creationTime, then the document id).
describe("the pin cursor survives messages sharing a creation time", () => {
  type Row = {
    _id: string;
    _creationTime: number;
    chatId: string;
    role: "user" | "assistant";
    routedInstanceName?: string;
    routedAgentId?: string;
  };

  function fakeCtx(chat: Record<string, unknown>, rows: Row[]) {
    const docs = new Map<string, Record<string, unknown>>([[String(chat._id), chat]]);
    for (const r of rows) docs.set(r._id, r);
    const ctx = {
      db: {
        get: async (id: string) => docs.get(String(id)) ?? null,
        patch: async (id: string, fields: Record<string, unknown>) => {
          const doc = docs.get(String(id))!;
          for (const [k, v] of Object.entries(fields)) {
            if (v === undefined) delete doc[k];
            else doc[k] = v;
          }
        },
        query: (_table: string) => ({
          withIndex: (
            _name: string,
            range: (q: Record<string, (f: string, v: unknown) => unknown>) => unknown,
          ) => {
            const conds: Array<(r: Row) => boolean> = [];
            const q: Record<string, (f: string, v: unknown) => unknown> = {};
            const add = (test: (a: number, b: number) => boolean) => (f: string, v: unknown) => {
              conds.push((r) =>
                f === "chatId"
                  ? r.chatId === v
                  : test((r as unknown as Record<string, number>)[f]!, v as number),
              );
              return q;
            };
            q.eq = (f, v) => {
              conds.push((r) => (r as unknown as Record<string, unknown>)[f] === v);
              return q;
            };
            q.gt = add((a, b) => a > b);
            q.gte = add((a, b) => a >= b);
            q.lt = add((a, b) => a < b);
            q.lte = add((a, b) => a <= b);
            range(q);
            const hits = rows
              .filter((r) => conds.every((c) => c(r)))
              .sort((a, b) =>
                a._creationTime !== b._creationTime
                  ? a._creationTime - b._creationTime
                  : a._id < b._id
                    ? -1
                    : 1,
              );
            return { take: async (n: number) => hits.slice(0, n) };
          },
        }),
      },
    };
    return { ctx: ctx as unknown as MutationCtx, docs };
  }

  async function pinAll(times: number[]) {
    const chat = { _id: "chat1", userId: "u", updatedAt: 1 } as Record<string, unknown>;
    const rows: Row[] = times.map((t, i) => ({
      _id: `m${String(i).padStart(5, "0")}`,
      _creationTime: t,
      chatId: "chat1",
      role: "user",
    }));
    const { ctx, docs } = fakeCtx(chat, rows);
    const until = Math.max(...times);
    let done = false;
    for (let round = 0; round < 20 && !done; round++) {
      done = await pinUnroutedBatch(
        ctx,
        docs.get("chat1") as unknown as Doc<"chats">,
        alice,
        until,
      );
    }
    return { done, unstamped: rows.filter((r) => r.routedAgentId !== "alice").map((r) => r._id) };
  }

  test("two messages tied across the batch boundary: neither is skipped", async () => {
    const times = Array.from({ length: PRIMARY_PIN_BATCH + 40 }, (_, i) => 1000 + i);
    // The last message of the first batch and the first of the next share a time.
    times[PRIMARY_PIN_BATCH] = times[PRIMARY_PIN_BATCH - 1]!;
    expect(await pinAll(times)).toEqual({ done: true, unstamped: [] });
  });

  test("more messages at one creation time than a batch holds: all pinned, and it ends", async () => {
    const times = Array.from({ length: 2 * PRIMARY_PIN_BATCH + 10 }, () => 5000);
    expect(await pinAll(times)).toEqual({ done: true, unstamped: [] });
  });
});
