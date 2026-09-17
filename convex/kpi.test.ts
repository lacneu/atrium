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
import { KPI_METRIC_COUNT } from "./lib/kpiMetrics";

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
      // 3 backend-latency probe samples (150/250/350 -> avg 250). A probe row
      // WITHOUT latencyMs must NOT skew the average (count stays 3).
      { at: now, kind: "convex.probe", latencyMs: 150 },
      { at: now, kind: "convex.probe", latencyMs: 250 },
      { at: now, kind: "convex.probe", latencyMs: 350 },
      { at: now, kind: "convex.probe" },
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
    // Probe latency averages ONLY the rows that carry latencyMs (150/250/350).
    expect(first.get(KPI_METRICS.CONVEX_PROBE_LATENCY_AVG_MS)).toBe(250);

    // Idempotency: a second overlapping run REPLACES (never doubles) the values.
    await t.mutation(internal.kpi.rollupKpis, {});
    const second = await readRollups(t);
    expect(second.get(KPI_METRICS.API_CALLS)).toBe(3);
    expect(second.get(KPI_METRICS.CHAT_SEND)).toBe(4);
    expect(second.get(KPI_METRICS.OPENCLAW_INGEST)).toBe(2);
    expect(second.get(KPI_METRICS.ASSISTANT_STREAM_ERRORS)).toBe(2);
    expect(second.get(KPI_METRICS.API_ERRORS)).toBe(1);
    expect(second.get(KPI_METRICS.API_LATENCY_AVG_MS)).toBe(200);
    expect(second.get(KPI_METRICS.CONVEX_PROBE_LATENCY_AVG_MS)).toBe(250);
  });
});

// THE CHART AND THE ALARM AGREE ON WHAT A FAILURE WAS.
describe("kpi splits report deliveries from turns", () => {
  test("a burst of failed sub-agent reports leaves the turn metric at zero", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      const errorMeta = JSON.stringify({
        phase: "finalize",
        streamStatus: "error",
      });
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("traceEvents", {
          at: now,
          kind: "assistant.stream",
          principalType: "system",
          redacted: true,
          correlationId: `chatZ:announce:v1:agent:z:subagent:c${i}:r${i}`,
          meta: errorMeta,
        });
      }
      // One real turn fails: that one IS a user-visible failure.
      await ctx.db.insert("traceEvents", {
        at: now,
        kind: "assistant.stream",
        principalType: "system",
        redacted: true,
        correlationId: "chatZ:run-plain",
        meta: errorMeta,
      });
    });
    await t.mutation(internal.kpi.rollupKpis, {});
    const rollups = await readRollups(t);
    expect(
      rollups.get(KPI_METRICS.ASSISTANT_STREAM_ERRORS) ?? 0,
      "internal report deliveries are charted as users not getting replies",
    ).toBe(1);
    expect(rollups.get(KPI_METRICS.ASSISTANT_ANNOUNCE_ERRORS) ?? 0).toBe(3);
  });

  test("a delivery whose file landed LATE is charted as delivered", async () => {
    // The platform names a contentless delivery `empty_response` at the final and
    // takes the card back when the file arrives afterwards. The chart reads
    // traces, so the repair has to reach it — and the point has to come off the
    // hour that CARRIED it, even when the file lands in the next hour.
    const sumAnnounceErrors = async (t: ReturnType<typeof convexTest>) => {
      const rows = await t.query(internal.kpi.kpisInternal, { limit: 1000 });
      return rows
        .filter((r) => r.metric === KPI_METRICS.ASSISTANT_ANNOUNCE_ERRORS)
        .reduce((n, r) => n + r.value, 0);
    };
    const CORR = "chatR:announce:v1:agent:r:subagent:c1:r1";
    const seed = async (
      t: ReturnType<typeof convexTest>,
      rows: Array<{ at: number; corr: string; phase: string }>,
    ) => {
      await t.run(async (ctx) => {
        for (const r of rows) {
          await ctx.db.insert("traceEvents", {
            at: r.at,
            kind: "assistant.stream",
            principalType: "system",
            redacted: true,
            correlationId: r.corr,
            meta: JSON.stringify({
              phase: r.phase,
              streamStatus: r.phase === "finalize" ? "error" : "complete",
              errorCode: "empty_response",
            }),
          });
        }
      });
      await t.mutation(internal.kpi.rollupKpis, {});
    };

    // Same hour.
    const now = Date.now();
    const t1 = convexTest(schema, modules);
    await seed(t1, [
      { at: now, corr: CORR, phase: "finalize" },
      { at: now, corr: CORR, phase: "finalize_repaired" },
    ]);
    expect(await sumAnnounceErrors(t1)).toBe(0);

    // The file lands in the NEXT hour: the corrected bar is the failure's.
    const t2 = convexTest(schema, modules);
    await seed(t2, [
      { at: now - 90 * 60 * 1000, corr: CORR, phase: "finalize" },
      { at: now, corr: CORR, phase: "finalize_repaired" },
    ]);
    expect(
      await sumAnnounceErrors(t2),
      "the outage stays on the hour the delivery failed in",
    ).toBe(0);

    // The bar was ALREADY published before the file landed: the next rollup has
    // to rewrite that hour, not merely stop adding to it.
    const t2b = convexTest(schema, modules);
    await seed(t2b, [{ at: now, corr: CORR, phase: "finalize" }]);
    expect(await sumAnnounceErrors(t2b)).toBe(1);
    await seed(t2b, [{ at: now, corr: CORR, phase: "finalize_repaired" }]);
    expect(
      await sumAnnounceErrors(t2b),
      "a point already written survives the repair",
    ).toBe(0);

    // TWO failures of the same class on one correlation (a resumed announce that
    // failed the same way twice): the repair answers the one that was on screen
    // when the file landed — the MOST RECENT — so the recent hour is corrected
    // and the older point, which was a real failure at the time, stays.
    const t2c = convexTest(schema, modules);
    const older = now - 90 * 60 * 1000;
    await seed(t2c, [
      { at: older, corr: CORR, phase: "finalize" },
      { at: now - 60_000, corr: CORR, phase: "finalize" },
      { at: now, corr: CORR, phase: "finalize_repaired" },
    ]);
    const rows2c = await t2c.query(internal.kpi.kpisInternal, { limit: 1000 });
    const announceByBucket = new Map(
      rows2c
        .filter((r) => r.metric === KPI_METRICS.ASSISTANT_ANNOUNCE_ERRORS)
        .map((r) => [r.bucket, r.value]),
    );
    const hour = (at: number) =>
      new Date(Math.floor(at / (60 * 60 * 1000)) * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 13);
    expect(
      announceByBucket.get(hour(now)) ?? 0,
      "the repaired hour is the one the reader's card was in",
    ).toBe(0);
    expect(announceByBucket.get(hour(older)) ?? 0).toBe(1);

    // A failure written AFTER the repair is a NEW one (the bubble was reopened by
    // a rebroadcast and failed again): an earlier repair cannot answer it.
    const t2d = convexTest(schema, modules);
    await seed(t2d, [
      { at: older, corr: CORR, phase: "finalize" },
      { at: older + 60_000, corr: CORR, phase: "finalize_repaired" },
      { at: now, corr: CORR, phase: "finalize" },
    ]);
    const rows2d = await t2d.query(internal.kpi.kpisInternal, { limit: 1000 });
    const byBucket2d = new Map(
      rows2d
        .filter((r) => r.metric === KPI_METRICS.ASSISTANT_ANNOUNCE_ERRORS)
        .map((r) => [r.bucket, r.value]),
    );
    expect(byBucket2d.get(hour(older)) ?? 0).toBe(0);
    expect(
      byBucket2d.get(hour(now)) ?? 0,
      "a failure that came after the repair is still a failure",
    ).toBe(1);

    // …including at the SAME millisecond: two writes can share a timestamp, and
    // the one that came after the compensation is a new failure.
    const t2e = convexTest(schema, modules);
    await seed(t2e, [
      { at: now, corr: CORR, phase: "finalize_repaired" },
      { at: now, corr: CORR, phase: "finalize" },
    ]);
    expect(
      await sumAnnounceErrors(t2e),
      "a repair swallowed a failure written after it, same millisecond",
    ).toBe(1);

    // TWO repairs on the same pair answer TWO failures — the second one may not
    // land on the failure the first already took out.
    const t2f = convexTest(schema, modules);
    await seed(t2f, [
      { at: older, corr: CORR, phase: "finalize" },
      { at: now - 60_000, corr: CORR, phase: "finalize" },
      { at: now, corr: CORR, phase: "finalize_repaired" },
      { at: now, corr: CORR, phase: "finalize_repaired" },
    ]);
    expect(
      await sumAnnounceErrors(t2f),
      "the second repair answered a failure that was already answered",
    ).toBe(0);

    // A repair that answers ANOTHER failure cancels nothing here either: the
    // chart and the alarm apply one rule, through one helper.
    const t3 = convexTest(schema, modules);
    await seed(t3, [
      { at: now, corr: CORR, phase: "finalize" },
      {
        at: now,
        corr: "chatR:announce:v1:agent:r:subagent:c2:r2",
        phase: "finalize_repaired",
      },
    ]);
    expect(await sumAnnounceErrors(t3)).toBe(1);
  });

  test("a report the USER stopped is not charted as a lost report", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      // One Stop aborts every child announce at once (the Stop epoch): three
      // aborts here are ONE click, not three delivery outages.
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("traceEvents", {
          at: now,
          kind: "assistant.stream",
          principalType: "system",
          redacted: true,
          correlationId: `chatS:announce:v1:agent:s:subagent:c${i}:r${i}`,
          meta: JSON.stringify({
            phase: "finalize",
            streamStatus: "aborted",
          }),
        });
      }
    });
    await t.mutation(internal.kpi.rollupKpis, {});
    const rollups = await readRollups(t);
    expect(
      rollups.get(KPI_METRICS.ASSISTANT_ANNOUNCE_ERRORS) ?? 0,
      "one Stop reads as a delivery outage on the chart",
    ).toBe(0);
  });
});

// THE WINDOW A READER CAN ASK FOR IS SIZED ON THIS NUMBER.
//
// The admin dashboard turns hours into a ROW budget by multiplying by the
// metrics-per-bucket count. Kept by hand it drifted below the real number and
// silently shortened the visible window — the chart lost its oldest buckets
// with nothing to show it had. This measures the rollup instead of trusting it.
describe("the metrics-per-bucket contract", () => {
  test("matches what a rollup actually writes into one bucket", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("traceEvents", {
        at: now,
        kind: "chat.send",
        principalType: "system",
        redacted: true,
      });
    });
    await t.mutation(internal.kpi.rollupKpis, {});
    const rows = await t.query(internal.kpi.kpisInternal, { limit: 1000 });
    const perBucket = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = perBucket.get(r.bucket) ?? new Set<string>();
      set.add(r.metric);
      perBucket.set(r.bucket, set);
    }
    const widest = Math.max(...[...perBucket.values()].map((s) => s.size));
    expect(
      KPI_METRIC_COUNT,
      "a reader sizing its window on this number under-fetches",
    ).toBe(widest);
  });
});
