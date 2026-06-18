/// <reference types="vite/client" />
//
// Stuck-stream watchdog. Pins: a STALE streaming message (no update for >12 min)
// is flipped to `error` with the stable `stream_orphaned` code AND its partial
// text/parts are preserved AND a trace is written; a FRESH streaming message
// (recent updatedAt) is left untouched (never kill a live stream); a completed
// message is ignored.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

const STALE = 13 * 60 * 1000; // older than the 12-min threshold
const FRESH = 30 * 1000; // well within it

async function seedMessage(
  t: T,
  status: "streaming" | "complete",
  ageMs: number,
  text = "partial answer so far",
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    const at = Date.now() - ageMs;
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status,
      text,
      runId: "webchat-run-1",
      updatedAt: at,
    });
    return { chatId, messageId };
  });
}

describe("reconcileStuckStreams", () => {
  test("flips a stale streaming message to error (code + preserved text + trace)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedMessage(t, "streaming", STALE);

    const res = await t.mutation(
      internal.stuckStreams.reconcileStuckStreams,
      {},
    );
    expect(res.reconciled).toBe(1);

    await t.run(async (ctx) => {
      const msg = await ctx.db.get(messageId);
      expect(msg?.status).toBe("error");
      expect(msg?.error).toBe("stream_orphaned");
      expect(msg?.text).toBe("partial answer so far"); // partial content kept
      // A diagnostic trace was written for the chat.
      const traces = await ctx.db.query("traceEvents").collect();
      const reconcile = traces.find(
        (e) => e.kind === "assistant.reconcile" && e.chatId === chatId,
      );
      expect(reconcile).toBeDefined();
    });
  });

  test("leaves a FRESH streaming message untouched (never kills a live stream)", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedMessage(t, "streaming", FRESH);
    const res = await t.mutation(
      internal.stuckStreams.reconcileStuckStreams,
      {},
    );
    expect(res.reconciled).toBe(0);
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("streaming");
  });

  test("ignores a completed message even if old", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedMessage(t, "complete", STALE);
    const res = await t.mutation(
      internal.stuckStreams.reconcileStuckStreams,
      {},
    );
    expect(res.reconciled).toBe(0);
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
  });
});

// Chat-scoped DELIBERATE reconcile (self-correction loop #7): same safe flip, but
// targeted at ONE chat with a shorter (60s) cutoff, and never touching other chats.
const RECON_STALE = 90 * 1000; // > the 60s deliberate cutoff
const RECON_FRESH = 20 * 1000; // < it

describe("reconcileChatStuckStreams (chat-scoped self-correction)", () => {
  test("flips this chat's stale streaming message (preserving text + trace)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedMessage(t, "streaming", RECON_STALE);
    const res = await t.mutation(
      internal.stuckStreams.reconcileChatStuckStreams,
      { chatId: chatId as string, principalId: "svc-abc" },
    );
    expect(res).toMatchObject({ ok: true, reconciled: 1 });
    await t.run(async (ctx) => {
      const msg = await ctx.db.get(messageId);
      expect(msg?.status).toBe("error");
      expect(msg?.error).toBe("stream_orphaned");
      expect(msg?.text).toBe("partial answer so far");
      const trace = (await ctx.db.query("traceEvents").collect()).find(
        (e) => e.kind === "assistant.reconcile" && e.principalId === "svc-abc",
      );
      expect(trace).toBeDefined();
    });
  });

  test("leaves a FRESH streaming message untouched (never kills a live stream)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedMessage(t, "streaming", RECON_FRESH);
    const res = await t.mutation(
      internal.stuckStreams.reconcileChatStuckStreams,
      { chatId: chatId as string },
    );
    expect(res.reconciled).toBe(0);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(messageId))?.status).toBe("streaming");
    });
  });

  test("is SCOPED: reconciling chat A never touches chat B's stuck stream", async () => {
    const t = convexTest(schema, modules);
    const a = await seedMessage(t, "streaming", RECON_STALE);
    const b = await seedMessage(t, "streaming", RECON_STALE);
    await t.mutation(internal.stuckStreams.reconcileChatStuckStreams, {
      chatId: a.chatId as string,
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(a.messageId))?.status).toBe("error"); // A reconciled
      expect((await ctx.db.get(b.messageId))?.status).toBe("streaming"); // B untouched
    });
  });

  test("a bad chatId -> ok:false, reconciled:0 (no throw)", async () => {
    const t = convexTest(schema, modules);
    const res = await t.mutation(
      internal.stuckStreams.reconcileChatStuckStreams,
      { chatId: "not-a-real-id" },
    );
    expect(res).toMatchObject({ ok: false, reconciled: 0 });
  });
});
