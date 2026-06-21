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
