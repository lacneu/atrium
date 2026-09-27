// Group chats: the roster of a conversation, and who may change it.
//
// A chat starts solo (owner only) and becomes a group the moment someone is added.
// There is no separate "group chat" type: the same chat, the same gateway session,
// the same agent — with more people reading and writing it. That is the only shape
// the gateway supports (2026.9.2 sessions have one creator and no membership that
// grants visibility), and it is also the simplest thing to explain: you invite
// someone into a conversation you already have.

import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireActive } from "./lib/access";
import { auditImpersonated } from "./lib/audit";
import {
  notifyUser,
  withdrawChatNotifications,
  withdrawNotifications,
} from "./notifications";
import {
  MAX_CHAT_PARTICIPANTS,
  canManageRoom,
  chatParticipantRows,
  memberRoleOf,
  purgeMemberState,
  resolveChatAccess,
  seatIsCurrent,
  settleRoster,
  type ChatAccess,
  type MemberRole,
  type RoomRole,
} from "./lib/chatAccess";

const memberRoleValidator = v.union(
  v.literal("viewer"),
  v.literal("member"),
  v.literal("manager"),
);

/**
 * May `access` give `target` the role `to` — or remove them (`to` null)?
 *
 * The owner decides everything. A manager runs the room day to day: invites,
 * removes and re-roles viewers and members, but never touches another manager
 * and never makes one — otherwise any manager could promote a friend who then
 * demotes them, and the owner would no longer be the one who decides who runs
 * their conversation.
 */
function mayChangeRole(
  access: ChatAccess,
  target: MemberRole | null,
  to: MemberRole | null,
): boolean {
  if (access.roomRole === "owner") return true;
  if (access.roomRole !== "manager") return false;
  if (target === "manager" || to === "manager") return false;
  return true;
}

/** How a person is shown in a roster. Never an email the viewer cannot already see. */
export interface ChatMemberView {
  userId: Id<"users">;
  name: string;
  role: "owner" | "participant";
  /** Their standing in the room: "owner", or the participant's role. */
  roomRole: RoomRole;
  addedAt: number | null;
  /** True on the row of the person asking. The client needs it to offer "leave"
   *  to the right row; deriving it there would need a second identity query. */
  isSelf: boolean;
}

/**
 * Display identity for a user id. Falls back through the profile's own fields and
 * finally to a shortened id, so a roster row NEVER renders blank for a profile
 * that has not filled anything in.
 */
/**
 * How a person is named everywhere in a room — the roster AND the invite list. One
 * rule, so the name someone is invited under is the name they then appear with.
 */
function displayNameOf(
  profile: { name?: string; email?: string; canonical?: string } | null,
  userId: Id<"users">,
): string {
  return (
    profile?.name ??
    profile?.email ??
    profile?.canonical ??
    `#${String(userId).slice(0, 6)}`
  );
}

async function memberIdentity(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<{ name: string }> {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return { name: displayNameOf(profile, userId) };
}

/**
 * The roster of a chat, owner first. Readable by anyone who can reach the chat:
 * a participant must be able to see who else is in the room they are speaking in.
 */
export const listMembers = query({
  // v.string, like listByChat: the id comes from the URL and may be malformed.
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }): Promise<ChatMemberView[]> => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return [];
    const access = await resolveChatAccess(ctx, id, userId);
    if (access === null) return [];
    const owner = await memberIdentity(ctx, access.chat.userId);
    const rows = await chatParticipantRows(ctx, id);
    const members: ChatMemberView[] = [
      {
        userId: access.chat.userId,
        name: owner.name,
        role: "owner",
        roomRole: "owner",
        addedAt: null,
        isSelf: access.chat.userId === userId,
      },
    ];
    // Every current seat, even past the limit: whoever can read the room is shown.
    for (const row of rows) {
      const who = await memberIdentity(ctx, row.userId);
      members.push({
        userId: row.userId,
        name: who.name,
        role: "participant",
        roomRole: memberRoleOf(row),
        addedAt: row.addedAt,
        isSelf: row.userId === userId,
      });
    }
    return members;
  },
});

/**
 * People the current user may add to a chat: the approved users of this
 * deployment, minus those already in the room.
 *
 * Deliberately NOT a global directory search: Atrium deployments are one team, the
 * approved set is small and bounded, and a query that only ever returns people who
 * can already sign in cannot be used to probe for addresses. `pending` profiles are
 * excluded — inviting someone who is still blocked from the app would create a
 * roster entry nobody can act on.
 */
export const listInvitable = query({
  args: { chatId: v.string() },
  handler: async (
    ctx,
    { chatId },
  ): Promise<Array<{ userId: Id<"users">; name: string; detail?: string }>> => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return [];
    const access = await resolveChatAccess(ctx, id, userId);
    // Only those who manage the room are offered candidates.
    if (access === null || !canManageRoom(access)) return [];
    const taken = new Set<string>([String(access.chat.userId)]);
    for (const row of await chatParticipantRows(ctx, id)) {
      taken.add(String(row.userId));
    }
    const out: Array<{ userId: Id<"users">; name: string; detail?: string }> = [];
    for (const role of ["user", "admin"] as const) {
      const profiles = await ctx.db
        .query("profiles")
        .withIndex("by_role", (q) => q.eq("role", role))
        .take(200);
      for (const p of profiles) {
        if (taken.has(String(p.userId))) continue;
        taken.add(String(p.userId));
        // Display names repeat (two "olivier"s): the address — else the account key —
        // tells the person inviting WHO each one is. Only people who manage the room
        // reach this list.
        const detail = p.email ?? p.canonical;
        out.push({
          userId: p.userId,
          name: displayNameOf(p, p.userId),
          ...(detail !== undefined && detail !== displayNameOf(p, p.userId) ? { detail } : {}),
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const addMember = mutation({
  args: {
    chatId: v.id("chats"),
    memberId: v.id("users"),
    /** Absent = "member", the role every invitation had before roles existed. */
    role: v.optional(memberRoleValidator),
  },
  handler: async (ctx, { chatId, memberId, role }) => {
    const { userId, actor } = await requireActive(ctx);
    const access = await resolveChatAccess(ctx, chatId, userId);
    if (access === null) throw new Error("Forbidden: chat not reachable");
    const granted: MemberRole = role ?? "member";
    if (!canManageRoom(access) || !mayChangeRole(access, null, granted)) {
      throw new Error("Forbidden: you do not manage this conversation's participants");
    }
    if (memberId === access.chat.userId) {
      // Not an error worth failing a click over, but it must not create a row: the
      // owner already appears in the roster from the chat itself, and a duplicate
      // would show them twice and let "remove" strip the owner from their own chat.
      return { added: false as const, reason: "already-owner" as const };
    }
    const target = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", memberId))
      .unique();
    if (target === null || target.role === "pending" || target.role === undefined) {
      // A pending profile is blocked from the app; adding it would put a name in
      // the roster that can never open the chat.
      throw new Error("Forbidden: that user is not approved on this deployment");
    }
    // The room's leftovers go first, in this transaction (settleRoster): they must
    // neither count against the limit nor hide a current seat from it.
    const roster = await settleRoster(ctx, chatId);
    const existing = await ctx.db
      .query("chatParticipants")
      .withIndex("by_chat_user", (q) => q.eq("chatId", chatId).eq("userId", memberId))
      .unique();
    if (existing !== null) {
      if (seatIsCurrent(existing, target)) {
        return { added: false as const, reason: "already-member" as const };
      }
      // A deleted account's leftover the sweep has not reached yet (seatIsCurrent):
      // it grants nothing, and must not block inviting the person again — nor hand
      // the new account the old one's read marker and bookmarks here.
      await ctx.db.delete(existing._id);
      await purgeMemberState(ctx, chatId, memberId);
    }
    if (roster === null || roster.length >= MAX_CHAT_PARTICIPANTS) {
      // A CODE, not a sentence: this string reaches the panel verbatim, and the
      // panel is localized. The client maps the code; the server states the fact.
      throw new Error(`participants_limit:${MAX_CHAT_PARTICIPANTS}`);
    }
    const membershipId = await ctx.db.insert("chatParticipants", {
      chatId,
      userId: memberId,
      // Who actually added them — the owner or a manager (provenance).
      addedBy: userId,
      addedAt: Date.now(),
      ...(granted === "member" ? {} : { role: granted }),
    });
    // TELL THEM. Without it the only trace of an invitation is a new row in a
    // sidebar the guest may not be looking at. The chat's title and the name of
    // WHO INVITED them (the owner or a manager — the provenance `addedBy` records)
    // only — never a word of the conversation. De-duplicated per membership so a
    // retried click cannot ring twice; a later re-invitation after leaving is a
    // new membership row and rings again, which is what it is.
    const adder = await memberIdentity(ctx, userId);
    await notifyUser(ctx, {
      userId: memberId,
      kind: "chat_added",
      title: "Vous avez été ajouté à une conversation",
      body: access.chat.title ?? "",
      messageKey: "notif_chat_added",
      params: { by: adder.name, chat: access.chat.title ?? "" },
      href: `/chat/${String(chatId)}`,
      dedupeKey: `chat_added:${String(membershipId)}`,
      chatId,
    });
    // Access to the whole history, granted under someone else's identity: audited
    // (the conversation only — never who, never a word of it).
    await auditImpersonated(ctx, actor, "chat.member_add", { resource: "chat", resourceId: chatId });
    return { added: true as const };
  },
});

/**
 * Remove someone. The owner may remove anyone; a participant may remove only
 * themselves — that is "leave the conversation", and it is the one roster change a
 * participant is allowed to make.
 */
export const removeMember = mutation({
  args: { chatId: v.id("chats"), memberId: v.id("users") },
  handler: async (ctx, { chatId, memberId }) => {
    const { userId, actor } = await requireActive(ctx);
    const access = await resolveChatAccess(ctx, chatId, userId);
    if (access === null) throw new Error("Forbidden: chat not reachable");
    if (memberId === access.chat.userId) {
      // The owner is not a roster row; removing them would mean deleting the chat.
      throw new Error("Forbidden: the owner cannot be removed from their own chat");
    }
    const row = await ctx.db
      .query("chatParticipants")
      .withIndex("by_chat_user", (q) => q.eq("chatId", chatId).eq("userId", memberId))
      .unique();
    // Leaving is always allowed; removing someone else follows the role rules.
    if (memberId !== userId) {
      const target = row === null ? null : memberRoleOf(row);
      if (!canManageRoom(access) || !mayChangeRole(access, target, null)) {
        throw new Error("Forbidden: you do not manage this conversation's participants");
      }
    }
    if (row === null) return { removed: false as const };
    await ctx.db.delete(row._id);
    await purgeMemberState(ctx, chatId, memberId);
    // Nothing the conversation rang them for outlives their place in it: "you were
    // added", a mention, a question. By conversation, and — for an entry written
    // before entries carried it — "you were added" by its own key.
    await withdrawChatNotifications(ctx, memberId, chatId);
    await withdrawNotifications(ctx, `chat_added:${String(row._id)}`);
    await auditImpersonated(ctx, actor, "chat.member_remove", { resource: "chat", resourceId: chatId });
    return { removed: true as const };
  },
});

/**
 * Leave a conversation you were added to — the sidebar's "quitter" on a guest row.
 * `removeMember` with one's own id does the same, but the sidebar does not know the
 * reader's user id and must not have to: the server resolves "me".
 */
export const leaveChat = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId, actor } = await requireActive(ctx);
    const row = await ctx.db
      .query("chatParticipants")
      .withIndex("by_chat_user", (q) => q.eq("chatId", chatId).eq("userId", userId))
      .unique();
    if (row === null) return { left: false as const };
    await ctx.db.delete(row._id);
    await purgeMemberState(ctx, chatId, userId);
    await withdrawChatNotifications(ctx, userId, chatId);
    await withdrawNotifications(ctx, `chat_added:${String(row._id)}`);
    await auditImpersonated(ctx, actor, "chat.leave", { resource: "chat", resourceId: chatId });
    return { left: true as const };
  },
});

/** Change a participant's role. Same authority as adding and removing. */
export const setMemberRole = mutation({
  args: {
    chatId: v.id("chats"),
    memberId: v.id("users"),
    role: memberRoleValidator,
  },
  handler: async (ctx, { chatId, memberId, role }) => {
    const { userId, actor } = await requireActive(ctx);
    const access = await resolveChatAccess(ctx, chatId, userId);
    if (access === null) throw new Error("Forbidden: chat not reachable");
    const row = await ctx.db
      .query("chatParticipants")
      .withIndex("by_chat_user", (q) => q.eq("chatId", chatId).eq("userId", memberId))
      .unique();
    if (row === null) throw new Error("Not found: not a participant of this chat");
    if (memberId === userId && access.roomRole !== "owner") {
      // Promoting or demoting oneself is not a thing a participant decides.
      throw new Error("Forbidden: you cannot change your own role");
    }
    if (!canManageRoom(access) || !mayChangeRole(access, memberRoleOf(row), role)) {
      throw new Error("Forbidden: you do not manage this conversation's participants");
    }
    await ctx.db.patch(row._id, { role: role === "member" ? undefined : role });
    // A viewer answers nothing: the questions they were rung for are not theirs
    // to answer any more.
    if (role === "viewer") await withdrawChatNotifications(ctx, memberId, chatId, "agent_request");
    await auditImpersonated(ctx, actor, "chat.member_role", { resource: "chat", resourceId: chatId });
    return { role };
  },
});
