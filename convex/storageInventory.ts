// THE LIVE STORAGE INVENTORY — what a PHYSICAL garbage collector diffs against.
//
// On a self-hosted backend, `ctx.storage.delete` removes a blob's `_storage` entry
// but leaves its bytes on the local disk or in the S3 bucket (storage deletes are
// soft — get-convex/convex-backend#93). Reclaiming space therefore takes a sweeper
// OUTSIDE Convex: it lists the objects it can see on disk / in the bucket, pages
// through this inventory, and deletes (after a grace period) the objects whose
// blob is no longer live here. The logical side — which blobs to delete — is
// lib/blobs.releaseBlob; this is only the read that makes the physical side
// possible.
//
// Internal on purpose: the inventory names every blob of the deployment, and only
// an operator's tool (a CLI run with the deploy key, `npx convex run`) may walk it.

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalQuery } from "./_generated/server";

/** Blobs one page returns at most — whatever the caller asks. */
export const INVENTORY_PAGE_MAX = 500;

/**
 * One page of the live `_storage` table, oldest first: each blob's id, its
 * content digest and size (what a sweeper matches against the objects it finds)
 * and its creation time (what its grace period is measured against). Resume with
 * `continueCursor` until `isDone`.
 */
export const listLiveBlobs = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const page = await ctx.db.system.query("_storage").paginate({
      ...paginationOpts,
      numItems: Math.max(1, Math.min(paginationOpts.numItems, INVENTORY_PAGE_MAX)),
    });
    return {
      blobs: page.page.map((blob) => ({
        storageId: blob._id,
        sha256: blob.sha256,
        size: blob.size,
        contentType: blob.contentType ?? null,
        createdAt: blob._creationTime,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
