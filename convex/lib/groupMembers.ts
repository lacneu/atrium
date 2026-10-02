// Per-member state a group keeps about its agents (groupMembers.defaultAgent and
// the groupMemberAgents allowances), and its cleanup when an agent leaves a group.
// Shared by the group mutations, the agent purge and the instance cascade.

import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
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

/** Typed refusal: a share of an agent whose per-member cleanup (after it last left
 *  this group) has not finished. Retry shortly. Names nobody. */
export const MEMBER_CLEANUP_PENDING = "member_cleanup_pending";

/** Rows one cleanup batch touches, per kind: bounded, so a group of any size never
 *  exceeds a transaction's limits. */
export const MEMBER_CLEANUP_BATCH = 100;

/**
 * ONE bounded batch of the cleanup an agent leaving ONE group owes: member defaults
 * naming (instance, agent) — any agent of the instance when `agentId` is null — and,
 * for a named agent, the members' allowances for it. Reads only the rows it changes
 * (indexed), so it always progresses. True when nothing is left.
 */
export async function memberCleanupBatch(
  ctx: MutationCtx,
  groupId: Id<"groups">,
  instanceName: string,
  agentId: string | null,
): Promise<boolean> {
  const defaults = await ctx.db
    .query("groupMembers")
    .withIndex("by_group_and_default", (q) => {
      const byInstance = q.eq("groupId", groupId).eq("defaultAgent.instanceName", instanceName);
      return agentId === null ? byInstance : byInstance.eq("defaultAgent.agentId", agentId);
    })
    .take(MEMBER_CLEANUP_BATCH);
  for (const m of defaults) await ctx.db.patch(m._id, { defaultAgent: undefined });
  let allowances: { _id: Id<"groupMemberAgents"> }[] = [];
  if (agentId !== null) {
    allowances = await ctx.db
      .query("groupMemberAgents")
      .withIndex("by_group_instance_agent", (q) =>
        q.eq("groupId", groupId).eq("instanceName", instanceName).eq("agentId", agentId),
      )
      .take(MEMBER_CLEANUP_BATCH);
    for (const r of allowances) await ctx.db.delete(r._id);
  }
  return defaults.length < MEMBER_CLEANUP_BATCH && allowances.length < MEMBER_CLEANUP_BATCH;
}

/**
 * An agent left ONE group: ENQUEUE the clearing of what its members kept about it — a
 * DURABLE job (a `groupMemberCleanups` row run by groupMemberCleanup.runMemberCleanup,
 * one bounded batch per run). Nothing is cleared in the caller's transaction: a bulk
 * unshare of hundreds of agents costs one insert per agent, never a batch per agent
 * (codex pass 6). Idempotent: a second call for the same (group, instance, agent)
 * reuses the pending row.
 *
 * Correct while it runs: a default or an allowance for an agent the group no longer
 * shares is ignored at read time (agents.ts effective grants). What it protects is
 * the RE-SHARE — refused while the row is here (assertNoPendingMemberCleanup), so an
 * old per-member choice never comes back with it.
 */
export async function scheduleMemberCleanup(
  ctx: MutationCtx,
  groupId: Id<"groups">,
  instanceName: string,
  agentId: string | null,
): Promise<void> {
  const pending = await pendingMemberCleanup(ctx, groupId, instanceName, agentId);
  if (pending !== null) return; // its chain is already running
  const cleanupId = await ctx.db.insert("groupMemberCleanups", {
    groupId,
    instanceName,
    ...(agentId !== null ? { agentId } : {}),
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.groupMemberCleanup.runMemberCleanup, { cleanupId });
}

async function pendingMemberCleanup(
  ctx: MutationCtx,
  groupId: Id<"groups">,
  instanceName: string,
  agentId: string | null,
) {
  return await ctx.db
    .query("groupMemberCleanups")
    .withIndex("by_group_instance_agent", (q) =>
      q.eq("groupId", groupId).eq("instanceName", instanceName).eq("agentId", agentId ?? undefined),
    )
    .first();
}

/** How many cleanup batches one mutation may run while sharing — SHARED across every
 *  agent a bulk share touches, so the mutation stays bounded however many it shares. */
export type CleanupBudget = { batches: number };
export const newCleanupBudget = (): CleanupBudget => ({ batches: 2 });

/** Before sharing (instance, agent) with a group: a cleanup it still owes there (for
 *  that agent, or for the whole instance) is finished first — a batch, if the budget
 *  allows one — or the share is refused, retryable, rather than letting old
 *  per-member choices return. */
export async function assertNoPendingMemberCleanup(
  ctx: MutationCtx,
  groupId: Id<"groups">,
  instanceName: string,
  agentId: string,
  budget: CleanupBudget = newCleanupBudget(),
): Promise<void> {
  for (const scope of [agentId, null] as const) {
    const row = await pendingMemberCleanup(ctx, groupId, instanceName, scope);
    if (row === null) continue;
    if (budget.batches > 0) {
      budget.batches -= 1;
      if (await memberCleanupBatch(ctx, groupId, instanceName, scope)) {
        await ctx.db.delete(row._id);
        continue;
      }
    }
    throw new ConvexError({ code: MEMBER_CLEANUP_PENDING });
  }
}

/** An agent leaves ONE group: drop every member's allowance for it and every
 *  member default pointing at it (bounded now, the rest resumably), so re-sharing it
 *  later never silently restores an old per-member choice. */
export async function unshareAgentFromMembers(
  ctx: MutationCtx,
  groupId: Id<"groups">,
  instanceName: string,
  agentId: string,
): Promise<void> {
  await scheduleMemberCleanup(ctx, groupId, instanceName, agentId);
}
