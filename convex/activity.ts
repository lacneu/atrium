// Platform-activity snapshot — the deploy go/no-go read ("can I redeploy the
// bridge/Convex right now without cutting a live turn?").
//
// One BOUNDED internalQuery aggregates the live-work signals that already exist
// as tables/indexes (no new writes, no new schema):
//   - activeStreams:     `streamingText` — the invariant "a row exists ⇔ a turn
//                        is streaming" makes the table's cardinality the count.
//   - runningSubAgents:  `subAgents` via the global by_status_updated index
//                        (the reaper's index), status "running" only.
//   - outbox:            queued/pending counts via the global by_status index
//                        (the dispatch serialization states).
//   - activeUsers:       DISTINCT `principalId`s on `chat.send` traces over
//                        5/15/60-minute windows (by_at index, bounded scan).
//   - deployReadiness:   "idle" only when nothing is in flight AND the last
//                        chat.send is older than the quiet horizon.
//
// SOC2 (D2): counts, ages and timestamps ONLY. The response never carries a
// chatId, userId/email, message text or any other content — principalIds are
// aggregated into counts and never returned.

import { internalQuery, QueryCtx } from "./_generated/server";

// Per-slice read caps: every read below is `.take()`-bounded so the snapshot
// stays cheap no matter how a table grows. The counts saturate at the cap
// (reported via `capped: true`) — far beyond any healthy live state, and a
// saturated count still reads as "active", never a wrong "idle".
const STREAM_CAP = 200;
const SUBAGENT_CAP = 500;
const OUTBOX_CAP = 500;
const TRACE_SCAN_CAP = 4000;

// Activity windows for distinct-user counts, and the quiet horizon after the
// last user send before a deploy is called safe.
const WINDOWS_MIN = [5, 15, 60] as const;
const QUIET_HORIZON_MIN = 15;

export type ActivitySnapshot = {
  at: number;
  activeStreams: { count: number; maxAgeSeconds: number | null; capped: boolean };
  runningSubAgents: {
    count: number;
    maxAgeSeconds: number | null;
    capped: boolean;
  };
  outbox: { queued: number; pending: number; capped: boolean };
  activeUsers: {
    last5m: number;
    last15m: number;
    last60m: number;
    /** True when the 60-min trace scan hit its cap (counts are lower bounds). */
    capped: boolean;
  };
  /** Seconds since the newest chat.send within the 60-min scan window; null =
   *  none seen in that window (i.e. older than 60 min — quiet). */
  lastChatSendAgeSeconds: number | null;
  deployReadiness: { verdict: "idle" | "active"; reasons: string[] };
};

/** The shared aggregation core (also exercised directly by tests). */
export async function computeActivity(
  ctx: QueryCtx,
  now: number,
): Promise<ActivitySnapshot> {
  // Active streams: the table IS the set of in-flight turns (rows are created
  // at startAssistant and deleted at finalize; the stuck-stream watchdog reaps
  // leftovers). Age from _creationTime = how long the turn has been running.
  const streams = await ctx.db.query("streamingText").take(STREAM_CAP);
  const streamAges = streams.map((r) => now - r._creationTime);
  const activeStreams = {
    count: streams.length,
    maxAgeSeconds: streams.length
      ? Math.round(Math.max(...streamAges) / 1000)
      : null,
    capped: streams.length === STREAM_CAP,
  };

  // Running sub-agents/tasks: the global (status, updatedAt) slice the stale
  // reaper already ranges — covers kind "subagent", "task" AND legacy rows
  // without the kind field (all delegation work blocks a safe deploy alike).
  const running = await ctx.db
    .query("subAgents")
    .withIndex("by_status_updated", (q) => q.eq("status", "running"))
    .take(SUBAGENT_CAP);
  const subAgentAges = running.map((r) => now - r.createdAt);
  const runningSubAgents = {
    count: running.length,
    maxAgeSeconds: running.length
      ? Math.round(Math.max(...subAgentAges) / 1000)
      : null,
    capped: running.length === SUBAGENT_CAP,
  };

  // Outbox backlog: `queued` = sends parked behind an in-flight turn,
  // `pending` = dispatched-but-unacked turns. Both mean a deploy would cut work.
  const queuedRows = await ctx.db
    .query("outbox")
    .withIndex("by_status", (q) => q.eq("status", "queued"))
    .take(OUTBOX_CAP);
  const pendingRows = await ctx.db
    .query("outbox")
    .withIndex("by_status", (q) => q.eq("status", "pending"))
    .take(OUTBOX_CAP);
  const outbox = {
    queued: queuedRows.length,
    pending: pendingRows.length,
    capped:
      queuedRows.length === OUTBOX_CAP || pendingRows.length === OUTBOX_CAP,
  };

  // Distinct active users on chat.send over the 60-min window (one indexed
  // range read serves all three windows). principalIds are opaque user ids —
  // they are COUNTED here and never leave this function.
  const horizon = now - 60 * 60 * 1000;
  const recent = await ctx.db
    .query("traceEvents")
    .withIndex("by_at", (q) => q.gte("at", horizon))
    .order("desc")
    .take(TRACE_SCAN_CAP);
  const sends = recent.filter((r) => r.kind === "chat.send");
  const perWindow = WINDOWS_MIN.map((min) => {
    const cutoff = now - min * 60 * 1000;
    const ids = new Set<string>();
    for (const s of sends) {
      if (s.at >= cutoff && s.principalId) ids.add(s.principalId);
    }
    return ids.size;
  });
  const activeUsers = {
    last5m: perWindow[0],
    last15m: perWindow[1],
    last60m: perWindow[2],
    capped: recent.length === TRACE_SCAN_CAP,
  };
  const lastSendAt = sends.length
    ? Math.max(...sends.map((s) => s.at))
    : null;
  const lastChatSendAgeSeconds =
    lastSendAt !== null ? Math.round((now - lastSendAt) / 1000) : null;

  // Verdict: idle ⇔ no stream, no running delegation, empty queues AND the
  // last user send is past the quiet horizon (null = older than the 60-min
  // window, which is quieter still). Reasons name every blocking signal.
  const reasons: string[] = [];
  if (activeStreams.count > 0) {
    reasons.push(`${activeStreams.count} active stream(s)`);
  }
  if (runningSubAgents.count > 0) {
    reasons.push(`${runningSubAgents.count} running sub-agent(s)/task(s)`);
  }
  if (outbox.queued > 0) reasons.push(`${outbox.queued} queued send(s)`);
  if (outbox.pending > 0) reasons.push(`${outbox.pending} pending dispatch(es)`);
  if (
    lastChatSendAgeSeconds !== null &&
    lastChatSendAgeSeconds < QUIET_HORIZON_MIN * 60
  ) {
    reasons.push(
      `last user send ${lastChatSendAgeSeconds}s ago (< ${QUIET_HORIZON_MIN} min)`,
    );
  }
  return {
    at: now,
    activeStreams,
    runningSubAgents,
    outbox,
    activeUsers,
    lastChatSendAgeSeconds,
    deployReadiness: {
      verdict: reasons.length === 0 ? "idle" : "active",
      reasons,
    },
  };
}

/**
 * Internal read for the key-authed GET /api/v1/activity route. The httpAction
 * verifies the principal's `traces.read` permission BEFORE calling this (same
 * split as observability.recentEventsInternal). NOT publicly callable.
 */
export const activityInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<ActivitySnapshot> => {
    return await computeActivity(ctx, Date.now());
  },
});
