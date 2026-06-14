// Paired write helpers for the owner-scoped `files` denormalization table.
//
// INVARIANT (the whole point of the table): a `files` row exists IFF a file/media
// `messagePart` exists for that message. To hold it, EVERY site that inserts a
// file/media part calls `recordFileForPart`, and EVERY site that removes a
// message's parts calls `deleteFilesByMessage`. Routing both sides through these
// two functions is what stops the two tables from drifting (duplicate rows on a
// re-insert, orphan rows on a delete/regenerate).

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// The two `messagePart` variants that carry a stored blob (mirror schema.ts
// `messagePart`). `tool` / `reasoning` parts are NOT files and are ignored.
export type FileLikePart =
  | { kind: "media"; storageId: Id<"_storage">; filename: string; mimeType: string }
  | { kind: "file"; storageId: Id<"_storage">; filename: string; mimeType: string };

/** Narrow a raw part to a file/media part (the ones that get a `files` row). */
export function isFilePart(part: { kind: string }): part is FileLikePart {
  return part.kind === "media" || part.kind === "file";
}

// A coarse mimeType bucket for the Fichiers tab filter. Shared so the producers
// can DENORMALIZE it onto each `files` row (→ server-side category filtering) and
// the query/UI can fall back to it for legacy rows that predate the column.
export type FileCategory =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "document"
  | "archive"
  | "other";

export function mimeCategory(mime: string): FileCategory {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf") return "pdf";
  if (
    m.includes("word") ||
    m.includes("excel") ||
    m.includes("sheet") ||
    m.includes("presentation") ||
    m.includes("powerpoint") ||
    m.includes("csv") ||
    m.startsWith("text/")
  )
    return "document";
  if (
    m.includes("zip") ||
    m.includes("tar") ||
    m.includes("rar") ||
    m.includes("7z") ||
    m.includes("compressed") ||
    m.includes("gzip")
  )
    return "archive";
  return "other";
}

/**
 * Insert the `files` row paired with a just-inserted file/media `messagePart`.
 * `direction` is the message role mapped to inbound (user upload) / outbound
 * (agent output); `instanceName` is the chat's bound bridge SNAPSHOT at creation
 * (frozen — see schema). Call this RIGHT AFTER inserting the part.
 */
export async function recordFileForPart(
  ctx: MutationCtx,
  args: {
    messageId: Id<"messages">;
    chatId: Id<"chats">;
    userId: Id<"users">;
    direction: "inbound" | "outbound";
    instanceName?: string;
    part: FileLikePart;
    createdAt: number;
  },
): Promise<void> {
  await ctx.db.insert("files", {
    userId: args.userId,
    chatId: args.chatId,
    messageId: args.messageId,
    storageId: args.part.storageId,
    filename: args.part.filename,
    mimeType: args.part.mimeType,
    kind: args.part.kind,
    direction: args.direction,
    instanceName: args.instanceName,
    category: mimeCategory(args.part.mimeType),
    createdAt: args.createdAt,
  });
}

/**
 * Remove every `files` row for a message — the delete-side of the invariant.
 * Call this wherever a message's `messageParts` are deleted (chat cascade,
 * deleteMessage truncate-forward / regenerate), paired with the part deletion.
 */
export async function deleteFilesByMessage(
  ctx: MutationCtx,
  messageId: Id<"messages">,
): Promise<void> {
  const rows = await ctx.db
    .query("files")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}
