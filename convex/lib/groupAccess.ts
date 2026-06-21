// Shared per-group MANAGEMENT authorization (RBAC delegation, Phase A). Extracted
// so BOTH groups.ts (membership + agents) AND charts.ts (the Tier-2 chart
// selection) gate the per-group management surface through the SAME check —
// without a charts.ts <-> groups.ts module cycle.
//
// The split (do NOT collapse): the per-group CONTENT surface (membership, agents,
// chart selection of ONE group) is delegated to a group MANAGER; structural ops
// (create/delete group, promote a manager, rename) stay admin-only and are gated
// with requireAdmin at their call sites — never routed here.

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  getActor,
  getProfile,
  requirePermission,
  roleOf,
  type Actor,
} from "./access";
import { PERMISSIONS } from "./rbac";

/** True when the REAL caller is an admin (non-throwing; admins manage ALL groups). */
export async function isRealAdmin(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  const actor = await getActor(ctx);
  return roleOf(await getProfile(ctx, actor.realUserId)) === "admin";
}

/** True when `userId` is a MANAGER of `groupId` (groupMembers.manager === true). */
export async function isGroupManager(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  groupId: Id<"groups">,
): Promise<boolean> {
  const m = await ctx.db
    .query("groupMembers")
    .withIndex("by_user_group", (q) =>
      q.eq("userId", userId).eq("groupId", groupId),
    )
    .unique();
  return m?.manager === true;
}

/**
 * Gate the per-group MANAGEMENT surface (membership + agents + chart selection of
 * ONE group). Allowed for an admin (manages all) OR a holder of the grantable
 * `groups.manage` permission who is a MANAGER of THIS specific group. Throws
 * otherwise. Returns the actor for the audit trail. Create/delete-group + manager
 * PROMOTION are NOT routed here — they stay admin-only (requireAdmin).
 */
export async function authorizeGroupManage(
  ctx: QueryCtx | MutationCtx,
  groupId: Id<"groups">,
): Promise<Actor> {
  // requirePermission keys on the REAL identity: admins (wildcard) pass; a granted
  // non-admin passes; everyone else is rejected here.
  await requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE);
  const actor = await getActor(ctx);
  if (await isRealAdmin(ctx)) return actor; // admins manage every group
  if (!(await isGroupManager(ctx, actor.realUserId, groupId))) {
    throw new Error("Forbidden: not a manager of this group");
  }
  return actor;
}
