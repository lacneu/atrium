// Outbound trace shipping orchestrator (increment 5).
//
// D1 (storage split): the firehose lives in Opik/Langfuse; Convex keeps only the
// bounded recent window and ships NEW trace events out to whichever vendors are
// configured, linking by `correlationId`. This module is the periodic flush
// (driven by the 5-minute cron in crons.ts).
//
// Per-vendor cursor scheme (`integrationCursors`, index `by_vendor`):
//   - COMPOSITE watermark = (`lastAt`, `lastId`) of the last event already
//     shipped to a vendor (M3). Each flush reads `traceEvents` paged by
//     (at > lastAt) OR (at == lastAt AND _id > lastId), bounded to FLUSH_BATCH
//     rows (oldest-first), maps + sends them, and ON SUCCESS advances BOTH
//     fields to the newest shipped event. The id tiebreaker means a burst of
//     >FLUSH_BATCH events sharing one millisecond is NOT dropped at the batch
//     boundary (the old strict-`gt` watermark skipped same-ms remainders).
//   - INITIAL cursor (no row yet) = `now` at the FIRST flush: shipping is
//     FORWARD-ONLY from the moment a vendor is first configured (we do not
//     back-ship the retained window — D1 says Convex is the bounded recent window,
//     not a replay buffer; the firehose starts when egress is enabled).
//   - L4: the cursor row also carries secret-free `failureCount`/`lastError`
//     (reason code + vendor status only); a wedged vendor surfaces via
//     integrations.status and a detector anomaly after N consecutive failures.
//
// Graceful when unconfigured (the common dev case): a vendor with no env is a
// per-vendor no-op (skipped) and NEVER an error. The action catches per vendor
// (mirrors bridge.dispatch's "don't throw, record the outcome" reasoning) so the
// cron never sees a thrown action (which Convex would retry).
//
// D2/D3: events are already redacted (metadata only); credentials stay in env.

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  ActionCtx,
  MutationCtx,
  QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc } from "../_generated/dataModel";
import {
  langfuseConfig,
  opikConfig,
  otlpConfig,
  readIntegrationConfig,
  type LangfuseOverride,
  type OpikOverride,
} from "./config";
import { ShippableEvent, SendResult } from "./shared";
import * as langfuse from "./langfuse";
import * as opik from "./opik";
import * as otlp from "./otlp";
import { decryptOtlpHeaders } from "./otlpSecret";
import type { EncryptedSecret } from "../lib/crypto/cipher";

// Max trace events shipped to a single vendor per flush (bounded egress).
const FLUSH_BATCH = 200;

// L4: emit an anomaly once a vendor's egress has been wedged this many flushes
// in a row, so an operator (and the heartbeat) learns a vendor is stuck.
const FAILURE_ANOMALY_THRESHOLD = 3;

// M3: bounded read of the same-millisecond remainder. Must exceed the largest
// realistic single-ms burst so the per-flush slice always advances; far above
// FLUSH_BATCH so the watermark id can step forward through a dense ms across
// successive flushes without re-reading only the shipped prefix.
const MAX_SAME_MS_SCAN = 4000;

// The vendor keys (also the `integrationCursors.vendor` values).
const VENDOR_LANGFUSE = "langfuse";
const VENDOR_OPIK = "opik";
const VENDOR_OTLP = "otlp";

/** Per-vendor outcome returned by the flush (no secrets — booleans + counts). */
type VendorFlushResult = {
  vendor: string;
  configured: boolean;
  shipped: number; // events accepted by the vendor this flush
  ok: boolean; // false on send failure (cursor not advanced)
  skipped?: boolean; // true when unconfigured (pure no-op)
  status?: number; // vendor HTTP status when a response came back
  reason?: string; // "unconfigured" | "network_error" | "send_failed" | ...
  newCursor?: number; // advanced watermark on success
};

/**
 * Read the SHIPPABLE (redacted-metadata) subset of trace events with
 * `at > since`, oldest-first, bounded to `limit`. Returns a plain structural
 * shape the adapters can map without a Convex `Doc`. NOT publicly callable.
 */
export const unsentSince = internalQuery({
  // M3: `sinceId` is the COMPOSITE watermark tiebreaker. When provided we page
  // with (at > since) OR (at == since AND _id > sinceId), so a burst of events
  // sharing the boundary millisecond is never dropped at a batch boundary.
  // BACKWARD-COMPATIBLE: when `sinceId` is undefined we keep the original strict
  // `gt` semantics (the existing cursor-scheme test relies on this).
  args: {
    since: v.number(),
    sinceId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    { since, sinceId, limit },
  ): Promise<ShippableEvent[]> => {
    const take = Math.min(limit ?? FLUSH_BATCH, FLUSH_BATCH);
    if (sinceId === undefined) {
      // Legacy strict-gt path (no tiebreaker).
      const rows = await ctx.db
        .query("traceEvents")
        .withIndex("by_at", (q) => q.gt("at", since))
        .order("asc")
        .take(take);
      return rows.map(projectShippable);
    }
    // Composite path. Two bounded reads guarantee FORWARD PROGRESS even when far
    // more than `take` events share the boundary millisecond (M3's reason to
    // exist): a naive `gte(at).take(take+1)` returns the SMALLEST rows by
    // (at, _creationTime), so once the watermark id advances inside the same ms
    // the next flush re-reads only the shipped prefix and stalls forever.
    //
    //   1) the SAME-ms remainder: all rows at == since with _id > sinceId,
    //      ordered by the index, filtered + sliced by the SAME _id string
    //      comparison flushOneVendor advances on (consistent watermark);
    //   2) if room remains, the NEXT events strictly after this ms (gt at).
    const sameMsAll = await ctx.db
      .query("traceEvents")
      .withIndex("by_at", (q) => q.eq("at", since))
      .order("asc")
      .take(MAX_SAME_MS_SCAN);
    const sameMs = sameMsAll
      .filter((r) => r._id > sinceId)
      .sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
      .slice(0, take);
    const rest = take - sameMs.length;
    const newer =
      rest > 0
        ? await ctx.db
            .query("traceEvents")
            .withIndex("by_at", (q) => q.gt("at", since))
            .order("asc")
            .take(rest)
        : [];
    return [...sameMs, ...newer].map(projectShippable);
  },
});

/** Project a traceEvents row to the shippable (metadata-only) subset (D2). */
function projectShippable(r: Doc<"traceEvents">): ShippableEvent {
  return {
    _id: r._id,
    at: r.at,
    kind: r.kind,
    direction: r.direction,
    principalType: r.principalType,
    principalId: r.principalId,
    roleKey: r.roleKey,
    route: r.route,
    method: r.method,
    status: r.status,
    latencyMs: r.latencyMs,
    chatId: r.chatId,
    runId: r.runId,
    correlationId: r.correlationId,
    meta: r.meta,
  };
}

/** Read a vendor's current watermark `at` (or null when it has never shipped). */
export const getCursor = internalQuery({
  args: { vendor: v.string() },
  handler: async (ctx: QueryCtx, { vendor }): Promise<number | null> => {
    const row = await ctx.db
      .query("integrationCursors")
      .withIndex("by_vendor", (q) => q.eq("vendor", vendor))
      .unique();
    return row?.lastAt ?? null;
  },
});

/** Secret-free view of a vendor cursor row (composite watermark + L4 state). */
type CursorView = {
  lastAt: number;
  lastId: string | null;
  failureCount: number;
};

/**
 * Read the full cursor row for a vendor (composite watermark + failure count).
 * `getCursor` (numeric) is kept alongside for the existing unit test.
 */
export const getCursorRow = internalQuery({
  args: { vendor: v.string() },
  handler: async (ctx: QueryCtx, { vendor }): Promise<CursorView | null> => {
    const row = await ctx.db
      .query("integrationCursors")
      .withIndex("by_vendor", (q) => q.eq("vendor", vendor))
      .unique();
    if (row === null) return null;
    return {
      lastAt: row.lastAt,
      lastId: row.lastId ?? null,
      failureCount: row.failureCount ?? 0,
    };
  },
});

/**
 * Advance a vendor's composite watermark to (lastAt, lastId) (upsert by vendor)
 * and RESET the L4 failure state — advance happens ONLY after a successful send,
 * so a failed flush re-attempts the same events next run. Monotonic on the
 * composite key: never move backwards (also advances when `at` is equal but the
 * id is greater, so same-ms paging cannot stall).
 */
export const advanceCursor = internalMutation({
  args: {
    vendor: v.string(),
    lastAt: v.number(),
    lastId: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    { vendor, lastAt, lastId },
  ): Promise<void> => {
    const row = await ctx.db
      .query("integrationCursors")
      .withIndex("by_vendor", (q) => q.eq("vendor", vendor))
      .unique();
    if (row === null) {
      await ctx.db.insert("integrationCursors", {
        vendor,
        lastAt,
        lastId,
        failureCount: 0,
      });
      return;
    }
    const forward =
      lastAt > row.lastAt ||
      (lastAt === row.lastAt &&
        lastId !== undefined &&
        (row.lastId === undefined || lastId > row.lastId));
    if (forward) {
      await ctx.db.patch(row._id, { lastAt, lastId, failureCount: 0 });
    } else {
      // Watermark unchanged, but a successful send still clears any failure run.
      if ((row.failureCount ?? 0) !== 0) {
        await ctx.db.patch(row._id, { failureCount: 0 });
      }
    }
  },
});

/**
 * L4: record a consecutive send failure on the vendor cursor (secret-free —
 * reason CODE + optional vendor HTTP status ONLY, never a raw error message).
 * Returns the new consecutive failure count so the caller can emit an anomaly
 * exactly once when it crosses the threshold. Never advances the watermark.
 */
export const recordFailure = internalMutation({
  args: {
    vendor: v.string(),
    reason: v.string(), // reason code, e.g. "send_failed" | "exception"
    status: v.optional(v.number()),
  },
  handler: async (
    ctx: MutationCtx,
    { vendor, reason, status },
  ): Promise<{ failureCount: number }> => {
    const row = await ctx.db
      .query("integrationCursors")
      .withIndex("by_vendor", (q) => q.eq("vendor", vendor))
      .unique();
    if (row === null) {
      // No watermark yet (vendor never initialized) — record the failure on a
      // fresh row anchored at 0 so the count survives across flushes.
      await ctx.db.insert("integrationCursors", {
        vendor,
        lastAt: 0,
        failureCount: 1,
        lastError: reason,
        lastErrorStatus: status,
      });
      return { failureCount: 1 };
    }
    const failureCount = (row.failureCount ?? 0) + 1;
    await ctx.db.patch(row._id, {
      failureCount,
      lastError: reason,
      lastErrorStatus: status,
    });
    return { failureCount };
  },
});

/**
 * Flush NEW trace events to each CONFIGURED vendor. Bounded, best-effort, and
 * crash-safe: every vendor is handled in its own try/catch, an unconfigured
 * vendor is a pure no-op, and the action NEVER throws into the cron. Returns a
 * per-vendor summary (booleans + counts only — no secrets).
 *
 * Driven by the 5-minute cron; also safe to invoke directly (the live gate runs
 * `convex run integrations/ship:flushToVendors '{}'`).
 */
export const flushToVendors = internalAction({
  args: {},
  handler: async (ctx): Promise<{ vendors: VendorFlushResult[] }> => {
    const now = Date.now();
    const results: VendorFlushResult[] = [];

    // Non-secret admin overrides (host/baseUrl/workspace/enabled). An action has
    // no ctx.db, so read them via an internalQuery; keys stay in env.
    const ov = await ctx.runQuery(
      internal.integrations.ship.vendorOverrides,
      {},
    );

    // Langfuse — ship only when configured (keys present) AND not paused.
    const lf = langfuseConfig(ov.langfuse);
    results.push(
      await flushOneVendor(ctx, {
        vendor: VENDOR_LANGFUSE,
        configured: lf.configured && lf.enabled,
        now,
        sendBatch: (events) => langfuse.send(lf, events),
      }),
    );

    // Opik.
    const op = opikConfig(ov.opik);
    results.push(
      await flushOneVendor(ctx, {
        vendor: VENDOR_OPIK,
        configured: op.configured && op.enabled,
        now,
        sendBatch: (events) => opik.send(op, events),
      }),
    );

    // Generic OTLP — the operator's own OpenTelemetry backend. The auth headers are
    // an ENCRYPTED secret; decrypt them lazily INSIDE sendBatch (only when there are
    // events to send), so a missing/rotated master key or a tampered envelope
    // surfaces as a vendor failure (cursor NOT advanced, anomaly after N) rather
    // than crashing the cron.
    const ot = otlpConfig({
      endpoint: ov.otlp.endpoint,
      enabled: ov.otlp.enabled,
    });
    const otHeadersSecret = ov.otlp.headersSecret;
    results.push(
      await flushOneVendor(ctx, {
        vendor: VENDOR_OTLP,
        configured: ot.configured && ot.enabled,
        now,
        sendBatch: async (events) => {
          const headers = await decryptOtlpHeaders(otHeadersSecret);
          return otlp.send({ ...ot, headers }, events);
        },
      }),
    );

    return { vendors: results };
  },
});

/** Read the non-secret vendor overrides for the flush action (no ctx.db there). */
export const vendorOverrides = internalQuery({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<{
    langfuse: LangfuseOverride;
    opik: OpikOverride;
    // The OTLP blob includes the ENCRYPTED headers envelope (ciphertext only — safe
    // to return to the flush ACTION, which decrypts it; NEVER reaches the browser).
    otlp: {
      endpoint?: string;
      enabled?: boolean;
      headersSecret?: EncryptedSecret;
    };
  }> => {
    const cfg = await readIntegrationConfig(ctx);
    return {
      langfuse: cfg?.langfuse ?? {},
      opik: cfg?.opik ?? {},
      otlp: cfg?.otlp ?? {},
    };
  },
});

/**
 * Flush a single vendor end-to-end. Unconfigured → pure no-op. Otherwise read
 * the next bounded batch since the watermark, send it, and advance the watermark
 * on success only. Any unexpected throw is contained here and reported as a
 * failed outcome (never propagated to the cron).
 */
async function flushOneVendor(
  ctx: ActionCtx,
  opts: {
    vendor: string;
    configured: boolean;
    now: number;
    sendBatch: (events: ShippableEvent[]) => Promise<SendResult>;
  },
): Promise<VendorFlushResult> {
  const { vendor, configured, now, sendBatch } = opts;
  if (!configured) {
    return { vendor, configured: false, shipped: 0, ok: true, skipped: true, reason: "unconfigured" };
  }

  try {
    // Resolve the composite watermark; first-ever flush starts forward-only.
    const stored: CursorView | null = await ctx.runQuery(
      internal.integrations.ship.getCursorRow,
      { vendor },
    );
    if (stored === null) {
      // Seed the watermark forward-only; ship begins from the NEXT event.
      await ctx.runMutation(internal.integrations.ship.advanceCursor, {
        vendor,
        lastAt: now,
      });
      return { vendor, configured: true, shipped: 0, ok: true, reason: "initialized", newCursor: now };
    }

    const events: ShippableEvent[] = await ctx.runQuery(
      internal.integrations.ship.unsentSince,
      {
        since: stored.lastAt,
        sinceId: stored.lastId ?? undefined,
        limit: FLUSH_BATCH,
      },
    );
    if (events.length === 0) {
      return { vendor, configured: true, shipped: 0, ok: true, reason: "up_to_date" };
    }

    const result = await sendBatch(events);
    if (!result.ok) {
      // Send failed: DO NOT advance the cursor (retry these next flush). L4:
      // record a secret-free consecutive-failure run and emit an anomaly once
      // it crosses the threshold so a wedged vendor surfaces to operators.
      const reason = result.reason ?? "send_failed";
      await recordVendorFailure(ctx, vendor, reason, result.status);
      return {
        vendor,
        configured: true,
        shipped: 0,
        ok: false,
        status: result.status,
        reason,
      };
    }

    // Advance the composite watermark to the newest shipped event (events are
    // oldest-first, so the last one is the newest). Resets L4 failure state.
    const last = events[events.length - 1]!;
    await ctx.runMutation(internal.integrations.ship.advanceCursor, {
      vendor,
      lastAt: last.at,
      lastId: last._id,
    });
    return {
      vendor,
      configured: true,
      shipped: result.count,
      ok: true,
      status: result.status,
      newCursor: last.at,
    };
  } catch (err) {
    // Contain ANY unexpected error: the cron must never see a thrown action.
    // L4: a generic "exception" code only (never the raw message — no secrets).
    console.error(`integrations.flush(${vendor}) failed:`, errMsg(err));
    try {
      await recordVendorFailure(ctx, vendor, "exception", undefined);
    } catch {
      // Never let the failure bookkeeping itself throw into the cron.
    }
    return { vendor, configured: true, shipped: 0, ok: false, reason: "exception" };
  }
}

/**
 * L4 helper: record a consecutive vendor failure and, exactly once when the run
 * reaches the threshold, emit a detector-source anomaly (metadata only — vendor
 * name + reason code + status; never a secret). Best-effort; never throws.
 */
async function recordVendorFailure(
  ctx: ActionCtx,
  vendor: string,
  reason: string,
  status: number | undefined,
): Promise<void> {
  const { failureCount } = await ctx.runMutation(
    internal.integrations.ship.recordFailure,
    { vendor, reason, status },
  );
  if (failureCount === FAILURE_ANOMALY_THRESHOLD) {
    await ctx.runMutation(internal.anomalies.reportAnomalyInternal, {
      kind: `integration.egress_wedged.${vendor}`,
      severity: "warn",
      message: `Trace egress to ${vendor} has failed ${failureCount} consecutive flushes (${reason}${status !== undefined ? ` status ${status}` : ""})`,
      evidence: JSON.stringify({
        vendor,
        failureCount,
        reason,
        ...(status !== undefined ? { status } : {}),
        source: "integration.ship",
      }),
    });
  }
}

/** Error → message WITHOUT leaking secrets (we never put secrets in errors). */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
