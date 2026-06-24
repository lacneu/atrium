// Scheduled jobs.
//
// Retention sweep (D1): once a day, delete trace events older than
// TRACE_RETENTION_DAYS (default 14). purgeOldTraces processes one bounded batch
// and re-schedules itself if a backlog remains, so a single daily trigger
// drains any accumulation without exceeding mutation limits.
//
// KPI rollups (D1, increment 4): once an hour, aggregate the bounded recent
// trace window into the small, long-lived kpiRollups table. rollupKpis is
// idempotent (it REPLACES per-bucket values), so an overlapping recompute never
// double-counts.

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Daily at 03:00 UTC (quiet hour). Use crons.cron (not the daily/weekly
// helpers) per the Convex cron guideline.
crons.cron(
  "purge old trace events",
  "0 3 * * *",
  internal.observability.purgeOldTraces,
  {},
);

// Hourly at minute 0. Recomputes KPI rollups for the recent hour buckets.
crons.cron("rollup kpis", "0 * * * *", internal.kpi.rollupKpis, {});

// Backend-latency probe: every 5 minutes, time a fixed, identity-free, content-free
// READ and record its server-side execution latency (-> convex.probe.latency.avg_ms
// rollup). Fixed cadence makes it traffic-independent, so the latency trend is
// attributable to the BACKEND — a clean apples-to-apples NAS<->Convex-Cloud before/
// after. ~12 samples/hour. See convex/metricsProbe.ts.
crons.interval(
  "backend latency probe",
  { minutes: 5 },
  internal.metricsProbe.runLatencyProbe,
  {},
);

// Outbound trace shipping (increment 5): every 5 minutes, flush NEW trace events
// to whichever vendors (Langfuse/Opik) are configured via deployment env. A
// vendor with no env is a per-vendor no-op; the action never throws into the
// cron (best-effort egress — see integrations/ship.ts).
crons.interval(
  "flush traces to vendors",
  { minutes: 5 },
  internal.integrations.ship.flushToVendors,
  {},
);

// Anomaly detection (increment 6): every 5 minutes, scan the bounded recent
// trace window and UPSERT anomalies (one OPEN row per kind — de-duped, never
// double-inserted across runs). Bounded scan; safe to overlap. Feeds the
// heartbeat so an OpenClaw agent can learn of anomalies and self-repair.
crons.interval(
  "detect anomalies",
  { minutes: 5 },
  internal.anomalies.detectAnomalies,
  {},
);

// Bridge health (active monitoring): every minute, GET the bridge /health and
// upsert the singleton snapshot. This is the REAL-TIME source the Settings health
// badge + the chat availability gate read — much fresher than the 5-min anomaly
// scan, because "is the bridge up right now" must not lag.
crons.interval(
  "poll bridge health",
  { minutes: 1 },
  internal.bridgeHealth.pollBridgeHealth,
  {},
);

// Bridge compat (versions & capabilities): every 5 minutes, GET the bridge's
// unauthenticated /capabilities and upsert the singleton snapshot. Deliberately
// SLOWER than the 1-min /health poll (separate cron, not a 1-in-N counter — an
// internalAction is stateless across runs): the compat manifest only changes on
// a bridge/gateway upgrade, and a failed poll preserves last-good (see compat.ts).
crons.interval(
  "poll bridge compat",
  { minutes: 5 },
  internal.compat.pollBridgeCompat,
  {},
);

// Agent discovery (multi-agent redesign): every 2 minutes, ask the bridge
// `/agents` for each instance and cache the result RESILIENTLY (a failed poll
// never empties the cache nor flips per-agent presence — red-team B2). This is
// the bind whitelist that makes a stale/typo agent id structurally impossible.
crons.interval(
  "discover agents",
  { minutes: 2 },
  internal.agents.pollAgentDiscovery,
  {},
);

// Stuck-stream watchdog: every 2 minutes, flip assistant messages left
// `status:"streaming"` with no update for >12 min to `error`. Heals the bridge's
// lost-finalize failure mode (gateway finished the turn but the bridge never
// relayed the finalize frame), which otherwise pins the message "streaming"
// forever — eternal "Réflexion…" AND no per-message actions. See stuckStreams.ts.
crons.interval(
  "reconcile stuck streams",
  { minutes: 2 },
  internal.stuckStreams.reconcileStuckStreams,
  {},
);

// Durable access-log retention (SOC2): daily bounded purge of access-log rows
// past ACCESS_LOG_RETENTION_DAYS (default 90 — spans a Type II audit period,
// vs the 14-day traceEvents purge). Self-reschedules to drain a backlog.
crons.cron(
  "purge old access log",
  "30 3 * * *",
  internal.observability.purgeOldAccessLog,
  {},
);

// API rate-limit window cleanup (SOC2): hourly bounded purge of expired
// per-key counter rows so the apiRateLimits table stays tiny. Self-reschedules
// while a backlog remains (mirrors purgeOldTraces).
crons.interval(
  "purge old rate limits",
  { hours: 1 },
  internal.apiRateLimit.purgeOldRateLimits,
  {},
);

export default crons;
