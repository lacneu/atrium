// Upload ownership registry (IDOR defense for attachments).
//
// Why this exists: Convex's `ctx.storage.generateUploadUrl()` hands the browser
// a short-lived signed URL, and the browser POSTs the bytes directly to storage.
// The storageId only exists AFTER that POST resolves — there is no server-side
// "upload finished" hook we could use to record who uploaded what. Without an
// ownership record, `send.sendMessage` could not tell whether an attachment
// storageId in its args was actually uploaded by the calling user, or guessed /
// replayed from another user (an IDOR: reference someone else's blob).
//
// Resolution (register-at-confirm): the attachment adapter calls
// `registerUpload({ storageId })` immediately after its upload POST resolves.
// We derive the user via auth (never an arg) and persist a `uploads` row. The
// send mutation then enforces ownership via `assertOwnsUpload`.

import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireActive } from "./lib/access";

/**
 * Record that the authenticated user owns a freshly uploaded storage blob.
 * Idempotent: a retried call for the same (user, storageId) is a no-op rather
 * than inserting a duplicate ownership row.
 *
 * NOTE: identity is derived from `ctx.auth` (never taken as an arg), so a caller
 * can only ever register a blob under their own id.
 */
export const registerUpload = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const { userId } = await requireActive(ctx);
    // Reject if this storageId is already owned by a DIFFERENT user: a blob can
    // only ever be claimed once, so a caller cannot register an id another user
    // uploaded (defense-in-depth atop the unguessability of storage ids).
    const owner = await ctx.db
      .query("uploads")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .unique();
    if (owner !== null) {
      if (owner.userId !== userId) {
        throw new Error("Forbidden: storage blob already owned by another user");
      }
      return { ok: true } as const; // idempotent re-register by the same user
    }
    await ctx.db.insert("uploads", { storageId, userId });
    return { ok: true } as const;
  },
});

/**
 * Throw unless `storageId` was registered to `userId` (the IDOR gate). Shared by
 * `send.sendMessage`. Uses the (userId, storageId) index for a single lookup.
 */
export async function assertOwnsUpload(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  storageId: Id<"_storage">,
): Promise<void> {
  const row = await ctx.db
    .query("uploads")
    .withIndex("by_user_storage", (q) =>
      q.eq("userId", userId).eq("storageId", storageId),
    )
    .unique();
  if (row === null) {
    // Do not leak whether the blob exists for some other user — a flat forbidden.
    throw new Error("Forbidden: attachment not owned by user");
  }
}
