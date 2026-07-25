/**
 * NO CHAT STAYS LOCKED — the reconciler's two obligations, which pull in opposite
 * directions:
 *
 *  1. it must ALWAYS release a lock nobody else will release (a `pending` outbox
 *     row makes its chat busy forever), and
 *  2. it must NEVER touch a dispatch that is still alive — failing a live turn
 *     would invent the very defect it exists to remove.
 *
 * Every test below pins one side or the other.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  STALLED_PENDING_MS,
  STALLED_UNSTAMPED_MS,
  DISPATCH_STALLED_CODE,
} from "./outboxReconcile";
import { STALE_STREAM_MS } from "./stuckStreams";

const modules = import.meta.glob("./**/*.ts");

const NOW = 10_000_000;

async function seedPending(
  t: ReturnType<typeof convexTest>,
  opts: {
    pendingSince?: number;
    preemptHold?: boolean;
    status?: "pending" | "queued" | "sent";
    /** The instance serving this chat (the deployment guard is scoped to it). */
    instanceName?: string;
  } = {},
): Promise<{ chatId: Id<"chats">; outboxId: Id<"outbox"> }> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", {
      userId,
      archived: false,
      updatedAt: NOW,
      instanceName: opts.instanceName ?? "inst",
    });
    const outboxId = await ctx.db.insert("outbox", {
      chatId,
      userId,
      clientMessageId: "cmid-1",
      text: "hello",
      attachmentIds: [],
      status: opts.status ?? "pending",
      ...(opts.pendingSince !== undefined
        ? { pendingSince: opts.pendingSince }
        : {}),
      ...(opts.preemptHold === true ? { preemptHold: true } : {}),
    });
    return { chatId, outboxId };
  });
}

/**
 * Establish that the bridge serving THIS INSTANCE writes dispatch correlations —
 * one earlier correlated turn from it is the proof the reconciler looks for. Called by every test that expects the normal (15-minute) bound:
 * without it the reconciler is deliberately conservative, because an older bridge
 * would leave real turns uncorrelated and they would be settled as failures.
 */
async function proveCorrelationSupport(
  t: ReturnType<typeof convexTest>,
  chatId: Id<"chats">,
  instanceName = "inst",
) {
  await t.run(async (ctx) => {
    const userId = (await ctx.db.get(chatId))!.userId;
    const other = await ctx.db.insert("outbox", {
      chatId,
      userId,
      clientMessageId: "unrelated",
      text: "an earlier, correlated turn",
      attachmentIds: [],
      status: "sent" as const,
      pendingSince: NOW,
    });
    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      runId: "webchat-earlier",
      dispatchOutboxId: other as string,
      // The stamp the guard reads: this INSTANCE's bridge writes correlations.
      boundInstance: instanceName,
      text: "done",
      updatedAt: NOW,
    });
  });
}

function rowOf(t: ReturnType<typeof convexTest>, outboxId: Id<"outbox">) {
  return t.run(async (ctx) => await ctx.db.get(outboxId));
}

function messagesOf(t: ReturnType<typeof convexTest>, chatId: Id<"chats">) {
  return t.run(async (ctx) => {
    const all = await ctx.db.query("messages").collect();
    return all.filter((m) => m.chatId === chatId);
  });
}

describe("outboxReconcile bounds", () => {
  test("the stalled bound stays ABOVE the stuck-stream watchdog", () => {
    // Load-bearing ordering, not a coincidence. The correlation proves a turn
    // OPENED, not that the provider accepted the prompt (Hermes WS opens the
    // streaming row before its submit ack, so the chat reads busy before /send
    // returns 200). A bridge dying in that window leaves a correlated row for a
    // prompt the agent never saw — and the only reason that is safe is that the
    // stuck-stream watchdog reaches it FIRST, terminating it with a visible error
    // and draining the queue. Invert these two and that turn would instead be
    // quietly booked as `sent` while still streaming.
    expect(STALLED_PENDING_MS).toBeGreaterThan(STALE_STREAM_MS);
    // …and the unstamped fallback is looser still.
    expect(STALLED_UNSTAMPED_MS).toBeGreaterThan(STALLED_PENDING_MS);
  });
});

describe("outboxReconcile.reconcileStalledOutbox", () => {
  test("a live dispatch is left alone (the whole risk of acting early)", async () => {
    const t = convexTest(schema, modules);
    // Stamped one second ago: a perfectly ordinary in-flight POST.
    const { chatId, outboxId } = await seedPending(t, { pendingSince: NOW - 1_000 });
    const res = await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, {
      now: NOW,
    });
    expect(res).toEqual({ scanned: 1, settled: 0 });
    expect((await rowOf(t, outboxId))?.status).toBe("pending");
    expect(await messagesOf(t, chatId)).toHaveLength(0); // no error card invented
  });

  test("a dispatch still inside the window — even a long one — is left alone", async () => {
    const t = convexTest(schema, modules);
    const { outboxId } = await seedPending(t, {
      pendingSince: NOW - (STALLED_PENDING_MS - 1),
    });
    await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, { now: NOW });
    expect((await rowOf(t, outboxId))?.status).toBe("pending");
  });

  test("a stalled dispatch is settled AND the conversation is unlocked", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seedPending(t, {
      pendingSince: NOW - STALLED_PENDING_MS,
    });
    await proveCorrelationSupport(t, chatId);
    // A follow-up the user parked behind the stuck dispatch: it must be released,
    // because THAT is what "unlocked" means for the person waiting.
    const queuedId = await t.run(async (ctx) => {
      const row = (await ctx.db.get(outboxId))!;
      return await ctx.db.insert("outbox", {
        chatId,
        userId: row.userId,
        clientMessageId: "cmid-2",
        text: "and this one too",
        attachmentIds: [],
        status: "queued" as const,
      });
    });
    const res = await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, {
      now: NOW,
    });
    expect(res.settled).toBe(1);
    expect((await rowOf(t, outboxId))?.status).toBe("failed");
    // The parked follow-up was promoted (the drain inside failDispatch) — the queue
    // moves again instead of waiting on a dispatch that will never return.
    const queued = await rowOf(t, queuedId);
    expect(queued?.status).toBe("pending");
    // …and the promotion stamped its OWN dispatch window, so the reconciler can
    // judge it later on its own merits.
    expect(typeof queued?.pendingSince).toBe("number");
    // The reader gets an honest card carrying the curated cause.
    const cards = (await messagesOf(t, chatId)).filter(
      (m) => m.errorCode === DISPATCH_STALLED_CODE,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.status).toBe("error");
  });

  test("an UNSTAMPED row waits far longer — a missed stamp must not fail a live turn", async () => {
    const t = convexTest(schema, modules);
    // No stamp at all. `_creationTime` is the only clock left, and it is the WRONG
    // one: a row promoted from a long `queued` wait carries an ancient creation
    // time while its dispatch has just started. So the fallback bound must be far
    // beyond any dispatch that could still be alive.
    const { outboxId } = await seedPending(t);
    const createdAt = (await rowOf(t, outboxId))!._creationTime;
    // Past the STAMPED bound — and deliberately not settled.
    const inBetween = await t.mutation(
      internal.outboxReconcile.reconcileStalledOutbox,
      { now: createdAt + STALLED_PENDING_MS + 1 },
    );
    expect(inBetween).toEqual({ scanned: 1, settled: 0 });
    expect((await rowOf(t, outboxId))?.status).toBe("pending");
    // Past the UNSTAMPED bound — the lock is released rather than kept forever.
    const later = await t.mutation(
      internal.outboxReconcile.reconcileStalledOutbox,
      { now: createdAt + STALLED_UNSTAMPED_MS + 1 },
    );
    expect(later.settled).toBe(1);
    expect((await rowOf(t, outboxId))?.status).toBe("failed");
  });

  test("a row that DID produce a turn is marked sent, never failed", async () => {
    // The assistant row carries the outbox id it was dispatched from, so this is a
    // fact: the dispatch ran and only its ack was lost. An error card here would sit
    // beside a real reply.
    const t = convexTest(schema, modules);
    for (const status of ["streaming", "complete"] as const) {
      const { chatId, outboxId } = await seedPending(t, {
        pendingSince: NOW - STALLED_PENDING_MS,
      });
      await proveCorrelationSupport(t, chatId);
      await t.run(async (ctx) => {
        const row = (await ctx.db.get(outboxId))!;
        await ctx.db.insert("messages", {
          chatId,
          userId: row.userId,
          role: "assistant" as const,
          status,
          runId: "webchat-1",
          dispatchOutboxId: outboxId as string,
          text: status === "complete" ? "the answer" : "",
          updatedAt: NOW,
        });
      });
      // A follow-up the user queued DURING that turn: the turn's own finalize drain
      // no-opped (this row was still `pending`), so if the reconciler does not drain
      // here nothing ever will — the conversation stays stuck one row further down.
      const queuedId = await t.run(async (ctx) => {
        const row = (await ctx.db.get(outboxId))!;
        return await ctx.db.insert("outbox", {
          chatId,
          userId: row.userId,
          clientMessageId: "cmid-follow",
          text: "queued during the turn",
          attachmentIds: [],
          status: "queued" as const,
        });
      });
      const res = await t.mutation(
        internal.outboxReconcile.reconcileStalledOutbox,
        { now: NOW },
      );
      expect(res.settled).toBe(0);
      expect((await rowOf(t, outboxId))?.status).toBe("sent");
      // Drained only once the correlated turn is no longer streaming — busy-guarded.
      expect((await rowOf(t, queuedId))?.status).toBe(
        status === "complete" ? "pending" : "queued",
      );
      const msgs = await messagesOf(t, chatId);
      expect(msgs.some((m) => m.errorCode === DISPATCH_STALLED_CODE)).toBe(false);
    }
  });

  test("a reconciled ROUTED dispatch confirms the routing it actually used", async () => {
    // The normal ack path calls confirmTurnRouting; a lost ack must not skip it, or
    // the chat's routing tuple stays at the PREVIOUS agent and a later return to that
    // agent reads as same-agent — reusing its session without rehydrating the reply
    // this turn produced.
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seedPending(t, {
      pendingSince: NOW - STALLED_PENDING_MS,
    });
    await proveCorrelationSupport(t, chatId);
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(outboxId))!;
      // A per-turn routed chat that had previously confirmed agent A.
      await ctx.db.patch(chatId, {
        perTurnRouting: true,
        lastRoutedAgentId: "agent-a",
        lastRoutedInstanceName: "inst",
        routingSegment: "turn:old",
      });
      await ctx.db.patch(outboxId, {
        routedAgent: { instanceName: "inst", agentId: "agent-b" },
        dispatchSegment: "turn:new",
      });
      // …and the turn DID run (correlated), only its ack was lost.
      await ctx.db.insert("messages", {
        chatId,
        userId: row.userId,
        role: "assistant" as const,
        status: "complete" as const,
        runId: "webchat-1",
        dispatchOutboxId: outboxId as string,
        text: "B's answer",
        updatedAt: NOW,
      });
    });
    await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, { now: NOW });
    const chat = await t.run(async (ctx) => await ctx.db.get(chatId));
    expect(chat?.lastRoutedAgentId).toBe("agent-b");
    expect(chat?.routingSegment).toBe("turn:new");
  });

  test("an EMPTY errored turn does not confirm routing (opened is not accepted)", async () => {
    // Hermes WS opens its streaming row before `prompt.submit`, so a correlated row
    // can belong to a prompt the provider never took — the watchdog then errors it.
    // Confirming from that would persist a FAILED switch as the chat's route.
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seedPending(t, {
      pendingSince: NOW - STALLED_PENDING_MS,
    });
    await proveCorrelationSupport(t, chatId);
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(outboxId))!;
      await ctx.db.patch(chatId, {
        perTurnRouting: true,
        lastRoutedAgentId: "agent-a",
        lastRoutedInstanceName: "inst",
        routingSegment: "turn:old",
      });
      await ctx.db.patch(outboxId, {
        routedAgent: { instanceName: "inst", agentId: "agent-b" },
        dispatchSegment: "turn:new",
      });
      await ctx.db.insert("messages", {
        chatId,
        userId: row.userId,
        role: "assistant" as const,
        status: "error" as const, // watchdog-terminated, never a frame
        runId: "webchat-1",
        dispatchOutboxId: outboxId as string,
        text: "",
        updatedAt: NOW,
      });
    });
    await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, { now: NOW });
    const chat = await t.run(async (ctx) => await ctx.db.get(chatId));
    // The tuple stays at the previously CONFIRMED agent — a later return to it
    // rehydrates instead of reusing a session that never received the prompt.
    expect(chat?.lastRoutedAgentId).toBe("agent-a");
    expect(chat?.routingSegment).toBe("turn:old");
  });

  test("an UNRELATED turn in the same chat is no excuse — the message is not swallowed", async () => {
    // A delivery run, a spontaneous talk turn, or another turn's reply: none of them
    // carries THIS row's dispatch id, so none of them proves this send ran. Marking
    // the row `sent` on that evidence would lose the user's message silently.
    const t = convexTest(schema, modules);
    for (const runId of [
      "image_generate:c3e21208-1111-4222-8333-444455556666:ok",
      "talk-abc",
      "webchat-someone-else",
    ]) {
      const { chatId, outboxId } = await seedPending(t, {
        pendingSince: NOW - STALLED_PENDING_MS,
      });
      await proveCorrelationSupport(t, chatId);
      await t.run(async (ctx) => {
        const row = (await ctx.db.get(outboxId))!;
        await ctx.db.insert("messages", {
          chatId,
          userId: row.userId,
          role: "assistant" as const,
          status: "streaming" as const,
          runId,
          text: "",
          updatedAt: NOW,
        });
      });
      await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, { now: NOW });
      expect((await rowOf(t, outboxId))?.status).toBe("failed");
      expect(
        (await messagesOf(t, chatId)).some(
          (m) => m.errorCode === DISPATCH_STALLED_CODE,
        ),
      ).toBe(true);
    }
  });

  test("a stalled PREEMPT HOLD is released — failDispatch alone refuses to touch it", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seedPending(t, {
      pendingSince: NOW - STALLED_PENDING_MS,
      preemptHold: true,
    });
    await proveCorrelationSupport(t, chatId);
    // Proof the hold is exactly what would keep the lock: the ordinary failure path
    // drops the write while the marker is set.
    await t.mutation(internal.bridge.failDispatch, {
      outboxId,
      reason: "send_failed",
    });
    expect((await rowOf(t, outboxId))?.status).toBe("pending");
    // The reconciler clears the marker (its owner is provably gone) and settles.
    const res = await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, {
      now: NOW,
    });
    expect(res.settled).toBe(1);
    const row = await rowOf(t, outboxId);
    expect(row?.status).toBe("failed");
    expect(row?.preemptHold).toBeUndefined();
    expect(
      (await messagesOf(t, chatId)).filter(
        (m) => m.errorCode === DISPATCH_STALLED_CODE,
      ),
    ).toHaveLength(1);
  });

  test("rows in other states are never candidates", async () => {
    const t = convexTest(schema, modules);
    const { outboxId: sentId } = await seedPending(t, {
      status: "sent",
      pendingSince: NOW - 10 * STALLED_PENDING_MS,
    });
    const { outboxId: queuedId } = await seedPending(t, {
      status: "queued",
      pendingSince: NOW - 10 * STALLED_PENDING_MS,
    });
    const res = await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, {
      now: NOW,
    });
    expect(res).toEqual({ scanned: 0, settled: 0 });
    expect((await rowOf(t, sentId))?.status).toBe("sent");
    // A queued row holds NOTHING (the chat is busy only on `pending`), and the
    // drain owns its promotion — reconciling it would fail a send never dispatched.
    expect((await rowOf(t, queuedId))?.status).toBe("queued");
  });

  test("a crowd of UNSTAMPED rows cannot starve a stalled stamped one", async () => {
    // Absent `pendingSince` sorts before every number, so a single bounded scan
    // ordered by that field would refill itself with young legacy rows every run and
    // never reach the stamped row behind them — the guarantee would hold on paper
    // and fail in a migration window.
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seedPending(t, {
      pendingSince: NOW - STALLED_PENDING_MS,
    });
    await proveCorrelationSupport(t, chatId);
    // 120 unstamped rows (> SCAN_LIMIT), all YOUNG by their own longer bound.
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(outboxId))!;
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert("outbox", {
          chatId: row.chatId,
          userId: row.userId,
          clientMessageId: `legacy-${i}`,
          text: "legacy",
          attachmentIds: [],
          status: "pending" as const,
        });
      }
    });
    const res = await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, {
      now: NOW,
    });
    // The stalled STAMPED row is settled on this very run, not "eventually".
    expect(res.settled).toBe(1);
    expect((await rowOf(t, outboxId))?.status).toBe("failed");
    expect(
      (await messagesOf(t, chatId)).some(
        (m) => m.errorCode === DISPATCH_STALLED_CODE,
      ),
    ).toBe(true);
  });

  test("a settled row can no longer OPEN a turn (the late bridge handler)", async () => {
    // Aborting the Convex POST does not cancel the bridge's handler. One blocked past
    // the reconciliation window could reach `startAssistant` after the row was failed,
    // the user told, and the next queued send drained — starting that turn would
    // overlap two turns on one session and put a reply under an error card.
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seedPending(t, {
      pendingSince: NOW - STALLED_PENDING_MS,
    });
    await proveCorrelationSupport(t, chatId);
    await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, { now: NOW });
    expect((await rowOf(t, outboxId))?.status).toBe("failed");
    await expect(
      t.mutation(internal.stream.startAssistant, {
        chatId,
        runId: "webchat-late",
        dispatchOutboxId: outboxId as string,
      }),
    ).rejects.toThrow(/already reconciled/i);
    // Only the reconciler's own card exists — no orphan streaming row was opened.
    const msgs = await messagesOf(t, chatId);
    expect(msgs.filter((m) => m.status === "streaming")).toHaveLength(0);
    // …and a dispatch that is NOT settled still opens normally.
    const { chatId: liveChat, outboxId: liveRow } = await seedPending(t, {
      pendingSince: NOW - 1_000,
    });
    await expect(
      t.mutation(internal.stream.startAssistant, {
        chatId: liveChat,
        runId: "webchat-ok",
        dispatchOutboxId: liveRow as string,
      }),
    ).resolves.toBeTruthy();
  });

  test("an OLDER bridge (no correlation anywhere) is not trusted to the short bound", async () => {
    // Convex and the bridge ship separately. A bridge that predates the correlation
    // opens every turn UNCORRELATED, so the lookup finds nothing and a real, answered
    // turn would be settled as a failure. Until one turn proves the capability, the
    // destructive decision waits for the far longer bound — the lock is still broken,
    // just later, and by then the stuck-stream watchdog has already told the user.
    const t = convexTest(schema, modules);
    const { outboxId } = await seedPending(t, {
      pendingSince: NOW - STALLED_PENDING_MS,
    });
    const early = await t.mutation(
      internal.outboxReconcile.reconcileStalledOutbox,
      { now: NOW },
    );
    expect(early.settled).toBe(0);
    expect((await rowOf(t, outboxId))?.status).toBe("pending");
    // The guarantee still holds at the conservative bound.
    const later = await t.mutation(
      internal.outboxReconcile.reconcileStalledOutbox,
      { now: NOW + (STALLED_UNSTAMPED_MS - STALLED_PENDING_MS) },
    );
    expect(later.settled).toBe(1);
    expect((await rowOf(t, outboxId))?.status).toBe("failed");
  });

  test("another INSTANCE's correlated turn does NOT vouch for this row", async () => {
    // Rolling deployment + per-turn routing: an upgraded bridge on instance B must
    // not license the short destructive bound for a row routed to instance A, still
    // served by an older one.
    const t = convexTest(schema, modules);
    const { chatId: otherChat } = await seedPending(t, {
      status: "sent",
      instanceName: "other",
    });
    await proveCorrelationSupport(t, otherChat, "other");
    const { outboxId } = await seedPending(t, {
      pendingSince: NOW - STALLED_PENDING_MS,
    });
    const res = await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, {
      now: NOW,
    });
    expect(res.settled).toBe(0);
    expect((await rowOf(t, outboxId))?.status).toBe("pending");
  });

  test("a row ROUTED to an un-upgraded instance keeps the conservative bound", async () => {
    // The per-turn router can send this turn to a DIFFERENT instance than the chat's
    // own: the guard must follow the routed target, not the chat.
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seedPending(t, {
      pendingSince: NOW - STALLED_PENDING_MS,
      instanceName: "inst",
    });
    await proveCorrelationSupport(t, chatId, "inst"); // the chat's own instance is fine
    await t.run(async (ctx) => {
      // …but THIS turn is routed elsewhere, to a bridge that has never correlated.
      await ctx.db.patch(outboxId, {
        routedAgent: { instanceName: "legacy", agentId: "a" },
      });
    });
    const res = await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, {
      now: NOW,
    });
    expect(res.settled).toBe(0);
    expect((await rowOf(t, outboxId))?.status).toBe("pending");
  });

  test("running twice settles nothing twice (idempotent, no duplicate cards)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedPending(t, {
      pendingSince: NOW - STALLED_PENDING_MS,
    });
    await proveCorrelationSupport(t, chatId);
    await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, { now: NOW });
    const second = await t.mutation(
      internal.outboxReconcile.reconcileStalledOutbox,
      { now: NOW },
    );
    expect(second).toEqual({ scanned: 0, settled: 0 });
    // ONE card, not two — the settle never double-fires.
    expect(
      (await messagesOf(t, chatId)).filter(
        (m) => m.errorCode === DISPATCH_STALLED_CODE,
      ),
    ).toHaveLength(1);
  });
});
