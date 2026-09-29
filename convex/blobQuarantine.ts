// THE BLOB QUARANTINE — the only place a storage blob is ever deleted.
//
// lib/blobs.releaseBlob records a blob nothing references any more in
// `blobReleases`; it deletes nothing. Once a day, `purgeQuarantine` takes the
// entries older than the quarantine (BLOB_QUARANTINE_DAYS, default 7), tests each
// blob's references again — every one — and deletes it only if nothing holds it
// (lib/blobs.endQuarantine). A blob referenced again meanwhile, or all along by a
// row a reference-counting bug missed, is spared: any wrong release is recoverable
// for the length of the quarantine. Every path that releases a blob — a purge, a
// deleted message, a hidden-chat sweep, a chart logo, an import undone, an account
// deletion, the orphan sweep — goes through it.
//
// GATED ON THE PART INDEX. The reference test finds a message part by its blob
// through `messageParts.storageId`, a field older rows do not carry until
// `backfillPartStorage` has walked the table. Until that backfill has COMPLETED,
// the purge deletes nothing (the entries wait): a part older than the field would
// otherwise be invisible to it.
//
// On a self-hosted backend a deleted blob's bytes stay on disk until the physical
// collector runs (get-convex/convex-backend#93): nothing here frees space itself.

import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requireAdmin } from "./lib/access";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { blobQuarantineDays, endQuarantine, partStorageField } from "./lib/blobs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The migration key of the messageParts.storageId backfill. */
export const PART_STORAGE_BACKFILL = "messageParts.storageId";

/** Quarantine entries one purge step ends (each re-tests every reference). */
export const QUARANTINE_BATCH = 50;

/** messageParts one backfill step reads (parts carry payloads up to the document
 *  limit, so the page stays small — the orphan sweep's mirror check reads 128). */
export const BACKFILL_PAGE = 128;

/** A backfill whose progress stamp is older than this has lost its chain. */
export const BACKFILL_STALE_MS = 10 * 60 * 1000;

/** What the orphan-sweep card announces: how long a released blob waits. Admin. */
export const quarantineSettings = query({
  args: {},
  handler: async (ctx): Promise<{ days: number }> => {
    await requireAdmin(ctx);
    return { days: blobQuarantineDays() };
  },
});

/** Has the messageParts.storageId backfill completed? */
export async function partIndexComplete(ctx: MutationCtx): Promise<boolean> {
  const marker = await ctx.db
    .query("migrationMarkers")
    .withIndex("by_key", (q) => q.eq("key", PART_STORAGE_BACKFILL))
    .first();
  return marker?.completedAt !== undefined;
}

/**
 * The daily purge (crons.ts): end the quarantine of the entries older than
 * BLOB_QUARANTINE_DAYS, oldest first, a bounded batch per transaction,
 * re-scheduling itself while a full batch was taken. Resumable by construction:
 * an entry goes only in the transaction that ends its quarantine, so a chain that
 * died leaves the rest for the next run. Deletes nothing while the part index is
 * incomplete.
 */
export const purgeQuarantine = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!(await partIndexComplete(ctx))) {
      return { gated: true as const, ended: 0, deleted: 0, spared: 0 };
    }
    const cutoff = Date.now() - blobQuarantineDays() * DAY_MS;
    const due = await ctx.db
      .query("blobReleases")
      .withIndex("by_released_at", (q) => q.lte("releasedAt", cutoff))
      .take(QUARANTINE_BATCH);
    let deleted = 0;
    let spared = 0;
    for (const entry of due) {
      const outcome = await endQuarantine(ctx, entry);
      if (outcome === "deleted") deleted += 1;
      if (outcome === "spared") spared += 1;
    }
    if (due.length === QUARANTINE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.blobQuarantine.purgeQuarantine, {});
    }
    return { gated: false as const, ended: due.length, deleted, spared };
  },
});

/**
 * One step of the messageParts.storageId backfill: stamp the storage id of every
 * file/media part of one page that lacks it, save the cursor, and schedule the next
 * step — or, on the last page, mark the migration complete. Idempotent: a part
 * already stamped is left alone, and a replayed page stamps the same values.
 */
export const backfillPartStorage = internalMutation({
  args: {},
  handler: async (ctx) => {
    const marker = await ctx.db
      .query("migrationMarkers")
      .withIndex("by_key", (q) => q.eq("key", PART_STORAGE_BACKFILL))
      .first();
    if (marker?.completedAt !== undefined) return { done: true, stamped: 0 };
    const page = await ctx.db
      .query("messageParts")
      .paginate({ cursor: marker?.cursor ?? null, numItems: BACKFILL_PAGE });
    let stamped = 0;
    for (const row of page.page) {
      const field = partStorageField(row.part);
      if (field.storageId !== undefined && row.storageId !== field.storageId) {
        await ctx.db.patch(row._id, field);
        stamped += 1;
      }
    }
    const now = Date.now();
    const progress = {
      cursor: page.isDone ? null : page.continueCursor,
      updatedAt: now,
      ...(page.isDone ? { completedAt: now } : {}),
    };
    if (marker === null) {
      await ctx.db.insert("migrationMarkers", { key: PART_STORAGE_BACKFILL, ...progress });
    } else {
      await ctx.db.patch(marker._id, progress);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.blobQuarantine.backfillPartStorage, {});
    }
    return { done: page.isDone, stamped };
  },
});

/**
 * Start — or resume — the backfill unless it has completed or a live chain is
 * running it (a fresh progress stamp). Run by a cron, so a fresh deployment and a
 * chain that died both converge without anyone running anything by hand.
 */
export const ensurePartStorageBackfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    const marker = await ctx.db
      .query("migrationMarkers")
      .withIndex("by_key", (q) => q.eq("key", PART_STORAGE_BACKFILL))
      .first();
    if (marker?.completedAt !== undefined) return "complete" as const;
    if (marker !== null && marker.updatedAt > Date.now() - BACKFILL_STALE_MS) {
      return "running" as const;
    }
    await ctx.scheduler.runAfter(0, internal.blobQuarantine.backfillPartStorage, {});
    return "started" as const;
  },
});
