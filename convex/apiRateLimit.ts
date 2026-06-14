// Per-API-key rate limiting for the /api/v1 surface (SOC2 CC6.6).
//
// Threat (regulatory spec): a VALID key enumerating `chatId`s to fingerprint
// platform activity. The compensating controls are this limit + the per-call
// access trace (which logs the chatId). Fixed-window counter: one row per
// (principal, 1-min window), upserted per authenticated request. Checked inside
// authenticateApiKey so EVERY authenticated route is covered with no per-route
// wiring; the unauthenticated /health probe is exempt (it never authenticates).

import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Generous enough for interactive MCP/CLI debugging + an agent heartbeat, low
// enough that bulk chatId scraping trips it. A debug surface, not a data feed.
export const RATE_LIMIT_PER_WINDOW = 120;
export const RATE_WINDOW_MS = 60_000;
// Drop windows older than this in the purge (a few windows of slack for clock
// skew / in-flight reads). Tiny table regardless; this just bounds it.
const RATE_RETENTION_MS = 10 * 60_000;
const PURGE_BATCH = 200;

// UNAUTHENTICATED pre-resolution throttle (SOC2 CC6.6): a flood of bad/missing
// keys would otherwise amplify into one hashKey + findByHash DB read each. We
// gate it BEFORE findByHash, SHARDED by the presented-key hash across a FIXED
// number of buckets — so (a) the counter is never one hot row (OCC contention
// under the very flood it guards), and (b) random keys cannot bloat the table
// (cardinality is bounded to UNAUTH_SHARDS rows per window). Global budget ≈
// UNAUTH_SHARDS × per-shard; a distinct-key flood spreads across shards (each
// trips at ~budget), a single-key flood concentrates on one shard (trips fast).
export const UNAUTH_SHARDS = 16;
export const UNAUTH_PER_SHARD_PER_WINDOW = 60; // ≈ 960/min global, ~16/s

/** Deterministic shard for an UNAUTHENTICATED request, derived from the presented
 *  key hash (NOT random — Convex determinism + same key → same shard so a single
 *  abusive key is rate-limited coherently). Returns a stable principalId string. */
export function unauthShardKey(presentedHash: string): string {
  let acc = 0;
  for (let i = 0; i < presentedHash.length; i++) {
    acc = (acc * 31 + presentedHash.charCodeAt(i)) >>> 0;
  }
  return `__unauth_${acc % UNAUTH_SHARDS}`;
}

/**
 * Atomically count this principal's calls in the current fixed window and
 * report whether the call is allowed. One write per request (alongside the
 * existing lastUsedAt bump + api.call trace — same write tier). `limit`
 * defaults to the authenticated per-key cap; the unauthenticated gate passes
 * the (per-shard) UNAUTH_PER_SHARD_PER_WINDOW.
 */
export const checkApiRateLimit = internalMutation({
  args: { principalId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { principalId, limit }) => {
    const cap = limit ?? RATE_LIMIT_PER_WINDOW;
    const now = Date.now();
    const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
    const row = await ctx.db
      .query("apiRateLimits")
      .withIndex("by_principal_window", (q) =>
        q.eq("principalId", principalId).eq("windowStart", windowStart),
      )
      .unique();
    if (row === null) {
      await ctx.db.insert("apiRateLimits", { principalId, windowStart, count: 1 });
      return { allowed: true as const };
    }
    if (row.count >= cap) {
      return {
        allowed: false as const,
        retryAfterMs: windowStart + RATE_WINDOW_MS - now,
      };
    }
    await ctx.db.patch(row._id, { count: row.count + 1 });
    return { allowed: true as const };
  },
});

/** Bounded purge of expired rate-limit windows (cron). Re-schedules itself while
 *  a backlog remains, mirroring purgeOldTraces — never exceeds mutation limits. */
export const purgeOldRateLimits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RATE_RETENTION_MS;
    const stale = await ctx.db
      .query("apiRateLimits")
      .withIndex("by_window", (q) => q.lt("windowStart", cutoff))
      .take(PURGE_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
    if (stale.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.apiRateLimit.purgeOldRateLimits,
        {},
      );
    }
    return { purged: stale.length };
  },
});
