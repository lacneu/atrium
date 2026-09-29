// THE LOGICAL ORPHAN SWEEP — shared rules (convex/blobSweep.ts runs the job).
//
// A blob is ORPHANED when no row references it any more (lib/blobs.blobReference)
// and it is old enough that no flow can still be about to reference it. Years of
// them exist: uploads picked in the composer and never sent, sub-agent interaction
// uploads (the bytes ride the dispatch, then nothing holds them), media the bridge
// uploaded for a part that was then refused, and blobs left by delete paths that
// predate lib/blobs.releaseBlob. The sweep deletes their `_storage` entries; on a
// self-hosted backend the bytes stay on disk until the PHYSICAL collector
// (deploy/gc) reclaims them — which is why this sweep alone frees no space.

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { blobReference, releaseBlob } from "./blobs";
import { mimeCategory } from "./files";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How old a blob must be before the sweep may call it an orphan, by default.
 *
 * WHY 7 DAYS. The longest legitimate window in which a live blob is held by no
 * reference is the composer: a file is uploaded the moment it is picked and held
 * only by its upload registration until the message is sent — a tab left open over
 * a long weekend is the realistic worst case. Every other window is minutes (a
 * bridge upload before its part lands: at most the 420 s repair budget; a
 * sub-agent interaction: until its dispatch). An archive import in progress is
 * protected explicitly, whatever its age. A week clears the composer case with room
 * to spare and still collects everything else long before anyone notices it. The
 * composer case is also closed by rule, whatever the minimum age chosen: an upload
 * registration holds its blob while it is usable (lib/blobs.UPLOAD_USABLE_MS, the
 * same week), and the send refuses one that is not (uploads.assertOwnsUpload).
 */
export const DEFAULT_SWEEP_MIN_AGE_DAYS = 7;

/** The floor: below a day the composer window is no longer covered. */
export const MIN_SWEEP_MIN_AGE_DAYS = 1;

/** The ceiling: an age past a year only hides orphans; nothing waits that long. */
export const MAX_SWEEP_MIN_AGE_DAYS = 365;

/** Blob ids a report keeps as examples. */
export const SWEEP_SAMPLE_IDS = 20;

/** The newest `_creationTime` a blob may have to be considered, for a sweep
 *  started at `now` with `minAgeDays`. */
export function sweepCutoff(now: number, minAgeDays: number): number {
  return now - minAgeDays * DAY_MS;
}

/** A requested minimum age, validated: an integer in the allowed range. */
export function validMinAgeDays(requested: number | undefined): number {
  const days = requested ?? DEFAULT_SWEEP_MIN_AGE_DAYS;
  if (
    !Number.isInteger(days) ||
    days < MIN_SWEEP_MIN_AGE_DAYS ||
    days > MAX_SWEEP_MIN_AGE_DAYS
  ) {
    throw new Error(
      `minAgeDays must be an integer between ${MIN_SWEEP_MIN_AGE_DAYS} and ${MAX_SWEEP_MIN_AGE_DAYS}`,
    );
  }
  return days;
}

/** The rough kind of an orphan the report can name without reading its bytes. */
export type OrphanOrigin =
  /** Registered by a browser upload (composer, sub-agent panel, archive import)
   *  and never — or no longer — attached to anything. */
  | "upload"
  /** No registration at all: a bridge upload whose part never landed, or a blob
   *  left by a delete path that did not release it. */
  | "unregistered";

/** What the sweep decided about one blob. */
export type BlobVerdict =
  | { kind: "young" }
  | { kind: "referenced" }
  /** Held only by an upload registration of someone whose archive import is still
   *  applying: its bytes are about to be attached. */
  | { kind: "importing" }
  | { kind: "orphan"; origin: OrphanOrigin };

/**
 * Classify one `_storage` entry. Point reads only (the reference test, the upload
 * registration, the uploader's applying import).
 */
export async function classifyBlob(
  ctx: MutationCtx,
  blob: { _id: Id<"_storage">; _creationTime: number },
  cutoff: number,
): Promise<BlobVerdict> {
  if (blob._creationTime > cutoff) return { kind: "young" };
  if ((await blobReference(ctx, blob._id)) !== null) return { kind: "referenced" };
  const upload = await ctx.db
    .query("uploads")
    .withIndex("by_storage", (q) => q.eq("storageId", blob._id))
    .first();
  if (upload === null) return { kind: "orphan", origin: "unregistered" };
  const applying = await ctx.db
    .query("archiveImports")
    .withIndex("by_user_status", (q) => q.eq("userId", upload.userId).eq("status", "applying"))
    .first();
  if (applying !== null) return { kind: "importing" };
  return { kind: "orphan", origin: "upload" };
}

/** The coarse content bucket a report groups orphans by. */
export function orphanTypeOf(contentType: string | null | undefined): string {
  return contentType ? mimeCategory(contentType) : "other";
}

/**
 * Reclaim a blob NAMED BY NETWORK INPUT (the bridge's ingest), unless anything
 * still holds it — a row that references it, or an upload registration.
 *
 * Unlike releaseBlob, an upload registration counts here: the id comes from the
 * wire, and a caller naming another user's freshly uploaded, not yet sent file
 * would otherwise have it destroyed (and its registration with it). A blob the
 * bridge uploaded itself carries no registration, so its own leftovers still go.
 * Best-effort: a reclaim never fails the ingest that asked for it.
 */
export async function reclaimUnheldBlob(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<void> {
  try {
    if ((await blobReference(ctx, storageId, { countUploads: true })) !== null) return;
    await releaseBlob(ctx, storageId, { reason: "ingest_reclaim" });
  } catch {
    // best-effort: an already-gone blob must not fail the ingest
  }
}
