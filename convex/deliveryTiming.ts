// Delivery-latency recorder — a controllable, content-free measurement of the
// bridge -> Convex -> frontend streaming pipeline. OFF by default (zero hot-path
// cost). A session is started/stopped from Settings>Traces or via MCP; every
// recorded delta is correlated by `seq` and reported skew-corrected. Skews follow
// the calibrateClock convention `skew = serverClock - localClock`, so a LOCAL-clock
// timestamp is converted to server time by ADDING its skew. The earlier endpoint of
// a cross-clock segment carries the local stamp, so the sign differs per segment:
//   A = t2 - (t1 + bridgeSkew) = t2 - t1 - bridgeSkew  (bridge->Convex; t1 local, earlier)
//   B = t3 - t2                                          (Convex exec; same clock)
//   C = (t4 + clientSkew) - t3 = t4 - t3 + clientSkew   (Convex->frontend; t4 local, later)
//
// SAMPLING: A and B are recorded for EVERY delta. C is necessarily SAMPLED at the
// frontend's observation rate — Convex's reactive sync COALESCES intermediate states
// (the client renders the latest, never each delta), so a delta superseded before the
// client observes it has no user-facing delivery to time. The single in-band slot
// (streamingText.recTimingId, latest-wins) reflects exactly that: the frontend closes
// C for the states it actually rendered. So `segments.C.count <= segments.A.count` is
// EXPECTED, not a loss — the report exposes both counts so the gap is explicit.
// All values are timestamps/sizes only — NEVER message content (SOC2). See the
// schema (deliveryRecording / deliverySessions / deliveryTimings) and the hooks
// in stream.ts (appendDelta/setSnapshot) + messages.ts (getStreamingText).

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireActive, requireAdmin, requirePermission } from "./lib/access";

const SINGLETON = "singleton";
// Safety: a recording auto-stops after this window even if never stopped, so an
// enabled flag left on can't accrue cost forever. Also bounds storage (~minutes
// of deltas). `activeRecording` treats a past-cutoff session as OFF.
const AUTO_STOP_MS = 10 * 60 * 1000;
// Upper bound on timing rows pulled into a single report (a 10-min session at a
// few deltas/sec stays well under this).
const REPORT_CAP = 10000;

/**
 * The active recording session, or null when OFF or past its safety auto-stop.
 * One indexed point-read — the ONLY cost appendDelta/setSnapshot pay when a
 * recording is not active (and only when the caller passed a `seq` at all).
 */
export async function activeRecording(
  ctx: QueryCtx | MutationCtx,
): Promise<{ sessionId: string } | null> {
  const cfg = await ctx.db
    .query("deliveryRecording")
    .withIndex("by_key", (q) => q.eq("key", SINGLETON))
    .unique();
  if (cfg === null || !cfg.enabled || cfg.sessionId === undefined) return null;
  if (cfg.autoStopAt !== undefined && Date.now() > cfg.autoStopAt) return null;
  return { sessionId: cfg.sessionId };
}

/**
 * Record one delta: insert a timing row (t1/t2 from the caller, t3 = now) and echo
 * its _id (the unique correlator) + t3 onto the streaming row, so getStreamingText
 * carries them in-band for the frontend to close segment C. Called ONLY when the
 * delta's session matches the active recording (validated by the caller).
 */
export async function recordDelta(
  ctx: MutationCtx,
  args: {
    sessionId: string;
    streamRowId: Id<"streamingText">;
    chatId: Id<"chats">;
    t1: number;
    t2: number;
    bridgeSkew?: number;
    sizeBytes?: number;
  },
): Promise<void> {
  // Insert first to get the correlator id; t3 is provisional, restamped below.
  const timingId = await ctx.db.insert("deliveryTimings", {
    sessionId: args.sessionId,
    chatId: args.chatId,
    t1: args.t1,
    t2: args.t2,
    t3: args.t2,
    bridgeSkew: args.bridgeSkew,
    sizeBytes: args.sizeBytes,
  });
  // Stamp t3 AFTER the recorder's insert (its dominant write) so that write falls in
  // segment B (Convex exec) instead of inflating segment C — the frontend observes
  // this sample only AFTER the mutation commits. (Codex review: a pre-insert t3
  // charged server-side recorder time to the delivery segment.)
  const t3 = Date.now();
  await ctx.db.patch(timingId, { t3 });
  await ctx.db.patch(args.streamRowId, {
    recTimingId: timingId,
    recCommittedAt: t3,
  });
}

// --- Start / stop ----------------------------------------------------------

// Core start logic, identity-agnostic so both the admin-gated public mutation
// and (Phase 4) the key-authed MCP/HTTP path can reuse it. `startedBy` is a
// non-secret label ("admin:<userId>" | "agent:<account>").
async function startRecordingInternal(
  ctx: MutationCtx,
  startedBy: string,
): Promise<{ sessionId: Id<"deliverySessions">; autoStopAt: number }> {
  const now = Date.now();
  const autoStopAt = now + AUTO_STOP_MS;
  const sessionId = await ctx.db.insert("deliverySessions", {
    startedAt: now,
    startedBy,
    autoStopAt,
  });
  const cfg = await ctx.db
    .query("deliveryRecording")
    .withIndex("by_key", (q) => q.eq("key", SINGLETON))
    .unique();
  if (cfg === null) {
    await ctx.db.insert("deliveryRecording", {
      key: SINGLETON,
      enabled: true,
      sessionId,
      autoStopAt,
    });
  } else {
    await ctx.db.patch(cfg._id, { enabled: true, sessionId, autoStopAt });
  }
  return { sessionId, autoStopAt };
}

async function stopRecordingInternal(
  ctx: MutationCtx,
): Promise<{ stopped: boolean }> {
  const cfg = await ctx.db
    .query("deliveryRecording")
    .withIndex("by_key", (q) => q.eq("key", SINGLETON))
    .unique();
  if (cfg === null) return { stopped: false };
  if (cfg.sessionId !== undefined) {
    const sid = ctx.db.normalizeId("deliverySessions", cfg.sessionId);
    if (sid !== null) {
      const sess = await ctx.db.get(sid);
      if (sess !== null && sess.stoppedAt === undefined) {
        await ctx.db.patch(sid, { stoppedAt: Date.now() });
      }
    }
  }
  await ctx.db.patch(cfg._id, { enabled: false, sessionId: undefined });
  return { stopped: true };
}

// Toggling the recorder has a cost, so ACTIVATION is admin-only (the MCP/agent
// path in Phase 4 reuses startRecordingInternal behind the service-account key).
export const startDeliveryRecord = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAdmin(ctx);
    return await startRecordingInternal(ctx, `admin:${userId}`);
  },
});

export const stopDeliveryRecord = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await stopRecordingInternal(ctx);
  },
});

// Agent/MCP path: the key-authed HTTP routes (convex/http.ts) authenticate the
// service-account key + check the permission, then run these. This is the "agent
// may activate" half of the gate (admin via the public mutations above).
export const startDeliveryRecordForAgent = internalMutation({
  args: { principalId: v.string() },
  handler: async (ctx, { principalId }) =>
    startRecordingInternal(ctx, `agent:${principalId}`),
});

export const stopDeliveryRecordForAgent = internalMutation({
  args: {},
  handler: async (ctx) => stopRecordingInternal(ctx),
});

// Read by bridge_ingest at startAssistant (once per turn): tells the bridge whether
// to tag this turn's deltas + a server timestamp for skew. Doing the recording
// point-read ONCE per turn (not per delta) keeps the delta hot path free when OFF —
// the bridge sends no `seq`, so appendDelta/setSnapshot skip activeRecording.
export const getActiveRecordingForBridge = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rec = await activeRecording(ctx);
    return {
      recording: rec !== null,
      serverNow: Date.now(),
      // The bridge carries this back on each tagged delta; Convex records only when
      // it still matches the active session (so a late delta from a turn started
      // under an OLD session is never mis-filed into a NEW one).
      sessionId: rec?.sessionId ?? null,
    };
  },
});

// --- Clock calibration -----------------------------------------------------

// Echo the caller's send time + the server clock so the caller (frontend, or the
// bridge in Phase 2) can derive its skew: skew = serverNow - (clientSentAt + RTT/2),
// RTT measured on the caller's single clock. No content; any active user may ping.
export const calibrateClock = mutation({
  args: { clientSentAt: v.number() },
  handler: async (ctx, { clientSentAt }) => {
    await requireActive(ctx);
    return { clientSentAt, serverNow: Date.now() };
  },
});

// --- Frontend t4 ingest (batched) ------------------------------------------

// The frontend, on receiving an in-band {recTimingId, recCommittedAt} push, stamps
// t4 and reports a batch here (~1/s) to close segment C. Keyed by the timing row's
// unique _id; owner-scoped (only a timing on a chat the caller owns), and skips
// unknown / already-closed rows.
export const recordFrontendTiming = mutation({
  args: {
    samples: v.array(
      v.object({
        timingId: v.string(),
        t4: v.number(),
        clientSkew: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { samples }) => {
    const { userId } = await requireActive(ctx);
    let patched = 0;
    for (const s of samples) {
      const id = ctx.db.normalizeId("deliveryTimings", s.timingId);
      if (id === null) continue;
      const row = await ctx.db.get(id);
      if (row === null || row.t4 !== undefined) continue;
      const chat = await ctx.db.get(row.chatId);
      if (chat === null || chat.userId !== userId) continue; // IDOR guard
      await ctx.db.patch(id, { t4: s.t4, clientSkew: s.clientSkew });
      patched++;
    }
    return { patched };
  },
});

// --- Report ----------------------------------------------------------------

type SegStat = {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

function percentile(sorted: number[], p: number): number {
  // Nearest-rank on an already-sorted ascending array: rank = ceil(p/100 * n),
  // index = rank - 1 (clamped). `floor` would overshoot (p50 of 2 -> idx 1, p95
  // of 100 -> idx 95), overestimating the percentile.
  const n = sorted.length;
  const i = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sorted[i];
}

function segStat(values: number[]): SegStat {
  if (values.length === 0)
    return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

// Resolve the session to report on: explicit arg, else the active session, else
// the most recent one.
async function resolveSessionId(
  ctx: QueryCtx,
  sessionId: string | undefined,
): Promise<string | null> {
  if (sessionId !== undefined) return sessionId;
  const cfg = await ctx.db
    .query("deliveryRecording")
    .withIndex("by_key", (q) => q.eq("key", SINGLETON))
    .unique();
  if (cfg?.sessionId !== undefined) return cfg.sessionId;
  const latest = await ctx.db.query("deliverySessions").order("desc").first();
  return latest?._id ?? null;
}

// Current recorder state for the Settings UI toggle (content-free). traces.read can
// read it; only an admin may actually start/stop (those mutations enforce it).
export const getDeliveryStatus = query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, "traces.read");
    const cfg = await ctx.db
      .query("deliveryRecording")
      .withIndex("by_key", (q) => q.eq("key", SINGLETON))
      .unique();
    if (cfg === null || !cfg.enabled || cfg.sessionId === undefined) {
      return {
        recording: false,
        sessionId: null,
        startedAt: null,
        autoStopAt: null,
      };
    }
    const expired = cfg.autoStopAt !== undefined && Date.now() > cfg.autoStopAt;
    const sid = ctx.db.normalizeId("deliverySessions", cfg.sessionId);
    const sess = sid !== null ? await ctx.db.get(sid) : null;
    return {
      recording: !expired,
      sessionId: cfg.sessionId,
      startedAt: sess?.startedAt ?? null,
      autoStopAt: cfg.autoStopAt ?? null,
    };
  },
});

// Skew-corrected per-segment report for a session. CONTENT-FREE. Shared by the
// user-authed query (Settings UI) and the key-authed MCP/HTTP path.
async function computeDeliveryReport(
  ctx: QueryCtx,
  sessionId: string | undefined,
) {
  const sid = await resolveSessionId(ctx, sessionId);
  if (sid === null) {
    return { sessionId: null, count: 0, segments: null, worst: [] };
  }
  const rows = await ctx.db
    .query("deliveryTimings")
    .withIndex("by_session", (q) => q.eq("sessionId", sid))
    .take(REPORT_CAP);

  const aVals: number[] = [];
  const bVals: number[] = [];
  const cVals: number[] = [];
  const perDelta = rows.map((r) => {
    const a = r.t2 - r.t1 - (r.bridgeSkew ?? 0);
    const b = r.t3 - r.t2;
    // C ADDS clientSkew: t4 is a browser-clock stamp at the LATER endpoint, so
    // converting it to server time (+clientSkew) nets to +. (A's t1 is the earlier
    // endpoint, hence -bridgeSkew.) Do NOT "simplify" the sign to match A.
    const c =
      r.t4 !== undefined ? r.t4 - r.t3 + (r.clientSkew ?? 0) : undefined;
    aVals.push(a);
    bVals.push(b);
    if (c !== undefined) cVals.push(c);
    return { id: r._id, a, b, c, sizeBytes: r.sizeBytes };
  });

  const worst = [...perDelta]
    .sort((x, y) => y.a + y.b + (y.c ?? 0) - (x.a + x.b + (x.c ?? 0)))
    .slice(0, 10);

  return {
    sessionId: sid,
    count: rows.length,
    segments: { A: segStat(aVals), B: segStat(bVals), C: segStat(cVals) },
    worst,
  };
}

// User-authed (Settings UI): gate traces.read.
export const getDeliveryReport = query({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, { sessionId }) => {
    await requirePermission(ctx, "traces.read");
    return computeDeliveryReport(ctx, sessionId);
  },
});

// Agent/MCP path: the key-authed HTTP route checks traces.read on the principal,
// then runs this (no user identity).
export const getDeliveryReportInternal = internalQuery({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, { sessionId }) => computeDeliveryReport(ctx, sessionId),
});
