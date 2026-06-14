/// <reference types="vite/client" />
//
// Deterministic unit test for the KPI rollup aggregation (increment 4).
//
// No auth simulation: we seed a handful of `traceEvents` directly in db context
// (timestamps relative to Date.now() so they fall inside the scan window), run
// internal.kpi.rollupKpis, and assert the per-metric counts. We also run the
// rollup TWICE to prove it is idempotent (REPLACE semantics, never doubled).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { KPI_METRICS } from "./kpi";

// Discover function modules for convex-test (required).
const modules = import.meta.glob("./**/*.ts");

/** Helper: insert a trace event with the required `redacted` flag. */
type SeedEvent = {
  at: number;
  kind: string;
  status?: number;
  latencyMs?: number;
  meta?: string;
};

async function readRollups(t: ReturnType<typeof convexTest>) {
  // Read all rollups via the internal query (no auth needed), keyed by metric.
  const rows = await t.query(internal.kpi.kpisInternal, { limit: 1000 });
  const byMetric = new Map<string, number>();
  for (const r of rows) {
    // The test seeds a single hour bucket, so one row per metric.
    byMetric.set(r.metric, r.value);
  }
  return byMetric;
}

describe("kpi rollups", () => {
  test("rollupKpis aggregates trace metadata into per-metric counts", async () => {
    const t = convexTest(schema, modules);

    // Anchor all events to the same recent minute so they share one hour bucket
    // and fall well within the scan window.
    const now = Date.now();
    const events: SeedEvent[] = [
      // 3 api.call (1 error, latencies 100/200/300 -> avg 200).
      { at: now, kind: "api.call", status: 200, latencyMs: 100 },
      { at: now, kind: "api.call", status: 200, latencyMs: 200 },
      { at: now, kind: "api.call", status: 500, latencyMs: 300 },
      // 2 openclaw.ingest (+ 1 .denied that must NOT be counted).
      { at: now, kind: "openclaw.ingest" },
      { at: now, kind: "openclaw.ingest" },
      { at: now, kind: "openclaw.ingest.denied" },
      // 4 chat.send.
      { at: now, kind: "chat.send" },
      { at: now, kind: "chat.send" },
      { at: now, kind: "chat.send" },
      { at: now, kind: "chat.send" },
      // assistant.stream: 1 finalize error + 1 finalize aborted = 2 errors;
      // a finalize complete + a start must NOT count.
      {
        at: now,
        kind: "assistant.stream",
        meta: JSON.stringify({ phase: "finalize", streamStatus: "error" }),
      },
      {
        at: now,
        kind: "assistant.stream",
        meta: JSON.stringify({ phase: "finalize", streamStatus: "aborted" }),
      },
      {
        at: now,
        kind: "assistant.stream",
        meta: JSON.stringify({ phase: "finalize", streamStatus: "complete" }),
      },
      {
        at: now,
        kind: "assistant.stream",
        meta: JSON.stringify({ phase: "start", streamStatus: "streaming" }),
      },
    ];

    await t.run(async (ctx) => {
      for (const e of events) {
        await ctx.db.insert("traceEvents", {
          at: e.at,
          kind: e.kind,
          principalType: "system",
          status: e.status,
          latencyMs: e.latencyMs,
          redacted: true,
          meta: e.meta,
        });
      }
    });

    await t.mutation(internal.kpi.rollupKpis, {});
    const first = await readRollups(t);

    expect(first.get(KPI_METRICS.API_CALLS)).toBe(3);
    expect(first.get(KPI_METRICS.API_ERRORS)).toBe(1);
    expect(first.get(KPI_METRICS.API_LATENCY_AVG_MS)).toBe(200);
    expect(first.get(KPI_METRICS.OPENCLAW_INGEST)).toBe(2);
    expect(first.get(KPI_METRICS.CHAT_SEND)).toBe(4);
    expect(first.get(KPI_METRICS.ASSISTANT_STREAM_ERRORS)).toBe(2);

    // Idempotency: a second overlapping run REPLACES (never doubles) the values.
    await t.mutation(internal.kpi.rollupKpis, {});
    const second = await readRollups(t);
    expect(second.get(KPI_METRICS.API_CALLS)).toBe(3);
    expect(second.get(KPI_METRICS.CHAT_SEND)).toBe(4);
    expect(second.get(KPI_METRICS.OPENCLAW_INGEST)).toBe(2);
    expect(second.get(KPI_METRICS.ASSISTANT_STREAM_ERRORS)).toBe(2);
    expect(second.get(KPI_METRICS.API_ERRORS)).toBe(1);
    expect(second.get(KPI_METRICS.API_LATENCY_AVG_MS)).toBe(200);
  });
});
