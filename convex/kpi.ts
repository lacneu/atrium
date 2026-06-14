// KPI rollups (increment 4).
//
// D1 (storage split): `traceEvents` is the BOUNDED recent firehose; this module
// aggregates that window into the SMALL, long-lived `kpiRollups` table. An
// hourly cron (crons.ts -> internal.kpi.rollupKpis) recomputes the rollups for
// every hour bucket touched by the scan window.
//
// D2 (PHI): rollups read trace METADATA only (kind/status/latency + the non-PHI
// `meta` flags written by the trace producers). Message text (`messages.text`)
// is NEVER read here — `traceEvents` are already redacted by design.
//
// Recompute model (load-bearing): the hourly cron re-scans the same recent
// window every run, so it MUST be idempotent. We aggregate the window into
// per-(bucket,metric) counts IN MEMORY, then UPSERT by REPLACING each stored
// `value` (insert if absent, patch to the recomputed value if present). We
// never `+=` a stored value — that would double-count on every overlapping run.

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  QueryCtx,
  MutationCtx,
} from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { requirePermission } from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { filterValidator, type Filter } from "./lib/filters";

// How many full hours back the rollup recomputes. The cutoff is snapped to an
// hour BOUNDARY so every COMPLETED bucket in range is always scanned in full
// (a non-boundary cutoff would leave the oldest bucket perpetually undercounted).
const ROLLUP_WINDOW_HOURS = 3;
// Bounded scan cap (mirror observability's bounded-window discipline — never an
// unbounded scan). A 3h window of trace metadata stays well under this.
const MAX_SCAN = 5000;

// Default page size for the rollup listings.
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

// Stable metric keys. Mirrors the increment-4 contract; keep this the single
// source so the cron, the query, and the test cannot drift.
export const KPI_METRICS = {
  API_CALLS: "api.calls",
  API_ERRORS: "api.errors",
  API_LATENCY_AVG_MS: "api.latency.avg_ms",
  OPENCLAW_INGEST: "openclaw.ingest",
  CHAT_SEND: "chat.send",
  ASSISTANT_STREAM_ERRORS: "assistant.stream.errors",
} as const;

/** The hour bucket an event belongs to, e.g. 1717336800000 -> "2026-06-02T14". */
function hourBucket(at: number): string {
  return new Date(at).toISOString().slice(0, 13);
}

/** Per-bucket running aggregates accumulated over the scan window. */
type BucketAgg = {
  apiCalls: number;
  apiErrors: number;
  apiLatencySum: number;
  apiLatencyCount: number;
  openclawIngest: number;
  chatSend: number;
  streamErrors: number;
};

function emptyAgg(): BucketAgg {
  return {
    apiCalls: 0,
    apiErrors: 0,
    apiLatencySum: 0,
    apiLatencyCount: 0,
    openclawIngest: 0,
    chatSend: 0,
    streamErrors: 0,
  };
}

/**
 * Is this an `assistant.stream` finalize whose lifecycle status is error/aborted?
 * phase + streamStatus live in the non-PHI `meta` JSON (the `status` column is
 * numeric, see observability.ts). Parse defensively — a malformed/absent meta is
 * simply not counted.
 */
function isStreamError(row: Doc<"traceEvents">): boolean {
  if (row.kind !== "assistant.stream" || row.meta === undefined) return false;
  try {
    const m = JSON.parse(row.meta) as {
      phase?: string;
      streamStatus?: string;
    };
    return (
      m.phase === "finalize" &&
      (m.streamStatus === "error" || m.streamStatus === "aborted")
    );
  } catch {
    return false;
  }
}

/** Fold a single trace row into its bucket aggregate. */
function accumulate(agg: BucketAgg, row: Doc<"traceEvents">): void {
  switch (row.kind) {
    case "api.call": {
      agg.apiCalls += 1;
      if (row.status !== undefined && row.status >= 400) agg.apiErrors += 1;
      if (row.latencyMs !== undefined) {
        agg.apiLatencySum += row.latencyMs;
        agg.apiLatencyCount += 1;
      }
      break;
    }
    case "openclaw.ingest": {
      // Exact match only: `openclaw.ingest.denied` / `openclaw.dispatch` are
      // distinct kinds and must NOT be conflated.
      agg.openclawIngest += 1;
      break;
    }
    case "chat.send": {
      agg.chatSend += 1;
      break;
    }
    case "assistant.stream": {
      if (isStreamError(row)) agg.streamErrors += 1;
      break;
    }
    default:
      break;
  }
}

/**
 * Recompute KPI rollups for every hour bucket in the bounded recent window.
 *
 * Idempotent by construction: aggregates in memory, then UPSERTS by REPLACING
 * the stored `value` per (bucket, metric). Running it twice over the same window
 * yields identical rows (never doubled). Driven by the hourly cron; safe to
 * invoke directly.
 */
export const rollupKpis = internalMutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ scanned: number; buckets: number; rows: number }> => {
    // Snap the cutoff to a full-hour boundary N hours back so every completed
    // bucket in range is scanned in full (no perpetually-undercounted bucket).
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    const cutoff = Math.floor(now / hourMs) * hourMs - ROLLUP_WINDOW_HOURS * hourMs;

    const rows = await ctx.db
      .query("traceEvents")
      .withIndex("by_at", (q) => q.gte("at", cutoff))
      .order("asc")
      .take(MAX_SCAN);

    // Bucket -> aggregate. Each event lands in its OWN hour bucket; the window
    // straddles hour boundaries so a single "current hour" would drop events.
    const byBucket = new Map<string, BucketAgg>();
    for (const row of rows) {
      const bucket = hourBucket(row.at);
      let agg = byBucket.get(bucket);
      if (agg === undefined) {
        agg = emptyAgg();
        byBucket.set(bucket, agg);
      }
      accumulate(agg, row);
    }

    // UPSERT each (bucket, metric) as a REPLACE of the computed value.
    let written = 0;
    for (const [bucket, agg] of byBucket) {
      const avgLatency =
        agg.apiLatencyCount > 0
          ? Math.round(agg.apiLatencySum / agg.apiLatencyCount)
          : 0;
      const metricValues: Array<[string, number]> = [
        [KPI_METRICS.API_CALLS, agg.apiCalls],
        [KPI_METRICS.API_ERRORS, agg.apiErrors],
        [KPI_METRICS.API_LATENCY_AVG_MS, avgLatency],
        [KPI_METRICS.OPENCLAW_INGEST, agg.openclawIngest],
        [KPI_METRICS.CHAT_SEND, agg.chatSend],
        [KPI_METRICS.ASSISTANT_STREAM_ERRORS, agg.streamErrors],
      ];
      for (const [metric, value] of metricValues) {
        await upsertRollup(ctx, bucket, metric, value);
        written += 1;
      }
    }

    return { scanned: rows.length, buckets: byBucket.size, rows: written };
  },
});

/**
 * UPSERT a single rollup by (bucket, metric): insert if absent, otherwise patch
 * the existing row's `value` to the recomputed total. REPLACE semantics — never
 * an additive `+=` (the window overlaps across cron runs).
 */
async function upsertRollup(
  ctx: MutationCtx,
  bucket: string,
  metric: string,
  value: number,
): Promise<void> {
  const existing = await ctx.db
    .query("kpiRollups")
    .withIndex("by_bucket_metric", (q) =>
      q.eq("bucket", bucket).eq("metric", metric),
    )
    .unique();
  if (existing === null) {
    await ctx.db.insert("kpiRollups", { bucket, metric, value });
  } else if (existing.value !== value) {
    await ctx.db.patch(existing._id, { value });
  }
}

/** Stable view of a rollup row (UI + API consumers). */
type KpiRollupView = {
  _id: Doc<"kpiRollups">["_id"];
  bucket: string;
  metric: string;
  value: number;
  dims: string | null;
};

function toView(r: Doc<"kpiRollups">): KpiRollupView {
  return {
    _id: r._id,
    bucket: r.bucket,
    metric: r.metric,
    value: r.value,
    dims: r.dims ?? null,
  };
}

/** The hour bucket a ms timestamp falls in, e.g. 1717336800000 -> "2026-06-02T14". */
function bucketOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

/**
 * Fetch recent rollups, newest bucket first. Shared core for the admin query and
 * the key-authed API path (mirrors observability.fetchRecentEvents). The
 * `by_bucket_metric` index sorts by bucket then metric; ISO hour strings sort
 * lexicographically == chronologically, so `.order("desc")` is newest-first.
 *
 * `metric` filters to one metric (uses the index prefix-free, so it is applied
 * in memory over a bounded scan); `since` keeps only buckets >= the given hour
 * bucket string (e.g. "2026-06-02T00").
 *
 * Filtering (KPI is the odd resource): its time field is a STRING hour bucket,
 * NOT a numeric `at`, so the generic numeric time path does not apply. A
 * `filter.from`/`filter.to` (epoch ms) is converted to its hour bucket and
 * range-compared against `bucket`; `filter.metric` reconciles with the `metric`
 * arg (both ANDed). The `q`/advanced clauses do not apply to KPI (no search
 * fields). NOTE (D1): a `filter.from` older than the bounded rollup history
 * returns PARTIAL results.
 */
async function fetchKpis(
  ctx: QueryCtx,
  opts: { limit?: number; metric?: string; since?: string; filter?: Filter },
): Promise<KpiRollupView[]> {
  // L3: clamp to a non-negative integer so a negative/non-integer ?limit can
  // never reach `.take()` (which Convex rejects -> a 500 in the http route).
  const limit = clampLimit(opts.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const filter = opts.filter;
  // KPI's quick filter (`metric`) is the dedicated `metric` arg (HTTP `?metric=`);
  // the shared Filter only contributes the time range for this resource.
  const metric = opts.metric;
  // Convert the filter's epoch-ms bounds into hour-bucket strings (KPI's time
  // field). `from` AND the existing string `since` are both lower bounds.
  const fromBucket =
    filter?.from !== undefined ? bucketOf(filter.from) : undefined;
  const toBucket = filter?.to !== undefined ? bucketOf(filter.to) : undefined;
  const lowerBound =
    opts.since !== undefined && fromBucket !== undefined
      ? opts.since > fromBucket
        ? opts.since
        : fromBucket
      : (opts.since ?? fromBucket);
  // Over-fetch when filtering so the post-filter still fills `limit` (bounded).
  const filtering =
    metric !== undefined ||
    lowerBound !== undefined ||
    toBucket !== undefined;
  const scan = filtering
    ? Math.min(Math.max(limit, 1) * 6, MAX_LIST_LIMIT)
    : limit;
  const rows = await ctx.db
    .query("kpiRollups")
    .withIndex("by_bucket_metric")
    .order("desc")
    .take(scan);
  let filtered = rows;
  if (metric) filtered = filtered.filter((r) => r.metric === metric);
  if (lowerBound) filtered = filtered.filter((r) => r.bucket >= lowerBound);
  if (toBucket) filtered = filtered.filter((r) => r.bucket <= toBucket);
  return filtered.slice(0, limit).map(toView);
}

/** Clamp an optional numeric limit to a non-negative integer within [0, max]. */
function clampLimit(
  raw: number | undefined,
  fallback: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  return Math.min(Math.max(0, Math.floor(raw)), max);
}

/**
 * Admin-only rollup listing (for the KPI dashboard UI, a later increment). The
 * key-authed principal path does NOT go through here — see `kpisInternal`.
 */
export const listKpis = query({
  args: {
    limit: v.optional(v.number()),
    metric: v.optional(v.string()),
    since: v.optional(v.string()),
    filter: v.optional(filterValidator),
  },
  handler: async (ctx, { limit, metric, since, filter }) => {
    // Per-tab RBAC: KPI readable by any user granted kpi.read (admins via wildcard).
    await requirePermission(ctx, PERMISSIONS.KPI_READ);
    return await fetchKpis(ctx, { limit, metric, since, filter });
  },
});

/**
 * Internal rollup listing for the key-authed /api/v1/kpi route. The httpAction
 * verifies the principal's `kpi.read` permission BEFORE calling this (the check
 * cannot run in the httpAction's no-db context). NOT publicly callable. Mirrors
 * observability.recentEventsInternal.
 */
export const kpisInternal = internalQuery({
  args: {
    limit: v.optional(v.number()),
    metric: v.optional(v.string()),
    since: v.optional(v.string()),
    filter: v.optional(filterValidator),
  },
  handler: async (ctx, { limit, metric, since, filter }) => {
    return await fetchKpis(ctx, { limit, metric, since, filter });
  },
});
