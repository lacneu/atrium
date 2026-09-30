// Group INVITATION REQUESTS. A group manager never browses the user directory and
// never adds anyone: they ask, by exact email, for a person to join their group,
// and an admin approves (the account must exist and be approved) or rejects.
//
//  - requestGroupInvite       — the group's manager (or an admin); notifies admins.
//  - listGroupInviteRequests  — the group's manager (or an admin): their requests.
//  - listPendingInviteRequests / decideGroupInvite — admin only.
//
// MAKING a request tells a manager nothing about whether an email belongs to an
// account: any well-formed address is accepted (the only refusal that names a
// person is "already a member", which the manager already sees in the member
// list). The DECISION does disclose it, by design: an approval means an approved
// account exists — and it is then a member the manager sees anyway — while a
// rejection says nothing about why. Every step is audited with the real actor.

import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getActor, getProfile, requireAdmin, roleOf } from "./lib/access";
import { recordAudit } from "./lib/audit";
import { normalizeEmail } from "./lib/authDomains";
import { authorizeGroupManage } from "./lib/groupAccess";
import { notifyAdmins, notifyUser } from "./notifications";
import { userLabel } from "./groups";

/** A group holds at most this many PENDING requests (abuse guard). */
export const MAX_PENDING_INVITES_PER_GROUP = 50;
const EMAIL_MAX = 254;
const LIST_CAP = 100;

/** A normalized, plausibly-shaped address, or null. Deliberately loose (one "@",
 *  non-empty sides, a dot in the domain, no whitespace): the admin decides. */
export function normalizeInviteEmail(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (email === undefined || email.length > EMAIL_MAX) return null;
  if (/\s/.test(email)) return null;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return null;
  const domain = email.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) {
    return null;
  }
  return email;
}

/** The profile an email names (normalized index first, then the legacy exact one
 *  — the same two reads the duplicate-account guard uses), or null. */
async function profileByEmail(
  ctx: QueryCtx | MutationCtx,
  email: string,
): Promise<Doc<"profiles"> | null> {
  return (
    (await ctx.db
      .query("profiles")
      .withIndex("by_email_lower", (q) => q.eq("emailLower", email))
      .first()) ??
    (await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first())
  );
}

async function isMember(
  ctx: QueryCtx | MutationCtx,
  groupId: Id<"groups">,
  userId: Id<"users">,
): Promise<boolean> {
  return (
    (await ctx.db
      .query("groupMembers")
      .withIndex("by_user_group", (q) => q.eq("userId", userId).eq("groupId", groupId))
      .unique()) !== null
  );
}

export const requestGroupInvite = mutation({
  args: { groupId: v.id("groups"), email: v.string() },
  handler: async (ctx, { groupId, email: raw }): Promise<Id<"groupInviteRequests">> => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    const group = await ctx.db.get(groupId);
    if (group === null) throw new Error("Not found: group");
    const email = normalizeInviteEmail(raw);
    if (email === null) throw new Error("Invalid email address");
    const pending = await ctx.db
      .query("groupInviteRequests")
      .withIndex("by_group_email_status", (q) =>
        q.eq("groupId", groupId).eq("email", email).eq("status", "pending"),
      )
      .first();
    if (pending !== null) return pending._id; // idempotent
    const owner = await profileByEmail(ctx, email);
    if (owner !== null && (await isMember(ctx, groupId, owner.userId))) {
      throw new Error("Refused: already a member of this group");
    }
    const open = await ctx.db
      .query("groupInviteRequests")
      .withIndex("by_group_status", (q) =>
        q.eq("groupId", groupId).eq("status", "pending"),
      )
      .take(MAX_PENDING_INVITES_PER_GROUP);
    if (open.length >= MAX_PENDING_INVITES_PER_GROUP) {
      throw new Error(
        `Refused: this group already has ${MAX_PENDING_INVITES_PER_GROUP} pending requests`,
      );
    }
    const requestId = await ctx.db.insert("groupInviteRequests", {
      groupId,
      email,
      requestedBy: actor.realUserId,
      status: "pending",
      createdAt: Date.now(),
    });
    await recordAudit(ctx, actor, "group.inviteRequest", {
      resource: "groupInvite",
      resourceId: requestId,
    });
    // The admins' bell names the group and who asked — never the address (it is
    // on the approval screen, behind the admin gate).
    const requester = await userLabel(ctx, actor.realUserId);
    await notifyAdmins(ctx, {
      kind: "group_invite",
      title: "Demande d'invitation dans un groupe",
      body: `${group.name} (${requester})`,
      messageKey: "notif_group_invite_request",
      params: { group: group.name, by: requester },
      href: "/settings/groups",
      dedupeKey: `group_invite:${requestId}`,
    });
    return requestId;
  },
});

/** The requests made for ONE group (pending first, then the most recent decided). */
export const listGroupInviteRequests = query({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    await authorizeGroupManage(ctx, groupId); // admin or group manager
    const pending = await ctx.db
      .query("groupInviteRequests")
      .withIndex("by_group_status", (q) => q.eq("groupId", groupId).eq("status", "pending"))
      .order("desc")
      .take(LIST_CAP);
    const approved = await ctx.db
      .query("groupInviteRequests")
      .withIndex("by_group_status", (q) => q.eq("groupId", groupId).eq("status", "approved"))
      .order("desc")
      .take(10);
    const rejected = await ctx.db
      .query("groupInviteRequests")
      .withIndex("by_group_status", (q) => q.eq("groupId", groupId).eq("status", "rejected"))
      .order("desc")
      .take(10);
    const decided = [...approved, ...rejected].sort(
      (a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0),
    );
    return [...pending, ...decided.slice(0, 10)].map((r) => ({
      _id: r._id,
      email: r.email,
      status: r.status,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt ?? null,
    }));
  },
});

/** Admin: every PENDING request, with whether the address names an account that
 *  can be added right now ("ready"), one still awaiting approval, or none. */
export const listPendingInviteRequests = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("groupInviteRequests")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(200);
    const out = [];
    for (const r of rows) {
      const group = await ctx.db.get(r.groupId);
      const owner = await profileByEmail(ctx, r.email);
      out.push({
        _id: r._id,
        groupId: r.groupId,
        groupName: group?.name ?? null,
        email: r.email,
        requestedBy: await userLabel(ctx, r.requestedBy),
        createdAt: r.createdAt,
        account:
          owner === null
            ? ("none" as const)
            : roleOf(owner) === "pending"
              ? ("pending" as const)
              : ("ready" as const),
      });
    }
    return out;
  },
});

/** Admin: approve (the account must exist and be approved — it joins the group) or
 *  reject a pending request. The requester is told either way. */
export const decideGroupInvite = mutation({
  args: { requestId: v.id("groupInviteRequests"), approve: v.boolean() },
  handler: async (ctx, { requestId, approve }) => {
    await requireAdmin(ctx);
    const actor = await getActor(ctx);
    const request = await ctx.db.get(requestId);
    if (request === null) throw new Error("Not found: invitation request");
    if (request.status !== "pending") throw new Error("Refused: already decided");
    const group = await ctx.db.get(request.groupId);
    if (group === null) throw new Error("Not found: group");
    const now = Date.now();
    if (approve) {
      const owner = await profileByEmail(ctx, request.email);
      if (owner === null) {
        throw new Error("Refused: no account uses this email");
      }
      if (roleOf(owner) === "pending") {
        throw new Error("Refused: this account is still awaiting approval");
      }
      if (!(await isMember(ctx, request.groupId, owner.userId))) {
        await ctx.db.insert("groupMembers", {
          groupId: request.groupId,
          userId: owner.userId,
          joinedAt: now,
        });
        await recordAudit(ctx, actor, "group.addMember", {
          resource: "groupMember",
          resourceId: `${request.groupId}:${owner.userId}`,
        });
      }
      await ctx.db.patch(requestId, {
        status: "approved",
        decidedBy: actor.realUserId,
        decidedAt: now,
        approvedUserId: owner.userId,
      });
    } else {
      await ctx.db.patch(requestId, {
        status: "rejected",
        decidedBy: actor.realUserId,
        decidedAt: now,
      });
    }
    await recordAudit(ctx, actor, approve ? "group.inviteApprove" : "group.inviteReject", {
      resource: "groupInvite",
      resourceId: requestId,
    });
    // The requester may have been deleted since (their rows are dropped with the
    // account, but a decision can race it): never ring a missing account.
    if ((await getProfile(ctx, request.requestedBy)) === null) return;
    await notifyUser(ctx, {
      userId: request.requestedBy,
      kind: "group_invite",
      title: approve ? "Invitation acceptée" : "Invitation refusée",
      body: `${request.email} — ${group.name}`,
      messageKey: approve ? "notif_group_invite_approved" : "notif_group_invite_rejected",
      params: { email: request.email, group: group.name },
      href: "/settings/groups",
      dedupeKey: `group_invite_decided:${requestId}`,
    });
  },
});
