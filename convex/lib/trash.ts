// THE CONVERSATION TRASH — the rules every surface shares (convex/trash.ts holds
// the mutations, lib/chatAccess the access consequence).
//
// A deleted conversation is set aside rather than removed: `trashedAt` hides it
// everywhere at once (every access check reads it), and `purgeAfter` is when the
// daily purge removes it and everything it holds for good. Until then its owner —
// or an admin — may restore it as it was.

import type { Doc } from "../_generated/dataModel";

/** How long a trashed conversation stays restorable, when nothing overrides it. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The retention horizon in days: `CHAT_TRASH_RETENTION_DAYS` when it is a positive
 * number, the default otherwise (same contract as TRACE_RETENTION_DAYS). A value
 * that does not parse falls back rather than purging early.
 */
export function trashRetentionDays(
  raw: string | undefined = process.env.CHAT_TRASH_RETENTION_DAYS,
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRASH_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TRASH_RETENTION_DAYS;
}

/** When a conversation trashed at `trashedAt` is purged. */
export function purgeDateFor(trashedAt: number, days: number = trashRetentionDays()): number {
  return trashedAt + days * DAY_MS;
}

/** Is this conversation in the trash? One spelling for every reader. */
export function isTrashed(chat: Pick<Doc<"chats">, "trashedAt">): boolean {
  return chat.trashedAt !== undefined;
}
