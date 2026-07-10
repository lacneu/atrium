import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  buildConversionPrompt,
  isConvertibleDocument,
  isPdfPart,
  pickDeliveredPdf,
  RENDITION_TIMEOUT_MS,
} from "./fileRenditions";

const modules = import.meta.glob("./**/*.ts");

// Document renditions (Release B). The discriminating tests are the ones the
// advisor flagged: the correlation artifact-rule (delivered PDF vs nothing),
// the IDOR-on-read (a rendition only for a file the caller owns), idempotency
// (a double-click never double-converts), and the timeout bound.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("pure helpers", () => {
  test("isConvertibleDocument: Office by mime OR extension; native formats are not", () => {
    expect(isConvertibleDocument(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "x.pptx",
    )).toBe(true);
    expect(isConvertibleDocument("application/octet-stream", "deck.pptx")).toBe(true);
    expect(isConvertibleDocument("application/octet-stream", "notes.docx")).toBe(true);
    expect(isConvertibleDocument("application/pdf", "already.pdf")).toBe(false);
    expect(isConvertibleDocument("image/png", "shot.png")).toBe(false);
    expect(isConvertibleDocument("text/plain", "n.txt")).toBe(false);
  });

  test("pickDeliveredPdf: the FIRST PDF file/media part with a storageId; none otherwise", () => {
    expect(isPdfPart({ mimeType: "application/pdf" })).toBe(true);
    expect(isPdfPart({ mimeType: "application/octet-stream", filename: "out.pdf" })).toBe(true);
    expect(isPdfPart({ mimeType: "text/plain", filename: "x.txt" })).toBe(false);
    const parts = [
      { kind: "text" },
      { kind: "media", mimeType: "image/png", filename: "thumb.png", storageId: "s1" },
      { kind: "media", mimeType: "application/pdf", filename: "deck.pdf", storageId: "sPDF" },
      { kind: "file", mimeType: "application/pdf", filename: "second.pdf", storageId: "s2" },
    ];
    expect(pickDeliveredPdf(parts)?.storageId).toBe("sPDF");
    // A converter turn that returned only text/an image → no PDF.
    expect(pickDeliveredPdf([{ kind: "media", mimeType: "image/png", storageId: "i" }])).toBeNull();
    // A PDF part with no storageId doesn't count (nothing to render).
    expect(pickDeliveredPdf([{ kind: "file", mimeType: "application/pdf" }])).toBeNull();
  });

  test("buildConversionPrompt localizes, falls back to English", () => {
    expect(buildConversionPrompt("fr")).toMatch(/PDF/);
    expect(buildConversionPrompt("en")).toMatch(/PDF/);
    expect(buildConversionPrompt("xx")).toBe(buildConversionPrompt("en"));
  });
});

/** Seed: a user + a chat on an instance whose config designates a converter agent
 *  (present), + an owned Office file part in that chat. Returns the source
 *  storageId + ids. `converter:false` omits the designation (unconfigured path). */
async function seed(
  t: ReturnType<typeof convexTest>,
  opts?: { converter?: boolean; converterPresent?: boolean; foreign?: boolean },
) {
  const converter = opts?.converter ?? true;
  const present = opts?.converterPresent ?? true;
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "alice" });
    await ctx.db.insert("instances", {
      name: "prod",
      gatewayUrl: "ws://x",
      ...(converter ? { config: { converterAgentId: "convbot" } } : {}),
    });
    if (converter) {
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "convbot",
        source: "discovered" as const,
        presentInLastOk: present,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
    }
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "Voici le deck.",
      updatedAt: 1,
    });
    const storageId = await ctx.storage.store(
      new Blob(["PPTX"], {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    );
    // The `files` row IS the authorization anchor (ownedFile). A `foreign` seed
    // gives it to a DIFFERENT user so the caller doesn't own it.
    const ownerId = opts?.foreign
      ? await ctx.db.insert("users", {})
      : userId;
    await ctx.db.insert("files", {
      userId: ownerId,
      chatId,
      messageId,
      storageId,
      filename: "IFOA.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      kind: "file" as const,
      direction: "inbound" as const,
      createdAt: 1,
    });
    await ctx.db.insert("messageParts", {
      messageId,
      order: 1,
      part: {
        kind: "file" as const,
        storageId,
        filename: "IFOA.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
    });
    return { userId, chatId, messageId, storageId };
  });
}

describe("requestRendition + getRendition", () => {
  test("happy path: creates ONE pending row + dispatches a converter turn with the file attached", async () => {
    const t = convexTest(schema, modules);
    const { userId, storageId } = await seed(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    const res = await as.mutation(api.fileRenditions.requestRendition, {
      sourceStorageId: storageId,
    });
    expect(res.status).toBe("pending");
    const state = await t.run(async (ctx) => {
      const rows = await ctx.db.query("fileRenditions").collect();
      const hidden = await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "converter"))
        .collect();
      const outbox = await ctx.db.query("outbox").collect();
      return { rows, hidden, outbox };
    });
    expect(state.rows.length).toBe(1);
    expect(state.rows[0]!.status).toBe("pending");
    expect(state.rows[0]!.converterAgentId).toBe("convbot");
    // A hidden converter chat bound to the designated agent, with the file riding
    // the outbox as an attachment (the transport both providers already handle).
    expect(state.hidden.length).toBe(1);
    expect(state.hidden[0]!.pendingConvert).toBeTruthy();
    expect(state.outbox.length).toBe(1);
    expect(state.outbox[0]!.attachments?.[0]?.storageId).toBe(storageId);
  });

  test("IDEMPOTENT: a second request (double-click) never creates a second row or dispatch", async () => {
    const t = convexTest(schema, modules);
    const { userId, storageId } = await seed(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId });
    await as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId });
    const counts = await t.run(async (ctx) => ({
      rows: (await ctx.db.query("fileRenditions").collect()).length,
      outbox: (await ctx.db.query("outbox").collect()).length,
    }));
    expect(counts.rows).toBe(1);
    expect(counts.outbox).toBe(1); // the second click no-ops on the pending row
  });

  test("IDOR: a file the caller does NOT own is never renditioned (read + trigger)", async () => {
    const t = convexTest(schema, modules);
    const { userId, storageId } = await seed(t, { foreign: true });
    const as = t.withIdentity({ subject: `${userId}|session` });
    // Read: a foreign source reports unconfigured (never leaks a rendition).
    const read = await as.query(api.fileRenditions.getRendition, {
      sourceStorageId: storageId,
    });
    expect(read.status).toBe("unconfigured");
    // Trigger: forbidden.
    await expect(
      as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId }),
    ).rejects.toThrow(/forbidden/);
  });

  test("UNCONFIGURED: no designated converter → no row, download fallback", async () => {
    const t = convexTest(schema, modules);
    const { userId, storageId } = await seed(t, { converter: false });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const res = await as.mutation(api.fileRenditions.requestRendition, {
      sourceStorageId: storageId,
    });
    expect(res.status).toBe("unconfigured");
    const rows = await t.run((ctx) => ctx.db.query("fileRenditions").collect());
    expect(rows.length).toBe(0); // no cached failure — re-click works once configured
  });

  test("a DELETED designated agent resolves to null → unconfigured (never dispatches to a ghost)", async () => {
    const t = convexTest(schema, modules);
    const { userId, storageId } = await seed(t, { converterPresent: false });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const res = await as.mutation(api.fileRenditions.requestRendition, {
      sourceStorageId: storageId,
    });
    expect(res.status).toBe("unconfigured");
  });
});

describe("correlation (from stream.finalize) + timeout", () => {
  test("a delivered PDF makes the rendition READY; text-only makes it FAILED", async () => {
    const t = convexTest(schema, modules);
    const { userId, storageId } = await seed(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId });
    // Simulate the converter turn finalizing: an assistant message on the hidden
    // chat carrying a delivered PDF media part, then run stream.finalize.
    const { assistantId, pdfId } = await t.run(async (ctx) => {
      const hidden = await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "converter"))
        .first();
      const assistantId = await ctx.db.insert("messages", {
        chatId: hidden!._id,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 2,
      });
      await ctx.db.insert("streamingText", {
        messageId: assistantId,
        chatId: hidden!._id,
        text: "",
        updatedAt: 2,
      });
      const pdfId = await ctx.storage.store(
        new Blob(["%PDF"], { type: "application/pdf" }),
      );
      await ctx.db.insert("messageParts", {
        messageId: assistantId,
        order: 1,
        part: {
          kind: "media" as const,
          storageId: pdfId,
          filename: "IFOA.pdf",
          mimeType: "application/pdf",
        },
      });
      return { assistantId, pdfId };
    });
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "complete" as const,
      text: "Voici le PDF.",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const ready = await t.run(async (ctx) => {
      const row = await ctx.db.query("fileRenditions").first();
      const hidden = await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "converter"))
        .first();
      return { row, hidden };
    });
    expect(ready.row!.status).toBe("ready");
    expect(ready.row!.pdfStorageId).toBe(pdfId);
    expect(ready.hidden!.pendingConvert).toBeUndefined(); // lock cleared

    // getRendition now serves the PDF url to the owner.
    const view = await as.query(api.fileRenditions.getRendition, { sourceStorageId: storageId });
    expect(view.status).toBe("ready");
  });

  test("QUEUE: opening a SECOND Office file while the first converts dispatches it once the first settles (no timeout dead-end)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, storageId } = await seed(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    // First file → dispatches immediately (one outbox).
    await as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId });
    // Second Office file in the same chat, owned by the same user.
    const storage2 = await t.run(async (ctx) => {
      const messageId = (
        await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()
      )[0]!._id;
      const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      const sid = await ctx.storage.store(new Blob(["PPTX2"], { type: PPTX }));
      await ctx.db.insert("files", {
        userId, chatId, messageId, storageId: sid, filename: "deck2.pptx",
        mimeType: PPTX, kind: "file" as const, direction: "inbound" as const, createdAt: 2,
      });
      return sid;
    });
    await as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storage2 });
    // The second is QUEUED (pending row) but NOT dispatched yet — the chat is busy.
    let outboxCount = await t.run(async (ctx) => (await ctx.db.query("outbox").collect()).length);
    expect(outboxCount).toBe(1); // only the first dispatched
    const pendingRows = await t.run((ctx) =>
      ctx.db.query("fileRenditions").withIndex("by_status", (q) => q.eq("status", "pending")).collect(),
    );
    expect(pendingRows.length).toBe(2); // both queued

    // Simulate the first turn's dispatch completing (outbox pending → sent) so
    // the chat is no longer "busy" on a pending outbox when its turn finalizes.
    const assistantId = await t.run(async (ctx) => {
      const ob = await ctx.db.query("outbox").first();
      await ctx.db.patch(ob!._id, { status: "sent" as const });
      const hidden = await ctx.db.query("chats").filter((q) => q.eq(q.field("kind"), "converter")).first();
      const aid = await ctx.db.insert("messages", {
        chatId: hidden!._id, userId, role: "assistant" as const, status: "streaming" as const, text: "", updatedAt: 3,
      });
      await ctx.db.insert("streamingText", { messageId: aid, chatId: hidden!._id, text: "", updatedAt: 3 });
      return aid;
    });
    // finalize with NO pdf part → the first rendition fails, drain dispatches #2.
    await t.mutation(internal.stream.finalize, { messageId: assistantId, status: "complete" as const, text: "done" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    outboxCount = await t.run(async (ctx) => (await ctx.db.query("outbox").collect()).length);
    expect(outboxCount).toBe(2); // the SECOND got dispatched by the drain
  });

  test("the timeout cron fails a rendition stuck pending past the window", async () => {
    const t = convexTest(schema, modules);
    const { userId, storageId } = await seed(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId });
    // Age the pending row past the timeout, then run the cron.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("fileRenditions").first();
      await ctx.db.patch(row!._id, { createdAt: Date.now() - RENDITION_TIMEOUT_MS - 1000 });
    });
    await t.mutation(internal.fileRenditions.timeoutStaleRenditions, {});
    const row = await t.run((ctx) => ctx.db.query("fileRenditions").first());
    expect(row!.status).toBe("failed");
    expect(row!.failureReason).toBe("timeout");
  });
});
