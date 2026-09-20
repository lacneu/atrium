/// <reference types="vite/client" />
//
// WHO OWNS A VOICE SESSION — the Convex half.
//
// The gateway reads a Talk session's owning agent off an AGENT-SCOPED session key;
// without one it falls back to `config.talk.agentId`, and refuses outright when
// several agents are configured with no such fallback ("Talk session ownership has
// no explicit owner"). The bridge builds that key, but only from
// ingredients Convex resolves from OWNED state — so this prepare is where the
// owner is actually decided. Live prod 2026-09-17: it returned only the instance
// and the transport, the create went out unscoped, and voice was dead on both
// multi-agent instances.
//
// Naming the owner is not enough: it has to be the agent the THREAD is talking to,
// on the conversation that thread is using. Two cases below say so (a per-turn
// routed chat, a rebind), and one drives the real action to the wire.
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

interface SeedOpts {
  /** The chat routes per turn; its last confirmed turn went to this agent. */
  perTurn?: { lastAgentId: string; segment: string };
  /** Grant `agentId` on the gateway's agent roster (a second agent). */
  extraAgents?: string[];
  /** The chat is bound to an agent the user is NOT granted and that is GONE. */
  boundAgentId?: string;
  /** Outbox rows to lay down, oldest first: the chat's send history. `agentId`
   *  absent = a send that addressed the chat's PRIMARY binding. */
  outbox?: {
    status: "queued" | "pending" | "sent" | "failed";
    agentId?: string;
    segment?: string;
    /** When this row entered DISPATCH — not when it was created. */
    pendingSince?: number;
  }[];
}

async function seedTalkChat(
  t: ReturnType<typeof convexTest>,
  opts: SeedOpts = {},
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "olivier",
    });
    await ctx.db.insert("instances", {
      name: "lacneu",
      gatewayUrl: "wss://gw.example.org",
      config: { talkEnabled: true },
    });
    // The gateway must ALSO expose the surface: `talkAvailable` is fail-closed on it.
    // ONE singleton per deployment — a second seeded chat must not insert a twin.
    const compatExists = await ctx.db.query("bridgeCompat").first();
    if (compatExists === null)
      await ctx.db.insert("bridgeCompat", {
      key: "singleton",
      reachable: true,
      bridgeVersion: "0.84.10",
      protocolVersion: 2,
      compat: null,
      fetchedAt: Date.now(),
      targets: [
        {
          instanceName: "lacneu",
          provider: "openclaw",
          gatewayVersion: "2026.9.4",
          capabilities: { talk: true },
          versionBeyondValidated: false,
        },
      ],
    });
    const granted = ["alice", ...(opts.extraAgents ?? [])];
    for (const [i, agentId] of granted.entries()) {
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "lacneu",
        agentId,
        isDefault: i === 0,
        source: "manual" as const,
        createdAt: 1,
      });
      await ctx.db.insert("agents", {
        instanceName: "lacneu",
        agentId,
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
    }
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "lacneu",
      agentId: opts.boundAgentId ?? "alice",
      openclawChatId: "oc-bound",
      ...(opts.perTurn
        ? {
            perTurnRouting: true,
            routingSegment: opts.perTurn.segment,
            lastRoutedInstanceName: "lacneu",
            lastRoutedAgentId: opts.perTurn.lastAgentId,
          }
        : {}),
    });
    for (const [i, row] of (opts.outbox ?? []).entries()) {
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: `cm-${i}`,
        text: `m-${i}`,
        attachmentIds: [],
        status: row.status,
        ...(row.agentId
          ? { routedAgent: { instanceName: "lacneu", agentId: row.agentId } }
          : {}),
        ...(row.segment ? { dispatchSegment: row.segment } : {}),
        ...(row.pendingSince ? { pendingSince: row.pendingSince } : {}),
      });
    }
    return { userId, chatId };
  });
}

const asOwner = (t: ReturnType<typeof convexTest>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|session` });

/** Mint a real session through the public action, returning its handle. */
async function mintFor(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  chatId: Id<"chats">,
  routedAgent?: { instanceName: string; agentId: string },
  gateway?: { expiresAt: number },
) {
  const prevUrl = process.env.BRIDGE_URL;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  process.env.BRIDGE_URL = "http://bridge.test";
  process.env.BRIDGE_SHARED_SECRET = "s3cret";
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_i: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        ok: true,
        ownerScoped: true,
        session: {
          clientSecret: "ek_x",
          offerUrl: "https://gw.example.org/offer",
          model: "gpt-realtime",
          ...(gateway ? { expiresAt: gateway.expiresAt } : {}),
        },
      }),
      { status: 200 },
    );
  });
  try {
    const res = await asOwner(t, userId).action(api.talk.mintTalkSession, {
      chatId,
      ...(routedAgent ? { routedAgent } : {}),
    });
    return { res, bodies };
  } finally {
    vi.unstubAllGlobals();
    if (prevUrl === undefined) delete process.env.BRIDGE_URL;
    else process.env.BRIDGE_URL = prevUrl;
    if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
    else process.env.BRIDGE_SHARED_SECRET = prevSecret;
  }
}

describe("prepareTalkSession names the owning agent", () => {
  test("it returns the session-key ingredients, not just the instance", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("alice");
    expect(prep.canonical).toBe("olivier");
    // The chat's BOUND gateway conversation, so the voice session lands where a
    // typed turn lands.
    expect(prep.openclawChatId).toBe("oc-bound");
  });

  test("a PER-TURN routed chat names the agent its last turn went to", async () => {
    // THE DEFECT: the agent came from the chat's PRIMARY binding while the segment
    // came from the LAST ROUTED turn. A chat bound to alice whose last turn went to
    // bob would mint `agent:alice:…:<bob's segment>` — one agent's name over another
    // agent's conversation, which is the silent split this whole fix exists to avoid.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "bob", segment: "turn:42" },
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("bob");
    expect(prep.openclawChatId).toBe("turn:42");
  });

  test("a REBIND drops the old agent's conversation id", async () => {
    // THE DEFECT: when the bound agent is gone the resolver hands back a
    // replacement, and `chat.openclawChatId` is then the OLD agent's provider
    // conversation. convex/bridge.ts drops it on the typed path for exactly that
    // reason; carrying it here would point the new agent at a session that is not
    // its own.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { boundAgentId: "ghost" });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("alice"); // the fallback grant
    expect(prep.openclawChatId).toBeNull();
  });
});

describe("mintTalkSession puts the owner ON THE WIRE", () => {
  test("the bridge POST carries the three ingredients", async () => {
    // The prepare returning them proves nothing on its own: dropping the fields
    // from the POST body would leave the queries above green and voice dead.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          ok: true,
          ownerScoped: true,
          session: {
            clientSecret: "ek_x",
            offerUrl: "https://gw.example.org/offer",
            model: "gpt-realtime",
            expiresAt: 9_999_999_999,
          },
        }),
        { status: 200 },
      );
    });
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
      });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        instanceName: "lacneu",
        chatId,
        agentId: "alice",
        canonical: "olivier",
        openclawChatId: "oc-bound",
      });
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });
});

describe("the voice session follows the thread mid-switch", () => {
  test("a switch being DISPATCHED outranks the last confirmed tuple", async () => {
    // THE DEFECT: `lastRouted*` only advances on CONFIRMATION. Between the send to
    // bob and its confirmation, the typed turn is bob's while voice still answered
    // alice's — two agents, one conversation.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "alice", segment: "turn:7" },
      outbox: [{ status: "pending", agentId: "bob", segment: "turn:99" }],
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("bob");
    // AND the segment that dispatch stamped on the row. Reading the agent from the
    // row and the segment from the chat mints bob's name over alice's conversation
    // — the exact mixing this resolution exists to prevent.
    expect(prep.openclawChatId).toBe("turn:99");
  });

  test("a FAILED switch is not a transient gap — the chat stays on that agent", async () => {
    // The switched-to agent's gateway failed the dispatch, so `lastRouted*` never
    // advanced; the composer and the retry stay on bob, and so must voice.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "alice", segment: "turn:7" },
      outbox: [{ status: "failed", agentId: "bob", segment: "turn:99" }],
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("bob");
    expect(prep.openclawChatId).toBe("turn:99");
  });

  test("a QUEUED follow-up describes a FUTURE turn and is ignored", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "alice", segment: "turn:7" },
      outbox: [{ status: "queued", agentId: "bob" }],
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("alice");
  });

  test("per-turn FLAGGED but nothing routed yet keeps the bound conversation", async () => {
    // The dispatch's segment branch needs a routed agent (`perTurnRouting &&
    // routedAgent`); without one it keeps `chat.openclawChatId`. Forcing null here
    // would key voice to a conversation the next typed turn would not use.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {});
    await t.run((ctx) => ctx.db.patch(chatId, { perTurnRouting: true }));
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("alice");
    expect(prep.openclawChatId).toBe("oc-bound");
  });
});

describe("the OTHER two Talk lanes resolve the same way", () => {
  // Three consumers, one helper: unplugging any ONE of them must be visible.
  const routedToBob = {
    extraAgents: ["bob"],
    perTurn: { lastAgentId: "bob", segment: "turn:42" },
  };

  test("the agent-consult relay addresses the chat's CURRENT agent", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, routedToBob);
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("bob");
    expect(prep.openclawChatId).toBe("turn:42");
  });

  test("the button's visibility probes the instance the session would reach", async () => {
    // Talk is enabled PER INSTANCE. A chat now routed to an agent on a
    // talk-disabled instance must not show a button that cannot work.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, routedToBob);
    const as = asOwner(t, userId);
    expect(await as.query(api.talk.talkAvailable, { chatId })).toBe(true);
    await t.run(async (ctx) => {
      // Move bob to a second, talk-DISABLED instance.
      await ctx.db.insert("instances", {
        name: "ataraxis",
        gatewayUrl: "wss://gw2.example.org",
        config: { talkEnabled: false },
      });
      const compatDoc = (await ctx.db.query("bridgeCompat").first())!;
      await ctx.db.patch(compatDoc._id, {
        targets: [
          ...compatDoc.targets,
          {
            instanceName: "ataraxis",
            provider: "openclaw",
            gatewayVersion: "2026.9.4",
            capabilities: { talk: true },
            versionBeyondValidated: false,
          },
        ],
      });
      const grant = await ctx.db
        .query("userAgents")
        .filter((q) => q.eq(q.field("agentId"), "bob"))
        .first();
      await ctx.db.patch(grant!._id, { instanceName: "ataraxis" });
      const agentRow = await ctx.db
        .query("agents")
        .filter((q) => q.eq(q.field("agentId"), "bob"))
        .first();
      await ctx.db.patch(agentRow!._id, { instanceName: "ataraxis" });
      const chat = await ctx.db.get(chatId);
      await ctx.db.patch(chatId, {
        lastRoutedInstanceName: "ataraxis",
        lastRoutedAgentId: "bob",
      });
      void chat;
    });
    expect(await as.query(api.talk.talkAvailable, { chatId })).toBe(false);
  });
});

describe("which send speaks for the current turn", () => {
  test("a PENDING row outranks a more recent sent/failed one", () => {
    // Laid down oldest-first, so the `sent` row is NEWER than the `pending` one:
    // recency alone would answer carol. `pending` is the dispatch happening NOW.
    return (async () => {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await seedTalkChat(t, {
        extraAgents: ["bob", "carol"],
        perTurn: { lastAgentId: "alice", segment: "turn:1" },
        outbox: [
          { status: "pending", agentId: "bob", segment: "turn:2" },
          { status: "sent", agentId: "carol", segment: "turn:3" },
        ],
      });
      const prep = await asOwner(t, userId).query(
        internal.talk.prepareTalkSession,
        { chatId },
      );
      expect(prep.ok).toBe(true);
      if (!prep.ok) return;
      expect(prep.agentId).toBe("bob");
      expect(prep.openclawChatId).toBe("turn:2");
    })();
  });

  test("a send with NO routed agent means the PRIMARY binding, not 'no evidence'", async () => {
    // The dispatch resolves a null choice to the chat's binding. Falling through to
    // `lastRouted*` here would answer the agent from BEFORE that send.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "bob", segment: "turn:7" },
      outbox: [{ status: "sent" }],
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("alice");
  });
});

describe("the composer's current selection", () => {
  test("a pick the user has NOT sent is who the voice talks to", async () => {
    // THE DEFECT A USER WOULD REPORT: the picker shows bob, the voice answers as
    // alice. Agents differ in instructions, tools and access — this is not cosmetic.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "alice", segment: "turn:1" },
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId, routedAgent: { instanceName: "lacneu", agentId: "bob" } },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("bob");
    // No turn ever went to bob, so no conversation of his exists. NOT alice's
    // segment, and NOT the chat's bound id either — that one belongs to whichever
    // agent the chat was bound to. `null` lets the bridge key on the chat id.
    expect(prep.openclawChatId).toBeNull();
  });

  test("a pick is AUTHORIZED, not obeyed — an ungranted agent cannot be reached", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId, routedAgent: { instanceName: "lacneu", agentId: "mallory" } },
    );
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.code).toBe("no_agent");
  });
});

describe("the composer selection survives every hop to the bridge", () => {
  // Each hop is its own chance to drop the field, and a test that calls the
  // internal prepare directly cannot see the PUBLIC action stop forwarding it.
  test("mintTalkSession forwards the pick, and hands back the session handle", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "alice", segment: "turn:1" },
    });
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          ok: true,
          ownerScoped: true,
          session: {
            clientSecret: "ek_x",
            offerUrl: "https://gw.example.org/offer",
            model: "gpt-realtime",
            expiresAt: 9_999_999_999,
          },
        }),
        { status: 200 },
      );
    });
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (!res.ok) return;
      // The bridge is told BOB…
      expect(bodies[0]).toMatchObject({ agentId: "bob" });
      // …and the client is handed the session's HANDLE — an id, and nothing else.
      // The agent is NOT returned: which agent, canonical and conversation the call
      // belongs to stays in the server's row, which is what makes it proof.
      expect(res.sessionId).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("relayTalkToolCall carries the HANDLE all the way to the bridge body", async () => {
    // Every hop is a chance to drop it, and the handle tests above call the internal
    // prepare directly — they cannot see the PUBLIC action stop forwarding `sessionId`.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "bob", segment: "turn:7" },
    });
    const { res } = await mintFor(t, userId, chatId, {
      instanceName: "lacneu",
      agentId: "bob",
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    // The thread moves on WHILE the call is up: re-resolution would answer
    // alice/turn:8.
    await t.run((ctx) =>
      ctx.db.patch(chatId, {
        lastRoutedAgentId: "alice",
        routingSegment: "turn:8",
      }),
    );
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_i: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, resultText: "ok" }), {
        status: 200,
      });
    });
    try {
      await asOwner(t, userId).action(api.talk.relayTalkToolCall, {
        chatId,
        callId: "call-1",
        args: { question: "où en est le lot ?" },
        sessionId: res.sessionId,
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        agentId: "bob",
        openclawChatId: "turn:7",
      });
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("WITHOUT a handle, the relay falls back to the named agent (legacy path)", async () => {
    // No session is minted here and no `sessionId` is sent: this pins the path a
    // client that predates the handle takes, where the named agent is all the server
    // has to go on. The thread points at ALICE, so only the forwarded `routedAgent`
    // can produce bob — an earlier version pointed the fixture at bob and stayed
    // green with the forwarding removed.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "alice", segment: "turn:alice" },
    });
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, resultText: "ok" }), {
        status: 200,
      });
    });
    try {
      await asOwner(t, userId).action(api.talk.relayTalkToolCall, {
        chatId,
        callId: "call-1",
        args: { question: "où en est le lot ?" },
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      });
      expect(bodies).toHaveLength(1);
      // Bob, and NOT alice's conversation: the named agent brings his own (none yet,
      // so the chat id), never the thread's.
      expect(bodies[0]).toMatchObject({ agentId: "bob" });
      expect(bodies[0].openclawChatId).not.toBe("turn:alice");
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("talkAvailable probes the PICKED agent's instance, not the thread's", async () => {
    // bob lives on a talk-DISABLED instance: picking him must hide the button
    // before anything is sent.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "ataraxis",
        gatewayUrl: "wss://gw2.example.org",
        config: { talkEnabled: false },
      });
      // Capability PRESENT on ataraxis: the assertion below must fail on the admin
      // gate alone, not incidentally because the gateway lacks the surface.
      const compat = (await ctx.db.query("bridgeCompat").first())!;
      await ctx.db.patch(compat._id, {
        targets: [
          ...compat.targets,
          {
            instanceName: "ataraxis",
            provider: "openclaw",
            gatewayVersion: "2026.9.4",
            capabilities: { talk: true },
            versionBeyondValidated: false,
          },
        ],
      });
      const grant = await ctx.db
        .query("userAgents")
        .filter((q) => q.eq(q.field("agentId"), "bob"))
        .first();
      await ctx.db.patch(grant!._id, { instanceName: "ataraxis" });
      const agentRow = await ctx.db
        .query("agents")
        .filter((q) => q.eq(q.field("agentId"), "bob"))
        .first();
      await ctx.db.patch(agentRow!._id, { instanceName: "ataraxis" });
    });
    const as = asOwner(t, userId);
    expect(await as.query(api.talk.talkAvailable, { chatId })).toBe(true);
    expect(
      await as.query(api.talk.talkAvailable, {
        chatId,
        routedAgent: { instanceName: "ataraxis", agentId: "bob" },
      }),
    ).toBe(false);
  });
});

describe("the composer's selection SELECTS from the evidence, it does not erase it", () => {
  // THE DEFECT THIS CAUGHT. `composerSelected` is the thread's EFFECTIVE agent, not
  // "a pick the user never sent" — the browser passes it on every call. Treating an
  // explicit target as "no turn exists for this agent" therefore hid the very outbox
  // row that knew the conversation, and the voice session opened `<agent>:<chatId>`
  // while the turn in flight used `<agent>:turn:<n>`. The mid-switch tests above
  // called the prepare WITHOUT the argument the browser really sends, so they stayed
  // green through it.
  test("a pick matching the dispatch in flight inherits ITS conversation", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "alice", segment: "turn:7" },
      outbox: [{ status: "pending", agentId: "bob", segment: "turn:99" }],
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId, routedAgent: { instanceName: "lacneu", agentId: "bob" } },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("bob");
    expect(prep.openclawChatId).toBe("turn:99");
  });

  test("a pick matching the CONFIRMED agent inherits the confirmed segment", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "bob", segment: "turn:7" },
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId, routedAgent: { instanceName: "lacneu", agentId: "bob" } },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.openclawChatId).toBe("turn:7");
  });

  test("a pick on the chat's own binding inherits the bound conversation", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId, routedAgent: { instanceName: "lacneu", agentId: "alice" } },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.openclawChatId).toBe("oc-bound");
  });

  test("a dispatch not yet stamped falls back to the SAME agent's known conversation", async () => {
    // Between the row's insertion and beginTurnRouting there is no dispatchSegment.
    // That does not mean bob has no conversation: the confirmed tuple says he does.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "bob", segment: "turn:7" },
      outbox: [{ status: "pending", agentId: "bob" }],
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("bob");
    expect(prep.openclawChatId).toBe("turn:7");
  });

  test("a send to the PRIMARY binding with no stamp keeps the bound conversation", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      outbox: [{ status: "pending", agentId: "alice" }],
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.openclawChatId).toBe("oc-bound");
  });
});

describe("the live call is proven by a server handle, not re-derived", () => {
  test("the consult stays in the call after the thread has moved on", async () => {
    // THE DEFECT A HANDLE EXISTS FOR. The call is opened on bob/turn:7. While the
    // user is speaking, a turn to alice is confirmed: `routingSegment` becomes
    // turn:8 and the outbox row that knew turn:7 is superseded. Anything that
    // RE-DERIVES the call's conversation from current state now answers turn:8 and
    // walks the consult out of the live session.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "bob", segment: "turn:7" },
    });
    const { res } = await mintFor(t, userId, chatId, {
      instanceName: "lacneu",
      agentId: "bob",
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    // …the thread moves to alice on a new segment.
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, {
        lastRoutedAgentId: "alice",
        routingSegment: "turn:8",
      });
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId, sessionId: res.sessionId },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("bob");
    expect(prep.openclawChatId).toBe("turn:7");
  });

  test("a call opened before any turn is pinned just as firmly", async () => {
    // With no conversation to inherit, the bridge keys on the chat id. The handle
    // records that EFFECTIVE value, so a first typed turn minting `turn:<n>` later
    // cannot drag the consult out of the call.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "alice", segment: "turn:1" },
    });
    const { res } = await mintFor(t, userId, chatId, {
      instanceName: "lacneu",
      agentId: "bob",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await t.run((ctx) =>
      ctx.db.patch(chatId, {
        lastRoutedAgentId: "bob",
        routingSegment: "turn:2",
      }),
    );
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId, sessionId: res.sessionId },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.openclawChatId).toBe(chatId);
  });

  test("ANOTHER user's handle is refused outright", async () => {
    const t = convexTest(schema, modules);
    // The owner's call is on a DISTINCT conversation, so honouring the stolen handle
    // and re-resolving the intruder's own chat cannot produce the same answer.
    const owner = await seedTalkChat(t, {
      perTurn: { lastAgentId: "alice", segment: "turn:owner" },
    });
    const intruder = await seedTalkChat(t);
    const { res } = await mintFor(t, owner.userId, owner.chatId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const prep = await asOwner(t, intruder.userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId: intruder.chatId, sessionId: res.sessionId },
    );
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.code).toBe("talk_session_stale");
  });

  test("a handle from ANOTHER chat of the same user is refused too", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const other = await t.run((ctx) =>
      ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "lacneu",
        agentId: "alice",
        openclawChatId: "oc-other",
      }),
    );
    const { res } = await mintFor(t, userId, chatId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId: other, sessionId: res.sessionId },
    );
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.code).toBe("talk_session_stale");
  });

  test("an EXPIRED handle FAILS — it never falls back to the thread", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "bob", segment: "turn:7" },
    });
    const { res } = await mintFor(t, userId, chatId, {
      instanceName: "lacneu",
      agentId: "bob",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await t.run(async (ctx) => {
      await ctx.db.patch(res.sessionId, { expiresAt: Date.now() - 1 });
      await ctx.db.patch(chatId, {
        lastRoutedAgentId: "alice",
        routingSegment: "turn:8",
      });
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId, sessionId: res.sessionId },
    );
    // NOT a silent fallback to alice/turn:8: that would send the consult into a
    // different session under the appearance of success. Only the ABSENCE of a
    // handle takes the legacy path.
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.code).toBe("talk_session_stale");
  });
});

describe("a handle is a proof of address, never a bypass", () => {
  test("an agent revoked DURING the call stops the consult", async () => {
    // The row still names bob and has not expired, but the user no longer holds him.
    // Honouring the row here would keep a revoked agent reachable for two hours.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "bob", segment: "turn:7" },
    });
    const { res } = await mintFor(t, userId, chatId, {
      instanceName: "lacneu",
      agentId: "bob",
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query("userAgents")
        .filter((q) => q.eq(q.field("agentId"), "bob"))
        .first();
      await ctx.db.delete(grant!._id);
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId, sessionId: res.sessionId },
    );
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.code).toBe("agent_restricted");
  });

  test("an agent DELETED on the gateway stops it too", async () => {
    // Deleted (not merely revoked) is the path where an unbound resolution would
    // rebind to a remaining grant. Note what this does NOT prove: the equality check
    // beside the null check is unreachable against today's resolver, which answers
    // an explicit choice with that agent or with nothing.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob"],
      perTurn: { lastAgentId: "bob", segment: "turn:7" },
    });
    const { res } = await mintFor(t, userId, chatId, {
      instanceName: "lacneu",
      agentId: "bob",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await t.run(async (ctx) => {
      // ONLY the gateway-side deletion. Removing the grant as well made this test
      // pass for the same reason as the revocation one above, so it could not tell
      // whether `isDeleted` was still consulted.
      const row = await ctx.db
        .query("agents")
        .filter((q) => q.eq(q.field("agentId"), "bob"))
        .first();
      await ctx.db.patch(row!._id, { presentInLastOk: false });
      const disc = await ctx.db.query("instanceDiscovery").first();
      if (disc === null) {
        await ctx.db.insert("instanceDiscovery", {
          instanceName: "lacneu",
          lastPollOk: true,
          lastPollAt: 1,
        });
      }
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId, sessionId: res.sessionId },
    );
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.code).toBe("agent_restricted");
  });

  test("the canonical is pinned too — it is the key's third component", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const { res } = await mintFor(t, userId, chatId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .filter((q) => q.eq(q.field("userId"), userId))
        .first();
      await ctx.db.patch(profile!._id, { canonical: "olivier-renamed" });
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId, sessionId: res.sessionId },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    // The session on the line is keyed on the canonical the mint used.
    expect(prep.canonical).toBe("olivier");
  });

  test("the handle outlives the credential — its TTL is its own", async () => {
    // The gateway's `expiresAt` expires the connection secret; a WebRTC connection
    // already up outlives it. Taking the handle down with it would drop a live
    // conversation's consult back into the thread's routing.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const { res } = await mintFor(t, userId, chatId, undefined, {
      expiresAt: Date.now() + 60_000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await t.run((ctx) => ctx.db.get(res.sessionId));
    expect(row!.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
  });
});

describe("the handle table does not grow without bound", () => {
  test("the scheduled sweep deletes what has expired and keeps what has not", async () => {
    // The opportunistic sweep only runs when someone mints; a deployment that stops
    // minting would otherwise keep its last expired rows forever.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const ids = await t.run(async (ctx) => {
      const mk = (expiresAt: number) =>
        ctx.db.insert("talkSessions", {
          userId,
          chatId,
          instanceName: "lacneu",
          agentId: "alice",
          canonical: "olivier",
          conversation: "oc-bound",
          createdAt: 1,
          expiresAt,
        });
      return {
        dead: await mk(Date.now() - 1),
        alive: await mk(Date.now() + 60_000),
      };
    });
    await t.mutation(internal.talk.sweepTalkSessions, {});
    const after = await t.run(async (ctx) => ({
      dead: await ctx.db.get(ids.dead),
      alive: await ctx.db.get(ids.alive),
    }));
    expect(after.dead).toBeNull();
    expect(after.alive).not.toBeNull();
  });
});

describe("the right to talk is re-checked when the session is recorded", () => {
  test("a grant revoked DURING the mint refuses the session, secret and all", async () => {
    // The prepare passed, the gateway opened a session, and only then the grant
    // went away. Handing the clientSecret over anyway would give a working voice
    // session to someone who no longer holds the agent — the consult would block it
    // afterwards, far too late.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    vi.stubGlobal("fetch", async () => {
      // The POST "succeeds"; the revocation lands while it is in flight.
      await t.run(async (ctx) => {
        const grant = await ctx.db
          .query("userAgents")
          .filter((q) => q.eq(q.field("agentId"), "alice"))
          .first();
        await ctx.db.delete(grant!._id);
      });
      return new Response(
        JSON.stringify({
          ok: true,
          ownerScoped: true,
          session: {
            clientSecret: "ek_x",
            offerUrl: "https://gw.example.org/offer",
            model: "gpt-realtime",
          },
        }),
        { status: 200 },
      );
    });
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("talk_session_unrecorded");
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("talk switched OFF during the mint refuses it too", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    vi.stubGlobal("fetch", async () => {
      await t.run(async (ctx) => {
        const inst = await ctx.db
          .query("instances")
          .filter((q) => q.eq(q.field("name"), "lacneu"))
          .first();
        await ctx.db.patch(inst!._id, { config: { talkEnabled: false } });
      });
      return new Response(
        JSON.stringify({
          ok: true,
          ownerScoped: true,
          session: {
            clientSecret: "ek_x",
            offerUrl: "https://gw.example.org/offer",
            model: "gpt-realtime",
          },
        }),
        { status: 200 },
      );
    });
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("talk_session_unrecorded");
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("the button is OWNER-only, like the mint — a PARTICIPANT does not get it", async () => {
    // The probe used to accept anyone who can REACH the chat, while the mint requires
    // ownership. A participant therefore saw a button whose click hits an action that
    // refuses — a dead button. A stranger alone cannot prove this: they fail either
    // check.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const guest = await seedTalkChat(t);
    await t.run((ctx) =>
      ctx.db.insert("chatParticipants", {
        chatId,
        userId: guest.userId,
        addedBy: userId,
        addedAt: 1,
      }),
    );
    expect(
      await asOwner(t, userId).query(api.talk.talkAvailable, { chatId }),
    ).toBe(true);
    expect(
      await asOwner(t, guest.userId).query(api.talk.talkAvailable, { chatId }),
    ).toBe(false);
    // …and the parity is the point: the MINT refuses them too. Asserting the probe
    // alone would stay green if the mint stopped being owner-only, which is the
    // direction that actually matters.
    await expect(
      asOwner(t, guest.userId).action(api.talk.mintTalkSession, { chatId }),
    ).rejects.toThrow();
  });
});

describe("a bridge that cannot prove it scoped the session is refused", () => {
  test("an OLD bridge's unacknowledged answer does not become a call", async () => {
    // It replies with the SAME `{ok, session}` shape while dropping the ownership
    // fields, so the gateway opens the session under its own `talk.agentId` fallback
    // — possibly an agent this user was never granted — while the handle would record
    // the agent we asked for. Voice and consult on two different agents is exactly
    // the defect this lot removes.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          // No `ownerScoped`: the old bridge does not know the field.
          JSON.stringify({
            ok: true,
            session: {
              clientSecret: "ek_old",
              offerUrl: "https://gw.example.org/offer",
              model: "gpt-realtime",
            },
          }),
          { status: 200 },
        ),
    );
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("talk_owner_unconfirmed");
      // …and nothing was recorded: a handle for a session we cannot vouch for would
      // be a lie the consult then trusts.
      const rows = await t.run((ctx) => ctx.db.query("talkSessions").collect());
      expect(rows).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });
});

describe("the latest send is the latest DISPATCH, not the latest row", () => {
  test("a row sent LATER but dispatched EARLIER does not win", async () => {
    // NOT a scenario production can reach today: `outboxQueue` keeps one send in
    // flight per chat and drains FIFO, so insertion and dispatch currently agree.
    // This pins the RULE the answer depends on, so a priority lane, a re-dispatched
    // retry or an import without the stamp cannot quietly make insertion order start
    // answering the wrong agent.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob", "carol"],
      perTurn: { lastAgentId: "alice", segment: "turn:1" },
      outbox: [
        // Created FIRST, dispatched LAST: this is the current turn.
        {
          status: "sent",
          agentId: "bob",
          segment: "turn:bob",
          pendingSince: 5_000,
        },
        // Created LAST, dispatched FIRST.
        {
          status: "sent",
          agentId: "carol",
          segment: "turn:carol",
          pendingSince: 1_000,
        },
      ],
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("bob");
    expect(prep.openclawChatId).toBe("turn:bob");
  });

  test("a row that never reached dispatch is ordered by its CREATION", async () => {
    // Today's producers all stamp `pendingSince` on promotion, so a row without one
    // is a historical or non-conforming row rather than a normal state. Sorting
    // those to the beginning of time would let an OLDER stamped row outrank the
    // newest send — the fallback has to be the row's own creation, and this fixture
    // is the one that can tell the two apart: carol is newer and has no stamp.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, {
      extraAgents: ["bob", "carol"],
      perTurn: { lastAgentId: "alice", segment: "turn:1" },
      outbox: [
        { status: "failed", agentId: "bob", segment: "turn:bob", pendingSince: 1_000 },
        { status: "failed", agentId: "carol", segment: "turn:carol" },
      ],
    });
    const prep = await asOwner(t, userId).query(
      internal.talk.prepareTalkSession,
      { chatId },
    );
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.agentId).toBe("carol");
  });
});

describe("the button asks about the instance the session would REACH", () => {
  test("a rebound chat is judged by its NEW instance, not its bound one", async () => {
    // `compat.forChat` answers about the chat AS IT STANDS: with no explicit
    // selection it prefers `chat.instanceName` over the resolver. A chat whose bound
    // agent is gone and which now falls back to another instance would therefore be
    // described by the OLD one — hiding a button that works, or offering one that
    // cannot. Here the BOUND instance has no talk surface and the fallback does.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { boundAgentId: "ghost" });
    await t.run(async (ctx) => {
      // Rebind the chat onto a talk-LESS instance it no longer routes to.
      await ctx.db.patch(chatId, { instanceName: "silent" });
      await ctx.db.insert("instances", {
        name: "silent",
        gatewayUrl: "wss://gw3.example.org",
        config: { talkEnabled: true },
      });
      const compat = (await ctx.db.query("bridgeCompat").first())!;
      await ctx.db.patch(compat._id, {
        targets: [
          ...compat.targets,
          {
            instanceName: "silent",
            provider: "openclaw",
            gatewayVersion: "2026.9.4",
            capabilities: {}, // no talk surface at all
            versionBeyondValidated: false,
          },
        ],
      });
    });
    // The resolver falls back to alice on `lacneu`, which HAS the surface.
    expect(
      await asOwner(t, userId).query(api.talk.talkAvailable, { chatId }),
    ).toBe(true);
  });

  test("no capability snapshot at all = no button (fail closed)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    await t.run(async (ctx) => {
      const compat = (await ctx.db.query("bridgeCompat").first())!;
      await ctx.db.delete(compat._id);
    });
    expect(
      await asOwner(t, userId).query(api.talk.talkAvailable, { chatId }),
    ).toBe(false);
  });

  test("a gateway without the surface = no button", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    await t.run(async (ctx) => {
      const compat = (await ctx.db.query("bridgeCompat").first())!;
      await ctx.db.patch(compat._id, {
        targets: compat.targets.map((x) => ({ ...x, capabilities: {} })),
      });
    });
    expect(
      await asOwner(t, userId).query(api.talk.talkAvailable, { chatId }),
    ).toBe(false);
  });
});

// ── The GPT Live lane (OpenClaw >= 2026.9.5): relayed offer + owed hangup ──────
//
// On the 2026.9.5 default model the gateway OWNS the call and its offer path is on
// the gateway itself; the bridge keeps the secret and answers a handle. Convex then
// carries two more things: the browser's SDP through `relayTalkOffer`, and the
// hangup through `hangupTalkSession` — both authorized by the row the mint recorded,
// exactly as the mid-call consult is.

/** Stub the bridge: answer the mint with `mint`, record every POST by route. */
function stubBridge(mint: Record<string, unknown>) {
  const prevUrl = process.env.BRIDGE_URL;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  process.env.BRIDGE_URL = "http://bridge.test";
  process.env.BRIDGE_SHARED_SECRET = "s3cret";
  const posts: { route: string; host: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = url.pathname;
    posts.push({ route, host: url.host, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (route === "/talk-session") {
      return new Response(JSON.stringify(mint), { status: 200 });
    }
    if (route === "/talk-offer") {
      return new Response(
        JSON.stringify({ ok: true, answerSdp: "v=0\r\nanswer", status: 201 }),
        { status: 200 },
      );
    }
    if (route === "/talk-hangup") {
      return new Response(JSON.stringify({ ok: true, closed: "closed" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  return {
    posts,
    restore() {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    },
  };
}

const RELAYED_BRIDGE_ANSWER = {
  ok: true,
  ownerScoped: true,
  relayed: true,
  session: {
    provider: "openai",
    transport: "webrtc",
    offerRelay: { relayId: "r_handle_0123456789abcdef", expiresAt: 9_999_999_999 },
    model: "gpt-live-1",
    voice: "marin",
    expiresAt: 9_999_999_999,
    voiceSessionId: "vs-live-1",
  },
};

const DIRECT_BRIDGE_ANSWER = {
  ok: true,
  ownerScoped: true,
  session: {
    clientSecret: "ek_x",
    offerUrl: "https://api.openai.com/v1/realtime/calls",
    model: "gpt-realtime-2.1",
    expiresAt: 9_999_999_999,
    voiceSessionId: "vs-classic-1",
  },
};

describe("GPT Live: the relayed mint, the relayed offer and the owed hangup", () => {
  test("a relayed mint hands the browser a handle, and records the call on its row", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (!res.ok) return;
      expect(res.session.offerRelay).toEqual({
        relayId: "r_handle_0123456789abcdef",
        expiresAt: 9_999_999_999,
      });
      expect(res.session.clientSecret).toBeNull();
      expect(res.session.offerUrl).toBeNull();
      expect(res.session.voiceSessionId).toBe("vs-live-1");
      // The row is what the hangup will read: the gateway's id and the lane.
      const row = await t.run((ctx) => ctx.db.get(res.sessionId));
      expect(row?.voiceSessionId).toBe("vs-live-1");
      expect(row?.relayed).toBe(true);
    } finally {
      bridge.restore();
    }
  });

  test("the offer is posted under the ROW's instance, with the handle and the SDP", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      const res = await asOwner(t, userId).action(api.talk.relayTalkOffer, {
        chatId,
        sessionId: minted.sessionId,
        relayId: "r_handle_0123456789abcdef",
        sdp: "v=0\r\noffer",
      });
      expect(res).toEqual({ ok: true, answerSdp: "v=0\r\nanswer" });
      const offer = bridge.posts.find((p) => p.route === "/talk-offer");
      expect(offer?.body).toEqual({
        instanceName: "lacneu",
        // The SESSION the row proved the caller on — the bridge spends the handle
        // for that session key and no other of the same chat.
        chatId,
        openclawChatId: "oc-bound",
        canonical: "olivier",
        agentId: "alice",
        relayId: "r_handle_0123456789abcdef",
        sdp: "v=0\r\noffer",
      });
    } finally {
      bridge.restore();
    }
  });

  test("an offer on a handle that is not this chat's is refused before any POST", async () => {
    // Same boundary as the consult: a foreign or stale row never reaches the bridge.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const other = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, other.userId).action(api.talk.mintTalkSession, {
        chatId: other.chatId,
      });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      const before = bridge.posts.length;
      const res = await asOwner(t, userId).action(api.talk.relayTalkOffer, {
        chatId,
        sessionId: minted.sessionId,
        relayId: "r_handle_0123456789abcdef",
        sdp: "v=0",
      });
      expect(res).toEqual({ ok: false, code: "talk_session_stale" });
      expect(bridge.posts.length).toBe(before);
    } finally {
      bridge.restore();
    }
  });

  test("a blank or oversized offer never leaves Convex", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      const before = bridge.posts.length;
      for (const sdp of ["", "   ", "a".repeat(256 * 1024 + 1)]) {
        const res = await asOwner(t, userId).action(api.talk.relayTalkOffer, {
          chatId,
          sessionId: minted.sessionId,
          relayId: "r_x",
          sdp,
        });
        expect(res).toEqual({ ok: false, code: "invalid_args" });
      }
      expect(bridge.posts.length).toBe(before);
    } finally {
      bridge.restore();
    }
  });

  test("the hangup posts the row's ingredients and the gateway's voice id", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      const res = await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      expect(res).toEqual({ ok: true, closed: "closed" });
      const hang = bridge.posts.find((p) => p.route === "/talk-hangup");
      expect(hang?.body).toEqual({
        instanceName: "lacneu",
        chatId,
        openclawChatId: "oc-bound",
        canonical: "olivier",
        agentId: "alice",
        voiceSessionId: "vs-live-1",
      });
    } finally {
      bridge.restore();
    }
  });

  test("Talk switched OFF mid-call does not stop the hangup", async () => {
    // The consult's prepare refuses a disabled instance — rightly. A hangup must
    // not: closing a call one owns is never a capability, and refusing it here would
    // keep the call alive on the gateway until its TTL (codex P2, pass 2).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await t.run(async (ctx) => {
        const instance = await ctx.db
          .query("instances")
          .withIndex("by_name", (q) => q.eq("name", "lacneu"))
          .first();
        await ctx.db.patch(instance!._id, { config: { talkEnabled: false } });
      });
      const res = await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      expect(res).toEqual({ ok: true, closed: "closed" });
      expect(bridge.posts.some((p) => p.route === "/talk-hangup")).toBe(true);
    } finally {
      bridge.restore();
    }
  });

  test("a chat deleted mid-call can still hang up its gateway-owned session", async () => {
    // cascadeDeleteChat takes the chat and its rows; the talkSessions row survives,
    // and the unmount that follows the navigation must still close the call the
    // gateway holds open. Ownership is the ROW's `userId` + `chatId`, checked when it
    // was written; requiring the chat to exist would throw first (codex P2, pass 3).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await asOwner(t, userId).mutation(api.chats.deleteChat, { chatId });
      const res = await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      expect(res).toEqual({ ok: true, closed: "closed" });
      expect(bridge.posts.some((p) => p.route === "/talk-hangup")).toBe(true);
    } finally {
      bridge.restore();
    }
  });

  test("an agent grant withdrawn mid-call does not stop the hangup either", async () => {
    // The consult's prepare re-runs the grant and refuses `agent_restricted`. A
    // hangup must not re-check it: the call is the user's own, and closing it after
    // the grant went away is exactly what should happen (codex P3, pass 3).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await t.run(async (ctx) => {
        const grants = await ctx.db.query("userAgents").collect();
        for (const g of grants) await ctx.db.delete(g._id);
      });
      const res = await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      expect(res).toEqual({ ok: true, closed: "closed" });
      expect(bridge.posts.some((p) => p.route === "/talk-hangup")).toBe(true);
    } finally {
      bridge.restore();
    }
  });

  test("an account set PENDING mid-call can still hang up its own session", async () => {
    // Every data function gates on an ACTIVE role, rightly. The hangup must not: the
    // moment an account is suspended is exactly when its live call must be closable,
    // and it is closing its OWN call (row ownership) — nothing else (codex P2, pass 4).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await t.run(async (ctx) => {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .unique();
        await ctx.db.patch(profile!._id, { role: "pending" });
      });
      const res = await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      expect(res).toEqual({ ok: true, closed: "closed" });
      expect(bridge.posts.some((p) => p.route === "/talk-hangup")).toBe(true);
    } finally {
      bridge.restore();
    }
  });

  test("the offer and the hangup reach the bridge the MINT went to, not the current routing", async () => {
    // The relay handle and the owning socket live on one bridge process. A
    // failover that moves the instance's routing mid-call would otherwise send the
    // hangup to a bridge that answers `closed:"gone"` for a call it never had, while
    // the real one keeps it until its TTL (codex P2, pass 5).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      const row = await t.run((ctx) => ctx.db.get(minted.sessionId));
      expect(row?.bridgeUrl).toBe("http://bridge.test");
      // The routing moves.
      process.env.BRIDGE_URL = "http://bridge-b.test";
      await asOwner(t, userId).action(api.talk.relayTalkOffer, {
        chatId,
        sessionId: minted.sessionId,
        relayId: "r_handle_0123456789abcdef",
        sdp: "v=0",
      });
      await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      const hosts = bridge.posts.filter((p) => p.route !== "/talk-session").map((p) => p.host);
      expect(hosts).toEqual(["bridge.test", "bridge.test"]);
    } finally {
      bridge.restore();
    }
  });

  test("an unauthenticated caller cannot hang up anyone's session", async () => {
    // Ownership is checked against the ROW, so the identity must come from the
    // request. A derivation that read `live.userId` instead would let anyone holding
    // the two ids close the call; this pins that the request must be signed in.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      const before = bridge.posts.length;
      await expect(
        t.action(api.talk.hangupTalkSession, { chatId, sessionId: minted.sessionId }),
      ).rejects.toThrow(/authenticat/i);
      expect(bridge.posts.length).toBe(before);
    } finally {
      bridge.restore();
    }
  });

  test("a relayed mint without a voiceSessionId is refused — nothing to hang up by", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const { voiceSessionId: _v, ...session } = RELAYED_BRIDGE_ANSWER.session;
    const bridge = stubBridge({ ...RELAYED_BRIDGE_ANSWER, session });
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      expect(res).toEqual({ ok: false, code: "talk_malformed" });
    } finally {
      bridge.restore();
    }
  });

  test("a DIRECT session owes the gateway no hangup — nothing is posted", async () => {
    // Its call is the browser's own (client-owned WebRTC to the provider); closing
    // the peer connection ends it. Posting a close would name a call the gateway
    // does not own.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(DIRECT_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      expect(minted.session.offerRelay).toBeNull();
      const row = await t.run((ctx) => ctx.db.get(minted.sessionId));
      expect(row?.relayed).toBe(false);
      const before = bridge.posts.length;
      const res = await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      expect(res).toEqual({ ok: true, closed: "none" });
      expect(bridge.posts.length).toBe(before);
    } finally {
      bridge.restore();
    }
  });
});

describe("the conversation's socket is opened AS the person the gateway knows", () => {
  test("a trusted-proxy instance naming people by email puts that name on the mint", async () => {
    // A gateway-owned voice call runs under the identity of the socket that minted
    // it. The bridge opens the conversation's socket as `gatewayUser ?? canonical`;
    // the dispatch derives that name (resolveGatewayUser) and so must the mint —
    // one derivation, or the same person gets two gateway profiles.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(userId, { email: "Olivier@Example.org" });
      const instance = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", "lacneu"))
        .first();
      await ctx.db.patch(instance!._id, {
        authMode: "trusted-proxy",
        identitySource: "email",
      });
    });
    const prep = await asOwner(t, userId).query(internal.talk.prepareTalkSession, { chatId });
    expect(prep.ok, JSON.stringify(prep)).toBe(true);
    if (!prep.ok) return;
    expect(prep.gatewayUser).toBe("olivier@example.org");
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const mint = bridge.posts.find((p) => p.route === "/talk-session");
      expect(mint?.body.gatewayUser).toBe("olivier@example.org");
      expect(mint?.body.canonical).toBe("olivier");
    } finally {
      bridge.restore();
    }
  });

  test("a token-mode instance names nobody: the field is absent, not empty", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      const mint = bridge.posts.find((p) => p.route === "/talk-session");
      expect(mint?.body).not.toHaveProperty("gatewayUser");
    } finally {
      bridge.restore();
    }
  });
});
