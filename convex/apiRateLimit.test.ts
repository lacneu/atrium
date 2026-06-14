/// <reference types="vite/client" />
//
// Per-key API rate limit (SOC2 CC6.6). Pins: a principal is allowed up to the
// window cap then blocked (429 signal); a DIFFERENT principal is independent;
// the purge drops expired windows.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  RATE_LIMIT_PER_WINDOW,
  UNAUTH_SHARDS,
  unauthShardKey,
} from "./apiRateLimit";

const modules = import.meta.glob("./**/*.ts");

describe("checkApiRateLimit", () => {
  test("allows up to the cap, then blocks; principals are independent", async () => {
    const t = convexTest(schema, modules);
    // Exhaust the window for principal A.
    for (let i = 0; i < RATE_LIMIT_PER_WINDOW; i++) {
      const r = await t.mutation(internal.apiRateLimit.checkApiRateLimit, {
        principalId: "svcA",
      });
      expect(r.allowed).toBe(true);
    }
    // The next call for A is blocked.
    const blocked = await t.mutation(internal.apiRateLimit.checkApiRateLimit, {
      principalId: "svcA",
    });
    expect(blocked.allowed).toBe(false);
    // A different principal is unaffected.
    const other = await t.mutation(internal.apiRateLimit.checkApiRateLimit, {
      principalId: "svcB",
    });
    expect(other.allowed).toBe(true);
  });

  test("custom limit (unauth shard) blocks at its own cap", async () => {
    const t = convexTest(schema, modules);
    const shard = unauthShardKey("deadbeefdeadbeef");
    for (let i = 0; i < 3; i++) {
      const r = await t.mutation(internal.apiRateLimit.checkApiRateLimit, {
        principalId: shard,
        limit: 3,
      });
      expect(r.allowed).toBe(true);
    }
    const blocked = await t.mutation(internal.apiRateLimit.checkApiRateLimit, {
      principalId: shard,
      limit: 3,
    });
    expect(blocked.allowed).toBe(false);
  });

  test("unauthShardKey: deterministic + bounded to the shard set", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const key = unauthShardKey(`hash-${i}-${i * 7}`);
      expect(key).toMatch(/^__unauth_\d+$/);
      const idx = Number(key.slice("__unauth_".length));
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(UNAUTH_SHARDS);
      seen.add(key);
    }
    // Cardinality is bounded to the shard count, never the (unbounded) key space.
    expect(seen.size).toBeLessThanOrEqual(UNAUTH_SHARDS);
    // Same hash -> same shard (coherent throttling of one abusive key).
    expect(unauthShardKey("abc")).toBe(unauthShardKey("abc"));
  });

  test("purge drops expired windows, keeps current", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("apiRateLimits", {
        principalId: "old",
        windowStart: now - 60 * 60_000, // 1h ago -> expired
        count: 5,
      });
      await ctx.db.insert("apiRateLimits", {
        principalId: "fresh",
        windowStart: Math.floor(now / 60_000) * 60_000, // current window
        count: 1,
      });
    });
    const res = await t.mutation(internal.apiRateLimit.purgeOldRateLimits, {});
    expect(res.purged).toBe(1);
    const remaining = await t.run((ctx) => ctx.db.query("apiRateLimits").collect());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.principalId).toBe("fresh");
  });
});
