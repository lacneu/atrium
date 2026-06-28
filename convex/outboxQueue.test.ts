/// <reference types="vite/client" />
//
// Mid-turn send serialization (Phase 1: QUEUE). These tests pin the
// single-in-flight-turn invariant: a send that arrives while a chat has a turn
// in flight is PARKED (`queued`) and auto-dispatched FIFO when the turn ends —
// never dispatched concurrently (the bridge is one-turn-per-session). Each test
// is written to FAIL if the serialization regresses (e.g. a queued send slips
// straight to `pending`, or the queue stalls after a turn ends).

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  isChatBusy,
  drainNextQueued,
  MAX_QUEUED_PER_CHAT,
  SUBAGENT_STALE_TTL_MS,
} from "./lib/outboxQueue";
import { QUEUED_ORDER_SENTINEL } from "./lib/messageOrder";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

async function seedUserChat(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "u",
    });
    await ctx.db.insert("userAgents", {
      userId,
      instanceName: "prod",
      agentId: "main",
      isDefault: true,
      source: "manual" as const,
      createdAt: 1,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    return { userId, chatId };
  });
}

function insertOutbox(
  t: ReturnType<typeof convexTest>,
  chatId: Id<"chats">,
  userId: Id<"users">,
  status: "queued" | "pending" | "sent" | "failed",
  clientMessageId: string,
) {
  return t.run((ctx) =>
    ctx.db.insert("outbox", {
      chatId,
      userId,
      clientMessageId,
      text: clientMessageId,
      attachmentIds: [],
      status,
    }),
  );
}

/**
 * Insert a sub-agent observation row directly (for isChatBusy assertions).
 * `updatedAt` defaults to NOW so a `running` row is FRESH (and thus holds); the
 * freshness tests pass an old `updatedAt` to exercise the stale-row path.
 */
function insertSubAgent(
  t: ReturnType<typeof convexTest>,
  chatId: Id<"chats">,
  childSessionKey: string,
  status: "running" | "done" | "error" | "aborted",
  updatedAt: number = Date.now(),
) {
  return t.run((ctx) =>
    ctx.db.insert("subAgents", {
      chatId,
      childSessionKey,
      status,
      createdAt: updatedAt,
      updatedAt,
    }),
  );
}

describe("isChatBusy", () => {
  test("idle chat is not busy; a pending outbox OR a streaming message is", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);

    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(false);

    // A terminal outbox (sent) and a complete message do NOT make it busy.
    await insertOutbox(t, chatId, userId, "sent", "done-1");
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "complete",
        text: "hi",
        updatedAt: 1,
      }),
    );
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(false);

    // A pending outbox → busy.
    const pendingId = await insertOutbox(t, chatId, userId, "pending", "p-1");
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(true);
    await t.run((ctx) => ctx.db.patch(pendingId, { status: "sent" }));
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(false);

    // A streaming message → busy.
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "streaming",
        text: "",
        updatedAt: 2,
      }),
    );
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(true);
  });
});

describe("drainNextQueued", () => {
  test("no-op while busy: a queued row stays queued", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    await insertOutbox(t, chatId, userId, "pending", "p-1"); // busy
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");

    await t.run((ctx) => drainNextQueued(ctx, chatId));

    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "queued",
    );
  });

  test("idle chat promotes the OLDEST queued (FIFO) and only one", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");
    const q2 = await insertOutbox(t, chatId, userId, "queued", "q-2");

    await t.run((ctx) => drainNextQueued(ctx, chatId));

    const [s1, s2] = await t.run(async (ctx) => [
      (await ctx.db.get(q1))?.status,
      (await ctx.db.get(q2))?.status,
    ]);
    expect(s1).toBe("pending"); // oldest promoted
    expect(s2).toBe("queued"); // the next stays parked (one turn at a time)
  });

  test("no queued → no-op (creates no pending row)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserChat(t);
    await t.run((ctx) => drainNextQueued(ctx, chatId));
    const pending = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", chatId).eq("status", "pending"),
        )
        .first(),
    );
    expect(pending).toBeNull();
  });
});

describe("sendMessage serialization (integration)", () => {
  test("idle chat → pending + dispatch; busy chat → queued (no concurrent dispatch)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const asUser = t.withIdentity({ subject: `${userId}|session` });

    // First send to an idle chat: dispatched (pending).
    await asUser.mutation(api.send.sendMessage, {
      chatId,
      text: "first",
      clientMessageId: "c1",
    });
    const first = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_client_message", (q) =>
          q.eq("userId", userId).eq("clientMessageId", "c1"),
        )
        .unique(),
    );
    expect(first?.status).toBe("pending");

    // Second send while the first turn is still in flight (pending) → QUEUED.
    await asUser.mutation(api.send.sendMessage, {
      chatId,
      text: "second",
      clientMessageId: "c2",
    });
    const second = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_client_message", (q) =>
          q.eq("userId", userId).eq("clientMessageId", "c2"),
        )
        .unique(),
    );
    expect(second?.status).toBe("queued");

    // The user message for the queued send IS inserted (instant feedback).
    const userMsgs = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect(),
    );
    expect(userMsgs.filter((m) => m.role === "user").length).toBe(2);
  });

  test("a queued send is dispatched when the in-flight turn finalizes (no stall)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const asUser = t.withIdentity({ subject: `${userId}|session` });

    // Simulate an in-flight turn: a streaming assistant message.
    const streamingId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "streaming",
        text: "",
        updatedAt: 1,
      }),
    );
    // A send now must be queued (chat busy via the streaming message).
    await asUser.mutation(api.send.sendMessage, {
      chatId,
      text: "follow-up",
      clientMessageId: "c1",
    });
    const queued = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", chatId).eq("status", "queued"),
        )
        .unique(),
    );
    expect(queued).not.toBeNull();

    // Finalize the turn → drainNextQueued promotes the queued row to pending.
    await t.mutation(internal.stream.finalize, {
      messageId: streamingId,
      status: "complete",
      text: "done",
    });
    expect(
      await t.run((ctx) => ctx.db.get(queued!._id).then((r) => r?.status)),
    ).toBe("pending");
  });

  test("a FAILED dispatch drains the next queued (no stall on dispatch error)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    // In-flight (pending) turn + one queued behind it.
    const pendingId = await insertOutbox(t, chatId, userId, "pending", "p-1");
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");

    // The in-flight dispatch fails (e.g. bridge unreachable).
    await t.mutation(internal.bridge.markOutbox, {
      outboxId: pendingId,
      status: "failed",
    });

    // The queue must NOT stall: the next send is promoted.
    expect(
      await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status)),
    ).toBe("pending");
  });

  test("a failDispatch (the REAL dispatch error path) also drains the next queued", async () => {
    // The dispatch action terminates its failures via internal.bridge.failDispatch,
    // NOT markOutbox — so the drain MUST live there too, else a queued follow-up
    // stalls forever after a no_agent/not_configured/send_failed. (The markOutbox
    // test above does not cover this path.)
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const pendingId = await insertOutbox(t, chatId, userId, "pending", "p-1");
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");

    await t.mutation(internal.bridge.failDispatch, {
      outboxId: pendingId,
      reason: "send_failed",
    });

    // The failed row is terminal AND the queue advanced. Regression guard: remove
    // the drainNextQueued call from failDispatch and q1 stays "queued".
    expect(
      await t.run((ctx) => ctx.db.get(pendingId).then((r) => r?.status)),
    ).toBe("failed");
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "pending",
    );
  });

  test("deleting a chat purges its QUEUED outbox rows (no ghost dispatch after deletion)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    const queued = await insertOutbox(t, chatId, userId, "queued", "q-1");

    await asUser.mutation(api.chats.deleteChat, { chatId });

    // Regression guard: a pending-only purge leaves the queued row behind, and a
    // later drainNextQueued could dispatch a DELETED chat's queued send.
    expect(await t.run((ctx) => ctx.db.get(queued))).toBeNull();
  });

  test("RACE: a turn that finalizes BEFORE markOutbox('sent') still drains the queue", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    // In-flight turn: a pending outbox AND its streaming assistant message.
    const pendingId = await insertOutbox(t, chatId, userId, "pending", "p-1");
    const streamingId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "streaming",
        text: "",
        updatedAt: 1,
      }),
    );
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");

    // The turn finalizes BEFORE the dispatch action marks the outbox "sent" (a very
    // fast turn). finalize's own drain sees the outbox still "pending" → no-op.
    await t.mutation(internal.stream.finalize, {
      messageId: streamingId,
      status: "complete",
      text: "done",
    });
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "queued",
    ); // still parked — the race window

    // markOutbox("sent") now runs. It MUST drain (outbox sent + message complete →
    // chat idle). Regression guard: drain only on "failed" and q1 stalls forever.
    await t.mutation(internal.bridge.markOutbox, {
      outboxId: pendingId,
      status: "sent",
    });
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "pending",
    );
  });

  test("a queued send carries the SENTINEL orderTime; draining re-stamps it to a real time", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    // In-flight turn (streaming assistant) → the next send is QUEUED.
    const streamingId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant",
        status: "streaming",
        text: "",
        updatedAt: 1,
      }),
    );
    await asUser.mutation(api.send.sendMessage, {
      chatId,
      text: "follow-up",
      clientMessageId: "c1",
    });
    const outbox = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_client_message", (q) =>
          q.eq("userId", userId).eq("clientMessageId", "c1"),
        )
        .unique(),
    );
    // Parked → SENTINEL (sorts after the in-flight turn's not-yet-created assistant).
    const queuedMsg = await t.run((ctx) => ctx.db.get(outbox!.messageId!));
    expect(queuedMsg!.orderTime).toBe(QUEUED_ORDER_SENTINEL);

    // Finalize the in-flight turn → drainNextQueued promotes c1 AND re-stamps it to
    // the real dispatch time. Regression guard: drop the drain re-stamp and orderTime
    // stays SENTINEL forever (the message sorts last forever, never beside its reply).
    await t.mutation(internal.stream.finalize, {
      messageId: streamingId,
      status: "complete",
      text: "done",
    });
    const afterDrain = await t.run((ctx) => ctx.db.get(outbox!.messageId!));
    expect(afterDrain!.orderTime).toBeLessThan(QUEUED_ORDER_SENTINEL);
    expect(afterDrain!.orderTime).toBeGreaterThan(0);
  });

  test("draining stamps STRICTLY AFTER the latest dispatched message (no same-ms tie)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const future = Date.now() + 1_000_000_000; // a dispatched msg whose order is AHEAD
    const promoted = await t.run(async (ctx) => {
      // A dispatched message with a HIGH effectiveOrder (simulates the prior turn's
      // order being ahead of the wall clock at drain — the same-ms-tie edge).
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "A1",
        orderTime: future,
        updatedAt: 1,
      });
      const promoted = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "U2",
        orderTime: QUEUED_ORDER_SENTINEL,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "u2",
        messageId: promoted,
        text: "U2",
        attachmentIds: [],
        status: "queued" as const,
      });
      return promoted;
    });

    await t.run((ctx) => drainNextQueued(ctx, chatId));

    const ot = await t.run((ctx) => ctx.db.get(promoted).then((m) => m?.orderTime));
    // Regression guard: raw Date.now() would be BELOW `future`, sorting the promoted
    // turn before the prior reply; the bump places it strictly after.
    expect(ot).toBeGreaterThan(future);
    expect(ot).toBeLessThan(QUEUED_ORDER_SENTINEL); // still before other still-queued
  });

  test("deleting a QUEUED message keeps an EARLIER in-flight turn's outbox (scoped purge)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    const { u1ob, u2msg } = await t.run(async (ctx) => {
      // U1: an EARLIER turn still in flight (message kept + pending outbox).
      const u1msg = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "U1",
        updatedAt: 1,
      });
      const u1ob = await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "u1",
        messageId: u1msg,
        text: "U1",
        attachmentIds: [],
        status: "pending" as const,
      });
      // U2: a QUEUED follow-up (SENTINEL → logically after U1).
      const u2msg = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "U2",
        orderTime: QUEUED_ORDER_SENTINEL,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "u2",
        messageId: u2msg,
        text: "U2",
        attachmentIds: [],
        status: "queued" as const,
      });
      return { u1ob, u2msg };
    });

    await asUser.mutation(api.messages.deleteMessage, { messageId: u2msg });

    // Regression guard: a broad pending+queued purge wiped U1's in-flight outbox (its
    // message kept by logical order) → that turn vanishes. Scoped purge keeps it.
    expect(await t.run((ctx) => ctx.db.get(u1ob))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(u2msg))).toBeNull(); // U2 truncated
  });

  test("QUEUE_FULL: a runaway backlog is refused without inserting anything", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const asUser = t.withIdentity({ subject: `${userId}|session` });

    // Make the chat busy + fill the queue to the cap.
    await insertOutbox(t, chatId, userId, "pending", "p-1");
    for (let i = 0; i < MAX_QUEUED_PER_CHAT; i++) {
      await insertOutbox(t, chatId, userId, "queued", `q-${i}`);
    }
    const before = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect(),
    );

    await expect(
      asUser.mutation(api.send.sendMessage, {
        chatId,
        text: "overflow",
        clientMessageId: "over",
      }),
    ).rejects.toThrow(/QUEUE_FULL/);

    // The rejected send inserted NEITHER a message NOR an outbox row.
    const after = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect(),
    );
    expect(after.length).toBe(before.length);
    const over = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_client_message", (q) =>
          q.eq("userId", userId).eq("clientMessageId", "over"),
        )
        .unique(),
    );
    expect(over).toBeNull();
  });
});

// A/B fix: a chat with a LIVE sub-agent must HOLD the user's next send (OpenClaw
// mis-routes it into the yielded child otherwise). These tests collectively prove
// the one invariant the design rests on: every path that clears the LAST blocker
// (pending outbox / streaming message / running sub-agent) calls drainNextQueued,
// so whichever blocker clears last dispatches the held message — no lost-message
// path regardless of ordering. Each test FAILS if the sub-agent hold regresses.
describe("sub-agent dispatch hold (A/B fix)", () => {
  const A = "agent:u:subagent:aaaaaaaa-0000-0000-0000-000000000001";
  const B = "agent:u:subagent:bbbbbbbb-0000-0000-0000-000000000002";

  test("isChatBusy: a RUNNING sub-agent holds; TERMINAL-only sub-agents do NOT", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserChat(t);

    // A running sub-agent (no in-flight turn) → busy.
    const row = await insertSubAgent(t, chatId, A, "running");
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(true);

    // Once terminal, it no longer holds. Dual of the line above: this FAILS if the
    // filter ever broadened to match terminal rows.
    await t.run((ctx) => ctx.db.patch(row, { status: "done" as const }));
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(false);

    // error / aborted are terminal too (none should make the chat busy).
    await insertSubAgent(t, chatId, B, "error");
    await insertSubAgent(t, chatId, `${B}-x`, "aborted");
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(false);
  });

  test("many TERMINATED sub-agents (zero running) → NOT busy (bounded by_chat_status read)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserChat(t);
    // A long-lived chat accumulates terminal history: it must NOT make a send busy,
    // and the read must hit only the (empty) running slice — not the whole per-chat
    // history. Regression guard for the by_chat scan + JS filter (P2).
    for (let i = 0; i < 30; i++) {
      await insertSubAgent(t, chatId, `${A}-done-${i}`, "done");
      await insertSubAgent(t, chatId, `${A}-err-${i}`, "error");
    }
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(false);
    // Add ONE running child → busy true (the running slice now has a row).
    await insertSubAgent(t, chatId, A, "running");
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(true);
  });

  test("RACE (a): a send right after a spawn — running row already present → QUEUED", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const asUser = t.withIdentity({ subject: `${userId}|session` });

    // The spawn's `running` row is written DURING the parent turn, so it is present
    // when the user's next message arrives. No pending outbox / streaming message:
    // ONLY the sub-agent holds the chat.
    await insertSubAgent(t, chatId, A, "running");
    await asUser.mutation(api.send.sendMessage, {
      chatId,
      text: "while the sub-agent runs",
      clientMessageId: "c1",
    });
    const ob = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_client_message", (q) =>
          q.eq("userId", userId).eq("clientMessageId", "c1"),
        )
        .unique(),
    );
    // Regression guard: without the sub-agent busy condition this would be "pending"
    // and the dispatch would be mis-routed into the yielded child.
    expect(ob?.status).toBe("queued");
  });

  test("RACE (b) / drain on terminal: the queued send dispatches when the child finishes", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    // running sub-agent registered via the REAL upsert (no drain on a running write).
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "running" as const,
    });
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");
    // Still held while the child runs.
    await t.run((ctx) => drainNextQueued(ctx, chatId));
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "queued",
    );

    // Child reaches `done` → the upsert's terminal drain dispatches the held send.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "done" as const,
      resultText: "child answer",
    });
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "pending",
    );
  });

  test("drains on the TTL/watchdog terminal (error), not just a clean done", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "running" as const,
    });
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");

    // The observer's TTL watchdog writes a terminal `error` for a silently-hung
    // child (same upsert seam). The held send must still dispatch — a silent hang
    // can never permanently strand the queue.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "error" as const,
      errorMessage: "timed out",
    });
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "pending",
    );
  });

  test("MULTI sub-agent: a PARTIAL terminal does NOT drain; the LAST one does", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    // Two children running concurrently under the same chat.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "running" as const,
    });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: B,
      status: "running" as const,
    });
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");

    // A finishes — B still holds the chat → the send STAYS queued. This is the sharp
    // test for "AND no remaining running sub-agent": it FAILS if the drain fired on
    // the first terminal regardless of the still-running sibling.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "done" as const,
    });
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "queued",
    );

    // B finishes — now NO running sub-agent → the held send dispatches.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: B,
      status: "done" as const,
    });
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "pending",
    );
  });

  test("drain HELD while the parent turn streams: finalize does NOT dispatch into a live child", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    // Parent turn streaming AND it spawned a child that is still running.
    const streamingId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      }),
    );
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "running" as const,
    });
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");

    // The parent turn finalizes WHILE the child runs. finalize's own drain must see
    // the running sub-agent and HOLD — this is the crux that folding the check into
    // isChatBusy (which drainNextQueued calls) buys for free.
    await t.mutation(internal.stream.finalize, {
      messageId: streamingId,
      status: "complete",
      text: "parent done",
    });
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "queued",
    );

    // Only when the child finishes does the held send dispatch.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "done" as const,
    });
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "pending",
    );
  });

  test("no double-drain: a redundant terminal frame promotes only ONE queued row", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "running" as const,
    });
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");
    const q2 = await insertOutbox(t, chatId, userId, "queued", "q-2");

    // First terminal frame → drains q1 (oldest).
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "done" as const,
    });
    // A redundant later `done` frame for the SAME child must NOT promote q2 (the
    // chat is now busy via q1's pending row). Regression guard for double-dispatch.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "done" as const,
    });

    const [s1, s2] = await t.run(async (ctx) => [
      (await ctx.db.get(q1))?.status,
      (await ctx.db.get(q2))?.status,
    ]);
    expect(s1).toBe("pending"); // promoted once
    expect(s2).toBe("queued"); // still parked — no second dispatch
  });

  test("first-sight TERMINAL child drains a held send (insert branch)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");

    // A child observed already finished on its FIRST frame (it ended before its
    // spawn registration was ingested). The insert-branch drain must still fire.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "done" as const,
      resultText: "fast child",
    });
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "pending",
    );
  });

  test("a first-sight RUNNING child does NOT drain (it holds the chat)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");

    // Registering a running child must NOT release the queue — the child now holds.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: A,
      status: "running" as const,
    });
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "queued",
    );
  });

  test("single-agent path unchanged: NO sub-agent rows → busy reflects only the turn", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    // Byte-identical to today: with zero subAgents rows the new read is empty.
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(false);
    const pendingId = await insertOutbox(t, chatId, userId, "pending", "p-1");
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(true);
    await t.run((ctx) => ctx.db.patch(pendingId, { status: "sent" as const }));
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(false);
  });

  // DEAD-OBSERVER REAPER (Codex P1, round 2): a `running` row is a best-effort
  // observer write. If the observer dies without terminalizing it (dropped upsert /
  // bridge restart / the in-memory TTL watchdog dying with the connection), the row
  // stays "running" forever → the chat is held forever AND its queue strands. The
  // reaper terminalizes a stale row out-of-band, routing through the SAME terminal-
  // drain so the held queue dispatches FIFO and the dead child becomes visible.
  const STALE = SUBAGENT_STALE_TTL_MS + 60_000; // just past the TTL → reapable
  const FRESH = 60_000; // 1 min ago — a genuinely live child, NOT reaped

  test("reaper terminalizes a STALE running row AND drains the queue behind it (FIFO)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const staleRow = await insertSubAgent(
      t,
      chatId,
      A,
      "running",
      Date.now() - STALE,
    );
    // Two sends queued behind the (now dead-observer) running row.
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");
    const q2 = await insertOutbox(t, chatId, userId, "queued", "q-2");

    await t.mutation(internal.subAgents.reapStaleSubAgents, {});

    // The stale child is now a VISIBLE failure (status error + a short FR message).
    const reaped = await t.run((ctx) => ctx.db.get(staleRow));
    expect(reaped?.status).toBe("error");
    expect(reaped?.errorMessage).toMatch(/expiré/i);
    // The held queue drained via the terminal-drain — oldest first, ONE at a time.
    const [s1, s2] = await t.run(async (ctx) => [
      (await ctx.db.get(q1))?.status,
      (await ctx.db.get(q2))?.status,
    ]);
    expect(s1).toBe("pending"); // q1 dispatched
    expect(s2).toBe("queued"); // q2 still parked (no reorder, no double-drain)
  });

  test("reaper does NOT touch a FRESH running row (a live child still holds)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const freshRow = await insertSubAgent(
      t,
      chatId,
      A,
      "running",
      Date.now() - FRESH,
    );
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");

    await t.mutation(internal.subAgents.reapStaleSubAgents, {});

    // Untouched → still running → the chat is still busy → the send stays queued.
    expect(await t.run((ctx) => ctx.db.get(freshRow).then((r) => r?.status))).toBe(
      "running",
    );
    expect(await t.run((ctx) => ctx.db.get(q1).then((r) => r?.status))).toBe(
      "queued",
    );
  });

  test("reaping is IDEMPOTENT: a second pass over an already-terminal row is a no-op (no double-drain)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    await insertSubAgent(t, chatId, A, "running", Date.now() - STALE);
    const q1 = await insertOutbox(t, chatId, userId, "queued", "q-1");
    const q2 = await insertOutbox(t, chatId, userId, "queued", "q-2");

    await t.mutation(internal.subAgents.reapStaleSubAgents, {}); // reaps A, drains q1
    await t.mutation(internal.subAgents.reapStaleSubAgents, {}); // A is now error → range empty

    // The second pass must NOT promote q2 (it only ranges `running` rows; A is gone
    // from that range). Regression guard against a double-drain reordering the queue.
    const [s1, s2] = await t.run(async (ctx) => [
      (await ctx.db.get(q1))?.status,
      (await ctx.db.get(q2))?.status,
    ]);
    expect(s1).toBe("pending");
    expect(s2).toBe("queued");
  });
});
