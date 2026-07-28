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
      // Real streaming model: the live text lives on a streamingText row, the
      // message doc's `text` is "" until finalize. A completed message keeps text.
      text: status === "streaming" ? "" : text,
      runId: "webchat-run-1",
      updatedAt: at,
    });
    // A streaming message carries its partial text + HEARTBEAT on a streamingText
    // row (created at startAssistant in prod). The watchdog ranges THESE by
    // updatedAt; the reap preserves `text` back onto the message.
    if (status === "streaming") {
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text,
        updatedAt: at,
      });
    }
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

  // The cron ranges streamingText.by_updated (the heartbeat). A stale row whose
  // message has ALREADY finalized (a phantom from a late delta racing finalize, or a
  // pre-fix leak) must be CLEANED UP — deleted so getStreamingText stops returning it
  // forever — but NOT counted as a reconcile (the turn ended cleanly; nothing to flip).
  test("cleans up an ORPHAN stale row whose message already completed (deletes row, not a reap)", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      const at = Date.now() - STALE;
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const, // already finalized cleanly
        text: "final answer",
        runId: "webchat-run-orphan",
        updatedAt: at,
      });
      // A leftover live row with a stale heartbeat (no finalize will delete it).
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "phantom partial",
        updatedAt: at,
      });
      return { messageId };
    });

    const res = await t.mutation(
      internal.stuckStreams.reconcileStuckStreams,
      {},
    );
    expect(res.reconciled).toBe(0); // a clean-up is not a reap

    await t.run(async (ctx) => {
      // The completed message is untouched...
      const msg = await ctx.db.get(messageId);
      expect(msg?.status).toBe("complete");
      expect(msg?.text).toBe("final answer");
      // ...and the orphan row is gone (getStreamingText would have returned it forever).
      const row = await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .first();
      expect(row).toBeNull();
    });
  });

  // GUARDS THE HEAD-OF-LINE FIX ITSELF (Option A: range streamingText.by_updated, NOT
  // messages.by_status_updated). The other cron tests all pass under EITHER index, so
  // none of them would fail on a revert. This one does: post-split, deltas no longer
  // touch message.updatedAt, so a long-but-ACTIVE turn keeps a very old message.updatedAt
  // with a FRESH heartbeat row. Seed BATCH (25) such live turns + one REAL orphan whose
  // message.updatedAt sorts AFTER them (newer) but whose row is STALE. Option A ranges
  // the rows → only the orphan's row is stale → it is reaped. A messages-range revert
  // would fill take(25) with the 25 older live turns (all skipped via max-heartbeat) and
  // EXCLUDE the orphan entirely → reconciled === 0. So this asserts reconciled === 1.
  test("head-of-line: reaps a real orphan even behind BATCH live-but-long turns", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const orphanId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      // 25 long-LIVE turns: oldest message.updatedAt (frozen at start), FRESH row.
      for (let i = 0; i < 25; i++) {
        const mId = await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "assistant" as const,
          status: "streaming" as const,
          text: "",
          runId: `live-${i}`,
          updatedAt: now - HOUR, // oldest by message.updatedAt
        });
        await ctx.db.insert("streamingText", {
          messageId: mId,
          chatId,
          text: "live",
          updatedAt: now, // FRESH heartbeat → actively streaming, must not be reaped
        });
      }
      // The real orphan: message.updatedAt NEWER than the live turns (sorts after them,
      // so a messages-range take(25) excludes it) but a STALE row (no recent heartbeat).
      const orphanId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "orphan",
        updatedAt: now - 20 * 60 * 1000, // < cutoff, but newer than the 25 live turns
      });
      await ctx.db.insert("streamingText", {
        messageId: orphanId,
        chatId,
        text: "stuck partial",
        updatedAt: now - 20 * 60 * 1000, // STALE heartbeat → the only row in range
      });
      return orphanId;
    });

    const res = await t.mutation(
      internal.stuckStreams.reconcileStuckStreams,
      {},
    );
    expect(res.reconciled).toBe(1); // ONLY the orphan; live turns excluded by fresh rows

    await t.run(async (ctx) => {
      const orphan = await ctx.db.get(orphanId);
      expect(orphan?.status).toBe("error");
      expect(orphan?.text).toBe("stuck partial"); // partial preserved
      // The 25 live turns are untouched (their fresh rows kept them out of range).
      const stillStreaming = (await ctx.db.query("messages").collect()).filter(
        (m) => m.status === "streaming",
      );
      expect(stillStreaming.length).toBe(25);
    });
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

  // LEGACY coverage lives HERE (not the cron): a stream that started BEFORE the
  // subscription split carries its partial text on `messages.liveText` with NO
  // streamingText row. The cron ranges streamingText rows so it can't see a row-less
  // stream — but the deliberate, chat-scoped reconcile scans `messages by_chat` with
  // heartbeat = max(row, msg), so an operator/agent acting on a reported stuck chat
  // still recovers a legacy row-less stream and preserves its liveText.
  test("reaps a LEGACY pre-split stream (liveText, no streamingText row) and preserves its text", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        // Pre-split shape: empty text, partial on liveText, and NO streamingText row.
        text: "",
        liveText: "legacy partial answer",
        runId: "webchat-run-legacy",
        updatedAt: Date.now() - RECON_STALE,
      });
      return { chatId, messageId };
    });

    const res = await t.mutation(internal.stuckStreams.reconcileChatStuckStreams, {
      chatId: chatId as string,
    });
    expect(res.reconciled).toBe(1);

    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
    expect(msg?.error).toBe("stream_orphaned");
    expect(msg?.text).toBe("legacy partial answer"); // liveText preserved on reap
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

// L2: the watchdog must ALSO release a documentary FETCH stuck on the hidden chat,
// else the owner is locked out (fetch_in_flight) forever AND the stuck case is silent.
async function seedStuckDocFetch(
  t: T,
  opts: { withStreamingMsg: boolean; ageMs?: number },
) {
  const ageMs = opts.ageMs ?? STALE;
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const convId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    const srcMsg = await ctx.db.insert("messages", {
      chatId: convId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "x",
      updatedAt: Date.now(),
    });
    const createdAt = Date.now() - ageMs;
    const docId = await ctx.db.insert("chats", {
      userId,
      kind: "documentary" as const,
      title: "Documents",
      updatedAt: 0,
      pendingFetch: { sourceMessageId: srcMsg, createdAt },
    });
    const rowId = await ctx.db.insert("documentAttachments", {
      userId,
      sourceMessageId: srcMsg,
      entryKey: "k",
      reference: "guide.md",
      status: "pending" as const,
      createdAt: 1,
      updatedAt: 1,
    });
    let fetchMsgId: string | undefined;
    if (opts.withStreamingMsg) {
      fetchMsgId = await ctx.db.insert("messages", {
        chatId: docId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "docfetch-run",
        updatedAt: createdAt,
      });
      // The streaming heartbeat the cron watchdog ranges on (stale here).
      await ctx.db.insert("streamingText", {
        messageId: fetchMsgId,
        chatId: docId,
        text: "",
        updatedAt: createdAt,
      });
    }
    return { userId, srcMsg, docId, rowId, fetchMsgId };
  });
}

describe("watchdog releases a stuck documentary fetch", () => {
  test("cron: a dropped fetch STREAM clears pendingFetch + fails rows + emits documentary.fail", async () => {
    const t = convexTest(schema, modules);
    const { docId, rowId } = await seedStuckDocFetch(t, { withStreamingMsg: true });

    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});

    await t.run(async (ctx) => {
      const doc = await ctx.db.get(docId);
      expect(doc?.pendingFetch).toBeUndefined(); // lock released
      expect((await ctx.db.get(rowId))?.status).toBe("failed");
      const fail = (await ctx.db.query("traceEvents").collect()).find(
        (e) => e.kind === "documentary.fail",
      );
      expect(fail).toBeDefined();
      expect(JSON.parse(fail!.meta!).reason).toBe("stuck_stream");
    });
  });

  test("deliberate reconcile heals a stale pendingFetch with NO streaming message (the rare completed-but-stuck case)", async () => {
    const t = convexTest(schema, modules);
    const { docId, rowId } = await seedStuckDocFetch(t, {
      withStreamingMsg: false,
    });

    const res = await t.mutation(
      internal.stuckStreams.reconcileChatStuckStreams,
      { chatId: docId as string },
    );
    expect(res.reconciled).toBe(0); // no streaming message to flip...

    await t.run(async (ctx) => {
      // ...but the stale lock is still released.
      expect((await ctx.db.get(docId))?.pendingFetch).toBeUndefined();
      expect((await ctx.db.get(rowId))?.status).toBe("failed");
    });
  });

  test("a FRESH pendingFetch is NOT released (never kill an in-progress fetch)", async () => {
    const t = convexTest(schema, modules);
    const { docId, rowId } = await seedStuckDocFetch(t, {
      withStreamingMsg: false,
      ageMs: 10 * 1000, // within the 60s deliberate cutoff
    });
    await t.mutation(internal.stuckStreams.reconcileChatStuckStreams, {
      chatId: docId as string,
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(docId))?.pendingFetch).not.toBeUndefined();
      expect((await ctx.db.get(rowId))?.status).toBe("pending");
    });
  });
});

describe("a reap drops the provider session (lot 31)", () => {
  // A reap means NOBODY settled this turn — no terminal, ever — so nothing is known about
  // the provider's run. The timeout's own clear rides its finalize, and here there is no
  // finalize: this is the case that clear cannot reach. Without it, a bridge that crashed
  // mid-turn left the stored session behind and the next send resumed a run nobody had
  // stopped.

  async function seedWithSession(t: T, stored: string | undefined) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 0,
        ...(stored === undefined ? {} : { openclawChatId: stored }),
      });
      const at = Date.now() - STALE;
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "webchat-run-1",
        updatedAt: at,
      });
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "partial",
        updatedAt: at,
      });
      return chatId;
    });
  }

  const sessionOf = async (t: T, chatId: unknown) =>
    await t.run(async (ctx) => {
      const c = await ctx.db.get(chatId as never);
      return {
        stored: (c as { openclawChatId?: string } | null)?.openclawChatId,
        epoch: (c as { providerResetCount?: number } | null)?.providerResetCount,
      };
    });

  test("a Hermes WS session id is dropped and the epoch bumps", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedWithSession(t, "20260706_212939_aee24e");
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    expect(await sessionOf(t, chatId)).toEqual({ stored: undefined, epoch: 1 });
  });

  test("a Hermes REST session id is dropped too", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedWithSession(t, "api_1751830179_9f2c");
    expect((await sessionOf(t, chatId)).stored).toBe("api_1751830179_9f2c");
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    expect((await sessionOf(t, chatId)).stored).toBeUndefined();
  });

  test("an OpenClaw ROUTING SEGMENT is left exactly where it is", async () => {
    // The slot is shared. Clearing a routing segment would break routing to fix a session
    // that was never stored there — the shape guard, not the call site, is what bounds
    // the blast radius.
    const t = convexTest(schema, modules);
    const chatId = await seedWithSession(t, "turn:nx7dt2mbcnsr3pvpghhtmndazh");
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    const after = await sessionOf(t, chatId);
    expect(after.stored).toBe("turn:nx7dt2mbcnsr3pvpghhtmndazh");
    // …and the epoch still bumps: an in-flight bind must stand down either way.
    expect(after.epoch).toBe(1);
  });

  test("an EMPTY slot still bumps the epoch", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedWithSession(t, undefined);
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});
    expect((await sessionOf(t, chatId)).epoch).toBe(1);
  });
});

describe("every path that releases a turn WITHOUT a terminal drops the session (lot 31)", () => {
  // The periodic reap was the first one found. Two more release a chat the same way — the
  // privileged reconcile-chat endpoint, and the bridge's own startup sweep, which is
  // exactly the restart case where the in-memory cache is gone and only the persisted id
  // remains. A fix that covers one of three reads, from every report, like a fix.

  async function seedFor(t: T, stored: string, boundInstance?: string) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 0,
        openclawChatId: stored,
        ...(boundInstance ? { instanceName: boundInstance } : {}),
      });
      const at = Date.now() - STALE;
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "hermes-run-1",
        updatedAt: at,
      });
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "partial",
        updatedAt: at,
        // The sweep selects by the per-turn stamp; the chat binding is the fallback.
        ...(boundInstance ? { boundInstance } : {}),
      });
      return chatId;
    });
  }

  const storedOf = async (t: T, chatId: unknown) =>
    await t.run(async (ctx) => {
      const c = await ctx.db.get(chatId as never);
      // A REMOVED field crosses the convex-test boundary as `null`, not `undefined` —
      // asserting on the raw value would be asserting on the harness.
      return (c as { openclawChatId?: string } | null)?.openclawChatId ?? "«cleared»";
    });

  test("the reconcile-chat path clears it", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedFor(t, "api_1751830179_9f2c");
    await t.mutation(internal.stuckStreams.reconcileChatStuckStreams, {
      chatId: chatId as never,
    });
    expect(await storedOf(t, chatId)).toBe("«cleared»");
  });

  test("the startup sweep clears it — the restart case", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedFor(t, "20260706_212939_aee24e", "hermes");
    await t.mutation(internal.stuckStreams.sweepInstanceStreams, {
      instanceName: "hermes",
    });
    expect(await storedOf(t, chatId)).toBe("«cleared»");
  });
});
