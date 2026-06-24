/// <reference types="vite/client" />
//
// The synthetic backend-latency probe records a `convex.probe` trace carrying a
// server-side execution latencyMs, content-free. We run the action and assert the
// trace shape (the rollup of these into convex.probe.latency.avg_ms is covered in
// kpi.test.ts).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("metricsProbe.runLatencyProbe", () => {
  test("records a content-free convex.probe trace with a numeric latencyMs", async () => {
    const t = convexTest(schema, modules);

    await t.action(internal.metricsProbe.runLatencyProbe, {});

    const probes = await t.run(async (ctx) =>
      ctx.db
        .query("traceEvents")
        .filter((q) => q.eq(q.field("kind"), "convex.probe"))
        .collect(),
    );

    expect(probes).toHaveLength(1);
    const probe = probes[0];
    // It carries a real, non-negative execution latency (the load signal).
    expect(typeof probe.latencyMs).toBe("number");
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
    expect(probe.principalType).toBe("system");
    // SOC2: meta is a probe label + a COUNT + ok flag — never message content.
    const meta = JSON.parse(probe.meta ?? "{}") as {
      probe?: string;
      rows?: number;
      ok?: boolean;
    };
    expect(meta.probe).toBe("read_window");
    expect(meta.ok).toBe(true);
    // Empty messages table in the test -> the probe read returns 0 rows (a COUNT,
    // proving the read ran and returned a number, not content).
    expect(meta.rows).toBe(0);
  });
});
