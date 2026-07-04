/// <reference types="vite/client" />
//
// Settings → Fichiers backend. Pins the table INVARIANT (a `files` row exists iff
// a file/media messagePart does) across the producer AND the delete/regenerate
// mirror — the correctness risk flagged in review — plus the owner-scoped query,
// its filters/self-hiding facets, and the re-runnable backfill.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { QUEUED_ORDER_SENTINEL } from "./lib/messageOrder";

const modules = import.meta.glob("./**/*.ts");

async function seedUser(t: ReturnType<typeof convexTest>, canonical: string) {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: uid,
      role: "user" as const,
      canonical,
    });
    return uid;
  });
}

describe("files: invariant + owner-scoped listing", () => {
  test("outbound producer (addPart media) → a files row; listMine returns it", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "u");
    const { messageId } = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
      });
      const mid = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 1,
      });
      return { messageId: mid };
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["png-bytes"])),
    );
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: {
        kind: "media",
        storageId,
        filename: "out.png",
        mimeType: "image/png",
      },
    });

    const res = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.files.listMine, {});
    expect(res.files.length).toBe(1);
    expect(res.files[0].direction).toBe("outbound");
    expect(res.files[0].category).toBe("image");
    expect(res.files[0].filename).toBe("out.png");
    expect(res.files[0].instanceName).toBe("prod");
    expect(res.files[0].url).not.toBeNull(); // real blob → signed URL
    // Single provider → the instance filter self-hides.
    expect(res.facets.multiProvider).toBe(false);
  });

  test("DELETE mirror: deleteMessage removes the message's files rows", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "u");
    const { messageId } = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const mid = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 1,
      });
      return { messageId: mid };
    });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "file", storageId, filename: "doc.pdf", mimeType: "application/pdf" },
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    expect((await as.query(api.files.listMine, {})).files.length).toBe(1);

    await as.mutation(api.messages.deleteMessage, { messageId });

    // Invariant held: part gone → files row gone (no orphan).
    expect((await as.query(api.files.listMine, {})).files.length).toBe(0);
    const orphans = await t.run((ctx) => ctx.db.query("files").collect());
    expect(orphans.length).toBe(0);
  });

  test("truncate-forward uses LOGICAL order: deleting an assistant removes a queued follow-up (no orphan)", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "u");
    const { chatId, user1, user2, assistant1 } = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const mk = (role: "user" | "assistant", text: string) =>
        ctx.db.insert("messages", {
          chatId,
          userId,
          role,
          status: "complete" as const,
          text,
          updatedAt: 1,
        });
      const user1 = await mk("user", "U1");
      const user2 = await mk("user", "U2"); // queued in U1's pre-ack: early _ct
      const assistant1 = await mk("assistant", "A1"); // U1's reply, later _ct
      const a1 = (await ctx.db.get(assistant1))!;
      // U2 was DRAINED → orderTime AFTER A1 (logically after A1, _ct before it).
      await ctx.db.patch(user2, { orderTime: a1._creationTime + 1 });
      // U2 still carries a queued outbox (the purge below would orphan its message).
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "u2",
        messageId: user2,
        text: "U2",
        attachmentIds: [],
        status: "queued" as const,
      });
      return { chatId, user1, user2, assistant1 };
    });
    const as = t.withIdentity({ subject: `${userId}|session` });

    await as.mutation(api.messages.deleteMessage, { messageId: assistant1 });

    const ids = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect()
        .then((rows) => rows.map((m) => m._id)),
    );
    expect(ids).toContain(user1); // U1 kept (logically before A1)
    expect(ids).not.toContain(assistant1); // A1 deleted
    // Regression guard: raw _creationTime truncation keeps U2 (early _ct) as an
    // undispatchable orphan (its outbox is purged); effectiveOrder removes it too.
    expect(ids).not.toContain(user2);
  });

  test("truncate-forward keeps an EARLIER still-queued follow-up when a LATER one is deleted", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "u");
    const { chatId, u2, u3 } = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      // Two follow-ups parked at once → BOTH carry the SENTINEL; only _creationTime
      // (FIFO) separates them.
      const mk = (text: string) =>
        ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user" as const,
          status: "complete" as const,
          text,
          orderTime: QUEUED_ORDER_SENTINEL,
          updatedAt: 1,
        });
      const u2 = await mk("U2"); // queued first (earlier _ct)
      const u3 = await mk("U3"); // queued second (later _ct), SAME sentinel
      return { chatId, u2, u3 };
    });
    const as = t.withIdentity({ subject: `${userId}|session` });

    // Delete U3 (the later follow-up). Regression guard: comparing effectiveOrder
    // ALONE (both SENTINEL) would truncate U2 too; compareOrder's _creationTime
    // tie-break keeps the earlier-queued U2.
    await as.mutation(api.messages.deleteMessage, { messageId: u3 });

    const ids = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect()
        .then((rows) => rows.map((m) => m._id)),
    );
    expect(ids).toContain(u2); // earlier still-queued follow-up KEPT
    expect(ids).not.toContain(u3); // the deleted one gone
  });

  test("backfill is re-runnable: legacy part with no files row → 1 row; second run inserts nothing", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "u");
    // Insert a file part DIRECTLY (simulating a pre-`files` legacy row).
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const mid = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "hi",
        updatedAt: 1,
      });
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 0,
        part: { kind: "file", storageId, filename: "legacy.txt", mimeType: "text/plain" },
      });
    });

    const first = await t.mutation(internal.files.backfillFiles, {});
    expect(first.inserted).toBe(1);
    const second = await t.mutation(internal.files.backfillFiles, {});
    expect(second.inserted).toBe(0); // dedup guard → idempotent

    const res = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.files.listMine, {});
    expect(res.files.length).toBe(1); // not 2
    expect(res.files[0].direction).toBe("inbound");
    expect(res.files[0].category).toBe("document");
  });

  test("filters + owner isolation: a user never sees another user's files", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, "a");
    const b = await seedUser(t, "b");
    // A: one inbound (image) + one outbound (pdf). B: one outbound.
    await t.run(async (ctx) => {
      const sid = async () => await ctx.storage.store(new Blob(["x"]));
      const chatA = await ctx.db.insert("chats", { userId: a, updatedAt: 1 });
      const chatB = await ctx.db.insert("chats", { userId: b, updatedAt: 1 });
      const mkFile = async (
        userId: typeof a,
        chatId: typeof chatA,
        direction: "inbound" | "outbound",
        mimeType: string,
      ) =>
        ctx.db.insert("files", {
          userId,
          chatId,
          messageId: await ctx.db.insert("messages", {
            chatId,
            userId,
            role: direction === "inbound" ? ("user" as const) : ("assistant" as const),
            status: "complete" as const,
            text: "",
            updatedAt: 1,
          }),
          storageId: await sid(),
          filename: `${direction}.bin`,
          mimeType,
          kind: "file" as const,
          direction,
          createdAt: 1,
        });
      await mkFile(a, chatA, "inbound", "image/png");
      await mkFile(a, chatA, "outbound", "application/pdf");
      await mkFile(b, chatB, "outbound", "application/pdf");
    });

    const asA = t.withIdentity({ subject: `${a}|session` });
    expect((await asA.query(api.files.listMine, {})).files.length).toBe(2);
    // Direction filter.
    const inbound = await asA.query(api.files.listMine, { direction: "inbound" });
    expect(inbound.files.length).toBe(1);
    expect(inbound.files[0].category).toBe("image");
    // Owner isolation: B sees only their own.
    const asB = t.withIdentity({ subject: `${b}|session` });
    const bRes = await asB.query(api.files.listMine, {});
    expect(bRes.files.length).toBe(1);
    expect(bRes.files[0].direction).toBe("outbound");
  });

  test("producer denormalizes `category`; the category filter is server-side", async () => {
    // Codex P2: filters (incl. category) must run server-side, BEFORE the cap, so
    // they need the stored `category` column. This pins that the producer writes
    // it and the filter selects the right subset while facets list every value.
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "u");
    const { messageId } = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const mid = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 1,
      });
      return { messageId: mid };
    });
    const imgId = await t.run((ctx) => ctx.storage.store(new Blob(["img"])));
    const pdfId = await t.run((ctx) => ctx.storage.store(new Blob(["pdf"])));
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "media", storageId: imgId, filename: "a.png", mimeType: "image/png" },
    });
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "file", storageId: pdfId, filename: "b.pdf", mimeType: "application/pdf" },
    });

    // The producer denormalized `category` onto each row (not derived at read).
    const stored = await t.run((ctx) => ctx.db.query("files").collect());
    expect(stored.map((r) => r.category).sort()).toEqual(["image", "pdf"]);

    const as = t.withIdentity({ subject: `${userId}|session` });
    const pdfs = await as.query(api.files.listMine, { category: "pdf" });
    expect(pdfs.files.length).toBe(1);
    expect(pdfs.files[0].filename).toBe("b.pdf");
    // Facets list every category regardless of the active filter.
    expect(pdfs.facets.categories.slice().sort()).toEqual(["image", "pdf"]);
  });

  test("category + direction combo: indexed cover returns the right subset AND keeps createdAt desc", async () => {
    // Codex P2 (round 2): category+direction is the only reachable multi-filter
    // non-chatId combo; it routes through `by_user_category_direction`. That index
    // is [userId, category, direction, createdAt] — its desc ordering only holds
    // when BOTH category and direction are eq-constrained (the gate in listMine).
    // Tiny fixtures would hide an ordering bug, so seed UNSORTED createdAt and
    // assert the result is sorted desc, plus that noise (other category/direction)
    // is excluded.
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "u");
    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const sid = () => ctx.storage.store(new Blob(["x"]));
      const mkMsg = (role: "user" | "assistant") =>
        ctx.db.insert("messages", {
          chatId,
          userId,
          role,
          status: "complete" as const,
          text: "",
          updatedAt: 1,
        });
      const mkFile = async (
        direction: "inbound" | "outbound",
        category: "image" | "pdf",
        mimeType: string,
        createdAt: number,
        filename: string,
      ) =>
        ctx.db.insert("files", {
          userId,
          chatId,
          messageId: await mkMsg(direction === "inbound" ? "user" : "assistant"),
          storageId: await sid(),
          filename,
          mimeType,
          kind: "file" as const,
          direction,
          category,
          createdAt,
        });
      // Target subset (image + inbound), createdAt deliberately UNSORTED.
      await mkFile("inbound", "image", "image/png", 10, "img-old.png");
      await mkFile("inbound", "image", "image/png", 30, "img-new.png");
      await mkFile("inbound", "image", "image/png", 20, "img-mid.png");
      // Noise: same category other direction, and same direction other category.
      await mkFile("outbound", "image", "image/png", 99, "img-out.png");
      await mkFile("inbound", "pdf", "application/pdf", 99, "doc-in.pdf");
    });

    const as = t.withIdentity({ subject: `${userId}|session` });
    const res = await as.query(api.files.listMine, {
      category: "image",
      direction: "inbound",
    });
    // Subset: only the three image+inbound rows (noise excluded).
    expect(res.files.map((f) => f.filename)).toEqual([
      "img-new.png",
      "img-mid.png",
      "img-old.png",
    ]);
    // Ordering: createdAt strictly descending (the index-prefix ordering trap).
    expect(res.files.map((f) => f.createdAt)).toEqual([30, 20, 10]);
    expect(res.files.every((f) => f.category === "image")).toBe(true);
    expect(res.files.every((f) => f.direction === "inbound")).toBe(true);
  });

  test("softDelete: owner hides from listMine (soft + idempotent); cross-user rejected", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, "a");
    const b = await seedUser(t, "b");
    const fileId = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId: a, updatedAt: 1 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId: a,
        role: "assistant" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 1,
      });
      return ctx.db.insert("files", {
        userId: a,
        chatId,
        messageId,
        storageId: await ctx.storage.store(new Blob(["x"])),
        filename: "report.md",
        mimeType: "text/markdown",
        kind: "media" as const,
        direction: "outbound" as const,
        createdAt: 1,
      });
    });
    const asA = t.withIdentity({ subject: `${a}|session` });
    const asB = t.withIdentity({ subject: `${b}|session` });

    expect((await asA.query(api.files.listMine, {})).files.length).toBe(1);

    // IDOR: another user cannot delete A's file; it stays visible to A.
    await expect(
      asB.mutation(api.files.softDelete, { fileId }),
    ).rejects.toThrow();
    expect((await asA.query(api.files.listMine, {})).files.length).toBe(1);

    // Owner soft-deletes → hidden from the listing.
    await asA.mutation(api.files.softDelete, { fileId });
    expect((await asA.query(api.files.listMine, {})).files.length).toBe(0);

    // SOFT: the row is KEPT with `deletedAt` set (invariant holds, recoverable),
    // not destroyed — distinct from the deleteMessage cascade that removes it.
    const row = await t.run((ctx) => ctx.db.get(fileId));
    expect(row).not.toBeNull();
    expect(typeof row?.deletedAt).toBe("number");

    // Idempotent: re-deleting is a no-op (no throw), still hidden.
    await asA.mutation(api.files.softDelete, { fileId });
    expect((await asA.query(api.files.listMine, {})).files.length).toBe(0);
  });
});

describe("auto-generated (pasted) files: hidden by default, revealed by the toggle", () => {
  test("listMine excludes origin=pasted by default and includes it on demand", async () => {
    const t = convexTest(schema, modules);
    const u = await seedUser(t, "u");
    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId: u, updatedAt: 1 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId: u,
        role: "user" as const,
        status: "complete" as const,
        text: "",
        updatedAt: 1,
      });
      const mk = async (filename: string, origin?: "pasted") =>
        ctx.db.insert("files", {
          userId: u,
          chatId,
          messageId,
          storageId: await ctx.storage.store(new Blob(["x"])),
          filename,
          mimeType: "text/plain",
          kind: "file" as const,
          direction: "inbound" as const,
          createdAt: 1,
          ...(origin ? { origin } : {}),
        });
      await mk("vrai-document.txt");
      await mk("texte-colle-1.txt", "pasted");
    });
    const asU = t.withIdentity({ subject: `${u}|s` });

    // Default: ONLY the real file.
    const byDefault = await asU.query(api.files.listMine, {});
    expect(byDefault.files.map((f) => f.filename)).toEqual(["vrai-document.txt"]);

    // Toggle on: both, with the pasted one carrying its origin.
    const all = await asU.query(api.files.listMine, {
      includeAutoGenerated: true,
    });
    expect(all.files.map((f) => f.filename).sort()).toEqual([
      "texte-colle-1.txt",
      "vrai-document.txt",
    ]);
    const pasted = all.files.find((f) => f.filename === "texte-colle-1.txt");
    expect(pasted?.origin).toBe("pasted");
  });
});
