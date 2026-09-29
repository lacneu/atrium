// STORAGE BLOBS ARE SHARED — ONE rule for when one may go.
//
// A `_storage` object is never owned by a single row. A fork copies its source's
// file rows onto the SAME storage id (chatFork.ts), a documentary fetch and a
// delivered file can land on one blob, a rendition keeps a PDF, a chart keeps its
// logos. Deleting a blob because ONE row that named it went away destroys what
// every other row still shows. So a blob goes only when NOTHING references it any
// more, asked through the indexes below — and this module is the only place that
// knows the list.
//
// WHAT "GOES" MEANS. Nothing is deleted at release: an unreferenced blob enters the
// QUARANTINE (`blobReleases`) and stays whole for BLOB_QUARANTINE_DAYS. Only the
// daily purge (blobQuarantine.purgeQuarantine) deletes it — after testing its
// references again, so a wrong release is recoverable for that long — and only
// once the messageParts.storageId backfill has completed. Its `ctx.storage.delete`
// removes the `_storage` entry: no URL is issued for it any more. It does NOT
// reclaim the bytes on a self-hosted backend — storage deletes are soft there (the
// object stays on the local disk or in the S3 bucket; get-convex/convex-backend#93).
// Reclaiming them is a physical garbage collector's job, run outside Convex against
// the live inventory (storageInventory.listLiveBlobs). This module decides WHICH
// blobs are dead; it does not free space.
//
// THE REFERENCE LIST (every schema field that holds a storage id):
//   - messageParts.storageId     (by_storage)      — every file/media part, found by
//     its blob whether or not its files mirror exists (the denormalized copy of
//     `part.storageId`, which sits inside a union and is not indexable).
//   - files.storageId            (by_storage)      — the mirror of every file/media
//     messagePart (lib/files).
//   - documentAttachments.storageId (by_storage)
//   - fileRenditions.pdfStorageId (by_pdf_storage) — the rendered PDF.
//   - charts.logoLightStorageId / logoDarkStorageId (by_logo_light / by_logo_dark)
//   - fileRenditions.sourceStorageId while the rendition is `pending` (by_source)
//     — a conversion queued or in flight will attach the source to its turn in the
//     converter's hidden chat, where NO files row names it. The rendition row is
//     the exact reference: it is `pending` from the request until the conversion
//     settles (ready / failed / timed out), whatever happens to its outbox row.
//   - archiveImportIds of kind IMPORT_BLOB_KIND (by_kind_archive) — while its
//     import is `applying` or `abandoning`: the import is about to attach the blob,
//     or wrote a part naming it before the part's files mirror.
//   - uploads.storageId          (by_storage)      — an OWNERSHIP registration
//     (the IDOR gate): counted while it is USABLE — its owner may still attach the
//     blob (uploadIsUsable) — and, on request (`countUploads`), whatever its age.
// NOT references, by design:
//   - fileRenditions.sourceStorageId of a SETTLED rendition — derived from its
//     source, it goes with it (releaseBlob removes it).
//   - outbox.attachmentIds / attachments[].storageId — arrays, not indexable, and
//     not needed: every other send attaches the files of a message that exists
//     while the send can still leave (a send writes its parts and their files rows
//     with the outbox row; deleting the message deletes its non-terminal outbox
//     rows), so the files mirror holds them. The conversion turn is the one send
//     whose blob no files row names — covered by its pending rendition (above).
//   - documentDrafts.sourceStorageId — a version marker (a string), not a use.
//   - subAgentInteractions.attachments — metadata only (name + type); the bytes
//     rode the dispatch and are held by nothing afterwards.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** What holds a blob, first found. */
export type BlobReference =
  | "part"
  | "file"
  | "documentAttachment"
  | "renditionPdf"
  | "chartLogo"
  | "renditionSource"
  | "importing"
  | "upload";

/**
 * The first row that references `storageId`, or null when none does. Point reads
 * only (one `.first()` per index), so it can answer for ANY blob — including one
 * no row names at all, the question an orphan sweep asks.
 */
export async function blobReference(
  ctx: QueryCtx | MutationCtx,
  storageId: Id<"_storage">,
  opts: {
    countUploads?: boolean;
    /** The import being undone: its own blob mappings hold nothing any more. */
    abandonedImport?: Id<"archiveImports">;
  } = {},
): Promise<BlobReference | null> {
  // THE PART ITSELF, not only its files mirror: a legacy part written before the
  // mirror (or by a path that missed it) still shows the blob. Every writer of a
  // file/media part denormalizes its storage id (partStorageField); rows older than
  // that are backfilled (blobQuarantine.backfillPartStorage), and nothing is deleted
  // before that backfill has completed (blobQuarantine.purgeQuarantine).
  if (
    (await ctx.db
      .query("messageParts")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first()) !== null
  ) {
    return "part";
  }
  if (
    (await ctx.db
      .query("files")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first()) !== null
  ) {
    return "file";
  }
  if (
    (await ctx.db
      .query("documentAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first()) !== null
  ) {
    return "documentAttachment";
  }
  if (
    (await ctx.db
      .query("fileRenditions")
      .withIndex("by_pdf_storage", (q) => q.eq("pdfStorageId", storageId))
      .first()) !== null
  ) {
    return "renditionPdf";
  }
  if (
    (await ctx.db
      .query("charts")
      .withIndex("by_logo_light", (q) => q.eq("logoLightStorageId", storageId))
      .first()) !== null ||
    (await ctx.db
      .query("charts")
      .withIndex("by_logo_dark", (q) => q.eq("logoDarkStorageId", storageId))
      .first()) !== null
  ) {
    return "chartLogo";
  }
  // Exact, not bounded: one source has one rendition row by construction (the
  // cache key — fileRenditions.requestRendition), and every row is read.
  for await (const rendition of ctx.db
    .query("fileRenditions")
    .withIndex("by_source", (q) => q.eq("sourceStorageId", storageId))) {
    if (rendition.status === "pending") return "renditionSource";
  }
  // An import IN PROGRESS that registered this blob (archiveImport.registerImportBlob)
  // is about to attach it — or already wrote a part naming it whose files mirror has
  // not landed yet. Held until the import finishes (its files rows hold it from
  // then on) or is undone (its own cleanup releases it). Every mapping of the blob
  // is read: one per import that registered it.
  for await (const mapping of ctx.db
    .query("archiveImportIds")
    .withIndex("by_kind_archive", (q) =>
      q.eq("kind", IMPORT_BLOB_KIND).eq("archiveId", storageId),
    )) {
    if (mapping.importId === opts.abandonedImport) continue;
    const session = await ctx.db.get(mapping.importId);
    if (session !== null && (session.status === "applying" || session.status === "abandoning")) {
      return "importing";
    }
  }
  // An upload registration while it is USABLE (uploadIsUsable): its owner may still
  // attach the blob to a send (uploads.assertOwnsUpload), so it must not go. An
  // expired one holds nothing — unless the caller asks (`countUploads`: a blob
  // named by network input must never take a user's file with it).
  const now = Date.now();
  for (const upload of await ctx.db
    .query("uploads")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .take(DEPENDENTS_READ)) {
    if (opts.countUploads === true || uploadIsUsable(upload, now)) return "upload";
  }
  return null;
}

/**
 * HOW LONG AN UPLOAD REGISTRATION STAYS USABLE. A registration (uploads.ts) is what
 * lets its owner attach a blob to a send. The composer registers a file the moment
 * it is picked and may send it much later — a tab left open over a long weekend —
 * and a file already sent can be attached again. Registrations never expired, so a
 * blob with one could never be told abandoned. The rule:
 *
 *   - within UPLOAD_USABLE_MS of its registration, a blob may be attached freely,
 *     and the registration holds it (blobReference: "upload");
 *   - past it, the registration still admits the blob while one of its owner's
 *     own messages shows it (a files row of theirs names it — and holds it), and
 *     nothing otherwise: the send refuses it cleanly (uploads.assertOwnsUpload),
 *     and the blob may go once nothing else references it.
 *
 * The same week as the orphan sweep's default minimum age (lib/blobSweep), so the
 * sweep never judges a blob its owner may still attach.
 */
export const UPLOAD_USABLE_MS = 7 * 24 * 60 * 60 * 1000;

/** Is this registration still usable at `now` (see UPLOAD_USABLE_MS)? */
export function uploadIsUsable(
  upload: { _creationTime: number },
  now: number,
): boolean {
  return upload._creationTime > now - UPLOAD_USABLE_MS;
}

/** The mapping kind under which an archive import records the blobs it uploaded
 *  (archiveImportIds; archiveId = mappedId = the storage id). */
export const IMPORT_BLOB_KIND = "blob";

/** Rows one derived-dependent read may return (renditions of one source, upload
 *  registrations of one blob — one of each in practice). */
const DEPENDENTS_READ = 4;

/** Reads of one reference test (`blobReference`): seven point reads, the source's
 *  rendition row, the imports holding it (a mapping and its session each) and its
 *  upload registrations. */
const REFERENCE_READS = 8 + 2 * DEPENDENTS_READ + DEPENDENTS_READ;

/**
 * Upper bound of the documents one `releaseBlob` touches — the budget a batched
 * caller charges per blob: the reference test, the storage lookup, and the
 * quarantine entry (read, then written).
 */
export const BLOB_RELEASE_READS = REFERENCE_READS + 3;

/**
 * Release the blob `storageId` IF nothing references it any more — into the
 * QUARANTINE, not out of storage: an entry in `blobReleases` records the release,
 * and the blob stays whole for BLOB_QUARANTINE_MS. Only the daily purge
 * (blobQuarantine.purgeQuarantine) deletes it, after testing its references again:
 * a blob referenced again meanwhile — or all along, by a row a reference-counting
 * bug missed — is spared. Any wrong release is thereby recoverable for a week.
 * Otherwise (referenced) nothing changes.
 *
 * Call it AFTER deleting the row that named the blob, in the same transaction: the
 * reads here see that deletion, so the last holder to go is the one that releases
 * the blob, whichever it is and whenever it goes. Idempotent — one entry per blob,
 * the first release's date kept — and safe to call for any id ("gone" when the
 * blob no longer exists).
 */
export async function releaseBlob(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
  opts: {
    abandonedImport?: Id<"archiveImports">;
    /** Why it was released, for the quarantine's record (a closed vocabulary). */
    reason?: string;
  } = {},
): Promise<"kept" | "quarantined" | "gone"> {
  if ((await blobReference(ctx, storageId, opts)) !== null) return "kept";
  if ((await ctx.db.system.get("_storage", storageId)) === null) return "gone";
  const entry = await ctx.db
    .query("blobReleases")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (entry === null) {
    await ctx.db.insert("blobReleases", {
      storageId,
      releasedAt: Date.now(),
      reason: opts.reason ?? "released",
    });
  }
  return "quarantined";
}

/** How long a released blob waits in the quarantine before it may be deleted. */
export const DEFAULT_BLOB_QUARANTINE_DAYS = 7;

/** The quarantine in days: `BLOB_QUARANTINE_DAYS` when a positive number, else the
 *  default (same contract as the other retentions). */
export function blobQuarantineDays(
  raw: string | undefined = process.env.BLOB_QUARANTINE_DAYS,
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BLOB_QUARANTINE_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BLOB_QUARANTINE_DAYS;
}

/**
 * The END of a quarantine: test the blob's references again — every one, the part
 * index included — and delete it only if nothing holds it, with what exists only
 * because of it (its settled renditions, whose PDFs are released in turn, and its
 * expired upload registrations). A blob held again is spared. The entry goes
 * either way. Called by the purge alone.
 */
export async function endQuarantine(
  ctx: MutationCtx,
  entry: Doc<"blobReleases">,
): Promise<"spared" | "deleted" | "gone"> {
  await ctx.db.delete(entry._id);
  const storageId = entry.storageId;
  if ((await blobReference(ctx, storageId)) !== null) return "spared";
  for (const rendition of await ctx.db
    .query("fileRenditions")
    .withIndex("by_source", (q) => q.eq("sourceStorageId", storageId))
    .take(DEPENDENTS_READ)) {
    await ctx.db.delete(rendition._id);
    const pdf = rendition.pdfStorageId;
    if (pdf !== undefined && pdf !== storageId) {
      await releaseBlob(ctx, pdf, { reason: "rendition_source_deleted" });
    }
  }
  for (const upload of await ctx.db
    .query("uploads")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .take(DEPENDENTS_READ)) {
    await ctx.db.delete(upload._id);
  }
  if ((await ctx.db.system.get("_storage", storageId)) === null) return "gone";
  await ctx.storage.delete(storageId);
  return "deleted";
}

/** The storage id to denormalize onto a messageParts row (its `storageId` field,
 *  indexed `by_storage`): the part's own, for a file/media part. EVERY writer of a
 *  part spreads this, so a part is found by its blob (blobReference). */
export function partStorageField(part: {
  kind: string;
  storageId?: unknown;
}): { storageId?: Id<"_storage"> } {
  const [storageId] = storageIdsOfPart(part);
  return storageId === undefined ? {} : { storageId };
}

/** Every storage id a message part, an outbox row or an attachment row names. */
export function storageIdsOfPart(part: { kind: string; storageId?: unknown }): Id<"_storage">[] {
  return (part.kind === "media" || part.kind === "file") && typeof part.storageId === "string"
    ? [part.storageId as Id<"_storage">]
    : [];
}

export function storageIdsOfOutbox(row: {
  attachmentIds: ReadonlyArray<Id<"_storage">>;
  attachments?: ReadonlyArray<{ storageId: Id<"_storage"> }>;
}): Id<"_storage">[] {
  const ids = new Set<Id<"_storage">>(row.attachmentIds);
  for (const a of row.attachments ?? []) ids.add(a.storageId);
  return [...ids];
}
