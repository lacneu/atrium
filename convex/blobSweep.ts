// THE LOGICAL ORPHAN SWEEP — find the storage blobs nothing references any more,
// report them (DRY RUN, the default), and delete their `_storage` entries only when
// an admin applies a report they have read (lib/blobSweep holds the rules).
//
// TWO PHASES, each in bounded, self-scheduled batches:
//
//   1. MIRROR. The reference test reads the `files` mirror for every file/media
//      message part (the part's own storage id is not indexed). A part whose
//      message exists but whose mirror row is missing — data older than the
//      mirror, never backfilled — holds a blob the test cannot see. So every part
//      is checked first, and an APPLY refuses while any is missing: run
//      `npx convex run files:backfillFiles` to completion, then dry-run again.
//   2. BLOBS. `_storage`, oldest first, up to the cutoff fixed at the start (blobs
//      younger than `minAgeDays` are never judged — the walk ends at the first).
//      Each old blob is classified (lib/blobSweep.classifyBlob); in an apply, an
//      orphan goes through lib/blobs.releaseBlob, which re-tests its references in
//      the same transaction — the dry run's list is shown to the admin, never
//      trusted by the apply.
//
// WHAT IT DOES NOT DO. It frees no disk space on a self-hosted backend: deleting a
// `_storage` entry is soft there (get-convex/convex-backend#93). The physical
// collector (deploy/gc, docs/installation/BACKUP.md) reclaims the bytes afterwards.

import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireAdmin } from "./lib/access";
import { recordAudit } from "./lib/audit";
import { releaseBlob } from "./lib/blobs";
import { isFilePart } from "./lib/files";
import {
  SWEEP_SAMPLE_IDS,
  classifyBlob,
  orphanTypeOf,
  sweepCutoff,
  validMinAgeDays,
} from "./lib/blobSweep";

/** Message parts one mirror batch reads. Parts carry tool payloads of any size up
 *  to the document limit, so the page stays small (files.backfillFiles walks 200). */
export const MIRROR_PAGE = 128;
/** Blobs one batch judges (an apply spends up to BLOB_RELEASE_READS on each). */
export const BLOB_PAGE = 100;
/** A running sweep whose progress stamp is older than this has lost its chain. */
export const SWEEP_STALE_MS = 30 * 60 * 1000;
/** How long a dry run may be applied after it finished. */
export const REPORT_APPLICABLE_MS = 24 * 60 * 60 * 1000;
/** Reports kept; older ones are removed when a new sweep starts. */
const REPORTS_KEPT = 20;
/** Reports the admin view lists. */
const REPORTS_LISTED = 5;

type Tally = { count: number; bytes: number };
const ZERO: Tally = { count: 0, bytes: 0 };

function add(t: Tally | undefined, bytes: number): Tally {
  return { count: (t?.count ?? 0) + 1, bytes: (t?.bytes ?? 0) + bytes };
}

/**
 * Start a sweep. A DRY RUN (the default) only reports. An APPLY carries out a dry
 * run the admin has read: it names that report (`confirms`), which must have
 * finished within the last 24 hours with a complete files mirror, and it runs with
 * the report's own minimum age. Audit-logged.
 */
export const startBlobSweep = mutation({
  args: {
    mode: v.union(v.literal("dryRun"), v.literal("apply")),
    minAgeDays: v.optional(v.number()),
    confirms: v.optional(v.id("blobSweeps")),
  },
  handler: async (ctx, { mode, minAgeDays, confirms }): Promise<Id<"blobSweeps">> => {
    const adminId = await requireAdmin(ctx);
    const now = Date.now();
    const running = await ctx.db
      .query("blobSweeps")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .first();
    if (running !== null) {
      if (running.updatedAt > now - SWEEP_STALE_MS) {
        throw new Error("A storage sweep is already running");
      }
      await ctx.db.patch(running._id, { status: "stalled", finishedAt: now });
    }

    let days: number;
    if (mode === "apply") {
      if (confirms === undefined) throw new Error("An apply must confirm a dry-run report");
      const report = await ctx.db.get(confirms);
      if (
        report === null ||
        report.mode !== "dryRun" ||
        report.status !== "done" ||
        report.finishedAt === undefined
      ) {
        throw new Error("The confirmed report is not a finished dry run");
      }
      if (report.finishedAt < now - REPORT_APPLICABLE_MS) {
        throw new Error("The confirmed report is more than 24 hours old: run a new dry run");
      }
      if (report.mirrorMissing > 0) {
        throw new Error("The confirmed report found file parts without a files row");
      }
      if (minAgeDays !== undefined && minAgeDays !== report.minAgeDays) {
        throw new Error("An apply runs with its report's minimum age");
      }
      days = report.minAgeDays;
    } else {
      days = validMinAgeDays(minAgeDays);
    }

    await pruneOldReports(ctx);
    const sweepId = await ctx.db.insert("blobSweeps", {
      mode,
      status: "running",
      phase: "mirror",
      cursor: null,
      minAgeDays: days,
      cutoff: sweepCutoff(now, days),
      startedBy: adminId,
      startedAt: now,
      updatedAt: now,
      ...(mode === "apply" ? { confirms } : {}),
      partsChecked: 0,
      mirrorMissing: 0,
      blobsScanned: 0,
      referenced: 0,
      importing: 0,
      orphans: ZERO,
      byOrigin: {},
      byType: {},
      deleted: ZERO,
      sampleIds: [],
    });
    await ctx.scheduler.runAfter(0, internal.blobSweep.sweepStep, { sweepId });
    await recordAudit(
      ctx,
      { realUserId: adminId, effectiveUserId: adminId, impersonating: false },
      mode === "apply" ? "storage.sweep_apply" : "storage.sweep_dry_run",
      { resource: "blobSweep", resourceId: sweepId },
    );
    return sweepId;
  },
});

async function pruneOldReports(ctx: MutationCtx): Promise<void> {
  const newest = await ctx.db
    .query("blobSweeps")
    .withIndex("by_started")
    .order("desc")
    .take(REPORTS_KEPT + 8);
  for (const old of newest.slice(REPORTS_KEPT - 1)) {
    if (old.status !== "running") await ctx.db.delete(old._id);
  }
}

/** One bounded batch of a sweep; schedules the next while work remains. */
export const sweepStep = internalMutation({
  args: { sweepId: v.id("blobSweeps") },
  handler: async (ctx, { sweepId }) => {
    const sweep = await ctx.db.get(sweepId);
    if (sweep === null || sweep.status !== "running") return;
    if (sweep.phase === "mirror") await mirrorBatch(ctx, sweep);
    else await blobBatch(ctx, sweep);
  },
});

// KNOWN COST: every run re-reads the whole `messageParts` table here, dry run and
// apply alike. Once a deployment's mirror is complete it stays complete (every
// part insert writes its files row), so a persisted "verified" marker could skip
// this phase; deferred until the cost shows.
async function mirrorBatch(ctx: MutationCtx, sweep: Doc<"blobSweeps">): Promise<void> {
  const page = await ctx.db
    .query("messageParts")
    .paginate({ cursor: sweep.cursor, numItems: MIRROR_PAGE });
  let checked = 0;
  let missing = 0;
  for (const row of page.page) {
    const part = row.part;
    if (!isFilePart(part)) continue;
    checked += 1;
    const mirrored = await ctx.db
      .query("files")
      .withIndex("by_message_storage", (q) =>
        q.eq("messageId", row.messageId).eq("storageId", part.storageId),
      )
      .first();
    // A part whose message is gone shows nothing and holds nothing a reader
    // can reach; backfillFiles skips it too.
    if (mirrored === null && (await ctx.db.get(row.messageId)) !== null) missing += 1;
  }
  const now = Date.now();
  const partsChecked = sweep.partsChecked + checked;
  const mirrorMissing = sweep.mirrorMissing + missing;
  if (!page.isDone) {
    await ctx.db.patch(sweep._id, {
      cursor: page.continueCursor,
      partsChecked,
      mirrorMissing,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.blobSweep.sweepStep, { sweepId: sweep._id });
    return;
  }
  if (sweep.mode === "apply" && mirrorMissing > 0) {
    await ctx.db.patch(sweep._id, {
      status: "refused",
      refusal: "mirror_incomplete",
      partsChecked,
      mirrorMissing,
      updatedAt: now,
      finishedAt: now,
    });
    return;
  }
  await ctx.db.patch(sweep._id, {
    phase: "blobs",
    cursor: null,
    partsChecked,
    mirrorMissing,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.blobSweep.sweepStep, { sweepId: sweep._id });
}

async function blobBatch(ctx: MutationCtx, sweep: Doc<"blobSweeps">): Promise<void> {
  const page = await ctx.db.system
    .query("_storage")
    .paginate({ cursor: sweep.cursor, numItems: BLOB_PAGE });
  let scanned = 0;
  let referenced = 0;
  let importing = 0;
  let orphans = sweep.orphans;
  let deleted = sweep.deleted;
  const byOrigin = { ...sweep.byOrigin };
  const byType = { ...sweep.byType };
  const sampleIds = [...sweep.sampleIds];
  let reachedCutoff = false;
  for (const blob of page.page) {
    const verdict = await classifyBlob(ctx, blob, sweep.cutoff);
    // Oldest first: the first blob too young to judge ends the walk.
    if (verdict.kind === "young") {
      reachedCutoff = true;
      break;
    }
    scanned += 1;
    if (verdict.kind === "referenced") {
      referenced += 1;
      continue;
    }
    if (verdict.kind === "importing") {
      importing += 1;
      continue;
    }
    orphans = add(orphans, blob.size);
    byOrigin[verdict.origin] = add(byOrigin[verdict.origin], blob.size);
    const type = orphanTypeOf(blob.contentType);
    byType[type] = add(byType[type], blob.size);
    if (sampleIds.length < SWEEP_SAMPLE_IDS) sampleIds.push(blob._id);
    // RELEASED, not deleted: the blob enters the quarantine (lib/blobs.releaseBlob)
    // and is deleted by its purge only if still unreferenced a week later.
    if (
      sweep.mode === "apply" &&
      (await releaseBlob(ctx, blob._id, { reason: "orphan_sweep" })) === "quarantined"
    ) {
      deleted = add(deleted, blob.size);
    }
  }
  const now = Date.now();
  const done = reachedCutoff || page.isDone;
  await ctx.db.patch(sweep._id, {
    cursor: done ? null : page.continueCursor,
    blobsScanned: sweep.blobsScanned + scanned,
    referenced: sweep.referenced + referenced,
    importing: sweep.importing + importing,
    orphans,
    byOrigin,
    byType,
    deleted,
    sampleIds,
    updatedAt: now,
    ...(done ? { status: "done" as const, finishedAt: now } : {}),
  });
  if (!done) {
    await ctx.scheduler.runAfter(0, internal.blobSweep.sweepStep, { sweepId: sweep._id });
  }
}

/** The latest sweeps, newest first — what Settings shows. Admin only. */
export const listBlobSweeps = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("blobSweeps")
      .withIndex("by_started")
      .order("desc")
      .take(REPORTS_LISTED);
    const now = Date.now();
    return rows.map((r) => ({
      _id: r._id,
      mode: r.mode,
      status: r.status,
      // A running row whose chain died reads as what it is.
      stale: r.status === "running" && r.updatedAt < now - SWEEP_STALE_MS,
      phase: r.phase,
      minAgeDays: r.minAgeDays,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null,
      applicableUntil:
        r.mode === "dryRun" && r.status === "done" && r.finishedAt !== undefined
          ? r.finishedAt + REPORT_APPLICABLE_MS
          : null,
      confirms: r.confirms ?? null,
      partsChecked: r.partsChecked,
      mirrorMissing: r.mirrorMissing,
      blobsScanned: r.blobsScanned,
      referenced: r.referenced,
      importing: r.importing,
      orphans: r.orphans,
      byOrigin: r.byOrigin,
      byType: r.byType,
      deleted: r.deleted,
      sampleIds: r.sampleIds,
      refusal: r.refusal ?? null,
    }));
  },
});
