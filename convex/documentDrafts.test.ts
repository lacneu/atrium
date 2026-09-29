import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { DRAFT_TEXT_CAP_BYTES } from "./documentDrafts";
import { DRAFTS_PURGE_BOUND, MAX_DRAFTS_PER_CHAT } from "./lib/chatAccess";

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
    await as.mutation(api.trash.purgeChat, { chatId });
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

// A PARTICIPANT opens the conversation's documents too. Reported in production:
// the shared file downloaded, but its side panel failed for the participant —
// both viewer queries refused anyone but the owner.
describe("a participant of the conversation", () => {
  async function room(t: T) {
    const { userId: ownerId, chatId } = await seed(t, "alice");
    return t.run(async (ctx) => {
      const guest = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: guest, role: "user" as const, canonical: "bob" });
      await ctx.db.insert("chatParticipants", {
        chatId,
        userId: guest,
        addedBy: ownerId,
        addedAt: 1,
        role: "member" as const,
      });
      const stranger = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: stranger,
        role: "user" as const,
        canonical: "eve",
      });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId: ownerId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "voici",
        updatedAt: 1000,
      });
      const sid = await ctx.storage.store(new Blob(["pdf"]));
      // Delivered files are recorded under the conversation's OWNER.
      await ctx.db.insert("files", {
        userId: ownerId,
        chatId,
        messageId,
        storageId: sid,
        filename: "flan.pdf",
        mimeType: "application/pdf",
        kind: "file" as const,
        direction: "outbound" as const,
        createdAt: 1000,
      });
      return { ownerId, chatId, guest, stranger };
    });
  }

  test("sees the conversation's delivered versions and keeps their OWN draft", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, chatId, guest } = await room(t);
    const asGuest = t.withIdentity({ subject: `${guest}|s` });
    const latest = await asGuest.query(api.documentDrafts.latestDeliveredFile, {
      chatId,
      filename: "flan.pdf",
    });
    expect(latest?.createdAt).toBe(1000);
    expect(await asGuest.query(api.documentDrafts.getDraft, { chatId, filename: "n.md" })).toBeNull();
    await asGuest.mutation(api.documentDrafts.saveDraft, { chatId, filename: "n.md", text: "bob" });
    expect(
      (await asGuest.query(api.documentDrafts.getDraft, { chatId, filename: "n.md" }))?.text,
    ).toBe("bob");
    // A draft is personal: the owner never sees the participant's.
    const asOwner = t.withIdentity({ subject: `${ownerId}|s` });
    expect(await asOwner.query(api.documentDrafts.getDraft, { chatId, filename: "n.md" })).toBeNull();
  });

  test("someone outside the conversation still reads nothing", async () => {
    const t = convexTest(schema, modules);
    const { chatId, stranger } = await room(t);
    const asStranger = t.withIdentity({ subject: `${stranger}|s` });
    await expect(
      asStranger.query(api.documentDrafts.latestDeliveredFile, { chatId, filename: "flan.pdf" }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asStranger.query(api.documentDrafts.getDraft, { chatId, filename: "n.md" }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asStranger.mutation(api.documentDrafts.saveDraft, { chatId, filename: "n.md", text: "x" }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a participant's drafts go when they leave, and with the conversation", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, chatId, guest } = await room(t);
    const asGuest = t.withIdentity({ subject: `${guest}|s` });
    await asGuest.mutation(api.documentDrafts.saveDraft, { chatId, filename: "n.md", text: "bob" });
    await asGuest.mutation(api.chatParticipants.leaveChat, { chatId });
    const afterLeave = await t.run((ctx) => ctx.db.query("documentDrafts").collect());
    expect(afterLeave).toEqual([]);

    // Seated again, drafting again, then the owner deletes the conversation.
    await t.run(async (ctx) => {
      await ctx.db.insert("chatParticipants", {
        chatId,
        userId: guest,
        addedBy: ownerId,
        addedAt: 2,
        role: "member" as const,
      });
    });
    await asGuest.mutation(api.documentDrafts.saveDraft, { chatId, filename: "n.md", text: "bob" });
    await t.withIdentity({ subject: `${ownerId}|s` }).mutation(api.chats.deleteChat, { chatId });
    await t.withIdentity({ subject: `${ownerId}|s` }).mutation(api.trash.purgeChat, { chatId });
    await t.finishAllScheduledFunctions(() => {});
    const afterDelete = await t.run((ctx) => ctx.db.query("documentDrafts").collect());
    expect(afterDelete).toEqual([]);
  });
});

// Codex review (2026-09-27), P3: a person's drafts in a conversation are purged in ONE
// transaction when they leave it (purgeMemberState reads at most DRAFTS_PURGE_BOUND).
// saveDraft had no per-chat bound, so drafts past the purge window outlived the seat.
describe("drafts are bounded per (person, conversation)", () => {
  test("the cap fits inside the purge's single read", () => {
    expect(MAX_DRAFTS_PER_CHAT).toBeLessThanOrEqual(DRAFTS_PURGE_BOUND);
  });

  test("past the cap a NEW draft is refused by name; an existing one still saves", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "alice");
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_DRAFTS_PER_CHAT; i++) {
        await ctx.db.insert("documentDrafts", {
          userId,
          chatId,
          filename: `f-${i}.md`,
          text: "x",
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    await expect(
      as.mutation(api.documentDrafts.saveDraft, { chatId, filename: "one-more.md", text: "y" }),
    ).rejects.toThrow(/draft_limit_reached/);
    expect(
      (await as.mutation(api.documentDrafts.saveDraft, { chatId, filename: "f-3.md", text: "edited" })).applied,
    ).toBe(true);
  });
});

