// Reading a conversation, or a folder of them, out of Atrium, as an archive.
//
// The archive is assembled by the CALLER, not here: a folder of image
// attachments is far larger than any single Convex read, so this module hands
// out bounded pages and the caller — which is writing the file anyway — drives
// the loop. Every call is bounded and carries its own cursor; none of them
// depends on state kept between calls.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireActive, requireOwnedChat } from "./lib/access";
import { compareOrder, effectiveOrder } from "./lib/messageOrder";
import {
  pickReconciledIdentity,
  readDeploymentOrigin,
} from "./lib/deploymentIdentity";
import {
  ARCHIVE_FORMAT_VERSION,
  CHAT_FIELDS_DROPPED,
  CHAT_SECTIONS,
  IMPORT_TRANSFORMS,
  EXPORT_PAGE_SIZE,
  FOLDER_PAGE_SIZE,
  MAX_FOLDER_DEPTH,
  MAX_FOLDERS,
  MESSAGE_FIELDS_DROPPED,
  OPAQUE_PART_KEYS,
  SUBAGENT_FIELDS_DROPPED,
  NOT_EXPORTED,
  stripChatForExport,
  stripRowForExport,
} from "./lib/exportArchive";

/** Messages read per page while walking their parts. */
const PARTS_MESSAGE_BATCH = 25;
/** Identity rows read; mirrors the identity module's own bound. */
const MERGED_ROW_SCAN = 16;
/** `files` rows examined when resolving one storage pointer to an archive key.
 *  One per conversation that shares those bytes — forks, in practice. */
const BLOB_OWNER_SCAN = 32;

/**
 * Where a two-level walk resumes: which message, and how far into its own rows.
 *
 * BOTH levels advance on creation time rather than on a paginated cursor. Convex
 * allows exactly ONE paginated query per function call, and walking messages and
 * their parts is two — the composite cursor that replaced a silent truncation
 * failed outright at runtime, which no test could see because the harness does
 * not enforce that limit. Every index carries `_creationTime`, so a bound on it
 * is a cursor that costs nothing and cannot collide with the rule.
 */
interface PartsCursor {
  /** Creation time of the message being walked, or of the last one finished. */
  at: number | null;
  /** Creation time of the last child row emitted for that message. */
  childAt: number | null;
}

function parsePartsCursor(raw: string | null): PartsCursor {
  if (raw === null) return { at: null, childAt: null };
  try {
    const parsed = JSON.parse(raw) as Partial<PartsCursor>;
    return {
      at: typeof parsed.at === "number" ? parsed.at : null,
      childAt: typeof parsed.childAt === "number" ? parsed.childAt : null,
    };
  } catch {
    // A cursor we cannot read restarts the section rather than skipping rows: a
    // silently shortened export is worse than a repeated page.
    return { at: null, childAt: null };
  }
}

const encodePartsCursor = (cursor: PartsCursor): string => JSON.stringify(cursor);

/**
 * One message part, with every storage pointer removed at any depth and replaced
 * by the archive key of the file that holds those bytes.
 *
 * A part carries its attachment's pointer nested inside free-form JSON, so a
 * strip that only looked at top-level keys let it travel — the very pointer the
 * `files` section was carefully removing.
 */
async function exportPart(
  ctx: { db: { query: (t: "files") => any } },
  chatId: Id<"chats">,
  part: Doc<"messageParts">,
): Promise<Record<string, unknown>> {
  const pointers: string[] = [];
  const row = stripRowForExport(part, {
    collect: (pointer) => pointers.push(pointer),
    opaque: OPAQUE_PART_KEYS,
  });
  const keys: string[] = [];
  let unresolved = 0;
  for (const pointer of pointers) {
    // SCOPED TO THIS CHAT. A forked conversation has its own `files` row over the
    // same bytes, so taking the first row that matches the pointer would name a
    // row belonging to the SOURCE chat — an archive key the exported `files`
    // section never publishes, and the attachment would be lost with no sign of
    // it. A soft-deleted row is skipped for the same reason: the export omits it.
    const candidates = await ctx.db
      .query("files")
      .withIndex("by_storage", (q: any) => q.eq("storageId", pointer))
      .take(BLOB_OWNER_SCAN);
    const owned = candidates.find(
      (file: Doc<"files">) =>
        file.chatId === chatId &&
        (file.deletedAt === undefined || file.deletedAt === null),
    );
    if (owned === undefined) unresolved += 1;
    else keys.push(owned._id);
  }
  if (keys.length > 0) row.archiveBlobKeys = keys;
  // Bytes this part points at that the archive does NOT carry. Counted rather
  // than hidden: a reader must be able to tell a part with no attachment from one
  // whose attachment was lost.
  if (unresolved > 0) row.unresolvedBlobs = unresolved;
  return row;
}

const sectionValidator = v.union(
  ...CHAT_SECTIONS.map((name) => v.literal(name)),
);

/**
 * The folders under one folder, itself included.
 *
 * Walked DOWNWARDS with the visited set carried along: `projects.parentId` is a
 * plain reference and nothing in the schema forbids a cycle, so a walk that
 * trusted it would not terminate. Depth is bounded too, and a subtree that
 * exceeds either bound is REPORTED — an export that silently left folders out
 * would look complete to whoever opens it.
 */
export const exportFolderTree = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const { userId } = await requireActive(ctx);
    const root = await ctx.db.get(projectId);
    if (root === null || root.userId !== userId) {
      throw new Error("Not found: folder does not exist");
    }

    const folders: Doc<"projects">[] = [root];
    const seen = new Set<string>([root._id]);
    let frontier: Id<"projects">[] = [root._id];
    let depth = 0;
    let complete = true;

    while (frontier.length > 0) {
      if (depth >= MAX_FOLDER_DEPTH || folders.length >= MAX_FOLDERS) {
        // The per-parent bound does not bound the WALK: a tree where every folder
        // has ninety-nine children stays under it at each step while reading tens
        // of thousands of rows in one transaction, which fails as a limit error
        // rather than as an answer.
        complete = false;
        break;
      }
      const next: Id<"projects">[] = [];
      let exhausted = false;
      for (const parentId of frontier) {
        // Breaking only the CHILD loop left the walk reading a page for every
        // remaining parent of this level before noticing the budget again —
        // thousands of rows in one transaction, which fails as a limit error
        // rather than as an answer.
        if (exhausted) break;
        const children = await ctx.db
          .query("projects")
          .withIndex("by_parent", (q) => q.eq("parentId", parentId))
          .take(FOLDER_PAGE_SIZE + 1);
        if (children.length > FOLDER_PAGE_SIZE) complete = false;
        for (const child of children.slice(0, FOLDER_PAGE_SIZE)) {
          // A folder belonging to someone else cannot be reached through an owned
          // parent in normal use; refusing to follow it costs nothing and means a
          // stray row can never widen an export.
          if (child.userId !== userId) continue;
          if (seen.has(child._id)) continue;
          if (folders.length >= MAX_FOLDERS) {
            complete = false;
            exhausted = true;
            break;
          }
          seen.add(child._id);
          folders.push(child);
          next.push(child._id);
        }
      }
      frontier = next;
      depth += 1;
    }

    return {
      folders: folders.map((folder) => stripRowForExport(folder)),
      /** False when a bound was hit: the caller must refuse rather than ship a
       *  subtree that is missing folders without saying so. */
      complete,
    };
  },
});

/** The chats directly in one folder. Bounded, resumable. */
export const exportFolderChats = query({
  args: {
    projectId: v.id("projects"),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { projectId, cursor }) => {
    const { userId } = await requireActive(ctx);
    const folder = await ctx.db.get(projectId);
    if (folder === null || folder.userId !== userId) {
      throw new Error("Not found: folder does not exist");
    }
    const page = await ctx.db
      .query("chats")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .paginate({ numItems: EXPORT_PAGE_SIZE, cursor: cursor ?? null });
    return {
      chatIds: page.page
        .filter((chat) => chat.userId === userId)
        .map((chat) => chat._id),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * One conversation's own row, stripped of everything that must not travel.
 *
 * The session fields are the ones worth naming: a restored chat carrying
 * `recoverableSession` would have the bridge present, to a gateway on a
 * same-named instance, a session key that gateway never issued. "primary" is the
 * default instance name everywhere, so that collision is likely rather than
 * exotic.
 */
export const exportChat = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    return stripChatForExport(chat);
  },
});

/** One bounded page of one section of one conversation. */
export const exportChatSection = query({
  args: {
    chatId: v.id("chats"),
    section: sectionValidator,
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { chatId, section, cursor }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);

    const at = cursor ?? null;
    const page = { numItems: EXPORT_PAGE_SIZE, cursor: at };

    if (section === "messages") {
      const result = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .paginate(page);
      return {
        // LOGICAL order, not creation order. `_creationTime` misplaces a mid-turn
        // queued follow-up, and the import re-bases on the order it receives — so
        // emitting creation order would bake that misordering into the archive.
        // The order the SOURCE displays, carried explicitly. Sorting the page
        // alone could not fix an order that crosses a page boundary — a queued
        // follow-up ending one page and the reply created after it beginning the
        // next — and re-basing on the arrival order would then bake that
        // inversion in for ever. `effectiveOrder` is the value the source itself
        // sorts by, so carrying it needs no page to be complete.
        rows: [...result.page].sort(compareOrder).map(
          (row): Record<string, unknown> => ({
            ...stripRowForExport(row, { drop: MESSAGE_FIELDS_DROPPED }),
            archiveOrder: effectiveOrder(row),
          }),
        ),
        blobs: [],
        cursor: result.isDone ? null : result.continueCursor,
      };
    }

    if (section === "messageParts") {
      // Parts hang off messages, not off the chat, so this walks two levels —
      // and Convex allows only ONE paginated query per call. Both levels advance
      // on creation time instead: every index carries it, so it is a cursor that
      // costs nothing and cannot run into that rule.
      const state = parsePartsCursor(at);
      const rows: Record<string, unknown>[] = [];
      let messageAt = state.at;
      let childAt = state.childAt;
      // PARENTS ARE BOUNDED TOO. Returning only once enough CHILD rows had been
      // gathered meant a long conversation whose messages carry few parts walked
      // every one of them in a single call — two reads each, past Convex's limit
      // on how many a function may make. A page that found nothing still ends.
      let visited = 0;

      while (rows.length < EXPORT_PAGE_SIZE && visited < PARTS_MESSAGE_BATCH) {
        const [message] = await ctx.db
          .query("messages")
          .withIndex("by_chat", (q) =>
            childAt === null
              ? q.eq("chatId", chatId).gt("_creationTime", messageAt ?? -1)
              : q.eq("chatId", chatId).gte("_creationTime", messageAt ?? -1),
          )
          .take(1);
        if (message === undefined) {
          return { rows, blobs: [], cursor: null };
        }
        visited += 1;
        // ONLY WHAT IS LEFT OF THE PAGE. Reading a whole page per message meant
        // a page that already held 199 rows could come back with 399 — and the
        // page is handed to the import unchanged, which refuses more than it
        // reads. The export would have produced archives its own import rejects.
        const remaining = EXPORT_PAGE_SIZE - rows.length;
        const parts = await ctx.db
          .query("messageParts")
          // THE BOUND IS IN THE INDEX, not a filter. A filter runs after the scan,
          // so every resume re-read all the parts already exported before
          // discarding them — a later page could exceed the read limits while
          // returning a normal number of rows. Every index carries `_creationTime`.
          .withIndex("by_message", (q) =>
            q.eq("messageId", message._id).gt("_creationTime", childAt ?? -1),
          )
          .take(remaining);
        for (const part of parts) {
          rows.push(await exportPart(ctx, chatId, part));
        }
        if (parts.length === remaining) {
          // This message may have more; resume ON it rather than moving past.
          messageAt = message._creationTime;
          childAt = parts[parts.length - 1]!._creationTime;
          continue;
        }
        messageAt = message._creationTime;
        childAt = null;
      }
      return {
        rows,
        blobs: [],
        cursor: encodePartsCursor({ at: messageAt, childAt }),
      };
    }

    if (section === "files") {
      const result = await ctx.db
        .query("files")
        .withIndex("by_user_chat", (q) =>
          q.eq("userId", userId).eq("chatId", chatId),
        )
        .paginate(page);
      const rows: Record<string, unknown>[] = [];
      const blobs: {
        key: string;
        url: string | null;
        filename: string;
        mimeType: string;
      }[] = [];
      for (const file of result.page) {
        if (file.deletedAt !== undefined && file.deletedAt !== null) continue;
        const { storageId } = file;
        // THE STORAGE ID DOES NOT TRAVEL. It points into THIS deployment's
        // storage, and an import that trusted one from a file would be reading
        // whatever it named here. The archive references bytes by a key of its
        // own, which an import can only resolve to bytes it re-uploaded itself.
        // The pointer is removed by the strip itself, at any depth; the row names
        // the bytes only by a key of the archive's own.
        rows.push({ ...stripRowForExport(file), archiveBlobKey: file._id });
        blobs.push({
          key: file._id,
          url: await ctx.storage.getUrl(storageId),
          filename: file.filename,
          mimeType: file.mimeType,
        });
      }
      return {
        rows,
        blobs,
        cursor: result.isDone ? null : result.continueCursor,
      };
    }

    if (section === "documentDrafts") {
      const result = await ctx.db
        .query("documentDrafts")
        .withIndex("by_user_chat_filename", (q) =>
          q.eq("userId", userId).eq("chatId", chatId),
        )
        .paginate(page);
      return {
        rows: result.page.map((row) => stripRowForExport(row)),
        blobs: [],
        cursor: result.isDone ? null : result.continueCursor,
      };
    }

    if (section === "chatBookmarks") {
      const result = await ctx.db
        .query("chatBookmarks")
        .withIndex("by_user_chat", (q) =>
          q.eq("userId", userId).eq("chatId", chatId),
        )
        .paginate(page);
      return {
        rows: result.page.map((row) => stripRowForExport(row)),
        blobs: [],
        cursor: result.isDone ? null : result.continueCursor,
      };
    }

    if (section === "documentAttachments") {
      // Kept by SOURCE MESSAGE, not by chat: a message that used "attach the
      // documents" stores its ready file here rather than in the chat's own
      // `files`. Same two-level walk as the parts above, and the same reason for
      // avoiding a paginated cursor on either level.
      const state = parsePartsCursor(at);
      const rows: Record<string, unknown>[] = [];
      const blobs: {
        key: string;
        url: string | null;
        filename: string;
        mimeType: string;
      }[] = [];
      let messageAt = state.at;
      let childAt = state.childAt;
      let visited = 0;

      while (rows.length < EXPORT_PAGE_SIZE && visited < PARTS_MESSAGE_BATCH) {
        const [message] = await ctx.db
          .query("messages")
          .withIndex("by_chat", (q) =>
            childAt === null
              ? q.eq("chatId", chatId).gt("_creationTime", messageAt ?? -1)
              : q.eq("chatId", chatId).gte("_creationTime", messageAt ?? -1),
          )
          .take(1);
        if (message === undefined) return { rows, blobs, cursor: null };
        visited += 1;
        // Only what is left of the page — see the parts walk above.
        const remaining = EXPORT_PAGE_SIZE - rows.length;
        const attachments = await ctx.db
          .query("documentAttachments")
          .withIndex("by_source_message", (q) =>
            q
              .eq("sourceMessageId", message._id)
              .gt("_creationTime", childAt ?? -1),
          )
          .take(remaining);
        for (const attachment of attachments) {
          const { storageId } = attachment;
          const hasBytes = storageId !== undefined && storageId !== null;
          rows.push({
            ...stripRowForExport(attachment),
            // ONLY when there are bytes to point at. A pending or failed
            // attachment has none, and publishing a key with no entry behind it
            // is indistinguishable from a blob that went missing.
            ...(hasBytes ? { archiveBlobKey: attachment._id } : {}),
          });
          if (hasBytes) {
            blobs.push({
              key: attachment._id,
              url: await ctx.storage.getUrl(storageId),
              filename: attachment.filename ?? "document",
              mimeType: attachment.mimeType ?? "application/octet-stream",
            });
          }
        }
        if (attachments.length === remaining) {
          messageAt = message._creationTime;
          childAt = attachments[attachments.length - 1]!._creationTime;
          continue;
        }
        messageAt = message._creationTime;
        childAt = null;
      }
      return {
        rows,
        blobs,
        cursor: encodePartsCursor({ at: messageAt, childAt }),
      };
    }

    // The remaining sections are all keyed by chat through a `by_chat` index.
    const result = await ctx.db
      .query(section)
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .paginate(page);
    return {
      rows: result.page.map((row) =>
        stripRowForExport(row, { drop: SUBAGENT_FIELDS_DROPPED }),
      ),
      blobs: [],
      cursor: result.isDone ? null : result.continueCursor,
    };
  },
});

/** The parts of the manifest that are a pure read. Split out so the public entry
 *  can AUTHENTICATE before anything is minted. */
export const manifestBase = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireActive(ctx);
    return {
      formatVersion: ARCHIVE_FORMAT_VERSION,
      sections: [...CHAT_SECTIONS],
      notIncluded: NOT_EXPORTED.map((entry) => ({ ...entry })),
      // Omissions alone made the manifest misleading: a reader who trusted it
      // believed they were reading the original.
      transforms: IMPORT_TRANSFORMS.map((entry) => ({ ...entry })),
      chatFieldsDropped: [...CHAT_FIELDS_DROPPED],
    };
  },
});

/**
 * What the archive says about itself.
 *
 * The omissions are stated, not left to be inferred: whoever opens this months
 * later cannot otherwise tell a conversation that carried no attachments from one
 * whose attachments were dropped.
 *
 * An ACTION, because it also MINTS the deployment's identity if there is not one
 * yet. Reading the table and hoping something else had filled it left every
 * archive stamped with no origin — and an archive with no origin is foreign
 * everywhere, including back here, so nothing would ever have reattached. The
 * caller is authenticated first, so an unauthenticated request cannot cause a
 * write.
 */
export const exportManifest = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    formatVersion: number;
    origin: string | null;
    sections: string[];
    notIncluded: { what: string; why: string }[];
    transforms: { what: string; why: string }[];
    chatFieldsDropped: string[];
  }> => {
    const base = await ctx.runQuery(internal.archiveExport.manifestBase, {});
    // Reconciled by construction: this is the same path that decides whether a
    // stored identity still speaks for the deployment running now, and it answers
    // null where nothing does.
    const origin = await ctx.runAction(
      internal.deploymentIdentity.ensureDeploymentId,
      {},
    );
    return { ...base, origin };
  },
});
