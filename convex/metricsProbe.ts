// Synthetic backend-latency probe (perf-trend instrumentation).
//
// A fixed-cadence cron (crons.ts -> runLatencyProbe) times a representative,
// identity-free, content-free READ and records its SERVER-SIDE execution latency
// as a `convex.probe` trace. kpi.ts rolls these up into
// `convex.probe.latency.avg_ms`.
//
// WHY a synthetic probe (not piggybacking organic traces): organic per-turn
// events are too sparse (chat.send is 0-4/hour) to form a trend, and the
// high-frequency delta path is deliberately UN-traced to avoid write
// amplification on a resource-constrained backend (see bridge_ingest.ts). A
// fixed-cadence probe controls for traffic, so a latency change is attributable
// to the BACKEND (NAS saturation vs Convex Cloud), not to traffic differing
// between two measurement windows.
//
// SCOPE of the signal (label it honestly): this is server-side query EXECUTION
// latency — a strong proxy for backend load, NOT full client-perceived display
// latency (network + render are excluded; those would need frontend
// instrumentation). It samples at fixed intervals under whatever load exists then
// (it won't catch every burst), and on the NAS it competes for the same resources
// it measures — but the IDENTICAL probe post-migration is an apples-to-apples
// before/after.

import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// Rows read per probe — a bounded window mirroring a chat-view-sized read over the
// busiest table (`messages`, what loadChatView reads). Fixed so the per-run cost
// is stable and the before/after stays apples-to-apples.
const PROBE_READ_ROWS = 200;
// Recorded when the probe READ itself fails (e.g. the backend rejects it under
// saturation). A failed probe is signal, not a crash: surface a high sentinel so
// the rollup average visibly spikes rather than silently dropping the sample.
const PROBE_ERROR_SENTINEL_MS = 60_000;

/**
 * Representative bounded READ, identity-free and content-free (returns a COUNT,
 * never message content). `nonce` is unused by the read itself but is PART OF THE
 * ARGS so Convex cannot serve a cached result — each probe measures a REAL
 * execution, which is what makes the latency a faithful load signal.
 */
export const probeRead = internalQuery({
  args: { nonce: v.number() },
  handler: async (ctx, { nonce }) => {
    const rows = await ctx.db.query("messages").take(PROBE_READ_ROWS);
    return { rows: rows.length, nonce };
  },
});

/**
 * Time the probe read and record a `convex.probe` trace carrying `latencyMs`
 * (server-side execution time). Best-effort: a read failure records the sentinel
 * latency + `ok:false` rather than throwing (the cron must never crash).
 */
export const runLatencyProbe = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const startedAt = Date.now();
    let latencyMs: number;
    let ok: boolean;
    let rows: number | undefined;
    try {
      const res = await ctx.runQuery(internal.metricsProbe.probeRead, {
        nonce: startedAt,
      });
      latencyMs = Date.now() - startedAt;
      rows = res.rows;
      ok = true;
    } catch {
      // Saturation/timeout: the failure IS the signal — record a high sentinel
      // (or the real elapsed if it somehow exceeded the sentinel).
      latencyMs = Math.max(Date.now() - startedAt, PROBE_ERROR_SENTINEL_MS);
      ok = false;
    }
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "convex.probe",
      direction: "internal",
      principalType: "system",
      principalId: "probe",
      latencyMs,
      // Non-PHI: a probe label, the row COUNT (never content), and the ok flag.
      meta: JSON.stringify({ probe: "read_window", rows, ok }),
    });
  },
});
