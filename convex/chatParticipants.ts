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
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireActive } from "./lib/access";
import {
  MAX_CHAT_PARTICIPANTS,
  chatParticipantRows,
  resolveChatAccess,
} from "./lib/chatAccess";

/** How a person is shown in a roster. Never an email the viewer cannot already see. */
export interface ChatMemberView {
  userId: Id<"users">;
  name: string;
  role: "owner" | "participant";
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
async function memberIdentity(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<{ name: string }> {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const name =
    profile?.name ??
    profile?.email ??
    profile?.canonical ??
    `#${String(userId).slice(0, 6)}`;
  return { name };
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
        addedAt: null,
        isSelf: access.chat.userId === userId,
      },
    ];
    for (const row of rows.slice(0, MAX_CHAT_PARTICIPANTS)) {
      const who = await memberIdentity(ctx, row.userId);
      members.push({
        userId: row.userId,
        name: who.name,
        role: "participant",
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
  ): Promise<Array<{ userId: Id<"users">; name: string }>> => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return [];
    const access = await resolveChatAccess(ctx, id, userId);
    // Only the owner manages the roster, so only the owner is offered candidates.
    if (access === null || access.role !== "owner") return [];
    const taken = new Set<string>([String(access.chat.userId)]);
    for (const row of await chatParticipantRows(ctx, id)) {
      taken.add(String(row.userId));
    }
    const out: Array<{ userId: Id<"users">; name: string }> = [];
    for (const role of ["user", "admin"] as const) {
      const profiles = await ctx.db
        .query("profiles")
        .withIndex("by_role", (q) => q.eq("role", role))
        .take(200);
      for (const p of profiles) {
        if (taken.has(String(p.userId))) continue;
        taken.add(String(p.userId));
        out.push({
          userId: p.userId,
          name: p.name ?? p.email ?? `#${String(p.userId).slice(0, 6)}`,
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const addMember = mutation({
  args: { chatId: v.id("chats"), memberId: v.id("users") },
  handler: async (ctx, { chatId, memberId }) => {
    const { userId } = await requireActive(ctx);
    const access = await resolveChatAccess(ctx, chatId, userId);
    if (access === null) throw new Error("Forbidden: chat not reachable");
    if (access.role !== "owner") {
      throw new Error("Forbidden: only the chat owner manages participants");
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
    const existing = await ctx.db
      .query("chatParticipants")
      .withIndex("by_chat_user", (q) => q.eq("chatId", chatId).eq("userId", memberId))
      .unique();
    if (existing !== null) return { added: false as const, reason: "already-member" as const };
    const rows = await chatParticipantRows(ctx, chatId);
    if (rows.length >= MAX_CHAT_PARTICIPANTS) {
      // A CODE, not a sentence: this string reaches the panel verbatim, and the
      // panel is localized. The client maps the code; the server states the fact.
      throw new Error(`participants_limit:${MAX_CHAT_PARTICIPANTS}`);
    }
    await ctx.db.insert("chatParticipants", {
      chatId,
      userId: memberId,
      addedBy: userId,
      addedAt: Date.now(),
    });
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
    const { userId } = await requireActive(ctx);
    const access = await resolveChatAccess(ctx, chatId, userId);
    if (access === null) throw new Error("Forbidden: chat not reachable");
    if (access.role !== "owner" && memberId !== userId) {
      throw new Error("Forbidden: only the chat owner removes other participants");
    }
    if (memberId === access.chat.userId) {
      // The owner is not a roster row; removing them would mean deleting the chat.
      throw new Error("Forbidden: the owner cannot be removed from their own chat");
    }
    const row = await ctx.db
      .query("chatParticipants")
      .withIndex("by_chat_user", (q) => q.eq("chatId", chatId).eq("userId", memberId))
      .unique();
    if (row === null) return { removed: false as const };
    await ctx.db.delete(row._id);
    return { removed: true as const };
  },
});
