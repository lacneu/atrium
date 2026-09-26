// WHO SPOKE, in a rebuilt history — the group conversation's authors.
//
// A message's `userId` is always the chat OWNER (access checks read it); the
// person who actually wrote a user turn is `authorUserId`, absent = the owner.
// The history a fresh gateway session is re-grounded from (rehydration) and the
// transcript the summarizer condenses both used to label every user turn with
// the same generic "User": after a reset, compaction or agent switch, the agent
// could no longer tell who asked what in a room of several people.
//
// ONLY for a group conversation — a chat with participants, or whose window
// holds a turn written by someone other than the owner. A solo chat gets no
// labels at all, so its rebuilt history stays byte-identical to what it was.
//
// The label is DATA that lands inside a prompt, chosen by the person it names:
// it is bounded, single-line, stripped of the characters that frame the history
// block (brackets, parentheses, colons), and never a full email address.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { writtenAtOf } from "./chatAccess";

/** Longest author label rendered into a history line. */
export const MAX_AUTHOR_LABEL_CHARS = 64;

/**
 * A display name made safe to embed in a history line: one line, no framing
 * characters, no email domain, bounded. Null when nothing usable is left.
 */
export function safeAuthorLabel(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  // Never a full email: whatever follows an `@` is dropped.
  const at = raw.indexOf("@");
  const local = at >= 0 ? raw.slice(0, at) : raw;
  const cleaned = local
    // Control characters (newlines included) and the characters that frame
    // the history block or a label within it.
    .replace(/[\u0000-\u001f\u007f-\u009f[\]{}()<>:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_AUTHOR_LABEL_CHARS
    ? `${cleaned.slice(0, MAX_AUTHOR_LABEL_CHARS - 1).trimEnd()}…`
    : cleaned;
}

/** The label a profile is named by: its name, else its email's local part. */
function profileLabel(profile: Doc<"profiles"> | null): string | null {
  if (profile === null) return null;
  return (
    safeAuthorLabel(profile.name) ??
    safeAuthorLabel(profile.email) ??
    safeAuthorLabel(profile.canonical)
  );
}

/** The author of a user turn: `authorUserId`, absent = the chat's owner. */
export function turnAuthorId(
  chat: Pick<Doc<"chats">, "userId">,
  m: Pick<Doc<"messages">, "authorUserId">,
): Id<"users"> {
  return m.authorUserId ?? chat.userId;
}

/**
 * Author labels for the USER turns of `messages`, keyed by message id — or null
 * for a solo conversation (render as before, no label). One profile read per
 * DISTINCT author in the window, never per message.
 */
export async function userTurnAuthorLabels(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  messages: ReadonlyArray<Doc<"messages">>,
): Promise<Map<string, string> | null> {
  const userTurns = messages.filter((m) => m.role === "user");
  const isGroup =
    userTurns.some((m) => turnAuthorId(chat, m) !== chat.userId) ||
    (await ctx.db
      .query("chatParticipants")
      .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
      .first()) !== null;
  if (!isGroup) return null;
  const byAuthor = new Map<string, { label: string | null; since: number } | null>();
  const labels = new Map<string, string>();
  for (const m of userTurns) {
    const author = turnAuthorId(chat, m);
    if (!byAuthor.has(author)) {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", author))
        .unique();
      byAuthor.set(
        author,
        profile === null ? null : { label: profileLabel(profile), since: profile._creationTime },
      );
    }
    // The name of the account that WROTE the turn: one older than its author's
    // current profile was written by a deleted account whose users row was
    // provisioned again, and is left unlabelled like any author without a profile
    // — never put in the successor's mouth (the seat rule, lib/chatAccess).
    const who = byAuthor.get(author);
    if (who && who.label && writtenAtOf(m) >= who.since) labels.set(m._id, who.label);
  }
  return labels;
}
