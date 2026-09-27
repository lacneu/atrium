import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { MAX_PARTICIPATIONS_SCANNED } from "./lib/chatAccess";
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
    // The `files` row IS the authorization anchor (readableFile). A `foreign`
    // seed gives it to a DIFFERENT user, in THEIR conversation — one the caller
    // is not in, so the caller neither owns nor sees it.
    const ownerId = opts?.foreign
      ? await ctx.db.insert("users", {})
      : userId;
    const fileChatId = opts?.foreign
      ? await ctx.db.insert("chats", {
          userId: ownerId,
          updatedAt: 1,
          instanceName: "prod",
          agentId: "main",
        })
      : chatId;
    await ctx.db.insert("files", {
      userId: ownerId,
      chatId: fileChatId,
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

// A PARTICIPANT sees what the conversation shows them: the file is the OWNER's
// `files` row. Reported in production: the shared file downloaded, but its
// preview failed for the participant.
describe("a participant of the conversation", () => {
  async function seat(
    t: ReturnType<typeof convexTest>,
    chatId: Id<"chats">,
    ownerId: Id<"users">,
    role: "viewer" | "member",
  ) {
    return t.run(async (ctx) => {
      const guest = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: guest, role: "user" as const, canonical: "bob" });
      await ctx.db.insert("chatParticipants", {
        chatId,
        userId: guest,
        addedBy: ownerId,
        addedAt: 1,
        role,
      });
      return guest;
    });
  }

  test("a member gets the preview, converted on the OWNER's converter chat", async () => {
    const t = convexTest(schema, modules);
    const { userId: ownerId, chatId, storageId } = await seed(t);
    const guest = await seat(t, chatId, ownerId, "member");
    const as = t.withIdentity({ subject: `${guest}|session` });
    const read = await as.query(api.fileRenditions.getRendition, { sourceStorageId: storageId });
    expect(read.status).toBe("pending");
    const res = await as.mutation(api.fileRenditions.requestRendition, {
      sourceStorageId: storageId,
    });
    expect(res.status).toBe("pending");
    const state = await t.run(async (ctx) => ({
      rows: await ctx.db.query("fileRenditions").collect(),
      hidden: await ctx.db
        .query("chats")
        .filter((q) => q.eq(q.field("kind"), "converter"))
        .collect(),
    }));
    expect(state.rows.length).toBe(1);
    expect(state.rows[0]!.userId).toBe(ownerId);
    expect(state.hidden.map((c) => c.userId)).toEqual([ownerId]);
  });

  test("a viewer reads an existing rendition but never starts one", async () => {
    const t = convexTest(schema, modules);
    const { userId: ownerId, chatId, storageId } = await seed(t);
    const viewer = await seat(t, chatId, ownerId, "viewer");
    const as = t.withIdentity({ subject: `${viewer}|session` });
    // No rendition yet: "no preview" (download fallback), not "pending".
    const before = await as.query(api.fileRenditions.getRendition, { sourceStorageId: storageId });
    expect(before.status).toBe("unconfigured");
    await expect(
      as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId }),
    ).rejects.toThrow(/forbidden/);
    // The owner's rendition, once ready, is the viewer's to read.
    await t.run(async (ctx) => {
      const pdf = await ctx.storage.store(new Blob(["%PDF"], { type: "application/pdf" }));
      await ctx.db.insert("fileRenditions", {
        sourceStorageId: storageId,
        chatId,
        userId: ownerId,
        sourceFilename: "IFOA.pptx",
        sourceMimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        status: "ready" as const,
        pdfStorageId: pdf,
        converterInstance: "prod",
        converterAgentId: "convbot",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const after = await as.query(api.fileRenditions.getRendition, { sourceStorageId: storageId });
    expect(after.status).toBe("ready");
  });

  // Codex review (2026-09-27), P2: the blob's rows were scanned `take(32)` — a fork
  // copies them onto the same storageId, so enough copies pushed the caller's row out
  // of the window — and the FIRST reachable conversation decided, so a viewer seat
  // shadowed a member seat.
  async function forkedCopies(
    t: ReturnType<typeof convexTest>,
    storageId: Id<"_storage">,
    count: number,
  ) {
    await t.run(async (ctx) => {
      const stranger = await ctx.db.insert("users", {});
      for (let i = 0; i < count; i++) {
        const c = await ctx.db.insert("chats", { userId: stranger, updatedAt: 1, instanceName: "prod", agentId: "main" });
        const messageId = await ctx.db.insert("messages", {
          chatId: c,
          userId: stranger,
          role: "user" as const,
          status: "complete" as const,
          text: "copie",
          updatedAt: 1,
        });
        await ctx.db.insert("files", {
          userId: stranger,
          chatId: c,
          messageId,
          storageId,
          filename: "IFOA.pptx",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          kind: "file" as const,
          direction: "inbound" as const,
          createdAt: 1,
        });
      }
    });
  }
  async function laterCopyIn(
    t: ReturnType<typeof convexTest>,
    ownerId: Id<"users">,
    storageId: Id<"_storage">,
  ) {
    return t.run(async (ctx) => {
      const c = await ctx.db.insert("chats", { userId: ownerId, updatedAt: 1, instanceName: "prod", agentId: "main" });
      const messageId = await ctx.db.insert("messages", {
        chatId: c,
        userId: ownerId,
        role: "user" as const,
        status: "complete" as const,
        text: "copie",
        updatedAt: 2,
      });
      await ctx.db.insert("files", {
        userId: ownerId,
        chatId: c,
        messageId,
        storageId,
        filename: "IFOA.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        kind: "file" as const,
        direction: "inbound" as const,
        createdAt: 2,
      });
      return c;
    });
  }

  test("a member whose conversation's row sits behind many fork copies still reaches it", async () => {
    const t = convexTest(schema, modules);
    const { userId: ownerId, storageId } = await seed(t);
    await forkedCopies(t, storageId, 40);
    const later = await laterCopyIn(t, ownerId, storageId);
    const guest = await seat(t, later, ownerId, "member");
    const as = t.withIdentity({ subject: `${guest}|session` });
    const res = await as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId });
    expect(res.status).toBe("pending");
  });

  test("a member seat wins over a viewer seat on the same file", async () => {
    const t = convexTest(schema, modules);
    const { userId: ownerId, chatId, storageId } = await seed(t);
    const viewer = await seat(t, chatId, ownerId, "viewer");
    const later = await laterCopyIn(t, ownerId, storageId);
    await t.run((ctx) =>
      ctx.db.insert("chatParticipants", { chatId: later, userId: viewer, addedBy: ownerId, addedAt: 2, role: "member" }),
    );
    const as = t.withIdentity({ subject: `${viewer}|session` });
    const res = await as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId });
    expect(res.status).toBe("pending");
  });

  // Codex pass 2 (2026-09-27), P3: without the viewer's conversation, access was found
  // through the caller's first MAX_PARTICIPATIONS_SCANNED seats — a chat reachable by URL
  // past that window (or behind stale seats) read `unconfigured`. The viewer passes its
  // chatId; THAT conversation decides, by point reads.
  test("the viewer's conversation decides, even past the participation scan", async () => {
    const t = convexTest(schema, modules);
    const { userId: ownerId, storageId } = await seed(t);
    const guest = await t.run(async (ctx) => {
      const g = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: g, role: "user" as const, canonical: "bob" });
      // Seats that fill the scan window first (other conversations of the same owner).
      for (let i = 0; i < MAX_PARTICIPATIONS_SCANNED; i++) {
        const c = await ctx.db.insert("chats", { userId: ownerId, updatedAt: 1, instanceName: "prod", agentId: "main" });
        await ctx.db.insert("chatParticipants", { chatId: c, userId: g, addedBy: ownerId, addedAt: 1, role: "member" });
      }
      return g;
    });
    const later = await laterCopyIn(t, ownerId, storageId);
    await t.run((ctx) =>
      ctx.db.insert("chatParticipants", { chatId: later, userId: guest, addedBy: ownerId, addedAt: 2, role: "member" }),
    );
    const as = t.withIdentity({ subject: `${guest}|session` });
    expect((await as.query(api.fileRenditions.getRendition, { sourceStorageId: storageId })).status).toBe("unconfigured");
    expect(
      (await as.query(api.fileRenditions.getRendition, { sourceStorageId: storageId, chatId: later })).status,
    ).toBe("pending");
    const res = await as.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId, chatId: later });
    expect(res.status).toBe("pending");
  });

  test("the chatId is no way around the guard: a chat not reachable, or a blob not in it", async () => {
    const t = convexTest(schema, modules);
    const { userId: ownerId, chatId, storageId } = await seed(t);
    const stranger = await t.run(async (ctx) => {
      const s = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: s, role: "user" as const, canonical: "eve" });
      return s;
    });
    const eve = t.withIdentity({ subject: `${stranger}|session` });
    expect((await eve.query(api.fileRenditions.getRendition, { sourceStorageId: storageId, chatId })).status).toBe(
      "unconfigured",
    );
    await expect(
      eve.mutation(api.fileRenditions.requestRendition, { sourceStorageId: storageId, chatId }),
    ).rejects.toThrow(/forbidden/);
    // The owner, naming a conversation of theirs that does NOT hold this blob.
    const other = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: ownerId, updatedAt: 1, instanceName: "prod", agentId: "main" }),
    );
    const owner = t.withIdentity({ subject: `${ownerId}|session` });
    expect(
      (await owner.query(api.fileRenditions.getRendition, { sourceStorageId: storageId, chatId: other })).status,
    ).toBe("unconfigured");
  });
});

