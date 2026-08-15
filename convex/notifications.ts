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
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getActor } from "./lib/access";
import {
  loadSignedAnnouncementConfig,
  verifyMailboxResponse,
  type VerifiedAnnouncement,
} from "./lib/signedAnnouncements";

type NotifKind =
  | "anomaly_open"
  | "anomaly_resolved"
  | "feedback_reply"
  | "feedback_resolved"
  | "feedback_new"
  | "curation"
  | "operator_announcement";

const FEED_LIMIT = 50;
// Bulk read/clear process at most this many rows per transaction, then SELF-
// SCHEDULE the rest (Codex R2-P2): a Convex mutation is ONE transaction with
// read/write limits, so an unbounded `.collect()`-and-patch/delete would fail
// the action once a user piles up notifications. Each batch stays bounded; the
// continuation drains the tail.
const BULK_BATCH = 256;
// Admin fan-out batch (anomaly notifications), paginated + self-scheduled.
const FANOUT_PAGE = 100;
const ANNOUNCEMENT_RESPONSE_MAX_BYTES = 64 * 1024;
const ANNOUNCEMENT_ACK_LIMIT = 100;

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
    expiresAt?: number;
  },
): Promise<Id<"notifications"> | null> {
  if (args.dedupeKey !== undefined) {
    const dk = args.dedupeKey;
    const existing = await ctx.db
      .query("notifications")
      .withIndex("by_user_dedupe", (q) =>
        q.eq("userId", args.userId).eq("dedupeKey", dk),
      )
      .first();
    if (existing !== null) return null;
  }
  return ctx.db.insert("notifications", {
    userId: args.userId,
    kind: args.kind,
    title: args.title,
    ...(args.messageKey ? { messageKey: args.messageKey } : {}),
    ...(args.params ? { params: args.params } : {}),
    body: args.body,
    href: args.href,
    dedupeKey: args.dedupeKey,
    createdAt: args.createdAt ?? Date.now(),
    expiresAt: args.expiresAt,
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

// --- Signed operator announcements -----------------------------------------

const verifiedAnnouncementValidator = v.object({
  deliveryId: v.string(),
  messageId: v.string(),
  notificationKey: v.union(
    v.literal("notif_operator_maintenance_scheduled"),
    v.literal("notif_operator_maintenance_completed"),
    v.literal("notif_operator_incident_update"),
    v.literal("notif_operator_subscription_notice"),
  ),
  params: v.record(v.string(), v.string()),
  issuedAt: v.number(),
  expiresAt: v.number(),
});

/** Only durable receipts are acknowledged. A user may clear the derived bell
 * row without causing the remote service to redeliver an already-seen item. */
export const pendingSignedAnnouncementAcknowledgements = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("signedAnnouncementReceipts")
      .withIndex("by_acknowledged_at", (q) =>
        q.eq("acknowledgedAt", undefined),
      )
      .take(ANNOUNCEMENT_ACK_LIMIT);
    return rows.map((row) => row.deliveryId);
  },
});

export const acknowledgeSignedAnnouncements = internalMutation({
  args: { deliveryIds: v.array(v.string()) },
  handler: async (ctx, { deliveryIds }) => {
    const acknowledgedAt = Date.now();
    for (const deliveryId of deliveryIds.slice(0, ANNOUNCEMENT_ACK_LIMIT)) {
      const row = await ctx.db
        .query("signedAnnouncementReceipts")
        .withIndex("by_delivery_id", (q) => q.eq("deliveryId", deliveryId))
        .unique();
      if (row !== null && row.acknowledgedAt === undefined) {
        await ctx.db.patch(row._id, { acknowledgedAt });
      }
    }
  },
});

/** Fan out one already-verified receipt. The scheduled chain is transactional
 * with receipt insertion, and per-user dedupe makes retries harmless. */
export const fanOutSignedAnnouncement = internalMutation({
  args: {
    receiptId: v.id("signedAnnouncementReceipts"),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { receiptId, cursor }) => {
    const receipt = await ctx.db.get(receiptId);
    if (receipt === null) return;
    const result = await ctx.db
      .query("profiles")
      .paginate({ numItems: FANOUT_PAGE, cursor: cursor ?? null });
    for (const profile of result.page) {
      const notificationId = await notifyUser(ctx, {
        userId: profile.userId,
        kind: "operator_announcement",
        title: "Operator announcement",
        body: "A verified announcement is available.",
        messageKey: receipt.notificationKey,
        params: receipt.params,
        dedupeKey: `signed-announcement:${receipt.deliveryId}`,
        createdAt: receipt.issuedAt,
        expiresAt: receipt.expiresAt,
      });
      if (notificationId !== null) {
        await ctx.scheduler.runAt(
          receipt.expiresAt,
          internal.notifications.expireSignedNotification,
          {
            notificationId,
            dedupeKey: `signed-announcement:${receipt.deliveryId}`,
          },
        );
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.notifications.fanOutSignedAnnouncement,
        { receiptId, cursor: result.continueCursor },
      );
    }
  },
});

export const expireSignedNotification = internalMutation({
  args: {
    notificationId: v.id("notifications"),
    dedupeKey: v.string(),
  },
  handler: async (ctx, { notificationId, dedupeKey }) => {
    const notification = await ctx.db.get(notificationId);
    if (
      notification !== null &&
      notification.kind === "operator_announcement" &&
      notification.dedupeKey === dedupeKey &&
      notification.expiresAt !== undefined &&
      notification.expiresAt <= Date.now()
    ) {
      await ctx.db.delete(notificationId);
    }
  },
});

export const persistSignedAnnouncements = internalMutation({
  args: { announcements: v.array(verifiedAnnouncementValidator) },
  handler: async (ctx, { announcements }) => {
    let inserted = 0;
    let duplicate = 0;
    for (const announcement of announcements.slice(0, 100)) {
      const existing = await ctx.db
        .query("signedAnnouncementReceipts")
        .withIndex("by_delivery_id", (q) =>
          q.eq("deliveryId", announcement.deliveryId),
        )
        .unique();
      if (existing !== null) {
        duplicate += 1;
        continue;
      }
      const receiptId = await ctx.db.insert("signedAnnouncementReceipts", {
        ...announcement,
        receivedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(
        0,
        internal.notifications.fanOutSignedAnnouncement,
        { receiptId },
      );
      inserted += 1;
    }
    return { inserted, duplicate };
  },
});

/** Poll a configurable signed-announcement service. Missing or malformed
 * configuration is fail-closed: the action performs no outbound request. */
export const pollSignedAnnouncements = internalAction({
  args: {},
  handler: async (ctx) => {
    const state = loadSignedAnnouncementConfig();
    if (state.status === "inactive") {
      if (state.reason !== "not_configured") {
        console.warn(`[signed-announcements] inactive: ${state.reason}`);
      }
      return { status: "inactive" as const, reason: state.reason };
    }

    const acknowledgements: string[] = await ctx.runQuery(
      internal.notifications.pendingSignedAnnouncementAcknowledgements,
      {},
    );
    let response: Response;
    try {
      response = await fetch(state.config.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ contract_version: 1, acknowledgements }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      console.warn("[signed-announcements] poll failed: network_error");
      return { status: "error" as const, reason: "network_error" as const };
    }
    if (!response.ok) {
      console.warn(
        `[signed-announcements] poll failed: http_${response.status}`,
      );
      return { status: "error" as const, reason: "http_error" as const };
    }

    if (acknowledgements.length > 0) {
      await ctx.runMutation(
        internal.notifications.acknowledgeSignedAnnouncements,
        { deliveryIds: acknowledgements },
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > ANNOUNCEMENT_RESPONSE_MAX_BYTES
    ) {
      console.warn("[signed-announcements] poll failed: response_too_large");
      return { status: "error" as const, reason: "response_too_large" as const };
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > ANNOUNCEMENT_RESPONSE_MAX_BYTES) {
      console.warn("[signed-announcements] poll failed: response_too_large");
      return { status: "error" as const, reason: "response_too_large" as const };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      console.warn("[signed-announcements] poll failed: invalid_response");
      return { status: "error" as const, reason: "invalid_response" as const };
    }

    let result: Awaited<ReturnType<typeof verifyMailboxResponse>>;
    try {
      result = await verifyMailboxResponse(payload, state.config);
    } catch {
      console.warn("[signed-announcements] poll failed: invalid_response");
      return { status: "error" as const, reason: "invalid_response" as const };
    }
    for (const rejected of result.rejected) {
      console.warn(
        `[signed-announcements] rejected delivery ${rejected.deliveryId ?? "unknown"}: ${rejected.reason}`,
      );
    }
    const persistResult: { inserted: number; duplicate: number } =
      result.verified.length > 0
        ? await ctx.runMutation(
            internal.notifications.persistSignedAnnouncements,
            { announcements: result.verified satisfies VerifiedAnnouncement[] },
          )
        : { inserted: 0, duplicate: 0 };
    return {
      status: "ok" as const,
      received: result.verified.length,
      rejected: result.rejected.length,
      ...persistResult,
    };
  },
});

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
    const now = Date.now();
    return rows.filter((r) => r.expiresAt === undefined || r.expiresAt > now).map((r) => ({
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
    const now = Date.now();
    return unread.filter(
      (row) => row.expiresAt === undefined || row.expiresAt > now,
    ).length;
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
