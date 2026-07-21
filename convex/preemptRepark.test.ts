import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { QUEUED_ORDER_SENTINEL } from "./lib/messageOrder";

const modules = import.meta.glob("./**/*.ts");

// Automatic re-dispatch of a turn the GATEWAY killed to run a delivery
// (announce×queue race, inverse direction — live prod 2026-07-21, report
// ms746b01…). The system, not the user, owns the recovery: the empty aborted
// card is dropped, the outbox row re-parks `queued` after a delay, and the
// normal drain machinery re-dispatches once the delivery settles. The
// discriminating tests are the GUARDS (a re-park that fires when the user
// moved on would duplicate a turn) and the BOUND (one automatic re-dispatch).

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedPreemptedTurn(
  t: ReturnType<typeof convexTest>,
  opts?: { alreadyRedispatched?: boolean; withoutRecentChild?: boolean },
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "jnl",
    });
    await ctx.db.insert("userAgents", {
      userId,
      instanceName: "ataraxis",
      agentId: "fabien",
      isDefault: true,
      source: "manual" as const,
      createdAt: 1,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "ataraxis",
      agentId: "fabien",
    });
    const userMsgId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "Reprends la présentation et propose trois lignes.",
      updatedAt: 1,
    });
    // The dispatched turn's outbox row (the gateway had ACKed: status sent).
    const outboxId = await ctx.db.insert("outbox", {
      chatId,
      userId,
      clientMessageId: "orig-preempt-1",
      messageId: userMsgId,
      text: "Reprends la présentation et propose trois lignes.",
      attachmentIds: [],
      status: "sent" as const,
      ...(opts?.alreadyRedispatched ? { preemptRedispatched: true } : {}),
    });
    // The killed turn's assistant card, still streaming (finalize flips it).
    const assistantId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId: "webchat-preempted-1",
      updatedAt: 2,
    });
    // The PREEMPTION PROOF: the sub-agent whose queued delivery is what kills
    // the dispatched turn (live shape: analyse-paxi-ppt done 35s before the
    // kill). Omitted only by the no-proof test.
    if (opts?.withoutRecentChild !== true) {
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "agent:fabien:subagent:proof-1",
        kind: "subagent" as const,
        status: "done" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return { userId, chatId, userMsgId, assistantId, outboxId };
  });
}

async function finalizePreempted(
  t: ReturnType<typeof convexTest>,
  messageId: Id<"messages">,
  opts?: { text?: string },
) {
  await t.mutation(internal.stream.finalize, {
    messageId,
    status: "aborted" as const,
    ...(opts?.text !== undefined ? { text: opts.text } : {}),
    gatewayPreempted: true,
  });
}

describe("finalize(gatewayPreempted) -> re-park -> drain (the automatic re-send)", () => {
  test("happy path: the empty aborted card is dropped and the SAME row re-dispatches through the queue", async () => {
    const t = convexTest(schema, modules);
    const { chatId, assistantId, outboxId } = await seedPreemptedTurn(t);
    await finalizePreempted(t, assistantId);
    // Same-transaction effects: card gone, row stamped and HELD `pending` —
    // the queue's own busy blocker, so a window send parks behind it and the
    // finalize's own drain cannot race the delivery (codex P1).
    const mid = await t.run(async (ctx) => ({
      card: await ctx.db.get(assistantId),
      row: await ctx.db.get(outboxId),
    }));
    expect(mid.card).toBeNull();
    expect(mid.row?.status).toBe("pending");
    expect(mid.row?.preemptRedispatched).toBe(true);
    // The delayed flip fires; the chat is idle -> queued -> drained -> the
    // dispatch action runs (no BRIDGE_SHARED_SECRET in tests: it fail-safes
    // the row to `failed`, proving the whole chain was ridden).
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const end = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(end?.status).toBe("failed");
    expect(end?.preemptRedispatched).toBe(true);
    // The flip released the transient hold and minted a FRESH gateway key as
    // a SEPARATE alias (the killed dispatch consumed the original) — the
    // browser's clientMessageId stays intact for send retry dedup (codex P1).
    expect(end?.preemptHold ?? undefined).toBeUndefined();
    expect(end?.dispatchKey?.startsWith("preempt-")).toBe(true);
    expect(end?.clientMessageId).toBe("orig-preempt-1");
    // The chain never spawned a second row for the same message.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) => q.eq("chatId", chatId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("the RE-dispatch's own ack lands normally (hold cleared — no forever-pending chat)", async () => {
    // codex P1 (pass 4): the ack guard must key on the TRANSIENT hold, never
    // the permanent bound stamp — this row shape IS the re-dispatched turn
    // (stamp kept, hold cleared, back in `pending` via the drain).
    const t = convexTest(schema, modules);
    const { outboxId } = await seedPreemptedTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(outboxId, {
        status: "pending" as const,
        preemptRedispatched: true,
      });
    });
    await t.mutation(internal.bridge.markOutbox, {
      outboxId,
      status: "sent" as const,
    });
    const row = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(row?.status).toBe("sent");
  });

  test("a STRAGGLER ack from the killed dispatch cannot flip the re-keyed row (codex P1)", async () => {
    // The first dispatch's ack arrives AFTER the flip (>10s network lag): the
    // flip minted a fresh clientMessageId, so the generation-bound ack must
    // be dropped — flipping the re-queued row `sent` would make the scheduled
    // re-dispatch bail and lose the turn (its card is already deleted).
    const t = convexTest(schema, modules);
    const { outboxId } = await seedPreemptedTurn(t);
    // Post-flip shape: re-keyed via the dispatchKey alias, back in the queue.
    await t.run(async (ctx) => {
      await ctx.db.patch(outboxId, {
        status: "queued" as const,
        preemptRedispatched: true,
        dispatchKey: "preempt-msg-999",
      });
    });
    await t.mutation(internal.bridge.markOutbox, {
      outboxId,
      status: "sent" as const,
      expectedClientMessageId: "orig-preempt-1", // the killed dispatch's key
    });
    const row = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(row?.status).toBe("queued"); // untouched — the re-dispatch owns it
    // A MATCHING generation still lands normally.
    await t.mutation(internal.bridge.markOutbox, {
      outboxId,
      status: "sent" as const,
      expectedClientMessageId: "preempt-msg-999",
    });
    const row2 = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(row2?.status).toBe("sent");
  });

  test("a transport 'failure' cannot cancel a held recovery (lost-response, codex P2)", async () => {
    // The hold proves the send reached the gateway (a run was killed) — a
    // lost HTTP response must not fail the row nor paint an error card.
    const t = convexTest(schema, modules);
    const { chatId, assistantId, outboxId } = await seedPreemptedTurn(t);
    await finalizePreempted(t, assistantId);
    await t.mutation(internal.bridge.markOutbox, {
      outboxId,
      status: "failed" as const,
    });
    await t.mutation(internal.bridge.failDispatch, {
      outboxId,
      reason: "send_failed" as const,
    });
    const state = await t.run(async (ctx) => ({
      row: await ctx.db.get(outboxId),
      errorCards: (
        await ctx.db
          .query("messages")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect()
      ).filter((m) => m.role === "assistant" && m.status === "error"),
    }));
    expect(state.row?.status).toBe("pending"); // hold intact
    expect(state.errorCards).toHaveLength(0); // no spurious card
  });

  test("a STRAGGLER failDispatch outliving the hold cannot fail the re-keyed row (codex P1)", async () => {
    // The killed dispatch's lost-response failure lands AFTER the flip: the
    // row is re-keyed (dispatchKey) and back in `pending` for its re-dispatch
    // — the generation-bound failure must be dropped, not fail the recovery.
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seedPreemptedTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(outboxId, {
        status: "pending" as const,
        preemptRedispatched: true,
        dispatchKey: "preempt-msg-777",
      });
    });
    await t.mutation(internal.bridge.failDispatch, {
      outboxId,
      reason: "send_failed" as const,
      expectedClientMessageId: "orig-preempt-1", // the killed dispatch's key
    });
    const state = await t.run(async (ctx) => ({
      row: await ctx.db.get(outboxId),
      errorCards: (
        await ctx.db
          .query("messages")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect()
      ).filter((m) => m.role === "assistant" && m.status === "error"),
    }));
    expect(state.row?.status).toBe("pending"); // untouched
    expect(state.errorCards).toHaveLength(0);
    // A MATCHING generation still fails normally (real re-dispatch failure).
    await t.mutation(internal.bridge.failDispatch, {
      outboxId,
      reason: "send_failed" as const,
      expectedClientMessageId: "preempt-msg-777",
    });
    const after = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(after?.status).toBe("failed");
  });

  test("a streaming delivery at flip time keeps the row QUEUED (its finalize drains it later)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, assistantId, outboxId } =
      await seedPreemptedTurn(t);
    await finalizePreempted(t, assistantId);
    // The announce opens its stream during the delay window.
    const announceId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "announce:v1:agent:files:subagent:abc:def",
        updatedAt: 3,
      }),
    );
    // Run ONLY the delayed flip (advance past PREEMPT_REPARK_DELAY_MS): the
    // drain must defer to the streaming delivery.
    await vi.advanceTimersByTimeAsync(11_000);
    await t.finishInProgressScheduledFunctions();
    const mid = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(mid?.status).toBe("queued");
    // The delivery settles -> its finalize drains the queue FIFO -> dispatch.
    await t.mutation(internal.stream.finalize, {
      messageId: announceId,
      status: "complete" as const,
      text: "Le rapport livré.",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const end = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(end?.status).toBe("failed"); // dispatch attempted (fail-safe in tests)
  });

  test("FIFO: a user send INSIDE the hold window parks queued and the held turn drains FIRST (codex P1)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, assistantId, outboxId } =
      await seedPreemptedTurn(t);
    await finalizePreempted(t, assistantId);
    // The user sends a NEW message inside the 10s window: the `pending` hold
    // makes the chat busy, so it must park `queued` — never dispatch ahead of
    // the held turn (order inversion + a fresh collision with the delivery).
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    const sent = (await asUser.mutation(api.send.sendMessage, {
      chatId,
      text: "nouveau message pendant la fenêtre",
      clientMessageId: "window-send-1",
    })) as { outboxId: Id<"outbox"> };
    const during = await t.run(async (ctx) => ({
      held: await ctx.db.get(outboxId),
      win: await ctx.db.get(sent.outboxId),
    }));
    expect(during.held?.status).toBe("pending");
    expect(during.win?.status).toBe("queued");
    // The flip fires: the held row re-queues and the drain promotes the OLDEST
    // queued row — the held turn (earlier _creationTime), never the window send.
    await vi.advanceTimersByTimeAsync(11_000);
    await t.finishInProgressScheduledFunctions();
    const after = await t.run(async (ctx) => ({
      held: await ctx.db.get(outboxId),
      win: await ctx.db.get(sent.outboxId),
    }));
    expect(after.held?.status).toBe("pending"); // promoted first, dispatch scheduled
    expect(after.win?.status).toBe("queued"); // still parked behind it
  });

  test("a SECOND queued follow-up (sentinel order) does not veto the recovery (codex P1)", async () => {
    // Fabien's scenario widened: TWO messages queued during the killed turn.
    // The second is parked with QUEUED_ORDER_SENTINEL (sorts after the aborted
    // card) — it is not yet part of the established order and must not make
    // the last-message guard abandon the first message's recovery.
    const t = convexTest(schema, modules);
    const { chatId, userId, assistantId, outboxId } =
      await seedPreemptedTurn(t);
    await t.run(async (ctx) => {
      const queuedMsgId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "deuxième message, encore en file",
        orderTime: QUEUED_ORDER_SENTINEL,
        updatedAt: 3,
      });
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "second-queued-1",
        messageId: queuedMsgId,
        text: "deuxième message, encore en file",
        attachmentIds: [],
        status: "queued" as const,
      });
    });
    await finalizePreempted(t, assistantId);
    const mid = await t.run(async (ctx) => ({
      card: await ctx.db.get(assistantId),
      row: await ctx.db.get(outboxId),
    }));
    expect(mid.card).toBeNull(); // recovery engaged despite the queued peer
    expect(mid.row?.status).toBe("pending");
    expect(mid.row?.preemptRedispatched).toBe(true);
  });

  test("a kill ingested BEFORE the dispatch's sent-flip (row still pending) still recovers (codex P1)", async () => {
    const t = convexTest(schema, modules);
    const { assistantId, outboxId } = await seedPreemptedTurn(t);
    // The 2026-07-09 shape: the gateway error beat markOutbox("sent") — the
    // turn's own row is still `pending` when the flagged finalize lands.
    await t.run(async (ctx) => {
      await ctx.db.patch(outboxId, { status: "pending" as const });
    });
    await finalizePreempted(t, assistantId);
    const mid = await t.run(async (ctx) => ({
      card: await ctx.db.get(assistantId),
      row: await ctx.db.get(outboxId),
    }));
    expect(mid.card).toBeNull();
    expect(mid.row?.status).toBe("pending"); // held
    expect(mid.row?.preemptRedispatched).toBe(true);
    // The late markOutbox("sent") ack lands mid-window: it must NOT release
    // the hold (a release would drain a window send ahead of the held turn —
    // codex P1). The dispatch it reports was consumed by the kill.
    await t.mutation(internal.bridge.markOutbox, {
      outboxId,
      status: "sent" as const,
    });
    const held = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(held?.status).toBe("pending"); // hold preserved
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const end = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(end?.status).toBe("failed"); // re-queued, drained, dispatch attempted
  });

  test("BOUND: a second kill of the same row keeps the honest aborted card (no loop)", async () => {
    const t = convexTest(schema, modules);
    const { assistantId, outboxId } = await seedPreemptedTurn(t, {
      alreadyRedispatched: true,
    });
    await finalizePreempted(t, assistantId);
    const state = await t.run(async (ctx) => ({
      card: await ctx.db.get(assistantId),
      row: await ctx.db.get(outboxId),
    }));
    // Card kept (honest Interrompu), row untouched.
    expect(state.card?.status).toBe("aborted");
    expect(state.row?.status).toBe("sent");
  });

  test("CONTENT gate: an aborted turn with streamed text keeps its card (defense in depth)", async () => {
    const t = convexTest(schema, modules);
    const { assistantId, outboxId } = await seedPreemptedTurn(t);
    await finalizePreempted(t, assistantId, { text: "Un début de réponse" });
    const state = await t.run(async (ctx) => ({
      card: await ctx.db.get(assistantId),
      row: await ctx.db.get(outboxId),
    }));
    expect(state.card?.status).toBe("aborted");
    expect(state.card?.text).toBe("Un début de réponse");
    expect(state.row?.preemptRedispatched ?? false).toBe(false);
  });

  test("SUPERSEDED at fire time: a newer re-dispatch of the same message stands the flip down", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, userMsgId, assistantId, outboxId } =
      await seedPreemptedTurn(t);
    await finalizePreempted(t, assistantId);
    // A manual regenerate rebuilt a pending row for the SAME user message
    // during the delay window.
    await t.run(async (ctx) => {
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "regen-1",
        messageId: userMsgId,
        text: "Reprends la présentation et propose trois lignes.",
        attachmentIds: [],
        status: "pending" as const,
      });
    });
    await vi.advanceTimersByTimeAsync(11_000);
    await t.finishInProgressScheduledFunctions();
    const end = await t.run(async (ctx) => ctx.db.get(outboxId));
    // The original row never flips: the newer row owns the re-run.
    expect(end?.status).toBe("sent");
  });

  test("a replacement already SENT during the hold stands the flip down (no duplicate turn — codex P2)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, userMsgId, assistantId, outboxId } =
      await seedPreemptedTurn(t);
    await finalizePreempted(t, assistantId);
    // A manual regenerate rebuilt AND dispatched a row for the SAME user
    // message during the window — it is `sent` by the time the flip fires.
    await t.run(async (ctx) => {
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "regen-sent-1",
        messageId: userMsgId,
        text: "Reprends la présentation et propose trois lignes.",
        attachmentIds: [],
        status: "sent" as const,
      });
    });
    await vi.advanceTimersByTimeAsync(11_000);
    await t.finishInProgressScheduledFunctions();
    const end = await t.run(async (ctx) => ctx.db.get(outboxId));
    // Hold released to the inert terminal — never requeued behind the
    // replacement's reply.
    expect(end?.status).toBe("sent");
    expect(end?.preemptHold ?? undefined).toBeUndefined();
  });

  test("a DELETED user message stands the flip down (no resurrection)", async () => {
    const t = convexTest(schema, modules);
    const { userMsgId, assistantId, outboxId } = await seedPreemptedTurn(t);
    await finalizePreempted(t, assistantId);
    await t.run(async (ctx) => {
      await ctx.db.delete(userMsgId);
    });
    await vi.advanceTimersByTimeAsync(11_000);
    await t.finishInProgressScheduledFunctions();
    const end = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(end?.status).toBe("sent");
  });

  test("NO recent child = NO proof of the race: the aborted card stays (operator stop, codex P1)", async () => {
    // A gateway-side stop (CLI abort) has the same wire shape as the
    // preemption kill — without the delivery signature (a child/task recently
    // terminal or running) the recovery must NOT re-run the stopped turn.
    const t = convexTest(schema, modules);
    const { assistantId, outboxId } = await seedPreemptedTurn(t, {
      withoutRecentChild: true,
    });
    await finalizePreempted(t, assistantId);
    const state = await t.run(async (ctx) => ({
      card: await ctx.db.get(assistantId),
      row: await ctx.db.get(outboxId),
    }));
    expect(state.card?.status).toBe("aborted"); // honest Interrompu kept
    expect(state.row?.status).toBe("sent");
    expect(state.row?.preemptRedispatched ?? false).toBe(false);
  });

  test("a NORMAL abort (no flag) changes nothing — card kept, row untouched", async () => {
    const t = convexTest(schema, modules);
    const { assistantId, outboxId } = await seedPreemptedTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "aborted" as const,
    });
    const state = await t.run(async (ctx) => ({
      card: await ctx.db.get(assistantId),
      row: await ctx.db.get(outboxId),
    }));
    expect(state.card?.status).toBe("aborted");
    expect(state.row?.status).toBe("sent");
    expect(state.row?.preemptRedispatched ?? false).toBe(false);
  });
});
