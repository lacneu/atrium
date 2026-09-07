// WHO may reach a chat — ONE definition.
//
// Before group chats there was exactly one rule, written out at 48 call sites:
// `chat.userId !== userId → forbidden`. Adding a second way to reach a chat by
// editing 48 copies is how a cross-user leak gets introduced, so the second way
// exists HERE and nowhere else, and the call sites that gained it call this.
//
// TWO ROLES, deliberately unequal:
//   - `owner`  — `chats.userId`. Administers the chat: rename, delete, rebind the
//     agent, reset the session, export, bookmark, summarize, manage the roster.
//   - `participant` — a row in `chatParticipants`. CONVERSES: reads the chat, sees
//     it stream, posts to it, and leaves it. Nothing else.
//
// That split is not a shortcut. Every administrative surface stays owner-only on
// purpose: those act on the chat's binding to a gateway session, and a chat has
// one gateway session with one owner (OpenClaw 2026.9.2 has no multi-human
// session). Letting a participant rebind or reset would hand them a control the
// gateway attributes to somebody else.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type ChatRole = "owner" | "participant";

export interface ChatAccess {
  chat: Doc<"chats">;
  role: ChatRole;
}

/**
 * A person is in at most this many group chats for sidebar and access purposes.
 * A BOUND, not a product limit: an unbounded `.collect()` over a person's
 * participations is the read that grows forever and eventually exceeds Convex's
 * per-function budget. Beyond it, a chat is still reachable by URL — the roster
 * read below is per-chat and never truncated.
 */
export const MAX_PARTICIPATIONS_SCANNED = 200;

/** Roster size for one chat. Bounds the read AND states the product limit. */
export const MAX_CHAT_PARTICIPANTS = 32;

/**
 * Resolve how `userId` may reach `chatId`, or null when they may not.
 *
 * Returns null — never throws — for a deleted chat, so callers can render "not
 * found" rather than a permission error for a chat that no longer exists.
 */
export async function resolveChatAccess(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
): Promise<ChatAccess | null> {
  const chat = await ctx.db.get(chatId);
  if (chat === null) return null;
  if (chat.userId === userId) return { chat, role: "owner" };
  const membership = await ctx.db
    .query("chatParticipants")
    .withIndex("by_chat_user", (q) => q.eq("chatId", chatId).eq("userId", userId))
    .unique();
  return membership === null ? null : { chat, role: "participant" };
}

/**
 * The chats `userId` takes part in without owning. Bounded; the caller unions
 * these with their own chats.
 */
export async function participantChatIds(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  /** Drop the ones this person took off their own sidebar. The chat's own
   *  `sidebarHidden` is the OWNER's preference and must not travel. */
  opts?: { forSidebar?: boolean },
): Promise<Id<"chats">[]> {
  const rows = await ctx.db
    .query("chatParticipants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_PARTICIPATIONS_SCANNED);
  return rows
    .filter((r) => !(opts?.forSidebar === true && r.sidebarHidden === true))
    .map((r) => r.chatId);
}

/** The roster of one chat, oldest first. Bounded by the product limit. */
export async function chatParticipantRows(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
): Promise<Doc<"chatParticipants">[]> {
  return await ctx.db
    .query("chatParticipants")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .take(MAX_CHAT_PARTICIPANTS + 1);
}

/**
 * Boolean form of `resolveChatAccess`, for the many render-path queries whose
 * existing guard is an inline `chat.userId !== userId` and which only need a
 * yes/no. Keeps those call sites reading the SAME definition as everything else.
 */
export async function canReachChat(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
): Promise<boolean> {
  return (await resolveChatAccess(ctx, chatId, userId)) !== null;
}
