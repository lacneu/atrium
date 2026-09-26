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

/** A participant's standing in the room (absent on a row = "member"). */
export type MemberRole = "viewer" | "member" | "manager";
/** Everyone's standing, the owner included — what the UI and the gates read. */
export type RoomRole = "owner" | MemberRole;

export interface ChatAccess {
  chat: Doc<"chats">;
  role: ChatRole;
  /** "owner" for the owner; the participant's own role otherwise. */
  roomRole: RoomRole;
}

/**
 * A SEAT BELONGS TO ITS HOLDER'S CURRENT ACCOUNT ONLY. Deleting a person drops
 * their profile at once but their seats in batches afterwards
 * (admin.sweepDeletedUserRoomState); the same person provisioned again meanwhile
 * gets a NEW profile under the same users doc, and must not walk back into the
 * rooms of the account that was deleted. A seat is only ever created for someone
 * who already has a profile (chatParticipants.addMember refuses anyone without an
 * approved one), and a profile document is only ever removed by that deletion —
 * so a seat OLDER than its holder's current profile can only be a leftover of a
 * deleted account. No profile: no seat. The rule is on the profile document, not
 * on its role, so it holds however the new profile became active (approval, an
 * allowed email domain).
 */
export function seatIsCurrent(
  seat: Pick<Doc<"chatParticipants">, "_creationTime">,
  holder: Pick<Doc<"profiles">, "_creationTime"> | null,
): boolean {
  return holder !== null && seat._creationTime >= holder._creationTime;
}

/** A person's CURRENT seats (seatIsCurrent), bounded like every participation
 *  scan: one profile read, and the leftovers are outside the index range — they
 *  never use up the bound. */
export async function currentParticipations(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"chatParticipants">[]> {
  const holder = await holderProfile(ctx, userId);
  if (holder === null) return [];
  return await ctx.db
    .query("chatParticipants")
    .withIndex("by_user", (q) =>
      q.eq("userId", userId).gte("_creationTime", holder._creationTime),
    )
    .take(MAX_PARTICIPATIONS_SCANNED);
}

async function holderProfile(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"profiles"> | null> {
  return await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/**
 * Were an outbox row's words written by the author's CURRENT account — the same
 * generational rule as a seat (lib/chatAccess.seatIsCurrent): nothing older than
 * the author's current profile is theirs. Judged on the ORIGINATING user message
 * (`messageId`), which a queued send, an auto-retry and a regenerate all point
 * at — a retry row is created later than the words it replays — and on the row
 * itself when it names none. A row gone is judged by its callers.
 */
/** When a message's words were written: its own creation, or — on a copy — the
 *  original's (`writtenAt`, chatFork). What every generational check judges. */
export function writtenAtOf(m: Pick<Doc<"messages">, "_creationTime" | "writtenAt">): number {
  return m.writtenAt ?? m._creationTime;
}

export async function writtenByCurrentAccount(
  ctx: QueryCtx | MutationCtx,
  outboxId: Id<"outbox">,
  profileCreatedAt: number,
): Promise<boolean> {
  const row = await ctx.db.get(outboxId);
  if (row === null) return true;
  let writtenAt = row._creationTime;
  if (row.messageId !== undefined) {
    const message = await ctx.db.get(row.messageId);
    if (message !== null) writtenAt = Math.min(writtenAt, writtenAtOf(message));
  }
  return writtenAt >= profileCreatedAt;
}

/** The room role a membership row grants. */
export function memberRoleOf(row: Pick<Doc<"chatParticipants">, "role">): MemberRole {
  return row.role ?? "member";
}

/** May this person invite people and add agents: the owner, or a manager. */
export function canManageRoom(access: ChatAccess): boolean {
  return access.roomRole === "owner" || access.roomRole === "manager";
}

/** May this person post into the conversation: anyone but a viewer. */
export function canPost(access: ChatAccess): boolean {
  return access.roomRole !== "viewer";
}

/**
 * A person is in at most this many group chats for sidebar and access purposes.
 * A BOUND, not a product limit: an unbounded `.collect()` over a person's
 * participations is the read that grows forever and eventually exceeds Convex's
 * per-function budget. Beyond it, a chat is still reachable by URL — the roster
 * read below is per-chat and never truncated.
 */
export const MAX_PARTICIPATIONS_SCANNED = 200;

/**
 * How many distinct OWNERS the sidebar judges guest rows for (each is a full
 * enrichment of that owner's grants). Participations are bounded in rows, not in
 * owners, and 200 rows from 200 owners would exceed the query's read budget.
 */
export const MAX_GUEST_OWNERS_JUDGED = 12;

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
  if (chat.userId === userId) return { chat, role: "owner", roomRole: "owner" };
  const membership = await ctx.db
    .query("chatParticipants")
    .withIndex("by_chat_user", (q) => q.eq("chatId", chatId).eq("userId", userId))
    .unique();
  if (membership === null) return null;
  if (!seatIsCurrent(membership, await holderProfile(ctx, userId))) return null;
  // Everything a participant DOES here goes out on the owner's delegation (their
  // grants, their gateway session). An owner whose account is no longer active
  // (back to pending, or no profile at all) delegates nothing: the room is kept
  // readable, and every seat acts as a viewer until the owner is active again.
  if (!(await ownerIsActive(ctx, chat.userId))) {
    return { chat, role: "participant", roomRole: "viewer" };
  }
  return { chat, role: "participant", roomRole: memberRoleOf(membership) };
}

/**
 * Whether the owner's account may still delegate. Read here, not through
 * `access.getProfile`, because `access` imports this module. Exported so a
 * surface judging many seats of one room (a notification fan-out, a badge, the
 * sidebar) applies THIS rule once per room instead of re-deriving it per row.
 */
export async function ownerIsActive(
  ctx: QueryCtx | MutationCtx,
  ownerId: Id<"users">,
): Promise<boolean> {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", ownerId))
    .unique();
  return profileIsActive(profile);
}

/** The same rule on a profile the caller already holds (null = no profile). */
export function profileIsActive(profile: Pick<Doc<"profiles">, "role"> | null): boolean {
  return profile?.role !== undefined && profile.role !== "pending";
}

/**
 * Raw seats read per room. Wider than the product limit on purpose: the rows also
 * hold leftovers of deleted accounts until their sweep, and a window of exactly
 * the limit could then cut off CURRENT seats — hidden from the roster, uncounted
 * against the limit. Leftovers stay few: each deletion's sweep is scheduled at
 * once, and every invitation settles the room first (settleRoster).
 */
export const ROSTER_READ_WINDOW = (MAX_CHAT_PARTICIPANTS + 1) * 4;

async function rosterWindow(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
): Promise<Doc<"chatParticipants">[]> {
  return await ctx.db
    .query("chatParticipants")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .take(ROSTER_READ_WINDOW);
}

/** The roster of one chat, oldest first, CURRENT seats only (seatIsCurrent) — a
 *  deleted account's leftovers are neither listed, nor counted, nor rung, nor
 *  mentionable. Every current seat in the window, even past the product limit (a
 *  room already above it must not hide anyone who can read it). One profile read
 *  per seat, inherent to judging a roster of different people. */
export async function chatParticipantRows(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
): Promise<Doc<"chatParticipants">[]> {
  const current: Doc<"chatParticipants">[] = [];
  for (const row of await rosterWindow(ctx, chatId)) {
    if (seatIsCurrent(row, await holderProfile(ctx, row.userId))) current.push(row);
  }
  return current;
}

/**
 * Drop a room's leftover seats NOW, with what their holders kept there (read
 * marker, bookmarks), and return its current roster — the roster an invitation
 * counts against the limit. Settled window by window: a transaction sees its own
 * deletions, so a window full of leftovers is cleared and read again until the
 * room fits in one. Null when it still does not (the window full of CURRENT
 * seats, or leftovers past the passes): the count could not be seen whole, and the
 * caller must refuse rather than guess (fail closed). A leftover's state is kept
 * when the same person also holds a current seat here — it is theirs.
 */
export async function settleRoster(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<Doc<"chatParticipants">[] | null> {
  for (let pass = 0; pass < ROSTER_SETTLE_PASSES; pass += 1) {
    const raw = await rosterWindow(ctx, chatId);
    const current: Doc<"chatParticipants">[] = [];
    const stale: Doc<"chatParticipants">[] = [];
    for (const row of raw) {
      if (seatIsCurrent(row, await holderProfile(ctx, row.userId))) current.push(row);
      else stale.push(row);
    }
    const seated = new Set(current.map((r) => String(r.userId)));
    for (const row of stale) {
      await ctx.db.delete(row._id);
      if (!seated.has(String(row.userId))) await purgeMemberState(ctx, chatId, row.userId);
    }
    if (raw.length < ROSTER_READ_WINDOW) return current;
    if (stale.length === 0) return null;
  }
  return null;
}

/** Windows one invitation may clear of leftovers before it refuses. */
const ROSTER_SETTLE_PASSES = 4;

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

/**
 * Forget a person's OWN state in one conversation — their read marker and their
 * bookmarks — when they leave it, are removed from it, or it is deleted. Left
 * behind, a bookmark's label outlives the conversation it names, and dead rows
 * crowd the bounded per-user reads (`myChatReads`) that the sidebar relies on.
 */
export async function purgeMemberState(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
): Promise<void> {
  const read = await ctx.db
    .query("chatReads")
    .withIndex("by_user_chat", (q) => q.eq("userId", userId).eq("chatId", chatId))
    .first();
  if (read !== null) await ctx.db.delete(read._id);
  for (const bookmark of await ctx.db
    .query("chatBookmarks")
    .withIndex("by_user_chat", (q) => q.eq("userId", userId).eq("chatId", chatId))
    .take(1000)) {
    await ctx.db.delete(bookmark._id);
  }
}
