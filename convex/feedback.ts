// On-demand FORENSIC feedback (OpenRouter-style "Report Feedback").
//
// When a user flags a message, `submitFeedback` FREEZES a complete forensic
// snapshot at that instant. This is the project's answer to "OpenClaw modified
// my words": the feedback is the dispute signal, and we capture everything
// needed to analyze it BEFORE a UI-7 delete/regenerate can erase the evidence.
//
// TRUST MODEL (non-negotiable — the whole forensic value rests on it):
//   - `snapshot.messageText` and every other authoritative field are read
//     SERVER-SIDE from the DB here, NEVER accepted from the client. If the
//     client could supply the "stored" text, anyone could forge the proof.
//   - `displayedText` is the ONLY client-declared content: it is what the
//     BROWSER actually rendered (the byte-exact `.oc-msg__source-pre`
//     textContent, or `metadata.custom.rawText`). Its sole purpose is letting
//     the server compute `displayedMatchesStored` — proving whether the browser
//     altered the displayed characters. It is never treated as truth.
//
// SCOPE HONESTY: strong for AI-response disputes (full generating context frozen)
// and for preserving evidence before a delete. For "you changed the words I
// TYPED" the mutation happens BEFORE our first capture point (OS/keyboard
// autocorrect), so no server snapshot can prove the pre-capture state — only the
// input hardening + the byte-exact source view address that case. `clientInfo`
// captures the environment (best available diagnostic), nothing more.

import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import {
  requireActive,
  requireOwnedChat,
  requireAdmin,
  getProfile,
} from "./lib/access";
import { recordAudit } from "./lib/audit";
import { notifyUser } from "./notifications";
import {
  PERMISSIONS,
  permissionsForRoleKey,
  roleHasPermission,
} from "./lib/rbac";

// Allowed report categories (mirrors OpenRouter's set, adapted: `altered_words`
// is added because it is the dispute this whole feature exists to investigate;
// `billing` is dropped — no billing surface yet). Kept as a plain list so the
// frontend and the validator agree on one source of truth.
export const FEEDBACK_CATEGORIES = [
  "incoherence",
  "incorrect",
  "altered_words",
  "formatting",
  "latency",
  "api_error",
  "other",
] as const;
type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

const COMMENT_MAX = 1000;
const DISPLAYED_MAX = 100_000; // generous; just a guard against abuse
// Bounded forensic context window. CONTEXT_SCAN bounds how far back we look to
// locate the reported message; CONTEXT_WINDOW is how many turns we actually
// freeze (ending at the reported message). The bound is RECORDED in the snapshot
// (contextWindowLimit/contextTruncated) — never a silent truncation.
const CONTEXT_SCAN = 60;
const CONTEXT_WINDOW = 12;
const PARTS_MAX = 50;

function isCategory(s: string): s is FeedbackCategory {
  return (FEEDBACK_CATEGORIES as readonly string[]).includes(s);
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Freeze a forensic snapshot for one message and store it with the user's
 * report. Owner-scoped to the EFFECTIVE identity; audited (the realUserId is
 * always recorded, so a report filed while impersonating is attributable).
 */
export const submitFeedback = mutation({
  args: {
    chatId: v.id("chats"),
    messageId: v.id("messages"),
    category: v.string(),
    comment: v.optional(v.string()),
    // CLIENT DECLARATIONS ONLY (browser-fidelity comparison + environment). Never
    // used as the source of truth for stored content.
    client: v.optional(
      v.object({
        displayedText: v.optional(v.string()),
        sourceWasOpen: v.optional(v.boolean()),
        userAgent: v.optional(v.string()),
        language: v.optional(v.string()),
        timezone: v.optional(v.string()),
        appVersion: v.optional(v.string()),
        theme: v.optional(v.string()),
        plugins: v.optional(v.array(v.string())),
        extensionsDetected: v.optional(v.array(v.string())),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { userId, realUserId, impersonating, actor } =
      await requireActive(ctx);

    if (!isCategory(args.category)) {
      throw new Error(`Invalid feedback category: ${args.category}`);
    }

    // Owner-scope: both the chat and the message must belong to the effective
    // user. (An admin investigating another user does so via impersonation,
    // which flips the effective identity — and is audited below.)
    await requireOwnedChat(ctx, userId, args.chatId);
    const message = await ctx.db.get(args.messageId);
    if (
      message === null ||
      message.chatId !== args.chatId ||
      message.userId !== userId
    ) {
      throw new Error("Forbidden: message not owned by user");
    }

    // --- SERVER-READ authoritative content (never from the client) ---
    const messageText = message.text;

    // Message structure: tools / reasoning / media parts, ordered, bounded.
    const partDocs = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .collect();
    partDocs.sort((a, b) => a.order - b.order);
    const partsCount = partDocs.length;
    const partsJson = safeJson(
      partDocs.slice(0, PARTS_MAX).map((p) => p.part),
    );

    // Bounded recent window to locate the message + freeze generating context.
    const recentDesc = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .take(CONTEXT_SCAN);
    const asc = recentDesc.reverse();
    const idx = asc.findIndex((m) => m._id === message._id);

    let promptMessage: Doc<"messages"> | null = null;
    let contextSlice: Doc<"messages">[] = [];
    let contextTruncated = false;
    if (idx >= 0) {
      const start = Math.max(0, idx - (CONTEXT_WINDOW - 1));
      contextSlice = asc.slice(start, idx + 1);
      contextTruncated = start > 0 || recentDesc.length === CONTEXT_SCAN;
      // Nearest preceding user turn = the prompt that generated this message.
      for (let i = idx - 1; i >= 0; i--) {
        if (asc[i].role === "user") {
          promptMessage = asc[i];
          break;
        }
      }
    } else {
      // Message older than the scan window: freeze just the message itself and
      // record that context was unavailable rather than silently dropping it.
      contextSlice = [message];
      contextTruncated = true;
    }
    const contextJson = safeJson(
      contextSlice.map((m) => ({ role: m.role, text: m.text })),
    );

    // Session config that produced the message.
    const chat = await ctx.db.get(args.chatId);
    const sessionMeta = chat?.sessionMeta;
    const sessionSettings = chat?.sessionSettings;

    // Dispatched payload (best-effort): the outbox row for the relevant USER
    // turn. Transient — usually gone for historical messages; captured when
    // still present. For a user-message report it is the message itself; for an
    // assistant report it is the preceding prompt.
    const outboxKeyMessageId =
      message.role === "user" ? message._id : promptMessage?._id;
    let outbox: Doc<"outbox"> | null = null;
    if (outboxKeyMessageId) {
      outbox = await ctx.db
        .query("outbox")
        .withIndex("by_message", (q) => q.eq("messageId", outboxKeyMessageId))
        .first();
    }

    // L2 "Joindre les documents" state for THIS reply (SERVER-READ, owner-scoped):
    // per-card status so a report on a failed/stuck attach carries the evidence.
    // entryKey/reference are the user's own document sources (already present via
    // partsJson's provenance); storageId/url are deliberately omitted.
    const docRows = await ctx.db
      .query("documentAttachments")
      .withIndex("by_source_message", (q) => q.eq("sourceMessageId", message._id))
      .collect();
    const docAttachments = docRows
      .filter((r) => r.userId === userId)
      .map((r) => ({
        entryKey: r.entryKey,
        reference: r.reference,
        status: r.status,
      }));
    // A fetch still IN FLIGHT for this message (the likely reason for the report):
    // read the user's hidden documentary chat's pendingFetch.
    const docChat = await ctx.db
      .query("chats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("kind"), "documentary"))
      .first();
    const docFetchPendingAgeSeconds =
      docChat?.pendingFetch &&
      docChat.pendingFetch.sourceMessageId === message._id
        ? Math.round((Date.now() - docChat.pendingFetch.createdAt) / 1000)
        : undefined;

    // CLIENT comparison: did the browser render exactly the stored characters?
    const displayedText = args.client?.displayedText?.slice(0, DISPLAYED_MAX);
    const displayedMatchesStored =
      displayedText === undefined ? undefined : displayedText === messageText;

    const comment = args.comment?.slice(0, COMMENT_MAX) || undefined;

    const feedbackId = await ctx.db.insert("feedback", {
      userId,
      realUserId,
      impersonated: impersonating,
      chatId: args.chatId,
      messageId: args.messageId,
      at: Date.now(),
      category: args.category,
      comment,
      snapshot: {
        messageRole: message.role,
        messageText,
        messageStatus: message.status,
        messageError: message.error,
        messageUpdatedAt: message.updatedAt,
        runId: message.runId,
        isRegeneration: outbox?.clientMessageId?.startsWith("regen-"),
        partsJson,
        partsCount,
        promptMessageId: promptMessage?._id,
        promptText: promptMessage?.text,
        contextJson,
        contextCount: contextSlice.length,
        contextWindowLimit: CONTEXT_WINDOW,
        contextTruncated,
        sessionSettings: sessionSettings
          ? {
              thinkingLevel: sessionSettings.thinkingLevel,
              model: sessionSettings.model,
            }
          : undefined,
        sessionMetaJson: sessionMeta ? safeJson(sessionMeta) : undefined,
        openclawModel: sessionMeta?.model,
        openclawProvider: sessionMeta?.modelProvider,
        openclawRuntime: sessionMeta?.agentRuntime,
        // openclawVersion lives bridge-side; not in Convex today (field reserved).
        openclawVersion: undefined,
        outboxText: outbox?.text,
        outboxStatus: outbox?.status,
        outboxClientMessageId: outbox?.clientMessageId,
        outboxAttachmentsCount: outbox?.attachmentIds.length,
        outboxAvailable: outbox !== null,
        docAttachmentsJson:
          docAttachments.length > 0 ? safeJson(docAttachments) : undefined,
        docAttachmentsCount:
          docAttachments.length > 0 ? docAttachments.length : undefined,
        docFetchPendingAgeSeconds,
        // contentHash deferred (no deterministic sync hash in a mutation; the
        // frozen snapshot is itself the authoritative evidence).
        contentHash: undefined,
        displayedText,
        displayedMatchesStored,
        clientInfo: args.client
          ? {
              userAgent: args.client.userAgent,
              language: args.client.language,
              timezone: args.client.timezone,
              appVersion: args.client.appVersion,
              theme: args.client.theme,
              sourceWasOpen: args.client.sourceWasOpen,
              plugins: args.client.plugins?.slice(0, 40),
              extensionsDetected: args.client.extensionsDetected?.slice(0, 20),
            }
          : undefined,
      },
    });

    // Audit every submission (low volume, forensically useful). recordAudit
    // stores realUserId + the impersonated flag, so a report filed while an
    // admin impersonates a user is fully attributable.
    await recordAudit(ctx, actor, "feedback.submit", {
      resource: "message",
      resourceId: args.messageId,
    });

    return { feedbackId, displayedMatchesStored };
  },
});

/**
 * Message ids in a chat that the EFFECTIVE user has already reported — so the UI
 * can mark the flag as active. Owner-scoped + bounded by the chat's feedback.
 */
export const myReportedMessageIds = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const chat = await ctx.db.get(chatId);
    if (chat === null || chat.userId !== userId) return [];
    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
    return rows
      .filter((r) => r.userId === userId)
      .map((r) => r.messageId as string);
  },
});

// ===========================================================================
// Increment B — ADMIN administration of recorded feedback (Settings tab).
//
// Split by sensitivity (product rule: admin has no privacy constraint, but
// every admin view of ANOTHER user's CONTENT must be audited):
//   - listForAdmin  = METADATA only (category, who, when, fidelity verdict). No
//     message content → no per-row audit, like the traces/audit log lists.
//   - readSnapshot  = the CONTENT read (message text, prompt, context, comment).
//     A MUTATION (queries can't write the audit) gated by `traces.read.content`
//     and AUDITED per call as a cross-user content access.
//   - deleteFeedback = administration (clear a handled report), audited.
// ===========================================================================

const ADMIN_LIST_MAX = 200;

/** Admin metadata list — NO message content, so no per-row content audit. */
export const listForAdmin = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_time")
      .order("desc")
      .take(Math.min(limit ?? ADMIN_LIST_MAX, ADMIN_LIST_MAX));
    return Promise.all(
      rows.map(async (r) => {
        const reporter = await getProfile(ctx, r.userId);
        const realReporter = r.impersonated
          ? await getProfile(ctx, r.realUserId)
          : reporter;
        return {
          _id: r._id,
          at: r.at,
          category: r.category,
          hasComment: !!r.comment,
          messageRole: r.snapshot.messageRole,
          displayedMatchesStored: r.snapshot.displayedMatchesStored,
          sourceWasOpen: r.snapshot.clientInfo?.sourceWasOpen ?? false,
          impersonated: r.impersonated,
          answered: latestAdminAt(r.thread) > 0,
          reporterEmail: reporter?.email ?? null,
          reporterName: reporter?.name ?? null,
          // When filed under impersonation, surface the REAL operator too.
          realOperatorEmail: r.impersonated
            ? (realReporter?.email ?? null)
            : null,
          chatId: r.chatId,
          messageId: r.messageId,
          // Withdrawn-by-user status + reason (the user closed it prematurely);
          // the reason IS content the user typed, surfaced to the admin here so
          // they know why it was withdrawn. (METADATA + this reason only — never
          // messageText/promptText/the original comment here.)
          userClosedAt: r.userClosedAt ?? null,
          userCloseReason: r.userCloseReason ?? null,
        };
      }),
    );
  },
});

/**
 * The AUDITED content read. Returns the frozen snapshot (message text, prompt,
 * context, comment, client declarations). Gated by `traces.read.content`; every
 * call writes an audit row attributing the admin (realUserId) AND whose content
 * was read (effectiveUserId = the feedback owner; impersonated=true marks the
 * cross-user case) — satisfying "admin sees another user's info → traced".
 */
export const readSnapshot = mutation({
  args: { feedbackId: v.id("feedback") },
  handler: async (ctx, { feedbackId }) => {
    const adminId = await requireAdmin(ctx);
    // Content-read gate (documents intent + future-proofs a non-admin auditor
    // role): the admin's role must hold traces.read.content (admin = wildcard).
    const adminProfile = await getProfile(ctx, adminId);
    const perms = await permissionsForRoleKey(
      ctx,
      adminProfile?.role ?? "user",
    );
    if (!roleHasPermission(perms, PERMISSIONS.TRACES_READ_CONTENT)) {
      throw new Error("Forbidden: traces.read.content required");
    }

    const fb = await ctx.db.get(feedbackId);
    if (fb === null) throw new Error("Not found: feedback");

    // Audit the cross-user content access (reuses the audit identity model:
    // realUserId = who read, effectiveUserId = whose data, impersonated = cross).
    await recordAudit(
      ctx,
      {
        realUserId: adminId,
        effectiveUserId: fb.userId,
        impersonating: adminId !== fb.userId,
      },
      "feedback.read.content",
      { resource: "feedback", resourceId: feedbackId },
    );

    return {
      _id: fb._id,
      at: fb.at,
      category: fb.category,
      comment: fb.comment ?? null,
      impersonated: fb.impersonated,
      reporterUserId: fb.userId,
      realUserId: fb.realUserId,
      chatId: fb.chatId,
      messageId: fb.messageId,
      thread: (fb.thread ?? []).map((m) => ({
        authorRole: m.authorRole,
        text: m.text,
        at: m.at,
      })),
      snapshot: fb.snapshot,
    };
  },
});

/** Administration: remove a handled feedback. Audited (no content exposed). */
export const deleteFeedback = mutation({
  args: { feedbackId: v.id("feedback") },
  handler: async (ctx, { feedbackId }) => {
    const adminId = await requireAdmin(ctx);
    const fb = await ctx.db.get(feedbackId);
    if (fb === null) return; // idempotent
    await recordAudit(
      ctx,
      {
        realUserId: adminId,
        effectiveUserId: fb.userId,
        impersonating: adminId !== fb.userId,
      },
      "feedback.delete",
      { resource: "feedback", resourceId: feedbackId },
    );
    await ctx.db.delete(feedbackId);
  },
});

// ===========================================================================
// Increment C — feedback EXCHANGE loop + per-user notification zone.
//
//   - respondToFeedback : admin appends a response to the thread (audited).
//   - myFeedback        : the user reads THEIR OWN reports + the thread (never
//     the forensic snapshot). Owner-scoped to the effective identity.
//   - myUnreadFeedbackCount : reactive badge — count of the user's reports whose
//     latest admin message is newer than what the user has read.
//   - markAllMyFeedbackRead : clears the badge. NO-OP under impersonation, so an
//     admin investigating AS a user never silently clears that user's badge.
// ===========================================================================

const RESPONSE_MAX = 2000;

function latestAdminAt(thread: Doc<"feedback">["thread"]): number {
  let mx = 0;
  for (const m of thread ?? []) if (m.authorRole === "admin" && m.at > mx) mx = m.at;
  return mx;
}

type ThreadMessage = NonNullable<Doc<"feedback">["thread"]>[number];

/** The most-recent admin reply in a thread (author + time), or null if none.
 *  Backfill needs the author to faithfully replay `respondToFeedback`'s skip of
 *  self-replies (`fb.userId !== adminId`). */
function latestAdminMessage(
  thread: Doc<"feedback">["thread"],
): { authorUserId: ThreadMessage["authorUserId"]; at: number } | null {
  let latest: { authorUserId: ThreadMessage["authorUserId"]; at: number } | null =
    null;
  for (const m of thread ?? []) {
    if (m.authorRole === "admin" && (latest === null || m.at > latest.at)) {
      latest = { authorUserId: m.authorUserId, at: m.at };
    }
  }
  return latest;
}

/** Admin appends a response to a report's thread (audited; not a content read). */
export const respondToFeedback = mutation({
  args: { feedbackId: v.id("feedback"), text: v.string() },
  handler: async (ctx, { feedbackId, text }) => {
    const adminId = await requireAdmin(ctx);
    const fb = await ctx.db.get(feedbackId);
    if (fb === null) throw new Error("Not found: feedback");
    const trimmed = text.trim().slice(0, RESPONSE_MAX);
    if (trimmed.length === 0) throw new Error("Empty response");
    const now = Date.now();
    await ctx.db.patch(feedbackId, {
      thread: [
        ...(fb.thread ?? []),
        {
          authorUserId: adminId,
          authorRole: "admin" as const,
          text: trimmed,
          at: now,
        },
      ],
    });
    // Notify the report owner (NON-PHI: a label only — never the reply text,
    // which stays in the feedback thread). Skip when the admin replies to their
    // OWN report. dedupeKey per reply so each one notifies exactly once.
    if (fb.userId !== adminId) {
      await notifyUser(ctx, {
        userId: fb.userId,
        kind: "feedback_reply",
        title: "Réponse à votre signalement",
        body: "Un administrateur a répondu à un signalement que vous avez envoyé.",
        // Deep-link to the reported conversation (the bell's "Mes signalements"
        // section holds the reply text; the top-list item just needs to be
        // openable — restoring the link the old feedback panel exposed).
        href: `/chat/${fb.chatId}`,
        dedupeKey: `feedback_reply:${feedbackId}:${now}`,
      });
    }
    await recordAudit(
      ctx,
      {
        realUserId: adminId,
        effectiveUserId: fb.userId,
        impersonating: adminId !== fb.userId,
      },
      "feedback.respond",
      { resource: "feedback", resourceId: feedbackId },
    );
  },
});

/** The user's OWN reports + exchange thread (never the forensic snapshot). */
export const myFeedback = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActive(ctx);
    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(ADMIN_LIST_MAX);
    // Withdrawn reports vanish from the user's OWN list (they keep existing for
    // the admin); a later admin reply does NOT resurface them.
    return rows
      .filter((r) => r.userClosedAt == null)
      .map((r) => {
        const adminAt = latestAdminAt(r.thread);
        return {
          _id: r._id,
          at: r.at,
          category: r.category,
          comment: r.comment ?? null,
          messageRole: r.snapshot.messageRole,
          // The REPORTED message text, from the FROZEN snapshot — robust even
          // after the live message was regenerated/deleted (the very reason the
          // snapshot exists). The user's OWN report content → no admin gate.
          messageText: r.snapshot.messageText,
          chatId: r.chatId,
          messageId: r.messageId,
          // Thread WITHOUT author ids (the user only needs role + text + time).
          thread: (r.thread ?? []).map((m) => ({
            authorRole: m.authorRole,
            text: m.text,
            at: m.at,
          })),
          answered: adminAt > 0,
          unread: adminAt > (r.userReadAt ?? 0),
        };
      });
  },
});

/** Reactive unread badge count for the notification bell. */
export const myUnreadFeedbackCount = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActive(ctx);
    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(ADMIN_LIST_MAX);
    let count = 0;
    for (const r of rows) {
      if (r.userClosedAt != null) continue; // withdrawn → never badges
      if (latestAdminAt(r.thread) > (r.userReadAt ?? 0)) count++;
    }
    return count;
  },
});

/**
 * The OWNER withdraws/closes their own report, with an optional reason. Owner-only;
 * NO-OP under impersonation (an admin peeking AS the user must not withdraw it,
 * same guard as markAllMyFeedbackRead). The feedback row is KEPT (the admin still
 * sees it + the reason); it just leaves the user's list + clears the report's
 * reply notifications from the bell so nothing is left behind. Idempotent.
 */
export const closeMyFeedback = mutation({
  args: { feedbackId: v.id("feedback"), reason: v.optional(v.string()) },
  handler: async (ctx, { feedbackId, reason }) => {
    const { userId, impersonating } = await requireActive(ctx);
    if (impersonating) return;
    const fb = await ctx.db.get(feedbackId);
    if (fb === null) throw new Error("Not found: feedback");
    if (fb.userId !== userId) throw new Error("Forbidden: not your report");
    if (fb.userClosedAt != null) return; // idempotent
    const now = Date.now();
    const trimmed = reason?.trim().slice(0, RESPONSE_MAX);
    await ctx.db.patch(feedbackId, {
      userClosedAt: now,
      userCloseReason: trimmed && trimmed.length > 0 ? trimmed : undefined,
    });
    // Remove the report's reply notifications from the bell's top feed so a
    // withdrawn report leaves NOTHING behind (the "Mes signalements" entry is
    // filtered by userClosedAt; these top rows must go too). Their dedupeKey is
    // `feedback_reply:<feedbackId>:<at>` (see respondToFeedback).
    const prefix = `feedback_reply:${feedbackId}:`;
    const notifs = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const n of notifs) {
      if (n.dedupeKey?.startsWith(prefix)) await ctx.db.delete(n._id);
    }
    await recordAudit(
      ctx,
      { realUserId: userId, effectiveUserId: userId, impersonating: false },
      "feedback.close",
      { resource: "feedback", resourceId: feedbackId },
    );
  },
});

/** Mark all the user's reports read. NO-OP under impersonation (advisor guard). */
export const markAllMyFeedbackRead = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId, impersonating } = await requireActive(ctx);
    if (impersonating) return; // an admin peeking AS the user must not clear it
    const now = Date.now();
    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(ADMIN_LIST_MAX);
    for (const r of rows) {
      if (latestAdminAt(r.thread) > (r.userReadAt ?? 0)) {
        await ctx.db.patch(r._id, { userReadAt: now });
      }
    }
  },
});

// --- One-shot migration (UI-10 code-review P2) -------------------------------
//
// Before UI-10, `respondToFeedback` did NOT create a `notifications` row — the
// badge was driven by `myUnreadFeedbackCount`. UI-10 moved the badge to the
// generic `notifications` table, so feedback replies that were still UNREAD at
// deploy time have no notification and would silently vanish from the badge.
//
// This replays what `respondToFeedback` WOULD have produced for those threads:
// for each report whose latest admin reply is unread (`latestAdminAt >
// userReadAt`) and was NOT authored by the owner (mirrors the `fb.userId !==
// adminId` skip), emit one idempotent `feedback_reply` notification keyed
// `feedback_reply:<id>:<latestAdminAt>` — the SAME dedupeKey shape a future
// reply would use, so a live reply racing the backfill is deduped, not doubled.
// Paginated + idempotent → safe to run more than once.
//
// RUN ONCE post-deploy (the schema change is inert without it):
//   npx convex run feedback:backfillFeedbackNotifications
//
// BOUNDED PER TRANSACTION (Codex R2-P1): a Convex mutation is ONE transaction
// with read/write limits, so we process a single bounded page then SELF-SCHEDULE
// the next page via `ctx.scheduler.runAfter(0, …)`. A naive in-one-mutation
// loop over the whole table would blow the limits on a large base and fail the
// backfill entirely. The CLI call runs the first page and returns; the chain
// drains the rest in background. Idempotent (dedupeKey), so a re-run is safe.
const BACKFILL_PAGE = 100;

export const backfillFeedbackNotifications = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (
    ctx,
    { cursor },
  ): Promise<{ scanned: number; notified: number; done: boolean }> => {
    const result = await ctx.db
      .query("feedback")
      .paginate({ numItems: BACKFILL_PAGE, cursor: cursor ?? null });
    let notified = 0;
    for (const fb of result.page) {
      const latest = latestAdminMessage(fb.thread);
      if (latest === null) continue; // no admin reply yet
      if (latest.at <= (fb.userReadAt ?? 0)) continue; // already read
      if (latest.authorUserId === fb.userId) continue; // self-reply (mirror producer)
      const dedupeKey = `feedback_reply:${fb._id}:${latest.at}`;
      const before = await ctx.db
        .query("notifications")
        .withIndex("by_user_dedupe", (q) =>
          q.eq("userId", fb.userId).eq("dedupeKey", dedupeKey),
        )
        .first();
      if (before !== null) continue; // already backfilled / produced
      // Direct insert (not notifyUser) — one dedupe read above is enough, and we
      // need the exact count + the ORIGINAL reply time as the label.
      await ctx.db.insert("notifications", {
        userId: fb.userId,
        kind: "feedback_reply",
        title: "Réponse à votre signalement",
        body: "Un administrateur a répondu à un signalement que vous avez envoyé.",
        href: `/chat/${fb.chatId}`, // deep-link to the reported conversation
        dedupeKey,
        createdAt: latest.at, // original reply time (label only; feed sorts by insert)
      });
      notified += 1;
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.feedback.backfillFeedbackNotifications,
        { cursor: result.continueCursor },
      );
    }
    return { scanned: result.page.length, notified, done: result.isDone };
  },
});
