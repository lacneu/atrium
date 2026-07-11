// Generic per-user notification feed (the bell) — the SINGLE source of truth for
// the unread badge. Producers (anomalies, feedback) call the internal writers;
// the user reads/clears via the queries+mutations below.
//
// IMPERSONATION: reads resolve the EFFECTIVE user (an admin acting AS a user sees
// that user's feed, read-only); WRITES no-op under impersonation, so an admin
// peeking never marks-read or clears the target's notifications (mirrors
// feedback.markAllMyFeedbackRead).
//
// NON-PHI: `title`/`body` are labels only — never message/feedback text.

import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getActor } from "./lib/access";

type NotifKind =
  | "anomaly_open"
  | "anomaly_resolved"
  | "feedback_reply"
  | "feedback_resolved"
  | "feedback_new"
  | "curation";

const FEED_LIMIT = 50;
// Bulk read/clear process at most this many rows per transaction, then SELF-
// SCHEDULE the rest (Codex R2-P2): a Convex mutation is ONE transaction with
// read/write limits, so an unbounded `.collect()`-and-patch/delete would fail
// the action once a user piles up notifications. Each batch stays bounded; the
// continuation drains the tail.
const BULK_BATCH = 256;
// Admin fan-out batch (anomaly notifications), paginated + self-scheduled.
const FANOUT_PAGE = 100;

// --- Internal writers (called by producers) ---------------------------------

/** Idempotent per-user notify: skips when a row with the same (userId, dedupeKey)
 *  already exists, so a producer never double-notifies for one event. */
export async function notifyUser(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    kind: NotifKind;
    title: string;
    body: string;
    // i18n key + params — the client renders these in the READER's language;
    // title/body above remain the write-time fallback (legacy rows, old clients).
    messageKey?: string;
    params?: Record<string, string>;
    href?: string;
    dedupeKey?: string;
    // Override the row's timestamp (e.g. a backfill replaying a past event at its
    // ORIGINAL time). Defaults to now. Note: feed ordering is by _creationTime,
    // so a backfilled row still surfaces at the top — this only fixes its label.
    createdAt?: number;
  },
): Promise<void> {
  if (args.dedupeKey !== undefined) {
    const dk = args.dedupeKey;
    const existing = await ctx.db
      .query("notifications")
      .withIndex("by_user_dedupe", (q) =>
        q.eq("userId", args.userId).eq("dedupeKey", dk),
      )
      .first();
    if (existing !== null) return;
  }
  await ctx.db.insert("notifications", {
    userId: args.userId,
    kind: args.kind,
    title: args.title,
    ...(args.messageKey ? { messageKey: args.messageKey } : {}),
    ...(args.params ? { params: args.params } : {}),
    body: args.body,
    href: args.href,
    dedupeKey: args.dedupeKey,
    createdAt: args.createdAt ?? Date.now(),
  });
}

/** Paginated admin fan-out — SCHEDULED off the producer's mutation (Codex R5) so
 *  a large admin set can NEVER make the anomaly insert/resolve itself fail: the
 *  anomaly write commits, and this internalMutation delivers the notifications in
 *  bounded batches, self-scheduling until done. Each admin gets an idempotent row
 *  (dedupeKey per event), so a re-run / racing schedule never double-notifies. */
export const fanOutAnomalyToAdmins = internalMutation({
  args: {
    kind: v.union(
      v.literal("anomaly_open"),
      v.literal("anomaly_resolved"),
      v.literal("feedback_new"),
    ),
    title: v.string(),
    body: v.string(),
    messageKey: v.optional(v.string()),
    params: v.optional(v.record(v.string(), v.string())),
    href: v.optional(v.string()),
    dedupeKey: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("profiles")
      .withIndex("by_role", (q) => q.eq("role", "admin"))
      .paginate({ numItems: FANOUT_PAGE, cursor: args.cursor ?? null });
    for (const a of result.page) {
      await notifyUser(ctx, {
        userId: a.userId,
        kind: args.kind,
        title: args.title,
        body: args.body,
        messageKey: args.messageKey,
        params: args.params,
        href: args.href,
        dedupeKey: args.dedupeKey,
      });
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.notifications.fanOutAnomalyToAdmins,
        { ...args, cursor: result.continueCursor },
      );
    }
  },
});

/** Enqueue the admin fan-out (see `fanOutAnomalyToAdmins`). Returns immediately —
 *  the producer's mutation stays bounded regardless of how many admins exist. */
export async function notifyAdmins(
  ctx: MutationCtx,
  args: {
    kind: "anomaly_open" | "anomaly_resolved" | "feedback_new";
    title: string;
    body: string;
    messageKey?: string;
    params?: Record<string, string>;
    href?: string;
    dedupeKey?: string;
  },
): Promise<void> {
  await ctx.scheduler.runAfter(
    0,
    internal.notifications.fanOutAnomalyToAdmins,
    args,
  );
}

// --- User-facing read --------------------------------------------------------

export const myNotifications = query({
  args: {},
  handler: async (ctx) => {
    const { effectiveUserId } = await getActor(ctx);
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", effectiveUserId))
      .order("desc")
      .take(FEED_LIMIT);
    return rows.map((r) => ({
      _id: r._id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      // i18n rendering inputs — the client localizes known keys in the READER's
      // language; title/body above are the fallback.
      messageKey: r.messageKey ?? null,
      params: r.params ?? null,
      href: r.href ?? null,
      createdAt: r.createdAt,
      // INSERTION time (monotonic, unlike createdAt which producers may
      // backdate): the bell's arrival-cue watermark, so an OLD row revealed by
      // the bounded window (a newer one was cleared) never re-triggers a cue.
      creationTime: r._creationTime,
      unread: r.readAt === undefined,
    }));
  },
});

/** Reactive unread badge count — the SINGLE source for the bell. Scans ONLY the
 *  unread set via `by_user_unread` (not the whole history) and caps at FEED_LIMIT,
 *  so the subscription stays bounded on every authenticated page. */
export const myUnreadCount = query({
  args: {},
  handler: async (ctx) => {
    const { effectiveUserId } = await getActor(ctx);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_unread", (q) =>
        q.eq("userId", effectiveUserId).eq("readAt", undefined),
      )
      .take(FEED_LIMIT);
    return unread.length;
  },
});

// --- User-facing write (no-op under impersonation) ---------------------------

export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const { effectiveUserId, impersonating } = await getActor(ctx);
    if (impersonating) return;
    const n = await ctx.db.get(notificationId);
    if (n === null || n.userId !== effectiveUserId) return; // ownership
    if (n.readAt === undefined) await ctx.db.patch(notificationId, { readAt: Date.now() });
  },
});

/** The drain cutoff = the newest EXISTING notification's `_creationTime`, read at
 *  click time. Anything arriving mid-drain has a strictly greater `_creationTime`
 *  and is spared. Exact, with NO clock dependency: `Date.now()` floors to ms and
 *  can sit below a sub-ms `_creationTime`, which would wrongly exclude a row the
 *  user meant to clear. Returns -1 (matches nothing) when the feed is empty. */
async function clickCutoff(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<number> {
  const latest = await ctx.db
    .query("notifications")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .first();
  return latest === null ? -1 : latest._creationTime;
}

/** One bounded mark-read batch; self-schedules the next while rows remain.
 *  Patched rows leave the `by_user_unread` range, so the next `.take` returns the
 *  following unread page — no cursor needed. Two explicit args because a SCHEDULED
 *  function carries NO auth identity (the public mutation resolves the actor +
 *  impersonation guard once, before the first batch) and must NOT consume rows
 *  that arrived AFTER the user clicked: `cutoff` (see `clickCutoff`) bounds the
 *  scan to rows that already existed, via the implicit `_creationTime` index field. */
async function drainMarkAllRead(
  ctx: MutationCtx,
  userId: Id<"users">,
  cutoff: number,
): Promise<void> {
  const now = Date.now();
  const batch = await ctx.db
    .query("notifications")
    .withIndex("by_user_unread", (q) =>
      q
        .eq("userId", userId)
        .eq("readAt", undefined)
        .lte("_creationTime", cutoff),
    )
    .take(BULK_BATCH);
  for (const r of batch) await ctx.db.patch(r._id, { readAt: now });
  if (batch.length === BULK_BATCH) {
    await ctx.scheduler.runAfter(0, internal.notifications.markAllReadContinue, {
      userId,
      cutoff,
    });
  }
}

export const markAllReadContinue = internalMutation({
  args: { userId: v.id("users"), cutoff: v.number() },
  handler: async (ctx, { userId, cutoff }) => {
    await drainMarkAllRead(ctx, userId, cutoff);
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const { effectiveUserId, impersonating } = await getActor(ctx);
    if (impersonating) return;
    await drainMarkAllRead(ctx, effectiveUserId, await clickCutoff(ctx, effectiveUserId));
  },
});

/** Delete ONE notification (read OR unread). */
export const clearOne = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const { effectiveUserId, impersonating } = await getActor(ctx);
    if (impersonating) return;
    const n = await ctx.db.get(notificationId);
    if (n === null || n.userId !== effectiveUserId) return;
    await ctx.db.delete(notificationId);
  },
});

/** One bounded clear batch; self-schedules the next while rows remain. Deleting
 *  shrinks the `by_user` set, so the next `.take` returns the following page — no
 *  cursor needed (Convex guideline for bulk deletion). Explicit userId (a
 *  scheduled continuation has no auth identity) + `cutoff` (see `clickCutoff`) so
 *  the drain never deletes a notification that arrived AFTER the user clicked. */
async function drainClearAll(
  ctx: MutationCtx,
  userId: Id<"users">,
  cutoff: number,
): Promise<void> {
  const batch = await ctx.db
    .query("notifications")
    .withIndex("by_user", (q) =>
      q.eq("userId", userId).lte("_creationTime", cutoff),
    )
    .take(BULK_BATCH);
  for (const r of batch) await ctx.db.delete(r._id);
  if (batch.length === BULK_BATCH) {
    await ctx.scheduler.runAfter(0, internal.notifications.clearAllContinue, {
      userId,
      cutoff,
    });
  }
}

export const clearAllContinue = internalMutation({
  args: { userId: v.id("users"), cutoff: v.number() },
  handler: async (ctx, { userId, cutoff }) => {
    await drainClearAll(ctx, userId, cutoff);
  },
});

/** Delete ALL the user's notifications (even unread). */
export const clearAll = mutation({
  args: {},
  handler: async (ctx) => {
    const { effectiveUserId, impersonating } = await getActor(ctx);
    if (impersonating) return;
    await drainClearAll(ctx, effectiveUserId, await clickCutoff(ctx, effectiveUserId));
  },
});
