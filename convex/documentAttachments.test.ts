/// <reference types="vite/client" />
//
// L2 "Joindre les documents" — dispatch + correlation. Pins the entitlement gate
// (only a GRANTED documentary agent), the per-CARD (entryKey) pending rows + hidden
// chat dispatch, the filename correlation (ready / not_found), the denormalized
// "joints" count, and the sidebar exclusion. The CORE invariant: an unchecked
// duplicate (same file_name, different card) NEVER gets a row → never lights up.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  correlateDocumentaryFetch,
  failDocumentaryFetchForChat,
} from "./documentAttachments";

const modules = import.meta.glob("./**/*.ts");

async function setup(
  t: TestConvex<typeof schema>,
  opts: { docType?: boolean; grant?: boolean } = {},
) {
  const { docType = true, grant = true } = opts;
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "primary", gatewayUrl: "ws://gw" });
    await ctx.db.insert("agents", {
      instanceName: "primary",
      agentId: "doc",
      source: "discovered" as const,
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
      ...(docType ? { types: ["documentary"] } : {}),
    });
    if (grant) {
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "primary",
        agentId: "doc",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
    }
    // A conversational chat + an assistant reply that carried documentary sources.
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
    const sourceMessageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "reply",
      updatedAt: 1,
    });
    // The stored provenance for that reply (documents group). attachDocuments
    // validates each submitted reference against THESE file_names, so the tests'
    // references (guide.md / faq.md) must appear here.
    await ctx.db.insert("messageParts", {
      messageId: sourceMessageId,
      order: 0,
      part: {
        kind: "provenance" as const,
        v: 1,
        pluginId: "p",
        source: "rag",
        group: "documents" as const,
        items: [
          { file_name: "guide.md" },
          { file_name: "faq.md" },
          { file_name: "missing.md" },
        ],
      },
    });
    return { userId, chatId, sourceMessageId };
  });
}

describe("attachDocuments dispatch", () => {
  test("entitlement: throws when no documentary agent is granted", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t, { docType: false });
    const as = t.withIdentity({ subject: `${userId}|session` });
    await expect(
      as.mutation(api.documentAttachments.attachDocuments, {
        sourceMessageId,
        items: [{ entryKey: "k|guide", reference: "guide.md" }],
      }),
    ).rejects.toThrow(/no_documentary_agent/);
  });

  test("rejects a reference that is NOT a document source of the message (no arbitrary fetch)", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    // "secret.md" is not among the message's provenance sources (guide.md / faq.md).
    await expect(
      as.mutation(api.documentAttachments.attachDocuments, {
        sourceMessageId,
        items: [{ entryKey: "k|x", reference: "secret.md" }],
      }),
    ).rejects.toThrow(/no_references/);
    // Regression guard: drop the provenance check and this becomes a real pending row
    // + a dispatched fetch for an UNSHOWN file.
    const rows = await as.query(api.documentAttachments.getDocumentAttachments, {
      sourceMessageId,
    });
    expect(rows.length).toBe(0);
  });

  test("a MIX of valid + forbidden references queues ONLY the valid ones", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [
        { entryKey: "k|guide", reference: "guide.md" }, // a real source
        { entryKey: "k|evil", reference: "/etc/passwd" }, // not a source -> dropped
      ],
    });
    const rows = await as.query(api.documentAttachments.getDocumentAttachments, {
      sourceMessageId,
    });
    expect(rows.map((r) => r.entryKey)).toEqual(["k|guide"]);
  });

  test("creates per-CARD pending rows + a hidden documentary chat + outbox + pendingFetch", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [
        { entryKey: "k|guide", reference: "guide.md" },
        { entryKey: "k|faq", reference: "faq.md" },
        { entryKey: "k|guide", reference: "guide.md" }, // dup entryKey collapses
      ],
    });
    const rows = await as.query(api.documentAttachments.getDocumentAttachments, {
      sourceMessageId,
    });
    expect(rows.map((r) => r.entryKey).sort()).toEqual(["k|faq", "k|guide"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    // A hidden documentary chat exists, bound to the agent, with pendingFetch.
    const hidden = await t.run((ctx) =>
      ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first(),
    );
    expect(hidden?.agentId).toBe("doc");
    expect(hidden?.pendingFetch?.sourceMessageId).toBe(sourceMessageId);
    // A documentary outbox was queued for dispatch.
    const outbox = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden!._id).eq("status", "pending"),
        )
        .first(),
    );
    expect(outbox).not.toBeNull();
  });

  test("two cards with the SAME file_name but different entryKey → TWO rows (only the checked cards)", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    // The user checked ONE of two duplicate "guide.md" cards (distinct entryKeys).
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "p|0.0", reference: "guide.md" }],
    });
    const rows = await as.query(api.documentAttachments.getDocumentAttachments, {
      sourceMessageId,
    });
    // ONLY the checked card's entryKey has a row; the unchecked duplicate (p|1.0)
    // has none → it can never light up in the panel.
    expect(rows.map((r) => r.entryKey)).toEqual(["p|0.0"]);
  });

  test("the hidden documentary chat is EXCLUDED from the sidebar (listChats)", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "k|guide", reference: "guide.md" }],
    });
    const chats = await as.query(api.messages.listChats, {});
    expect(chats.some((c) => c.title === "Documents")).toBe(false);
  });

  test("serial: a second fetch while one is in flight is refused", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "k|guide", reference: "guide.md" }],
    });
    await expect(
      as.mutation(api.documentAttachments.attachDocuments, {
        sourceMessageId,
        items: [{ entryKey: "k|faq", reference: "faq.md" }],
      }),
    ).rejects.toThrow(/fetch_in_flight/);
  });

  test("serial: refused while the hidden chat STREAMS even if pendingFetch was released", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    // The released-but-still-streaming window: a hidden documentary chat with an
    // IN-FLIGHT (streaming) turn but NO pendingFetch.
    await t.run(async (ctx) => {
      const hidden = await ctx.db.insert("chats", {
        userId,
        kind: "documentary" as const,
        title: "Documents",
        instanceName: "primary",
        agentId: "doc",
        updatedAt: 1,
      });
      await ctx.db.insert("messages", {
        chatId: hidden,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      });
    });
    // Regression guard: a pendingFetch-only check would PASS (none set) and dispatch a
    // SECOND concurrent chat.send to the streaming hidden session; isChatBusy refuses.
    await expect(
      as.mutation(api.documentAttachments.attachDocuments, {
        sourceMessageId,
        items: [{ entryKey: "k|guide", reference: "guide.md" }],
      }),
    ).rejects.toThrow(/fetch_in_flight/);
  });
});

describe("documentary fetch dispatch failure", () => {
  test("a failed dispatch clears pendingFetch + marks rows failed (no fetch_in_flight lockout)", async () => {
    // When the documentary fetch's DISPATCH fails before stream.finalize (bridge
    // down / no_agent), the hidden chat's pendingFetch must be released — else the
    // serial guard permanently throws fetch_in_flight for that user.
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "k|guide", reference: "guide.md" }],
    });
    const hidden = await t.run((ctx) =>
      ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first(),
    );
    const outbox = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden!._id).eq("status", "pending"),
        )
        .first(),
    );

    // Simulate the documentary fetch dispatch failing (the REAL dispatch error path).
    await t.mutation(internal.bridge.failDispatch, {
      outboxId: outbox!._id,
      reason: "send_failed",
    });

    // pendingFetch released (regression guard: drop the cleanup in failDispatch OR
    // the pendingFetch:undefined patch in the helper and this stays set)...
    const after = await t.run((ctx) => ctx.db.get(hidden!._id));
    expect(after?.pendingFetch).toBeUndefined();
    // ...rows surfaced as failed (not stuck pending)...
    const rows = await as.query(api.documentAttachments.getDocumentAttachments, {
      sourceMessageId,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
    // ...and the lockout is gone: a fresh attach is accepted (no fetch_in_flight).
    await expect(
      as.mutation(api.documentAttachments.attachDocuments, {
        sourceMessageId,
        items: [{ entryKey: "k|guide", reference: "guide.md" }],
      }),
    ).resolves.toBeDefined();
  });
});

describe("a LATE finalize of an OLD run never corrupts the CURRENT fetch", () => {
  test("stream.finalize on a message older than pendingFetch.createdAt skips correlate", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    // Build the corruption window directly: a hidden documentary chat whose CURRENT
    // pendingFetch.createdAt is AFTER an OLD run's assistant message (the old fetch was
    // stuck + released, a new one started, then the old gateway run finalizes late).
    const { hiddenId, oldMsg } = await t.run(async (ctx) => {
      const hiddenId = await ctx.db.insert("chats", {
        userId,
        kind: "documentary" as const,
        title: "Documents",
        updatedAt: 1,
      });
      const oldMsg = await ctx.db.insert("messages", {
        chatId: hiddenId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      });
      // The OLD turn returned a file that WOULD match the new fetch's reference.
      const storageId = await ctx.storage.store(new Blob([new Uint8Array([1])]));
      await ctx.db.insert("messageParts", {
        messageId: oldMsg,
        order: 0,
        part: {
          kind: "media" as const,
          storageId,
          filename: "guide.md",
          mimeType: "text/markdown",
        },
      });
      // The CURRENT fetch: its pendingFetch.createdAt is set AFTER oldMsg's _creationTime.
      const old = (await ctx.db.get(oldMsg))!;
      await ctx.db.patch(hiddenId, {
        pendingFetch: { sourceMessageId, createdAt: old._creationTime + 1000 },
      });
      await ctx.db.insert("documentAttachments", {
        userId,
        sourceMessageId,
        entryKey: "k|guide",
        reference: "guide.md",
        status: "pending" as const,
        createdAt: 1,
        updatedAt: 1,
      });
      return { hiddenId, oldMsg };
    });

    // The OLD run finalizes LATE.
    await t.mutation(internal.stream.finalize, {
      messageId: oldMsg,
      status: "complete",
      text: "done",
    });

    // Regression guard: without the createdAt guard, correlate would ready the row +
    // clear the lock from a foreign run. With it, the current fetch is untouched.
    const stillPending = await t.run((ctx) =>
      ctx.db
        .query("documentAttachments")
        .withIndex("by_source_status", (q) =>
          q.eq("sourceMessageId", sourceMessageId).eq("status", "pending"),
        )
        .first(),
    );
    expect(stillPending).not.toBeNull(); // row NOT readied by the old run
    const hidden = await t.run((ctx) => ctx.db.get(hiddenId));
    expect(hidden?.pendingFetch).not.toBeUndefined(); // lock NOT cleared
  });
});

describe("correlateDocumentaryFetch", () => {
  test("matches files BY FILENAME → ready/not_found, denorm count, NO system message, clears pendingFetch", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [
        { entryKey: "k|guide", reference: "guide.md" },
        { entryKey: "k|missing", reference: "missing.md" },
      ],
    });
    // Simulate the documentary turn: an assistant message in the hidden chat with a
    // media part named after ONE of the references (path-prefixed → basename match).
    const storageId = await t.run(async (ctx) => {
      const blob = new Blob([new Uint8Array([1, 2, 3])]);
      return await ctx.storage.store(blob);
    });
    const { hidden, fetchMsg } = await t.run(async (ctx) => {
      const hidden = (await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first())!;
      const fetchMsg = await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 2,
      });
      await ctx.db.insert("messageParts", {
        messageId: fetchMsg,
        order: 0,
        part: {
          kind: "media" as const,
          storageId,
          filename: "/srv/docs/guide.md",
          mimeType: "text/markdown",
        },
      });
      return { hidden, fetchMsg };
    });

    await t.run(async (ctx) => {
      const chat = (await ctx.db.get(hidden._id))!;
      const msg = (await ctx.db.get(fetchMsg))!;
      await correlateDocumentaryFetch(ctx, chat, msg);
    });

    const rows = await as.query(api.documentAttachments.getDocumentAttachments, {
      sourceMessageId,
    });
    const guide = rows.find((r) => r.entryKey === "k|guide");
    const missing = rows.find((r) => r.entryKey === "k|missing");
    expect(guide?.status).toBe("ready");
    expect(guide?.url).not.toBeNull(); // a download URL is resolved
    expect(missing?.status).toBe("not_found");

    const after = await t.run(async (ctx) => {
      const chat = await ctx.db.get(hidden._id);
      const src = await ctx.db.get(sourceMessageId);
      const sysMsgs = (
        await ctx.db
          .query("messages")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect()
      ).filter((m) => m.role === "system");
      return {
        pendingCleared: chat?.pendingFetch === undefined,
        attachedDocCount: src?.attachedDocCount,
        systemMessages: sysMsgs.length,
      };
    });
    // pendingFetch cleared; ready count denormalized; NO system recap message.
    expect(after.pendingCleared).toBe(true);
    expect(after.attachedDocCount).toBe(1);
    expect(after.systemMessages).toBe(0);
  });

  test("matches a returned file carrying the gateway media-store `---<uuid>` suffix", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "k|guide", reference: "guide.md" }],
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([1])])),
    );
    const { hidden, fetchMsg } = await t.run(async (ctx) => {
      const hidden = (await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first())!;
      const fetchMsg = await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 2,
      });
      // The agent returns the file with the media-store id appended — the reference
      // was just "guide.md". Without stripping the suffix this is a wrong not_found.
      await ctx.db.insert("messageParts", {
        messageId: fetchMsg,
        order: 0,
        part: {
          kind: "media" as const,
          storageId,
          filename: "guide---4c23520c-b8a8-4533-b48b-b735dd8e1297.md",
          mimeType: "text/markdown",
        },
      });
      return { hidden, fetchMsg };
    });
    await t.run(async (ctx) =>
      correlateDocumentaryFetch(
        ctx,
        (await ctx.db.get(hidden._id))!,
        (await ctx.db.get(fetchMsg))!,
      ),
    );
    const rows = await as.query(api.documentAttachments.getDocumentAttachments, {
      sourceMessageId,
    });
    expect(rows.find((r) => r.entryKey === "k|guide")?.status).toBe("ready");
  });

  test("a file shared by TWO selected cards readies BOTH (same reference, distinct entryKeys)", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [
        { entryKey: "p|0.0", reference: "guide.md" },
        { entryKey: "p|1.0", reference: "guide.md" }, // sibling chunk of the SAME file
      ],
    });
    const storageId = await t.run(async (ctx) => {
      const blob = new Blob([new Uint8Array([9])]);
      return await ctx.storage.store(blob);
    });
    const { hidden, fetchMsg } = await t.run(async (ctx) => {
      const hidden = (await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first())!;
      const fetchMsg = await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 2,
      });
      await ctx.db.insert("messageParts", {
        messageId: fetchMsg,
        order: 0,
        part: {
          kind: "media" as const,
          storageId,
          filename: "guide.md",
          mimeType: "text/markdown",
        },
      });
      return { hidden, fetchMsg };
    });
    await t.run(async (ctx) => {
      const chat = (await ctx.db.get(hidden._id))!;
      const msg = (await ctx.db.get(fetchMsg))!;
      await correlateDocumentaryFetch(ctx, chat, msg);
    });
    const rows = await as.query(api.documentAttachments.getDocumentAttachments, {
      sourceMessageId,
    });
    expect(rows.every((r) => r.status === "ready")).toBe(true);
    expect(rows.map((r) => r.entryKey).sort()).toEqual(["p|0.0", "p|1.0"]);
  });
});

describe("deletion cascade", () => {
  test("deleting the fetch SOURCE message releases the hidden chat's pendingFetch (no fetch_in_flight lock)", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "k|guide", reference: "guide.md" }],
    });
    const hiddenId = await t.run((ctx) =>
      ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first()
        .then((c) => c!._id),
    );
    // The fetch is in flight (pendingFetch points at sourceMessageId).
    expect(
      await t.run((ctx) => ctx.db.get(hiddenId).then((c) => c?.pendingFetch)),
    ).toBeTruthy();

    // Delete the SOURCE message while the fetch is in flight.
    await as.mutation(api.messages.deleteMessage, { messageId: sourceMessageId });

    // Regression guard: without releasing it, pendingFetch dangles at the deleted
    // source → every future attach throws fetch_in_flight.
    const after = await t.run((ctx) =>
      ctx.db.get(hiddenId).then((c) => c?.pendingFetch ?? null),
    );
    expect(after).toBeNull();
  });

  test("deleting the source CHAT releases the hidden documentary fetch lock", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "k|guide", reference: "guide.md" }],
    });
    const hiddenId = await t.run((ctx) =>
      ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first()
        .then((c) => c!._id),
    );
    // Delete the SOURCE chat (cascadeDeleteChat) while the fetch is in flight.
    await as.mutation(api.chats.deleteChat, { chatId });
    // The hidden chat survives but its lock is released (the source is gone).
    const pf = await t.run((ctx) =>
      ctx.db.get(hiddenId).then((c) => c?.pendingFetch ?? null),
    );
    expect(pf).toBeNull();
  });

  test("deleting the source chat purges its documentAttachments (no orphan downloadable refs)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "k|guide", reference: "guide.md" }],
    });
    // Sanity: a row exists before deletion.
    const before = await t.run((ctx) =>
      ctx.db
        .query("documentAttachments")
        .withIndex("by_source_message", (q) =>
          q.eq("sourceMessageId", sourceMessageId),
        )
        .collect(),
    );
    expect(before.length).toBeGreaterThan(0);

    await as.mutation(api.chats.deleteChat, { chatId });

    // Regression guard: without the cascade purge, the row (+ its downloadable
    // storageId) survives the deleted message/chat as an orphan.
    const after = await t.run((ctx) =>
      ctx.db
        .query("documentAttachments")
        .withIndex("by_source_message", (q) =>
          q.eq("sourceMessageId", sourceMessageId),
        )
        .collect(),
    );
    expect(after.length).toBe(0);
  });
});

describe("L2 SOC2 observability traces", () => {
  const traceRows = (t: TestConvex<typeof schema>) =>
    t.run((ctx) => ctx.db.query("traceEvents").collect());

  test("attachDocuments emits a documentary.attach trace (counts only) with a stable correlationId", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [
        { entryKey: "k|guide", reference: "guide.md" },
        { entryKey: "k|faq", reference: "faq.md" },
      ],
    });
    const traces = await traceRows(t);
    const attach = traces.find((e) => e.kind === "documentary.attach");
    expect(attach).toBeDefined();
    // chatId = the CONVERSATIONAL chat the user sees (not the hidden one).
    expect(attach!.chatId).toBe(chatId);
    expect(attach!.correlationId).toMatch(/^docfetch:.+:\d+$/);
    const meta = JSON.parse(attach!.meta!);
    expect(meta.queued).toBe(2);
    expect(meta.distinctFiles).toBe(2);
    expect(typeof meta.hiddenChatId).toBe("string");
  });

  test("correlate + attach traces share ONE correlationId; correlate carries ready/notFound counts", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [
        { entryKey: "k|guide", reference: "guide.md" },
        { entryKey: "k|missing", reference: "missing.md" },
      ],
    });
    const storageId = await t.run(async (ctx) => {
      const blob = new Blob([new Uint8Array([1])]);
      return await ctx.storage.store(blob);
    });
    await t.run(async (ctx) => {
      const hidden = (await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first())!;
      const fetchMsg = await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 2,
      });
      await ctx.db.insert("messageParts", {
        messageId: fetchMsg,
        order: 0,
        part: {
          kind: "media" as const,
          storageId,
          filename: "guide.md",
          mimeType: "text/markdown",
        },
      });
      await correlateDocumentaryFetch(
        ctx,
        (await ctx.db.get(hidden._id))!,
        (await ctx.db.get(fetchMsg))!,
      );
    });
    const traces = await traceRows(t);
    const attach = traces.find((e) => e.kind === "documentary.attach")!;
    const correlate = traces.find((e) => e.kind === "documentary.correlate")!;
    expect(correlate).toBeDefined();
    // The whole fetch is ONE queryable span.
    expect(correlate.correlationId).toBe(attach.correlationId);
    const meta = JSON.parse(correlate.meta!);
    expect(meta.total).toBe(2);
    expect(meta.ready).toBe(1);
    expect(meta.notFound).toBe(1);
    expect(typeof correlate.latencyMs).toBe("number");
  });

  test("failDocumentaryFetchForChat (the bridge dispatch-error path) emits documentary.fail reason=dispatch_error + clears the lock", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "k|guide", reference: "guide.md" }],
    });
    await t.run(async (ctx) => {
      const hidden = (await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first())!;
      await failDocumentaryFetchForChat(ctx, hidden); // default reason
    });
    const traces = await traceRows(t);
    const fail = traces.find((e) => e.kind === "documentary.fail");
    expect(fail).toBeDefined();
    expect(JSON.parse(fail!.meta!).reason).toBe("dispatch_error");
    const rows = await as.query(api.documentAttachments.getDocumentAttachments, {
      sourceMessageId,
    });
    expect(rows.every((r) => r.status === "failed")).toBe(true);
  });

  // The discriminating SOC2 guard: a PHI-bearing file_name must leak through NO
  // trace field. Seed a sentinel reference, run the full attach→correlate, then
  // assert the string is absent from EVERY serialized trace row (not just "meta
  // has no `reference` key"). Delete any field that carries it → this fails.
  test("SENTINEL: a PHI-like reference appears in NO trace field", async () => {
    const SENTINEL = "secret-patient-dupont-2026.pdf";
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
      await ctx.db.insert("instances", { name: "primary", gatewayUrl: "ws://gw" });
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "doc",
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
        types: ["documentary"],
      });
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "primary",
        agentId: "doc",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const sourceMessageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "reply",
        updatedAt: 1,
      });
      await ctx.db.insert("messageParts", {
        messageId: sourceMessageId,
        order: 0,
        part: {
          kind: "provenance" as const,
          v: 1,
          pluginId: "p",
          source: "rag",
          group: "documents" as const,
          items: [{ file_name: SENTINEL }],
        },
      });
      return { userId, sourceMessageId };
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      // entryKey MIRRORS PRODUCTION: SourceEntry.key embeds the file_name
      // (pluginId|group|file_name|partIdx.i), so it is the MOST likely accidental
      // PHI carrier. The sentinel must catch a leak through entryKey too, not just
      // reference/filename.
      items: [{ entryKey: `lightrag|documents|${SENTINEL}|0.0`, reference: SENTINEL }],
    });
    const storageId = await t.run(async (ctx) => {
      const blob = new Blob([new Uint8Array([7])]);
      return await ctx.storage.store(blob);
    });
    await t.run(async (ctx) => {
      const hidden = (await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first())!;
      const fetchMsg = await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 2,
      });
      await ctx.db.insert("messageParts", {
        messageId: fetchMsg,
        order: 0,
        part: {
          kind: "media" as const,
          storageId,
          filename: SENTINEL,
          mimeType: "application/pdf",
        },
      });
      await correlateDocumentaryFetch(
        ctx,
        (await ctx.db.get(hidden._id))!,
        (await ctx.db.get(fetchMsg))!,
      );
    });
    const traces = await traceRows(t);
    // NON-VACUOUS: the L2 traces MUST exist, else the no-leak proof guards nothing
    // (a best-effort catch swallowing both emissions would otherwise pass green).
    expect(traces.some((e) => e.kind === "documentary.attach")).toBe(true);
    expect(traces.some((e) => e.kind === "documentary.correlate")).toBe(true);
    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain("secret-patient-dupont");
    expect(serialized).not.toContain(".pdf");
  });
});

describe("attachedDocCount stays honest on re-attach", () => {
  const docCount = (t: TestConvex<typeof schema>, id: Id<"messages">) =>
    t.run((ctx) => ctx.db.get(id).then((m) => m?.attachedDocCount));

  test("re-attaching a previously-READY card drops the count immediately", async () => {
    const t = convexTest(schema, modules);
    const { userId, sourceMessageId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "k|guide", reference: "guide.md" }],
    });
    // Simulate the fetch returning guide.md → correlate readies the row + sets count.
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([1])])),
    );
    const { hidden, fetchMsg } = await t.run(async (ctx) => {
      const hidden = (await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "documentary"))
        .first())!;
      const fetchMsg = await ctx.db.insert("messages", {
        chatId: hidden._id,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 2,
      });
      await ctx.db.insert("messageParts", {
        messageId: fetchMsg,
        order: 0,
        part: {
          kind: "media" as const,
          storageId,
          filename: "guide.md",
          mimeType: "text/markdown",
        },
      });
      // In prod the dispatch acks (outbox -> sent) and the reply finalizes BEFORE
      // correlate fires, so the hidden chat is idle again. Mirror that: leaving the
      // first attach's outbox `pending` would keep isChatBusy true and make the
      // re-attach below wrongly hit fetch_in_flight.
      const ob = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", hidden._id).eq("status", "pending"),
        )
        .first();
      if (ob) await ctx.db.patch(ob._id, { status: "sent" });
      return { hidden, fetchMsg };
    });
    await t.run(async (ctx) =>
      correlateDocumentaryFetch(
        ctx,
        (await ctx.db.get(hidden._id))!,
        (await ctx.db.get(fetchMsg))!,
      ),
    );
    expect(await docCount(t, sourceMessageId)).toBe(1); // ready → advertised

    // Re-attach the SAME card → its row resets to `pending` (storageId cleared).
    await as.mutation(api.documentAttachments.attachDocuments, {
      sourceMessageId,
      items: [{ entryKey: "k|guide", reference: "guide.md" }],
    });
    // Regression guard: without the recompute the count stays 1 and the chip
    // advertises a download whose row is now pending (and gone if the re-fetch fails).
    // (convex-test reads an unset optional back as null; prod sees the field absent.)
    expect(await docCount(t, sourceMessageId)).toBeNull();
  });
});
