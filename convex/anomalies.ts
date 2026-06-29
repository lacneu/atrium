// Anomaly detection + heartbeat + self-repair signals (increment 6).
//
// D1 (storage split): the detector scans only the BOUNDED recent `traceEvents`
// window (mirrors kpi.ts's bounded `by_at` scan), never an unbounded history.
// D2 (PHI): traceEvents are already redacted (metadata only); `evidence` here is
// a JSON string of NON-PHI signals (counts/ratios/thresholds/window) — never
// message text, tokens, or paths.
//
// Sources:
//   - "detector": `detectAnomalies` (the cron) UPSERTS one OPEN row per `kind`.
//   - "agent": `reportAnomalyInternal` (the key-authed POST /api/v1/anomalies
//     route) inserts a row so an OpenClaw agent can report an anomaly OR a
//     self-repair action taken.
//
// De-dupe scheme (the load-bearing invariant): the `anomalies` table has only
// `by_status` and `by_at` indexes (no `by_kind`). So `detectAnomalies` queries
// `by_status` eq "open" (open anomalies are few -> bounded), filters in memory
// by `kind`, and PATCHES the existing open row (bump `at`, refresh
// message/severity/evidence) instead of inserting a duplicate. Re-running the
// cron over the same window therefore never creates a second open row of the
// same kind. A resolved/acknowledged row of the same kind does NOT block a fresh
// insert — a recurrence after a resolution is a new anomaly.

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { getActor, requireAdmin, requirePermission } from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { recordAudit } from "./lib/audit";
import { notifyAdmins } from "./notifications";
import {
  applyFilter,
  filterValidator,
  type Filter,
  type FilterConfig,
} from "./lib/filters";

// --- Detection tuning (single source so the cron + test cannot drift) --------

// How far back the detector scans. Mirrors kpi.ts's bounded-window discipline.
const DETECT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
// Bounded scan cap (never an unbounded scan).
const MAX_SCAN = 5000;

// api.error_ratio: fire only when BOTH a floor count of api.calls is reached
// (so a single error over a tiny sample never trips) AND the error ratio exceeds
// the threshold. Thresholds are explicit so a test can seed exactly past them.
const API_ERROR_MIN_CALLS = 10;
const API_ERROR_RATIO_WARN = 0.25;
const API_ERROR_RATIO_CRITICAL = 0.5;

// openclaw.dispatch_failures: outbound dispatch failures in the window. WARN at 1
// (operator decision 2026-06-07): for a chat platform a single failed dispatch =
// a user who got no reply, which is notable, not noise — and auto-resolve clears
// it once the 15m window empties. It stays a WARN until CRITICAL (heartbeat
// exposes bySeverity, so a self-repair signal keyed on criticalCount is NOT
// tripped by an isolated failure). Each occurrence is also in Traces in real time.
const DISPATCH_FAIL_WARN = 1;
const DISPATCH_FAIL_CRITICAL = 10;

// assistant.stream_errors: error/aborted finalize bursts in the window.
const STREAM_ERROR_WARN = 3;
const STREAM_ERROR_CRITICAL = 10;

// openclaw.ingest_denied: ingest auth-denied spikes (possible misconfig/abuse).
const INGEST_DENIED_WARN = 3;
const INGEST_DENIED_CRITICAL = 10;

// api.access_scan (SOC2 CC7.2): a single service-account key reading many
// DISTINCT chats via the diagnostic API in the window. Operationalizes the
// documented IDOR compensating control — legitimate debugging touches a few
// chats, so a burst of distinct reads is the fingerprint of a chatId scan.
const ACCESS_SCAN_DISTINCT_WARN = 25;
const ACCESS_SCAN_DISTINCT_CRITICAL = 100;

// Default page size for the listing/heartbeat queries.
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
// Page size for the heartbeat open-row scan (open rows are few in practice).
const OPEN_SCAN = 500;
// Safety cap on heartbeat pagination pages (OPEN_SCAN * this = max counted).
// De-dupe + auto-resolve (M2) keep the open set far below this; the cap only
// guards against a runaway so the query stays bounded.
const HEARTBEAT_MAX_PAGES = 50;

type Severity = "info" | "warn" | "critical";

// Stable detector kinds. Keep this the single source so the cron + test agree.
export const ANOMALY_KINDS = {
  API_ERROR_RATIO: "api.error_ratio",
  DISPATCH_FAILURES: "openclaw.dispatch_failures",
  STREAM_ERRORS: "assistant.stream_errors",
  INGEST_DENIED: "openclaw.ingest_denied",
  ACCESS_SCAN: "api.access_scan",
} as const;

/** Is this `assistant.stream` row an error/aborted finalize? (mirrors kpi.ts) */
function isStreamError(row: Doc<"traceEvents">): boolean {
  if (row.kind !== "assistant.stream" || row.meta === undefined) return false;
  try {
    const m = JSON.parse(row.meta) as { phase?: string; streamStatus?: string };
    return (
      m.phase === "finalize" &&
      (m.streamStatus === "error" || m.streamStatus === "aborted")
    );
  } catch {
    return false;
  }
}

/** Is this `openclaw.dispatch` row a failed dispatch? (meta.dispatchStatus) */
function isDispatchFailure(row: Doc<"traceEvents">): boolean {
  if (row.kind !== "openclaw.dispatch" || row.meta === undefined) return false;
  try {
    const m = JSON.parse(row.meta) as { dispatchStatus?: string };
    return m.dispatchStatus === "failed";
  } catch {
    return false;
  }
}

/**
 * Curated root-cause code carried on a failed-dispatch trace (meta.errorCode,
 * written by bridge.ts). Non-PHI by construction (a stable enum, never the raw
 * gateway text). Absent on traces written before this feature shipped, or when an
 * old bridge image returned no code — callers fall back to "UNKNOWN".
 */
function dispatchFailureCode(row: Doc<"traceEvents">): string | undefined {
  if (row.meta === undefined) return undefined;
  try {
    const m = JSON.parse(row.meta) as { errorCode?: string };
    return typeof m.errorCode === "string" ? m.errorCode : undefined;
  } catch {
    return undefined;
  }
}

/** Key with the highest count (the dominant root cause). Undefined if empty. */
function topKey(counts: Record<string, number>): string | undefined {
  let best: string | undefined;
  let max = -1;
  for (const [k, n] of Object.entries(counts)) {
    if (n > max) {
      max = n;
      best = k;
    }
  }
  return best;
}

/** Window aggregates folded over the scan, used by the detectors. */
type WindowAgg = {
  apiCalls: number;
  apiErrors: number;
  dispatchFailures: number;
  // Root-cause breakdown of the dispatch failures (errorCode -> count) so the
  // anomaly can name the DOMINANT cause, not just a bare count. Plus the most
  // recent failed-turn correlationId, for a one-click drill-down into Traces.
  dispatchCodes: Record<string, number>;
  dispatchSampleCorrelation?: string;
  streamErrors: number;
  ingestDenied: number;
  // principalId -> set of DISTINCT chatIds it read via the diagnostic API in the
  // window (access-scan detector). Non-PHI: a service-account id + chat ids.
  accessByPrincipal: Map<string, Set<string>>;
};

/**
 * Find the single OPEN detector row of a kind, directly via the `by_status_kind`
 * index — so de-dupe is correct REGARDLESS of how large the open set grows (the
 * old `.take(500)` open-set scan could miss the row past the cap and insert a
 * duplicate, M2). Agent rows can also be open with the same kind; we filter to
 * `source==="detector"` so the detector only ever owns ONE open row per kind.
 */
async function findOpenDetectorRow(
  ctx: MutationCtx,
  kind: string,
): Promise<Doc<"anomalies"> | undefined> {
  // Bounded read of open rows OF THIS KIND (not the whole open set, so the
  // .take(500) truncation hazard the old code had cannot recur). The cap guards
  // against an agent spamming a colliding kind; the detector still owns exactly
  // one open row per kind, so it is found well within the cap.
  const openOfKind = await ctx.db
    .query("anomalies")
    .withIndex("by_status_kind", (q) =>
      q.eq("status", "open").eq("kind", kind),
    )
    .take(OPEN_SCAN);
  return openOfKind.find((r) => r.source === "detector");
}

/**
 * UPSERT a single detector anomaly by `kind` (de-dupe = one OPEN row per kind).
 * Looks up the existing open detector row directly via `by_status_kind` (no
 * truncation hazard) and patches it (refresh at/message/severity/evidence) —
 * else inserts. A resolved/acknowledged row of the same kind does NOT block a
 * fresh insert.
 */
async function upsertDetectorAnomaly(
  ctx: MutationCtx,
  args: {
    kind: string;
    severity: Severity;
    message: string;
    evidence: Record<string, unknown>;
  },
): Promise<void> {
  const existing = await findOpenDetectorRow(ctx, args.kind);
  const now = Date.now();
  const evidence = JSON.stringify(args.evidence);
  if (existing === undefined) {
    const id = await ctx.db.insert("anomalies", {
      at: now,
      kind: args.kind,
      severity: args.severity,
      status: "open",
      message: args.message,
      source: "detector",
      evidence,
    });
    // Notify admins on the OPEN transition only (fresh insert) — never on the
    // upsert/refresh path below, so a re-observed anomaly doesn't spam per cron
    // tick (advisor). dedupeKey by row id = one notif per open-row lifetime.
    await notifyAdmins(ctx, {
      kind: "anomaly_open",
      title: `Anomalie : ${args.kind}`,
      body: args.message,
      href: "/settings/anomalies",
      dedupeKey: `anomaly_open:${id}`,
    });
    return;
  }
  // Refresh the still-open row in place (last-seen bump) — never a duplicate.
  await ctx.db.patch(existing._id, {
    at: now,
    severity: args.severity,
    message: args.message,
    evidence,
  });
}

/**
 * Auto-resolve detector anomalies whose condition is no longer present (M2). For
 * each known detector kind NOT detected in this run, resolve its open detector
 * row (a transient spike that has cleared). This is what returns the heartbeat
 * `openCount` to 0 once a condition clears, so the OpenClaw self-repair signal
 * un-trips. Iterates the FIXED set of detector kinds (bounded by design) and
 * touches detector rows ONLY — agent-reported rows are never auto-resolved.
 */
async function autoResolveClearedDetectors(
  ctx: MutationCtx,
  detected: string[],
): Promise<string[]> {
  const resolved: string[] = [];
  const detectedSet = new Set(detected);
  for (const kind of Object.values(ANOMALY_KINDS)) {
    if (detectedSet.has(kind)) continue;
    const open = await findOpenDetectorRow(ctx, kind);
    if (open === undefined) continue;
    await resolveAnomalyDoc(ctx, {
      anomalyId: open._id,
      status: "resolved",
      resolvedBy: "detector:auto",
    });
    resolved.push(kind);
  }
  return resolved;
}

/**
 * The cron. Scan the bounded recent `traceEvents` window and UPSERT anomalies.
 * Detects: high API error ratio, repeated openclaw.dispatch failures,
 * assistant.stream error/aborted bursts, and ingest auth-denied spikes. Bounded
 * scan; de-dupes to one OPEN row per kind. Returns a small summary for logs.
 */
export const detectAnomalies = internalMutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ scanned: number; detected: string[]; autoResolved: string[] }> => {
    const cutoff = Date.now() - DETECT_WINDOW_MS;
    const rows = await ctx.db
      .query("traceEvents")
      .withIndex("by_at", (q) => q.gte("at", cutoff))
      .order("asc")
      .take(MAX_SCAN);

    const agg: WindowAgg = {
      apiCalls: 0,
      apiErrors: 0,
      dispatchFailures: 0,
      dispatchCodes: {},
      streamErrors: 0,
      ingestDenied: 0,
      accessByPrincipal: new Map(),
    };
    for (const row of rows) {
      switch (row.kind) {
        case "api.call": {
          agg.apiCalls += 1;
          if (row.status !== undefined && row.status >= 400) agg.apiErrors += 1;
          // Track distinct chats a key read (only chat reads carry a chatId).
          if (row.chatId && row.principalId) {
            const set = agg.accessByPrincipal.get(row.principalId) ?? new Set();
            set.add(row.chatId);
            agg.accessByPrincipal.set(row.principalId, set);
          }
          break;
        }
        case "openclaw.dispatch": {
          if (isDispatchFailure(row)) {
            agg.dispatchFailures += 1;
            const code = dispatchFailureCode(row) ?? "UNKNOWN";
            agg.dispatchCodes[code] = (agg.dispatchCodes[code] ?? 0) + 1;
            // rows are scanned oldest -> newest, so the last write wins = the most
            // recent failed turn (the one an admin most likely wants to inspect).
            if (row.correlationId) agg.dispatchSampleCorrelation = row.correlationId;
          }
          break;
        }
        case "assistant.stream": {
          if (isStreamError(row)) agg.streamErrors += 1;
          break;
        }
        case "openclaw.ingest.denied": {
          agg.ingestDenied += 1;
          break;
        }
        default:
          break;
      }
    }

    const detected: string[] = [];
    const windowMin = Math.round(DETECT_WINDOW_MS / 60000);

    // 1) API error ratio — guarded by a minimum denominator so a tiny sample
    //    (and our own 403/503 traces) cannot trip it spuriously.
    if (agg.apiCalls >= API_ERROR_MIN_CALLS) {
      const ratio = agg.apiErrors / agg.apiCalls;
      if (ratio >= API_ERROR_RATIO_WARN) {
        const severity: Severity =
          ratio >= API_ERROR_RATIO_CRITICAL ? "critical" : "warn";
        await upsertDetectorAnomaly(ctx, {
          kind: ANOMALY_KINDS.API_ERROR_RATIO,
          severity,
          message: `High API error ratio: ${agg.apiErrors}/${agg.apiCalls} (${(
            ratio * 100
          ).toFixed(0)}%) over ${windowMin}m`,
          evidence: {
            apiCalls: agg.apiCalls,
            apiErrors: agg.apiErrors,
            ratio: Number(ratio.toFixed(4)),
            windowMs: DETECT_WINDOW_MS,
            warnThreshold: API_ERROR_RATIO_WARN,
            criticalThreshold: API_ERROR_RATIO_CRITICAL,
          },
        });
        detected.push(ANOMALY_KINDS.API_ERROR_RATIO);
      }
    }

    // 2) openclaw.dispatch failures (WARN at 1). The anomaly names the DOMINANT
    //    root cause and carries a sample correlationId so the admin can jump
    //    straight to the failing turn in Traces — turning "N failures" into an
    //    actionable, fixable signal.
    if (agg.dispatchFailures >= DISPATCH_FAIL_WARN) {
      const severity: Severity =
        agg.dispatchFailures >= DISPATCH_FAIL_CRITICAL ? "critical" : "warn";
      const dominantCode = topKey(agg.dispatchCodes);
      await upsertDetectorAnomaly(ctx, {
        kind: ANOMALY_KINDS.DISPATCH_FAILURES,
        severity,
        message: dominantCode
          ? `OpenClaw dispatch failures: ${agg.dispatchFailures} over ${windowMin}m — dominant cause: ${dominantCode}`
          : `OpenClaw dispatch failures: ${agg.dispatchFailures} over ${windowMin}m`,
        evidence: {
          dispatchFailures: agg.dispatchFailures,
          dominantCode,
          codeCounts: agg.dispatchCodes,
          sampleCorrelationId: agg.dispatchSampleCorrelation,
          windowMs: DETECT_WINDOW_MS,
          warnThreshold: DISPATCH_FAIL_WARN,
          criticalThreshold: DISPATCH_FAIL_CRITICAL,
        },
      });
      detected.push(ANOMALY_KINDS.DISPATCH_FAILURES);
    }

    // 3) assistant.stream error/aborted bursts.
    if (agg.streamErrors >= STREAM_ERROR_WARN) {
      const severity: Severity =
        agg.streamErrors >= STREAM_ERROR_CRITICAL ? "critical" : "warn";
      await upsertDetectorAnomaly(ctx, {
        kind: ANOMALY_KINDS.STREAM_ERRORS,
        severity,
        message: `Assistant stream error/aborted burst: ${agg.streamErrors} over ${windowMin}m`,
        evidence: {
          streamErrors: agg.streamErrors,
          windowMs: DETECT_WINDOW_MS,
          warnThreshold: STREAM_ERROR_WARN,
          criticalThreshold: STREAM_ERROR_CRITICAL,
        },
      });
      detected.push(ANOMALY_KINDS.STREAM_ERRORS);
    }

    // 4) Ingest auth-denied spikes (possible misconfig or abuse).
    if (agg.ingestDenied >= INGEST_DENIED_WARN) {
      const severity: Severity =
        agg.ingestDenied >= INGEST_DENIED_CRITICAL ? "critical" : "warn";
      await upsertDetectorAnomaly(ctx, {
        kind: ANOMALY_KINDS.INGEST_DENIED,
        severity,
        message: `Ingest auth-denied spike: ${agg.ingestDenied} over ${windowMin}m`,
        evidence: {
          ingestDenied: agg.ingestDenied,
          windowMs: DETECT_WINDOW_MS,
          warnThreshold: INGEST_DENIED_WARN,
          criticalThreshold: INGEST_DENIED_CRITICAL,
        },
      });
      detected.push(ANOMALY_KINDS.INGEST_DENIED);
    }

    // 5) Cross-chat access scan (SOC2 CC7.2): the worst key by DISTINCT chats
    //    read via the diagnostic API in the window. Operationalizes the
    //    documented IDOR compensating control — an active detector on the
    //    formally-accepted risk, not just a passive compensation.
    let scanPrincipal: string | undefined;
    let scanDistinct = 0;
    for (const [principalId, chats] of agg.accessByPrincipal) {
      if (chats.size > scanDistinct) {
        scanDistinct = chats.size;
        scanPrincipal = principalId;
      }
    }
    if (scanDistinct >= ACCESS_SCAN_DISTINCT_WARN && scanPrincipal !== undefined) {
      const severity: Severity =
        scanDistinct >= ACCESS_SCAN_DISTINCT_CRITICAL ? "critical" : "warn";
      await upsertDetectorAnomaly(ctx, {
        kind: ANOMALY_KINDS.ACCESS_SCAN,
        severity,
        message: `API key reading many distinct chats: ${scanDistinct} in ${windowMin}m (possible chatId scan)`,
        evidence: {
          // serviceAccount id + counts — non-PHI by construction (no content).
          principalId: scanPrincipal,
          distinctChats: scanDistinct,
          windowMs: DETECT_WINDOW_MS,
          warnThreshold: ACCESS_SCAN_DISTINCT_WARN,
          criticalThreshold: ACCESS_SCAN_DISTINCT_CRITICAL,
        },
      });
      detected.push(ANOMALY_KINDS.ACCESS_SCAN);
    }

    // Auto-resolve detector anomalies whose condition cleared this run, so the
    // heartbeat openCount returns to 0 (the self-repair signal un-trips).
    const autoResolved = await autoResolveClearedDetectors(ctx, detected);

    return { scanned: rows.length, detected, autoResolved };
  },
});

// --- Read views --------------------------------------------------------------

/** Stable view of an anomaly row (UI + API consumers). */
type AnomalyView = {
  _id: Doc<"anomalies">["_id"];
  at: number;
  kind: string;
  severity: Severity;
  status: "open" | "acknowledged" | "resolved";
  message: string;
  source: "detector" | "agent" | "user";
  correlationId: string | null;
  evidence: string | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
};

function toView(r: Doc<"anomalies">): AnomalyView {
  return {
    _id: r._id,
    at: r.at,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    message: r.message,
    source: r.source,
    correlationId: r.correlationId ?? null,
    evidence: r.evidence ?? null,
    resolvedAt: r.resolvedAt ?? null,
    resolvedBy: r.resolvedBy ?? null,
  };
}

const statusValidator = v.union(
  v.literal("open"),
  v.literal("acknowledged"),
  v.literal("resolved"),
);

/**
 * Filter config for the anomalies resource (docs/FILTERS_SPEC.md). Applied over
 * the VIEW objects (AnomalyView) the query returns. `q` searches the non-PHI
 * message/kind/correlationId only (D2). `anomalyStatus` maps onto the view's
 * `status` field (the shared Filter uses a distinct key so it never collides
 * with the numeric `status` used by traces).
 */
const ANOMALIES_FILTER_CFG: FilterConfig = {
  searchFields: ["message", "kind", "correlationId"],
  timeField: "at",
  structured: {
    anomalyStatus: { field: "status", kind: "string" },
    severity: { field: "severity", kind: "string" },
    source: { field: "source", kind: "string" },
    kind: { field: "kind", kind: "string" },
  },
  advanced: false,
};

/**
 * Fetch recent anomalies (optionally filtered by status), newest first. Shared
 * core for the admin query and the key-authed API path. When a status filter is
 * given we use the `by_status` index; otherwise the `by_at` index newest-first.
 *
 * Filtering: an optional `filter` (the per-resource subset of the shared Filter
 * model) is applied in-memory over the bounded read, AFTER the read but BEFORE
 * the `limit` slice — so `limit` caps the FILTERED set. When a `filter` is
 * present we scan up to MAX_LIST_LIMIT so the post-filter can still fill `limit`
 * (bounded). NOTE (D1): a `filter.from` older than the bounded recent window
 * returns PARTIAL results — the full firehose lives in Opik/Langfuse, not here.
 */
async function fetchAnomalies(
  ctx: QueryCtx,
  opts: {
    status?: "open" | "acknowledged" | "resolved";
    limit?: number;
    since?: number;
    filter?: Filter;
  },
): Promise<AnomalyView[]> {
  // L3: clamp to a non-negative integer so a negative/non-integer ?limit can
  // never reach `.take()` (which Convex rejects -> a 500 in the http route).
  const limit = clampLimit(opts.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const status = opts.status;
  // L8: `since` is a numeric ms watermark (newer-or-equal `at` only).
  const since = opts.since;
  const hasFilter = opts.filter !== undefined;
  // Over-fetch when a `filter` is present so the post-filter can still fill
  // `limit`. The non-filter, non-status `by_at` path keeps reading exactly
  // `limit` (its order is already correct).
  const scan = Math.min(Math.max(limit, 1) * 5, MAX_LIST_LIMIT);
  if (status) {
    const rows = await ctx.db
      .query("anomalies")
      .withIndex("by_status", (q) => q.eq("status", status))
      .take(scan);
    // by_status is not time-ordered; filter + sort newest-first then slice.
    const sinceFiltered =
      since !== undefined ? rows.filter((r) => r.at >= since) : rows;
    sinceFiltered.sort((a, b) => b.at - a.at);
    const views = applyFilter(
      sinceFiltered.map(toView),
      opts.filter,
      ANOMALIES_FILTER_CFG,
    );
    return views.slice(0, limit);
  }
  const rows = await ctx.db
    .query("anomalies")
    .withIndex("by_at", (q) =>
      since !== undefined ? q.gte("at", since) : q,
    )
    .order("desc")
    .take(hasFilter ? scan : limit);
  const views = applyFilter(rows.map(toView), opts.filter, ANOMALIES_FILTER_CFG);
  return views.slice(0, limit);
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
 * Admin-only anomaly listing (for the anomalies viewer UI, a later step). The
 * key-authed principal path does NOT go through here — see `anomaliesInternal`.
 */
export const listAnomalies = query({
  args: {
    status: v.optional(statusValidator),
    limit: v.optional(v.number()),
    since: v.optional(v.number()),
    filter: v.optional(filterValidator),
  },
  handler: async (ctx, { status, limit, since, filter }) => {
    // Per-tab RBAC: Anomalies readable by any user granted anomalies.read (admins
    // via wildcard). Resolve/acknowledge stays requireAdmin (mutation below).
    await requirePermission(ctx, PERMISSIONS.ANOMALIES_READ);
    return await fetchAnomalies(ctx, { status, limit, since, filter });
  },
});

/**
 * Internal anomaly listing for the key-authed GET /api/v1/anomalies route. The
 * httpAction verifies the principal's `anomalies.read` permission BEFORE calling
 * this (the check cannot run in the httpAction's no-db context). NOT publicly
 * callable. Mirrors observability.recentEventsInternal.
 */
export const anomaliesInternal = internalQuery({
  args: {
    status: v.optional(statusValidator),
    limit: v.optional(v.number()),
    since: v.optional(v.number()),
    filter: v.optional(filterValidator),
  },
  handler: async (ctx, { status, limit, since, filter }) => {
    return await fetchAnomalies(ctx, { status, limit, since, filter });
  },
});

// --- Write paths (key-authed routes call these via runMutation) --------------

const severityValidator = v.union(
  v.literal("info"),
  v.literal("warn"),
  v.literal("critical"),
);

/**
 * Insert a source:"agent" anomaly. Backs POST /api/v1/anomalies: an OpenClaw
 * agent reports an anomaly OR a self-repair action it took. The httpAction
 * verifies `anomalies.report` AND validates the body BEFORE calling this. D2:
 * caller is responsible for keeping `evidence` PHI-free (it is a JSON string).
 *
 * Reporter attribution (the non-PHI principal id) is folded into `evidence` by
 * the route — NOT into `resolvedBy`, which is reserved for resolution-time
 * attribution (a fresh "open" row must never carry a `resolvedBy`).
 */
export const reportAnomalyInternal = internalMutation({
  args: {
    kind: v.string(),
    severity: severityValidator,
    message: v.string(),
    correlationId: v.optional(v.string()),
    evidence: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { kind, severity, message, correlationId, evidence },
  ): Promise<{ id: Doc<"anomalies">["_id"] }> => {
    const id = await ctx.db.insert("anomalies", {
      at: Date.now(),
      kind,
      severity,
      status: "open",
      message,
      source: "agent",
      correlationId,
      evidence,
    });
    await notifyAdmins(ctx, {
      kind: "anomaly_open",
      title: `Anomalie : ${kind}`,
      body: message,
      href: "/settings/anomalies",
      dedupeKey: `anomaly_open:${id}`,
    });
    return { id };
  },
});

/**
 * Plain helper (single resolution writer): flip an anomaly's status to resolved
 * (default) or acknowledged, stamping `resolvedAt` and an optional non-PHI
 * `resolvedBy` (principal/actor id). A mutation cannot ctx.runMutation another
 * mutation, so the detector cron (auto-resolve) and the admin mutation both call
 * this directly; the key-authed HTTP route (an httpAction) reaches it via
 * resolveAnomalyInternal. Returns ok:false when the id does not exist.
 */
async function resolveAnomalyDoc(
  ctx: MutationCtx,
  args: {
    anomalyId: Id<"anomalies">;
    status?: "resolved" | "acknowledged";
    resolvedBy?: string;
  },
): Promise<{ ok: boolean }> {
  const row = await ctx.db.get(args.anomalyId);
  if (row === null) return { ok: false };
  const next = args.status ?? "resolved";
  await ctx.db.patch(args.anomalyId, {
    status: next,
    resolvedAt: Date.now(),
    ...(args.resolvedBy !== undefined ? { resolvedBy: args.resolvedBy } : {}),
  });
  // Notify admins when an anomaly is RESOLVED (not on mute/acknowledge). Fires
  // here — the SINGLE resolution writer — so DETECTOR auto-resolve notifies too,
  // not just manual "Résoudre" (advisor). dedupeKey = one resolved-notif per row.
  if (next === "resolved") {
    await notifyAdmins(ctx, {
      kind: "anomaly_resolved",
      title: `Anomalie résolue : ${row.kind}`,
      body: row.message,
      // Deep-link to the RESOLVED view — the tab defaults to status=open, which
      // would filter out the very anomaly this notification is about.
      href: "/settings/anomalies?status=resolved",
      dedupeKey: `anomaly_resolved:${args.anomalyId}`,
    });
  }
  return { ok: true };
}

/**
 * Flip an anomaly's status to resolved (default) or acknowledged. Backs the
 * key-authed POST /api/v1/anomalies/resolve route (the httpAction verifies
 * `anomalies.report` BEFORE calling this) AND is reused internally. A
 * self-repair signal: an agent marking an anomaly handled.
 */
export const resolveAnomalyInternal = internalMutation({
  args: {
    anomalyId: v.id("anomalies"),
    status: v.optional(
      v.union(v.literal("resolved"), v.literal("acknowledged")),
    ),
    resolvedBy: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { anomalyId, status, resolvedBy },
  ): Promise<{ ok: boolean }> => {
    return await resolveAnomalyDoc(ctx, { anomalyId, status, resolvedBy });
  },
});

/**
 * Admin-only resolve (for the anomalies viewer UI). requireAdmin (REAL identity,
 * impersonation never grants it) + audit attribution. Routes through the same
 * resolveAnomalyDoc writer as the cron and the key-authed route.
 */
export const resolveAnomaly = mutation({
  args: {
    anomalyId: v.id("anomalies"),
    status: v.optional(
      v.union(v.literal("resolved"), v.literal("acknowledged")),
    ),
  },
  handler: async (ctx, { anomalyId, status }): Promise<{ ok: boolean }> => {
    await requireAdmin(ctx);
    const actor = await getActor(ctx);
    const result = await resolveAnomalyDoc(ctx, {
      anomalyId,
      status,
      // Non-PHI resolution attribution (the real admin's user id).
      resolvedBy: actor.realUserId,
    });
    if (result.ok) {
      await recordAudit(ctx, actor, "anomaly.resolve", {
        resource: "anomaly",
        resourceId: anomalyId,
      });
    }
    return result;
  },
});

/**
 * Compact heartbeat summary for GET /api/v1/heartbeat: how many open anomalies,
 * how many are critical, the latest anomaly timestamp, and a severity histogram
 * of the OPEN rows. So an OpenClaw heartbeat learns whether anomalies appeared
 * and can self-repair. Bounded scan over the (few) open rows.
 */
export const heartbeatInternal = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    openCount: number;
    criticalCount: number;
    latestAt: number | null;
    bySeverity: { info: number; warn: number; critical: number };
  }> => {
    // Count ALL open rows completely (no silent truncation at a single .take):
    // page through `by_status` open until exhausted. With de-dupe + auto-resolve
    // (M2) the open set is bounded in practice; a hard page cap is a safety net.
    const bySeverity = { info: 0, warn: 0, critical: 0 };
    let openCount = 0;
    let latestAt: number | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < HEARTBEAT_MAX_PAGES; page++) {
      const result = await ctx.db
        .query("anomalies")
        .withIndex("by_status", (q) => q.eq("status", "open"))
        .paginate({ numItems: OPEN_SCAN, cursor });
      for (const r of result.page) {
        openCount += 1;
        bySeverity[r.severity] += 1;
        if (latestAt === null || r.at > latestAt) latestAt = r.at;
      }
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    return {
      openCount,
      criticalCount: bySeverity.critical,
      latestAt,
      bySeverity,
    };
  },
});
