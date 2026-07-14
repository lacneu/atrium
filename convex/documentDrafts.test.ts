import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { DRAFT_TEXT_CAP_BYTES } from "./documentDrafts";

const modules = import.meta.glob("./**/*.ts");

// Collaborative-document drafts. Discriminating properties:
//   - one draft per (user, chat, filename), upserted (auto-save), deletable;
//   - ownership enforced on every surface; writes no-op under impersonation;
//   - the size cap REFUSES instead of silently truncating user content;
//   - drafts die with their chat (cascade);
//   - latestDeliveredFile tracks the newest OUTBOUND delivery by filename.

type T = ReturnType<typeof convexTest>;

async function seed(t: T, canonical: string) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "alice",
    });
    return { userId, chatId };
  });
}

describe("documentDrafts", () => {
  test("saveDraft upserts (auto-save), getDraft returns it, deleteDraft discards", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|s` });

    await as.mutation(api.documentDrafts.saveDraft, {
      chatId,
      filename: "rapport.md",
      text: "# v1 edited",
      sourceStorageId: "kg-storage-abc",
    });
    let draft = await as.query(api.documentDrafts.getDraft, {
      chatId,
      filename: "rapport.md",
    });
    expect(draft?.text).toBe("# v1 edited");
    expect(draft?.sourceStorageId).toBe("kg-storage-abc");

    // Second save = UPDATE of the same row (no duplicates), source kept.
    await as.mutation(api.documentDrafts.saveDraft, {
      chatId,
      filename: "rapport.md",
      text: "# v1 edited more",
    });
    draft = await as.query(api.documentDrafts.getDraft, {
      chatId,
      filename: "rapport.md",
    });
    expect(draft?.text).toBe("# v1 edited more");
    expect(draft?.sourceStorageId).toBe("kg-storage-abc");
    const count = await t.run(async (ctx) =>
      (await ctx.db.query("documentDrafts").collect()).length,
    );
    expect(count).toBe(1);

    await as.mutation(api.documentDrafts.deleteDraft, {
      chatId,
      filename: "rapport.md",
    });
    draft = await as.query(api.documentDrafts.getDraft, {
      chatId,
      filename: "rapport.md",
    });
    expect(draft).toBeNull();
  });

  test("drafts are per-filename within the chat", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|s` });
    await as.mutation(api.documentDrafts.saveDraft, {
      chatId,
      filename: "a.md",
      text: "A",
    });
    await as.mutation(api.documentDrafts.saveDraft, {
      chatId,
      filename: "b.md",
      text: "B",
    });
    const a = await as.query(api.documentDrafts.getDraft, {
      chatId,
      filename: "a.md",
    });
    const b = await as.query(api.documentDrafts.getDraft, {
      chatId,
      filename: "b.md",
    });
    expect(a?.text).toBe("A");
    expect(b?.text).toBe("B");
  });

  test("IDOR: a foreign chat can neither be drafted on nor read", async () => {
    const t = convexTest(schema, modules);
    const owner = await seed(t, "alice");
    const intruder = await seed(t, "mallory");
    const asIntruder = t.withIdentity({ subject: `${intruder.userId}|s` });
    await expect(
      asIntruder.mutation(api.documentDrafts.saveDraft, {
        chatId: owner.chatId,
        filename: "x.md",
        text: "hijack",
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asIntruder.query(api.documentDrafts.getDraft, {
        chatId: owner.chatId,
        filename: "x.md",
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("oversized drafts are REFUSED (never silently truncated)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|s` });
    await expect(
      as.mutation(api.documentDrafts.saveDraft, {
        chatId,
        filename: "big.md",
        // Multi-byte content: the cap must count UTF-8 BYTES, not JS chars
        // (each emoji is 4 bytes but 2 UTF-16 units).
        text: "\u{1F600}".repeat(Math.ceil(DRAFT_TEXT_CAP_BYTES / 4) + 10),
      }),
    ).rejects.toThrow(/too large/);
  });

  test("draft writes are a NO-OP under admin impersonation", async () => {
    const t = convexTest(schema, modules);
    const target = await seed(t, "alice");
    const adminId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "admin" as const,
        canonical: "root",
        impersonatingUserId: target.userId,
      });
      return userId;
    });
    const asAdmin = t.withIdentity({ subject: `${adminId}|s` });
    await asAdmin.mutation(api.documentDrafts.saveDraft, {
      chatId: target.chatId,
      filename: "x.md",
      text: "ghost",
    });
    const count = await t.run(async (ctx) =>
      (await ctx.db.query("documentDrafts").collect()).length,
    );
    expect(count).toBe(0);
  });

  test("drafts die with their chat (cascade)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|s` });
    await as.mutation(api.documentDrafts.saveDraft, {
      chatId,
      filename: "gone.md",
      text: "bye",
    });
    await as.mutation(api.chats.deleteChat, { chatId });
    const count = await t.run(async (ctx) =>
      (await ctx.db.query("documentDrafts").collect()).length,
    );
    expect(count).toBe(0);
  });

  test("version tracking links deliveries through the gateway ---uuid suffix (normalized identity)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|s` });
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "v",
        updatedAt: 1000,
      });
      for (const [suffix, at] of [
        ["---0aaa1111-2222-3333-4444-555566667777", 1000],
        ["---9bbb1111-2222-3333-4444-555566667777", 2000],
      ] as const) {
        const sid = await ctx.storage.store(new Blob([`v${at}`]));
        await ctx.db.insert("files", {
          userId,
          chatId,
          messageId,
          storageId: sid,
          filename: `rapport${suffix}.md`,
          mimeType: "text/markdown",
          kind: "file" as const,
          direction: "outbound" as const,
          createdAt: at,
        });
      }
    });
    // The viewer asks with the DISPLAY name (suffix stripped by
    // convertMessage): both uuid-suffixed versions must resolve, newest wins.
    const latest = await as.query(api.documentDrafts.latestDeliveredFile, {
      chatId,
      filename: "rapport.md",
    });
    expect(latest).not.toBeNull();
    expect(latest!.createdAt).toBe(2000);
  });

  test("latestDeliveredFile returns the NEWEST outbound delivery of that filename", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|s` });
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "voila",
        updatedAt: 1000,
      });
      const sid1 = await ctx.storage.store(new Blob(["v1"]));
      const sid2 = await ctx.storage.store(new Blob(["v2"]));
      const sidOther = await ctx.storage.store(new Blob(["in"]));
      await ctx.db.insert("files", {
        userId,
        chatId,
        messageId,
        storageId: sid1,
        filename: "rapport.md",
        mimeType: "text/markdown",
        kind: "file" as const,
        direction: "outbound" as const,
        createdAt: 1000,
      });
      // An INBOUND file with the same name (the user re-attached it) must
      // never count as a delivered version.
      await ctx.db.insert("files", {
        userId,
        chatId,
        messageId,
        storageId: sidOther,
        filename: "rapport.md",
        mimeType: "text/markdown",
        kind: "file" as const,
        direction: "inbound" as const,
        createdAt: 1500,
      });
      await ctx.db.insert("files", {
        userId,
        chatId,
        messageId,
        storageId: sid2,
        filename: "rapport.md",
        mimeType: "text/markdown",
        kind: "file" as const,
        direction: "outbound" as const,
        createdAt: 2000,
      });
    });
    const latest = await as.query(api.documentDrafts.latestDeliveredFile, {
      chatId,
      filename: "rapport.md",
    });
    expect(latest).not.toBeNull();
    expect(latest!.createdAt).toBe(2000);
    expect(typeof latest!.storageId).toBe("string"); // the STABLE version key
    expect(
      await as.query(api.documentDrafts.latestDeliveredFile, {
        chatId,
        filename: "inconnu.md",
      }),
    ).toBeNull();
  });
});
