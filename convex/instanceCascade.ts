// The scheduled half of instance deletion. `lib/instanceCascade` removes the
// instance row and its ID-bound credentials synchronously; everything keyed by the
// instance NAME is unbounded and is swept here, one bounded batch per scheduled
// pass, until nothing is left.
//
// Durability is the point of the `instanceCascades` job row: `scheduler.runAfter`
// survives a restart, but a pass that THROWS is not retried, and a half-swept
// deletion leaves user grants pointing at an instance that no longer exists —
// people keep seeing agents they can no longer reach. The job row makes that state
// visible and a cron re-arms it, so the sweep is eventually-complete rather than
// best-effort.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  closeCascadeJob,
  openCascadeJob,
  sweepInstanceNameBoundBatch,
} from "./lib/instanceCascade";

/** A sweep with no progress for this long is considered dropped and re-armed. */
const STALE_MS = 5 * 60 * 1000;
/** Jobs re-armed per cron tick. */
const REARM_BATCH = 20;

/**
 * One bounded pass, then re-arm itself while work remains.
 *
 * `openCascadeJob` runs on EVERY pass, not just the first: it refreshes the
 * progress stamp, which is what tells the reaper this chain is alive. A sweep that
 * is advancing must never look stalled, or two chains would run for one name.
 */
export const sweepInstanceCascade = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const verdict = await sweepInstanceNameBoundBatch(ctx, name);
    if (verdict === "more") {
      await openCascadeJob(ctx, name);
      await ctx.scheduler.runAfter(0, internal.instanceCascade.sweepInstanceCascade, {
        name,
      });
      return;
    }
    await closeCascadeJob(ctx, name);
  },
});

/**
 * Re-arm sweeps whose chain died. Reads only jobs whose progress stamp is older
 * than the staleness window, via the index — never the whole table.
 */
export const reapStalledCascades = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_MS;
    const stalled = await ctx.db
      .query("instanceCascades")
      .withIndex("by_updated", (query) =>
        // A LOWER BOUND is not optional: an absent field sorts BEFORE every
        // number in a Convex index, so `lt(cutoff)` alone would also select rows
        // that carry no stamp at all and re-arm work that is actively running.
        query.gte("updatedAt", 0).lt("updatedAt", cutoff),
      )
      .take(REARM_BATCH);
    for (const job of stalled) {
      // Stamp BEFORE scheduling: if two ticks overlap, the second sees a fresh
      // stamp and leaves this one alone.
      await ctx.db.patch(job._id, { updatedAt: Date.now() });
      await ctx.scheduler.runAfter(
        0,
        internal.instanceCascade.sweepInstanceCascade,
        { name: job.instanceName },
      );
    }
    return stalled.length;
  },
});
