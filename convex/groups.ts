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
import {
  getActor,
  requireAdmin,
  requirePermission,
  requireUserId,
  roleOf,
} from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { resolveAgentTypes } from "./lib/agentTypes";
import { auditImpersonated } from "./lib/audit";
import { authorizeGroupManage, isRealAdmin } from "./lib/groupAccess";
import { chartDisplayName } from "./charts";

// How many member/agent/chart names to PREVIEW inline in the groups list (the rest
// are summarized as "+N"). Bounds the listGroups payload + reads (a group can have
// many members) so the list stays cheap — never an unbounded fan-out.
const GROUP_PREVIEW_CAP = 6;

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
    await requireAdmin(ctx); // create a group = admin-only (structural)
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
    // Rename / description = group metadata. Admin-only (not in the delegated
    // manager set: membership + agents + charts). Managers manage content, not the
    // group's identity.
    await requireAdmin(ctx);
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
    await requireAdmin(ctx); // delete a group (cascade) = admin-only (structural)
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
    // Tier-1 admin chart POOL rows for this group (3-tier charts model).
    const gcp = await ctx.db
      .query("groupChartPool")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    for (const p of gcp) await ctx.db.delete(p._id);
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
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
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
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    const existing = await ctx.db
      .query("groupMembers")
      .withIndex("by_user_group", (q) =>
        q.eq("userId", userId).eq("groupId", groupId),
      )
      .unique();
    if (existing === null) return; // idempotent
    // A MANAGER membership may only be removed by an ADMIN: deleting the row also
    // strips the `manager` flag, which would let a delegated manager demote a
    // co-manager and bypass the admin-only setGroupManager. (Also blocks a manager
    // self-demoting via removal — safe; an admin does it.)
    if (existing.manager === true && !(await isRealAdmin(ctx))) {
      throw new Error("Refused: only an admin can remove a group manager");
    }
    await ctx.db.delete(existing._id);
    await auditImpersonated(ctx, actor, "group.removeMember", {
      resource: "group",
      resourceId: groupId,
    });
  },
});

// Promote/demote a MEMBER as a MANAGER of this group. ADMIN-ONLY (delegation is
// the admin's call). The target must already be a member; managing requires the
// grantable `groups.manage` permission too (this flag scopes WHICH groups).
export const setGroupManager = mutation({
  args: {
    groupId: v.id("groups"),
    userId: v.id("users"),
    manager: v.boolean(),
  },
  handler: async (ctx, { groupId, userId, manager }) => {
    await requireAdmin(ctx);
    const actor = await getActor(ctx);
    const membership = await ctx.db
      .query("groupMembers")
      .withIndex("by_user_group", (q) =>
        q.eq("userId", userId).eq("groupId", groupId),
      )
      .unique();
    if (membership === null) {
      throw new Error("Refused: user is not a member of this group");
    }
    await ctx.db.patch(membership._id, { manager });
    await auditImpersonated(
      ctx,
      actor,
      manager ? "group.promoteManager" : "group.demoteManager",
      { resource: "group", resourceId: groupId },
    );
  },
});

export const assignAgentToGroup = mutation({
  args: {
    groupId: v.id("groups"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { groupId, instanceName, agentId }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
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
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
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

// Upper bound on a single bulk call. listUsers/listInstances are bounded at 500,
// so a real "select all" never approaches this — it is purely an abuse guard.
const BULK_CAP = 1000;

// "Select all" / "deselect all" for members: add or remove a whole set in ONE
// round-trip (the per-user mutations would be N requests). Each item reuses the
// idempotent add/remove logic; a single audit row is written when anything
// actually changed.
export const bulkSetMembers = mutation({
  args: {
    groupId: v.id("groups"),
    userIds: v.array(v.id("users")),
    member: v.boolean(),
  },
  handler: async (ctx, { groupId, userIds, member }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    await getGroupOrThrow(ctx, groupId);
    if (userIds.length > BULK_CAP) {
      throw new Error(
        `Refused: bulk membership change exceeds ${BULK_CAP} users`,
      );
    }
    // Same invariant as removeMember: a non-admin manager may not remove a
    // co-manager (it would strip the manager flag). The whole batch aborts on a
    // violation (Convex mutations are atomic → no partial removal persists).
    const admin = await isRealAdmin(ctx);
    let changed = 0;
    for (const userId of userIds) {
      const existing = await ctx.db
        .query("groupMembers")
        .withIndex("by_user_group", (q) =>
          q.eq("userId", userId).eq("groupId", groupId),
        )
        .unique();
      if (member && existing === null) {
        await ctx.db.insert("groupMembers", {
          groupId,
          userId,
          joinedAt: Date.now(),
        });
        changed++;
      } else if (!member && existing !== null) {
        if (existing.manager === true && !admin) {
          throw new Error("Refused: only an admin can remove a group manager");
        }
        await ctx.db.delete(existing._id);
        changed++;
      }
    }
    if (changed > 0) {
      await auditImpersonated(
        ctx,
        actor,
        member ? "group.addMember" : "group.removeMember",
        { resource: "group", resourceId: groupId },
      );
    }
  },
});

// "Select all" / "deselect all" for the agents of ONE instance. On assign, each
// agent is re-validated exactly like assignAgentToGroup (discovered + present);
// anything not assignable is silently skipped so a partial set still applies.
export const bulkSetGroupAgents = mutation({
  args: {
    groupId: v.id("groups"),
    instanceName: v.string(),
    agentIds: v.array(v.string()),
    assigned: v.boolean(),
  },
  handler: async (ctx, { groupId, instanceName, agentIds, assigned }) => {
    const actor = await authorizeGroupManage(ctx, groupId); // admin or group manager
    await getGroupOrThrow(ctx, groupId);
    if (agentIds.length > BULK_CAP) {
      throw new Error(
        `Refused: bulk agent change exceeds ${BULK_CAP} agents`,
      );
    }
    let changed = 0;
    for (const agentId of agentIds) {
      const existing = await ctx.db
        .query("groupAgents")
        .withIndex("by_group_instance_agent", (q) =>
          q
            .eq("groupId", groupId)
            .eq("instanceName", instanceName)
            .eq("agentId", agentId),
        )
        .unique();
      if (assigned) {
        if (existing !== null) continue; // idempotent
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
          continue; // not assignable — skip, do not abort the batch
        }
        await ctx.db.insert("groupAgents", {
          groupId,
          instanceName,
          agentId,
          createdAt: Date.now(),
        });
        changed++;
      } else {
        if (existing === null) continue; // idempotent
        await ctx.db.delete(existing._id);
        changed++;
      }
    }
    if (changed > 0) {
      await auditImpersonated(
        ctx,
        actor,
        assigned ? "group.assignAgent" : "group.removeAgent",
        { resource: "group", resourceId: groupId },
      );
    }
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
    const actor = await getActor(ctx);
    // Admins see EVERY group; a delegated (non-admin) manager sees ONLY the groups
    // they manage (groupMembers.manager) — never others.
    let groups: Doc<"groups">[];
    if (await isRealAdmin(ctx)) {
      groups = await ctx.db.query("groups").order("desc").take(500);
    } else {
      const memberships = await ctx.db
        .query("groupMembers")
        .withIndex("by_user", (q) => q.eq("userId", actor.realUserId))
        .collect();
      const managed = memberships.filter((m) => m.manager === true);
      const rows: Doc<"groups">[] = [];
      for (const m of managed) {
        const g = await ctx.db.get(m.groupId);
        if (g !== null) rows.push(g);
      }
      groups = rows.sort((a, b) => b.createdAt - a.createdAt);
    }
    const out = [];
    for (const g of groups) {
      const memberRows = await ctx.db
        .query("groupMembers")
        .withIndex("by_group", (q) => q.eq("groupId", g._id))
        .collect();
      const agentRows = await ctx.db
        .query("groupAgents")
        .withIndex("by_group", (q) => q.eq("groupId", g._id))
        .collect();
      // Charts SELECTED by the group (Tier 2 — groupCharts); the pool (Tier 1) is
      // admin-internal and not surfaced in the list.
      const chartRows = await ctx.db
        .query("groupCharts")
        .withIndex("by_group", (q) => q.eq("groupId", g._id))
        .collect();

      // Inline DETAIL previews (names), bounded by GROUP_PREVIEW_CAP. Managers /
      // default chart are sorted FIRST so they always appear in the preview; the
      // count reveals how many more are hidden ("+N").
      const memberPreview = [...memberRows]
        .sort((a, b) => Number(b.manager === true) - Number(a.manager === true))
        .slice(0, GROUP_PREVIEW_CAP);
      const members = [];
      for (const m of memberPreview) {
        members.push({
          label: await userLabel(ctx, m.userId),
          manager: m.manager === true,
        });
      }
      const agents = [];
      for (const a of agentRows.slice(0, GROUP_PREVIEW_CAP)) {
        const { displayName } = await agentState(ctx, a.instanceName, a.agentId);
        agents.push(displayName ?? a.agentId);
      }
      const chartPreview = [...chartRows]
        .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true))
        .slice(0, GROUP_PREVIEW_CAP);
      const charts = [];
      for (const c of chartPreview) {
        charts.push({
          name: await chartDisplayName(ctx, c.chartKey),
          isDefault: c.isDefault === true,
        });
      }

      out.push({
        _id: g._id,
        key: g.key,
        name: g.name,
        description: g.description ?? null,
        memberCount: memberRows.length,
        agentCount: agentRows.length,
        chartCount: chartRows.length,
        // Bounded name previews for the list "detail" columns (rest = "+N").
        members,
        agents,
        charts,
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
    await authorizeGroupManage(ctx, groupId); // admin or this group's manager
    const group = await ctx.db.get(groupId);
    if (group === null) throw new Error("Not found: group");
    const memberRows = await ctx.db
      .query("groupMembers")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    const members = [];
    for (const m of memberRows) {
      members.push({
        userId: m.userId,
        label: await userLabel(ctx, m.userId),
        manager: m.manager === true, // promote/demote is admin-only (UI gates it)
      });
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
    // Count of charts the group has SELECTED (Tier 2) — feeds the Charts tab badge.
    const chartRows = await ctx.db
      .query("groupCharts")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    return {
      group: {
        _id: group._id,
        key: group.key,
        name: group.name,
        description: group.description ?? null,
      },
      members,
      agents,
      chartCount: chartRows.length,
      // Promote/demote a manager is ADMIN-ONLY: the Members tab shows the toggle
      // only when this is true (a delegated manager sees the badges, not the control).
      viewerIsAdmin: await isRealAdmin(ctx),
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

// ===========================================================================
// DELEGATION-SAFE DIRECTORY QUERIES (GROUPS_MANAGE-gated)
// The Manage dialog needs the user directory + instances + an instance's agents to
// curate a group. The admin equivalents (api.admin.listUsers / listInstances /
// agents.listAgentsForInstance) are requireAdmin AND over-disclose (roles +
// extraPermissions, full instance rows incl. URLs, agent curation state). These
// BOUNDED queries return ONLY the LABELS the dialog renders, gated by GROUPS_MANAGE
// so a delegated manager (admin-deputised) can populate the dialog. The data is
// non-secret (names/emails/agent labels) — never extraPermissions, gateway URLs,
// secrets or PHI. Per-GROUP data still flows through getGroup/authorizeGroupManage;
// these are the global pickable directory, so the permission (not per-group) gate is
// correct. NOTE: a delegated manager can now see the user directory + agent/instance
// topology — inherent to delegation, bounded to labels.

/** Users a manager may add as members: id + label fields only (NO extraPermissions). */
export const listAssignableUsers = query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const profiles = await ctx.db.query("profiles").order("desc").take(500);
    return profiles.map((p) => ({
      _id: p._id,
      userId: p.userId,
      role: roleOf(p),
      email: p.email ?? null,
      name: p.name ?? null,
      canonical: p.canonical ?? null,
    }));
  },
});

/** Instances a manager may share agents from: id + names only (NO URLs/config/secrets). */
export const listAssignableInstances = query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const instances = await ctx.db.query("instances").order("desc").take(200);
    return instances.map((i) => ({
      _id: i._id,
      name: i.name,
      displayName: i.displayName ?? null,
      kind: i.kind ?? "openclaw",
    }));
  },
});

/** Discovered agents of ONE instance a manager may share: render labels only (NO
 *  admin-curation state — enabled / defaultAgentId are omitted). */
export const listAssignableAgents = query({
  args: { instanceName: v.string() },
  handler: async (ctx, { instanceName }) => {
    await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .collect();
    const discovery = await ctx.db
      .query("instanceDiscovery")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .first();
    return {
      agents: agents.map((a) => ({
        agentId: a.agentId,
        displayName: a.displayName ?? null,
        emoji: a.emoji ?? null,
        model: a.model ?? null,
        isDefaultOnInstance: a.isDefaultOnInstance ?? false,
        types: resolveAgentTypes(a.types),
        source: a.source,
        presentInLastOk: a.presentInLastOk,
      })),
      discovery: discovery
        ? {
            lastPollAt: discovery.lastPollAt,
            lastPollOk: discovery.lastPollOk,
            lastOkAt: discovery.lastOkAt ?? null,
            error: discovery.error ?? null,
          }
        : null,
    };
  },
});
