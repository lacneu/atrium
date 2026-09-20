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
import {
  TALK_CALL_MAX_MS,
  TALK_HANGUP_RETRY_MAX_GAP_MS,
  TALK_HANGUP_RETRY_REACH_MS,
} from "./talk";

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

  test("an ENDED call authorizes NO further consult — ended is over", async () => {
    // Until now only the handle's two-hour TTL stopped the consults, so a call ended
    // in one place went on asking the agent questions from another. It matters most
    // on the DIRECT lane: `talk.client.close` closes the gateway's logical record and
    // nothing can reach the browser↔provider media (upstream client-voice-session.ts
    // says so in as many words), so a second tab's recovery hangup lifted the freeze
    // while the first tab kept talking — and could then hand the conversation to
    // another agent, which is the one thing this lot exists to prevent (codex P1,
    // pass 11). `talk_session_stale` is TERMINAL, so that call ends with a message.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const { res } = await mintFor(t, userId, chatId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // It works while the call is live…
    const before = await asOwner(t, userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId, sessionId: res.sessionId },
    );
    expect(before.ok).toBe(true);
    // …and stops the moment the call is marked ended, TTL or no TTL.
    await t.mutation(internal.talk.markTalkSessionEnded, { sessionId: res.sessionId });
    const row = await t.run((ctx) => ctx.db.get(res.sessionId));
    expect(row?.expiresAt).toBeGreaterThan(Date.now()); // the handle is NOT expired
    const after = await asOwner(t, userId).query(
      internal.talk.prepareTalkToolCall,
      { chatId, sessionId: res.sessionId },
    );
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.code).toBe("talk_session_stale");
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

  test("a hangup the bridge never answered is RETRIED by the server", async () => {
    // Convex marks the row ended BEFORE the POST, so every reader sees no call while
    // the bridge — on the other side of a partition — keeps holding this chat's socket
    // and refusing every agent switch. The browser's own bounded retries stop long
    // before that hold does, and it then forgets the session for good: nothing was
    // left to try (codex P2, pass 12). The server owes this close, so the server
    // retries it.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    let mints = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/talk-session")) {
        mints += 1;
        return new Response(JSON.stringify(RELAYED_BRIDGE_ANSWER), { status: 200 });
      }
      // The hangup never lands: the request itself fails, not the gateway.
      throw new Error("network down");
    });
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      expect(mints).toBe(1);
      const res = await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      expect(res).toMatchObject({ ok: false, code: "bridge_unreachable" });
      // The row is ended regardless — and a retry is armed to free the socket.
      expect(
        (await t.run((ctx) => ctx.db.get(minted.sessionId)))?.endedAt,
      ).toEqual(expect.any(Number));
      const armed = (
        await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
      ).filter((f) => f.name.includes("retryTalkHangup"));
      expect(armed).toHaveLength(1);
      expect(armed[0]?.args?.[0]).toMatchObject({ attempt: 0 });
      // ONE CHAIN PER CALL. The browser retries this action up to three times by
      // itself, and a second tab doubles that again: without the claim each rejection
      // armed another chain, and one hangup under a lasting partition became eighteen
      // POSTs all releasing the same hold (codex P2, pass 15).
      await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      expect(
        (
          await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
        ).filter((f) => f.name.includes("retryTalkHangup")),
      ).toHaveLength(1);
      // AND WHAT IT SENDS. The bridge rebuilds the session key from these and answers
      // `closed:"gone"` — releasing nothing — when it does not match the socket it
      // holds. A retry missing the conversation was a polite no-op the loop then read
      // as delivered, leaving the agent frozen for up to thirty minutes (codex P2,
      // pass 13). Run it and read the POST rather than trusting the arming.
      const row = await t.run((ctx) => ctx.db.get(minted.sessionId));
      const seen: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        seen.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true, closed: "closed" }), {
          status: 200,
        });
      });
      await t.action(internal.talk.retryTalkHangup, {
        chatId,
        sessionId: minted.sessionId,
        attempt: 0,
      });
      const retried = seen.find((p) => String(p.url).endsWith("/talk-hangup"));
      expect(retried, "the retry never posted").toBeDefined();
      // A DELIVERED answer ends the chain: the bridge released in its own `finally`,
      // whatever the gateway said, so asking again would be noise.
      expect(
        (
          await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
        ).filter((f) => f.name.includes("retryTalkHangup")),
      ).toHaveLength(1); // only the original arming, no follow-up
      expect(retried?.body).toMatchObject({
        chatId,
        openclawChatId: row?.conversation,
        canonical: row?.canonical,
        agentId: row?.agentId,
        voiceSessionId: row?.voiceSessionId,
      });
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("the retry chain SPREADS, and stops itself at the end", async () => {
    // Evenly spaced tries over a minute gave up while the hold they release can last
    // thirty on the relayed lane — the chat then stayed frozen with nothing left
    // trying. The delays widen to cover roughly a quarter of an hour, which is the
    // difference between a blip and an outage (found while auditing pass 13).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/talk-session")) {
        return new Response(JSON.stringify(RELAYED_BRIDGE_ANSWER), { status: 200 });
      }
      throw new Error("still partitioned");
    });
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await t.mutation(internal.talk.markTalkSessionEnded, { sessionId: minted.sessionId });
      const armedAfter = async (attempt: number) => {
        await t.action(internal.talk.retryTalkHangup, {
          chatId,
          sessionId: minted.sessionId,
          attempt,
        });
        return (
          await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
        ).filter((f) => f.name.includes("retryTalkHangup"));
      };
      // Each failed attempt arms the NEXT one, to the end of the chain…
      let armed = 0;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const after = (await armedAfter(attempt)).length;
        if (after === armed) break; // the chain stopped arming
        armed = after;
      }
      // …and it really does stop: looping forever on a partition would be worse than
      // letting the hold expire.
      expect(armed).toBeGreaterThan(0);
      expect((await armedAfter(armed)).length).toBe(armed);
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("a PROXY's 503 is not the bridge saying it released", async () => {
    // The bridge's `finally` releases the hold whatever the gateway answered — but an
    // ingress in front of a bridge that is DOWN answers too, and reading that as
    // "released" ended the chain on the one failure it exists for (codex P2, pass 15).
    // Only a 2xx is the bridge's own handler speaking.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/talk-session")) {
        return new Response(JSON.stringify(RELAYED_BRIDGE_ANSWER), { status: 200 });
      }
      // The bridge never ran: this is the ingress answering for it.
      return new Response("service unavailable", { status: 503 });
    });
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      // The user's own hangup gets the 503 — and still owes the close.
      await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      const armedFirst = (
        await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
      ).filter((f) => f.name.includes("retryTalkHangup"));
      expect(armedFirst, "a 5xx from an ingress armed nothing").toHaveLength(1);
      // …and a retry that meets the same 503 keeps going rather than calling it done.
      await t.action(internal.talk.retryTalkHangup, {
        chatId,
        sessionId: minted.sessionId,
        attempt: 0,
      });
      expect(
        (
          await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
        ).filter((f) => f.name.includes("retryTalkHangup")),
      ).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("the retry chain outlasts the hold AND never goes quiet inside it", async () => {
    // Reaching the end is not enough, and asserting only the sum was the wrong
    // invariant: a chain whose delays kept doubling reached past the hold while
    // leaving a twenty-minute silence in the middle, so a partition healing at
    // seventeen minutes met no attempt until after the hold had expired by itself —
    // the exact hole the chain exists to close (codex P2, pass 15).
    //
    // What a user feels is the GAP: how long the chat stays frozen after the network
    // comes back. So both halves are held against the window, never re-added by hand.
    expect(TALK_HANGUP_RETRY_REACH_MS).toBeGreaterThan(TALK_CALL_MAX_MS);
    // A tenth of the hold — small enough that a healed partition is not felt as an
    // outage of its own.
    expect(TALK_HANGUP_RETRY_MAX_GAP_MS).toBeLessThanOrEqual(TALK_CALL_MAX_MS / 6);
  });

  test("a mint Convex refuses to record GIVES THE SOCKET BACK to the bridge", async () => {
    // The bridge has held this chat's socket since the mint (the 2-minute pending
    // window), and that hold is what refuses a typed turn for another agent. With no
    // row written there is no hangup to send later, no end-of-window marker, and
    // nothing in Convex that even knows the hold exists — a message could sit queued
    // behind a call that will never happen, with no call visible anywhere (codex P2,
    // pass 7). The abandon goes out where the failure is known.
    const t = convexTest(schema, modules);
    // A SECOND agent, so the revocation makes the re-resolution land elsewhere rather
    // than nowhere — the same shape as the revoked-grant test above.
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    const posted: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
      if (String(url).endsWith("/talk-hangup")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      // The grant is withdrawn WHILE the mint is in flight: the record will refuse.
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
          relayed: true,
          session: {
            voiceSessionId: "vs-orphan",
            offerRelay: { relayId: "rel-1" },
            model: "gpt-realtime",
          },
        }),
        { status: 200 },
      );
    });
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe("talk_session_unrecorded");
      const abandon = posted.find((p) => p.url.endsWith("/talk-hangup"));
      expect(abandon, "the socket was never given back").toBeDefined();
      expect(abandon?.body).toMatchObject({ voiceSessionId: "vs-orphan", chatId });
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

  test("a DIRECT session TELLS the bridge too — its socket is held all the same", async () => {
    // Its call is the browser's own (client-owned WebRTC to the provider), so a
    // re-key does not END it — and this used to post nothing for exactly that reason.
    // But the chat's agent is pinned all the same: the consult addresses the agent the
    // call was minted for, and a typed turn that re-keys the socket reaches another
    // one mid-sentence. The bridge therefore holds this chat's socket on this lane
    // too, for the whole call window — and that hold lives in its memory, so nothing
    // but this POST releases it. Skipping it would refuse every agent switch for up
    // to thirty minutes after a call the user ended in ten seconds (codex P1, pass 10).
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
      await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      const posted = bridge.posts.slice(before);
      const hangup = posted.find((p) => p.route === "/talk-hangup");
      expect(hangup, "the bridge was never told to release the socket").toBeDefined();
      // …naming the session the bridge holds the socket under.
      expect(hangup?.body).toMatchObject({
        voiceSessionId: row?.voiceSessionId,
        chatId,
      });
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

// ── The agent is frozen while someone is speaking ────────────────────────────
//
// A call is minted for the agent selected at that instant: the gateway holds the
// session and the mid-call consult addresses THAT agent. Routing a typed turn
// elsewhere would split one conversation across two agents — and on a gateway-owned
// call it ends the call, because the bridge keeps one live socket per chat and
// re-keying it closes the one the gateway bound the call to. The composer closes the
// selector; THIS is the boundary that does not depend on a client.

describe("a live call pins the chat's agent", () => {
  async function seedTwoAgentChat(t: ReturnType<typeof convexTest>) {
    return await seedTalkChat(t, { extraAgents: ["bob"] });
  }

  test("a turn routed to ANOTHER agent is refused while a call is up", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTwoAgentChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await expect(
        asOwner(t, userId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-call-1",
          routedAgent: { instanceName: "lacneu", agentId: "bob" },
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });

  test("a turn to the agent ON THE CALL still goes through", async () => {
    // The rule is about SWITCHING, not about speaking: typing to the same agent
    // while on a call is ordinary use.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTwoAgentChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await expect(
        asOwner(t, userId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-call-2",
          routedAgent: { instanceName: "lacneu", agentId: "alice" },
        }),
      ).resolves.toBeDefined();
    } finally {
      bridge.restore();
    }
  });

  test("hanging up releases the agent immediately", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTwoAgentChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      await expect(
        asOwner(t, userId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-call-3",
          routedAgent: { instanceName: "lacneu", agentId: "bob" },
        }),
      ).resolves.toBeDefined();
    } finally {
      bridge.restore();
    }
  });

  test("a hangup the gateway REFUSED still releases it", async () => {
    // The caller stopped speaking whatever the gateway answered, and the retry is
    // what chases the gateway. Holding the agent over a network blip would freeze
    // the conversation for the rest of the call TTL.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTwoAgentChat(t);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    vi.stubGlobal("fetch", async (input: unknown) => {
      const route = new URL(String(input)).pathname;
      if (route === "/talk-session") {
        return new Response(JSON.stringify(RELAYED_BRIDGE_ANSWER), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, error: { code: "boom" } }), {
        status: 502,
      });
    });
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      const res = await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      expect(res.ok).toBe(false);
      const row = await t.run((ctx) => ctx.db.get(minted.sessionId));
      expect(row?.endedAt).toEqual(expect.any(Number));
      await expect(
        asOwner(t, userId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-call-4",
          routedAgent: { instanceName: "lacneu", agentId: "bob" },
        }),
      ).resolves.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("a call nobody hung up releases the agent at the gateway's own TTL", async () => {
    // A browser that crashed never sends its hangup. The freeze must expire on its
    // own, and 30 minutes is the instant past which the gateway has dropped the call
    // anyway — so the release is correct, not merely convenient.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTwoAgentChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await t.run(async (ctx) => {
        // The window is the gateway's 30-minute call TTL PLUS the 60 s an offer may
        // take to be spent — the gateway arms its clock at allocation, not at the
        // mint, so a freeze that ended at 30 minutes would release a minute early.
        await ctx.db.patch(minted.sessionId, {
          createdAt: Date.now() - (31 * 60 * 1000 + 1),
        });
      });
      await expect(
        asOwner(t, userId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-call-5",
          routedAgent: { instanceName: "lacneu", agentId: "bob" },
        }),
      ).resolves.toBeDefined();
    } finally {
      bridge.restore();
    }
  });

  test("MY call in another conversation does not freeze this one", async () => {
    // The rows are per chat as well as per user: one person routinely has several
    // conversations, and a call in one must not lock the agent of the others. This
    // is the case a user-only filter would miss — the two-users test below cannot
    // see it, since the user id already tells those apart.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const second = await t.run(async (ctx) =>
      ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "lacneu",
        agentId: "alice",
        openclawChatId: "oc-second",
      }),
    );
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await expect(
        asOwner(t, userId).mutation(api.send.sendMessage, {
          chatId: second,
          text: "hello",
          clientMessageId: "cm-call-7",
          routedAgent: { instanceName: "lacneu", agentId: "bob" },
        }),
      ).resolves.toBeDefined();
    } finally {
      bridge.restore();
    }
  });

  test("ANOTHER user's live call does not freeze this chat", async () => {
    // The rows are per user and per chat; one person's call must not lock another's
    // conversation.
    const t = convexTest(schema, modules);
    const mine = await seedTwoAgentChat(t);
    const other = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, other.userId).action(api.talk.mintTalkSession, {
        chatId: other.chatId,
      });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await expect(
        asOwner(t, mine.userId).mutation(api.send.sendMessage, {
          chatId: mine.chatId,
          text: "hello",
          clientMessageId: "cm-call-6",
          routedAgent: { instanceName: "lacneu", agentId: "bob" },
        }),
      ).resolves.toBeDefined();
    } finally {
      bridge.restore();
    }
  });
});

describe("every way of switching agent is covered, not just the declared one", () => {
  test("a send that names NO agent is refused too when it would switch", async () => {
    // The optional field is not the route: a client that omits it still goes
    // somewhere — to the chat's binding. Reading only the field let that path
    // through (codex P2). The call here is minted on bob; the chat is bound to
    // alice, so an unnamed send would move off the call.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await expect(
        asOwner(t, userId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-noagent",
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });

  test("a PARTICIPANT cannot switch the agent out from under the owner's call", async () => {
    // Only the owner can mint, but a participant may post in the same chat — and
    // their turn re-keys the very socket the call is bound to. Keying the lookup on
    // the asking user found nothing for them and let it through (codex P1).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const guestId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "user" as const, canonical: "guest" });
      await ctx.db.insert("userAgents", {
        userId: id,
        instanceName: "lacneu",
        agentId: "bob",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
      await ctx.db.insert("chatParticipants", {
        chatId,
        userId: id,
        addedAt: 1,
        addedBy: userId,
      });
      return id;
    });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await expect(
        asOwner(t, guestId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-guest",
          routedAgent: { instanceName: "lacneu", agentId: "bob" },
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });

  test("a participant with NO grant on the chat's bound agent is still refused", async () => {
    // The nastiest shape of the same defect. The chat is bound to Alice; the OWNER
    // minted the call on Bob. A participant granted Bob but NOT Alice sends with no
    // `routedAgent`: resolving as THEM yielded nothing, the rule read "not a switch",
    // and the dispatch then resolved as the OWNER, landed on Alice, and cut Bob's
    // call. The rule now resolves against the chat's owner, which is what the
    // dispatch itself does (codex P1, pass 3).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const guestId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "user" as const, canonical: "guest" });
      // GRANTED BOB ONLY — no grant on alice, the chat's bound agent.
      await ctx.db.insert("userAgents", {
        userId: id,
        instanceName: "lacneu",
        agentId: "bob",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
      await ctx.db.insert("chatParticipants", {
        chatId,
        userId: id,
        addedAt: 1,
        addedBy: userId,
      });
      return id;
    });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      // The OWNER's call is on BOB; the chat itself stays bound to ALICE.
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await expect(
        asOwner(t, guestId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-guest-nogrant",
          // NO routedAgent: the send routes wherever the chat routes — to Alice.
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });

  test("a DIRECT call releases the agent the moment it is hung up", async () => {
    // Its call is the browser's own, so the gateway is owed nothing — but the
    // SERVER still has to stop treating the chat as on a call, or the agent stays
    // frozen for the whole window after the user hung up (codex P1).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(DIRECT_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      const res = await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      // `closed: "closed"` since pass 10: the bridge holds this chat's socket on the
      // direct lane too, so the hangup reaches it here as well.
      expect(res).toMatchObject({ ok: true });
      const row = await t.run((ctx) => ctx.db.get(minted.sessionId));
      expect(row?.endedAt).toEqual(expect.any(Number));
      await expect(
        asOwner(t, userId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-direct-release",
          routedAgent: { instanceName: "lacneu", agentId: "bob" },
        }),
      ).resolves.toBeDefined();
    } finally {
      bridge.restore();
    }
  });

  test("the live call is found however many other chats are on a call", async () => {
    // A bounded scan of the sweep index answered this until 2026-09-19 and could
    // miss the row behind older sessions, silently unfreezing the agent (codex P1).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      await t.run(async (ctx) => {
        for (let i = 0; i < 250; i += 1) {
          const other = await ctx.db.insert("chats", {
            userId,
            updatedAt: 1,
            instanceName: "lacneu",
            agentId: "alice",
          });
          await ctx.db.insert("talkSessions", {
            userId,
            chatId: other,
            instanceName: "lacneu",
            agentId: "alice",
            canonical: "olivier",
            conversation: String(other),
            createdAt: Date.now() - 1000,
            expiresAt: Date.now() + 60_000,
          });
        }
      });
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await expect(
        asOwner(t, userId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-many",
          routedAgent: { instanceName: "lacneu", agentId: "bob" },
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });

  test("the live call is found behind twenty ENDED calls of the SAME chat", async () => {
    // Reading the chat's newest rows and filtering `endedAt` afterwards is a bound on
    // the READ, not on the answer: twenty calls made and hung up since push the live
    // one out of the page and the agent silently unfreezes mid-call (codex P1, pass 2).
    // `endedAt` belongs in the index key, so closed rows cannot crowd out a live one.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      // …then twenty NEWER rows on this very chat, every one of them ended.
      await t.run(async (ctx) => {
        for (let i = 0; i < 20; i += 1) {
          await ctx.db.insert("talkSessions", {
            userId,
            chatId,
            instanceName: "lacneu",
            agentId: "alice",
            canonical: "olivier",
            conversation: String(chatId),
            createdAt: Date.now() + i + 1,
            endedAt: Date.now() + i + 2,
            expiresAt: Date.now() + 60_000,
          });
        }
      });
      await expect(
        asOwner(t, userId).mutation(api.send.sendMessage, {
          chatId,
          text: "hello",
          clientMessageId: "cm-behind-ended",
          routedAgent: { instanceName: "lacneu", agentId: "bob" },
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });

  test("a SECOND mint for another agent is refused, not served", async () => {
    // The composer is greyed out, but a second tab reaches the mint directly — and a
    // mint for another agent re-keys the bridge's one socket for this chat, closing
    // the socket the first call is bound to. The cut the freeze exists to prevent,
    // through the one door that never asked (codex P1, pass 2).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const first = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!first.ok) throw new Error(JSON.stringify(first));
      const second = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      });
      expect(second).toEqual({ ok: false, code: "call_active" });
      // …and the first call is untouched: still live, still Alice's.
      const row = await t.run((ctx) => ctx.db.get(first.sessionId));
      expect(row?.endedAt).toBeUndefined();
      expect(row?.agentId).toBe("alice");
    } finally {
      bridge.restore();
    }
  });

  test("a mint GIVES WAY to a turn already on its way to another agent", async () => {
    // The mirror of the freeze, and the only answer to the cross-bridge race. The
    // send's last check and its POST cannot be one transaction; a call minted in that
    // interval sits on a DIFFERENT bridge process when it is on another instance, and
    // that process knows nothing of the hold — so the socket-in-hand refusal never
    // runs and the turn lands on one agent while the call runs on another (codex P1,
    // pass 17). A `pending` row is exactly "a POST may be in flight right now".
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    // A turn already dispatched to BOB.
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "cm-in-flight",
        text: "hello",
        attachmentIds: [],
        status: "pending" as const,
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      }),
    );
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("the MINT is refused early, with its own code — no session left behind", async () => {
    // The write asks the same question and is where the answer binds, but only after
    // a session has been minted on the gateway and then abandoned, and the caller
    // learns that as the generic "could not record" (codex P3, pass 18). Asking in
    // the prepare spends nothing and lets the reader be told what happened.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "cm-early",
        text: "hello",
        attachmentIds: [],
        status: "pending" as const,
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      }),
    );
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
        routedAgent: { instanceName: "lacneu", agentId: "alice" },
      });
      expect(res).toEqual({ ok: false, code: "turn_in_flight" });
      // …and the gateway was never asked: nothing to abandon.
      expect(bridge.posts).toHaveLength(0);
    } finally {
      bridge.restore();
    }
  });

  test("pressing the button with NO pick calls the agent the turn is going to", async () => {
    // The refusal is for the user who asks for someone ELSE. With no pick the call
    // opens on the agent the in-flight turn is already addressed to, so there is
    // nothing to split and nothing to refuse — a rule that fought the default would
    // make voice unusable for the length of every answer.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "cm-default",
        text: "hello",
        attachmentIds: [],
        status: "pending" as const,
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      }),
    );
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const res = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // …and it really is BOB's call, not the chat's primary.
      expect(
        (await t.run((ctx) => ctx.db.get(res.sessionId)))?.agentId,
      ).toBe("bob");
    } finally {
      bridge.restore();
    }
  });

  test("…and to an answer being WRITTEN, long after the outbox says `sent`", async () => {
    // The outbox stops telling the truth halfway: the bridge answers 200 as soon as
    // the gateway accepts the prompt, so the row flips to `sent` while the run keeps
    // going. Watching only the outbox left the whole streaming half of every turn
    // unguarded — which is most of its life (codex P1, pass 18).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run(async (ctx) => {
      // The send is DONE as far as the outbox is concerned…
      const outboxId = await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "cm-sent",
        text: "hello",
        attachmentIds: [],
        status: "sent" as const,
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      });
      // …and Bob is still writing the answer. SHAPED THE WAY PRODUCTION WRITES IT:
      // `stream.startAssistant` sets no routing fields at all — it links the reply to
      // the send it answers. An earlier version of this test filled those fields in
      // by hand and so proved nothing about the real path (codex, pass 19).
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "thinking…",
        updatedAt: Date.now(),
        dispatchOutboxId: outboxId,
      });
    });
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("…but an answer from the agent we are CALLING is nothing to split", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run(async (ctx) => {
      const outboxId = await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "cm-sent-alice",
        text: "hello",
        attachmentIds: [],
        status: "sent" as const,
        routedAgent: { instanceName: "lacneu", agentId: "alice" },
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "thinking…",
        updatedAt: Date.now(),
        dispatchOutboxId: outboxId,
      });
    });
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).resolves.toBeDefined();
  });

  test("a message typed into ANOTHER agent's sub-agent is refused mid-call", async () => {
    // This door bypassed the freeze entirely: it writes no outbox row and no parent
    // assistant message, so neither the send rule nor the mirror saw it. The bridge
    // cannot catch it either — `/subagent-send` acquires the PARENT's socket, which
    // during a call is already the call's own, so nothing is re-keyed and the hold is
    // never consulted before the child `chat.send` goes out (codex P1, pass 19).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      // A REAL child row: the refusal reads the row's instance, because two gateways
      // can expose the same agent id and the id alone is not an identity.
      await t.run((ctx) =>
        ctx.db.insert("subAgents", {
          chatId,
          userId,
          instanceName: "lacneu",
          childSessionKey: "agent:bob:subagent:abc",
          status: "done" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      await expect(
        asOwner(t, userId).mutation(internal.subAgentInteractions.prepareInteraction, {
          chatId,
          childSessionKey: "agent:bob:subagent:abc",
          userText: "hello",
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });

  test("a message already on its way to a SUB-AGENT blocks the mint too", async () => {
    // `prepareInteraction` refuses one while a call is live — but it writes its row
    // and POSTs afterwards, so a call minted in that gap saw nothing, and
    // `/subagent-send` then acquired the PARENT's socket, which during a call already
    // matches and is never checked against the hold (codex P1, pass 20).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run((ctx) =>
      ctx.db.insert("subAgentInteractions", {
        chatId,
        childSessionKey: "agent:bob:subagent:abc",
        userText: "hello",
        status: "pending" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("the same agent id on another GATEWAY is caught for every shape", async () => {
    // An agent id is not an identity. Each shape must compare the gateway too, from
    // what the row CAPTURED — the interaction's own `instanceName`, the reply's proven
    // `boundInstance` — because the message is already addressed to that gateway
    // whatever the chat resolves to now (codex P1 + P2, pass 21).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const callArgs = {
      chatId,
      instanceName: "lacneu",
      agentId: "alice",
      canonical: "olivier",
      conversation: String(chatId),
    };
    // 1. A message on its way to `alice` on ANOTHER gateway.
    const interaction = await t.run((ctx) =>
      ctx.db.insert("subAgentInteractions", {
        chatId,
        childSessionKey: "agent:alice:subagent:abc",
        instanceName: "other-gateway",
        userText: "hello",
        status: "pending" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, callArgs),
    ).rejects.toThrow(/already on its way to another agent/);
    await t.run((ctx) => ctx.db.delete(interaction));
    // 2. A spontaneous reply proven to be on ANOTHER gateway.
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "…",
        updatedAt: Date.now(),
        boundInstance: "other-gateway",
        turnSessionKey: "agent:alice:atrium:chat:olivier:oc-1",
      }),
    );
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, callArgs),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("a sub-agent send that fails SETTLES its row — it cannot freeze voice forever", async () => {
    // The row is written before the POST, and a `pending` row now refuses calls to
    // other agents as well as holding the panel. So every way out has to settle it:
    // reading the blobs used to sit outside the try, where a failure escaped and left
    // the row pending with no reconciler to clear it (codex P2, pass 21).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    await t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        userId,
        instanceName: "lacneu",
        childSessionKey: "agent:alice:subagent:abc",
        status: "done" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    vi.stubGlobal("fetch", async () => {
      throw new Error("bridge down");
    });
    try {
      const res = await asOwner(t, userId).action(
        api.subAgentInteractions.sendToSubAgent,
        { chatId, childSessionKey: "agent:alice:subagent:abc", text: "hello" },
      );
      expect(res).toMatchObject({ ok: false });
      // NOTHING is left pending: the mirror reads this range on every mint.
      const stuck = await t.run((ctx) =>
        ctx.db
          .query("subAgentInteractions")
          .withIndex("by_chat_status", (q) =>
            q.eq("chatId", chatId).eq("status", "pending"),
          )
          .collect(),
      );
      expect(stuck).toHaveLength(0);
      // …so a call with another agent is possible again.
      await expect(
        asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
          chatId,
          instanceName: "lacneu",
          agentId: "bob",
          canonical: "olivier",
          conversation: String(chatId),
        }),
      ).resolves.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("an interaction is refused when the chat now routes to ANOTHER gateway than the child's", async () => {
    // The freeze vetted the CHILD's identity, but the POST used the PARENT's current
    // routing — which on a per-turn chat can have moved to another instance since the
    // spawn. A guard that validates one destination and sends to another is no guard
    // (codex P1, pass 24). Refused rather than sent wrong: a pre-existing routing
    // defect that this lot turned into a guarantee hole.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        userId,
        instanceName: "other-gateway", // spawned there…
        childSessionKey: "agent:alice:subagent:abc",
        status: "done" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    // …while the chat routes to `lacneu` today.
    await expect(
      asOwner(t, userId).mutation(internal.subAgentInteractions.prepareInteraction, {
        chatId,
        childSessionKey: "agent:alice:subagent:abc",
        userText: "hello",
      }),
    ).rejects.toThrow(/another instance than the chat routes to/);
  });

  test("a child key this code cannot read is refused mid-call — not waved through", async () => {
    // The schema pins the key's shape in prose only (`v.string()`), and the observer
    // accepts any non-empty key. A key the parser cannot read gave `null`, which was
    // read as compatible with whoever is on the line (codex P1, pass 24).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await t.run((ctx) =>
        ctx.db.insert("subAgents", {
          chatId,
          userId,
          instanceName: "lacneu",
          childSessionKey: "agent:bob:subagent-v2:abc", // not the pinned shape
          status: "done" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      await expect(
        asOwner(t, userId).mutation(internal.subAgentInteractions.prepareInteraction, {
          chatId,
          childSessionKey: "agent:bob:subagent-v2:abc",
          userText: "hello",
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });

  test("a spontaneous reply with NO session key blocks — the name is unknown, not the route's", async () => {
    // Old bridges omit `turnSessionKey`. Falling back to the chat's current route read
    // a spontaneous reply from one agent as the route's, which allowed a call with
    // another while it wrote (codex P1, pass 24).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "…",
        updatedAt: Date.now(),
        boundInstance: "lacneu",
        // no dispatchOutboxId, no turnSessionKey: an old bridge's spontaneous turn
      }),
    );
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice", // the chat's own route — which used to pass
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("a LEGACY child with no instance stamp is refused mid-call", async () => {
    // `?? call.instanceName` turned "I was not told" into "it matches", so a legacy
    // child on one gateway could be typed into while the call ran on another under
    // the same agent name — the same fail-open the mirror had, in the other
    // direction (codex P1, pass 23).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await t.run((ctx) =>
        ctx.db.insert("subAgents", {
          chatId,
          userId,
          // NO instanceName: a row from before the stamp existed.
          childSessionKey: "agent:alice:subagent:abc",
          status: "done" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      await expect(
        asOwner(t, userId).mutation(internal.subAgentInteractions.prepareInteraction, {
          chatId,
          childSessionKey: "agent:alice:subagent:abc",
          userText: "hello",
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });

  test("an interaction nothing will answer is REAPED — and frees voice", async () => {
    // A successful POST leaves the row pending on purpose: the child's reply comes
    // back asynchronously, and the bridge holds that correlation in MEMORY. A restart
    // between the two loses it, and nothing else settles the row — which blocks the
    // panel and, since the mirror reads this range, every call to another agent
    // (codex P2, pass 22).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const old = Date.now() - 60 * 60 * 1000;
    await t.run(async (ctx) => {
      await ctx.db.insert("subAgents", {
        chatId,
        userId,
        instanceName: "lacneu",
        childSessionKey: "agent:alice:subagent:abc",
        status: "done" as const,
        createdAt: old,
        updatedAt: old, // …and QUIET: nothing has been heard from it in an hour.
      });
      await ctx.db.insert("subAgentInteractions", {
        chatId,
        childSessionKey: "agent:alice:subagent:abc",
        instanceName: "lacneu",
        userText: "hello",
        status: "pending" as const,
        createdAt: old,
        updatedAt: old,
      });
    });
    expect(
      await t.mutation(internal.subAgentInteractions.reapStalePendingInteractions, {}),
    ).toEqual({ settled: 1 });
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "bob",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).resolves.toBeDefined();
  });

  test("…but a child whose CLOCK is moving keeps its interaction — the work is real", async () => {
    // THE STATE PRODUCTION ACTUALLY PRODUCES. An interaction may only be started on a
    // TERMINAL child, and Convex refuses to move a terminal child back to `running` —
    // so the row stays `done` for the whole interaction even while the child works.
    // A test that inserted a `running` child (the first version of this one) staged a
    // state that cannot occur, and so proved nothing (codex P1, pass 23). Every
    // observer event patches `updatedAt` whether or not the status moves: that is the
    // heartbeat.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const old = Date.now() - 60 * 60 * 1000;
    await t.run(async (ctx) => {
      await ctx.db.insert("subAgents", {
        chatId,
        userId,
        instanceName: "lacneu",
        childSessionKey: "agent:alice:subagent:abc",
        status: "done" as const, // terminal, as it must be to be interacted with…
        createdAt: old,
        updatedAt: Date.now(), // …and its clock is moving: the child is answering.
      });
      await ctx.db.insert("subAgentInteractions", {
        chatId,
        childSessionKey: "agent:alice:subagent:abc",
        instanceName: "lacneu",
        userText: "hello",
        status: "pending" as const,
        createdAt: old,
        updatedAt: old,
      });
    });
    expect(
      await t.mutation(internal.subAgentInteractions.reapStalePendingInteractions, {}),
    ).toEqual({ settled: 0 });
  });

  test("preparing an interaction RECORDS the gateway it resolved to", async () => {
    // The mirror can only compare what the row carries. Asserting on a row this test
    // wrote itself would prove nothing about the production insert — so this one goes
    // through `prepareInteraction` and reads back what it stored (codex P1, pass 21).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        userId,
        instanceName: "lacneu",
        childSessionKey: "agent:alice:subagent:abc",
        status: "done" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const prep = await asOwner(t, userId).mutation(
      internal.subAgentInteractions.prepareInteraction,
      { chatId, childSessionKey: "agent:alice:subagent:abc", userText: "hello" },
    );
    const row = await t.run((ctx) => ctx.db.get(prep.interactionId));
    expect(row?.instanceName).toBe("lacneu");
    // …and it is the instance the action will actually POST to.
    expect(prep.routing.instanceName).toBe(row?.instanceName);
  });

  test("an ABSENT captured field blocks — `undefined` is not agreement", async () => {
    // Rows written before a stamp existed are kept on purpose, and the schema says so.
    // Treating their silence as "same instance" let a call on another gateway through
    // for exactly as long as those rows survive a deployment (codex P1, pass 22).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const callArgs = {
      chatId,
      instanceName: "lacneu",
      agentId: "alice",
      canonical: "olivier",
      conversation: String(chatId),
    };
    // A legacy interaction: same agent name, no instance recorded at all.
    const legacy = await t.run((ctx) =>
      ctx.db.insert("subAgentInteractions", {
        chatId,
        childSessionKey: "agent:alice:subagent:abc",
        userText: "hello",
        status: "pending" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, callArgs),
    ).rejects.toThrow(/already on its way to another agent/);
    await t.run((ctx) => ctx.db.delete(legacy));
    // …and the same for a running child with no instance stamp.
    await t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        userId,
        childSessionKey: "agent:alice:subagent:def",
        status: "running" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, callArgs),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("a streaming reply's CAPTURED route is taken as written too", async () => {
    // The pass-21 fix landed on the pending branch only; the streaming branch still
    // handed the captured agent back to the resolver, so a grant withdrawn mid-stream
    // made the answer `null` and the mirror read "nothing differs" (codex P1, pass 22).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run(async (ctx) => {
      const outboxId = await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "cm-streamed",
        text: "hello",
        attachmentIds: [],
        status: "sent" as const,
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "…",
        updatedAt: Date.now(),
        boundInstance: "lacneu",
        dispatchOutboxId: outboxId,
      });
      // …and Bob's grant goes away WHILE he is writing.
      const grant = await ctx.db
        .query("userAgents")
        .filter((q) => q.eq(q.field("agentId"), "bob"))
        .first();
      if (grant) await ctx.db.delete(grant._id);
    });
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("a dispatch's CAPTURED target is taken as written, grant or no grant", async () => {
    // The dispatch resolves its target once and POSTs that. Re-resolving here against
    // current grants answered a different question: a grant withdrawn mid-flight made
    // the re-resolution return nothing, the mirror read "nothing differs", and the
    // dispatch posted its captured target anyway (codex P1, pass 21).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run(async (ctx) => {
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "cm-captured",
        text: "hello",
        attachmentIds: [],
        status: "pending" as const,
        routedAgent: { instanceName: "lacneu", agentId: "bob" },
      });
      // …and bob's grant is gone, so a re-resolution would answer nothing at all.
      const grant = await ctx.db
        .query("userAgents")
        .filter((q) => q.eq(q.field("agentId"), "bob"))
        .first();
      if (grant) await ctx.db.delete(grant._id);
    });
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("a HARMLESS first sub-agent does not hide a dangerous second", async () => {
    // A chat can hold several running children — the parallel-spawn case the bench
    // exercises. Reading one row answered about an arbitrary one of them, so a child
    // of the agent on the line hid a child of another agent behind it.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run(async (ctx) => {
      for (const [key, agent] of [
        ["agent:alice:subagent:one", "alice"],
        ["agent:bob:subagent:two", "bob"],
      ] as const) {
        void agent;
        await ctx.db.insert("subAgents", {
          chatId,
          userId,
          instanceName: "lacneu",
          childSessionKey: key,
          status: "running" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("a page that comes back FULL blocks — unseen rows are not a green light", async () => {
    // Each shape reads a bounded page. "There may be more I did not look at" is not a
    // reason to let a call start; it is a reason not to. Every child here belongs to
    // the agent being called, so nothing in the page itself objects — only the fact
    // that the page is full does.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i += 1) {
        await ctx.db.insert("subAgents", {
          chatId,
          userId,
          instanceName: "lacneu",
          childSessionKey: `agent:alice:subagent:${i}`,
          status: "running" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("…and a page with room to spare, all of them ours, does not", async () => {
    // The bound must not become a blanket refusal: a chat with a handful of children
    // of the agent being called can still start that call.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run(async (ctx) => {
      for (let i = 0; i < 49; i += 1) {
        await ctx.db.insert("subAgents", {
          chatId,
          userId,
          instanceName: "lacneu",
          childSessionKey: `agent:alice:subagent:${i}`,
          status: "running" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).resolves.toBeDefined();
  });

  test("a SPONTANEOUS turn is read from its own session, not from the primary", async () => {
    // An announce opens on whatever session was actually ACTIVE, and the reply records
    // that as `turnSessionKey`. Reading the absence of a dispatch row as "the chat's
    // primary" let an announce from one agent authorise a call with another, whose
    // acquire then closed the socket that announce was still writing on (codex P2,
    // pass 20).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "…",
        updatedAt: Date.now(),
        // No dispatch row — and the session says BOB, while the chat's primary is ALICE.
        turnSessionKey: "agent:bob:atrium:chat:olivier:oc-1",
      }),
    );
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).rejects.toThrow(/already on its way to another agent/);
  });

  test("the same agent id on ANOTHER gateway is not the same agent", async () => {
    // An agent id is not an identity on its own: two instances can expose the same
    // one. Comparing ids alone would let a child called `alice` on a second gateway
    // be typed into while the call runs on the first gateway's `alice`.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await t.run((ctx) =>
        ctx.db.insert("subAgents", {
          chatId,
          userId,
          instanceName: "other-gateway",
          childSessionKey: "agent:alice:subagent:abc",
          status: "done" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      await expect(
        asOwner(t, userId).mutation(internal.subAgentInteractions.prepareInteraction, {
          chatId,
          childSessionKey: "agent:alice:subagent:abc",
          userText: "hello",
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });

  test("…but a child of the agent ON THE LINE is that agent's own delegate", async () => {
    // Its answer comes back into the same conversation, so there is nothing to split.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await t.run((ctx) =>
        ctx.db.insert("subAgents", {
          chatId,
          userId,
          instanceName: "lacneu",
          childSessionKey: "agent:alice:subagent:abc",
          status: "done" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      await expect(
        asOwner(t, userId).mutation(internal.subAgentInteractions.prepareInteraction, {
          chatId,
          childSessionKey: "agent:alice:subagent:abc",
          userText: "hello",
        }),
      ).resolves.toBeDefined();
    } finally {
      bridge.restore();
    }
  });

  test("…but a turn to the SAME agent is nothing to split", async () => {
    // The refusal is about splitting the conversation, not about being busy: pressing
    // the voice button right after sending to the agent you are about to speak to
    // must work.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "cm-same",
        text: "hello",
        attachmentIds: [],
        status: "pending" as const,
        routedAgent: { instanceName: "lacneu", agentId: "alice" },
      }),
    );
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).resolves.toBeDefined();
  });

  test("the WRITE refuses a concurrent mint the pre-POST read let through", async () => {
    // `prepareTalkSession` refuses from a QUERY, before the POST. The bridge's own
    // reservation closes the race inside ONE bridge process — but two tabs minting on
    // two DIFFERENT instances reach two different bridges, whose registries know
    // nothing of each other (codex P1, pass 6). The chat then carried two live calls
    // and `liveTalkCall` answered with the newest, so typed turns left the person
    // still speaking. `recordTalkSession` is a MUTATION that reads the index range it
    // inserts into, which is where Convex can serialize what no bridge can.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    // Alice's call already exists — as if the other bridge's mint had just landed.
    await t.run((ctx) =>
      ctx.db.insert("talkSessions", {
        userId,
        chatId,
        instanceName: "lacneu",
        agentId: "alice",
        canonical: "olivier",
        conversation: String(chatId),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
    );
    // …and Bob's record arrives anyway, its own pre-POST read having found nothing.
    await expect(
      asOwner(t, userId).mutation(internal.talk.recordTalkSession, {
        chatId,
        instanceName: "lacneu",
        agentId: "bob",
        canonical: "olivier",
        conversation: String(chatId),
      }),
    ).rejects.toThrow(/already active on another agent/);
    // Exactly one live call remains, and it is Alice's.
    const live = await t.run((ctx) =>
      ctx.db
        .query("talkSessions")
        .withIndex("by_chat_live", (q) =>
          q.eq("chatId", chatId).eq("endedAt", undefined),
        )
        .collect(),
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.agentId).toBe("alice");
  });

  test("re-minting the SAME agent is a reconnect, and stays allowed", async () => {
    // The refusal is about SWITCHING, not about minting twice: a browser that lost
    // its connection must be able to open the call again on the same agent.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const first = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!first.ok) throw new Error(JSON.stringify(first));
      const again = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
        routedAgent: { instanceName: "lacneu", agentId: "alice" },
      });
      expect(again.ok).toBe(true);
    } finally {
      bridge.restore();
    }
  });
});

describe("the end of the freeze window is armed at the mint", () => {
  test("every mint schedules its own end, 31 minutes out", async () => {
    // A call that is never hung up (a browser that crashed) stops being live when the
    // window runs out — but only for a query that runs AGAIN. Nothing wrote at that
    // instant, so a held turn waited for an unrelated turn that never came, and the
    // composer's live subscription kept the selector greyed out on a call that ended
    // half an hour ago (codex P1 + P2, pass 3).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      const row = await t.run((ctx) => ctx.db.get(minted.sessionId));
      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      const armed = scheduled.filter((f) =>
        f.name.includes("markTalkSessionEnded"),
      );
      expect(armed).toHaveLength(1);
      // 30 min of call TTL + the 60 s the offer may still be spent in.
      expect(armed[0]?.scheduledTime).toBe((row?.createdAt ?? 0) + 31 * 60 * 1000);
    } finally {
      bridge.restore();
    }
  });
});

describe("a tab can ask whether ITS OWN call is still live", () => {
  test("true while it runs, false the moment anyone ends it", async () => {
    // Keyed on the SESSION, not the chat: a chat-wide answer can predate this tab's
    // own mint, which forced an earlier version to first WATCH its call appear — and
    // a tab that never saw that intermediate state (suspended, reconnecting) could
    // then never react to being hung up from elsewhere, and kept a direct call live
    // while another tab switched agents (codex P1, pass 16).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      expect(
        await asOwner(t, userId).query(api.talk.talkCallLive, {
          sessionId: minted.sessionId,
        }),
      ).toBe(true);
      await t.mutation(internal.talk.markTalkSessionEnded, { sessionId: minted.sessionId });
      expect(
        await asOwner(t, userId).query(api.talk.talkCallLive, {
          sessionId: minted.sessionId,
        }),
      ).toBe(false);
    } finally {
      bridge.restore();
    }
  });

  test("ANOTHER live call on the same chat does not keep ours alive", async () => {
    // The case that separates the two keys. A chat-wide answer says "a call is up"
    // while THIS tab's own session is the one that was ended — so the tab would keep
    // its microphone and its voice model running on a call nobody has any more. Only
    // a session-keyed answer can tell the two apart.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const first = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!first.ok) throw new Error(JSON.stringify(first));
      // A reconnect on the SAME agent — allowed, and it leaves two rows.
      const second = await asOwner(t, userId).action(api.talk.mintTalkSession, {
        chatId,
        routedAgent: { instanceName: "lacneu", agentId: "alice" },
      });
      if (!second.ok) throw new Error(JSON.stringify(second));
      // The FIRST is ended; the chat is still on a call because of the second.
      await t.mutation(internal.talk.markTalkSessionEnded, { sessionId: first.sessionId });
      expect(
        await asOwner(t, userId).query(api.talk.chatCallState, { chatId }),
      ).toMatchObject({ active: true });
      // …and the tab holding the FIRST handle is told its own call is over.
      expect(
        await asOwner(t, userId).query(api.talk.talkCallLive, {
          sessionId: first.sessionId,
        }),
      ).toBe(false);
    } finally {
      bridge.restore();
    }
  });

  test("it answers TRUE for a call that is not ours — a false would cut it", async () => {
    // This answer tears down a live call, so everything unexpected has to keep the
    // call running and let the ordinary paths refuse what must be refused.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const strangerId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "user" as const, canonical: "nobody" });
      return id;
    });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await t.mutation(internal.talk.markTalkSessionEnded, { sessionId: minted.sessionId });
      // Ended — but not THIS caller's to judge, so it must not be told to tear down.
      expect(
        await asOwner(t, strangerId).query(api.talk.talkCallLive, {
          sessionId: minted.sessionId,
        }),
      ).toBe(true);
    } finally {
      bridge.restore();
    }
  });
});

describe("the composer can ask the SERVER whether this chat is on a call", () => {
  test("it answers with the agent on the line, and stops answering at the hangup", async () => {
    // The local flag is this tab's TalkControl: false after a reload, false in a
    // second tab. Without a server reading the selector looked open and every send
    // came back TALK_CALL_ACTIVE — enforced but never explained (codex pass 3).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      expect(
        await asOwner(t, userId).query(api.talk.chatCallState, { chatId }),
      ).toEqual({ active: false });
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      // The SESSION ID rides along: a tab that owns no call — after a reload, or a
      // browser that crashed mid-call — has no other way to END the one the server
      // sees, and a freeze that is visible but not clearable is worse than invisible.
      expect(
        await asOwner(t, userId).query(api.talk.chatCallState, { chatId }),
      ).toEqual({
        active: true,
        instanceName: "lacneu",
        agentId: "alice",
        sessionId: minted.sessionId,
      });
      await asOwner(t, userId).action(api.talk.hangupTalkSession, {
        chatId,
        sessionId: minted.sessionId,
      });
      expect(
        await asOwner(t, userId).query(api.talk.chatCallState, { chatId }),
      ).toEqual({ active: false });
    } finally {
      bridge.restore();
    }
  });

  test("a PARTICIPANT is told too — the freeze refuses their send as well", async () => {
    // Only the owner can START a call, so the button stays owner-only. But the freeze
    // is keyed by chat: answering a participant `{active:false}` left the selector
    // open on the very path the identity fix was written for, and handed them the raw
    // refusal instead of the sentence (codex P2, pass 4).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const guestId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "user" as const, canonical: "guest" });
      await ctx.db.insert("chatParticipants", {
        chatId,
        userId: id,
        addedAt: 1,
        addedBy: userId,
      });
      return id;
    });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      // …WITHOUT the session id: `prepareTalkHangup` authorizes by row ownership and
      // would refuse them, so handing it over rendered a hangup button whose every
      // click failed silently through three retries (codex P2, pass 9).
      expect(
        await asOwner(t, guestId).query(api.talk.chatCallState, { chatId }),
      ).toEqual({ active: true, instanceName: "lacneu", agentId: "alice" });
    } finally {
      bridge.restore();
    }
  });

  test("a STRANGER is told nothing", async () => {
    // The probe is soft on every failure, and "soft" must not become "open": someone
    // who cannot reach the chat learns nothing about it, not even that it is busy.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t);
    const strangerId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "user" as const, canonical: "nobody" });
      return id;
    });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      expect(
        await asOwner(t, strangerId).query(api.talk.chatCallState, { chatId }),
      ).toEqual({ active: false });
    } finally {
      bridge.restore();
    }
  });
});

describe("a rebind is refused while a call is in progress", () => {
  test("moving the whole conversation mid-call is refused, by the same code", async () => {
    // A rebind is the other way to change agent — and a harder one: it moves the
    // conversation itself, leaving the live call addressing a session this chat no
    // longer uses.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedTalkChat(t, { extraAgents: ["bob"] });
    const bridge = stubBridge(RELAYED_BRIDGE_ANSWER);
    try {
      const minted = await asOwner(t, userId).action(api.talk.mintTalkSession, { chatId });
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      await expect(
        asOwner(t, userId).mutation(api.chats.rebindChatAgent, {
          chatId,
          instanceName: "lacneu",
          agentId: "bob",
        }),
      ).rejects.toThrow(/TALK_CALL_ACTIVE/);
    } finally {
      bridge.restore();
    }
  });
});
