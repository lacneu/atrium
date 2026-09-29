/// <reference types="vite/client" />
//
// THE LOGICAL ORPHAN SWEEP, from the outside: what a dry run reports, what an apply
// deletes (only what nothing references, only when a fresh report was confirmed and
// the files mirror is complete), and the delete paths that used to make orphans —
// the hidden-chat sweep — or destroy blobs something else held — the bridge ingest.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { BLOB_PAGE, MIRROR_PAGE } from "./blobSweep";
import { PART_STORAGE_BACKFILL } from "./blobQuarantine";
import { DEFAULT_SWEEP_MIN_AGE_DAYS, orphanTypeOf, validMinAgeDays } from "./lib/blobSweep";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedUser(t: T, name: string, role: "user" | "admin" = "user") {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role,
      canonical: name,
      name,
      email: `${name}@example.com`,
    });
    return userId;
  });
}

const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: userId });

async function storeBlob(t: T, body = "bytes", type?: string): Promise<Id<"_storage">> {
  return t.run(async (ctx) => ctx.storage.store(new Blob([body], type ? { type } : {})));
}

/** Is the blob HELD: in storage and not released into the quarantine
 *  (lib/blobs.releaseBlob — its deletion comes a week later, from the purge)? */
async function blobExists(t: T, id: Id<"_storage">): Promise<boolean> {
  return t.run(async (ctx) => {
    if ((await ctx.db.system.get("_storage", id)) === null) return false;
    return !(await ctx.db.query("blobReleases").collect()).some((r) => r.storageId === id);
  });
}

async function settle(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** A chat message holding `blob` as a file part — with its files mirror unless
 *  `mirror` is false (legacy data from before the mirror). */
async function fileMessage(
  t: T,
  owner: Id<"users">,
  blob: Id<"_storage">,
  opts: { mirror?: boolean; chatId?: Id<"chats"> } = {},
) {
  return t.run(async (ctx) => {
    const chatId =
      opts.chatId ?? (await ctx.db.insert("chats", { userId: owner, updatedAt: 1 }));
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId: owner,
      role: "assistant" as const,
      status: "complete" as const,
      text: "voici",
      updatedAt: 1,
    });
    const part = {
      kind: "file" as const,
      storageId: blob,
      filename: "a.pdf",
      mimeType: "application/pdf",
    };
    await ctx.db.insert("messageParts", { messageId, order: 0, part });
    if (opts.mirror !== false) {
      await ctx.db.insert("files", {
        userId: owner,
        chatId,
        messageId,
        storageId: blob,
        filename: "a.pdf",
        mimeType: "application/pdf",
        kind: "file" as const,
        direction: "outbound" as const,
        category: "pdf",
        createdAt: 1,
      });
    }
    return { chatId, messageId };
  });
}

async function registerUpload(t: T, userId: Id<"users">, storageId: Id<"_storage">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("uploads", { storageId, userId });
  });
}

async function latest(t: T, admin: Id<"users">) {
  const rows = await as(t, admin).query(api.blobSweep.listBlobSweeps, {});
  return rows[0]!;
}

async function dryRun(t: T, admin: Id<"users">, minAgeDays?: number) {
  const id = await as(t, admin).mutation(api.blobSweep.startBlobSweep, {
    mode: "dryRun",
    ...(minAgeDays !== undefined ? { minAgeDays } : {}),
  });
  await settle(t);
  return id;
}

async function apply(t: T, admin: Id<"users">, confirms: Id<"blobSweeps">) {
  const id = await as(t, admin).mutation(api.blobSweep.startBlobSweep, {
    mode: "apply",
    confirms,
  });
  await settle(t);
  return id;
}

/** Every kind of holder, and two orphans — all made "old" by the clock. */
async function seedWorld(t: T) {
  const admin = await seedUser(t, "admin", "admin");
  const owner = await seedUser(t, "olivier");
  const held = await storeBlob(t, "held", "application/pdf");
  await fileMessage(t, owner, held);
  const docBlob = await storeBlob(t, "doc");
  await t.run(async (ctx) => {
    const chatId = await ctx.db.insert("chats", { userId: owner, updatedAt: 1 });
    const sourceMessageId = await ctx.db.insert("messages", {
      chatId,
      userId: owner,
      role: "user" as const,
      status: "complete" as const,
      text: "réf",
      updatedAt: 1,
    });
    await ctx.db.insert("documentAttachments", {
      userId: owner,
      sourceMessageId,
      reference: "DOC-1",
      status: "ready" as const,
      storageId: docBlob,
      createdAt: 1,
      updatedAt: 1,
    });
  });
  const pdf = await storeBlob(t, "rendered", "application/pdf");
  await t.run(async (ctx) => {
    const chatId = await ctx.db.insert("chats", { userId: owner, updatedAt: 1 });
    await ctx.db.insert("fileRenditions", {
      sourceStorageId: held,
      chatId,
      userId: owner,
      sourceFilename: "a.docx",
      sourceMimeType: "application/msword",
      status: "ready" as const,
      pdfStorageId: pdf,
      converterInstance: "prod",
      converterAgentId: "converter",
      createdAt: 1,
      updatedAt: 1,
    });
  });
  const logo = await storeBlob(t, "logo", "image/webp");
  await t.run(async (ctx) => {
    await ctx.db.insert("charts", {
      key: "brand",
      name: "Brand",
      scope: "common",
      tokens: { colors: { light: {}, dark: {} } },
      logoLightStorageId: logo,
      createdBy: admin,
      createdAt: 1,
    });
  });
  // An upload picked in the composer and never sent.
  const unsent = await storeBlob(t, "unsent", "image/png");
  await registerUpload(t, owner, unsent);
  // A bridge upload whose part never landed: no row names it at all.
  const stray = await storeBlob(t, "stray-bytes");
  return { admin, owner, held, docBlob, pdf, logo, unsent, stray };
}

describe("a dry run reports and deletes nothing", () => {
  test("it names exactly the old blobs no row references, by origin and type", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    vi.setSystemTime(Date.now() + 8 * DAY);
    // A fresh upload, too young to judge.
    const fresh = await storeBlob(t, "fresh");

    await dryRun(t, w.admin);
    const report = await latest(t, w.admin);
    expect(report.status).toBe("done");
    expect(report.mode).toBe("dryRun");
    expect(report.minAgeDays).toBe(DEFAULT_SWEEP_MIN_AGE_DAYS);
    expect(report.mirrorMissing).toBe(0);
    expect(report.blobsScanned).toBe(6);
    expect(report.referenced).toBe(4);
    expect(report.orphans).toEqual({ count: 2, bytes: "unsent".length + "stray-bytes".length });
    expect(report.byOrigin).toEqual({
      upload: { count: 1, bytes: "unsent".length },
      unregistered: { count: 1, bytes: "stray-bytes".length },
    });
    // convex-test stores no content type, so both land in "other" here; the
    // buckets themselves are orphanTypeOf's (asserted below).
    expect(report.byType).toEqual({
      other: { count: 2, bytes: "unsent".length + "stray-bytes".length },
    });
    expect(orphanTypeOf("image/png")).toBe("image");
    expect(orphanTypeOf("application/pdf")).toBe("pdf");
    expect(orphanTypeOf(null)).toBe("other");
    expect(new Set(report.sampleIds)).toEqual(new Set([w.unsent, w.stray]));
    expect(report.deleted).toEqual({ count: 0, bytes: 0 });
    for (const id of [w.held, w.docBlob, w.pdf, w.logo, w.unsent, w.stray, fresh]) {
      expect(await blobExists(t, id)).toBe(true);
    }
  });

  test("a blob younger than the minimum age is never judged", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    vi.setSystemTime(Date.now() + 6 * DAY);
    await dryRun(t, w.admin);
    const report = await latest(t, w.admin);
    expect(report.blobsScanned).toBe(0);
    expect(report.orphans.count).toBe(0);
  });

  test("an upload whose owner has an archive import applying is spared", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("archiveImports", {
        userId: w.owner,
        status: "applying" as const,
        formatVersion: 1,
        origin: null,
        fromThisDeployment: true,
        targetProjectId: null,
        startedAt: 1,
        updatedAt: 1,
      });
    });
    vi.setSystemTime(Date.now() + 8 * DAY);
    await dryRun(t, w.admin);
    const report = await latest(t, w.admin);
    expect(report.importing).toBe(1);
    expect(report.sampleIds).toEqual([w.stray]);
  });

  test("the minimum age is bounded and only an admin may sweep", async () => {
    expect(() => validMinAgeDays(0)).toThrow();
    expect(() => validMinAgeDays(1.5)).toThrow();
    expect(validMinAgeDays(undefined)).toBe(DEFAULT_SWEEP_MIN_AGE_DAYS);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await expect(
      as(t, w.owner).mutation(api.blobSweep.startBlobSweep, { mode: "dryRun" }),
    ).rejects.toThrow(/admin/);
    await expect(as(t, w.owner).query(api.blobSweep.listBlobSweeps, {})).rejects.toThrow(/admin/);
  });

  test("a large inventory is walked in batches to the end", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin", "admin");
    const n = BLOB_PAGE * 2 + 7;
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) await ctx.storage.store(new Blob([`b${i}`]));
    });
    vi.setSystemTime(Date.now() + 8 * DAY);
    await dryRun(t, admin);
    const report = await latest(t, admin);
    expect(report.status).toBe("done");
    expect(report.blobsScanned).toBe(n);
    expect(report.orphans.count).toBe(n);
    expect(report.sampleIds).toHaveLength(20);
  });
});

describe("an apply deletes what its confirmed report found, and nothing else", () => {
  test("orphans go (with their upload registration); every held blob stays", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    vi.setSystemTime(Date.now() + 8 * DAY);
    const report = await dryRun(t, w.admin);
    await apply(t, w.admin, report);
    const run = await latest(t, w.admin);
    expect(run.mode).toBe("apply");
    expect(run.status).toBe("done");
    expect(run.confirms).toBe(report);
    expect(run.deleted).toEqual({ count: 2, bytes: "unsent".length + "stray-bytes".length });
    expect(await blobExists(t, w.unsent)).toBe(false);
    expect(await blobExists(t, w.stray)).toBe(false);
    for (const id of [w.held, w.docBlob, w.pdf, w.logo]) {
      expect(await blobExists(t, id)).toBe(true);
    }
    // RELEASED into the quarantine: deleted — with their upload registrations — only
    // when it ends, if nothing references them by then.
    expect(
      (await t.run((ctx) => ctx.db.query("blobReleases").collect())).map((r) => r.reason),
    ).toEqual(["orphan_sweep", "orphan_sweep"]);
    await t.run(async (ctx) => {
      await ctx.db.insert("migrationMarkers", {
        key: PART_STORAGE_BACKFILL,
        cursor: null,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
    });
    vi.setSystemTime(Date.now() + 8 * DAY);
    await t.mutation(internal.blobQuarantine.purgeQuarantine, {});
    const gone = await t.run(async (ctx) => ({
      unsent: await ctx.db.system.get("_storage", w.unsent),
      stray: await ctx.db.system.get("_storage", w.stray),
      uploads: await ctx.db.query("uploads").collect(),
    }));
    expect(gone).toEqual({ unsent: null, stray: null, uploads: [] });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((a) => a.action)).toEqual(["storage.sweep_dry_run", "storage.sweep_apply"]);
  });

  test("the apply re-tests each blob: one referenced since the report stays", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    vi.setSystemTime(Date.now() + 8 * DAY);
    const report = await dryRun(t, w.admin);
    // The unsent upload is sent after all.
    await fileMessage(t, w.owner, w.unsent);
    await apply(t, w.admin, report);
    expect(await blobExists(t, w.unsent)).toBe(true);
    expect(await blobExists(t, w.stray)).toBe(false);
  });

  test("an apply needs a finished dry run of the last 24 hours", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    vi.setSystemTime(Date.now() + 8 * DAY);
    await expect(
      as(t, w.admin).mutation(api.blobSweep.startBlobSweep, { mode: "apply" }),
    ).rejects.toThrow(/confirm/);
    const report = await dryRun(t, w.admin);
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    await expect(apply(t, w.admin, report)).rejects.toThrow(/24 hours/);
    expect(await blobExists(t, w.stray)).toBe(true);
  });

  test("one sweep at a time; a sweep whose chain died is replaced", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const first = await as(t, w.admin).mutation(api.blobSweep.startBlobSweep, {
      mode: "dryRun",
    });
    await expect(
      as(t, w.admin).mutation(api.blobSweep.startBlobSweep, { mode: "dryRun" }),
    ).rejects.toThrow(/already running/);
    // The chain never runs (its scheduled step is dropped) and the stamp goes stale.
    await t.run(async (ctx) => {
      await ctx.db.patch(first, { updatedAt: Date.now() - 31 * 60 * 1000 });
    });
    await as(t, w.admin).mutation(api.blobSweep.startBlobSweep, { mode: "dryRun" });
    const old = await t.run((ctx) => ctx.db.get(first));
    expect(old?.status).toBe("stalled");
  });
});

describe("the files mirror must be complete before anything is deleted", () => {
  test("a file part without its files row is reported, and its report cannot be applied", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const legacy = await storeBlob(t, "legacy");
    await fileMessage(t, w.owner, legacy, { mirror: false });
    vi.setSystemTime(Date.now() + 8 * DAY);
    const report = await dryRun(t, w.admin);
    const r = await latest(t, w.admin);
    expect(r.mirrorMissing).toBe(1);
    // The blob test cannot see the part: this one reads as an orphan…
    expect(r.sampleIds).toContain(legacy);
    // …which is exactly why the report cannot be applied.
    await expect(apply(t, w.admin, report)).rejects.toThrow(/files row/);
    expect(await blobExists(t, legacy)).toBe(true);
  });

  test("the mirror check walks every part, across batches", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin", "admin");
    const { messageId } = await fileMessage(t, admin, await storeBlob(t, "held"));
    await t.run(async (ctx) => {
      for (let i = 0; i < MIRROR_PAGE + 5; i++) {
        await ctx.db.insert("messageParts", {
          messageId,
          order: i + 1,
          part: { kind: "reasoning" as const, text: `pensée ${i}` },
        });
      }
    });
    // The gap sits past the first batch.
    await fileMessage(t, admin, await storeBlob(t, "legacy"), { mirror: false });
    await dryRun(t, admin);
    const r = await latest(t, admin);
    expect(r.status).toBe("done");
    expect(r.partsChecked).toBe(2);
    expect(r.mirrorMissing).toBe(1);
  });

  test("an apply whose own mirror check finds a gap refuses and deletes nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    vi.setSystemTime(Date.now() + 8 * DAY);
    const report = await dryRun(t, w.admin);
    // A legacy part surfaces between the report and the apply (a restore, say).
    await fileMessage(t, w.owner, w.stray, { mirror: false });
    await apply(t, w.admin, report);
    const run = await latest(t, w.admin);
    expect(run.status).toBe("refused");
    expect(run.refusal).toBe("mirror_incomplete");
    expect(run.deleted.count).toBe(0);
    expect(await blobExists(t, w.stray)).toBe(true);
    expect(await blobExists(t, w.unsent)).toBe(true);
  });
});

describe("the hidden-chat sweep releases the blobs its rows held", () => {
  test("a summarizer reply's file goes with it; one a real chat shares stays", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const own = await storeBlob(t, "summary-only");
    const shared = await storeBlob(t, "shared");
    await fileMessage(t, owner, shared); // a real conversation shows it
    const hiddenId = await t.run(async (ctx) =>
      ctx.db.insert("chats", {
        userId: owner,
        kind: "summarizer" as const,
        title: "Synthèse",
        updatedAt: 1,
      } as never),
    );
    await fileMessage(t, owner, own, { chatId: hiddenId });
    await fileMessage(t, owner, shared, { chatId: hiddenId });
    await t.mutation(internal.chatSummaries.cleanupSummarizerChat, { hiddenChatId: hiddenId });
    await settle(t);
    const left = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.chatId === hiddenId),
    );
    expect(left).toEqual([]);
    expect(await blobExists(t, own)).toBe(false);
    expect(await blobExists(t, shared)).toBe(true);
  });
});

describe("the bridge ingest never destroys a blob something else holds", () => {
  async function streamingReply(t: T, runId: string) {
    return t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId,
        updatedAt: 1,
      });
      return { userId, chatId, messageId };
    });
  }

  const filePart = (storageId: Id<"_storage">) => ({
    kind: "file" as const,
    storageId,
    filename: "rapport.pdf",
    mimeType: "application/pdf",
  });

  test("a stale-generation part naming a shared or registered blob leaves it; its own upload goes", async () => {
    const t = convexTest(schema, modules);
    const { userId, messageId } = await streamingReply(t, "run-new");
    const shared = await storeBlob(t, "shared");
    await fileMessage(t, userId, shared);
    const pendingUpload = await storeBlob(t, "picked, not sent");
    await registerUpload(t, userId, pendingUpload);
    const leftover = await storeBlob(t, "bridge upload");
    for (const id of [shared, pendingUpload, leftover]) {
      const outcome = await t.mutation(internal.stream.addPart, {
        messageId,
        expectedRunId: "run-old",
        part: filePart(id),
      });
      expect(outcome).toEqual({ accepted: false, reason: "stale_generation" });
    }
    expect(await blobExists(t, shared)).toBe(true);
    expect(await blobExists(t, pendingUpload)).toBe(true);
    expect(await blobExists(t, leftover)).toBe(false);
  });

  test("a replayed part deduped against its twin does not take a shared blob with it", async () => {
    const CHILD_KEY = "agent:files:subagent:9af5b6c1-d161-4994-a5df-6e256c5b4336";
    const ANNOUNCE_RUN = `announce:v1:${CHILD_KEY}:650150d5-fa3d-4c7c-825c-e6684997f82d`;
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await streamingReply(t, ANNOUNCE_RUN);
    const twin = await storeBlob(t, "twin");
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        announceRun: ANNOUNCE_RUN,
        part: filePart(twin),
      });
      await ctx.db.insert("files", {
        userId,
        chatId,
        messageId,
        storageId: twin,
        filename: "rapport.pdf",
        mimeType: "application/pdf",
        kind: "file" as const,
        direction: "outbound" as const,
        category: "pdf" as const,
        createdAt: 1,
      });
      await ctx.db.patch(messageId, {
        status: "complete" as const,
        announceReplayArmed: Date.now() + 60_000,
        announceReplayRun: ANNOUNCE_RUN,
      });
    });
    const shared = await storeBlob(t, "shared");
    await fileMessage(t, userId, shared);
    await t.mutation(internal.stream.addPart, {
      messageId,
      expectedRunId: ANNOUNCE_RUN,
      part: filePart(shared),
    });
    expect(await blobExists(t, shared)).toBe(true);
    const replayUpload = await storeBlob(t, "replayed bytes");
    await t.mutation(internal.stream.addPart, {
      messageId,
      expectedRunId: ANNOUNCE_RUN,
      part: filePart(replayUpload),
    });
    expect(await blobExists(t, replayUpload)).toBe(false);
    expect(await blobExists(t, twin)).toBe(true);
  });
});

describe("a settled documentary or converter job leaves only what it captured", () => {
  /** A hidden chat's streaming reply carrying `parts` (each with its files row). */
  async function hiddenReply(
    t: T,
    owner: Id<"users">,
    hiddenId: Id<"chats">,
    parts: Array<{ blob: Id<"_storage">; filename: string; mimeType: string }>,
  ) {
    return t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId: hiddenId,
        userId: owner,
        role: "user" as const,
        status: "complete" as const,
        text: "consigne",
        updatedAt: 1,
      });
      const messageId = await ctx.db.insert("messages", {
        chatId: hiddenId,
        userId: owner,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      });
      let order = 0;
      for (const p of parts) {
        const part = { kind: "media" as const, storageId: p.blob, filename: p.filename, mimeType: p.mimeType };
        await ctx.db.insert("messageParts", { messageId, order: order++, part });
        await ctx.db.insert("files", {
          userId: owner,
          chatId: hiddenId,
          messageId,
          storageId: p.blob,
          filename: p.filename,
          mimeType: p.mimeType,
          kind: "media" as const,
          direction: "outbound" as const,
          createdAt: 1,
        });
      }
      return messageId;
    });
  }

  const hiddenMessages = (t: T, hiddenId: Id<"chats">) =>
    t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.chatId === hiddenId),
    );

  test("documentary: the fetched file stays with its attachment; the rest is released", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const fetched = await storeBlob(t, "the referenced document");
    const extra = await storeBlob(t, "an unrequested file");
    const { sourceMessageId, hiddenId } = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId: owner, updatedAt: 1 });
      const sourceMessageId = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "assistant" as const,
        status: "complete" as const,
        text: "voir rapport.pdf",
        updatedAt: 1,
      });
      await ctx.db.insert("documentAttachments", {
        userId: owner,
        sourceMessageId,
        reference: "rapport.pdf",
        status: "pending" as const,
        createdAt: 1,
        updatedAt: 1,
      });
      const hiddenId = await ctx.db.insert("chats", {
        userId: owner,
        kind: "documentary" as const,
        updatedAt: 1,
        pendingFetch: { sourceMessageId, createdAt: 0 },
      });
      return { sourceMessageId, hiddenId };
    });
    const replyId = await hiddenReply(t, owner, hiddenId, [
      { blob: fetched, filename: "rapport.pdf", mimeType: "application/pdf" },
      { blob: extra, filename: "autre.pdf", mimeType: "application/pdf" },
    ]);
    await t.mutation(internal.stream.finalize, { messageId: replyId, status: "complete", text: "" });
    await settle(t);
    const row = await t.run(async (ctx) =>
      (await ctx.db.query("documentAttachments").collect()).find(
        (d) => d.sourceMessageId === sourceMessageId,
      ),
    );
    expect(row?.status).toBe("ready");
    expect(row?.storageId).toBe(fetched);
    expect(await blobExists(t, fetched)).toBe(true);
    expect(await blobExists(t, extra)).toBe(false);
    expect(await hiddenMessages(t, hiddenId)).toEqual([]);
  });

  test("converter: the PDF stays with its rendition, the source with its file; the rest is released", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const source = await storeBlob(t, "docx bytes");
    await fileMessage(t, owner, source);
    const pdf = await storeBlob(t, "%PDF rendered");
    const stray = await storeBlob(t, "a preview image");
    const { renditionId, hiddenId } = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId: owner, updatedAt: 1 });
      const renditionId = await ctx.db.insert("fileRenditions", {
        sourceStorageId: source,
        chatId,
        userId: owner,
        sourceFilename: "a.docx",
        sourceMimeType: "application/msword",
        status: "pending" as const,
        converterInstance: "prod",
        converterAgentId: "converter",
        createdAt: 1,
        updatedAt: 1,
      });
      const hiddenId = await ctx.db.insert("chats", {
        userId: owner,
        kind: "converter" as const,
        updatedAt: 1,
        pendingConvert: { renditionId, createdAt: 0 },
      });
      return { renditionId, hiddenId };
    });
    const replyId = await hiddenReply(t, owner, hiddenId, [
      { blob: pdf, filename: "a.pdf", mimeType: "application/pdf" },
      { blob: stray, filename: "apercu.png", mimeType: "image/png" },
    ]);
    await t.mutation(internal.stream.finalize, { messageId: replyId, status: "complete", text: "" });
    await settle(t);
    const rendition = await t.run((ctx) => ctx.db.get(renditionId));
    expect(rendition?.status).toBe("ready");
    expect(rendition?.pdfStorageId).toBe(pdf);
    expect(await blobExists(t, pdf)).toBe(true);
    expect(await blobExists(t, source)).toBe(true);
    expect(await blobExists(t, stray)).toBe(false);
    expect(await hiddenMessages(t, hiddenId)).toEqual([]);
  });

  test("while a newer job holds the chat, its rows are left alone", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const inFlight = await storeBlob(t, "being fetched");
    const { hiddenId } = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId: owner, updatedAt: 1 });
      const sourceMessageId = await ctx.db.insert("messages", {
        chatId,
        userId: owner,
        role: "assistant" as const,
        status: "complete" as const,
        text: "réf",
        updatedAt: 1,
      });
      const hiddenId = await ctx.db.insert("chats", {
        userId: owner,
        kind: "documentary" as const,
        updatedAt: 1,
        pendingFetch: { sourceMessageId, createdAt: Date.now() },
      });
      return { hiddenId };
    });
    const replyId = await hiddenReply(t, owner, hiddenId, [
      { blob: inFlight, filename: "x.pdf", mimeType: "application/pdf" },
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch(replyId, { status: "complete" as const });
    });
    await t.mutation(internal.chatSummaries.sweepHiddenChat, { hiddenChatId: hiddenId });
    await settle(t);
    expect(await hiddenMessages(t, hiddenId)).toHaveLength(2);
    expect(await blobExists(t, inFlight)).toBe(true);
  });
});

describe("chart logos and import uploads go only when nothing else holds them", () => {
  async function seedChartOwner(t: T) {
    return t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user" as const, canonical: "owner" });
      return uid;
    });
  }

  async function chartWith(t: T, owner: Id<"users">, light?: Id<"_storage">, dark?: Id<"_storage">) {
    return t.run((ctx) =>
      ctx.db.insert("charts", {
        key: `c-${Math.random().toString(36).slice(2)}`,
        name: "Brand",
        scope: "personal",
        ownerUserId: owner,
        tokens: { colors: { light: {}, dark: {} } },
        ...(light ? { logoLightStorageId: light } : {}),
        ...(dark ? { logoDarkStorageId: dark } : {}),
        createdBy: owner,
        createdAt: 1,
      }),
    );
  }

  test("removing one mode's logo keeps a blob the other mode still shows", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedChartOwner(t);
    const logo = await storeBlob(t, "logo");
    const chartId = await chartWith(t, owner, logo, logo);
    const asOwner = t.withIdentity({ subject: `${owner}|session` });
    await asOwner.mutation(api.charts.removeChartLogo, { chartId, mode: "light" });
    expect(await blobExists(t, logo)).toBe(true);
    await asOwner.mutation(api.charts.removeChartLogo, { chartId, mode: "dark" });
    expect(await blobExists(t, logo)).toBe(false);
  });

  test("deleting a chart releases its logos, except one another chart shows", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedChartOwner(t);
    const shared = await storeBlob(t, "shared logo");
    const own = await storeBlob(t, "own logo");
    const chartId = await chartWith(t, owner, shared, own);
    await chartWith(t, owner, shared);
    const asOwner = t.withIdentity({ subject: `${owner}|session` });
    await asOwner.mutation(api.charts.deleteChart, { chartId });
    expect(await blobExists(t, shared)).toBe(true);
    expect(await blobExists(t, own)).toBe(false);
  });

  test("replacing a logo releases the previous blob only when nothing else shows it", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedChartOwner(t);
    const shared = await storeBlob(t, "shared logo");
    const chartId = await chartWith(t, owner, shared);
    await chartWith(t, owner, shared);
    const next = await storeBlob(t, "new logo");
    await t
      .withIdentity({ subject: `${owner}|session` })
      .mutation(internal.charts.persistChartLogo, { chartId, storageId: next, mode: "light", hasAlpha: false });
    expect(await blobExists(t, shared)).toBe(true);
  });

  test("an abandoned import's upload stays while a rendition still shows it", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "olivier");
    const blob = await storeBlob(t, "imported bytes");
    const loose = await storeBlob(t, "imported, unused");
    const importId = await t.run(async (ctx) => {
      const importId = await ctx.db.insert("archiveImports", {
        userId: owner,
        status: "applying" as const,
        formatVersion: 1,
        origin: null,
        fromThisDeployment: true,
        targetProjectId: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
      for (const id of [blob, loose]) {
        await ctx.db.insert("uploads", { storageId: id, userId: owner });
        await ctx.db.insert("archiveImportIds", { importId, kind: "blob", archiveId: id, mappedId: id });
      }
      const chatId = await ctx.db.insert("chats", { userId: owner, updatedAt: 1 });
      await ctx.db.insert("fileRenditions", {
        sourceStorageId: loose,
        chatId,
        userId: owner,
        sourceFilename: "a.docx",
        sourceMimeType: "application/msword",
        status: "ready" as const,
        pdfStorageId: blob,
        converterInstance: "prod",
        converterAgentId: "converter",
        createdAt: 1,
        updatedAt: 1,
      });
      return importId;
    });
    const asOwner = as(t, owner);
    expect(await asOwner.mutation(api.archiveImport.discardUpload, { importId, storageId: blob })).toEqual({
      discarded: false,
    });
    expect(await blobExists(t, blob)).toBe(true);
    // The owner's registration is not the import's to discard: once it has expired,
    // nothing holds the unused bytes.
    vi.setSystemTime(Date.now() + 8 * DAY);
    expect(await asOwner.mutation(api.archiveImport.discardUpload, { importId, storageId: loose })).toEqual({
      discarded: true,
    });
    expect(await blobExists(t, loose)).toBe(false);
  });
});
