// Groups (P2). Regroup users + share agents by group. Admin-managed only — see
// docs/GROUPS_CHARTS_P2_SPEC.md. NO secrets (non-secret instance/agent NAMES
// only). The user↔agent union driven by group membership is computed at READ
// time in convex/agents.ts (getEffectiveGrants / enrichUserAgents); this module
// owns only the admin CRUD + the owner-scoped membership read (listMyGroups).
//
// Authorization split (mirrors the rest of the surface):
//   - management mutations + admin queries gate on requirePermission(GROUPS_MANAGE)
//     against the REAL identity (admin-only; impersonation never grants it), then
//     audit via auditImpersonated so an admin acting while impersonating is traced.
//   - listMyGroups is owner-scoped on the EFFECTIVE user (requireUserId), like the
//     other user-data reads.

import { v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { getActor, requirePermission, requireUserId } from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { auditImpersonated } from "./lib/audit";

// ===========================================================================
// Helpers
// ===========================================================================

/** Derive a filesystem-safe slug from a group name (mirrors canonicalFromEmail's
 *  allowlist). Empty/symbol-only names fall back to "group". */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "group";
}

/** A `key` not yet used by any group. Probes `base`, then `base-2`, `base-3`, …
 *  via by_key so the slug is unique even on a name collision. Bounded. */
async function uniqueGroupKey(
  ctx: MutationCtx,
  base: string,
): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const clash = await ctx.db
      .query("groups")
      .withIndex("by_key", (q) => q.eq("key", candidate))
      .unique();
    if (clash === null) return candidate;
  }
}

/** A short, non-PHI display label for a user (email local-part / name / id tail),
 *  for the admin members list. Same idiom as admin.listAudit's labelOf. */
async function userLabel(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return profile?.email ?? profile?.name ?? userId.slice(0, 8);
}

/** Resolution health of a (instance, agent) for the admin group-agents list —
 *  same classification as agents.enrichUserAgents (deleted > unknown > stale). */
async function agentState(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<{
  state: "ok" | "deleted" | "stale" | "unknown";
  displayName: string | null;
}> {
  const agent = await ctx.db
    .query("agents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
  const discovery = await ctx.db
    .query("instanceDiscovery")
    .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
    .first();
  let state: "ok" | "deleted" | "stale" | "unknown" = "ok";
  if (agent && agent.presentInLastOk === false) state = "deleted";
  else if (!discovery) state = "unknown";
  else if (!discovery.lastPollOk) state = "stale";
  else if (!agent) state = "deleted";
  return { state, displayName: agent?.displayName ?? null };
}

/** Read a group or throw a clean error (admin paths). */
async function getGroupOrThrow(
  ctx: QueryCtx | MutationCtx,
  groupId: Id<"groups">,
): Promise<Doc<"groups">> {
  const group = await ctx.db.get(groupId);
  if (group === null) throw new Error("Not found: group");
  return group;
}

// ===========================================================================
// MUTATIONS (admin — requirePermission GROUPS_MANAGE on the REAL identity)
// ===========================================================================

export const createGroup = mutation({
  args: { name: v.string(), description: v.optional(v.string()) },
  handler: async (ctx, { name, description }): Promise<Id<"groups">> => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const actor = await getActor(ctx);
    const key = await uniqueGroupKey(ctx, slugify(name));
    const groupId = await ctx.db.insert("groups", {
      key,
      name,
      description,
      createdBy: actor.realUserId,
      createdAt: Date.now(),
    });
    await auditImpersonated(ctx, actor, "group.create", {
      resource: "group",
      resourceId: groupId,
    });
    return groupId;
  },
});

export const updateGroup = mutation({
  args: {
    groupId: v.id("groups"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { groupId, name, description }) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const actor = await getActor(ctx);
    await getGroupOrThrow(ctx, groupId);
    // Patch only the provided fields; the `key` is immutable (provenance token).
    // `description: undefined` (arg absent) = don't touch; `description: ""` =
    // CLEAR it — patch the optional field to undefined so it is removed (the
    // established clear-an-optional pattern, cf. promoteChartToCommon clearing
    // ownerUserId). The edit form sends the RAW string so an emptied field clears.
    const patch: { name?: string; description?: string | undefined } = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description || undefined;
    if (Object.keys(patch).length > 0) await ctx.db.patch(groupId, patch);
    await auditImpersonated(ctx, actor, "group.update", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

export const deleteGroup = mutation({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const actor = await getActor(ctx);
    const group = await ctx.db.get(groupId);
    if (group === null) return; // idempotent
    // CASCADE: purge memberships + shared agents (both bounded by_group reads),
    // THEN the group itself. Group sizes are admin-scale; collect is acceptable.
    const members = await ctx.db
      .query("groupMembers")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    for (const m of members) await ctx.db.delete(m._id);
    const ga = await ctx.db
      .query("groupAgents")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    for (const a of ga) await ctx.db.delete(a._id);
    const gc = await ctx.db
      .query("groupCharts")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    for (const c of gc) await ctx.db.delete(c._id);
    await ctx.db.delete(groupId);
    await auditImpersonated(ctx, actor, "group.delete", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

export const addMember = mutation({
  args: { groupId: v.id("groups"), userId: v.id("users") },
  handler: async (ctx, { groupId, userId }) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const actor = await getActor(ctx);
    await getGroupOrThrow(ctx, groupId);
    // Dedup via by_user_group (membership check + idempotency in one read).
    const existing = await ctx.db
      .query("groupMembers")
      .withIndex("by_user_group", (q) =>
        q.eq("userId", userId).eq("groupId", groupId),
      )
      .unique();
    if (existing !== null) return; // idempotent
    await ctx.db.insert("groupMembers", {
      groupId,
      userId,
      joinedAt: Date.now(),
    });
    await auditImpersonated(ctx, actor, "group.addMember", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

export const removeMember = mutation({
  args: { groupId: v.id("groups"), userId: v.id("users") },
  handler: async (ctx, { groupId, userId }) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const actor = await getActor(ctx);
    const existing = await ctx.db
      .query("groupMembers")
      .withIndex("by_user_group", (q) =>
        q.eq("userId", userId).eq("groupId", groupId),
      )
      .unique();
    if (existing === null) return; // idempotent
    await ctx.db.delete(existing._id);
    await auditImpersonated(ctx, actor, "group.removeMember", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

export const assignAgentToGroup = mutation({
  args: {
    groupId: v.id("groups"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { groupId, instanceName, agentId }) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const actor = await getActor(ctx);
    await getGroupOrThrow(ctx, groupId);
    // Mirror agents.assignAgent EXACTLY: only DISCOVERED + currently-present
    // agents are assignable, so a group can never share a manual/deleted agent.
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", instanceName).eq("agentId", agentId),
      )
      .first();
    if (
      agent === null ||
      agent.source !== "discovered" ||
      !agent.presentInLastOk
    ) {
      throw new Error(
        `Agent not assignable: ${instanceName}/${agentId} is not a discovered, present agent`,
      );
    }
    // Dedup via by_group_instance_agent.
    const existing = await ctx.db
      .query("groupAgents")
      .withIndex("by_group_instance_agent", (q) =>
        q
          .eq("groupId", groupId)
          .eq("instanceName", instanceName)
          .eq("agentId", agentId),
      )
      .unique();
    if (existing !== null) return; // idempotent
    await ctx.db.insert("groupAgents", {
      groupId,
      instanceName,
      agentId,
      createdAt: Date.now(),
    });
    await auditImpersonated(ctx, actor, "group.assignAgent", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

export const removeAgentFromGroup = mutation({
  args: {
    groupId: v.id("groups"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { groupId, instanceName, agentId }) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const actor = await getActor(ctx);
    const existing = await ctx.db
      .query("groupAgents")
      .withIndex("by_group_instance_agent", (q) =>
        q
          .eq("groupId", groupId)
          .eq("instanceName", instanceName)
          .eq("agentId", agentId),
      )
      .unique();
    if (existing === null) return; // idempotent
    await ctx.db.delete(existing._id);
    await auditImpersonated(ctx, actor, "group.removeAgent", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

// ===========================================================================
// QUERIES
// ===========================================================================

/** Admin: all groups with member/agent counts (the Groups tab list). Counts are
 *  bounded by_group reads (admin-scale group sizes). */
export const listGroups = query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const groups = await ctx.db.query("groups").order("desc").take(500);
    const out = [];
    for (const g of groups) {
      const members = await ctx.db
        .query("groupMembers")
        .withIndex("by_group", (q) => q.eq("groupId", g._id))
        .collect();
      const agents = await ctx.db
        .query("groupAgents")
        .withIndex("by_group", (q) => q.eq("groupId", g._id))
        .collect();
      out.push({
        _id: g._id,
        key: g.key,
        name: g.name,
        description: g.description ?? null,
        memberCount: members.length,
        agentCount: agents.length,
        createdAt: g.createdAt,
      });
    }
    return out;
  },
});

/** Admin: one group's members + shared agents (the Groups tab detail). */
export const getGroup = query({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const group = await ctx.db.get(groupId);
    if (group === null) throw new Error("Not found: group");
    const memberRows = await ctx.db
      .query("groupMembers")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    const members = [];
    for (const m of memberRows) {
      members.push({ userId: m.userId, label: await userLabel(ctx, m.userId) });
    }
    const agentRows = await ctx.db
      .query("groupAgents")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    const agents = [];
    for (const a of agentRows) {
      const { state, displayName } = await agentState(
        ctx,
        a.instanceName,
        a.agentId,
      );
      agents.push({
        instanceName: a.instanceName,
        agentId: a.agentId,
        displayName,
        isDefault: a.isDefault ?? false,
        state,
      });
    }
    return {
      group: {
        _id: group._id,
        key: group.key,
        name: group.name,
        description: group.description ?? null,
      },
      members,
      agents,
    };
  },
});

/** The EFFECTIVE user's group memberships (impersonation-aware). Feeds the agents
 *  union + the P5 introspection screen. Owner-scoped — NOT admin-gated. */
export const listMyGroups = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const memberships = await ctx.db
      .query("groupMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out = [];
    for (const m of memberships) {
      const group = await ctx.db.get(m.groupId);
      if (group === null) continue; // tolerate a transient dangling membership
      out.push({ groupId: group._id, key: group.key, name: group.name });
    }
    return out;
  },
});
