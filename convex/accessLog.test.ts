/// <reference types="vite/client" />
//
// Durable access log (SOC2 CC6.1/CC7.2). Pins: recordEvent DUAL-writes an
// `api.call` to the long-retention accessLog (and to traceEvents as before);
// a non-api.call kind does NOT touch accessLog; the access-log purge drops rows
// past the retention horizon. METADATA ONLY (no content fields exist on the row).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("durable access log", () => {
  test("api.call dual-writes to accessLog + traceEvents; other kinds don't", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: "svc1",
      roleKey: "agent",
      route: "/api/v1/chat-state",
      method: "GET",
      status: 200,
      chatId: "chat-abc",
      latencyMs: 12,
    });
    await t.mutation(internal.observability.recordEvent, {
      kind: "openclaw.dispatch",
      direction: "outbound",
      principalType: "system",
      principalId: "bridge",
    });

    await t.run(async (ctx) => {
      const access = await ctx.db.query("accessLog").collect();
      expect(access).toHaveLength(1); // ONLY the api.call
      expect(access[0]).toMatchObject({
        principalId: "svc1",
        route: "/api/v1/chat-state",
        chatId: "chat-abc",
        status: 200,
      });
      // The trace copy still exists too (viewer unchanged).
      const traces = await ctx.db.query("traceEvents").collect();
      expect(traces.filter((e) => e.kind === "api.call")).toHaveLength(1);
    });
  });

  test("purge drops access-log rows past the retention horizon, keeps recent", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("accessLog", {
        at: Date.now() - 200 * 24 * 60 * 60 * 1000, // 200d ago -> expired (>90d)
        principalId: "old",
      });
      await ctx.db.insert("accessLog", {
        at: Date.now() - 60 * 60 * 1000, // 1h ago -> kept
        principalId: "fresh",
      });
    });
    const res = await t.mutation(internal.observability.purgeOldAccessLog, {});
    expect(res.deleted).toBe(1);
    const remaining = await t.run((ctx) => ctx.db.query("accessLog").collect());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.principalId).toBe("fresh");
  });
});
