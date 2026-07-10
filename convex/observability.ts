// Observability trace writer + reader (increment 1 "spine").
//
// D1 (storage split): Convex holds only a BOUNDED recent trace window; a daily
// cron (purgeOldTraces) deletes rows older than TRACE_RETENTION_DAYS. The full
// firehose ships to Opik/Langfuse in a later increment.
//
// D2 (PHI): `recordEvent` is the SINGLE trace writer and enforces redaction —
// for increment 1 the only emitted kind is "api.call" (route/method/status/
// latency/principal/roleKey), which contains no PHI, so it is written with
// `redacted: true`. Raw-content capture is a later increment gated behind the
// `traces.read.content` permission + an explicit flag.

import { v, Infer } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import { requireAdmin, requirePermission } from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import {
  applyFilter,
  filterValidator,
  type Filter,
  type FilterConfig,
} from "./lib/filters";

// Default retention horizon when TRACE_RETENTION_DAYS is unset (D1).
const DEFAULT_RETENTION_DAYS = 14;
// Bounded delete batch for the retention cron (stay within mutation limits).
const PURGE_BATCH = 200;
// Default page size for recent-event listings.
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

// Validator for the principal type stored on a trace (mirrors the schema).
const principalTypeValidator = v.union(
  v.literal("user"),
  v.literal("service"),
  v.literal("system"),
);

/**
 * Validator for a trace-event payload. Shared by the `recordEvent`
 * internalMutation AND the `writeTraceEvent` plain helper so the two cannot
 * drift: `WriteTraceEvent` (the helper's param type) is `Infer`-ed from it.
 *
 * NOTE on `status`: this is a NUMERIC column (HTTP status / numeric code only).
 * String lifecycle statuses (e.g. "streaming"/"complete"/"sent") are NOT a
 * `status` — callers put those inside `meta` (JSON). Likewise there is no
 * `messageId` column: message ids belong in `meta` too.
 */
const traceEventArgs = {
  kind: v.string(),
  direction: v.optional(
    v.union(
      v.literal("inbound"),
      v.literal("outbound"),
      v.literal("internal"),
    ),
  ),
  principalType: principalTypeValidator,
  principalId: v.optional(v.string()),
  roleKey: v.optional(v.string()),
  route: v.optional(v.string()),
  method: v.optional(v.string()),
  status: v.optional(v.number()),
  latencyMs: v.optional(v.number()),
  chatId: v.optional(v.string()),
  runId: v.optional(v.string()),
  correlationId: v.optional(v.string()),
  // JSON-encoded non-PHI extras. The writer does NOT introspect it; callers
  // are responsible for keeping it PHI-free (lengths/ops/flags only — never
  // message text, attachment contents, tokens, or paths).
  meta: v.optional(v.string()),
} as const;

const traceEventObject = v.object(traceEventArgs);

/** The trace-event payload shape, derived from the validator (cannot drift). */
export type WriteTraceEvent = Infer<typeof traceEventObject>;

/**
 * The single trace-event writer (plain async helper). ALL trace inserts flow
 * through here so the D2 redaction policy is enforced in exactly one place: for
 * now callers only emit metadata (no message text), so we force
 * `redacted: true`. When content capture lands (later increment, gated by
 * traces.read.content), this is where the redaction branch will live.
 *
 * Callable directly from MUTATIONS (a mutation cannot `ctx.runMutation` an
 * internalMutation). httpActions / internalActions reach it via the
 * `recordEvent` wrapper below (`ctx.runMutation`).
 */
export async function writeTraceEvent(
  ctx: MutationCtx,
  event: WriteTraceEvent,
): Promise<Doc<"traceEvents">["_id"]> {
  return await ctx.db.insert("traceEvents", {
    at: Date.now(),
    kind: event.kind,
    direction: event.direction,
    principalType: event.principalType,
    principalId: event.principalId,
    roleKey: event.roleKey,
    route: event.route,
    method: event.method,
    status: event.status,
    latencyMs: event.latencyMs,
    chatId: event.chatId,
    runId: event.runId,
    correlationId: event.correlationId,
    // D2: events carry metadata only -> always redacted.
    redacted: true,
    meta: event.meta,
  });
}

/**
 * internalMutation wrapper around `writeTraceEvent`, kept so httpAction /
 * internalAction callers (the /api/v1 route, bridge_ingest, bridge dispatch)
 * can still record events via `ctx.runMutation(internal.observability.recordEvent, ...)`.
 */
export const recordEvent = internalMutation({
  args: traceEventArgs,
  handler: async (ctx, args) => {
    const id = await writeTraceEvent(ctx, args);
    // SOC2 durable access log: every authenticated /api/v1 access (kind
    // "api.call") is ALSO appended to the long-retention `accessLog` table, so
    // the access trail survives the 14-day traceEvents purge for the full audit
    // period. Metadata only (same redacted fields). The trace viewer is
    // unchanged (it still reads api.call from traceEvents).
    if (args.kind === "api.call") {
      await ctx.db.insert("accessLog", {
        at: Date.now(),
        principalId: args.principalId,
        roleKey: args.roleKey,
        route: args.route,
        method: args.method,
        status: args.status,
        chatId: args.chatId,
        latencyMs: args.latencyMs,
      });
    }
    return id;
  },
});

/** Resolve the access-log retention horizon (days) from env; default 90 — long
 *  enough to span a SOC2 Type II audit period. Distinct from the 14-day trace
 *  retention because access logs are the compliance artifact, not debug noise. */
function accessLogRetentionDays(): number {
  const raw = process.env.ACCESS_LOG_RETENTION_DAYS;
  if (!raw) return 90;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

/** Bounded purge of access-log rows past the (long) retention horizon. Mirrors
 *  purgeOldTraces: one batch + self-reschedule while a backlog remains. */
export const purgeOldAccessLog = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number; more: boolean }> => {
    const cutoff = Date.now() - accessLogRetentionDays() * 24 * 60 * 60 * 1000;
    const stale = await ctx.db
      .query("accessLog")
      .withIndex("by_at", (q) => q.lt("at", cutoff))
      .order("asc")
      .take(PURGE_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
    const more = stale.length === PURGE_BATCH;
    if (more) {
      await ctx.scheduler.runAfter(0, internal.observability.purgeOldAccessLog, {});
    }
    return { deleted: stale.length, more };
  },
});

/** Shape returned for a trace event (stable for UI + API consumers). */
type TraceEventView = {
  _id: Doc<"traceEvents">["_id"];
  at: number;
  kind: string;
  direction: "inbound" | "outbound" | "internal" | null;
  principalType: "user" | "service" | "system";
  principalId: string | null;
  roleKey: string | null;
  route: string | null;
  method: string | null;
  status: number | null;
  latencyMs: number | null;
  chatId: string | null;
  runId: string | null;
  correlationId: string | null;
  redacted: boolean;
  meta: string | null;
};

function toView(r: Doc<"traceEvents">): TraceEventView {
  return {
    _id: r._id,
    at: r.at,
    kind: r.kind,
    direction: r.direction ?? null,
    principalType: r.principalType,
    principalId: r.principalId ?? null,
    roleKey: r.roleKey ?? null,
    route: r.route ?? null,
    method: r.method ?? null,
    status: r.status ?? null,
    latencyMs: r.latencyMs ?? null,
    chatId: r.chatId ?? null,
    runId: r.runId ?? null,
    correlationId: r.correlationId ?? null,
    redacted: r.redacted,
    meta: r.meta ?? null,
  };
}

/**
 * Filter config for the traces resource (docs/FILTERS_SPEC.md). Applied over the
 * VIEW objects (TraceEventView) the query returns. `q` searches the redacted
 * metadata only (D2). `correlationId` is NOT here — it stays a dedicated arg on
 * the by_correlation index path.
 */
const TRACES_FILTER_CFG: FilterConfig = {
  searchFields: ["kind", "principalId", "roleKey", "route", "correlationId"],
  timeField: "at",
  structured: {
    kind: { field: "kind", kind: "string" },
    // Exact numeric status (FILTERS_SPEC.md /api/v1 params line) AND the coarser
    // statusClass range both map onto the numeric `status` view field.
    status: { field: "status", kind: "number" },
    statusClass: { field: "status", kind: "statusClass" },
    principalType: { field: "principalType", kind: "string" },
    direction: { field: "direction", kind: "string" },
    roleKey: { field: "roleKey", kind: "string" },
  },
  advanced: true,
};

/**
 * Fetch the most recent events, newest first. Shared core for the admin query
 * and the internal API path. There is no `by_kind` index by contract, so `kind`
 * is filtered in memory over a bounded `by_at` scan — fine for the bounded
 * recent window.
 *
 * Filtering: an optional `filter` (the per-resource subset of the shared Filter
 * model) is applied in-memory over the bounded read, AFTER the read but BEFORE
 * the `limit` slice — so `limit` caps the FILTERED set. When a `filter` is
 * present we scan up to MAX_LIST_LIMIT so the post-filter can still fill `limit`
 * (the scan stays bounded). NOTE (D1): a `filter.from` older than the bounded
 * recent window returns PARTIAL results — the full firehose lives in
 * Opik/Langfuse, not here.
 */
async function fetchRecentEvents(
  ctx: Parameters<typeof requireAdmin>[0],
  opts: {
    limit?: number;
    kind?: string;
    correlationId?: string;
    filter?: Filter;
  },
): Promise<TraceEventView[]> {
  // L3: clamp to a non-negative integer so a negative/non-integer ?limit can
  // never reach `.take()` (which Convex rejects -> a 500 in the http route).
  const limit = clampLimit(opts.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const hasFilter = opts.filter !== undefined;
  // M7: a correlationId filter follows a span chain via the dedicated index
  // (the MCP client advertises it). Newest-first within the chain.
  if (opts.correlationId !== undefined) {
    const rows = await ctx.db
      .query("traceEvents")
      .withIndex("by_correlation", (q) =>
        q.eq("correlationId", opts.correlationId),
      )
      .take(Math.min(Math.max(limit, 1) * 5, MAX_LIST_LIMIT));
    rows.sort((a, b) => b.at - a.at);
    const chain = opts.kind ? rows.filter((r) => r.kind === opts.kind) : rows;
    const views = applyFilter(chain.map(toView), opts.filter, TRACES_FILTER_CFG);
    return views.slice(0, limit);
  }
  // Over-fetch when filtering (by `kind` arg OR a `filter`) so the post-filter
  // still returns up to `limit`, but keep the scan bounded.
  const scan =
    opts.kind || hasFilter
      ? Math.min(Math.max(limit, 1) * 5, MAX_LIST_LIMIT)
      : limit;
  // Push the from/to WINDOW into the INDEX. As a post-filter (the previous
  // shape) the scan could only ever see the newest `scan` rows of the WHOLE
  // table, so any window older than those read as SILENTLY EMPTY — a live
  // diagnostic trap (2026-07-09: an incident window a few hours old returned []
  // and mis-steered the investigation). Ranging by_at makes an old window
  // directly addressable; applyFilter re-checks from/to harmlessly below.
  const from = opts.filter?.from;
  const to = opts.filter?.to;
  const rows = await ctx.db
    .query("traceEvents")
    .withIndex("by_at", (q) =>
      from !== undefined && to !== undefined
        ? q.gte("at", from).lte("at", to)
        : from !== undefined
          ? q.gte("at", from)
          : to !== undefined
            ? q.lte("at", to)
            : q,
    )
    .order("desc")
    .take(scan);
  const byKind = opts.kind ? rows.filter((r) => r.kind === opts.kind) : rows;
  const views = applyFilter(byKind.map(toView), opts.filter, TRACES_FILTER_CFG);
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
 * Admin-only recent-events listing (for the Traces viewer UI). The principal
 * (service-account, traces.read) path does NOT go through here — it has no
 * admin identity; it uses `recentEventsInternal` after the httpAction has
 * already verified the permission. Structured so the principal path is purely
 * additive (no requireAdmin coupling in the shared core).
 */
export const listEvents = query({
  args: {
    limit: v.optional(v.number()),
    kind: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    filter: v.optional(filterValidator),
  },
  handler: async (ctx, { limit, kind, correlationId, filter }) => {
    // Per-tab RBAC: Traces is readable by any user GRANTED traces.read (already
    // the observer/agent service-account perm — non-PHI D2 metadata), not only
    // admins. The wildcard makes admins pass. Write/sensitive paths stay admin.
    await requirePermission(ctx, PERMISSIONS.TRACES_READ);
    return await fetchRecentEvents(ctx, { limit, kind, correlationId, filter });
  },
});

/**
 * Durable access-log review (SOC2 CC7.2): the long-retention access trail,
 * newest first, optionally scoped to one service-account principal — so an
 * operator can review WHO accessed the API over the audit period (beyond the
 * 14-day trace window). Gated `traces.read` (metadata only, like the viewer).
 * Bounded. This is the read side of the access-log review procedure.
 */
export const listAccessLog = query({
  args: {
    principalId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { principalId, limit }) => {
    await requirePermission(ctx, PERMISSIONS.TRACES_READ);
    const cap = Math.min(Math.max(1, limit ?? 200), 500);
    const rows = principalId
      ? await ctx.db
          .query("accessLog")
          .withIndex("by_principal_at", (q) => q.eq("principalId", principalId))
          .order("desc")
          .take(cap)
      : await ctx.db.query("accessLog").withIndex("by_at").order("desc").take(cap);
    return rows.map((r) => ({
      _id: r._id,
      at: r.at,
      principalId: r.principalId ?? null,
      roleKey: r.roleKey ?? null,
      route: r.route ?? null,
      method: r.method ?? null,
      status: r.status ?? null,
      chatId: r.chatId ?? null,
      latencyMs: r.latencyMs ?? null,
    }));
  },
});

/**
 * Internal recent-events listing for the key-authed /api/v1/traces route. The
 * httpAction verifies the principal's `traces.read` permission BEFORE calling
 * this (the permission check cannot run in the httpAction's no-db context, so
 * it is resolved at key-verification time). NOT publicly callable.
 */
export const recentEventsInternal = internalQuery({
  args: {
    limit: v.optional(v.number()),
    kind: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    filter: v.optional(filterValidator),
  },
  handler: async (ctx, { limit, kind, correlationId, filter }) => {
    return await fetchRecentEvents(ctx, { limit, kind, correlationId, filter });
  },
});

/**
 * Retention sweep (D1): delete trace events older than the horizon in one
 * bounded batch, then re-schedule itself if a full batch was removed (so a
 * backlog drains across transactions without exceeding mutation limits). Driven
 * by the daily cron in crons.ts; safe to invoke directly too.
 */
export const purgeOldTraces = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number; more: boolean }> => {
    const days = retentionDays();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stale = await ctx.db
      .query("traceEvents")
      .withIndex("by_at", (q) => q.lt("at", cutoff))
      .order("asc")
      .take(PURGE_BATCH);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    const more = stale.length === PURGE_BATCH;
    if (more) {
      // Continue draining in a fresh transaction to respect mutation limits.
      // Self-reference via the `internal` object per the cron guideline.
      await ctx.scheduler.runAfter(0, internal.observability.purgeOldTraces, {});
    }
    return { deleted: stale.length, more };
  },
});

/** Resolve the retention horizon (days) from env, with a safe default. */
function retentionDays(): number {
  const raw = process.env.TRACE_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}
