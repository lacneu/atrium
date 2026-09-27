/// <reference types="vite/client" />
//
// ADDRESSING BY @MENTION in a multi-agent room — the server's half.
//
// The agents a message is for are the agents it mentions, in the order of their
// tokens; each answers in turn (a CHAIN: one outbox row per agent, the head
// dispatched or queued as usual, the rest queued behind it). A message that
// mentions none goes to the PRIMARY — routed as a turn like any other on a
// per-turn routed chat, so the primary is re-hydrated when another agent spoke
// last. Pinned here: validation (room, grants, cap, guests), the chain's rows and
// their order, what withdraws it (cancel, Stop) and what does not stop it (a
// failed reply), the queue's bound, the reply attribution, the chained prompt
// (the question once, the earlier replies after it), and the ingest barrier.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { CHAIN_SETTLE_WAIT_MS, MAX_QUEUED_PER_CHAT } from "./lib/outboxQueue";
import { MAX_ADDRESSED_AGENTS } from "./lib/agentMentions";
import { chatAllowsInstance } from "./lib/ingestAuthz";
import { REHYDRATION_STRINGS } from "./lib/rehydration";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

// The dispatch sendMessage schedules must not run on its own: every transition is
// driven explicitly below.
beforeEach(() => {
  vi.useFakeTimers();
});
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

async function seedAgent(t: T, instanceName: string, agentId: string, displayName = agentId) {
  await t.run(async (ctx) => {
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    if (instance === null) {
      await ctx.db.insert("instances", { name: instanceName, gatewayUrl: "ws://gw" });
    }
    await ctx.db.insert("agents", {
      instanceName,
      agentId,
      displayName,
      enabled: true,
      source: "discovered" as const,
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
  });
}

const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: userId });

const alice = { instanceName: "alpha", agentId: "alice" }; // the primary
const bob = { instanceName: "alpha", agentId: "bob" };
const nova = { instanceName: "alpha", agentId: "nova" };
const carol = { instanceName: "alpha", agentId: "carol" }; // never in the room

/** An owner's chat bound to alpha/alice, with bob and nova added (carol exists, outside). */
async function room(t: T, fields: Partial<Doc<"chats">> = {}) {
  const owner = await seedUser(t, "owner");
  await seedAgent(t, "alpha", "alice", "Alice");
  await seedAgent(t, "alpha", "bob", "Bob");
  await seedAgent(t, "alpha", "nova", "Nova");
  await seedAgent(t, "alpha", "carol", "Carol");
  const chatId = await t.run(async (ctx) =>
    ctx.db.insert("chats", {
      userId: owner,
      updatedAt: 1,
      instanceName: "alpha",
      agentId: "alice",
      ...fields,
    }),
  );
  for (const agent of [bob, nova]) {
    await as(t, owner).mutation(api.chatAgents.addChatAgent, { chatId, ...agent });
  }
  return { owner, chatId };
}

/** `@Name` tokens placed in `text`, as the composer resolves them. */
function spans(text: string, agents: Array<[string, { instanceName: string; agentId: string }]>) {
  return agents.map(([token, agent]) => {
    const start = text.indexOf(token);
    return { ...agent, start, end: start + token.length };
  });
}

async function rowsOf(t: T, messageId: Id<"messages">) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("outbox")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect(),
  );
  return rows.sort((a, b) => (a.chainStep ?? 0) - (b.chainStep ?? 0));
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

describe("sendMessage — the agents a message mentions are the agents it is for", () => {
  test("one mention: the turn is routed to it, and the message records the address", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob peux-tu regarder ?";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [["@Bob", bob]]),
    });
    const message = (await t.run((ctx) => ctx.db.get(messageId!)))!;
    expect({ i: message.routedInstanceName, a: message.routedAgentId }).toEqual({
      i: "alpha",
      a: "bob",
    });
    expect(message.addressedAgents).toEqual([{ ...bob, start: 0, end: 4 }]);
    // Routing only: an agent is never forwarded as a human mention.
    expect(message.mentions).toBeUndefined();
    const rows = await rowsOf(t, messageId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", routedAgent: bob });
    expect(rows[0]!.chainStep).toBeUndefined();
    expect(rows[0]!.mentions).toBeUndefined();
  });

  test("several mentions: one row per agent, in TEXT order, the tail queued behind the head", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Nova puis @Alice puis @Bob : qu'en pensez-vous ?";
    const { messageId, outboxId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Nova", nova],
        ["@Alice", alice],
        ["@Bob", bob],
      ]),
    });
    const rows = await rowsOf(t, messageId!);
    expect(rows.map((r) => [r.routedAgent?.agentId, r.status, r.chainStep])).toEqual([
      ["nova", "pending", undefined],
      ["alice", "queued", 1],
      ["bob", "queued", 2],
    ]);
    expect(rows[0]!._id).toBe(outboxId);
    // Distinct idempotency keys, all the same words.
    expect(new Set(rows.map((r) => r.clientMessageId)).size).toBe(3);
    expect(rows.every((r) => r.text === text)).toBe(true);
    // The message is stamped with the FIRST agent; the order is on the message.
    const message = (await t.run((ctx) => ctx.db.get(messageId!)))!;
    expect(message.routedAgentId).toBe("nova");
    expect(message.addressedAgents?.map((a) => a.agentId)).toEqual(["nova", "alice", "bob"]);
    // A retried send returns the head and writes nothing more.
    const again = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Nova", nova],
        ["@Alice", alice],
        ["@Bob", bob],
      ]),
    });
    expect(again).toMatchObject({ deduped: true, outboxId });
    expect(await rowsOf(t, messageId!)).toHaveLength(3);
  });

  test("the thread's view: the question is IN the conversation, not in the queue dock", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob et @Nova ?";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    const view = await as(t, owner).query(api.messages.listByChat, { chatId: chatId as string });
    const mine = view.find((m) => m._id === messageId)!;
    // The head's lifecycle, never the queued chained row's.
    expect(mine.outbox?.status).toBe("pending");
    // Both addressed agents are highlighted like mentions, by name, in text order.
    expect(mine.mentions).toEqual([
      { start: 0, end: 4, name: "Bob", isViewer: false, isAgent: true },
      { start: 8, end: 13, name: "Nova", isViewer: false, isAgent: true },
    ]);
  });

  test("an agent OUTSIDE the room is refused — for the owner too", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob et @Carol";
    await expect(
      as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text,
        clientMessageId: "c1",
        agentMentions: spans(text, [
          ["@Bob", bob],
          ["@Carol", carol],
        ]),
      }),
    ).rejects.toThrow(/agent is not part of this conversation/);
    expect(await t.run((ctx) => ctx.db.query("outbox").collect())).toEqual([]);
  });

  test("an agent of the room the owner may no longer use is refused (grants)", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    // A group now grants the owner alice and bob only.
    await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("groups", { key: "g", name: "g", createdBy: owner, createdAt: 1 });
      await ctx.db.insert("groupAgents", { groupId, ...alice, createdAt: 1 });
      await ctx.db.insert("groupAgents", { groupId, ...bob, createdAt: 1 });
      await ctx.db.insert("groupMembers", { groupId, userId: owner, joinedAt: 1 });
    });
    const text = "@Bob et @Nova";
    await expect(
      as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text,
        clientMessageId: "c1",
        agentMentions: spans(text, [
          ["@Bob", bob],
          ["@Nova", nova],
        ]),
      }),
    ).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("outbox").collect())).toEqual([]);
  });

  test("more agents than one message may chain is refused with a clear code", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const agents = Array.from({ length: MAX_ADDRESSED_AGENTS + 1 }, (_, i) => ({
      instanceName: "alpha",
      agentId: `a${i}`,
    }));
    const text = agents.map((a) => `@${a.agentId}`).join(" ");
    await expect(
      as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text,
        clientMessageId: "c1",
        agentMentions: spans(
          text,
          agents.map((a) => [`@${a.agentId}`, a] as [string, typeof a]),
        ),
      }),
    ).rejects.toThrow(/agent_mentions_invalid:too_many_agents/);
  });

  test("the same agent twice, or spans colliding with a person's, are refused", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const twice = "@Bob puis @Bob2";
    await expect(
      as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text: twice,
        clientMessageId: "c1",
        agentMentions: [
          { ...bob, start: 0, end: 4 },
          { ...bob, start: 10, end: 15 },
        ],
      }),
    ).rejects.toThrow(/agent_mentions_invalid:duplicate_agent/);
    const text = "@Bob salut";
    await expect(
      as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text,
        clientMessageId: "c2",
        agentMentions: [{ ...bob, start: 0, end: 4 }],
        mentions: [{ userId: owner, start: 0, end: 4 }],
      }),
    ).rejects.toThrow(/agent_mentions_invalid:overlapping/);
  });

  test("a GUEST addresses the room's agents, on the owner's delegation — and nothing else", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const guest = await seedUser(t, "guest");
    await t.run((ctx) =>
      ctx.db.insert("chatParticipants", { chatId, userId: guest, addedBy: owner, addedAt: 1 }),
    );
    const text = "@Bob et @Nova";
    const { messageId } = await as(t, guest).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "g1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    const rows = await rowsOf(t, messageId!);
    expect(rows.map((r) => r.routedAgent?.agentId)).toEqual(["bob", "nova"]);
    // Each row has its own gateway idempotency key, the guest's.
    expect(rows.map((r) => r.dispatchKey)).toEqual([
      `participant-${String(guest)}-g1`,
      `participant-${String(guest)}-g1:chain:1`,
    ]);
    const outside = "@Carol";
    await expect(
      as(t, guest).mutation(api.send.sendMessage, {
        chatId,
        text: outside,
        clientMessageId: "g2",
        agentMentions: spans(outside, [["@Carol", carol]]),
      }),
    ).rejects.toThrow(/agent is not part of this conversation/);
  });

  test("a chain counts against the queue bound, every reply after the first included", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    // Idle chat, the queue one place short of full: a 2-agent chain needs ONE place.
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_QUEUED_PER_CHAT - 1; i++) {
        await ctx.db.insert("outbox", {
          chatId,
          userId: owner,
          clientMessageId: `q${i}`,
          text: "x",
          attachmentIds: [],
          status: "queued",
        });
      }
    });
    const two = "@Bob @Nova";
    // The queue is not empty, so the head queues too: two places, one left.
    await expect(
      as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text: two,
        clientMessageId: "c1",
        agentMentions: spans(two, [
          ["@Bob", bob],
          ["@Nova", nova],
        ]),
      }),
    ).rejects.toThrow(/QUEUE_FULL/);
    const one = "@Bob";
    await expect(
      as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text: one,
        clientMessageId: "c2",
        agentMentions: spans(one, [["@Bob", bob]]),
      }),
    ).resolves.toMatchObject({ deduped: false });
  });
});

// Codex pass 8 (2026-09-26), P3. A chained row's idempotency key is DERIVED from the
// client's (`<key>:chain:<n>`): a client choosing that very string as the key of a new
// send found the internal row and was handed an old message as its "duplicate".
describe("the client's idempotency keys and the chain's are apart", () => {
  test("a key in the chain's namespace is refused, not taken for a duplicate", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova";
    const first = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "foo",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    await expect(
      as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text: "une toute autre question",
        clientMessageId: "foo:chain:1",
      }),
    ).rejects.toThrow(/clientMessageId/);
    // The real retry of the original send is still recognised.
    await expect(
      as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text,
        clientMessageId: "foo",
        agentMentions: spans(text, [
          ["@Bob", bob],
          ["@Nova", nova],
        ]),
      }),
    ).resolves.toMatchObject({ deduped: true, messageId: first.messageId });
  });
});

describe("the chain runs in order, and continues past a failed reply", () => {
  test("a failed reply drains the next agent; the question stays where it was", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    const before = (await t.run((ctx) => ctx.db.get(messageId!)))!;
    const [head, second] = await rowsOf(t, messageId!);
    await t.mutation(internal.bridge.failDispatch, { outboxId: head!._id, reason: "send_failed" });
    const after = await rowsOf(t, messageId!);
    expect(after.map((r) => r.status)).toEqual(["failed", "pending"]);
    // A chained row shares the head's message: the drain does not move it below the
    // replies (no orderTime re-stamp).
    const moved = (await t.run((ctx) => ctx.db.get(messageId!)))!;
    expect(moved.orderTime).toBe(before.orderTime);
    // The head's failure card inherits the turn's agent (bob); a failure of the
    // chained reply is signed with ITS agent.
    await t.mutation(internal.bridge.failDispatch, { outboxId: second!._id, reason: "send_failed" });
    const cards = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect(),
    );
    const errors = cards.filter((m) => m.role === "assistant" && m.status === "error");
    expect(errors.map((m) => m.routedAgentId)).toEqual([undefined, "nova"]);
  });

  test("a chained reply opens as ITS agent's message", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    const [head, second] = await rowsOf(t, messageId!);
    const headReply = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "r1",
      dispatchOutboxId: head!._id,
    });
    const chainedReply = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "r2",
      dispatchOutboxId: second!._id,
    });
    const [h, c] = await t.run(async (ctx) => [
      await ctx.db.get(headReply!),
      await ctx.db.get(chainedReply!),
    ]);
    // The head's reply inherits the question's stamp (bob), unchanged.
    expect(h?.routedAgentId).toBeUndefined();
    expect({ i: c?.routedInstanceName, a: c?.routedAgentId }).toEqual({ i: "alpha", a: "nova" });
  });
});

// Codex pass 8 (2026-09-26), P2. A chain step whose agent YIELDED to a sub-agent has
// not answered yet: its conclusion comes in the requester-settle continuation, AFTER the
// child ends. Released by the child's end alone, the next agent was asked without it.
describe("the next agent waits for a yielded step's conclusion", () => {
  async function yieldedStep(t: T) {
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    const [head, second] = await rowsOf(t, messageId!);
    const replyId = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "r1",
      dispatchOutboxId: head!._id,
    });
    const childId = await t.run(async (ctx) => {
      await ctx.db.patch(replyId!, { status: "complete", text: "je délègue", finalizedAt: Date.now() });
      for (const live of await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", replyId!))
        .collect()) {
        await ctx.db.delete(live._id);
      }
      await ctx.db.patch(head!._id, { status: "sent" });
      await ctx.db.insert("messageParts", {
        messageId: replyId!,
        order: 0,
        part: {
          kind: "tool" as const,
          name: "sessions_yield",
          phase: "completed",
          input: {},
          output: { details: { status: "yielded" } },
        },
      });
      return await ctx.db.insert("subAgents", {
        chatId,
        userId: owner,
        parentMessageId: replyId!,
        childSessionKey: "agent:bob:subagent:child-1",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    // The child ends: its terminal releases the queue.
    const endChild = async () => {
      await t.run((ctx) => ctx.db.patch(childId, { status: "done", updatedAt: Date.now() }));
      await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId });
    };
    return { chatId, replyId: replyId!, second: second!, endChild };
  }
  const statusOf = (t: T, id: Id<"outbox">) => t.run(async (ctx) => (await ctx.db.get(id))?.status);

  test("the child ended, the continuation has not come: nova waits", async () => {
    const t = convexTest(schema, modules);
    const { second, endChild } = await yieldedStep(t);
    await endChild();
    expect(await statusOf(t, second._id)).toBe("queued");
  });

  test("the continuation merged and settled: nova goes, asked with the conclusion", async () => {
    const t = convexTest(schema, modules);
    const { chatId, replyId, second, endChild } = await yieldedStep(t);
    await endChild();
    await t.run((ctx) =>
      ctx.db.patch(replyId, {
        text: "je délègue\n\nCONCLUSION",
        continuations: [{ at: 12, childRunIds: ["run-1"] }],
      }),
    );
    await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId });
    expect(await statusOf(t, second._id)).toBe("pending");
    expect(await t.query(internal.bridge.chainedPrompt, { outboxId: second._id })).toContain(
      "CONCLUSION",
    );
  });

  test("a continuation that never comes does not hold the chain for ever", async () => {
    const t = convexTest(schema, modules);
    const { second, endChild } = await yieldedStep(t);
    await endChild();
    expect(await statusOf(t, second._id)).toBe("queued");
    // The held drain is re-armed for the end of the wait, and then lets nova go.
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const rearm = scheduled.find(
      (f) => f.name.includes("drainAfterCallRefusal") && f.state.kind === "pending",
    );
    expect(rearm).toBeDefined();
    vi.setSystemTime(Date.now() + CHAIN_SETTLE_WAIT_MS + 1_000);
    await t.mutation(internal.bridge.drainAfterCallRefusal, {
      chatId: (rearm!.args[0] as { chatId: Id<"chats"> }).chatId,
    });
    expect(await statusOf(t, second._id)).toBe("pending");
  });
});

// Codex pass 14 (2026-09-26), P2. Every regenerate adds rows to the question and keeps
// the old ones: the earlier steps of the CURRENT chain must be found whatever the number
// of rows before them — never among the question's oldest rows only.
describe("a chain regenerated many times still finds its earlier steps", () => {
  async function manyGenerations(t: T, opts: { yielded: boolean }) {
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    // Thirty rows of earlier generations (their replies deleted with the regenerates).
    await t.run(async (ctx) => {
      for (const r of await ctx.db
        .query("outbox")
        .withIndex("by_message", (q) => q.eq("messageId", messageId!))
        .collect()) {
        await ctx.db.patch(r._id, { status: "sent" });
      }
      for (let g = 0; g < 15; g++) {
        for (const [agent, step] of [
          [bob, undefined],
          [nova, 1],
        ] as const) {
          await ctx.db.insert("outbox", {
            chatId,
            userId: owner,
            clientMessageId: `regen-old-${g}${step === undefined ? "" : `:chain:${step}`}`,
            messageId: messageId!,
            text,
            attachmentIds: [],
            status: "sent",
            routedAgent: agent,
            ...(step === undefined ? {} : { chainStep: step }),
          });
        }
      }
    });
    // The CURRENT generation: bob answered it, nova waits.
    const head = await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "regen-new",
        messageId: messageId!,
        text,
        attachmentIds: [],
        status: "pending",
        pendingSince: Date.now(),
        routedAgent: bob,
      }),
    );
    const second = await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "regen-new:chain:1",
        messageId: messageId!,
        text,
        attachmentIds: [],
        status: "queued",
        routedAgent: nova,
        chainStep: 1,
      }),
    );
    const replyId = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "r-new",
      dispatchOutboxId: head,
    });
    const childId = await t.run(async (ctx) => {
      await ctx.db.patch(replyId!, { status: "complete", text: "BOB-NEWEST", finalizedAt: Date.now() });
      for (const live of await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", replyId!))
        .collect()) {
        await ctx.db.delete(live._id);
      }
      await ctx.db.patch(head, { status: "sent" });
      if (!opts.yielded) return null;
      await ctx.db.insert("messageParts", {
        messageId: replyId!,
        order: 0,
        part: {
          kind: "tool" as const,
          name: "sessions_yield",
          phase: "completed",
          input: {},
          output: { details: { status: "yielded" } },
        },
      });
      return await ctx.db.insert("subAgents", {
        chatId,
        userId: owner,
        parentMessageId: replyId!,
        childSessionKey: "agent:bob:subagent:child-9",
        status: "done",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    void childId;
    return { chatId, second };
  }

  test("the next agent is asked with the current generation's earlier reply", async () => {
    const t = convexTest(schema, modules);
    const { second } = await manyGenerations(t, { yielded: false });
    await t.run((ctx) => ctx.db.patch(second, { status: "pending" }));
    expect(await t.query(internal.bridge.chainedPrompt, { outboxId: second })).toContain(
      "BOB-NEWEST",
    );
  });

  test("the hold still sees a yielded step of the current generation", async () => {
    const t = convexTest(schema, modules);
    const { chatId, second } = await manyGenerations(t, { yielded: true });
    await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId });
    expect((await t.run((ctx) => ctx.db.get(second)))?.status).toBe("queued");
  });
});

describe("what withdraws the chain", () => {
  test("cancelling the queued message withdraws every reply it was waiting for", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    // A turn in flight: the whole message queues.
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "busy",
        text: "x",
        attachmentIds: [],
        status: "pending",
      }),
    );
    const text = "@Bob puis @Nova";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    expect((await rowsOf(t, messageId!)).map((r) => r.status)).toEqual(["queued", "queued"]);
    await as(t, owner).mutation(api.send.cancelQueuedMessage, { messageId: messageId! });
    expect(await rowsOf(t, messageId!)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(messageId!))).toBeNull();
  });

  test("once the head is in flight, the message is in the conversation: not cancellable from the dock", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    await expect(
      as(t, owner).mutation(api.send.cancelQueuedMessage, { messageId: messageId! }),
    ).rejects.toThrow(/QUEUE_ALREADY_DISPATCHED/);
    expect(await rowsOf(t, messageId!)).toHaveLength(2);
    expect(await t.run((ctx) => ctx.db.get(messageId!))).not.toBeNull();
  });

  test("deleting the message withdraws the rest of its chain", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    await as(t, owner).mutation(api.messages.deleteMessage, { messageId: messageId! });
    const left = await rowsOf(t, messageId!);
    expect(left.filter((r) => r.status === "queued" || r.status === "pending")).toEqual([]);
  });

  test("Stop ends the chain, and the kill goes to the agent actually answering", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova puis @Alice";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
        ["@Alice", alice],
      ]),
    });
    const [head, second] = await rowsOf(t, messageId!);
    // Bob answered; nova's turn is streaming — alice still waits.
    await t.run((ctx) => ctx.db.patch(head!._id, { status: "sent" }));
    await t.run((ctx) => ctx.db.patch(second!._id, { status: "sent" }));
    await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "r2",
      dispatchOutboxId: second!._id,
    });
    await as(t, owner).mutation(api.messages.abortTurn, { chatId });
    const rows = await rowsOf(t, messageId!);
    expect(rows.map((r) => r.routedAgent?.agentId)).toEqual(["bob", "nova"]);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const abort = scheduled.find((s) => s.name.includes("dispatchAbort"));
    expect((abort?.args[0] as { routedAgent?: unknown })?.routedAgent).toEqual(nova);
  });

  test("Stop while the first agent waits on its sub-agent: the rest of the chain is withdrawn, other sends still go", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    const [head, second] = await rowsOf(t, messageId!);
    // Bob answered and YIELDED to a sub-agent: his turn settled, the child runs and
    // holds the chat — nova's reply waits in the queue.
    const replyId = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "r1",
      dispatchOutboxId: head!._id,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(replyId!, { status: "complete", text: "je délègue" });
      for (const row of await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", replyId!))
        .collect()) {
        await ctx.db.delete(row._id);
      }
      await ctx.db.patch(head!._id, { status: "sent" });
      await ctx.db.insert("subAgents", {
        chatId,
        userId: owner,
        parentMessageId: replyId!,
        childSessionKey: "agent:bob:subagent:child-1",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    // Another message, sent meanwhile: it queues behind the chain.
    const { outboxId: later } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text: "et autre chose",
      clientMessageId: "c2",
    });
    await as(t, owner).mutation(api.messages.abortTurn, { chatId });
    // Nova is not asked: the chain the user stopped is withdrawn…
    expect(await t.run((ctx) => ctx.db.get(second!._id))).toBeNull();
    // …and the other message is the one that goes.
    expect((await t.run((ctx) => ctx.db.get(later)))?.status).toBe("pending");
  });

  test("Stop in the window between a chain step's promotion and its send: withdrawn; once sent, left alone", async () => {
    for (const passedGate of [false, true]) {
      const t = convexTest(schema, modules);
      const { owner, chatId } = await room(t);
      const text = "@Bob puis @Nova puis @Alice";
      const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text,
        clientMessageId: "c1",
        agentMentions: spans(text, [
          ["@Bob", bob],
          ["@Nova", nova],
          ["@Alice", alice],
        ]),
      });
      const [head, second, third] = await rowsOf(t, messageId!);
      // Bob answered and his turn settled: the drain promotes nova's step, whose
      // dispatch waits out the drain delay — nothing streams yet.
      await t.run((ctx) => ctx.db.patch(head!._id, { status: "sent" }));
      await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId });
      expect((await t.run((ctx) => ctx.db.get(second!._id)))?.status).toBe("pending");
      if (passedGate) {
        await t.mutation(internal.bridge.lastGateBeforeSend, { outboxId: second!._id, target: nova });
      }
      const res = await as(t, owner).mutation(api.messages.abortTurn, { chatId });
      if (!passedGate) {
        // Not sent: withdrawn with the rest of the chain, and Stop says it stopped.
        expect(res.ok).toBe(true);
        expect(await t.run((ctx) => ctx.db.get(second!._id))).toBeNull();
        expect(await t.run((ctx) => ctx.db.get(third!._id))).toBeNull();
      } else {
        // Its POST left: never deleted under it (the reply's own abort path stops it).
        expect((await t.run((ctx) => ctx.db.get(second!._id)))?.status).toBe("pending");
      }
    }
  });

  test("editing a queued message may not change who it is for", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "busy",
        text: "x",
        attachmentIds: [],
        status: "pending",
      }),
    );
    const text = "@Bob puis @Nova";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    await expect(
      as(t, owner).mutation(api.send.updateQueuedMessage, { messageId: messageId!, text: "@Bob seul" }),
    ).rejects.toThrow(/QUEUE_ADDRESSEES_CHANGED/);
    await expect(
      as(t, owner).mutation(api.send.updateQueuedMessage, {
        messageId: messageId!,
        text: "@Nova puis @Bob",
      }),
    ).rejects.toThrow(/QUEUE_ADDRESSEES_CHANGED/);
    // The same agents, in the same order: the words change, on every row.
    await as(t, owner).mutation(api.send.updateQueuedMessage, {
      messageId: messageId!,
      text: "Alors @Bob, puis @Nova ?",
    });
    const rows = await rowsOf(t, messageId!);
    expect(rows.map((r) => r.text)).toEqual(["Alors @Bob, puis @Nova ?", "Alors @Bob, puis @Nova ?"]);
    const message = (await t.run((ctx) => ctx.db.get(messageId!)))!;
    expect(message.addressedAgents).toEqual([
      { ...bob, start: 6, end: 10 },
      { ...nova, start: 17, end: 22 },
    ]);
  });
});

// Codex pass 8 (2026-09-26), P2. Regenerating a CHAINED reply re-runs the chain from
// that reply's agent on: its own step again, and every agent after it — each as the
// original send made them (one row per agent, the rest queued behind the first).
describe("regenerating a chained reply re-runs the chain from its agent", () => {
  async function answeredChain(t: T) {
    const { owner, chatId } = await room(t, { perTurnRouting: true });
    const text = "@Bob puis @Nova : quel est le plan ?";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    const [head, second] = await rowsOf(t, messageId!);
    const replies: Id<"messages">[] = [];
    for (const [row, runId, body] of [
      [head!, "r1", "BOB-A"],
      [second!, "r2", "NOVA-B"],
    ] as const) {
      await t.run((ctx) => ctx.db.patch(row._id, { status: "pending" }));
      const id = await t.mutation(internal.stream.startAssistant, {
        chatId,
        runId,
        dispatchOutboxId: row._id,
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(id!, { status: "complete", text: body });
        for (const live of await ctx.db
          .query("streamingText")
          .withIndex("by_message", (q) => q.eq("messageId", id!))
          .collect()) {
          await ctx.db.delete(live._id);
        }
        await ctx.db.patch(row._id, { status: "sent" });
      });
      replies.push(id!);
    }
    return { owner, chatId, messageId: messageId!, bobReply: replies[0]!, novaReply: replies[1]! };
  }
  const live = async (t: T, messageId: Id<"messages">) =>
    (await rowsOf(t, messageId)).filter((r) => r.status === "pending" || r.status === "queued");

  test("the SECOND reply: nova answers again, as the chain's step, after bob's kept answer", async () => {
    const t = convexTest(schema, modules);
    const { owner, messageId, novaReply } = await answeredChain(t);
    await as(t, owner).mutation(api.messages.deleteMessage, { messageId: novaReply });
    const rows = await live(t, messageId);
    expect(rows.map((r) => [r.routedAgent?.agentId, r.status, r.chainStep])).toEqual([
      ["nova", "pending", 1],
    ]);
    // Asked with bob's answer, which the reader kept.
    expect(await t.query(internal.bridge.chainedPrompt, { outboxId: rows[0]!._id })).toContain(
      "BOB-A",
    );
  });

  // Codex pass 9 (2026-09-26), P2: a step refused BEFORE it streamed has only the card
  // failDispatch writes — it must lead back to its step like a reply does.
  test("a step whose send FAILED after bob answered: deleting its card asks nova again", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId, messageId, novaReply } = await answeredChain(t);
    // Replay nova's step as a failed send instead of an answer.
    await as(t, owner).mutation(api.messages.deleteMessage, { messageId: novaReply });
    const [retry] = await live(t, messageId);
    await t.mutation(internal.bridge.failDispatch, { outboxId: retry!._id, reason: "send_failed" });
    const card = (
      await t.run((ctx) =>
        ctx.db
          .query("messages")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect(),
      )
    ).find((m) => m.role === "assistant" && m.status === "error")!;
    expect(card.routedAgentId).toBe("nova");
    await as(t, owner).mutation(api.messages.deleteMessage, { messageId: card._id });
    const rows = await live(t, messageId);
    expect(rows.map((r) => [r.routedAgent?.agentId, r.status, r.chainStep])).toEqual([
      ["nova", "pending", 1],
    ]);
  });

  test("nova left the room: regenerating its refused step is refused again, visibly", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId, messageId, novaReply } = await answeredChain(t);
    await as(t, owner).mutation(api.messages.deleteMessage, { messageId: novaReply });
    const [retry] = await live(t, messageId);
    await as(t, owner).mutation(api.chatAgents.removeChatAgent, { chatId, ...nova });
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatchReset, {
        chatId,
        userId: owner,
        regenerateOutboxId: retry!._id,
        routedAgent: nova,
      });
      const cards = async () =>
        (
          await t.run((ctx) =>
            ctx.db
              .query("messages")
              .withIndex("by_chat", (q) => q.eq("chatId", chatId))
              .collect(),
          )
        ).filter((m) => m.role === "assistant" && m.status === "error");
      const [card] = await cards();
      expect(card?.errorCode).toBe("AGENT_LEFT_ROOM");
      await as(t, owner).mutation(api.messages.deleteMessage, { messageId: card!._id });
      const [again] = await live(t, messageId);
      expect(again?.routedAgent?.agentId).toBe("nova");
      await t.action(internal.bridge.dispatchReset, {
        chatId,
        userId: owner,
        regenerateOutboxId: again!._id,
        routedAgent: nova,
      });
      // Refused before any reset or send, with the same clear card.
      expect(bridge.calls).toEqual([]);
      expect((await cards()).map((c) => c.errorCode)).toEqual(["AGENT_LEFT_ROOM"]);
    } finally {
      bridge.restore();
    }
  });

  test("the FIRST reply: bob answers again, then nova — the whole chain", async () => {
    const t = convexTest(schema, modules);
    const { owner, messageId, bobReply } = await answeredChain(t);
    await as(t, owner).mutation(api.messages.deleteMessage, { messageId: bobReply });
    const rows = await live(t, messageId);
    expect(rows.map((r) => [r.routedAgent?.agentId, r.status, r.chainStep])).toEqual([
      ["bob", "pending", undefined],
      ["nova", "queued", 1],
    ]);
  });
});

describe("a chained reply is asked the question once, with the earlier answers", () => {
  test("the prompt: the question, then bob's reply — and the history holds neither", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t, { perTurnRouting: true });
    const text = "@Bob puis @Nova : quel est le plan ?";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    const [head, second] = await rowsOf(t, messageId!);
    // Bob's reply, dispatched from the head row, complete.
    const replyId = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "r1",
      dispatchOutboxId: head!._id,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(replyId!, { status: "complete", text: "BOB-SAYS-PLAN-A" });
      const live = await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", replyId!))
        .collect();
      for (const row of live) await ctx.db.delete(row._id);
      await ctx.db.patch(head!._id, { status: "sent" });
      await ctx.db.patch(second!._id, { status: "pending" });
    });
    const prompt = await t.query(internal.bridge.chainedPrompt, { outboxId: second!._id });
    const FR = REHYDRATION_STRINGS.fr;
    expect(prompt).toBe(
      [text, "", FR.chainIntro, `${FR.assistantLabel} (Bob) : BOB-SAYS-PLAN-A`, FR.chainOutro].join(
        "\n",
      ),
    );
    // The history the bridge prepends excludes the question AND what follows it:
    // nothing is handed twice.
    const history = await t.query(internal.stream.rehydrationContext, {
      chatId,
      excludeMessageId: messageId!,
    });
    expect(history.history ?? "").not.toContain("quel est le plan");
    expect(history.history ?? "").not.toContain("BOB-SAYS-PLAN-A");
    // The head row itself is not a chain step: sent as is.
    expect(await t.query(internal.bridge.chainedPrompt, { outboxId: head!._id })).toBeNull();

    // …and that prompt is what the dispatch sends, to nova, on its own session.
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatch, { outboxId: second!._id });
      const send = bridge.calls.find((c) => c.url.endsWith("/send"));
      expect(send?.body).toMatchObject({ agentId: "nova", text: prompt });
      expect(String(send?.body.text).split("quel est le plan").length - 1).toBe(1);
      expect(send?.body.mentions).toBeUndefined();
    } finally {
      bridge.restore();
    }
  });

  test("the first agent failed: the next one is asked the bare question", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
      ]),
    });
    const [head, second] = await rowsOf(t, messageId!);
    await t.mutation(internal.bridge.failDispatch, { outboxId: head!._id, reason: "send_failed" });
    expect(await t.query(internal.bridge.chainedPrompt, { outboxId: second!._id })).toBe(text);
  });
});

// Codex pass 4 (2026-09-26), P2. Only a COMPLETE reply is an answer already given —
// the rule the rehydration applies to every history line (rehydrationContext keeps
// `status === "complete"` only). A reply that failed or was stopped after it began
// holds a fragment; presented as an answer, the next agent builds on it.
describe("a chained reply is never handed a failed reply's fragment as an answer", () => {
  for (const status of ["error", "aborted"] as const) {
    test(`bob's reply ended ${status} with partial text: nova is asked the bare question`, async () => {
      const t = convexTest(schema, modules);
      const { owner, chatId } = await room(t, { perTurnRouting: true });
      const text = "@Bob puis @Nova : quel est le plan ?";
      const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
        chatId,
        text,
        clientMessageId: "c1",
        agentMentions: spans(text, [
          ["@Bob", bob],
          ["@Nova", nova],
        ]),
      });
      const [head, second] = await rowsOf(t, messageId!);
      const replyId = await t.mutation(internal.stream.startAssistant, {
        chatId,
        runId: "r1",
        dispatchOutboxId: head!._id,
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(replyId!, { status, text: "BOB-HALF-A-PLA" });
        const live = await ctx.db
          .query("streamingText")
          .withIndex("by_message", (q) => q.eq("messageId", replyId!))
          .collect();
        for (const row of live) await ctx.db.delete(row._id);
        await ctx.db.patch(head!._id, { status: "sent" });
        await ctx.db.patch(second!._id, { status: "pending" });
      });
      const prompt = await t.query(internal.bridge.chainedPrompt, { outboxId: second!._id });
      expect(prompt).toBe(text);
    });
  }
});

describe("a message that mentions no agent goes to the PRIMARY", () => {
  test("on a per-turn routed chat, an unrouted send is dispatched as a ROUTED turn to the primary", async () => {
    const t = convexTest(schema, modules);
    // The session in use is bob's (confirmed): the primary's legacy session is stale.
    const { owner, chatId } = await room(t, {
      openclawChatId: "legacy-alice-session",
      perTurnRouting: true,
      lastRoutedInstanceName: "alpha",
      lastRoutedAgentId: "bob",
      routingSegment: "turn:seg-bob",
    });
    const { messageId, outboxId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text: "et maintenant ?",
      clientMessageId: "c1",
    });
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatch, { outboxId });
      const send = bridge.calls.find((c) => c.url.endsWith("/send"));
      // The primary, on a FRESH segment, flagged as a switch — re-hydrated, never
      // its stale legacy session.
      expect(send?.body).toMatchObject({
        agentId: "alice",
        openclawChatId: `turn:${messageId}`,
        config: { routedSwitch: true, rehydration: true },
      });
      const chat = (await t.run((ctx) => ctx.db.get(chatId)))!;
      expect(chat.lastRoutedAgentId).toBe("alice");
      expect(chat.routingSegment).toBe(`turn:${messageId}`);
    } finally {
      bridge.restore();
    }
  });

  test("a chat that is not routed per turn keeps the unchanged path", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t, { openclawChatId: "legacy-alice-session" });
    const { outboxId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text: "bonjour",
      clientMessageId: "c1",
    });
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatch, { outboxId });
      const send = bridge.calls.find((c) => c.url.endsWith("/send"));
      expect(send?.body).toMatchObject({ agentId: "alice", openclawChatId: "legacy-alice-session" });
      const chat = (await t.run((ctx) => ctx.db.get(chatId)))!;
      expect(chat.perTurnRouting).toBeUndefined();
    } finally {
      bridge.restore();
    }
  });
});

// Codex pass 7 (2026-09-26), P1. An outbox row naming an instance is proof that a turn
// went there only once the send LEFT for it (lastGateBeforeSend let it through). A
// chained row still queued behind the reply before it, one refused, or one promoted
// but not yet past the last gate names an instance nothing was ever sent to: its
// bridge must not be able to open a reply in this chat with its own key.
describe("the ingest barrier admits a chained reply's instance only once it was sent there", () => {
  const orion = { instanceName: "beta", agentId: "orion" };
  async function chainToBeta(t: T) {
    const { owner, chatId } = await room(t, { perTurnRouting: true });
    await seedAgent(t, "beta", "orion", "Orion");
    await as(t, owner).mutation(api.chatAgents.addChatAgent, { chatId, ...orion });
    await seedAgent(t, "gamma", "vega", "Vega");
    expect(await t.run((ctx) => chatAllowsInstance(ctx, chatId, "beta"))).toBe(false);
    const text = "@Bob puis @Orion";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Orion", orion],
      ]),
    });
    const [head, second] = await rowsOf(t, messageId!);
    return { owner, chatId, messageId: messageId!, head: head!, second: second! };
  }
  const allows = (t: T, chatId: Id<"chats">, instance: string) =>
    t.run((ctx) => chatAllowsInstance(ctx, chatId, instance));

  test("a chained row still QUEUED is no proof: beta's bridge cannot open a reply", async () => {
    const t = convexTest(schema, modules);
    const { chatId, second } = await chainToBeta(t);
    expect(second.status).toBe("queued");
    expect(await allows(t, chatId, "beta")).toBe(false);
    await expect(
      t.mutation(internal.stream.startAssistant, {
        chatId,
        runId: "forged",
        dispatchOutboxId: second._id,
        boundInstanceName: "beta",
      }),
    ).rejects.toThrow();
    expect(await allows(t, chatId, "gamma")).toBe(false);
  });

  test("the HEAD of a message queued behind a live turn: its routing stamp is no proof", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t, { perTurnRouting: true });
    await seedAgent(t, "beta", "orion", "Orion");
    await as(t, owner).mutation(api.chatAgents.addChatAgent, { chatId, ...orion });
    // A turn is live: the next send queues.
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "assistant",
        status: "streaming",
        text: "",
        updatedAt: 1,
      }),
    );
    const text = "@Orion une question";
    const { messageId, outboxId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [["@Orion", orion]]),
    });
    expect((await t.run((ctx) => ctx.db.get(outboxId)))?.status).toBe("queued");
    // The user message names beta already…
    expect((await t.run((ctx) => ctx.db.get(messageId!)))?.routedInstanceName).toBe("beta");
    // …but nothing was sent there.
    expect(await allows(t, chatId, "beta")).toBe(false);
  });

  test("promoted to pending, not yet past the last gate: still no proof", async () => {
    const t = convexTest(schema, modules);
    const { chatId, head, second } = await chainToBeta(t);
    await t.mutation(internal.bridge.failDispatch, { outboxId: head._id, reason: "send_failed" });
    expect((await t.run((ctx) => ctx.db.get(second._id)))?.status).toBe("pending");
    expect(await allows(t, chatId, "beta")).toBe(false);
  });

  test("orion taken out of the room: the refused row is no proof, before or after", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId, head, second } = await chainToBeta(t);
    await as(t, owner).mutation(api.chatAgents.removeChatAgent, { chatId, ...orion });
    expect(await allows(t, chatId, "beta")).toBe(false);
    await t.mutation(internal.bridge.failDispatch, { outboxId: head._id, reason: "send_failed" });
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatch, { outboxId: second._id });
    } finally {
      bridge.restore();
    }
    expect((await t.run((ctx) => ctx.db.get(second._id)))?.status).toBe("failed");
    expect(await allows(t, chatId, "beta")).toBe(false);
  });

  test("past the last gate — in flight — beta may read the history and open its reply", async () => {
    const t = convexTest(schema, modules);
    const { chatId, head, second } = await chainToBeta(t);
    await t.mutation(internal.bridge.failDispatch, { outboxId: head._id, reason: "send_failed" });
    const gate = await t.mutation(internal.bridge.lastGateBeforeSend, {
      outboxId: second._id,
      target: orion,
    });
    expect(gate.kind).toBe("send");
    expect(await allows(t, chatId, "beta")).toBe(true);
    await expect(
      t.query(internal.stream.rehydrationContext, { chatId, boundInstanceName: "beta" }),
    ).resolves.toBeDefined();
    expect(await allows(t, chatId, "gamma")).toBe(false);
  });

  test("a reply that really started keeps its provenance after its row leaves flight", async () => {
    const t = convexTest(schema, modules);
    const { chatId, head, second } = await chainToBeta(t);
    await t.mutation(internal.bridge.failDispatch, { outboxId: head._id, reason: "send_failed" });
    await t.mutation(internal.bridge.lastGateBeforeSend, { outboxId: second._id, target: orion });
    const replyId = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "r-orion",
      dispatchOutboxId: second._id,
      boundInstanceName: "beta",
    });
    expect(replyId).toBeTruthy();
    // Acked, or settled any other way: late frames of the reply still land.
    await t.run((ctx) => ctx.db.patch(second._id, { status: "sent" }));
    expect(await allows(t, chatId, "beta")).toBe(true);
    await t.run((ctx) => ctx.db.patch(second._id, { status: "failed" }));
    expect(await allows(t, chatId, "beta")).toBe(true);
  });
});

// ── Codex pass 1 (2026-09-26), P2 ────────────────────────────────────────────
// The owner may address only the room's agents (send.ts, "for the owner too" above),
// but a chained reply WAITS: queued behind the reply before it. An agent taken out of
// the room meanwhile must not still be asked — the dispatch re-judges the room for
// every row that was ADDRESSED to one of its agents, the owner's included.
describe("an agent taken out of the room while its reply waits is not asked", () => {
  async function cardOf(t: T, chatId: Id<"chats">, agentId: string) {
    const all = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect(),
    );
    return all.find(
      (m) => m.role === "assistant" && m.status === "error" && m.routedAgentId === agentId,
    );
  }

  test("the owner's chain: nova removed while bob answers — refused, and alice still answers", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Bob puis @Nova puis @Alice";
    const { messageId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [
        ["@Bob", bob],
        ["@Nova", nova],
        ["@Alice", alice],
      ]),
    });
    await as(t, owner).mutation(api.chatAgents.removeChatAgent, { chatId, ...nova });
    const [head, second, third] = await rowsOf(t, messageId!);
    // Bob's reply ends (a failure ends a turn like any other): nova's row drains.
    await t.mutation(internal.bridge.failDispatch, { outboxId: head!._id, reason: "send_failed" });
    expect((await rowsOf(t, messageId!)).map((r) => r.status)).toEqual([
      "failed",
      "pending",
      "queued",
    ]);
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatch, { outboxId: second!._id });
      expect(bridge.calls.filter((c) => c.url.endsWith("/send"))).toEqual([]);
      const card = await cardOf(t, chatId, "nova");
      expect(card?.errorCode).toBe("AGENT_LEFT_ROOM");
      // The chain is not stuck behind the refused reply: alice's turn drains, and goes.
      expect((await rowsOf(t, messageId!)).map((r) => r.status)).toEqual([
        "failed",
        "failed",
        "pending",
      ]);
      await t.action(internal.bridge.dispatch, { outboxId: third!._id });
      const sends = bridge.calls.filter((c) => c.url.endsWith("/send"));
      expect(sends.map((c) => c.body.agentId)).toEqual(["alice"]);
    } finally {
      bridge.restore();
    }
  });

  test("the head of a queued message: the agent it names removed before it drains", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Nova une question";
    const { outboxId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [["@Nova", nova]]),
    });
    expect(
      await t.query(internal.bridge.senderRefusalAtDispatch, {
        chatId,
        senderId: owner,
        routedAgent: nova,
        outboxId,
      }),
    ).toBeNull();
    await as(t, owner).mutation(api.chatAgents.removeChatAgent, { chatId, ...nova });
    expect(
      await t.query(internal.bridge.senderRefusalAtDispatch, {
        chatId,
        senderId: owner,
        routedAgent: nova,
        outboxId,
      }),
    ).toBe("agent_left_room");
  });

  test("a regenerate of a turn addressed to an agent since removed: no reset, the row settled", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const text = "@Nova une question";
    const { messageId, outboxId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text,
      clientMessageId: "c1",
      agentMentions: spans(text, [["@Nova", nova]]),
    });
    await t.run((ctx) => ctx.db.patch(outboxId, { status: "sent" }));
    // The regenerate's row, as messages.deleteMessage builds it: the turn's route.
    const regen = await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId: owner,
        clientMessageId: "regen-1",
        messageId: messageId!,
        text,
        attachmentIds: [],
        status: "pending",
        pendingSince: Date.now(),
        routedAgent: nova,
      }),
    );
    await as(t, owner).mutation(api.chatAgents.removeChatAgent, { chatId, ...nova });
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatchReset, {
        chatId,
        userId: owner,
        regenerateOutboxId: regen,
        routedAgent: nova,
      });
      expect(bridge.calls).toEqual([]);
      expect((await t.run((ctx) => ctx.db.get(regen)))?.status).toBe("failed");
      expect((await cardOf(t, chatId, "nova")) ?? null).toBeNull();
      const cards = await t.run((ctx) =>
        ctx.db
          .query("messages")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect(),
      );
      expect(
        cards.find((m) => m.role === "assistant" && m.status === "error")?.errorCode,
      ).toBe("AGENT_LEFT_ROOM");
    } finally {
      bridge.restore();
    }
  });

  test("unchanged: the owner's turn routed WITHOUT a mention, even to an agent outside the room", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await room(t);
    const { outboxId } = await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text: "une question",
      clientMessageId: "c1",
      routedAgent: carol,
    });
    const bridge = stubBridge();
    try {
      await t.action(internal.bridge.dispatch, { outboxId });
      const sends = bridge.calls.filter((c) => c.url.endsWith("/send"));
      expect(sends.map((c) => c.body.agentId)).toEqual(["carol"]);
    } finally {
      bridge.restore();
    }
  });
});
