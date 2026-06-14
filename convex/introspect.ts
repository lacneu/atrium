// Introspection (P5). A READ-ONLY admin screen: pick a user -> see their groups,
// available agents (with provenance), available charts (with provenance), and
// effective permissions. See docs/GROUPS_CHARTS_P5_SPEC.md. The `via` provenance
// already exists from P2-P4; this module only AGGREGATES + projects it for an
// ARBITRARY userId. NO mutation, NO write.
//
// Threat model (the one real surface): the aggregation exposes ANOTHER user's
// access map, so it MUST gate on admin against the REAL identity
// (requirePermission(ADMIN_MANAGE) keys off rawUserId; impersonation never drops
// the gate). A non-admin must never introspect anyone -- including themselves
// through this endpoint (they have their own owner-scoped queries).

import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  effectiveUserPermissions,
  getProfile,
  requirePermission,
  roleOf,
  type Role,
} from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { enrichUserAgents } from "./agents";
import { availableChartsForUser, type ChartVia } from "./charts";

/** A short display label for a user (email / name / id tail). Admin-only view,
 *  same idiom as groups.userLabel / admin.listAudit's labelOf. */
async function userLabel(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<string> {
  const profile = await getProfile(ctx, userId);
  return profile?.email ?? profile?.name ?? userId.slice(0, 8);
}

/** The user's group memberships, projected to {groupId, key, name}. Mirrors
 *  groups.listMyGroups but for an ARBITRARY userId (admin-gated above). Tolerates
 *  a transient dangling membership (skips a group that no longer exists). */
async function groupsForUser(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Array<{ groupId: Id<"groups">; key: string; name: string }>> {
  const memberships = await ctx.db
    .query("groupMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const out: Array<{ groupId: Id<"groups">; key: string; name: string }> = [];
  for (const m of memberships) {
    const group = await ctx.db.get(m.groupId);
    if (group === null) continue; // tolerate a transient dangling membership
    out.push({ groupId: group._id, key: group.key, name: group.name });
  }
  return out;
}

/**
 * Introspect an arbitrary user's access map (READ-ONLY). Gate: admin.manage on
 * the REAL identity (impersonation does NOT grant it). REUSES the existing
 * provenance helpers with the arbitrary `userId`:
 *   - groups  : the user's memberships (groupMembers by_user).
 *   - agents  : enrichUserAgents -> via "user" | { group }, with isDefault/state.
 *   - charts  : availableChartsForUser -> via "common" | { group } | "owner".
 *   - role + permissions : effectiveUserPermissions (role matrix UNION
 *     extraPermissions; an admin target's wildcard is already EXPANDED to the
 *     flat permission set by permissionsForRoleKey).
 * A user with no groups/agents/charts yields empty sections, not an error.
 */
export const introspectUser = query({
  args: { userId: v.id("users") },
  handler: async (
    ctx,
    { userId },
  ): Promise<{
    user: { userId: Id<"users">; label: string };
    role: Role;
    permissions: string[];
    groups: Array<{ groupId: Id<"groups">; key: string; name: string }>;
    agents: Array<{
      instanceName: string;
      agentId: string;
      displayName: string | null;
      via: "user" | { group: string };
      isDefault: boolean;
      state: "ok" | "deleted" | "stale" | "unknown";
    }>;
    charts: Array<{ key: string; name: string; via: ChartVia }>;
  }> => {
    // Admin gate on the REAL identity. Impersonation never drops it.
    await requirePermission(ctx, PERMISSIONS.ADMIN_MANAGE);

    const profile = await getProfile(ctx, userId);
    const perms = await effectiveUserPermissions(ctx, userId);

    const enrichedAgents = await enrichUserAgents(ctx, userId);
    const offeredCharts = await availableChartsForUser(ctx, userId);

    return {
      user: { userId, label: await userLabel(ctx, userId) },
      role: roleOf(profile),
      // Sorted for a stable, deterministic projection (the wildcard is already
      // expanded into the flat key set for an admin target).
      permissions: [...perms].sort(),
      groups: await groupsForUser(ctx, userId),
      // Project to the spec shape (a subset of EnrichedUserAgent): no source/
      // emoji/model/kind leak into the introspection view.
      agents: enrichedAgents.map((a) => ({
        instanceName: a.instanceName,
        agentId: a.agentId,
        displayName: a.displayName,
        via: a.via,
        isDefault: a.isDefault,
        state: a.state,
      })),
      // Project to the spec shape (a subset of OfferedChart): only key/name/via.
      charts: offeredCharts.map((c) => ({
        key: c.key,
        name: c.name,
        via: c.via,
      })),
    };
  },
});
