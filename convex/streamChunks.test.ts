// Phase 1 of the wire-SSE transport (openclaw-notes/docs/atrium/convex-http-streaming-transport.md):
// the append-only streamChunks log written by stream.appendDelta/setSnapshot, and its
// bounded GC at finalize. These chunks are what the (future) SSE endpoint will replay +
// tail. Inert until then, but the dual-write + monotonic seq + GC must be correct now.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { cascadeDeleteChat } from "./chats";

const modules = import.meta.glob("./**/*.ts");

async function seedStreamingMessage(
  t: TestConvex<typeof schema>,
): Promise<Id<"messages">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
    });
    return await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
  });
}

async function chunks(
  t: TestConvex<typeof schema>,
  messageId: Id<"messages">,
) {
  return await t.run((ctx) =>
    ctx.db
      .query("streamChunks")
      .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
      .collect(),
  );
}

// An ACTIVE, authenticated user owning a chat with a streaming assistant message —
// the auth context streamPoll + the SSE endpoint require (requireActive + chat owner).
async function seedAuthed(t: TestConvex<typeof schema>) {
  const userId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "u" });
    return uid;
  });
  const messageId = await t.run(async (ctx) => {
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
    });
    return await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
  });
  return {
    userId,
    messageId,
    asUser: t.withIdentity({ subject: `${userId}|session` }),
  };
}

describe("streamChunks — Phase 1 append-only log", () => {
  test("appendDelta writes an 'append' chunk with a monotonic per-message seq", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seedStreamingMessage(t);
    await t.mutation(internal.stream.appendDelta, { messageId, text: "Hel" });
    await t.mutation(internal.stream.appendDelta, { messageId, text: "lo" });
    const cs = await chunks(t, messageId);
    expect(cs.map((c) => `${c.seq}:${c.kind}:${c.text}`)).toEqual([
      "1:append:Hel",
      "2:append:lo",
    ]);
  });

  test("setSnapshot writes a 'replace' chunk; seq stays monotonic across delta + snapshot", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seedStreamingMessage(t);
    await t.mutation(internal.stream.appendDelta, { messageId, text: "Hi" });
    await t.mutation(internal.stream.setSnapshot, {
      messageId,
      text: "Hi there",
    });
    await t.mutation(internal.stream.appendDelta, { messageId, text: "!" });
    const cs = await chunks(t, messageId);
    expect(cs.map((c) => `${c.seq}:${c.kind}:${c.text}`)).toEqual([
      "1:append:Hi",
      "2:replace:Hi there",
      "3:append:!",
    ]);
  });

  test("finalize GCs the message's stream chunks", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seedStreamingMessage(t);
    await t.mutation(internal.stream.appendDelta, { messageId, text: "a" });
    await t.mutation(internal.stream.appendDelta, { messageId, text: "b" });
    expect((await chunks(t, messageId)).length).toBe(2);

    vi.useFakeTimers();
    try {
      await t.mutation(internal.stream.finalize, {
        messageId,
        status: "complete",
        text: "ab",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(await chunks(t, messageId)).toEqual([]);
  });

  test("a late write to an already-finished message creates NO chunk (no phantom)", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seedStreamingMessage(t);
    await t.run((ctx) => ctx.db.patch(messageId, { status: "complete" }));
    // No streamingText row + terminal status -> appendDelta drops the write entirely.
    await t.mutation(internal.stream.appendDelta, { messageId, text: "late" });
    expect(await chunks(t, messageId)).toEqual([]);
  });

  test("seq is 1-based: a fresh SSE cursor (0) + `seq > cursor` reads the FIRST chunk", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seedStreamingMessage(t);
    await t.mutation(internal.stream.appendDelta, { messageId, text: "first" });
    // Phase 2's fresh-connection contract: cursor = 0 (no Last-Event-ID), read seq>cursor.
    // With 0-based seq the first chunk (seq 0) would be skipped — this guards against that.
    const fromFresh = await t.run((ctx) =>
      ctx.db
        .query("streamChunks")
        .withIndex("by_message_seq", (q) =>
          q.eq("messageId", messageId).gt("seq", 0),
        )
        .collect(),
    );
    expect(fromFresh.map((c) => c.text)).toEqual(["first"]);
  });

  test("cascadeDeleteChat purges a mid-stream message's chunks (text not orphaned)", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seedStreamingMessage(t);
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "secret",
    });
    const chatId = (await t.run((ctx) => ctx.db.get(messageId)))!.chatId;
    expect((await chunks(t, messageId)).length).toBe(1);

    vi.useFakeTimers();
    try {
      await t.run((ctx) => cascadeDeleteChat(ctx, chatId));
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(await chunks(t, messageId)).toEqual([]); // no orphaned chunk content
  });

  test("first chunk for a row that ALREADY had text emits a 'replace' of the full text (migration: no lost prefix)", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seedStreamingMessage(t);
    // A stream active across the deploy: a streamingText row with text but no chunkSeq.
    await t.run(async (ctx) => {
      const m = await ctx.db.get(messageId);
      await ctx.db.insert("streamingText", {
        messageId,
        chatId: m!.chatId,
        text: "PREFIX",
        updatedAt: 1,
      });
    });
    await t.mutation(internal.stream.appendDelta, { messageId, text: "+d" });
    const cs = await chunks(t, messageId);
    // "replace" of the FULL text, so a fresh SSE client (cursor 0) gets the prefix.
    expect(cs.map((c) => `${c.seq}:${c.kind}:${c.text}`)).toEqual([
      "1:replace:PREFIX+d",
    ]);
  });

  test("first chunk created from a pre-split liveText prefix emits a 'replace'", async () => {
    const t = convexTest(schema, modules);
    const messageId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
      });
      return await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        liveText: "OLD",
        updatedAt: 1,
      });
    });
    await t.mutation(internal.stream.appendDelta, { messageId, text: "+new" });
    const cs = await chunks(t, messageId);
    expect(cs.map((c) => `${c.seq}:${c.kind}:${c.text}`)).toEqual([
      "1:replace:OLD+new",
    ]);
  });
});

describe("SSE endpoint (Phase 2): streamPoll + /api/v1/message-stream", () => {
  test("streamPoll returns chunks after the cursor + lifecycle status (owner)", async () => {
    const t = convexTest(schema, modules);
    const { messageId, asUser } = await seedAuthed(t);
    await t.mutation(internal.stream.appendDelta, { messageId, text: "A" }); // seq 1
    await t.mutation(internal.stream.appendDelta, { messageId, text: "B" }); // seq 2
    const p0 = await asUser.query(internal.stream.streamPoll, {
      messageId,
      afterSeq: 0,
    });
    expect(p0.chunks.map((c) => `${c.seq}:${c.text}`)).toEqual(["1:A", "2:B"]);
    expect(p0.status).toBe("streaming");
    expect(p0.finalText).toBeUndefined();
    const p1 = await asUser.query(internal.stream.streamPoll, {
      messageId,
      afterSeq: 1,
    });
    expect(p1.chunks.map((c) => c.seq)).toEqual([2]); // cursor skips seq 1
  });

  test("streamPoll exposes the authoritative finalText once terminal", async () => {
    const t = convexTest(schema, modules);
    const { messageId, asUser } = await seedAuthed(t);
    await t.mutation(internal.stream.appendDelta, { messageId, text: "hi" });
    await t.run((ctx) =>
      ctx.db.patch(messageId, { status: "complete", text: "hi (final)" }),
    );
    const p = await asUser.query(internal.stream.streamPoll, {
      messageId,
      afterSeq: 0,
    });
    expect(p.status).toBe("complete");
    expect(p.finalText).toBe("hi (final)");
  });

  test("streamPoll rejects a non-owner (IDOR)", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAuthed(t);
    const intruder = await seedAuthed(t); // a DIFFERENT user
    await expect(
      intruder.asUser.query(internal.stream.streamPoll, {
        messageId,
        afterSeq: 0,
      }),
    ).rejects.toThrow();
  });

  test("the SSE httpAction streams a terminal message's chunks + final + done (authed)", async () => {
    const t = convexTest(schema, modules);
    const { messageId, asUser } = await seedAuthed(t);
    await t.mutation(internal.stream.appendDelta, { messageId, text: "X" }); // seq 1
    await t.run((ctx) =>
      ctx.db.patch(messageId, { status: "complete", text: "X!" }),
    );
    const res = await asUser.fetch(
      `/api/v1/message-stream?messageId=${messageId}`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("id: 1");
    expect(body).toContain('"text":"X"'); // the streamed chunk
    expect(body).toContain("event: final");
    expect(body).toContain('"text":"X!"'); // the authoritative final text
    expect(body).toContain("event: done");
  });

  test("the SSE httpAction is auth-gated (no identity -> 403)", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAuthed(t);
    const res = await t.fetch(`/api/v1/message-stream?messageId=${messageId}`);
    expect(res.status).toBe(403);
  });

  test("the SSE httpAction requires a messageId (-> 400)", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(`/api/v1/message-stream`);
    expect(res.status).toBe(400);
  });

  test("the SSE endpoint answers the CORS preflight (OPTIONS) for browser fetch-streams", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/api/v1/message-stream", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example",
    );
    // The non-simple request headers the fetch-stream client sends must be allowed.
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowHeaders).toContain("Last-Event-ID");
    expect(allowHeaders).toContain("Authorization");
  });
});
