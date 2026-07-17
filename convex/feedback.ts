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
import { envLabel } from "./lib/envLabel";
import {
  internalQuery, mutation, query, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import {
  requireActive,
  requireOwnedChat,
  requireAdmin,
  getProfile,
} from "./lib/access";
import { recordAudit } from "./lib/audit";
import { notifyAdmins, notifyUser } from "./notifications";
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
// ── Environment-tagged reference ─────────────────────────────────────────────
// The reference shown to the reporter encodes WHICH deployment it came from
// (like a Convex deployment name in its URL): `<label>-<id>`. The label comes
// from the ATRIUM_ENV_LABEL deployment env var (e.g. "dev", "prod"; unset →
// bare id, fully backward-compatible). Readers strip any label prefix — the
// trailing id-like segment is authoritative — so old bare ids AND foreign
// labels both resolve. Lowercase alphanumerics only (defense against header
// injection through a copy-pasted reference).
// (envLabel moved to lib/envLabel.ts — one label now stamps BOTH the report
// references AND the minted API keys, so the two correlate unambiguously.)

/** Public shape of a reference: label-prefixed when the deployment is labeled. */
export function displayReference(id: string): string {
  const label = envLabel();
  return label ? `${label}-${id}` : id;
}

/** Accept `label-<id>`, bare `<id>`, or any foreign-labeled form: the trailing
 *  id-like run is the id. Returns null when nothing id-like is present. */
export function parseReference(reference: string): string | null {
  const m = reference.trim().match(/([a-z0-9]{20,40})$/i);
  return m ? m[1] : null;
}

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
      // Message older than the scan window: the prompting user turn (needed for
      // the FROZEN routing identity below) is found by a bounded indexed walk
      // backwards from the reported message — without it, a rerouted chat would
      // freeze TODAY's routing onto an OLD turn's report (codex P2).
      const older = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) =>
          // Index RANGE (not a post-scan filter): a report on a very old
          // message in a long chat must not scan every newer row (codex P2).
          q.eq("chatId", message.chatId).lt("_creationTime", message._creationTime),
        )
        .order("desc")
        .take(50);
      promptMessage = older.find((m) => m.role === "user") ?? null;
      // Freeze just the message itself and record that context was unavailable
      // rather than silently dropping it.
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
        // Frozen routing identity (survives rerouting/deletion — codex P2):
        // the reported turn's routed identity when present; an ASSISTANT row
        // does not carry it, so inherit from its prompting USER turn (which
        // send.ts stamps on routed sends); else the chat primary (codex P2 ×2).
        instanceName:
          (message as { routedInstanceName?: string }).routedInstanceName ??
          (promptMessage as { routedInstanceName?: string } | null)
            ?.routedInstanceName ??
          chat?.instanceName,
        agentId:
          (message as { routedAgentId?: string }).routedAgentId ??
          (promptMessage as { routedAgentId?: string } | null)?.routedAgentId ??
          chat?.agentId,
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

    // Badge every admin's bell the moment a report lands (the reactive half of
    // "a user just hit a problem"). Non-PHI by construction: reference +
    // category only — NEVER the user's comment (free text) nor any snapshot
    // content. Scheduled fan-out: the submission commits regardless of the
    // admin-set size; dedupeKey makes re-runs idempotent.
    const reference = displayReference(String(feedbackId));
    await notifyAdmins(ctx, {
      kind: "feedback_new",
      title: "Nouveau signalement utilisateur",
      body: `${reference} (${args.category})`,
      messageKey: "notif_feedback_new",
      params: { reference, category: args.category },
      href: "/settings/feedbacks",
      dedupeKey: `feedback_new:${feedbackId}`,
    });

    return {
      feedbackId,
      displayedMatchesStored,
      // Environment-tagged shareable reference (what the dialog shows).
      reference,
    };
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
          // The shareable env-labeled reference (what the reporter saw at
          // submit time, and what the key-authed support API takes): without
          // it here the admin has NO way to hand a report to an agent — the
          // reporter's submit dialog is the only other place it ever shows.
          reference: displayReference(r._id),
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
          // API-side resolution: the admin tab shows "resolved" instead of
          // an eternal "pending" for agent-closed reports (codex P2).
          resolvedAt: r.resolvedAt ?? null,
          resolvedBy: r.resolvedBy ?? null,
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
        authorLabel: m.authorLabel ?? null,
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
  // A SUPPORT reply is an admin's or a service agent's (the key-authed API) —
  // both count for "answered"/unread (codex P2: agent replies must not leave
  // the report looking pending).
  for (const m of thread ?? [])
    if ((m.authorRole === "admin" || m.authorRole === "agent") && m.at > mx)
      mx = m.at;
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
    if (
      (m.authorRole === "admin" || m.authorRole === "agent") &&
      (latest === null || m.at > latest.at)
    ) {
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
        messageKey: "notif_feedback_reply_admin",
        params: {},
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
            authorLabel: m.authorLabel ?? null,
            text: m.text,
            at: m.at,
          })),
          answered: adminAt > 0,
          // Support-side resolution (the key-authed close): the owner sees a
          // "resolved" state even when the close carried no reply (codex P2).
          resolvedAt: r.resolvedAt ?? null,
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
        messageKey: "notif_feedback_reply_admin",
        params: {},
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

/**
 * INTERNAL: one report by id, for the key-authed diagnostic API. Returns the
 * FROZEN forensic snapshot (the user volunteered it for analysis — that is the
 * report's purpose) plus survival flags (the report outlives its message/chat).
 */
export const readForApi = internalQuery({
  args: { feedbackId: v.id("feedback") },
  handler: async (ctx, { feedbackId }) => {
    const fb = await ctx.db.get(feedbackId);
    if (!fb) return { ok: false as const, error: "not_found" as const };
    const chat = await ctx.db.get(fb.chatId);
    const message = await ctx.db.get(fb.messageId);
    return {
      ok: true as const,
      report: {
        feedbackId: String(fb._id),
        // The same env-tagged reference the reporter saw (self-describing id).
        reference: displayReference(String(fb._id)),
        // WHERE this happened — no more guessing the environment/instance from
        // traces (three live occurrences on 2026-07-05 alone).
        environment: envLabel(),
        // FROZEN at submit (forensic — survives rerouting/deletion); pre-freeze
        // reports fall back to the live chat.
        instanceName: fb.snapshot.instanceName ?? chat?.instanceName ?? null,
        agentId: fb.snapshot.agentId ?? chat?.agentId ?? null,
        at: fb.at,
        category: fb.category,
        comment: fb.comment ?? null,
        // The reported conversation + message ids, so a diagnosis can chain
        // straight into the chat's traces (list_traces / get_chat_state)
        // without re-deriving the chatId from a runId search.
        chatId: String(fb.chatId),
        messageId: String(fb.messageId),
        displayedMatchesStored: fb.snapshot.displayedMatchesStored ?? null,
        snapshot: fb.snapshot,
        chatExists: chat !== null,
        messageExists: message !== null,
        // The response THREAD (user follow-ups + service/admin replies): the
        // support agent must read what was already answered before replying —
        // without it a threadLength>0 report is opaque over the API.
        thread: (fb.thread ?? []).map((m) => ({
          authorRole: m.authorRole,
          authorLabel: m.authorLabel ?? null,
          text: m.text,
          at: m.at,
        })),
      },
    };
  },
});

/**
 * INTERNAL: list reports for the key-authed API (the meta/critic agent's
 * inbox). METADATA ONLY — reference/category/comment/age/state, never the
 * forensic snapshot (get one by reference via readForApi for that). `openOnly`
 * filters to actionable reports (not user-withdrawn, not resolved).
 */
export const listForApi = internalQuery({
  args: { openOnly: v.optional(v.boolean()), limit: v.optional(v.number()) },
  handler: async (ctx, { openOnly, limit }) => {
    const cap = Math.min(Math.max(limit ?? 50, 1), 200);
    // Paginated scan until `cap` matching reports are collected — a fixed
    // take(N)-then-filter would silently omit an OLD still-open report behind
    // N closed newer ones (codex P2). Bounded at MAX_SCAN rows; if the bound
    // is hit the response says so instead of reading as complete.
    const MAX_SCAN = 2000;
    let scanned = 0;
    let truncatedScan = false;
    const out = [];
    let cursor: string | null = null;
    while (out.length < cap) {
      const page = await ctx.db
        .query("feedback")
        .order("desc")
        .paginate({ cursor, numItems: 200 });
      for (const fb of page.page) {
        scanned++;
        const open = fb.userClosedAt == null && fb.resolvedAt == null;
        if (openOnly !== false && !open) continue;
        if (out.length >= cap) break;
        out.push(projectReport(fb));
      }
      if (page.isDone) break;
      if (scanned >= MAX_SCAN) {
        truncatedScan = true;
        break;
      }
      cursor = page.continueCursor;
    }
    return { ok: true as const, reports: out, truncatedScan };
  },
});

function projectReport(fb: {
  _id: Id<"feedback">;
  at: number;
  category: string;
  comment?: string;
  userClosedAt?: number;
  resolvedAt?: number;
  thread?: unknown[];
  snapshot: { displayedMatchesStored?: boolean };
}) {
  const open = fb.userClosedAt == null && fb.resolvedAt == null;
  return {
    feedbackId: String(fb._id),
    // Env-tagged shareable form — matches what the reporter's dialog showed.
    reference: displayReference(String(fb._id)),
    at: fb.at,
    category: fb.category,
    comment: fb.comment ?? null,
    open,
    resolvedAt: fb.resolvedAt ?? null,
    userClosedAt: fb.userClosedAt ?? null,
    threadLength: (fb.thread ?? []).length,
    displayedMatchesStored: fb.snapshot.displayedMatchesStored ?? null,
  };
}

/**
 * INTERNAL: append a SERVICE reply to a report's thread (key-authed API,
 * permission feedback.respond — e.g. the meta/critic gateway agent). Mirrors
 * respondToFeedback: the owner is notified (label only, never the reply text).
 */
export const replyForApi = internalMutation({
  args: {
    feedbackId: v.id("feedback"),
    text: v.string(),
    authorLabel: v.string(),
  },
  handler: async (ctx, { feedbackId, text, authorLabel }) => {
    const fb = await ctx.db.get(feedbackId);
    if (!fb) return { ok: false as const, error: "not_found" as const };
    // A report the OWNER withdrew is invisible in their "Mes signalements" —
    // replying would notify them about a thread they cannot see (codex P2).
    if (fb.userClosedAt != null)
      return { ok: false as const, error: "user_closed" as const };
    const trimmed = text.trim().slice(0, RESPONSE_MAX);
    if (trimmed.length === 0)
      return { ok: false as const, error: "empty" as const };
    const now = Date.now();
    await ctx.db.patch(feedbackId, {
      thread: [
        ...(fb.thread ?? []),
        {
          authorRole: "agent" as const,
          authorLabel: authorLabel.slice(0, 80),
          text: trimmed,
          at: now,
        },
      ],
    });
    await notifyUser(ctx, {
      userId: fb.userId,
      kind: "feedback_reply",
      title: "Réponse à votre signalement",
      body: "Votre signalement a reçu une réponse.",
      messageKey: "notif_feedback_reply",
      params: {},
      href: `/chat/${fb.chatId}`,
      dedupeKey: `feedback_reply:${feedbackId}:${now}`,
    });
    return { ok: true as const, at: now };
  },
});

/**
 * INTERNAL: resolve a report (key-authed API). The row is KEPT; the owner still
 * sees their report + thread with the resolved state. Idempotent. Distinct from
 * the owner's own withdrawal (userClosedAt).
 */
export const closeForApi = internalMutation({
  args: {
    feedbackId: v.id("feedback"),
    resolvedBy: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { feedbackId, resolvedBy, note }) => {
    const fb = await ctx.db.get(feedbackId);
    if (!fb) return { ok: false as const, error: "not_found" as const };
    if (fb.resolvedAt != null)
      return { ok: true as const, alreadyResolved: true as const };
    const now = Date.now();
    // On a report the OWNER already withdrew, the thread is invisible to them:
    // resolve silently (state only) — a note would be written for nobody.
    const trimmedNote =
      fb.userClosedAt == null ? note?.trim().slice(0, RESPONSE_MAX) : undefined;
    await ctx.db.patch(feedbackId, {
      resolvedAt: now,
      resolvedBy: resolvedBy.slice(0, 80),
      // A closing note rides the thread so the owner sees WHY it was resolved.
      ...(trimmedNote
        ? {
            thread: [
              ...(fb.thread ?? []),
              {
                authorRole: "agent" as const,
                authorLabel: resolvedBy.slice(0, 80),
                text: trimmedNote,
                at: now,
              },
            ],
          }
        : {}),
    });
    // A closing note is a visible thread message — notify like a reply, else
    // the owner never learns an explanation awaits them (codex P2). A bare
    // close (no note) stays silent: there is nothing new to read.
    if (trimmedNote && fb.userClosedAt == null) {
      await notifyUser(ctx, {
        userId: fb.userId,
        kind: "feedback_resolved",
        title: "Signalement résolu",
        body: "Votre signalement a été résolu, avec une explication.",
        messageKey: "notif_feedback_resolved",
        params: {},
        href: `/chat/${fb.chatId}`,
        dedupeKey: `feedback_reply:${feedbackId}:${now}`,
      });
    }
    return { ok: true as const, at: now };
  },
});
