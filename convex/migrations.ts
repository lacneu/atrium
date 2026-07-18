// One-time data migrations, operator-invoked via `npx convex run`.
//
// stampNullInstanceChats — the R1 backfill for the per-bridge ingest isolation
// rollout. `chats.instanceName` is OPTIONAL; the normal new-chat flow always
// stamps it (useStartNewChat) and dispatch REBINDS a legacy chat on its next
// turn (bindChatTarget), so null-primary chats are a LEGACY-ONLY residue. R2
// (per-bridge-only ingest) denies a null-primary chat, so this stamps them
// FIRST — using the SAME resolver dispatch would (`resolveTargetForChat`), so
// the stamp is behavior-preserving (exactly what the next dispatch would bind).
// A chat whose owner has no resolvable agent is left null: it cannot be
// dispatched, so no bridge will ever ingest for it — leaving it null denies
// nothing real. Idempotent + self-chaining: one invocation drains the table.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { resolveTargetForChat } from "./routing";

const BATCH = 200;

export const stampNullInstanceChats = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (
    ctx,
    { cursor },
  ): Promise<{ done: boolean; stamped: number; leftNull: number }> => {
    const page = await ctx.db
      .query("chats")
      .paginate({ numItems: BATCH, cursor: cursor ?? null });

    let stamped = 0;
    let leftNull = 0;
    for (const chat of page.page) {
      if (chat.instanceName !== undefined) continue; // already bound — skip
      const resolution = await resolveTargetForChat(ctx, chat, chat.userId);
      if (resolution.target === null) {
        // Underivable (no resolvable agent) → cannot be dispatched → no bridge
        // ingests for it → safe to leave null.
        leftNull++;
        continue;
      }
      await ctx.db.patch(chat._id, {
        instanceName: resolution.target.instanceName,
        agentId: resolution.target.agentId,
        // Behavior-preserving REQUIRES dropping the pre-binding provider
        // session too: without the migration, the next dispatch would rebind
        // via bindChatTarget, which clears it (a session minted before binding
        // may belong to a different agent than the resolved target).
        openclawChatId: undefined,
      });
      stamped++;
    }

    if (!page.isDone) {
      // Self-chain the next batch so ONE invocation drains the whole table.
      await ctx.scheduler.runAfter(0, internal.migrations.stampNullInstanceChats, {
        cursor: page.continueCursor,
      });
    }
    return { done: page.isDone, stamped, leftNull };
  },
});

// Confirm the rollout precondition BEFORE R2 (per-bridge-only): the count of
// chats still lacking an instance binding. R2 is safe to ship once this is the
// residual, underivable-only set (or zero). Convex allows only ONE paginated
// query per function, so this counts ONE page and returns the cursor; re-run
// with it (`{cursor}`) until `done` on a table larger than one page. For the
// legacy-only residue, one call covers it.
export const countNullInstanceChats = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (
    ctx,
    { cursor },
  ): Promise<{ nullInstance: number; scanned: number; done: boolean; cursor: string | null }> => {
    const page = await ctx.db
      .query("chats")
      .paginate({ numItems: 2048, cursor: cursor ?? null });
    return {
      nullInstance: page.page.filter((c) => c.instanceName === undefined).length,
      scanned: page.page.length,
      done: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});
