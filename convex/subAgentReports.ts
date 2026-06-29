// USER report on a SUB-AGENT FAILURE — the two-plane (SOC2) engine.
//
// When a user flags a failed sub-agent card, `createSubAgentReport`:
//   PLANE 1 (CONTENT-BEARING, owner-scoped): FREEZES a forensic snapshot of the
//     flagged child + its failed siblings + the spawning turn into
//     `subAgentReports` (this is the user's own data, surfaced in the Atrium UI;
//     the admin read is AUDITED). Mirrors the `feedback` forensic-snapshot model.
//     The freeze is load-bearing: `reapStaleSubAgents` OVERWRITES a child's
//     `errorMessage` and a re-spawn can replace rows, so we capture the real
//     failure AT report time.
//   PLANE 2 (CONTENT-FREE, observability): emits ONE anomaly (source:"user",
//     kind:"subagent.failure") whose `evidence` is built ONLY from
//     lib/subAgentFailure.toSubAgentFailureStructure — {status enum, error
//     CATEGORY enum, counts, opaque ids} + the `reportId`/correlationId POINTER
//     into plane-1. The raw error text NEVER crosses into the anomaly. The MCP
//     analyzes via the existing `list_anomalies` (content-free) + the
//     correlationId → `get_trace_enrichment`; NO new MCP surface, and NO
//     key-authed/MCP route ever reads `subAgentReports` (the reportId is an
//     opaque pointer, safe even if it leaks).

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import {
  requireActive,
  requireOwnedChat,
  requireAdmin,
  getProfile,
} from "./lib/access";
import { recordAudit } from "./lib/audit";
import { notifyAdmins } from "./notifications";
import {
  PERMISSIONS,
  permissionsForRoleKey,
  roleHasPermission,
} from "./lib/rbac";
import {
  toSubAgentFailureStructure,
  isFailedStatus,
  type SubAgentFailureInput,
  type SubAgentStatus,
} from "./lib/subAgentFailure";

const COMMENT_MAX = 1000;
const RESPONSE_MAX = 2000;
// Bounded freeze: the flagged child + at most this many failed siblings. A
// runaway chat can accumulate many sub-agents; the bound is RECORDED in the
// snapshot (childrenTruncated) — never a silent drop.
const CHILDREN_MAX = 20;
const ADMIN_LIST_MAX = 200;

// Per-field byte cap on the FROZEN text (errorMessage/resultText/taskName/phase
// per child + parentText). A verbose sub-agent failure can carry a huge
// errorMessage/resultText (or a long spawning turn), and the whole snapshot lands
// in ONE Convex document (hard ~1MB limit) — an over-cap insert would THROW and
// lose the report exactly when the failure is most worth capturing. Cap so the
// worst case stays well under 1MB even at CHILDREN_MAX: 3 text fields × 20
// children × 10KB + parentText ≈ 0.6MB, with headroom for keys + sessionMeta.
// Any clip flips `snapshot.textTruncated` so the audited admin read knows.
export const FIELD_TEXT_MAX_BYTES = 10_000;
// sessionMeta is bounded gateway metadata, but a large models list could still
// be sizable; drop it WHOLE (not mid-JSON, which would corrupt it) past this.
const SESSION_META_MAX_BYTES = 30_000;

// Optional reporter-picked reason. Kept as a small allowlist so the frontend and
// the validator agree; an unknown value is dropped (treated as absent).
export const SUBAGENT_REPORT_CATEGORIES = [
  "hung", // never finished / observer lost
  "wrong_result", // finished but the answer was wrong
  "error", // failed with an error
  "other",
] as const;

function isCategory(s: string): boolean {
  return (SUBAGENT_REPORT_CATEGORIES as readonly string[]).includes(s);
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

const TEXT_ENCODER = new TextEncoder();

/** UTF-8 byte length of a string (the metric Convex bounds a document by). */
function byteLen(s: string): number {
  return TEXT_ENCODER.encode(s).length;
}

/**
 * Clip a frozen text field to FIELD_TEXT_MAX_BYTES UTF-8 bytes (byte-accurate, so
 * multi-byte content can't slip past the bound) and report whether it was clipped.
 * A partial trailing char left by the byte slice is dropped via TextDecoder. This
 * keeps the single snapshot document under Convex's ~1MB limit so the insert can
 * never throw and silently lose the report.
 */
function clipText(s: string | undefined): {
  text: string | undefined;
  clipped: boolean;
} {
  if (s === undefined) return { text: undefined, clipped: false };
  const bytes = TEXT_ENCODER.encode(s);
  if (bytes.length <= FIELD_TEXT_MAX_BYTES) return { text: s, clipped: false };
  const text = new TextDecoder().decode(bytes.slice(0, FIELD_TEXT_MAX_BYTES));
  return { text, clipped: true };
}

/**
 * Flag a failed sub-agent: freeze the plane-1 content record + emit the plane-2
 * content-free anomaly. Owner-scoped to the EFFECTIVE identity (an admin
 * investigating via impersonation flips the effective identity and is audited).
 */
export const createSubAgentReport = mutation({
  args: {
    subAgentId: v.id("subAgents"),
    category: v.optional(v.string()),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, realUserId, impersonating, actor } =
      await requireActive(ctx);

    const flagged = await ctx.db.get(args.subAgentId);
    if (flagged === null) throw new Error("Not found: sub-agent");
    // Owner-scope via the chat the sub-agent belongs to (the access boundary).
    await requireOwnedChat(ctx, userId, flagged.chatId);

    // Only a TERMINAL sub-agent is reportable (mirrors the UI's
    // isReportableSubAgent = status !== "running"). The public mutation can be
    // called directly or raced against a stale UI, so reject a still-running child
    // server-side — else we'd freeze a report + emit a `subagent.failure` anomaly
    // (failedCount:0) for a child that hasn't failed. A genuinely stuck running
    // child is terminalized to `error` by the observer watchdog/reaper within its
    // TTL, after which it is reportable — so reject-running is correct, not lossy.
    if (flagged.status === "running") {
      throw new Error("Forbidden: sub-agent still running");
    }

    // IDEMPOTENT: a re-click on an already-reported card / a retry / a mutation
    // replay must NOT create a duplicate report (+ anomaly + admin notification).
    // Look up an existing report for THIS (effective user, sub-agent) first and
    // return it unchanged. `by_subagent` is bounded (only the chat owner can
    // report a given child, so this slice is 0–1 rows in practice).
    const priorForChild = await ctx.db
      .query("subAgentReports")
      .withIndex("by_subagent", (q) => q.eq("subAgentId", flagged._id))
      .collect();
    const existing = priorForChild.find((r) => r.userId === userId);
    if (existing !== undefined) {
      return { reportId: existing._id, anomalyId: existing.anomalyId ?? null };
    }

    const category =
      args.category && isCategory(args.category) ? args.category : undefined;
    const comment = args.comment?.slice(0, COMMENT_MAX) || undefined;

    // Gather the flagged child + its FAILED siblings in the same chat (bounded
    // freeze, flagged FIRST, newest siblings next). The flagged child is captured
    // whatever its status (a "wrong_result" report targets a done child).
    //
    // BOUNDED READ (not a whole-chat `.collect()`): range ONLY the failed slices
    // via `by_chat_status` — (chat,"error") and (chat,"aborted"), newest-first,
    // each capped at CHILDREN_MAX. A long-lived chat with a large sub-agent
    // history therefore never blows the transaction read limit here.
    const [erroredRows, abortedRows] = await Promise.all([
      ctx.db
        .query("subAgents")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", flagged.chatId).eq("status", "error"),
        )
        .order("desc")
        .take(CHILDREN_MAX),
      ctx.db
        .query("subAgents")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", flagged.chatId).eq("status", "aborted"),
        )
        .order("desc")
        .take(CHILDREN_MAX),
    ]);
    const failedSiblings = [...erroredRows, ...abortedRows]
      .filter((r) => r._id !== flagged._id)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const capturedAll = [flagged, ...failedSiblings];
    const captured = capturedAll.slice(0, CHILDREN_MAX);
    // Honest truncation flag: either we have more than we keep, or a failed slice
    // hit its cap (there may be more failed siblings than we read).
    const childrenTruncated =
      capturedAll.length > CHILDREN_MAX ||
      erroredRows.length >= CHILDREN_MAX ||
      abortedRows.length >= CHILDREN_MAX;

    // Spawning turn (best-effort; parentMessageId is often absent on a subAgents
    // row). All CONTENT here lives ONLY in plane-1.
    let parentMsg: Doc<"messages"> | null = null;
    if (flagged.parentMessageId) {
      parentMsg = await ctx.db.get(flagged.parentMessageId);
    }
    const chat = await ctx.db.get(flagged.chatId);
    const sessionMeta = chat?.sessionMeta;

    // The plane-2 drill pointer: the parent turn's correlationId (`chatId:runId`)
    // when resolvable, else the chatId. Both are non-PHI ids (Atrium treats
    // chatId/runId as non-PHI across traces).
    const correlationId = parentMsg?.runId
      ? `${flagged.chatId}:${parentMsg.runId}`
      : (flagged.chatId as string);

    // Clip every frozen TEXT field to keep the single snapshot document under
    // Convex's ~1MB limit (an over-cap insert would throw → no report, no anomaly).
    // `textTruncated` records that ANY field was clipped, so the audited admin read
    // knows the stored text is an excerpt. NOTE: this clips ONLY the plane-1 stored
    // copy — the plane-2 projector below classifies the ORIGINAL `captured` rows,
    // so a clipped tail can't change the (content-free) error category.
    let textTruncated = false;
    const clip = (s: string | undefined): string | undefined => {
      const r = clipText(s);
      if (r.clipped) textTruncated = true;
      return r.text;
    };
    const childrenSnapshot = captured.map((c) => ({
      childSessionKey: c.childSessionKey,
      taskName: clip(c.taskName),
      status: c.status,
      errorMessage: clip(c.errorMessage),
      resultText: clip(c.resultText),
      phase: clip(c.phase),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
    const parentText = clip(parentMsg?.text);
    // sessionMeta is bounded gateway metadata; drop it WHOLE past the cap (clipping
    // mid-JSON would corrupt it) and flag the truncation.
    let sessionMetaJson = sessionMeta ? safeJson(sessionMeta) : undefined;
    if (sessionMetaJson !== undefined && byteLen(sessionMetaJson) > SESSION_META_MAX_BYTES) {
      sessionMetaJson = undefined;
      textTruncated = true;
    }
    const totalCount = childrenSnapshot.length;
    const failedCount = childrenSnapshot.filter((c) =>
      isFailedStatus(c.status as SubAgentStatus),
    ).length;

    const now = Date.now();
    // PLANE 1 — content-bearing record (owner-scoped). Inserted first so the
    // anomaly can carry its id as the pointer.
    const reportId = await ctx.db.insert("subAgentReports", {
      userId,
      realUserId,
      impersonated: impersonating,
      chatId: flagged.chatId,
      subAgentId: flagged._id,
      at: now,
      category,
      comment,
      correlationId,
      snapshot: {
        flaggedChildSessionKey: flagged.childSessionKey,
        totalCount,
        failedCount,
        children: childrenSnapshot,
        childrenTruncated: childrenTruncated || undefined,
        textTruncated: textTruncated || undefined,
        parentMessageId: parentMsg?._id,
        parentMessageRole: parentMsg?.role,
        parentText,
        parentRunId: parentMsg?.runId,
        parentStatus: parentMsg?.status,
        parentErrorCode: parentMsg?.errorCode,
        openclawModel: sessionMeta?.model,
        openclawProvider: sessionMeta?.modelProvider,
        openclawRuntime: sessionMeta?.agentRuntime,
        sessionMetaJson,
      },
    });

    // PLANE 2 — CONTENT-FREE structure, built through the single projector from
    // ONLY {childSessionKey, status, errorMessage}. The structure carries no
    // errorMessage/resultText/taskName by construction (see lib/subAgentFailure +
    // its sentinel tests).
    const structure = toSubAgentFailureStructure(
      captured.map<SubAgentFailureInput>((c) => ({
        childSessionKey: c.childSessionKey,
        status: c.status as SubAgentStatus,
        errorMessage: c.errorMessage,
      })),
    );
    const evidence = {
      reportId, // opaque pointer into plane-1 (never dereferenced by MCP)
      chatId: flagged.chatId as string,
      totalCount: structure.totalCount,
      failedCount: structure.failedCount,
      statuses: structure.statuses,
      errorCategories: structure.errorCategories,
      childIdShort: structure.childIdShort,
      parentCorrelationId: correlationId,
    };
    // English message (matches the detector anomaly stream style); non-PHI.
    const message = `Sub-agent failure reported — ${structure.failedCount}/${structure.totalCount} failed`;
    const anomalyId = await ctx.db.insert("anomalies", {
      at: now,
      kind: "subagent.failure",
      severity: "warn",
      status: "open",
      message,
      source: "user",
      correlationId,
      evidence: JSON.stringify(evidence),
    });
    // Back-link the anomaly onto the report so the admin can drill content-free
    // anomaly → plane-1 record.
    await ctx.db.patch(reportId, { anomalyId });

    // Notify admins on the OPEN transition (same producer the detector/agent
    // anomalies use; dedupeKey per anomaly id = one notif per row).
    await notifyAdmins(ctx, {
      kind: "anomaly_open",
      title: "Anomalie : subagent.failure",
      body: message,
      href: "/settings/anomalies",
      dedupeKey: `anomaly_open:${anomalyId}`,
    });

    // Audit the submission (low volume, forensically useful). recordAudit stores
    // realUserId + the impersonated flag, so a report filed while impersonating is
    // attributable. Resource = the flagged sub-agent (non-PHI id).
    await recordAudit(ctx, actor, "subagent_report.submit", {
      resource: "subAgent",
      resourceId: args.subAgentId,
    });

    return { reportId, anomalyId };
  },
});

/**
 * Sub-agent ids in a chat the EFFECTIVE user has already reported — so the failed
 * card can mark its flag active. Owner-scoped + bounded by the chat's reports.
 */
export const myReportedSubAgentIds = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const chat = await ctx.db.get(chatId);
    if (chat === null || chat.userId !== userId) return [];
    const rows = await ctx.db
      .query("subAgentReports")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
    return rows
      .filter((r) => r.userId === userId)
      .map((r) => r.subAgentId as string);
  },
});

// ===========================================================================
// ADMIN administration (Settings › Rapports sous-agents) — split by sensitivity,
// IDENTICAL to feedback's model:
//   - listForAdmin  = METADATA only (category, who, when, counts). No content →
//     no per-row audit (like the traces/audit/feedback lists).
//   - readReport    = the CONTENT read (frozen snapshot + comment + thread). A
//     MUTATION gated by `traces.read.content` and AUDITED per call as a
//     cross-user content access.
//   - respondToReport = admin appends to the thread + notifies the owner.
//   - deleteReport  = administration (clear a handled report), audited.
// ===========================================================================

/** Admin metadata list — NO snapshot content, so no per-row content audit. */
export const listForAdmin = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("subAgentReports")
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
          category: r.category ?? null,
          hasComment: !!r.comment,
          totalCount: r.snapshot.totalCount,
          failedCount: r.snapshot.failedCount,
          impersonated: r.impersonated,
          answered: latestAdminAt(r.thread) > 0,
          reporterEmail: reporter?.email ?? null,
          reporterName: reporter?.name ?? null,
          realOperatorEmail: r.impersonated
            ? (realReporter?.email ?? null)
            : null,
          chatId: r.chatId,
          subAgentId: r.subAgentId,
          // Non-PHI ids for the admin drill into Anomalies / Traces.
          correlationId: r.correlationId ?? null,
          anomalyId: r.anomalyId ?? null,
        };
      }),
    );
  },
});

/**
 * The AUDITED content read. Returns the frozen snapshot (children + spawning
 * turn + comment + thread). Gated by `traces.read.content`; every call writes an
 * audit row attributing the admin (realUserId) AND whose content was read
 * (the report owner) — satisfying "admin sees another user's info → traced".
 */
export const readReport = mutation({
  args: { reportId: v.id("subAgentReports") },
  handler: async (ctx, { reportId }) => {
    const adminId = await requireAdmin(ctx);
    const adminProfile = await getProfile(ctx, adminId);
    const perms = await permissionsForRoleKey(ctx, adminProfile?.role ?? "user");
    if (!roleHasPermission(perms, PERMISSIONS.TRACES_READ_CONTENT)) {
      throw new Error("Forbidden: traces.read.content required");
    }

    const r = await ctx.db.get(reportId);
    if (r === null) throw new Error("Not found: report");

    await recordAudit(
      ctx,
      {
        realUserId: adminId,
        effectiveUserId: r.userId,
        impersonating: adminId !== r.userId,
      },
      "subagent_report.read.content",
      { resource: "subAgentReport", resourceId: reportId },
    );

    return {
      _id: r._id,
      at: r.at,
      category: r.category ?? null,
      comment: r.comment ?? null,
      impersonated: r.impersonated,
      reporterUserId: r.userId,
      chatId: r.chatId,
      subAgentId: r.subAgentId,
      correlationId: r.correlationId ?? null,
      anomalyId: r.anomalyId ?? null,
      thread: (r.thread ?? []).map((m) => ({
        authorRole: m.authorRole,
        text: m.text,
        at: m.at,
      })),
      snapshot: r.snapshot,
    };
  },
});

function latestAdminAt(thread: Doc<"subAgentReports">["thread"]): number {
  let mx = 0;
  for (const m of thread ?? [])
    if (m.authorRole === "admin" && m.at > mx) mx = m.at;
  return mx;
}

/**
 * Admin appends a response to a report's thread (audited; not a content read).
 *
 * The reply is an ADMIN-VISIBLE note today (surfaced in readReport + the admin
 * tab). It deliberately does NOT notify the owner yet: a user-facing read surface
 * for sub-agent reports ("Mes signalements" + the bell section, mirroring
 * feedback's Increment C) is a coherent FOLLOW-UP — wiring a notification before
 * that surface exists would fire into a void (the generic bell shows only a label
 * and links to the conversation, which never renders the reply text). The
 * notification + the `subagent_report_reply` kind ship WITH the read surface.
 */
export const respondToReport = mutation({
  args: { reportId: v.id("subAgentReports"), text: v.string() },
  handler: async (ctx, { reportId, text }) => {
    const adminId = await requireAdmin(ctx);
    const r = await ctx.db.get(reportId);
    if (r === null) throw new Error("Not found: report");
    const trimmed = text.trim().slice(0, RESPONSE_MAX);
    if (trimmed.length === 0) throw new Error("Empty response");
    const now = Date.now();
    await ctx.db.patch(reportId, {
      thread: [
        ...(r.thread ?? []),
        {
          authorUserId: adminId,
          authorRole: "admin" as const,
          text: trimmed,
          at: now,
        },
      ],
    });
    await recordAudit(
      ctx,
      {
        realUserId: adminId,
        effectiveUserId: r.userId,
        impersonating: adminId !== r.userId,
      },
      "subagent_report.respond",
      { resource: "subAgentReport", resourceId: reportId },
    );
  },
});

/** Administration: remove a handled report. Audited (no content exposed). */
export const deleteReport = mutation({
  args: { reportId: v.id("subAgentReports") },
  handler: async (ctx, { reportId }) => {
    const adminId = await requireAdmin(ctx);
    const r = await ctx.db.get(reportId);
    if (r === null) return; // idempotent
    await recordAudit(
      ctx,
      {
        realUserId: adminId,
        effectiveUserId: r.userId,
        impersonating: adminId !== r.userId,
      },
      "subagent_report.delete",
      { resource: "subAgentReport", resourceId: reportId },
    );
    await ctx.db.delete(reportId);
  },
});
