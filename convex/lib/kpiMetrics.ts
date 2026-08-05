// Stable KPI metric keys — the CONTRACT between the rollup that writes them and
// every reader that displays them.
//
// A PURE module, deliberately: the admin dashboard sizes its row budget from
// this list, and it must not pull the Convex server runtime into the client
// bundle to do it. It lived inside convex/kpi.ts and the dashboard kept its own
// hand-maintained count instead — which silently drifted below the real number
// of metrics per bucket and shrank the visible window (codex 0.71.6).
// Stable metric keys. Mirrors the increment-4 contract; keep this the single
// source so the cron, the query, and the test cannot drift.
export const KPI_METRICS = {
  API_CALLS: "api.calls",
  API_ERRORS: "api.errors",
  API_LATENCY_AVG_MS: "api.latency.avg_ms",
  OPENCLAW_INGEST: "openclaw.ingest",
  CHAT_SEND: "chat.send",
  ASSISTANT_STREAM_ERRORS: "assistant.stream.errors",
  // Failed sub-agent REPORT deliveries, apart from the turn metric above. Folded
  // together, a burst of internal delivery failures read as users not getting
  // their replies — the chart said the product was failing while every reply had
  // arrived (live prod 2026-08-04).
  ASSISTANT_ANNOUNCE_ERRORS: "assistant.announce.errors",
  // Server-side query EXECUTION latency from the synthetic probe (metricsProbe.ts)
  // — a backend-load proxy that is comparable across a NAS↔Cloud migration
  // (fixed-cadence, traffic-independent). NOT full client-perceived latency.
  CONVEX_PROBE_LATENCY_AVG_MS: "convex.probe.latency.avg_ms",
} as const;

/** How many rows one bucket occupies — every metric is written once per bucket.
 *  DERIVED, never restated: a reader that hardcodes it under-sizes its window
 *  the day a metric is added. */
export const KPI_METRIC_COUNT = Object.keys(KPI_METRICS).length;
