// Per-member state a group keeps about its agents (groupMembers.defaultAgent and
// the groupMemberAgents allowances), and its cleanup when an agent leaves a group.
// Shared by the group mutations, the agent purge and the instance cascade.

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/** Typed refusal (ConvexError data) the UI localizes: a manager's unshare or member
 *  removal would LIFT an administrator's narrowing of some member (their direct
 *  grants would stop meeting any group's share → the whole pool). Names nobody.
 *  Shared with the front end (type-only imports here keep it bundle-safe). */
export const ADMIN_RESTRICTION_WOULD_LIFT = "admin_restriction_would_lift";

/** The mirror refusal: a manager's SHARE would switch a member INTO an
 *  administrator's narrowing (a direct grant on the shared agent, ignored until
 *  now, would start narrowing them to their direct grants). Names nobody. */
export const ADMIN_RESTRICTION_WOULD_APPLY = "admin_restriction_would_apply";

/** Clear every member default of ONE group pointing at (instance, agent) — or at
 *  any agent of the instance when `agentId` is null (instance purge). */
export async function clearMemberDefaults(
  ctx: MutationCtx,
  groupId: Id<"groups">,
  instanceName: string,
  agentId: string | null,
): Promise<void> {
  const members = await ctx.db
    .query("groupMembers")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .collect();
  for (const m of members) {
    const d = m.defaultAgent;
    if (
      d !== undefined &&
      d.instanceName === instanceName &&
      (agentId === null || d.agentId === agentId)
    ) {
      await ctx.db.patch(m._id, { defaultAgent: undefined });
    }
  }
}

/** An agent leaves ONE group: drop every member's allowance for it and every
 *  member default pointing at it, so re-sharing it later never silently restores
 *  an old per-member choice. */
export async function unshareAgentFromMembers(
  ctx: MutationCtx,
  groupId: Id<"groups">,
  instanceName: string,
  agentId: string,
): Promise<void> {
  const rows = await ctx.db
    .query("groupMemberAgents")
    .withIndex("by_group_instance_agent", (q) =>
      q
        .eq("groupId", groupId)
        .eq("instanceName", instanceName)
        .eq("agentId", agentId),
    )
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
  await clearMemberDefaults(ctx, groupId, instanceName, agentId);
}
