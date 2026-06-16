// Settings → Fichiers: the owner-scoped file listing (inbound uploads + outbound
// agent files) backed by the denormalized `files` table (see schema.ts + lib/files).
//
// AUTH: gated on `chats.read` against the REAL identity (every approved user holds
// it; admins via the wildcard), then the DATA is scoped to the EFFECTIVE user
// (impersonation-aware) — same split as the other owner-scoped reads. A user only
// ever sees their own files.

import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requirePermission, requireUserId } from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import {
  isFilePart,
  recordFileForPart,
  mimeCategory,
  type FileCategory,
} from "./lib/files";

// Bounded owner read (metadata-scale platform). `truncated` surfaces the cap
// honestly (no silent truncation). The LIST applies its filters SERVER-SIDE
// before the cap (so a filter matching only old files isn't dropped); the FACETS
// come from the recent-window read (the filter dropdowns reflect that window).
const CAP = 500;

export const listMine = query({
  args: {
    direction: v.optional(
      v.union(v.literal("inbound"), v.literal("outbound")),
    ),
    chatId: v.optional(v.id("chats")),
    instanceName: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Real-identity permission gate; effective-identity data scope.
    await requirePermission(ctx, PERMISSIONS.CHATS_READ);
    const userId = await requireUserId(ctx);

    // FACETS — the recent owner window: every distinct chat/instance/category the
    // filter dropdowns offer. Bounded; for a >CAP user this is the recent slice.
    const ownerWindow = await ctx.db
      .query("files")
      // `deletedAt === undefined` is INDEXED (by_user_created prefix), so this
      // ranges only LIVE rows — tombstones are never scanned.
      .withIndex("by_user_created", (q) =>
        q.eq("userId", userId).eq("deletedAt", undefined),
      )
      .order("desc")
      .take(CAP);
    const facetChatIds = [...new Set(ownerWindow.map((r) => r.chatId))];
    const chatTitle = new Map<string, string>();
    for (const cid of facetChatIds) {
      const c = await ctx.db.get(cid);
      chatTitle.set(cid, c?.title ?? "Conversation");
    }
    const instanceSet = new Set<string>();
    for (const r of ownerWindow) if (r.instanceName) instanceSet.add(r.instanceName);
    const categorySet = new Set<FileCategory>(
      ownerWindow.map((r) => r.category ?? mimeCategory(r.mimeType)),
    );

    // LIST — drive the scan with an INDEX that covers as many active filters as
    // possible so Convex reads only matching rows up to the cap, not the whole
    // owner set (Codex P2 scalability). Any dimensions the index does NOT cover
    // are AND-ed on top via `.filter()`; the cap then counts only MATCHING rows,
    // so a filter on a rare/old value is never dropped by a window of newer files.
    //
    // Index choice, by what bounds the residual scan:
    //  - chatId present  → by_user_chat (residual scan bounded by ONE conversation,
    //    so any other filters ride on top safely even though they aren't indexed).
    //  - category + direction (no chatId) → by_user_category_direction, the only
    //    multi-filter non-chatId combo reachable today (both low-cardinality, so
    //    neither alone bounds the scan). A residual instanceName filter is bounded
    //    by that two-column prefix.
    //  - a single filter → its own one-dimension index (exact cover, no residual).
    //  - none → by_user_created.
    // category×instanceName / direction×instanceName (without the third dim) are
    // only reachable under multi-provider (the instance filter self-hides when one
    // provider) — deferred to #97, which adds their composite indexes.
    const coveredDims = new Set<string>();
    const indexed = (() => {
      if (args.chatId) {
        coveredDims.add("chatId");
        const c = args.chatId;
        return ctx.db
          .query("files")
          .withIndex("by_user_chat", (x) =>
            x.eq("userId", userId).eq("chatId", c).eq("deletedAt", undefined),
          )
          .order("desc");
      }
      if (args.category && args.direction) {
        coveredDims.add("category");
        coveredDims.add("direction");
        const cat = args.category as FileCategory;
        const d = args.direction;
        return ctx.db
          .query("files")
          .withIndex("by_user_category_direction", (x) =>
            x
              .eq("userId", userId)
              .eq("category", cat)
              .eq("direction", d)
              .eq("deletedAt", undefined),
          )
          .order("desc");
      }
      if (args.category) {
        coveredDims.add("category");
        const cat = args.category as FileCategory;
        return ctx.db
          .query("files")
          .withIndex("by_user_category", (x) =>
            x.eq("userId", userId).eq("category", cat).eq("deletedAt", undefined),
          )
          .order("desc");
      }
      if (args.direction) {
        coveredDims.add("direction");
        const d = args.direction;
        return ctx.db
          .query("files")
          .withIndex("by_user_direction", (x) =>
            x.eq("userId", userId).eq("direction", d).eq("deletedAt", undefined),
          )
          .order("desc");
      }
      if (args.instanceName) {
        coveredDims.add("instanceName");
        const i = args.instanceName;
        return ctx.db
          .query("files")
          .withIndex("by_user_instance", (x) =>
            x
              .eq("userId", userId)
              .eq("instanceName", i)
              .eq("deletedAt", undefined),
          )
          .order("desc");
      }
      return ctx.db
        .query("files")
        .withIndex("by_user_created", (x) =>
          x.eq("userId", userId).eq("deletedAt", undefined),
        )
        .order("desc");
    })();
    let listQuery = indexed;
    if (args.direction && !coveredDims.has("direction")) {
      const d = args.direction;
      listQuery = listQuery.filter((f) => f.eq(f.field("direction"), d));
    }
    if (args.chatId && !coveredDims.has("chatId")) {
      const c = args.chatId;
      listQuery = listQuery.filter((f) => f.eq(f.field("chatId"), c));
    }
    if (args.instanceName && !coveredDims.has("instanceName")) {
      const i = args.instanceName;
      listQuery = listQuery.filter((f) => f.eq(f.field("instanceName"), i));
    }
    if (args.category && !coveredDims.has("category")) {
      const cat = args.category;
      listQuery = listQuery.filter((f) => f.eq(f.field("category"), cat));
    }
    // Soft-deleted rows are excluded by the INDEX range (`deletedAt === undefined`
    // is part of every listing index prefix above), so tombstones are never
    // scanned — no residual `.filter` needed here.
    const rows = await listQuery.take(CAP + 1);
    const truncated = rows.length > CAP;
    const list = truncated ? rows.slice(0, CAP) : rows;

    // Chat titles for the listed rows (reuse the facet window's titles; load any
    // not already known — e.g. an old chat surfaced only by a filter).
    for (const r of list) {
      if (!chatTitle.has(r.chatId)) {
        const c = await ctx.db.get(r.chatId);
        chatTitle.set(r.chatId, c?.title ?? "Conversation");
      }
    }

    const files = await Promise.all(
      list.map(async (r) => ({
        _id: r._id,
        filename: r.filename,
        mimeType: r.mimeType,
        category: r.category ?? mimeCategory(r.mimeType),
        kind: r.kind,
        direction: r.direction,
        instanceName: r.instanceName ?? null,
        chatId: r.chatId,
        chatTitle: chatTitle.get(r.chatId) ?? "Conversation",
        createdAt: r.createdAt,
        // null when the underlying blob was garbage-collected → the UI shows
        // "indisponible" instead of a broken download link.
        url: await ctx.storage.getUrl(r.storageId),
      })),
    );

    return {
      files,
      truncated,
      cap: CAP,
      facets: {
        chats: facetChatIds.map((id) => ({
          id,
          title: chatTitle.get(id) ?? "Conversation",
        })),
        instances: [...instanceSet].sort(),
        // Self-hide the instance/bridge filter when everything is one provider
        // (mirrors the sidebar bridge badge): only meaningful with >1 distinct.
        multiProvider: instanceSet.size > 1,
        categories: [...categorySet].sort(),
      },
    };
  },
});

// Owner soft-delete: hide ONE of the caller's files from the Settings › Fichiers
// listing. Scoped to the EFFECTIVE user (same as the listing the button sits on);
// a missing row OR another user's id rejects identically (no cross-user oracle).
// SOFT: sets `deletedAt`, keeps the row + the underlying message part + the blob
// (the file still appears in its chat bubble — this only removes it from "my
// files"). Idempotent: re-deleting an already-deleted row is a no-op.
export const softDelete = mutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    await requirePermission(ctx, PERMISSIONS.CHATS_READ);
    const userId = await requireUserId(ctx);
    const row = await ctx.db.get(fileId);
    if (!row || row.userId !== userId) {
      throw new Error("File not found");
    }
    if (row.deletedAt === undefined) {
      await ctx.db.patch(fileId, { deletedAt: Date.now() });
    }
    return { ok: true };
  },
});

// One-shot, RE-RUNNABLE backfill: walk existing `messageParts`, and for every
// file/media part with no `files` row yet, create one (historical createdAt =
// the message's creation time). Bounded per page + self-scheduling to the end.
// Idempotent: a second run inserts nothing (the (messageId, storageId) dedup
// guard). Invoke once after deploy: `npx convex run files:backfillFiles`.
export const backfillFiles = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const PAGE = 200;
    const page = await ctx.db
      .query("messageParts")
      .paginate({ cursor: cursor ?? null, numItems: PAGE });

    let inserted = 0;
    for (const pd of page.page) {
      if (!isFilePart(pd.part)) continue;
      const part = pd.part;
      const existing = await ctx.db
        .query("files")
        .withIndex("by_message", (q) => q.eq("messageId", pd.messageId))
        .collect();
      if (existing.some((f) => f.storageId === part.storageId)) continue; // dedup
      const message = await ctx.db.get(pd.messageId);
      if (message === null) continue; // orphan part
      const chat = await ctx.db.get(message.chatId);
      await recordFileForPart(ctx, {
        messageId: pd.messageId,
        chatId: message.chatId,
        userId: message.userId,
        direction: message.role === "user" ? "inbound" : "outbound",
        instanceName: chat?.instanceName,
        part,
        createdAt: message._creationTime,
      });
      inserted++;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.files.backfillFiles, {
        cursor: page.continueCursor,
      });
    }
    return { inserted, isDone: page.isDone };
  },
});
