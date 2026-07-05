/// <reference types="vite/client" />
//
// Hybrid rehydration — engine tests (docs/design/hybrid-rehydration.md):
// the rolling-summary scheduler (guards + dispatch effects), the correlate/failure
// paths, invalidation on deletion, and the rehydrationContext integration (summary
// + verbatim-after-watermark). The PURE composer is covered separately in
// rehydrationCompose.test.ts; this file exercises the Convex wiring around it.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import {
  correlateSummarize,
  failSummarizeForChat,
  invalidateSummaryOnDeletion,
  purgeSummaryForChat,
} from "./chatSummaries";
import { enrichUserAgents } from "./agents";
import { resolveTargetForChat, resolveTargetForTurn } from "./routing";
import { parseInstanceConfig } from "./lib/instanceConfig";
import {
  CHUNK_MIN_CHARS,
  KEEP_RECENT_MAX_MESSAGES,
  SUMMARY_MAX_CHARS,
  freshTailCount,
} from "./lib/rehydration";
import { effectiveOrder } from "./lib/messageOrder";

const modules = import.meta.glob("./**/*.ts");

/** convex-test handle WITH schema typing (the erased default loses withIndex types). */
type Tt = TestConvex<typeof schema>;

/** A message long enough that a handful of them crosses CHUNK_MIN_CHARS. */
const LONG = "x".repeat(1_200);

async function setup(
  t: Tt,
  opts?: {
    messages?: number;
    injectionEnabled?: boolean;
    text?: string;
  },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "u",
    });
    await ctx.db.insert("instances", {
      name: "primary",
      gatewayUrl: "ws://gw",
      ...(opts?.injectionEnabled === false
        ? {
            config: {
              promptInjections: { history_summary: { enabled: false } },
            },
          }
        : {}),
    });
    // The serving bridge advertises the turn-session echo (the engine refuses
    // to dispatch otherwise). Tests that exercise the kill-switch PATCH this row.
    const compat = await ctx.db
      .query("bridgeCompat")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .unique();
    if (!compat) {
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
    }
    // The bound agent must be DISCOVERED for the routing resolution (the engine
    // now validates the binding exactly like dispatch); the groupless user is
    // entitled via the all-pool.
    await ctx.db.insert("agents", {
      instanceName: "primary",
      agentId: "olivier",
      source: "discovered" as const,
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      instanceName: "primary",
      agentId: "olivier",
      updatedAt: 1,
    });
    const messageIds: Id<"messages">[] = [];
    const n = opts?.messages ?? 24;
    for (let i = 0; i < n; i++) {
      messageIds.push(
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
          status: "complete" as const,
          text: `${i === n - 1 ? "NEWEST" : `m${i}`} ${opts?.text ?? LONG}`,
          updatedAt: 1,
        }),
      );
    }
    return { userId, chatId, messageIds };
  });
}

function schedule(t: Tt, chatId: Id<"chats">) {
  return t.mutation(internal.chatSummaries.maybeScheduleSummarize, { chatId });
}

async function hiddenChat(
  t: Tt,
  userId: Id<"users">,
): Promise<Doc<"chats"> | null> {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("chats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("kind"), "summarizer"))
      .first();
  });
}

async function summaryRow(
  t: Tt,
  chatId: Id<"chats">,
): Promise<Doc<"chatSummaries"> | null> {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("chatSummaries")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
  });
}

describe("chatSummaries.maybeScheduleSummarize", () => {
  test("dispatches a summarize job: hidden chat + lock + outbox + prompt content", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await schedule(t, chatId);

    const hidden = await hiddenChat(t, userId);
    expect(hidden).not.toBeNull();
    expect(hidden!.kind).toBe("summarizer");
    // Bound to the TARGET chat's own agent (content never crosses agent boundaries).
    expect(hidden!.agentId).toBe("olivier");
    expect(hidden!.instanceName).toBe("primary");
    // Fresh gateway session per job.
    expect(hidden!.openclawChatId).toMatch(new RegExp(`^summarize:${chatId}:`));
    // The job lock, targeting the conversational chat.
    expect(hidden!.pendingSummarize?.targetChatId).toBe(chatId);
    expect(hidden!.pendingSummarize!.coveredCountTarget).toBeGreaterThan(0);

    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden!._id).eq("status", "pending"),
        )
        .collect();
      expect(outbox).toHaveLength(1);
      // The prompt: injection framing + first-summary marker + the OLDEST chunk
      // content — and NEVER the newest turns (they stay verbatim-fresh).
      const text = outbox[0]!.text;
      expect(text).toContain("[SYNTHÈSE DE CONVERSATION]");
      expect(text).toContain("aucun — première synthèse");
      expect(text).toContain("m0");
      expect(text).not.toContain("NEWEST");
    });
  });

  test("keeps the size-based fresh tail out of the chunk", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, { messages: 20 });
    await schedule(t, chatId);
    const hidden = await hiddenChat(t, userId);
    expect(hidden?.pendingSummarize).toBeDefined();
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      // The fresh tail is SIZE-based (helper-pinned separately): the watermark
      // target must be exactly the last message BEFORE the tail.
      const desc = [...chrono].reverse();
      const tail = freshTailCount(desc);
      expect(tail).toBeGreaterThanOrEqual(4);
      const lastChunk = chrono[chrono.length - tail - 1]!;
      expect(hidden!.pendingSummarize!.watermarkTarget).toBe(
        effectiveOrder(lastChunk),
      );
    });
  });

  test("below CHUNK_MIN_CHARS -> no dispatch", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, { messages: 16, text: "court." });
    await schedule(t, chatId);
    expect(await hiddenChat(t, userId)).toBeNull();
  });

  test("injection disabled -> the job STILL dispatches, with the bare material only", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, { injectionEnabled: false });
    await schedule(t, chatId);
    const hidden = await hiddenChat(t, userId);
    expect(hidden?.pendingSummarize).toBeDefined();
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden!._id).eq("status", "pending"),
        )
        .collect();
      const text = outbox[0]!.text;
      // Atrium's framing is gone; the material remains (the dedicated agent's own
      // briefing carries the instructions).
      expect(text).not.toContain("[SYNTHÈSE DE CONVERSATION]");
      expect(text).toContain("[NOUVEAUX MESSAGES]");
      expect(text).toContain("m0");
    });
  });

  test("the FEATURE switch is the instance rehydration config: OFF -> no dispatch", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      const inst = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", "primary"))
        .first();
      await ctx.db.patch(inst!._id, { config: { rehydration: false } });
    });
    await schedule(t, chatId);
    expect(await hiddenChat(t, userId)).toBeNull();
  });

  test("a DEDICATED summarizer agent (type, same instance, granted) owns the job", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "resumeur",
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
        types: ["summarizer"],
      });
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "primary",
        agentId: "resumeur",
        isDefault: false,
        source: "manual" as const,
        createdAt: 1,
      });
      // A DIRECT grant restricts the effective set to direct-only (cascade):
      // keep the conversational agent granted too, like a real admin would.
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "primary",
        agentId: "olivier",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
    });
    await schedule(t, chatId);
    const hidden = await hiddenChat(t, userId);
    expect(hidden?.pendingSummarize).toBeDefined();
    expect(hidden!.agentId).toBe("resumeur");
    expect(hidden!.instanceName).toBe("primary");
  });

  test("a job already in flight -> no second dispatch (serialization)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await schedule(t, chatId);
    const before = await hiddenChat(t, userId);
    const lock = before!.pendingSummarize!;
    await schedule(t, chatId);
    const after = await hiddenChat(t, userId);
    // Same lock object — the second call did not dispatch/replace.
    expect(after!.pendingSummarize).toEqual(lock);
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", before!._id).eq("status", "pending"),
        )
        .collect();
      expect(outbox).toHaveLength(1);
    });
  });

  test("failure backoff (nextEligibleAt in the future) -> no dispatch", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "",
        watermarkOrderTime: 0,
        coveredCount: 0,
        updatedAt: 1,
        failureCount: 3,
        nextEligibleAt: Date.now() + 60_000,
      });
    });
    await schedule(t, chatId);
    expect(await hiddenChat(t, userId)).toBeNull();
  });

  test("hidden utility chats are never summarized themselves", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, { kind: "documentary" as const });
    });
    await schedule(t, chatId);
    expect(await hiddenChat(t, userId)).toBeNull();
  });
});

describe("chatSummaries.correlateSummarize", () => {
  async function dispatched(t: Tt) {
    const s = await setup(t);
    await schedule(t, s.chatId);
    const hidden = (await hiddenChat(t, s.userId))!;
    return { ...s, hidden };
  }

  function replyOnHidden(
    t: Tt,
    hidden: Doc<"chats">,
    text: string,
    status: "complete" | "error" = "complete",
  ) {
    const lock = hidden.pendingSummarize!;
    return t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId: hidden.userId,
        role: "assistant" as const,
        status,
        text,
        // The bridge echo (nonce-or-nothing correlation).
        turnSessionKey: `agent:olivier:atrium:chat:u:summarize-${lock.targetChatId}-${lock.createdAt}`,
        updatedAt: Date.now(),
      });
      return (await ctx.db.get(id))!;
    });
  }

  test("success: stores the summary, advances the watermark, clears the lock", async () => {
    const t = convexTest(schema, modules);
    const { chatId, hidden, userId } = await dispatched(t);
    const lock = hidden.pendingSummarize!;
    const reply = await replyOnHidden(t, hidden, "Résumé : le projet avance.");
    await t.run(async (ctx) => {
      await correlateSummarize(ctx, (await ctx.db.get(hidden._id))!, reply);
    });
    const row = await summaryRow(t, chatId);
    expect(row?.summary).toBe("Résumé : le projet avance.");
    expect(row?.watermarkOrderTime).toBe(lock.watermarkTarget);
    expect(row?.coveredCount).toBe(lock.coveredCountTarget);
    expect(row?.failureCount).toBe(0);
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeUndefined();
  });

  test("an over-long reply is clamped to SUMMARY_MAX_CHARS", async () => {
    const t = convexTest(schema, modules);
    const { chatId, hidden } = await dispatched(t);
    const reply = await replyOnHidden(t, hidden, "mot ".repeat(3_000));
    await t.run(async (ctx) => {
      await correlateSummarize(ctx, (await ctx.db.get(hidden._id))!, reply);
    });
    const row = await summaryRow(t, chatId);
    expect(row!.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 1);
    expect(row!.summary.endsWith("…")).toBe(true);
  });

  test("error finalize: failure backoff, summary NOT stored, lock cleared", async () => {
    const t = convexTest(schema, modules);
    const { chatId, hidden, userId } = await dispatched(t);
    const reply = await replyOnHidden(t, hidden, "boom", "error");
    await t.run(async (ctx) => {
      await correlateSummarize(ctx, (await ctx.db.get(hidden._id))!, reply);
    });
    const row = await summaryRow(t, chatId);
    expect(row?.summary).toBe("");
    expect(row?.failureCount).toBe(1);
    expect(row!.nextEligibleAt).toBeGreaterThan(Date.now());
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeUndefined();
  });

  test("target chat deleted mid-job: lock cleared, nothing stored", async () => {
    const t = convexTest(schema, modules);
    const { chatId, hidden, userId } = await dispatched(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(chatId);
    });
    const reply = await replyOnHidden(t, hidden, "résumé orphelin");
    await t.run(async (ctx) => {
      await correlateSummarize(ctx, (await ctx.db.get(hidden._id))!, reply);
    });
    expect(await summaryRow(t, chatId)).toBeNull();
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeUndefined();
  });

  test("failSummarizeForChat (dispatch error / stuck): backoff + lock cleared", async () => {
    const t = convexTest(schema, modules);
    const { chatId, hidden, userId } = await dispatched(t);
    await t.run(async (ctx) => {
      await failSummarizeForChat(
        ctx,
        (await ctx.db.get(hidden._id))!,
        "dispatch_error",
      );
    });
    const row = await summaryRow(t, chatId);
    expect(row?.failureCount).toBe(1);
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeUndefined();
  });
});

describe("codex round-2 hardening", () => {
  test("a backlog WIDER than any read window starts at the true oldest (no watermark jump)", async () => {
    const t = convexTest(schema, modules);
    // 300 unsummarized messages — wider than CHUNK_READ_WINDOW (240).
    const { userId, chatId } = await setup(t, {
      messages: 300,
      text: "y".repeat(80),
    });
    await schedule(t, chatId);
    const hidden = await hiddenChat(t, userId);
    expect(hidden?.pendingSummarize).toBeDefined();
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden!._id).eq("status", "pending"),
        )
        .collect();
      // The chunk starts at the TRUE oldest message — never mid-history.
      expect(outbox[0]!.text).toContain("m0 ");
      expect(outbox[0]!.text).not.toContain("NEWEST");
      // And the watermark target stays strictly below the fresh-tail cutoff.
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      // Tiny messages: the size-based tail hits its COUNT cap.
      const cutoff = chrono[chrono.length - KEEP_RECENT_MAX_MESSAGES]!;
      expect(hidden!.pendingSummarize!.watermarkTarget).toBeLessThan(
        effectiveOrder(cutoff),
      );
    });
  });

  test("the injection toggle does NOT gate USING a stored summary (framing-only)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await setup(t, {
      messages: 4,
      text: "contenu.",
      injectionEnabled: false,
    });
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "résumé qui ne doit plus servir",
        watermarkOrderTime: effectiveOrder(chrono[1]!),
        coveredCount: 2,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
    });
    const r = await t.query(internal.stream.rehydrationContext, { chatId });
    expect(r.summaryUsed).toBe(true);
    expect(r.history).toContain("résumé qui ne doit plus servir");
    // Covered turns stay summarized; uncovered ones ride verbatim.
    expect(r.history).not.toContain("m0 contenu.");
    expect(r.turnCount).toBe(2);
  });

  test("releasing a poisoned job PURGES its undispatched prompt + outbox (privacy)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await schedule(t, chatId);
    const hidden = (await hiddenChat(t, userId))!;
    const target = hidden.pendingSummarize!.watermarkTarget;
    await t.run(async (ctx) => {
      await invalidateSummaryOnDeletion(ctx, chatId, userId, target);
    });
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", hidden._id))
        .collect();
      expect(msgs).toHaveLength(0); // the prompt (a copy of deleted content) is gone
      const pending = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden._id).eq("status", "pending"),
        )
        .collect();
      expect(pending).toHaveLength(0); // never reaches the agent
    });
  });

  test("cleanupSummarizerChat sweeps settled rows but never a live job's", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await schedule(t, chatId);
    const hidden = (await hiddenChat(t, userId))!;
    // Live job -> the sweep must be a no-op.
    await t.mutation(internal.chatSummaries.cleanupSummarizerChat, {
      hiddenChatId: hidden._id,
    });
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", hidden._id))
        .collect();
      expect(msgs.length).toBeGreaterThan(0);
    });
    // Release the lock -> the sweep clears the settled rows.
    await t.run(async (ctx) => {
      await ctx.db.patch(hidden._id, { pendingSummarize: undefined });
    });
    await t.mutation(internal.chatSummaries.cleanupSummarizerChat, {
      hiddenChatId: hidden._id,
    });
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", hidden._id))
        .collect();
      expect(msgs).toHaveLength(0);
    });
  });
});

describe("codex round-3 hardening", () => {
  test("a LATE reply of a released job is swept at its finalize (deleted-content retention)", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await setup(t);
      await schedule(t, chatId);
      const hidden = (await hiddenChat(t, userId))!;
      const target = hidden.pendingSummarize!.watermarkTarget;
      // The job's reply is STREAMING when a deletion releases the job.
      const replyId = await t.run(async (ctx) => {
        return await ctx.db.insert("messages", {
          chatId: hidden._id,
          userId,
          role: "assistant" as const,
          status: "streaming" as const,
          text: "",
          updatedAt: Date.now(),
        });
      });
      await t.run(async (ctx) => {
        await invalidateSummaryOnDeletion(ctx, chatId, userId, target);
      });
      // Late finalize: no lock anymore -> the hook must SWEEP, not correlate.
      await t.mutation(internal.stream.finalize, {
        messageId: replyId,
        status: "complete",
        text: "résumé de contenu supprimé",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await t.run(async (ctx) => {
        const msgs = await ctx.db
          .query("messages")
          .withIndex("by_chat", (q) => q.eq("chatId", hidden._id))
          .collect();
        expect(msgs).toHaveLength(0); // the orphan summary is gone
      });
      // And the orphan reply was NOT stored as a summary (no row, or an empty one).
      const row = await summaryRow(t, chatId);
      expect(row?.summary ?? "").toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a queued follow-up (orderTime > _creationTime) keeps the chunk in LOGICAL order", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, { messages: 20 });
    // Simulate a mid-turn QUEUED follow-up: inserted EARLY (low _creationTime)
    // but logically AFTER everything (orderTime far in the future of the chunk).
    const lateOrder = Date.now() + 10_000;
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      // Retro-stamp an EARLY-created message with a LATE orderTime (the queued shape).
      await ctx.db.patch(chrono[2]!._id, { orderTime: lateOrder });
    });
    await schedule(t, chatId);
    const hidden = await hiddenChat(t, userId);
    expect(hidden?.pendingSummarize).toBeDefined();
    // watermarkTarget must be >= EVERY included message's effectiveOrder — the
    // retro-ordered row either sorts LAST inside the chunk (watermark = its order)
    // or is excluded; unsorted _creationTime order would leave watermark BELOW it
    // while its content already shipped (double-summarize next job).
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden!._id).eq("status", "pending"),
        )
        .collect();
      const prompt = outbox[0]!.text;
      const wm = hidden!.pendingSummarize!.watermarkTarget;
      if (prompt.includes("m2 ")) {
        expect(wm).toBeGreaterThanOrEqual(lateOrder);
        // And logically LAST in the rendered chunk.
        expect(prompt.lastIndexOf("m2 ")).toBeGreaterThan(prompt.indexOf("m7 "));
      } else {
        expect(wm).toBeLessThan(lateOrder);
      }
    });
  });
});

describe("codex round: kill-switch + utility-agent isolation", () => {
  test("the bridge env kill-switch (rehydrationDefault:false) blocks dispatch", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      const c = await ctx.db
        .query("bridgeCompat")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique();
      await ctx.db.patch(c!._id, { rehydrationDefault: false });
    });
    await schedule(t, chatId);
    expect(await hiddenChat(t, userId)).toBeNull();
  });

  test("an explicit instance rehydration:true OVERRIDES the env kill-switch", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      const c = await ctx.db
        .query("bridgeCompat")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique();
      await ctx.db.patch(c!._id, { rehydrationDefault: false });
      const inst = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", "primary"))
        .first();
      await ctx.db.patch(inst!._id, { config: { rehydration: true } });
    });
    await schedule(t, chatId);
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeDefined();
  });

  test("a summarizer-ONLY agent is hidden from the user pool and refused by routing", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "resumeur",
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
        types: ["summarizer"],
      });
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "primary",
        agentId: "resumeur",
        isDefault: false,
        source: "manual" as const,
        createdAt: 1,
      });
    });
    // Hidden from the chat surfaces (picker / chip / multiAgent count).
    await t.run(async (ctx) => {
      const pool = await enrichUserAgents(ctx, userId);
      expect(pool.some((a) => a.agentId === "resumeur")).toBe(false);
    });
    // Refused as a per-turn pick (defense against a forged/stale selection).
    await t.run(async (ctx) => {
      const chat = (await ctx.db.get(chatId))!;
      const r = await resolveTargetForTurn(ctx, chat, userId, {
        instanceName: "primary",
        agentId: "resumeur",
      });
      expect(r.failReason).toBe("agent_restricted");
      expect(r.target).toBeNull();
    });
  });
});

describe("no false gap marker when the probe's bonus row is summary-covered", () => {
  test("exactly TAIL_READ uncovered turns after the watermark -> no marker", async () => {
    const t = convexTest(schema, modules);
    // 84 messages; the summary covers the first 4 -> exactly 80 uncovered.
    const { chatId } = await setup(t, { messages: 84, text: "contenu." });
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "couvre m0..m3",
        watermarkOrderTime: effectiveOrder(chrono[3]!),
        coveredCount: 4,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
    });
    const r = await t.query(internal.stream.rehydrationContext, { chatId });
    expect(r.summaryUsed).toBe(true);
    expect(r.turnCount).toBe(80);
    // The covered rows are REPRESENTED by the summary — nothing is omitted.
    expect(r.history).not.toContain("omis");
  });
});

describe("few-huge-messages conversations (the gauge-stuck-at-0 report)", () => {
  test("a conversation of a few HUGE turns is summarizable: gauge > 0 AND manual dispatches", async () => {
    const t = convexTest(schema, modules);
    // 8 × 10k-char digests: under the old count-based tail (12) everything was
    // fresh -> gauge 0 + nothing_to_do forever, despite ~80k chars of history.
    const { userId, chatId } = await setup(t, {
      messages: 8,
      text: "d".repeat(10_000),
    });
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    const gauge = await asOwner.query(api.chatSummaries.getChatSummary, {
      chatId,
    });
    expect(gauge?.pendingChars).toBeGreaterThan(10_000);
    const r = await asOwner.mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(r.outcome).toBe("dispatched");
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeDefined();
  });
});

describe("sub-agent results ARE conversation content (gauge-stuck round 3, live-diagnosed)", () => {
  async function seedSubAgentTurn(
    t: Tt,
    chatId: Id<"chats">,
    userId: Id<"users">,
    opts?: { status?: "running" | "done"; result?: string },
  ) {
    return await t.run(async (ctx) => {
      // The sessions_spawn shape: user asks, the parent assistant reply is EMPTY,
      // the content is the CHILD's final answer.
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Via un sub agent cherche les 10 news IA",
        updatedAt: 1,
      });
      const parentId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 1,
      });
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: parentId,
        childSessionKey: `agent:olivier:subagent:${parentId}`,
        taskName: "veille IA",
        status: (opts?.status ?? "done") as "done",
        resultText: opts?.result ?? "d".repeat(20_000),
        createdAt: 1,
        updatedAt: 1,
      });
      return parentId;
    });
  }

  test("gauge + manual trigger SEE the children's digests (empty parent text)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, { messages: 4, text: "petit." });
    // TWO digest turns (the user's real shape): 2 × 8k-capped results = 16k of
    // enriched content — the 12k fresh tail keeps the newest, the OLDER digest
    // becomes summarizable.
    await seedSubAgentTurn(t, chatId, userId);
    await seedSubAgentTurn(t, chatId, userId);
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    const gauge = await asOwner.query(api.chatSummaries.getChatSummary, {
      chatId,
    });
    expect(gauge?.pendingChars).toBeGreaterThan(3_000);
    const r = await asOwner.mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(r.outcome).toBe("dispatched");
    const hidden = (await hiddenChat(t, userId))!;
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden._id).eq("status", "pending"),
        )
        .collect();
      expect(outbox[0]!.text).toContain("Résultat du sous-agent « veille IA »");
      expect(outbox[0]!.text).toContain("ddddd");
    });
  });

  test("rehydration carries the child's answer (a reset no longer loses it)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId } = await setup(t, { messages: 2, text: "petit." });
    await seedSubAgentTurn(t, chatId, userId, { result: "réponse du sous-agent" });
    const r = await t.query(internal.stream.rehydrationContext, { chatId });
    expect(r.history).toContain("Résultat du sous-agent « veille IA »");
    expect(r.history).toContain("réponse du sous-agent");
  });

  test("MANUAL request with the oldest turn's child still running -> nothing_to_do (no crash)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, { messages: 24 });
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: chrono[0]!._id,
        childSessionKey: "agent:olivier:subagent:y",
        status: "running" as const,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    const r = await asOwner.mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(r.outcome).toBe("nothing_to_do");
  });

  test("a RUNNING child blocks the watermark from passing its parent", async () => {
    const t = convexTest(schema, modules);
    // Enough backlog to dispatch…
    const { userId, chatId } = await setup(t, { messages: 24 });
    // …but the OLDEST unsummarized turn has a child still running: nothing before
    // it may be skipped, so the chunk stops empty -> no dispatch yet.
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: chrono[0]!._id,
        childSessionKey: "agent:olivier:subagent:x",
        status: "running" as const,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await schedule(t, chatId);
    expect(await hiddenChat(t, userId)).toBeNull();
  });
});

describe("short conversation with one giant digest (gauge-stuck round 2)", () => {
  test("the digest becomes summarizable: gauge > 0 and manual dispatches", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, { messages: 1, text: "intro" });
    await t.run(async (ctx) => {
      const texts = ["g".repeat(30_000), "petite question", "petite réponse"];
      for (const text of texts) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user" as const,
          status: "complete" as const,
          text,
          updatedAt: 1,
        });
      }
    });
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    const gauge = await asOwner.query(api.chatSummaries.getChatSummary, {
      chatId,
    });
    expect(gauge?.pendingChars).toBeGreaterThan(29_000);
    const r = await asOwner.mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(r.outcome).toBe("dispatched");
  });
});

describe("configurable threshold + gauge data", () => {
  test("a LOWER per-instance threshold makes the auto path dispatch sooner", async () => {
    const t = convexTest(schema, modules);
    // 20 short-ish messages: ~2.4k chars pending — below the 8k default…
    const { userId, chatId } = await setup(t, {
      messages: 20 + KEEP_RECENT_MAX_MESSAGES,
      text: "x".repeat(100),
    });
    await schedule(t, chatId);
    expect(await hiddenChat(t, userId)).toBeNull(); // default threshold: skip
    // …but above an admin-lowered 2k threshold.
    await t.run(async (ctx) => {
      const inst = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", "primary"))
        .first();
      await ctx.db.patch(inst!._id, {
        config: { summarizeThresholdChars: 2_000 },
      });
    });
    await schedule(t, chatId);
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeDefined();
  });

  test("getChatSummary exposes the gauge (pending vs the RESOLVED threshold)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, {
      messages: 6 + KEEP_RECENT_MAX_MESSAGES,
      text: "y".repeat(200),
    });
    await t.run(async (ctx) => {
      const inst = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", "primary"))
        .first();
      await ctx.db.patch(inst!._id, {
        config: { summarizeThresholdChars: 5_000 },
      });
    });
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    const r = await asOwner.query(api.chatSummaries.getChatSummary, { chatId });
    expect(r?.thresholdChars).toBe(5_000);
    // 6 chunkable messages × ~214 chars ≈ 1.3k pending (the fresh tail excluded).
    expect(r?.pendingChars).toBeGreaterThan(1_000);
    expect(r?.pendingChars).toBeLessThan(2_000);
    expect(r?.pendingApprox).toBe(false);
  });

  test("a SINGLE giant turn is truncated to the per-job bound", async () => {
    const t = convexTest(schema, modules);
    // One 40k-char message beyond the fresh tail: the job must stay bounded.
    const { userId, chatId } = await setup(t, { messages: 1, text: "g".repeat(40_000) });
    await t.run(async (ctx) => {
      for (let i = 0; i < KEEP_RECENT_MAX_MESSAGES; i++) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user" as const,
          status: "complete" as const,
          text: `tail ${i}`,
          updatedAt: 1,
        });
      }
    });
    await schedule(t, chatId);
    const hidden = await hiddenChat(t, userId);
    expect(hidden?.pendingSummarize).toBeDefined();
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden!._id).eq("status", "pending"),
        )
        .collect();
      // Prompt = template + truncated chunk: well under the raw 40k.
      expect(outbox[0]!.text.length).toBeLessThan(26_000);
      expect(outbox[0]!.text).toContain("…");
    });
  });

  test("a threshold ABOVE the per-job chunk cap still triggers (uncapped backlog gate)", async () => {
    const t = convexTest(schema, modules);
    // Threshold 30k > CHUNK_MAX (24k): the per-job-capped counter could never
    // reach it — the gate must compare the UNCAPPED backlog.
    const { userId, chatId } = await setup(t, {
      messages: 40,
      text: "b".repeat(1_200),
    });
    await t.run(async (ctx) => {
      const inst = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", "primary"))
        .first();
      await ctx.db.patch(inst!._id, {
        config: { summarizeThresholdChars: 30_000 },
      });
    });
    await schedule(t, chatId);
    // Backlog ≈ 36×1.2k ≈ 43k ≥ 30k -> dispatches (chunk itself stays ≤ 24k).
    const hidden = await hiddenChat(t, userId);
    expect(hidden?.pendingSummarize).toBeDefined();
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden!._id).eq("status", "pending"),
        )
        .collect();
      expect(outbox[0]!.text.length).toBeLessThan(26_000); // per-job bound intact
    });
  });

  test("parseInstanceConfig bounds the threshold", () => {
    expect(parseInstanceConfig({ summarizeThresholdChars: 500 })).toBe("invalid");
    expect(parseInstanceConfig({ summarizeThresholdChars: 250_000 })).toBe(
      "invalid",
    );
    expect(parseInstanceConfig({ summarizeThresholdChars: 12_000 })).toEqual({
      summarizeThresholdChars: 12_000,
    });
  });
});

describe("requestSummarize (manual trigger)", () => {
  test("manual bypasses the volume threshold AND the failure backoff", async () => {
    const t = convexTest(schema, modules);
    // Short content (below CHUNK_MIN) + an active backoff: the auto path skips…
    const { userId, chatId } = await setup(t, { messages: 20, text: "court." });
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "",
        watermarkOrderTime: 0,
        coveredCount: 0,
        updatedAt: 1,
        failureCount: 2,
        nextEligibleAt: Date.now() + 60_000,
      });
    });
    await schedule(t, chatId);
    expect(await hiddenChat(t, userId)).toBeNull(); // auto: backoff + below-min
    // …the MANUAL path dispatches.
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    const r = await asOwner.mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(r.outcome).toBe("dispatched");
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeDefined();
  });

  test("outcomes: in_flight when a job runs; engine_off when rehydration is off", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    const first = await asOwner.mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(first.outcome).toBe("dispatched");
    const second = await asOwner.mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(second.outcome).toBe("in_flight");
    // engine_off on a rehydration-disabled instance.
    await t.run(async (ctx) => {
      const inst = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", "primary"))
        .first();
      await ctx.db.patch(inst!._id, { config: { rehydration: false } });
      const hidden = await ctx.db
        .query("chats")
        .withIndex("by_user_kind", (q) =>
          q.eq("userId", userId).eq("kind", "summarizer"),
        )
        .first();
      await ctx.db.patch(hidden!._id, { pendingSummarize: undefined });
    });
    const third = await asOwner.mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(third.outcome).toBe("engine_off");
  });

  test("a LEGACY unbound chat resolves the default agent (manual works)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      // Legacy shape: the chat rows predate bindings.
      await ctx.db.patch(chatId, {
        instanceName: undefined,
        agentId: undefined,
      });
      // The user must be GRANTED the agent for the resolution to pick it.
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "primary",
        agentId: "olivier",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
    });
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    const r = await asOwner.mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(r.outcome).toBe("dispatched");
    expect((await hiddenChat(t, userId))?.agentId).toBe("olivier");
  });

  test("a foreign user is refused", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await setup(t);
    const otherId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: id,
        role: "user" as const,
        canonical: "v",
      });
      return id;
    });
    const asOther = t.withIdentity({ subject: `${otherId}|s2` });
    await expect(
      asOther.mutation(api.chatSummaries.requestSummarize, { chatId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("correlate stamps the PRODUCING agent; getChatSummary exposes it + jobInFlight", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    await asOwner.mutation(api.chatSummaries.requestSummarize, { chatId });
    // In flight, visible reactively.
    const during = await asOwner.query(api.chatSummaries.getChatSummary, {
      chatId,
    });
    expect(during?.jobInFlight).toBe(true);
    const hidden = (await hiddenChat(t, userId))!;
    const lock = hidden.pendingSummarize!;
    const reply = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "résumé manuel",
        turnSessionKey: `agent:olivier:atrium:chat:u:summarize-${chatId}-${lock.createdAt}`,
        updatedAt: Date.now(),
      });
      return (await ctx.db.get(id))!;
    });
    await t.run(async (ctx) => {
      await correlateSummarize(ctx, (await ctx.db.get(hidden._id))!, reply);
    });
    const after = await asOwner.query(api.chatSummaries.getChatSummary, {
      chatId,
    });
    expect(after?.jobInFlight).toBe(false);
    expect(after?.summary).toBe("résumé manuel");
    expect(after?.lastAgentId).toBe("olivier");
    expect(after?.lastInstanceName).toBe("primary");
  });
});

describe("updateSummary (owner edit)", () => {
  test("owner edits; the edit FEEDS FORWARD as the next job's previous_summary", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "version machine",
        watermarkOrderTime: effectiveOrder(chrono[3]!),
        coveredCount: 4,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
    });
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    await asOwner.mutation(api.chatSummaries.updateSummary, {
      chatId,
      summary: "  version humaine améliorée  ",
    });
    const row = await summaryRow(t, chatId);
    expect(row?.summary).toBe("version humaine améliorée");
    expect(row?.coveredCount).toBe(4); // coverage untouched
    // Feed-forward: the next dispatched job's prompt uses the edited text.
    await schedule(t, chatId);
    const hidden = (await hiddenChat(t, userId))!;
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden._id).eq("status", "pending"),
        )
        .collect();
      expect(outbox[0]!.text).toContain("version humaine améliorée");
    });
  });

  test("refused: in-flight job, empty text, no summary, foreign user", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    // No summary yet.
    await expect(
      asOwner.mutation(api.chatSummaries.updateSummary, {
        chatId,
        summary: "x",
      }),
    ).rejects.toThrow(/no summary/);
    // Seed one + a job in flight -> conflict.
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "s",
        watermarkOrderTime: 1,
        coveredCount: 1,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
    });
    await asOwner.mutation(api.chatSummaries.requestSummarize, { chatId });
    await expect(
      asOwner.mutation(api.chatSummaries.updateSummary, {
        chatId,
        summary: "conflit",
      }),
    ).rejects.toThrow(/in flight/);
    await t.run(async (ctx) => {
      const hidden = await ctx.db
        .query("chats")
        .withIndex("by_user_kind", (q) =>
          q.eq("userId", userId).eq("kind", "summarizer"),
        )
        .first();
      await ctx.db.patch(hidden!._id, { pendingSummarize: undefined });
    });
    // Empty rejected.
    await expect(
      asOwner.mutation(api.chatSummaries.updateSummary, {
        chatId,
        summary: "   ",
      }),
    ).rejects.toThrow(/empty/);
    // Foreign user refused.
    const otherId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: id,
        role: "user" as const,
        canonical: "w",
      });
      return id;
    });
    const asOther = t.withIdentity({ subject: `${otherId}|s2` });
    await expect(
      asOther.mutation(api.chatSummaries.updateSummary, {
        chatId,
        summary: "intrusion",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("getChatSummary (Réglages de session panel)", () => {
  test("owner sees their summary; a foreign user gets null; no row -> null", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, { messages: 2, text: "court." });
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "résumé visible par le propriétaire",
        watermarkOrderTime: 1,
        coveredCount: 4,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
    });
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    const mine = await asOwner.query(api.chatSummaries.getChatSummary, {
      chatId,
    });
    expect(mine?.summary).toBe("résumé visible par le propriétaire");
    expect(mine?.coveredCount).toBe(4);
    // Foreign user -> tolerant null (never another user's content).
    const otherId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: id,
        role: "user" as const,
        canonical: "v",
      });
      return id;
    });
    const asOther = t.withIdentity({ subject: `${otherId}|s2` });
    expect(
      await asOther.query(api.chatSummaries.getChatSummary, { chatId }),
    ).toBeNull();
  });
});

describe("utility-chat routing exemption + per-target kill-switch", () => {
  test("a HIDDEN summarizer chat routes to a summarizer-ONLY agent (dispatch path)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "resumeur",
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
        types: ["summarizer"],
      });
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "primary",
        agentId: "resumeur",
        isDefault: false,
        source: "manual" as const,
        createdAt: 1,
      });
      const hiddenId = await ctx.db.insert("chats", {
        userId,
        kind: "summarizer" as const,
        instanceName: "primary",
        agentId: "resumeur",
        updatedAt: 1,
      });
      const r = await resolveTargetForChat(
        ctx,
        (await ctx.db.get(hiddenId))!,
        userId,
      );
      // The utility chat is EXEMPT from the conversational requirement.
      expect(r.failReason).toBeNull();
      expect(r.target?.agentId).toBe("resumeur");
    });
  });

  test("a utility chat whose bound agent is GONE fails — never re-routes the excerpts", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await setup(t); // grants the CONVERSATIONAL agent "olivier"
    await t.run(async (ctx) => {
      // The bound summarizer agent was deleted on the gateway.
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "resumeur",
        source: "discovered" as const,
        presentInLastOk: false,
        firstSeenAt: 1,
        lastSeenAt: 1,
        types: ["summarizer"],
      });
      const hiddenId = await ctx.db.insert("chats", {
        userId,
        kind: "summarizer" as const,
        instanceName: "primary",
        agentId: "resumeur",
        updatedAt: 1,
      });
      const r = await resolveTargetForChat(
        ctx,
        (await ctx.db.get(hiddenId))!,
        userId,
      );
      // NOT silently re-routed to the remaining conversational grant.
      expect(r.target).toBeNull();
      expect(r.failReason).toBe("no_agent");
    });
  });

  test("multi-bridge: the INSTANCE's own bridge kill-switch wins over the top-level", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      const c = await ctx.db
        .query("bridgeCompat")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique();
      await ctx.db.patch(c!._id, {
        // First-reachable bridge says OFF, but THIS instance's bridge says ON.
        rehydrationDefault: false,
        targets: [
          {
            instanceName: "primary",
            provider: "openclaw",
            gatewayVersion: "2026.6.11",
            capabilities: {},
            versionBeyondValidated: false,
            rehydrationDefault: true,
            turnSessionEcho: true,
          },
        ],
      });
    });
    await schedule(t, chatId);
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeDefined();
  });
});

describe("job-identity correlation (session-key nonce)", () => {
  test("a late CANCELLED job's reply under a NEWER lock settles NOTHING", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await schedule(t, chatId);
    const hidden = (await hiddenChat(t, userId))!;
    const currentLock = hidden.pendingSummarize!;
    // A reply whose turn ran under an OLD job's session (different nonce) but whose
    // row was created AFTER the current lock — the time-based guard would settle
    // the wrong job with it.
    const oldReply = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "résumé du job ANNULÉ (contenu supprimé)",
        turnSessionKey: `agent:olivier:atrium:chat:u:summarize-${chatId}-1`,
        updatedAt: Date.now(),
      });
      return (await ctx.db.get(id))!;
    });
    await t.run(async (ctx) => {
      const settled = await correlateSummarize(
        ctx,
        (await ctx.db.get(hidden._id))!,
        oldReply,
      );
      expect(settled).toBe(false);
    });
    // The CURRENT job is untouched; the poisoned text was never stored.
    expect((await hiddenChat(t, userId))!.pendingSummarize).toEqual(currentLock);
    const row = await summaryRow(t, chatId);
    expect(row?.summary ?? "").toBe("");
  });

  test("the RIGHT nonce settles the job (identity over time)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await schedule(t, chatId);
    const hidden = (await hiddenChat(t, userId))!;
    const lock = hidden.pendingSummarize!;
    const reply = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "résumé légitime",
        turnSessionKey: `agent:olivier:atrium:chat:u:summarize-${chatId}-${lock.createdAt}`,
        updatedAt: Date.now(),
      });
      return (await ctx.db.get(id))!;
    });
    await t.run(async (ctx) => {
      const settled = await correlateSummarize(
        ctx,
        (await ctx.db.get(hidden._id))!,
        reply,
      );
      expect(settled).toBe(true);
    });
    expect((await summaryRow(t, chatId))?.summary).toBe("résumé légitime");
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeUndefined();
  });
});

describe("failure-streak anomaly + admin notification", () => {
  test("3 consecutive failures -> ONE anomaly (threshold-exact) + admin bell", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await setup(t);
      // An admin to receive the fan-out.
      const adminId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("users", {});
        await ctx.db.insert("profiles", {
          userId: id,
          role: "admin" as const,
          canonical: "adm",
        });
        return id;
      });
      await schedule(t, chatId);
      const hidden = (await hiddenChat(t, userId))!;
      const failOnce = async () => {
        await t.run(async (ctx) => {
          const h = (await ctx.db.get(hidden._id))!;
          if (!h.pendingSummarize) {
            await ctx.db.patch(hidden._id, {
              pendingSummarize: {
                targetChatId: chatId,
                watermarkTarget: 1,
                coveredCountTarget: 1,
                createdAt: Date.now(),
              },
            });
          }
          await failSummarizeForChat(
            ctx,
            (await ctx.db.get(hidden._id))!,
            "dispatch_error",
          );
        });
      };
      const anomalies = () =>
        t.run(async (ctx) => {
          const rows = await ctx.db.query("anomalies").collect();
          return rows.filter((a) => a.kind === "chat.summary_failing");
        });
      await failOnce();
      await failOnce();
      expect(await anomalies()).toHaveLength(0); // below the threshold: silent
      await failOnce();
      const atThree = await anomalies();
      expect(atThree).toHaveLength(1);
      expect(atThree[0]!.severity).toBe("warn");
      expect(atThree[0]!.message).toContain("3 consecutive failures");
      // Threshold-EXACT: a 4th failure of the same streak does not re-report.
      await failOnce();
      expect(await anomalies()).toHaveLength(1);
      // The admin got the bell notification (scheduled fan-out).
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await t.run(async (ctx) => {
        const notifs = await ctx.db
          .query("notifications")
          .withIndex("by_user", (q) => q.eq("userId", adminId))
          .collect();
        expect(
          notifs.some(
            (n) => n.kind === "anomaly_open" && n.title.includes("chat.summary_failing"),
          ),
        ).toBe(true);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stale-binding + deep-children hardening", () => {
  test("a bound agent RETYPED utility-only no longer receives the transcript", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) =>
          q.eq("instanceName", "primary").eq("agentId", "olivier"),
        )
        .first();
      await ctx.db.patch(row!._id, { types: ["summarizer"] });
    });
    await schedule(t, chatId);
    // Normal dispatch would refuse this binding — the summarizer must too.
    expect(await hiddenChat(t, userId)).toBeNull();
  });

  test("an OLD parent's child beyond the newest-500 window is still summarized", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, { messages: 30 });
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      // The OLDEST turn's content is a child result…
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: chrono[0]!._id,
        childSessionKey: "agent:olivier:subagent:ancien",
        taskName: "ancien",
        status: "done" as const,
        resultText: "RESULTAT-ANCIEN " + "a".repeat(2_000),
        createdAt: 1,
        updatedAt: 1,
      });
      // …buried behind 520 NEWER child rows (the newest-window alone misses it).
      for (let i = 0; i < 520; i++) {
        await ctx.db.insert("subAgents", {
          chatId,
          parentMessageId: chrono[29]!._id,
          childSessionKey: `agent:olivier:subagent:n${i}`,
          status: "done" as const,
          resultText: `bruit ${i}`,
          createdAt: 2,
          updatedAt: 2,
        });
      }
    });
    await schedule(t, chatId);
    const hidden = (await hiddenChat(t, userId))!;
    expect(hidden.pendingSummarize).toBeDefined();
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden._id).eq("status", "pending"),
        )
        .collect();
      // The page-ranged children read reaches the old child.
      expect(outbox[0]!.text).toContain("RESULTAT-ANCIEN");
    });
  });
});

describe("codex round-7 hardening", () => {
  test("a covered region WIDER than one attempt's page budget converges across attempts", async () => {
    const t = convexTest(schema, modules);
    // 1500 messages; the summary covers the first 1460 — more than the 6×240 rows
    // one attempt may scan. Attempt 1 must PERSIST its progress; attempt 2 resumes
    // and dispatches from the first uncovered message.
    const { userId, chatId } = await setup(t, {
      messages: 1500,
      text: "z".repeat(300),
    });
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "couvre m0..m1459",
        watermarkOrderTime: effectiveOrder(chrono[1459]!),
        coveredCount: 1460,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
    });
    // Attempt 1: crosses 6 covered pages, dispatches nothing, PERSISTS the floor
    // and reports "scanning" (a continuation is self-scheduled — codex P2: no
    // extra conversation turn needed for convergence).
    const asOwner = t.withIdentity({ subject: `${userId}|s1` });
    const first = await asOwner.mutation(api.chatSummaries.requestSummarize, {
      chatId,
    });
    expect(first.outcome).toBe("scanning");
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeUndefined();
    const afterFirst = await summaryRow(t, chatId);
    expect(afterFirst?.scanFloorCreationTime ?? 0).toBeGreaterThan(0);
    // Attempt 2: resumes past the covered region and dispatches the real chunk.
    await schedule(t, chatId);
    const hidden = await hiddenChat(t, userId);
    expect(hidden?.pendingSummarize).toBeDefined();
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden!._id).eq("status", "pending"),
        )
        .collect();
      expect(outbox[0]!.text).toContain("m1460 ");
      expect(outbox[0]!.text).not.toContain("m1459 ");
    });
  });
});

describe("codex round-6 hardening", () => {
  test("a DENSE already-covered region wider than one window is paged past (no stall)", async () => {
    const t = convexTest(schema, modules);
    // 300 messages; the summary already covers the first 280 — the uncovered tail
    // sits BEYOND a full 240-row read window that contains only covered rows.
    const { userId, chatId } = await setup(t, { messages: 300 });
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "couvre m0..m279",
        watermarkOrderTime: effectiveOrder(chrono[279]!),
        coveredCount: 280,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
    });
    await schedule(t, chatId);
    const hidden = await hiddenChat(t, userId);
    // Without paging: window = 240 covered rows -> empty pool -> permanent stall.
    expect(hidden?.pendingSummarize).toBeDefined();
    await t.run(async (ctx) => {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden!._id).eq("status", "pending"),
        )
        .collect();
      // The chunk starts at the first UNCOVERED message.
      expect(outbox[0]!.text).toContain("m280 ");
      expect(outbox[0]!.text).not.toContain("m279 ");
    });
  });
});

describe("codex round-5 hardening", () => {
  test("a FULL read window of short messages still dispatches (no permanent stall)", async () => {
    const t = convexTest(schema, modules);
    // 300 tiny messages: the 240-row window holds well under CHUNK_MIN_CHARS —
    // the minimum gate must yield when the window is full, or the watermark
    // never advances for this chat.
    const { userId, chatId } = await setup(t, { messages: 300, text: "ok" });
    await schedule(t, chatId);
    const hidden = await hiddenChat(t, userId);
    expect(hidden?.pendingSummarize).toBeDefined();
  });

  test("a short chat below the minimum (window NOT full) still skips", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t, { messages: 40, text: "ok" });
    await schedule(t, chatId);
    expect(await hiddenChat(t, userId)).toBeNull();
  });
});

describe("codex round-4 hardening", () => {
  test("deleting ANOTHER chat never sweeps a live job's rows (no summarizer wedge)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t); // chat B: the job's target
    await schedule(t, chatId);
    const hidden = (await hiddenChat(t, userId))!;
    expect(hidden.pendingSummarize).toBeDefined();
    // Chat A (same user), unrelated — deleted while B's job is in flight.
    const otherChatId = await t.run(async (ctx) => {
      return await ctx.db.insert("chats", {
        userId,
        instanceName: "primary",
        agentId: "olivier",
        updatedAt: 1,
      });
    });
    await t.run(async (ctx) => {
      await purgeSummaryForChat(ctx, otherChatId, userId);
    });
    // B's job is INTACT: lock kept, prompt + pending outbox still there.
    const after = (await hiddenChat(t, userId))!;
    expect(after.pendingSummarize?.targetChatId).toBe(chatId);
    await t.run(async (ctx) => {
      const pending = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden._id).eq("status", "pending"),
        )
        .collect();
      expect(pending).toHaveLength(1);
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", hidden._id))
        .collect();
      expect(msgs.length).toBeGreaterThan(0);
    });
  });

  test("the cron watchdog sweeps a released job's ORPHAN streaming reply", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await setup(t);
      await schedule(t, chatId);
      const hidden = (await hiddenChat(t, userId))!;
      const target = hidden.pendingSummarize!.watermarkTarget;
      // A streaming reply exists, then a deletion releases the job (lock gone,
      // streaming row deliberately left).
      await t.run(async (ctx) => {
        const orphanId = await ctx.db.insert("messages", {
          chatId: hidden._id,
          userId,
          role: "assistant" as const,
          status: "streaming" as const,
          text: "résumé partiel de contenu supprimé",
          updatedAt: Date.now() - 60 * 60 * 1000,
        });
        // The watchdog keys on the streamingText heartbeat row — seed it STALE.
        await ctx.db.insert("streamingText", {
          messageId: orphanId,
          chatId: hidden._id,
          text: "résumé partiel de contenu supprimé",
          updatedAt: Date.now() - 60 * 60 * 1000,
        });
        await invalidateSummaryOnDeletion(ctx, chatId, userId, target);
      });
      expect((await hiddenChat(t, userId))!.pendingSummarize).toBeUndefined();
      // The cron watchdog flips the stale stream, then must SWEEP the orphan.
      await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await t.run(async (ctx) => {
        const msgs = await ctx.db
          .query("messages")
          .withIndex("by_chat", (q) => q.eq("chatId", hidden._id))
          .collect();
        expect(msgs).toHaveLength(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("correlate via the REAL stream.finalize (the pre-patch staleness trap)", () => {
  test("a summarize reply finalized through stream.finalize stores the summary", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await schedule(t, chatId);
    const hidden = (await hiddenChat(t, userId))!;
    const lock = hidden.pendingSummarize!;
    // The gateway reply streams into the hidden chat, then finalizes. The finalize
    // handler read the message BEFORE its own patch — the correlate hook must use
    // the FINALIZED doc (status complete + final text), not the stale snapshot
    // (codex P2: with the stale doc every success was misread as a failure).
    const msgId = await t.run(async (ctx) => {
      return await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        turnSessionKey: `agent:olivier:atrium:chat:u:summarize-${lock.targetChatId}-${lock.createdAt}`,
        updatedAt: Date.now(),
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId: msgId,
      status: "complete",
      text: "Résumé final via finalize.",
    });
    const row = await summaryRow(t, chatId);
    expect(row?.summary).toBe("Résumé final via finalize.");
    expect(row?.watermarkOrderTime).toBe(lock.watermarkTarget);
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeUndefined();
  });
});

describe("summary invalidation + purge", () => {
  test("deletion at-or-before the watermark resets the summary", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "vieux résumé",
        watermarkOrderTime: 1_000,
        coveredCount: 10,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
      await invalidateSummaryOnDeletion(ctx, chatId, userId, 900);
    });
    const row = await summaryRow(t, chatId);
    expect(row?.summary).toBe("");
    expect(row?.watermarkOrderTime).toBe(0);
  });

  test("deletion after the watermark leaves the summary untouched", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "résumé valide",
        watermarkOrderTime: 1_000,
        coveredCount: 10,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
      await invalidateSummaryOnDeletion(ctx, chatId, userId, 2_000);
    });
    expect((await summaryRow(t, chatId))?.summary).toBe("résumé valide");
  });

  test("deletion inside an IN-FLIGHT job's range releases the poisoned job (stored row kept)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await schedule(t, chatId);
    const hidden = await hiddenChat(t, userId);
    const target = hidden!.pendingSummarize!.watermarkTarget;
    // Stored summary predates the job (older watermark) — a delete INSIDE the job's
    // chunk range must release the job but keep the still-valid stored summary.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chatSummaries")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .unique();
      if (row) {
        await ctx.db.patch(row._id, {
          summary: "résumé antérieur valide",
          watermarkOrderTime: 1, // far before the deletion point
          coveredCount: 2,
        });
      } else {
        await ctx.db.insert("chatSummaries", {
          chatId,
          summary: "résumé antérieur valide",
          watermarkOrderTime: 1,
          coveredCount: 2,
          updatedAt: 1,
          failureCount: 0,
          nextEligibleAt: 0,
        });
      }
      await invalidateSummaryOnDeletion(ctx, chatId, userId, target);
    });
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeUndefined();
    expect((await summaryRow(t, chatId))?.summary).toBe("résumé antérieur valide");
  });

  test("purgeSummaryForChat: row deleted + in-flight lock for that target released", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await setup(t);
    await schedule(t, chatId);
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeDefined();
    await t.run(async (ctx) => {
      await purgeSummaryForChat(ctx, chatId, userId);
    });
    expect(await summaryRow(t, chatId)).toBeNull();
    expect((await hiddenChat(t, userId))?.pendingSummarize).toBeUndefined();
  });
});

describe("rehydrationContext with a rolling summary", () => {
  test("summary block + verbatim strictly after the watermark", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await setup(t, { messages: 6, text: "contenu." });
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      const chrono = msgs.sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
      // Summary covers the first 3 messages.
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "Début résumé : sujets m0-m2.",
        watermarkOrderTime: effectiveOrder(chrono[2]!),
        coveredCount: 3,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
    });
    const r = await t.query(internal.stream.rehydrationContext, { chatId });
    expect(r.summaryUsed).toBe(true);
    expect(r.history).toContain("Résumé de la partie antérieure");
    expect(r.history).toContain("Début résumé : sujets m0-m2.");
    // Covered turns never re-sent verbatim; uncovered ones are.
    expect(r.history).not.toContain("m0 contenu.");
    expect(r.history).toContain("m3 contenu.");
    expect(r.turnCount).toBe(3);
  });

  test("an empty (reset) summary row behaves as no-summary", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await setup(t, { messages: 4, text: "contenu." });
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "",
        watermarkOrderTime: 9e15, // stale watermark from before the reset
        coveredCount: 0,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
    });
    const r = await t.query(internal.stream.rehydrationContext, { chatId });
    // The stale watermark is IGNORED (empty summary = none): full verbatim.
    expect(r.summaryUsed).toBe(false);
    expect(r.turnCount).toBe(4);
    expect(r.history).toContain("m0 contenu.");
  });
});
