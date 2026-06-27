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
import { internal } from "./_generated/api";
import { requireActive, requireAdmin, requirePermission } from "./lib/access";

const SINGLETON = "singleton";
// Safety: a recording auto-stops after this window even if never stopped, so an
// enabled flag left on can't accrue cost forever. Also bounds storage (~minutes
// of deltas). `activeRecording` treats a past-cutoff session as OFF.
const AUTO_STOP_MS = 10 * 60 * 1000;
// Upper bound on timing rows pulled into a single report (a 10-min session at a
// few deltas/sec stays well under this).
const REPORT_CAP = 10000;
// Max frontend t4 samples processed per recordFrontendTiming call (each = 2 reads +
// 1 write). The client batches ~1/s (tens at most); this just caps a hostile/buggy
// array so the mutation can't reach Convex's transaction limit.
const FRONTEND_BATCH_CAP = 500;

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
    t0?: number;
    t1: number;
    t2: number;
    bridgeSkew?: number;
    sizeBytes?: number;
  },
): Promise<Id<"deliveryTimings">> {
  // t3 == t2 deliberately: Convex FREEZES Date.now() for the whole mutation
  // (determinism), so a post-insert re-stamp would read the SAME value — the old code
  // did exactly that and measured nothing (segment B was structurally 0). Convex exec
  // time is sourced from Convex's own telemetry (insights / log streaming), not here.
  // t3 is kept only as the C-segment server anchor (= the mutation timestamp = t2).
  const timingId = await ctx.db.insert("deliveryTimings", {
    sessionId: args.sessionId,
    t0: args.t0,
    chatId: args.chatId,
    t1: args.t1,
    t2: args.t2,
    t3: args.t2,
    bridgeSkew: args.bridgeSkew,
    sizeBytes: args.sizeBytes,
  });
  await ctx.db.patch(args.streamRowId, {
    recTimingId: timingId,
    recCommittedAt: args.t2,
  });
  // Returned so the caller can tag the SSE chunk with the same correlator (the SSE leg
  // closes segment C at the displayed receipt — see streamChunks.recTimingId).
  return timingId;
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
    // The bridge carries `sessionId` back on each tagged delta; Convex records only
    // when it still matches the active session (so a late delta from a turn started
    // under an OLD session is never mis-filed into a NEW one). The current bridge
    // derives the clock skew from the separate lightweight `calibrate` op (this heavy
    // startAssistant call would bias it). `serverNow` is kept ONLY for rolling-deploy
    // safety: a pre-calibrate bridge still reads it, so it computes a (biased but
    // numeric) skew instead of NaN -> bridgeSkew:null -> a rejected delta that would
    // break a recorded turn mid-deploy. The current bridge ignores this field.
    return {
      recording: rec !== null,
      sessionId: rec?.sessionId ?? null,
      serverNow: Date.now(),
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
    // Bound the per-call work (2 reads + 1 write each): the frontend batches ~1/s so
    // this never bites in practice, but the server must not trust a client array length
    // (Convex allows up to 8192) and push the mutation to its transaction limit.
    for (const s of samples.slice(0, FRONTEND_BATCH_CAP)) {
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
    return {
      sessionId: null,
      count: 0,
      truncated: false,
      segments: null,
      worst: [],
    };
  }
  // Read ONE past the cap so a session with exactly REPORT_CAP rows (complete) is
  // distinguished from one with more (truncated); the stats then window to the cap.
  // by_session is chronological, so the window keeps the EARLIEST rows — the LATEST
  // deltas are the ones omitted when truncated.
  const raw = await ctx.db
    .query("deliveryTimings")
    .withIndex("by_session", (q) => q.eq("sessionId", sid))
    .take(REPORT_CAP + 1);
  const truncated = raw.length > REPORT_CAP;
  const rows = truncated ? raw.slice(0, REPORT_CAP) : raw;

  const bridgeVals: number[] = [];
  const aVals: number[] = [];
  const cVals: number[] = [];
  const perDelta = rows.map((r) => {
    // Bridge-internal: receipt of the flush's first delta -> send. Single-clock
    // (bridge), so NO skew. Absent on a setSnapshot row (no t0) -> excluded.
    const bridge = r.t0 !== undefined ? r.t1 - r.t0 : undefined;
    // A only when the delta is clock-corrected: a delta recorded before the bridge's
    // calibration completes has no bridgeSkew, and t2 - t1 raw would be off by the
    // full clock offset (garbage). Exclude it rather than pollute A's stats (same as
    // C excludes deltas with no t4 yet).
    const a =
      r.bridgeSkew !== undefined ? r.t2 - r.t1 - r.bridgeSkew : undefined;
    // NOTE: there is NO B (Convex exec) segment — Date.now() is frozen within a Convex
    // mutation so t3==t2 and an in-app gap is structurally 0. Convex exec time comes
    // from Convex's own telemetry (insights / log streaming), reported separately.
    // C ADDS clientSkew: t4 is a browser-clock stamp at the LATER endpoint, so
    // converting it to server time (+clientSkew) nets to +. (A's t1 is the earlier
    // endpoint, hence -bridgeSkew.) Do NOT "simplify" the sign to match A.
    const c =
      r.t4 !== undefined ? r.t4 - r.t3 + (r.clientSkew ?? 0) : undefined;
    if (bridge !== undefined) bridgeVals.push(bridge);
    if (a !== undefined) aVals.push(a);
    if (c !== undefined) cVals.push(c);
    return { id: r._id, bridge, a, c, sizeBytes: r.sizeBytes };
  });

  const total = (x: { bridge?: number; a?: number; c?: number }) =>
    (x.bridge ?? 0) + (x.a ?? 0) + (x.c ?? 0);
  const worst = [...perDelta].sort((x, y) => total(y) - total(x)).slice(0, 10);

  return {
    sessionId: sid,
    count: rows.length,
    // Flagged so a very chatty session's capped stats aren't read as complete.
    truncated,
    segments: {
      bridge: segStat(bridgeVals),
      A: segStat(aVals),
      C: segStat(cVals),
    },
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

// --- Sessions: list + delete -----------------------------------------------

const SESSION_LIST_CAP = 50; // most recent sessions surfaced
const MAX_DELETE_SESSIONS = 50; // bound a single delete batch
const TIMING_DELETE_BATCH = 2000; // per-iteration delete page when purging a session

type SessionSummary = {
  sessionId: string;
  startedAt: number;
  stoppedAt: number | null;
  startedBy: string;
  active: boolean;
};

async function listSessionsImpl(ctx: QueryCtx): Promise<SessionSummary[]> {
  const cfg = await ctx.db
    .query("deliveryRecording")
    .withIndex("by_key", (q) => q.eq("key", SINGLETON))
    .unique();
  const activeId =
    cfg?.enabled === true &&
    cfg.sessionId !== undefined &&
    (cfg.autoStopAt === undefined || Date.now() <= cfg.autoStopAt)
      ? cfg.sessionId
      : undefined;
  const sessions = await ctx.db
    .query("deliverySessions")
    .order("desc")
    .take(SESSION_LIST_CAP);
  return sessions.map((s) => ({
    sessionId: s._id,
    startedAt: s.startedAt,
    // An auto-stopped session (lapsed past autoStopAt, never explicitly stopped) has
    // no stoppedAt; surface its effective stop time so the list doesn't read as
    // "never stopped" next to active:false.
    stoppedAt:
      s.stoppedAt ?? (Date.now() > s.autoStopAt ? s.autoStopAt : null),
    startedBy: s.startedBy,
    active: s._id === activeId,
  }));
}

// Delete is BOUNDED + self-scheduling: a single Convex mutation has transaction
// limits, so deleting many sessions (or one very active session) all at once would
// abort and delete nothing (Codex review). Each step drains ONE session's timings by
// a bounded page; once that session is empty it deletes the row and reschedules for
// the rest, so the whole job completes across many small mutations.
export const deleteSessionsStep = internalMutation({
  args: { sessionIds: v.array(v.string()) },
  handler: async (ctx, { sessionIds }) => {
    if (sessionIds.length === 0) return;
    const [sidStr, ...rest] = sessionIds;
    // Recording for any to-delete session was already disabled up-front by
    // scheduleDelete, so no new deltas land during this multi-step purge.
    const batch = await ctx.db
      .query("deliveryTimings")
      .withIndex("by_session", (q) => q.eq("sessionId", sidStr))
      .take(TIMING_DELETE_BATCH);
    for (const t of batch) await ctx.db.delete(t._id);
    if (batch.length === TIMING_DELETE_BATCH) {
      // More timings remain for this session — keep draining it before moving on.
      await ctx.scheduler.runAfter(
        0,
        internal.deliveryTiming.deleteSessionsStep,
        { sessionIds },
      );
      return;
    }
    // Drained: remove the session row (idempotent — skip if already gone, so a
    // duplicate id / re-delete / concurrent purge can't throw and break the chain,
    // leaving later sessions unpurged — Codex review), then continue with the rest.
    const sid = ctx.db.normalizeId("deliverySessions", sidStr);
    if (sid !== null && (await ctx.db.get(sid)) !== null) {
      await ctx.db.delete(sid);
    }
    if (rest.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.deliveryTiming.deleteSessionsStep,
        { sessionIds: rest },
      );
    }
  },
});

// Kick off a bounded, self-scheduling delete of up to MAX_DELETE_SESSIONS sessions.
// Returns immediately ({ scheduled }); sessions disappear from the reactive list as
// the steps drain them.
async function scheduleDelete(
  ctx: MutationCtx,
  sessionIds: string[],
): Promise<{ scheduled: number }> {
  const ids = [...new Set(sessionIds)].slice(0, MAX_DELETE_SESSIONS);
  if (ids.length === 0) return { scheduled: 0 };
  // If the ACTIVE session is anywhere in the batch, stop recording NOW — before any
  // purge step runs — so no new deltas land while the (possibly multi-step, multi-
  // session) delete proceeds, even when the active session isn't processed first
  // (Codex review).
  const cfg = await ctx.db
    .query("deliveryRecording")
    .withIndex("by_key", (q) => q.eq("key", SINGLETON))
    .unique();
  if (
    cfg !== null &&
    cfg.sessionId !== undefined &&
    ids.includes(cfg.sessionId)
  ) {
    await ctx.db.patch(cfg._id, { enabled: false, sessionId: undefined });
  }
  await ctx.scheduler.runAfter(0, internal.deliveryTiming.deleteSessionsStep, {
    sessionIds: ids,
  });
  return { scheduled: ids.length };
}

// User-authed (Settings UI): list = traces.read; delete = admin (a write).
export const listDeliverySessions = query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, "traces.read");
    return listSessionsImpl(ctx);
  },
});

export const deleteDeliverySessions = mutation({
  args: { sessionIds: v.array(v.string()) },
  handler: async (ctx, { sessionIds }) => {
    await requireAdmin(ctx);
    return scheduleDelete(ctx, sessionIds);
  },
});

// Agent/MCP path: the key-authed HTTP routes run these (list = traces.read,
// delete = selfheal, enforced at the route).
export const listDeliverySessionsInternal = internalQuery({
  args: {},
  handler: async (ctx) => listSessionsImpl(ctx),
});

export const deleteDeliverySessionsForAgent = internalMutation({
  args: { sessionIds: v.array(v.string()) },
  handler: async (ctx, { sessionIds }) => scheduleDelete(ctx, sessionIds),
});
