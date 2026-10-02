// The durable continuation of lib/groupMembers.scheduleMemberCleanup: one bounded
// batch per run, rescheduled until the agent that left the group is gone from every
// member's default and allowances, then the pending row is deleted (which re-opens
// sharing that agent with the group).

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { memberCleanupBatch } from "./lib/groupMembers";

export const runMemberCleanup = internalMutation({
  args: { cleanupId: v.id("groupMemberCleanups") },
  handler: async (ctx, { cleanupId }) => {
    const row = await ctx.db.get(cleanupId);
    if (row === null) return null; // finished by a share, or by a previous run
    if (await memberCleanupBatch(ctx, row.groupId, row.instanceName, row.agentId ?? null)) {
      await ctx.db.delete(cleanupId);
      return null;
    }
    await ctx.scheduler.runAfter(0, internal.groupMemberCleanup.runMemberCleanup, { cleanupId });
    return null;
  },
});
