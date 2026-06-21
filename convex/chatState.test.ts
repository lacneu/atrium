/// <reference types="vite/client" />
//
// chatStateInternal — the diagnostic inspector behind GET /api/v1/chat-state.
// THE SOC2 contract test: seed a chat with a unique sentinel in EVERY content
// slot (message text, raw error, tool name-args/input/output, reasoning text,
// provenance source/items, file name, mime name= param) and assert NONE of them
// appear in the serialized response — the auditable no-content proof. Also pins
// the structural projection (tool name base, hasInput/Output, mimeType base,
// hasFilename/hasStorageUrl, presence-only reasoning/provenance), the normalized
// errorCode, the bucketed textLen, and the shared runStatusKind derivation.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("chatStateInternal", () => {
  test("structural projection + NO content leak (sentinel proof)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const cid = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      const mid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "SENTINEL_BODYTEXT lorem ipsum",
        // Raw free-form gateway error (the PHI-risk field) — must normalize away.
        error: "SENTINEL_ERR patient Jean Dupont at /records/x",
        runId: "webchat-run-z",
        updatedAt: Date.now() - 30 * 60 * 1000, // stale -> stuckStreaming
      });
      const storageId = await ctx.storage.store(new Blob(["x"]));
      // One part of every kind, each carrying a sentinel in its content slots.
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 0,
        part: {
          kind: "tool" as const,
          name: "bash",
          phase: "done",
          input: { cmd: "SENTINEL_TOOLIN" },
          output: "SENTINEL_TOOLOUT",
        },
      });
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 1,
        part: { kind: "reasoning" as const, text: "SENTINEL_REASONING" },
      });
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 2,
        part: {
          kind: "file" as const,
          storageId,
          filename: "SENTINEL_FILENAME.pdf",
          mimeType: 'application/pdf; name="SENTINEL_MIMEPARAM.pdf"',
        },
      });
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 3,
        part: {
          kind: "provenance" as const,
          v: 1,
          pluginId: "lightrag",
          source: "SENTINEL_PROVSOURCE.pdf",
          group: "documents" as const,
          items: [{ text: "SENTINEL_PROVITEM" }],
        },
      });
      return cid;
    });

    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    expect(state.ok).toBe(true);
    if (!state.ok) return;

    // (1) AUDITABLE NO-CONTENT PROOF: not a single sentinel anywhere.
    const serialized = JSON.stringify(state);
    for (const sentinel of [
      "SENTINEL_BODYTEXT",
      "SENTINEL_ERR",
      "SENTINEL_TOOLIN",
      "SENTINEL_TOOLOUT",
      "SENTINEL_REASONING",
      "SENTINEL_FILENAME",
      "SENTINEL_MIMEPARAM",
      "SENTINEL_PROVSOURCE",
      "SENTINEL_PROVITEM",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }

    // (2) Structural projection is present + correct.
    const msg = state.messages[0]!;
    expect(msg.status).toBe("streaming");
    expect(msg.stuckStreaming).toBe(true);
    expect(msg.runStatusKind).toBe("generating"); // streaming + has text
    expect(msg.textLenBucket).toBe("1-100");
    expect(msg.errorCode).toBe("unknown"); // raw error normalized away
    const byKind = Object.fromEntries(msg.parts.map((p) => [p.kind, p]));
    expect(byKind.tool).toMatchObject({
      name: "bash", // base tool name IS exposed (safe per spec)
      hasInput: true,
      hasOutput: true,
    });
    expect(byKind.file).toMatchObject({
      mimeType: "application/pdf", // base only, name= param stripped
      hasFilename: true,
    });
    expect(byKind.reasoning).toEqual({ kind: "reasoning" }); // presence only
    expect(byKind.provenance).toEqual({ kind: "provenance" }); // presence only
  });

  test("L2: surfaces attachedDocCount + documentary kind + pendingDocFetch age, never a reference", async () => {
    const t = convexTest(schema, modules);
    const { convId, docId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const convId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      const srcMsg = await ctx.db.insert("messages", {
        chatId: convId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "hi",
        attachedDocCount: 2,
        updatedAt: Date.now(),
      });
      // A documentAttachments row with a PHI-like reference: chat-state must NEVER
      // pull it (it reads the denormalized count only, not the rows).
      await ctx.db.insert("documentAttachments", {
        userId,
        sourceMessageId: srcMsg,
        entryKey: "k",
        reference: "SENTINEL_DOCREF.pdf",
        status: "ready" as const,
        createdAt: 1,
        updatedAt: 1,
      });
      const docId = await ctx.db.insert("chats", {
        userId,
        kind: "documentary" as const,
        title: "Documents",
        updatedAt: 0,
        pendingFetch: { sourceMessageId: srcMsg, createdAt: Date.now() - 13 * 60 * 1000 },
      });
      return { convId, docId };
    });

    const conv = await t.query(internal.messages.chatStateInternal, { chatId: convId });
    expect(conv.ok).toBe(true);
    if (!conv.ok) return;
    expect(conv.messages[0]!.attachedDocCount).toBe(2);
    expect(conv.kind).toBeNull(); // a conversational chat
    expect(conv.pendingDocFetch).toBeNull();
    // The reference NEVER leaks through chat-state.
    expect(JSON.stringify(conv)).not.toContain("SENTINEL_DOCREF");

    const doc = await t.query(internal.messages.chatStateInternal, { chatId: docId });
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.kind).toBe("documentary");
    expect(doc.pendingDocFetch).not.toBeNull();
    expect(doc.pendingDocFetch!.ageSeconds).toBeGreaterThan(700); // stale -> stuck
  });

  test("bad / unknown chatId returns ok:false (never throws)", async () => {
    const t = convexTest(schema, modules);
    const bad = await t.query(internal.messages.chatStateInternal, {
      chatId: "not-a-real-id",
    });
    expect(bad.ok).toBe(false);
  });
});
