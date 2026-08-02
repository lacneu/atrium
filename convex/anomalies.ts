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

// atrium.internal_work_failures: Atrium's OWN hidden work failing to dispatch
// (summary, document fetch, curation, conversion). NOT 1 — nobody is waiting on
// these, and this class DOES auto-resolve (it is not turn-costing), so a threshold
// of 1 would flap open and closed on every isolated blip until it stopped being
// read. 3 in the window is the shape of "this job is not getting through", which is
// the thing worth waking someone for: a summary that can NEVER be built is a real
// malfunction that would otherwise be invisible, since no user ever sees it fail.
const INTERNAL_WORK_WARN = 3;
const INTERNAL_WORK_CRITICAL = 15;

// assistant.stream_errors: REAL error finalizes in the window. WARN at 2
// (operator decision 2026-07-09, mirroring the dispatch rationale: an errored
// zero-reply turn = a user who got no answer): the live incident that opened
// this — a real user's TWO consecutive gateway-conflict errors — sat exactly
// under the old threshold of 3 and never notified the admin. User ABORTS
// (the Stop button) are counted SEPARATELY: a Stop is a user choice, not a
// platform failure, so aborts never trip the WARN — but a mass abort burst
// (users interrupting everywhere = replies bad/slow) still reaches CRITICAL
// via the combined count.
const STREAM_ERROR_WARN = 2;
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
  // A burst of user STOPS. Split out from `STREAM_ERRORS` (codex P2): the combined
  // threshold can trip on aborts alone, and a user pressing Stop is a choice, not a
  // lost turn — classing it as turn-costing would leave an alert open forever for
  // something that clears by itself.
  STOP_BURSTS: "assistant.stop_bursts",
  // Atrium's OWN hidden work failing to dispatch — building a conversation summary,
  // fetching a document, curating, converting. Split out from DISPATCH_FAILURES the
  // same way STOP_BURSTS was split from STREAM_ERRORS, and for the mirror reason:
  // nobody is waiting on these, so classing them as turn-costing would pin an alert
  // open for something no user felt. But they are NOT nothing — a summary that can
  // never be built is a real malfunction, and it would go completely unnoticed if
  // the only choice were "user-facing alarm" or "silence".
  INTERNAL_WORK_FAILURES: "atrium.internal_work_failures",
} as const;

/**
 * PER-CAUSE anomaly classes for a failed turn.
 *
 * The old channel had one kind for every failure — "Assistant stream errors: 2
 * over 15m" — which named a COUNT, not a cause. Prod showed the consequence: the
 * row that fired during the 2026-07-20 context overflow was indistinguishable from
 * two unrelated blips, so the real diagnosis came from a human report instead.
 * A cause is only actionable when it is named, so each curated `errorCode` the
 * bridge already persists gets its own class.
 *
 * The map is FIXED (auto-resolution iterates it), and anything not listed keeps
 * falling into the generic class below — an unknown cause must still be surfaced,
 * never dropped for lacking an entry.
 */
export const CAUSE_ANOMALY_KINDS: Record<string, string> = {
  context_length: "assistant.cause.context_length",
  compaction_timeout: "assistant.cause.compaction_timeout",
  connection_lost: "assistant.cause.connection_lost",
  gateway_restarting: "assistant.cause.gateway_restarting",
  connection_saturated: "assistant.cause.connection_saturated",
  response_timeout: "assistant.cause.response_timeout",
  stream_orphaned: "assistant.cause.stream_orphaned",
  session_init_conflict: "assistant.cause.session_init_conflict",
  empty_response_silent: "assistant.cause.empty_response_silent",
  provider_internal: "assistant.cause.provider_internal",
  empty_response: "assistant.cause.empty_response",
  DISPATCH_STALLED: "assistant.cause.dispatch_stalled",
  // The gateway's own normalized hard-failure classes (codex P2): allowlisted
  // upstream and real lost turns, so they get named classes like the rest.
  rate_limit: "assistant.cause.rate_limit",
  timeout: "assistant.cause.timeout",
  refusal: "assistant.cause.refusal",
  gateway_timeout: "assistant.cause.gateway_timeout",
  gateway_error: "assistant.cause.gateway_error",
  // The turn was blocked on a human command approval Atrium has no surface to
  // grant (G-21). A REAL lost turn with a nameable, actionable cause — and the
  // signal that the resolution path is the missing feature.
  awaiting_approval: "assistant.cause.awaiting_approval",
};

/**
 * Classes that COST A USER A TURN — never auto-resolved (see
 * `autoResolveClearedDetectors`). Every per-cause class qualifies by construction:
 * each one exists because a turn failed. The generic stream-error class qualifies
 * too, since it is the same failure with an unrecognized cause. Rate/ratio classes
 * (API error ratio, ingest denied, access scan) are conditions rather than lost
 * work, so they keep clearing on their own.
 */
export function isTurnCostingKind(kind: string): boolean {
  return (
    kind === ANOMALY_KINDS.STREAM_ERRORS ||
    kind === ANOMALY_KINDS.DISPATCH_FAILURES ||
    Object.values(CAUSE_ANOMALY_KINDS).includes(kind)
  );
}

/** Every detector-owned kind: the fixed base set plus the per-cause classes. */
export function allDetectorKinds(): string[] {
  return [
    ...Object.values(ANOMALY_KINDS),
    ...Object.values(CAUSE_ANOMALY_KINDS),
  ];
}

/** The terminal class of an `assistant.stream` finalize row: a REAL "error",
 *  a user "aborted" (Stop), or null (not a terminal / not a stream row). The
 *  detector weighs the two differently (see STREAM_ERROR_WARN). */
function streamFinalizeClass(
  row: Doc<"traceEvents">,
): "error" | "aborted" | null {
  if (row.kind !== "assistant.stream" || row.meta === undefined) return null;
  try {
    const m = JSON.parse(row.meta) as { phase?: string; streamStatus?: string };
    if (m.phase !== "finalize") return null;
    if (m.streamStatus === "error") return "error";
    if (m.streamStatus === "aborted") return "aborted";
    return null;
  } catch {
    return null;
  }
}

/**
 * The curated failure CLASS of an `assistant.stream` finalize row (meta.errorCode,
 * written by stream.ts through the platform's non-PHI allowlist). Absent on rows
 * written before this shipped, and on failures whose code is not allowlisted —
 * those keep falling into the generic class, never dropped.
 */
function streamFailureCode(row: Doc<"traceEvents">): string | undefined {
  if (row.meta === undefined) return undefined;
  try {
    const m = JSON.parse(row.meta) as { errorCode?: unknown };
    return typeof m.errorCode === "string" && m.errorCode.length > 0
      ? m.errorCode
      : undefined;
  } catch {
    return undefined;
  }
}

/** The hidden-chat kind this dispatch belonged to, or null for a real conversation.
 *
 *  ABSENT COUNTS AS USER-FACING, deliberately. Every trace written before this field
 *  existed lacks it, and so does the one branch that fails before the chat is read.
 *  Defaulting those to "internal" would quietly downgrade real lost turns — the one
 *  direction that must never happen. */
function dispatchChatKind(row: Doc<"traceEvents">): string | null {
  if (row.meta === undefined) return null;
  try {
    const m = JSON.parse(row.meta) as { chatKind?: unknown };
    return typeof m.chatKind === "string" && m.chatKind !== "" ? m.chatKind : null;
  } catch {
    return null;
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
  /** Failed dispatches to Atrium's own hidden chats, counted apart. */
  internalFailures: number;
  internalCodes: Record<string, number>;
  /** Which hidden job failed, by chat kind — this is what makes the alert say
   *  "summaries are not being built" instead of naming a bare count. */
  internalJobs: Record<string, number>;
  internalSampleCorrelation?: string;
  // REAL error finalizes vs user Stops (aborted) — weighed differently (see
  // STREAM_ERROR_WARN). Sample correlationId = drill-down anchor, like dispatch.
  streamErrors: number;
  streamAborts: number;
  streamSampleCorrelation?: string;
  // Failed turns BY CAUSE (curated code -> count) plus the most recent
  // correlationId per cause: what turns "2 errors" into "2 context overflows".
  streamCauses: Record<string, number>;
  streamCauseCorrelation: Record<string, string>;
  // NEWEST contributing trace per detector — the watermark that tells a genuinely
  // new observation from the same one re-read on the next cron tick.
  /** IDENTITY of the newest contributing trace per detector (its row id), paired
   *  with `latestAt` — same-millisecond failures need it to be counted. */
  latestKey: {
    api?: string;
    dispatch?: string;
    internal?: string;
    streamError?: string;
    streamAbort?: string;
    ingest?: string;
    cause: Record<string, string>;
    accessByPrincipal: Map<string, string>;
  };
  latestAt: {
    api?: number;
    dispatch?: number;
    internal?: number;
    /** Newest real ERROR finalize — the only thing that is a new observation for
     *  the turn-costing class. A user Stop must not advance it (codex P2). */
    streamError?: number;
    /** Newest user STOP — what makes a new observation for the burst class. */
    streamAbort?: number;
    ingest?: number;
    cause: Record<string, number>;
    /** principalId -> newest CHAT-READ by that principal. The access-scan class is
     *  about one principal's distinct reads, so an unrelated API call (or another
     *  principal's) must not advance its watermark (codex P2). */
    accessByPrincipal: Map<string, number>;
  };
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
    /** Optional link to the span chain that produced THIS observation. */
    correlationId?: string;
    /** Timestamp of the NEWEST trace behind this detection. The occurrence history
     *  is appended only when this advances: the detection window (15 min) is wider
     *  than the cron period (5 min), so the same failing turn is re-detected on
     *  every tick. Counting ticks would turn one lost turn into fifteen
     *  "occurrences" and make the history — the whole point of this table — a lie
     *  (codex P1). */
    latestEventAt?: number;
    /** IDENTITY of that trace. Same-millisecond failures are real and must each
     *  count, so the timestamp alone cannot decide (codex P2); a different newest
     *  row at the same instant is a different failure. */
    latestEventKey?: string;
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
      occurrenceCount: 1,
      firstAt: now,
      ...(args.latestEventAt !== undefined
        ? { lastEventAt: args.latestEventAt }
        : {}),
      ...(args.latestEventKey !== undefined
        ? { lastEventKey: args.latestEventKey }
        : {}),
    });
    await appendOccurrence(ctx, {
      anomalyId: id,
      kind: args.kind,
      at: now,
      severity: args.severity,
      evidence,
      correlationId: args.correlationId,
    });
    // Notify admins on the OPEN transition only (fresh insert) — never on the
    // upsert/refresh path below, so a re-observed anomaly doesn't spam per cron
    // tick (advisor). dedupeKey by row id = one notif per open-row lifetime.
    await notifyAdmins(ctx, {
      kind: "anomaly_open",
      title: `Anomalie : ${args.kind}`,
      messageKey: "notif_anomaly_open",
      params: { kind: args.kind },
      body: args.message,
      href: "/settings/anomalies",
      dedupeKey: `anomaly_open:${id}`,
    });
    return;
  }
  // Refresh the still-open row in place (last-seen bump) — never a duplicate.
  // The patched `evidence` is the CURRENT observation; the one it replaces is not
  // lost, because every observation is also appended below. That append is what
  // turns this channel from "something is wrong now" into a record an operator can
  // reason about.
  // Is this a NEW observation, or the same failure still inside the window? Only a
  // newer contributing trace counts (see `latestEventAt`); with no timestamps at all
  // we cannot tell, and inventing occurrences is worse than missing one.
  const isNewObservation =
    args.latestEventAt !== undefined &&
    existing.lastEventAt !== undefined &&
    (args.latestEventAt > existing.lastEventAt ||
      // Same instant, DIFFERENT trace: a second real failure in that millisecond.
      // The timestamp must still not go backwards (the window slides, so an older
      // row can become the newest one — that is not a new event).
      (args.latestEventAt === existing.lastEventAt &&
        args.latestEventKey !== undefined &&
        args.latestEventKey !== existing.lastEventKey));
  // MIGRATION: a row opened before these fields existed has no watermark and no
  // occurrence history. Counting this tick as a second occurrence would show "2×"
  // over a history containing one entry (codex P2). Adopt the watermark and record
  // THIS observation as the row's first — the aggregate then matches the table.
  const isFirstEverObservation =
    args.latestEventAt !== undefined && existing.lastEventAt === undefined;
  await ctx.db.patch(existing._id, {
    at: now,
    severity: args.severity,
    message: args.message,
    evidence,
    ...(isNewObservation
      ? {
          occurrenceCount: (existing.occurrenceCount ?? 1) + 1,
          lastEventAt: args.latestEventAt,
          lastEventKey: args.latestEventKey,
        }
      : isFirstEverObservation
        ? {
            occurrenceCount: 1,
            lastEventAt: args.latestEventAt,
            lastEventKey: args.latestEventKey,
          }
        : {}),
    firstAt: existing.firstAt ?? existing.at,
  });
  if (!isNewObservation && !isFirstEverObservation) return;
  await appendOccurrence(ctx, {
    anomalyId: existing._id,
    kind: args.kind,
    at: now,
    severity: args.severity,
    evidence,
    correlationId: args.correlationId,
  });
}

/**
 * Append ONE immutable observation. Never patched, never deleted by the detector:
 * this table IS the history the single open row cannot hold.
 */
async function appendOccurrence(
  ctx: MutationCtx,
  args: {
    anomalyId: Id<"anomalies">;
    kind: string;
    at: number;
    severity: Severity;
    evidence?: string;
    correlationId?: string;
  },
): Promise<void> {
  await ctx.db.insert("anomalyOccurrences", {
    anomalyId: args.anomalyId,
    kind: args.kind,
    at: args.at,
    severity: args.severity,
    ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
    ...(args.correlationId !== undefined
      ? { correlationId: args.correlationId }
      : {}),
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
  for (const kind of allDetectorKinds()) {
    if (detectedSet.has(kind)) continue;
    // A class that COST A USER A TURN is never auto-resolved. The condition
    // leaving the 15-minute window does not undo the turn that failed, and prod
    // showed what auto-resolution costs: over 14 days every detector row was
    // closed by `detector:auto` five minutes after opening — including the one
    // that fired during the 2026-07-20 context-overflow incident, which then had
    // to be re-reported by hand. These rows stay open until a human closes them;
    // that is the whole point of raising them.
    if (isTurnCostingKind(kind)) {
      // …with ONE migration exception. The old detector raised
      // `assistant.stream_errors` for an abort-only burst (its combined threshold);
      // that row is now a CONDITION by our own rule, and treating it as lost work
      // would pin a stale critical alert in the heartbeat forever (codex P2). Its
      // own evidence says which it was, so read it rather than guess.
      const open = await findOpenDetectorRow(ctx, kind);
      if (open === undefined) continue;
      if (kind !== ANOMALY_KINDS.STREAM_ERRORS) continue;
      // TWO conditions, both necessary (codex P1):
      //  - the row predates this change (no observation watermark), so it cannot be
      //    one the current rule just opened — the mixed-burst rule legitimately
      //    raises rows whose evidence shows a single error, and those cost a turn;
      //  - and its evidence shows ZERO errors, i.e. it really was a pure stop burst.
      //    With even one error it stays open: a lost turn is a lost turn.
      let inheritedBurst = false;
      if (open.lastEventAt === undefined && open.occurrenceCount === undefined) {
        try {
          const ev = JSON.parse(open.evidence ?? "{}") as {
            streamErrors?: unknown;
          };
          inheritedBurst =
            typeof ev.streamErrors === "number" && ev.streamErrors === 0;
        } catch {
          inheritedBurst = false;
        }
      }
      if (!inheritedBurst) continue;
      await resolveAnomalyDoc(ctx, {
        anomalyId: open._id,
        status: "resolved",
        resolvedBy: "detector:auto",
      });
      resolved.push(kind);
      continue;
    }
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
      internalFailures: 0,
      internalCodes: {},
      internalJobs: {},
      streamErrors: 0,
      streamCauses: {},
      streamCauseCorrelation: {},
      latestAt: { cause: {}, accessByPrincipal: new Map() },
      latestKey: { cause: {}, accessByPrincipal: new Map() },
      streamAborts: 0,
      ingestDenied: 0,
      accessByPrincipal: new Map(),
    };
    for (const row of rows) {
      switch (row.kind) {
        case "api.call": {
          agg.apiCalls += 1;
          if (row.status !== undefined && row.status >= 400) {
            agg.apiErrors += 1;
            // Only a FAILING call is a new observation for the ratio class (codex
            // P2): every 2xx also advances the ratio's denominator, so watermarking
            // on any call let ordinary successful traffic manufacture occurrences —
            // polling the diagnostic API would have inflated its own history.
            agg.latestAt.api = row.at;
            agg.latestKey.api = row._id;
          }
          // Track distinct chats a key read (only chat reads carry a chatId).
          if (row.chatId && row.principalId) {
            const set = agg.accessByPrincipal.get(row.principalId) ?? new Set();
            const before = set.size;
            set.add(row.chatId);
            agg.accessByPrincipal.set(row.principalId, set);
            // The condition is DISTINCT chats, so only a new chat is a new
            // observation (codex P2): re-reading the same chat does not widen the
            // scan, and watermarking on it would let polling one chat inflate the
            // history of an alert about breadth.
            if (set.size > before) {
              agg.latestAt.accessByPrincipal.set(row.principalId, row.at);
              agg.latestKey.accessByPrincipal.set(row.principalId, row._id);
            }
          }
          break;
        }
        case "openclaw.dispatch": {
          if (isDispatchFailure(row)) {
            const code = dispatchFailureCode(row) ?? "UNKNOWN";
            const hiddenKind = dispatchChatKind(row);
            if (hiddenKind !== null) {
              // Atrium's own housekeeping. NOBODY lost a turn — but the job did not
              // run, and that is what this class exists to say out loud.
              agg.internalFailures += 1;
              agg.internalCodes[code] = (agg.internalCodes[code] ?? 0) + 1;
              agg.internalJobs[hiddenKind] =
                (agg.internalJobs[hiddenKind] ?? 0) + 1;
              if (row.correlationId)
                agg.internalSampleCorrelation = row.correlationId;
              agg.latestAt.internal = row.at;
              agg.latestKey.internal = row._id;
              break;
            }
            agg.dispatchFailures += 1;
            agg.dispatchCodes[code] = (agg.dispatchCodes[code] ?? 0) + 1;
            // rows are scanned oldest -> newest, so the last write wins = the most
            // recent failed turn (the one an admin most likely wants to inspect).
            if (row.correlationId) agg.dispatchSampleCorrelation = row.correlationId;
            agg.latestAt.dispatch = row.at;
            agg.latestKey.dispatch = row._id;
          }
          break;
        }
        case "assistant.stream": {
          const cls = streamFinalizeClass(row);
          if (cls === "error") {
            agg.streamErrors += 1;
            // oldest -> newest scan: last write wins = most recent failed turn.
            if (row.correlationId)
              agg.streamSampleCorrelation = row.correlationId;
            agg.latestAt.streamError = row.at;
            agg.latestKey.streamError = row._id;
            const cause = streamFailureCode(row);
            if (cause !== undefined) {
              agg.streamCauses[cause] = (agg.streamCauses[cause] ?? 0) + 1;
              if (row.correlationId)
                agg.streamCauseCorrelation[cause] = row.correlationId;
              agg.latestAt.cause[cause] = row.at;
              agg.latestKey.cause[cause] = row._id;
            }
          } else if (cls === "aborted") {
            agg.streamAborts += 1;
            agg.latestAt.streamAbort = row.at;
            agg.latestKey.streamAbort = row._id;
          }
          break;
        }
        case "openclaw.ingest.denied": {
          agg.ingestDenied += 1;
          agg.latestAt.ingest = row.at;
          agg.latestKey.ingest = row._id;
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
          latestEventAt: agg.latestAt.api,
        latestEventKey: agg.latestKey.api,
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
        latestEventAt: agg.latestAt.dispatch,
        latestEventKey: agg.latestKey.dispatch,
      });
      detected.push(ANOMALY_KINDS.DISPATCH_FAILURES);
    }

    // 2b) Atrium's own hidden work failing to reach the gateway. Same evidence shape
    //     as the user-facing class — dominant cause + a sample correlationId — plus
    //     WHICH job failed, because "summaries are not being built" is actionable and
    //     "2 dispatch failures" is not.
    if (agg.internalFailures >= INTERNAL_WORK_WARN) {
      const severity: Severity =
        agg.internalFailures >= INTERNAL_WORK_CRITICAL ? "critical" : "warn";
      const dominantJob = topKey(agg.internalJobs);
      const dominantCode = topKey(agg.internalCodes);
      await upsertDetectorAnomaly(ctx, {
        kind: ANOMALY_KINDS.INTERNAL_WORK_FAILURES,
        severity,
        message: `Atrium internal work failing: ${agg.internalFailures} over ${windowMin}m${
          dominantJob ? ` — mostly ${dominantJob}` : ""
        }${dominantCode ? ` (${dominantCode})` : ""}. No user turn was lost.`,
        evidence: {
          internalFailures: agg.internalFailures,
          dominantJob,
          jobCounts: agg.internalJobs,
          dominantCode,
          codeCounts: agg.internalCodes,
          sampleCorrelationId: agg.internalSampleCorrelation,
          windowMs: DETECT_WINDOW_MS,
          warnThreshold: INTERNAL_WORK_WARN,
          criticalThreshold: INTERNAL_WORK_CRITICAL,
        },
        latestEventAt: agg.latestAt.internal,
        latestEventKey: agg.latestKey.internal,
      });
      detected.push(ANOMALY_KINDS.INTERNAL_WORK_FAILURES);
    }

    // 3) assistant.stream failures. REAL errors trip the WARN (threshold 2 —
    //    see STREAM_ERROR_WARN's rationale); user Stops (aborted) never do, but
    //    a mass combined burst still reaches CRITICAL (users interrupting
    //    everywhere = replies bad/slow, worth an alert even with zero errors).
    const streamCombined = agg.streamErrors + agg.streamAborts;
    // A burst containing ANY real error still raises the turn-costing class, even
    // below the WARN threshold (codex P2): one lost turn among nine user stops is
    // still a lost turn, and routing it to the self-clearing burst class would make
    // its alert disappear after 15 minutes — a regression on the old combined rule.
    if (
      agg.streamErrors >= STREAM_ERROR_WARN ||
      (agg.streamErrors > 0 && streamCombined >= STREAM_ERROR_CRITICAL)
    ) {
      await upsertDetectorAnomaly(ctx, {
        kind: ANOMALY_KINDS.STREAM_ERRORS,
        // The COMBINED escalation is kept here (codex P1): 2 errors alongside 8
        // stops is a critical situation, and splitting the burst class out must not
        // downgrade it to a warning — the two classes answer different questions,
        // they do not divide the severity between them.
        severity:
          agg.streamErrors >= STREAM_ERROR_CRITICAL ||
          streamCombined >= STREAM_ERROR_CRITICAL
            ? "critical"
            : "warn",
        message:
          agg.streamAborts > 0
            ? `Assistant stream errors: ${agg.streamErrors} (+${agg.streamAborts} user abort(s)) over ${windowMin}m`
            : `Assistant stream errors: ${agg.streamErrors} over ${windowMin}m`,
        evidence: {
          streamErrors: agg.streamErrors,
          streamAborts: agg.streamAborts,
          sampleCorrelationId: agg.streamSampleCorrelation,
          windowMs: DETECT_WINDOW_MS,
          warnThreshold: STREAM_ERROR_WARN,
          criticalThreshold: STREAM_ERROR_CRITICAL,
        },
        latestEventAt: agg.latestAt.streamError,
        latestEventKey: agg.latestKey.streamError,
      });
      detected.push(ANOMALY_KINDS.STREAM_ERRORS);
    }
    if (streamCombined >= STREAM_ERROR_CRITICAL && agg.streamErrors === 0) {
      // Users interrupting EVERYWHERE with no real errors: replies are bad or slow,
      // worth an alert — but a Stop is a choice, not a lost turn, so this is its own
      // CONDITION class and clears by itself (codex P2). Folding it into the
      // turn-costing class would have left an alert open forever for a burst of
      // people changing their minds.
      await upsertDetectorAnomaly(ctx, {
        kind: ANOMALY_KINDS.STOP_BURSTS,
        severity: "critical",
        message: `User stops: ${agg.streamAborts} over ${windowMin}m (no errors)`,
        evidence: {
          streamErrors: agg.streamErrors,
          streamAborts: agg.streamAborts,
          sampleCorrelationId: agg.streamSampleCorrelation,
          windowMs: DETECT_WINDOW_MS,
          criticalThreshold: STREAM_ERROR_CRITICAL,
        },
        latestEventAt: agg.latestAt.streamAbort,
        latestEventKey: agg.latestKey.streamAbort,
      });
      detected.push(ANOMALY_KINDS.STOP_BURSTS);
    }

    // 3b) PER-CAUSE classes. The count above says how many turns failed; these say
    //     WHY, which is the only form an operator can act on — a context overflow
    //     needs a budget change, a saturated connection needs bridge headroom, and
    //     the old channel called both "2 stream errors". One occurrence is enough
    //     to raise a named cause: a lost turn is not a threshold question, and the
    //     append-only history is what distinguishes a blip from a pattern.
    for (const [cause, count] of Object.entries(agg.streamCauses)) {
      const kind = CAUSE_ANOMALY_KINDS[cause];
      if (kind === undefined) continue; // unknown cause: the generic class has it
      await upsertDetectorAnomaly(ctx, {
        kind,
        severity: count >= STREAM_ERROR_WARN ? "critical" : "warn",
        message: `Failed turns — cause ${cause}: ${count} over ${windowMin}m`,
        evidence: {
          cause,
          count,
          sampleCorrelationId: agg.streamCauseCorrelation[cause],
          windowMs: DETECT_WINDOW_MS,
        },
        correlationId: agg.streamCauseCorrelation[cause],
        latestEventAt: agg.latestAt.cause[cause],
        latestEventKey: agg.latestKey.cause[cause],
      });
      detected.push(kind);
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
        latestEventAt: agg.latestAt.ingest,
        latestEventKey: agg.latestKey.ingest,
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
        // The RETAINED principal's own newest chat read — not "any API call since"
        // (codex P2): an unrelated call must not manufacture an occurrence.
        latestEventAt: agg.latestAt.accessByPrincipal.get(scanPrincipal),
        latestEventKey: agg.latestKey.accessByPrincipal.get(scanPrincipal),
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
  // AGGREGATE of the append-only history: how many observations this row has had
  // and when the first one was. The whole point of the change is that an operator
  // can answer "how many times since Tuesday?" — which needs these on the wire,
  // not just in the table (codex P2).
  occurrenceCount: number | null;
  firstAt: number | null;
  // Attachment METADATA only (name + size). List payloads must stay light —
  // an anomaly can carry up to ~4×48k chars of proposal text; the full content
  // is served on demand by `getAnomalyAttachments`.
  attachments: { name: string; chars: number }[] | null;
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
    occurrenceCount: r.occurrenceCount ?? null,
    firstAt: r.firstAt ?? null,
    // Already metadata-only on the row (the content lives in anomalyAttachments).
    attachments:
      r.attachments && r.attachments.length > 0 ? r.attachments : null,
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
 * Full attachment content of ONE anomaly, on demand (the list view only carries
 * name+size). Same read gate as the listing (`anomalies.read` — admins via
 * wildcard). Returns [] when the anomaly has no attachments or does not exist —
 * the panel treats both as "nothing to show" (no existence oracle needed:
 * callers got the id from the listing they were already allowed to read).
 */
export const getAnomalyAttachments = query({
  args: { anomalyId: v.id("anomalies") },
  handler: async (
    ctx,
    { anomalyId },
  ): Promise<{ name: string; content: string }[]> => {
    await requirePermission(ctx, PERMISSIONS.ANOMALIES_READ);
    const rows = await ctx.db
      .query("anomalyAttachments")
      .withIndex("by_anomaly", (q) => q.eq("anomalyId", anomalyId))
      .collect();
    return rows.map((r) => ({ name: r.name, content: r.content }));
  },
});

/** Internal attachments read for the key-authed GET /api/v1/anomaly-attachments
 *  route (permission checked by the httpAction — no-db context there). The
 *  content is agent-authored, PII-free by contract (report_anomaly's rule). */
export const attachmentsInternal = internalQuery({
  args: { anomalyId: v.id("anomalies") },
  handler: async (
    ctx,
    { anomalyId },
  ): Promise<{ name: string; content: string }[]> => {
    const rows = await ctx.db
      .query("anomalyAttachments")
      .withIndex("by_anomaly", (q) => q.eq("anomalyId", anomalyId))
      .collect();
    return rows.map((r) => ({ name: r.name, content: r.content }));
  },
});

/** How many observations one read returns (recent-first, bounded). */
const OCCURRENCE_PAGE = 200;

/**
 * The append-only OCCURRENCE history of one anomaly — recent first.
 *
 * This is the read the old channel could not serve: with one patched row per kind,
 * "how often did this happen?" had no answer. Non-PHI by construction (the same
 * counters/codes the parent's evidence carries).
 */
export const occurrencesInternal = internalQuery({
  args: {
    anomalyId: v.optional(v.id("anomalies")),
    /** Or the whole history of a CAUSE, across successive open rows. */
    kind: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { anomalyId, kind, limit },
  ): Promise<{
    occurrences: {
      at: number;
      kind: string;
      severity: Severity;
      evidence: string | null;
      correlationId: string | null;
    }[];
    /** FALSE when the parent row was first seen before its history begins — i.e.
     *  it was opened before this table existed. Reported rather than papered over:
     *  the row's own first-seen is a real observation and must not be rewritten to
     *  match a partial history, but a reader comparing the two deserves to know
     *  which is which (codex P2). */
    historyComplete: boolean;
    /** FALSE when the requested `anomalyId` matches no row: a well-formed id that
     *  does not exist is an absent resource, not an empty history (codex P2). */
    found: boolean;
  }> => {
    // EXACTLY ONE selector. Given both, silently preferring the id would return a
    // history that may not match the `kind` the caller asked about — a wrong answer
    // dressed as a success (codex P2).
    if ((anomalyId === undefined) === (kind === undefined)) {
      throw new Error("provide exactly one of anomalyId or kind");
    }
    // FLOORED, not merely finite: `.take()` demands a non-negative integer, and a
    // caller passing `limit=1.5` deserves a page — not an error the route would
    // then report as an unknown id (codex P2).
    const take = Math.min(
      Math.max(Math.floor(limit ?? 50), 1),
      OCCURRENCE_PAGE,
    );
    const rows =
      anomalyId !== undefined
        ? await ctx.db
            .query("anomalyOccurrences")
            .withIndex("by_anomaly", (q) => q.eq("anomalyId", anomalyId))
            .order("desc")
            .take(take)
        : kind !== undefined
          ? await ctx.db
              .query("anomalyOccurrences")
              .withIndex("by_kind_at", (q) => q.eq("kind", kind))
              .order("desc")
              .take(take)
          : [];
    const occurrences = rows.map((r) => ({
      at: r.at,
      kind: r.kind,
      severity: r.severity,
      evidence: r.evidence ?? null,
      correlationId: r.correlationId ?? null,
    }));
    // Coverage check against the parent's own first-seen (only meaningful for the
    // per-anomaly read; a per-KIND history spans successive rows by design).
    //
    // Compared against the OLDEST occurrence overall, not the oldest on this page
    // (codex P2): the page holds the most recent entries, so a complete history that
    // simply does not fit would otherwise be reported as a migration gap.
    let historyComplete = true;
    let found = true;
    if (anomalyId !== undefined) {
      // Evaluated even with an EMPTY result (codex P2): the common legacy case is a
      // row opened before this table existed and therefore with NO occurrences at
      // all — claiming a complete empty history is exactly the wrong answer.
      const parent = await ctx.db.get(anomalyId);
      const oldest = await ctx.db
        .query("anomalyOccurrences")
        .withIndex("by_anomaly", (q) => q.eq("anomalyId", anomalyId))
        .order("asc")
        .first();
      if (parent === null) found = false;
      const parentFirst = parent?.firstAt ?? parent?.at;
      if (
        parentFirst !== undefined &&
        (oldest === null || parentFirst < oldest.at)
      ) {
        historyComplete = false;
      }
    }
    return { occurrences, historyComplete, found };
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
    // Agent-authored proposal documents (bounds enforced by the route — see
    // the schema comment). The row keeps name+size METADATA; the text goes to
    // the anomalyAttachments child table (list scans must stay light).
    attachments: v.optional(
      v.array(v.object({ name: v.string(), content: v.string() })),
    ),
  },
  handler: async (
    ctx,
    { kind, severity, message, correlationId, evidence, attachments },
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
      attachments:
        attachments && attachments.length > 0
          ? attachments.map((a) => ({ name: a.name, chars: a.content.length }))
          : undefined,
    });
    for (const a of attachments ?? []) {
      await ctx.db.insert("anomalyAttachments", {
        anomalyId: id,
        name: a.name,
        content: a.content,
      });
    }
    await notifyAdmins(ctx, {
      kind: "anomaly_open",
      title: `Anomalie : ${kind}`,
      messageKey: "notif_anomaly_open",
      params: { kind: kind },
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
      messageKey: "notif_anomaly_resolved",
      params: { kind: row.kind },
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
