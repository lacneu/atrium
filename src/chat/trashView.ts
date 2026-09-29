// THE CONVERSATION TRASH — what the delete confirmations and the trash views say.
//
// Deleting a conversation (or a folder, whose conversations follow) moves it to the
// trash for the deployment's retention period (convex/lib/trash.ts); the copy must
// say so and name the period the server actually applies, which is why it is read
// from `trash.retention` rather than written into the text.

import { useQuery } from "convex/react";
import { api } from "./convexApi";
import { getLocale } from "@/paraglide/runtime.js";
import { m } from "@/paraglide/messages.js";

/** The server's default, shown until `trash.retention` has answered. */
export const FALLBACK_TRASH_RETENTION_DAYS = 30;

/** How many days a deleted conversation stays in the trash. */
export function useTrashRetentionDays(): number {
  return useQuery(api.trash.retention, {})?.days ?? FALLBACK_TRASH_RETENTION_DAYS;
}

/** The folder-deletion confirmation: the folders go, their conversations go to
 *  the trash. An empty folder has nothing to restore — its deletion is final. */
export function folderDeleteDescription({
  folders,
  chats,
  days,
}: {
  folders: number;
  chats: number;
  days: number;
}): string {
  if (folders > 0) return m.sidebar_delete_project_confirm_desc_tree({ folders, chats, days });
  if (chats > 0) return m.sidebar_delete_project_confirm_desc({ count: chats, days });
  return m.sidebar_action_irreversible();
}

/** A day as "JJ/MM" in the reader's locale order (the purge date of an item). */
export function formatTrashDay(ms: number, locale: string = getLocale()): string {
  return new Date(ms).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

