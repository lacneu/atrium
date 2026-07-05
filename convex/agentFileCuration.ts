// Agent-file CURATION — auto-management of over-budget agent workspace files
// (MEMORY.md, AGENTS.md, ...). When a file exceeds its budget OpenClaw simply
// TRUNCATES it at injection time (tail lost). This rationalizes it instead: a
// specialist ("curator" agentType) rewrites the file smaller while preserving
// the relevant data, and the result is stored as a PROPOSED revision an admin
// reviews (mini-diff) + approves — the live file is NEVER auto-written.
//
// Safety posture (the #1 risk is SILENT semantic data loss):
//   - DEFAULT OFF per instance (config.curationEnabled) — admin opt-in.
//   - PROPOSE-AND-APPROVE — a curation produces a proposal + a full before/after
//     the admin diffs (agentFileRevisions on apply = one-click rollback).
//   - Write-back defense — the free-form reply is stripped/validated
//     (lib/curation.ts) before it can even become a proposal.
//   - CAS on apply (baseUpdatedAtMs) — a concurrent edit -> conflict, never a
//     silent clobber.
//   - PII hygiene — beforeContent/proposedContent (copies of file content, which
//     for MEMORY.md holds other users' data) are PURGED when the job resolves.
//
// Provider-neutral: everything rides the bridge `agents.files.*` surface, so it
// is Hermes-ready without change.

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getActor, requireAdmin } from "./lib/access";
import { resolveCuratorTarget } from "./agents";
import {
  postBridge,
  requireOkStatus,
} from "./agentFiles";
import {
  clampCurationBudget,
  CURATABLE_FILES,
  CURATION_ONE_SHOT_MAX_SOURCE_CHARS,
  extractCuratedContent,
  isCurationCandidate,
  validateCuration,
} from "./lib/curation";
import { curationSessionNonce } from "./lib/rehydration";
import { contentLocaleForInstance } from "./lib/serverLocale";
import type { Locale } from "./lib/locales";
import {
  effectiveTemplate,
  fillTemplate,
  resolveInjection,
  type PromptInjectionConfig,
} from "./lib/promptInjections";
import { cleanupHiddenChatContent } from "./chatSummaries";
import { notifyUser } from "./notifications";

const CURATABLE_SET: ReadonlySet<string> = new Set(CURATABLE_FILES);

// ===========================================================================
// Prompt (the curator briefing). Atrium frames the job; a dedicated curator
// agent may ALSO carry its own briefing — this is the belt.
// ===========================================================================

function buildCurationPrompt(
  fileName: string,
  content: string,
  budgetChars: number,
  feedback: string | undefined,
  injections: PromptInjectionConfig | undefined,
  // The instance's CONTENT locale — language of the default brief + fillers.
  locale: Locale,
): string {
  // The briefing is the per-instance `file_curation` PROMPT INJECTION (admin
  // customizes it per gateway type in Settings > Injections de prompt; disabling
  // it sends bare material for a dedicated curator agent that carries its own).
  const resolved = resolveInjection("file_curation", injections, locale);
  const template = effectiveTemplate("file_curation", resolved, locale);
  return fillTemplate(template, {
    file_name: fileName,
    budget_chars: String(budgetChars),
    feedback:
      feedback && feedback.trim().length > 0
        ? feedback.trim()
        : locale === "fr"
          ? "(aucun — première proposition)"
          : "(none — first proposal)",
    content,
  });
}

// ===========================================================================
// Curator hidden chat (one per user, mirrors ensureSummarizerChat)
// ===========================================================================

async function ensureCuratorChat(
  ctx: MutationCtx,
  userId: Id<"users">,
  target: { instanceName: string; agentId: string },
  now: number,
): Promise<Doc<"chats">> {
  const existing = await ctx.db
    .query("chats")
    .withIndex("by_user_kind", (q) =>
      q.eq("userId", userId).eq("kind", "curator"),
    )
    .first();
  if (existing) {
    if (
      existing.instanceName !== target.instanceName ||
      existing.agentId !== target.agentId
    ) {
      await ctx.db.patch(existing._id, {
        instanceName: target.instanceName,
        agentId: target.agentId,
      });
    }
    return (await ctx.db.get(existing._id))!;
  }
  const id = await ctx.db.insert("chats", {
    userId,
    kind: "curator" as const,
    title: "Curation",
    instanceName: target.instanceName,
    agentId: target.agentId,
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}

// ===========================================================================
// Trigger (admin, manual): read the file over the bridge, then dispatch a job.
// ===========================================================================

export const requestCuration = action({
  args: {
    instanceName: v.string(),
    agentId: v.string(),
    name: v.string(),
    // manual = the admin button (force); auto is reserved for the future cron.
    trigger: v.optional(v.union(v.literal("auto"), v.literal("manual"))),
  },
  handler: async (
    ctx,
    { instanceName, agentId, name, trigger },
  ): Promise<{ ok: boolean; reason?: string; curationId?: string }> => {
    await ctx.runQuery(internal.agentFiles.checkAdminAccess, {});
    if (!CURATABLE_SET.has(name)) {
      return { ok: false, reason: "not_curatable" };
    }
    // FEATURE gate + budget from the instance config (default OFF).
    const cfg = await ctx.runQuery(internal.agentFileCuration.instanceCuration, {
      instanceName,
    });
    if (!cfg.enabled) return { ok: false, reason: "disabled" };
    const budgetChars = clampCurationBudget(cfg.budgetChars);

    // Read the file over the bridge (content + updatedAtMs for the CAS base).
    const bridgeUrl = await ctx.runQuery(
      internal.agentFiles.bridgeUrlForInstance,
      { instanceName },
    );
    const { status, data } = await postBridge(
      "/agent-files",
      { op: "get", instanceName, agentId, name },
      undefined,
      bridgeUrl,
    );
    requireOkStatus(status, "agent-files get");
    const file = (data as { file?: { content?: unknown; updatedAtMs?: unknown } })
      ?.file;
    const content = typeof file?.content === "string" ? file.content : "";
    const baseUpdatedAtMs =
      typeof file?.updatedAtMs === "number" ? file.updatedAtMs : null;
    if (content.length === 0) return { ok: false, reason: "empty_or_missing" };

    // Only curate an ACTUAL over-budget file (manual still requires it — never
    // rewrite a healthy file). Over the one-shot ceiling -> FLAG, don't attempt a
    // single-pass rewrite that would itself overflow (advisor: detect, not truncate).
    if (!isCurationCandidate(content.length, budgetChars)) {
      return { ok: false, reason: "under_budget" };
    }
    if (content.length > CURATION_ONE_SHOT_MAX_SOURCE_CHARS) {
      return { ok: false, reason: "too_large_for_one_shot" };
    }

    // Dispatch the curation job (create row + hidden chat + outbox).
    return await ctx.runMutation(internal.agentFileCuration.dispatchCuration, {
      instanceName,
      agentId,
      name,
      content,
      baseUpdatedAtMs,
      budgetChars,
      trigger: trigger ?? "manual",
    });
  },
});

export const dispatchCuration = internalMutation({
  args: {
    instanceName: v.string(),
    agentId: v.string(),
    name: v.string(),
    content: v.string(),
    baseUpdatedAtMs: v.union(v.number(), v.null()),
    budgetChars: v.number(),
    trigger: v.union(v.literal("auto"), v.literal("manual")),
    // Admin guidance from a rejected proposal (woven into the curator prompt).
    feedback: v.optional(v.string()),
    // INTERNAL-ONLY caller identity for the SCHEDULED relaunch path (a scheduled
    // action has no auth context). The public entry (requestCuration) never
    // passes it — getActor stays the source of truth there.
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string; curationId?: string }> => {
    const userId = args.userId ?? (await getActor(ctx)).realUserId;
    // A curator agent on the SAME instance (content never crosses instances).
    const target = await resolveCuratorTarget(ctx, userId, args.instanceName);
    if (target === null) return { ok: false, reason: "no_curator_agent" };

    const now = Date.now();
    // Serialize FIRST, BEFORE ensureCuratorChat rebinds the hidden chat: a second
    // request on another instance must NOT re-point an in-flight curator chat (its
    // still-pending outbox would then dispatch the FIRST file's prompt to the NEW
    // instance — content crossing instances; codex P1).
    const existingCurator = await ctx.db
      .query("chats")
      .withIndex("by_user_kind", (q) =>
        q.eq("userId", userId).eq("kind", "curator"),
      )
      .first();
    if (existingCurator?.pendingCurate) {
      return { ok: false, reason: "in_flight" };
    }
    const hidden = await ensureCuratorChat(ctx, userId, target, now);
    // PRE-DISPATCH sweep (codex P2): a prior job may have released pendingCurate
    // but its scheduled cleanup hasn't run / failed — purge the stale rows (copies
    // of a previous agent file) NOW, before this chat holds a fresh lock (after
    // which cleanupCuratorChat skips the sweep). Mirrors the summarizer.
    await cleanupCuratorChatRows(ctx, hidden._id);

    const curationId = await ctx.db.insert("agentFileCurations", {
      instanceName: args.instanceName,
      agentId: args.agentId,
      name: args.name,
      status: "dispatched" as const,
      baseUpdatedAtMs: args.baseUpdatedAtMs,
      beforeSize: args.content.length,
      beforeContent: args.content,
      budgetChars: args.budgetChars,
      requestedByUserId: userId,
      trigger: args.trigger,
      ...(args.feedback ? { feedback: args.feedback } : {}),
      createdAt: now,
      updatedAt: now,
    });

    // The briefing template is the instance's `file_curation` injection.
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", args.instanceName))
      .first();
    const contentLocale = await contentLocaleForInstance(ctx, instance?.config);
    const prompt = buildCurationPrompt(
      args.name,
      args.content,
      args.budgetChars,
      args.feedback,
      instance?.config?.promptInjections,
      contentLocale,
    );
    const msgId = await ctx.db.insert("messages", {
      chatId: hidden._id,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: prompt,
      updatedAt: now,
    });
    await ctx.db.patch(hidden._id, {
      instanceName: target.instanceName,
      agentId: target.agentId,
      pendingCurate: { curationId, createdAt: now },
      openclawChatId: `curate:${curationId}:${now}`,
      updatedAt: now,
    });
    const outboxId = await ctx.db.insert("outbox", {
      chatId: hidden._id,
      userId,
      clientMessageId: `curate-${curationId}-${now}`,
      messageId: msgId,
      text: prompt,
      attachmentIds: [],
      status: "pending" as const,
    });
    await ctx.scheduler.runAfter(0, internal.bridge.dispatch, { outboxId });
    return { ok: true, curationId: String(curationId) };
  },
});

// ===========================================================================
// Correlate (from stream.finalize on a kind:"curator" chat)
// ===========================================================================

/** Called from stream.finalize when a `kind:"curator"` chat's assistant message
 *  finalizes. Extracts + validates the reply into a PROPOSED revision (never a
 *  live write). Returns true when it handled/settled the job. */
export async function correlateCuration(
  ctx: MutationCtx,
  hiddenChat: Doc<"chats">,
  message: Doc<"messages">,
): Promise<boolean> {
  const job = hiddenChat.pendingCurate;
  if (!job) return false;
  // NONCE OR NOTHING (mirrors correlateSummarize): a reply without the echoed
  // job session key can never settle this job (a late reply of a cancelled job
  // would otherwise settle the wrong one).
  const nonce = curationSessionNonce(String(job.curationId), job.createdAt);
  const identified =
    typeof message.turnSessionKey === "string" &&
    message.turnSessionKey.endsWith(`:${nonce}`);
  if (!identified) return false;

  await ctx.db.patch(hiddenChat._id, { pendingCurate: undefined });
  const curation = await ctx.db.get(job.curationId);
  const now = Date.now();
  // PII hygiene runs in a SEPARATE scheduled mutation, not here: this handler
  // runs inside stream.finalize's transaction on `message` itself — deleting the
  // hidden chat's rows now would delete the in-flight reply row. The proposal is
  // already stored on the curation row before this fires (mirrors the summarizer
  // deferred cleanup).
  const scheduleCleanup = async (): Promise<void> => {
    await ctx.scheduler.runAfter(
      0,
      internal.agentFileCuration.cleanupCuratorChat,
      { hiddenChatId: hiddenChat._id },
    );
  };
  const settle = async (
    patch: Record<string, unknown>,
  ): Promise<void> => {
    if (curation) {
      // PII hygiene: a FAILED job keeps no content copies (a PROPOSED one needs
      // beforeContent for the approve fallback + proposedContent for the review).
      const purge =
        patch.status !== "proposed"
          ? { beforeContent: undefined, proposedContent: undefined }
          : {};
      await ctx.db.patch(job.curationId, { ...patch, ...purge, updatedAt: now });
    }
    await scheduleCleanup();
  };

  if (!curation || curation.status !== "dispatched") {
    // Stale/cancelled job — clean up, settle nothing.
    await scheduleCleanup();
    return true;
  }

  // A curator turn that ended error/aborted may have streamed only a PREFIX —
  // never accept a truncated rewrite as a proposal (codex P2). Only a clean
  // complete reply is extracted.
  if (message.status !== "complete") {
    await settle({ status: "failed", failureReason: "incomplete_reply" });
    await notifyCurationOutcome(ctx, curation, "failed", "incomplete_reply");
    return true;
  }

  const proposed = extractCuratedContent(message.text ?? "");
  if (proposed === null) {
    await settle({ status: "failed", failureReason: "invalid_reply" });
    await notifyCurationOutcome(ctx, curation, "failed", "invalid_reply");
    return true;
  }
  const before = curation.beforeContent ?? "";
  const check = validateCuration(before, proposed, curation.budgetChars);
  if (!check.ok) {
    await settle({ status: "failed", failureReason: check.reason ?? "invalid" });
    await notifyCurationOutcome(ctx, curation, "failed", check.reason);
    return true;
  }
  // A valid PROPOSAL — store it for admin review (never written live).
  await settle({
    status: "proposed",
    proposedContent: proposed,
    proposedSize: proposed.length,
    ...(check.reason === "over_budget"
      ? { failureReason: "over_budget" }
      : {}),
  });
  await notifyCurationOutcome(ctx, curation, "proposed");
  return true;
}

async function notifyCurationOutcome(
  ctx: MutationCtx,
  curation: Doc<"agentFileCurations">,
  outcome: "proposed" | "failed",
  reason?: string,
): Promise<void> {
  // Notify the ADMIN who requested it (auto/cron would notify all admins — a
  // follow-up). Never the file content — a label only.
  const title =
    outcome === "proposed"
      ? "Proposition de curation prête"
      : "Curation échouée";
  const body =
    outcome === "proposed"
      ? `Une proposition pour ${curation.name} (${curation.agentId}) attend votre revue.`
      : `La curation de ${curation.name} a échoué (${reason ?? "raison inconnue"}).`;
  try {
    await notifyUser(ctx, {
      userId: curation.requestedByUserId,
      kind: "curation",
      // Localized at READ by the client (the reader's language); title/body are
      // the write-time fallback for legacy rows/clients.
      messageKey:
        outcome === "proposed" ? "notif_curation_proposed" : "notif_curation_failed",
      params:
        outcome === "proposed"
          ? { name: curation.name, agentId: curation.agentId }
          : { name: curation.name, reason: reason ?? "unknown" },
      title,
      body,
      href: "/settings/agentFiles",
      dedupeKey: `curation:${curation._id}:${outcome}`,
    });
  } catch {
    // best-effort — a notification failure must never wedge the correlate.
  }
}

// ===========================================================================
// Approve / reject (admin)
// ===========================================================================

export const approveCuration = action({
  args: { curationId: v.id("agentFileCurations") },
  handler: async (
    ctx,
    { curationId },
  ): Promise<{ ok: boolean; reason?: string }> => {
    await ctx.runQuery(internal.agentFiles.checkAdminAccess, {});
    return await applyCurationProposal(ctx, curationId);
  },
});

/** The apply core (shared by the admin action + the dev harness): CAS write via
 *  the bridge + revision record + mark resolved. Callers gate admin themselves. */
export async function applyCurationProposal(
  ctx: import("./_generated/server").ActionCtx,
  curationId: Id<"agentFileCurations">,
): Promise<{ ok: boolean; reason?: string }> {
  {
    // CLAIM first (transactional): proposed -> applying, so a concurrent reject
    // cannot flip the row while we write (codex P2).
    const row = await ctx.runMutation(internal.agentFileCuration.claimForApply, {
      curationId,
    });
    if (!row) return { ok: false, reason: "not_proposed" };
    const proposed = row.proposedContent;
    // Write via the bridge with CAS on the base read at dispatch — a concurrent
    // edit since then -> 409, re-curate needed (never a silent clobber).
    const bridgeUrl = await ctx.runQuery(
      internal.agentFiles.bridgeUrlForInstance,
      { instanceName: row.instanceName },
    );
    let status: number;
    let data: unknown;
    try {
      ({ status, data } = await postBridge(
        "/agent-files",
        {
          op: "set",
          instanceName: row.instanceName,
          agentId: row.agentId,
          name: row.name,
          content: proposed,
          baseUpdatedAtMs: row.baseUpdatedAtMs,
        },
        undefined,
        bridgeUrl,
      ));
    } catch (e) {
      // postBridge THROWS on a transport failure (timeout/DNS/unconfigured) —
      // release the claim so the proposal is retryable, never stuck "applying"
      // (codex P2).
      await ctx.runMutation(internal.agentFileCuration.releaseApplyClaim, {
        curationId,
      });
      console.error("[curation] apply bridge error:", (e as Error)?.message ?? e);
      return { ok: false, reason: "bridge_error" };
    }
    if (status === 409) {
      // A real conflict (the file changed since dispatch) — terminal.
      await ctx.runMutation(internal.agentFileCuration.markResolved, {
        curationId,
        status: "failed",
        failureReason: "conflict",
      });
      return { ok: false, reason: "conflict" };
    }
    if (status < 200 || status >= 300) {
      // A TRANSIENT bridge failure (timeout/5xx) — revert the claim to "proposed"
      // so the admin can retry/reject rather than being stuck at "applying" with
      // an invisible proposal (codex P2). The content copies are preserved.
      await ctx.runMutation(internal.agentFileCuration.releaseApplyClaim, {
        curationId,
      });
      return { ok: false, reason: "bridge_error" };
    }
    const before = (data as { before?: { content?: unknown } })?.before?.content;
    // The durable before/after lives in agentFileRevisions (rollback source).
    await ctx.runMutation(internal.agentFiles.recordFileRevision, {
      instanceName: row.instanceName,
      agentId: row.agentId,
      name: row.name,
      before: typeof before === "string" ? before : row.beforeContent ?? "",
      after: proposed,
    });
    await ctx.runMutation(internal.agentFileCuration.markResolved, {
      curationId,
      status: "applied",
    });
    return { ok: true };
  }
}

export const rejectCuration = mutation({
  args: {
    curationId: v.id("agentFileCurations"),
    // WHY the proposal is refused — recorded on the row, and (with `relaunch`)
    // woven into the NEXT attempt's prompt so the curator improves on it.
    comment: v.optional(v.string()),
    // Reject-and-retry: immediately dispatch a fresh curation seeded with the
    // comment; the admin gets a new proposal to review.
    relaunch: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { curationId, comment, relaunch },
  ): Promise<{ ok: boolean }> => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(curationId);
    // Only a settled PROPOSAL is rejectable — a still-`dispatched` job is in
    // flight (its outbox may not have dispatched yet); it resolves via correlate
    // or the stuck watchdog, and the admin rejects the resulting proposal
    // (codex P2 — never leave a dangling outbox/lock).
    if (row && row.status === "proposed") {
      const trimmed = comment?.trim();
      await ctx.db.patch(curationId, {
        status: "rejected" as const,
        ...(trimmed ? { rejectionComment: trimmed } : {}),
        // PII hygiene: drop the content copies on reject.
        beforeContent: undefined,
        proposedContent: undefined,
        updatedAt: Date.now(),
      });
      if (relaunch === true) {
        // Fresh job seeded with the admin's feedback. Runs as the REJECTING
        // admin (their identity is live here; the scheduled action has none).
        const actor = await getActor(ctx);
        await ctx.scheduler.runAfter(
          0,
          internal.agentFileCuration.recurateAfterReject,
          {
            instanceName: row.instanceName,
            agentId: row.agentId,
            name: row.name,
            feedback: trimmed ?? "",
            userId: actor.realUserId,
          },
        );
      }
      return { ok: true };
    }
    return { ok: false };
  },
});

/** Scheduled relaunch after a reject-with-feedback: re-read the file (fresh
 *  content + CAS base), re-check every dispatch guard, then dispatch a new job
 *  seeded with the admin's comment. Any refusal is NOTIFIED (never a silent
 *  no-op — the admin explicitly asked for a retry). */
export const recurateAfterReject = internalAction({
  args: {
    instanceName: v.string(),
    agentId: v.string(),
    name: v.string(),
    feedback: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args): Promise<null> => {
    const refuse = async (reason: string): Promise<null> => {
      // `reason` is a stable code (disabled/bridge_error/…): it rides as a param
      // so the client renders the whole line in the reader's language.
      await ctx.runMutation(internal.agentFileCuration.notifyCurationEvent, {
        userId: args.userId,
        title: "Relance de curation impossible",
        body: `La nouvelle curation de ${args.name} n'a pas pu être lancée (${reason}).`,
        messageKey: "notif_curation_relaunch_refused",
        params: { name: args.name, reason },
        dedupeKey: `curation-relaunch:${args.instanceName}:${args.agentId}:${args.name}:${reason}`,
      });
      return null;
    };
    const cfg = await ctx.runQuery(internal.agentFileCuration.instanceCuration, {
      instanceName: args.instanceName,
    });
    if (!cfg.enabled) return refuse("disabled");
    const budgetChars = clampCurationBudget(cfg.budgetChars);
    const bridgeUrl = await ctx.runQuery(
      internal.agentFiles.bridgeUrlForInstance,
      { instanceName: args.instanceName },
    );
    let content = "";
    let baseUpdatedAtMs: number | null = null;
    try {
      const { status, data } = await postBridge(
        "/agent-files",
        { op: "get", instanceName: args.instanceName, agentId: args.agentId, name: args.name },
        undefined,
        bridgeUrl,
      );
      requireOkStatus(status, "agent-files get");
      const file = (data as { file?: { content?: unknown; updatedAtMs?: unknown } })
        ?.file;
      content = typeof file?.content === "string" ? file.content : "";
      baseUpdatedAtMs =
        typeof file?.updatedAtMs === "number" ? file.updatedAtMs : null;
    } catch {
      return refuse("bridge_error");
    }
    if (content.length === 0) return refuse("empty_or_missing");
    if (!isCurationCandidate(content.length, budgetChars)) {
      return refuse("under_budget");
    }
    if (content.length > CURATION_ONE_SHOT_MAX_SOURCE_CHARS) {
      return refuse("too_large_for_one_shot");
    }
    const res = await ctx.runMutation(internal.agentFileCuration.dispatchCuration, {
      instanceName: args.instanceName,
      agentId: args.agentId,
      name: args.name,
      content,
      baseUpdatedAtMs,
      budgetChars,
      trigger: "manual" as const,
      feedback: args.feedback.length > 0 ? args.feedback : undefined,
      userId: args.userId,
    });
    if (!res.ok) return refuse(res.reason ?? "unknown");
    return null;
  },
});

/** Notification helper for the relaunch path (an internalAction has no ctx.db). */
export const notifyCurationEvent = internalMutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    body: v.string(),
    messageKey: v.optional(v.string()),
    params: v.optional(v.record(v.string(), v.string())),
    dedupeKey: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { userId, title, body, messageKey, params, dedupeKey },
  ): Promise<null> => {
    try {
      await notifyUser(ctx, {
        userId,
        kind: "curation",
        title,
        body,
        ...(messageKey ? { messageKey } : {}),
        ...(params ? { params } : {}),
        href: "/settings/agentFiles",
        ...(dedupeKey ? { dedupeKey } : {}),
      });
    } catch {
      // best-effort
    }
    return null;
  },
});

/** Revert an APPLYING claim back to PROPOSED after a transient bridge failure,
 *  so the proposal stays retryable (never stuck "applying"; codex P2). */
export const releaseApplyClaim = internalMutation({
  args: { curationId: v.id("agentFileCurations") },
  handler: async (ctx, { curationId }): Promise<null> => {
    const row = await ctx.db.get(curationId);
    if (row && row.status === "applying") {
      await ctx.db.patch(curationId, { status: "proposed", updatedAt: Date.now() });
    }
    return null;
  },
});

export const markResolved = internalMutation({
  args: {
    curationId: v.id("agentFileCurations"),
    status: v.union(v.literal("applied"), v.literal("failed")),
    failureReason: v.optional(v.string()),
  },
  handler: async (ctx, { curationId, status, failureReason }): Promise<null> => {
    const row = await ctx.db.get(curationId);
    if (!row) return null;
    // A TERMINAL status is never overwritten (codex P2): two concurrent approvals
    // — the first applies + marks "applied", the second 409s + would mark
    // "failed" — must not clobber the recorded apply. Only a live job resolves.
    if (row.status === "applied" || row.status === "rejected") return null;
    await ctx.db.patch(curationId, {
      status,
      ...(failureReason ? { failureReason } : {}),
      ...(status === "applied" ? { appliedRevisionAt: Date.now() } : {}),
      // PII hygiene: content copies are no longer needed once resolved (the
      // durable before/after is in agentFileRevisions on apply).
      beforeContent: undefined,
      proposedContent: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Transactional lock (codex P2): atomically flip a PROPOSED job to "applying"
 *  so a concurrent reject can't flip it to "rejected" while the bridge write is
 *  in flight (which would leave the file applied but the row rejected). Returns
 *  the claimed row's write inputs, or null when it was not proposed. */
export const claimForApply = internalMutation({
  args: { curationId: v.id("agentFileCurations") },
  handler: async (
    ctx,
    { curationId },
  ): Promise<{
    instanceName: string;
    agentId: string;
    name: string;
    proposedContent: string;
    baseUpdatedAtMs: number | null;
    beforeContent: string;
  } | null> => {
    const row = await ctx.db.get(curationId);
    if (!row || row.status !== "proposed") return null;
    const proposed = row.proposedContent;
    if (typeof proposed !== "string" || proposed.length === 0) return null;
    await ctx.db.patch(curationId, { status: "applying", updatedAt: Date.now() });
    return {
      instanceName: row.instanceName,
      agentId: row.agentId,
      name: row.name,
      proposedContent: proposed,
      baseUpdatedAtMs: row.baseUpdatedAtMs,
      beforeContent: row.beforeContent ?? "",
    };
  },
});

// ===========================================================================
// Dispatch-failure release (from bridge.dispatch)
// ===========================================================================

export const failCurationForChat = internalMutation({
  args: { chatId: v.id("chats"), reason: v.string() },
  handler: async (ctx, { chatId, reason }): Promise<null> => {
    const chat = await ctx.db.get(chatId);
    const job = chat?.pendingCurate;
    if (chat) await ctx.db.patch(chatId, { pendingCurate: undefined });
    if (job) {
      const row = await ctx.db.get(job.curationId);
      if (row && row.status === "dispatched") {
        await ctx.db.patch(job.curationId, {
          status: "failed" as const,
          failureReason: reason,
          beforeContent: undefined,
          proposedContent: undefined,
          updatedAt: Date.now(),
        });
        await notifyCurationOutcome(ctx, row, "failed", reason);
      }
    }
    if (chat) await cleanupCuratorChatRows(ctx, chatId);
    return null;
  },
});

// ===========================================================================
// PII hygiene: purge the hidden curator chat's messages + outbox
// ===========================================================================

/** Scheduled from correlate: purge the hidden curator chat's messages + outbox
 *  (copies of file content — PII hygiene). GUARD: skip if a NEW curation is in
 *  flight on this hidden chat (its rows are live), mirroring cleanupSummarizerChat. */
export const cleanupCuratorChat = internalMutation({
  args: { hiddenChatId: v.id("chats") },
  handler: async (ctx, { hiddenChatId }): Promise<null> => {
    const hidden = await ctx.db.get(hiddenChatId);
    if (!hidden || hidden.kind !== "curator") return null;
    if (hidden.pendingCurate) return null; // a fresh job locked it — its rows live
    await cleanupCuratorChatRows(ctx, hiddenChatId);
    return null;
  },
});

async function cleanupCuratorChatRows(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<void> {
  try {
    // Full cascade (messageParts + files + streams + sub-agent tables), not just
    // the messages: the curator chat holds copies of agent-file content (PII), so
    // it uses the SAME hygiene as the summarizer instead of leaving child rows
    // orphaned (codex P2).
    await cleanupHiddenChatContent(ctx, chatId);
  } catch {
    // best-effort cleanup — never wedge the correlate/fail path.
  }
}

// ===========================================================================
// Queries (admin UI)
// ===========================================================================

export const instanceCuration = internalQuery({
  args: { instanceName: v.string() },
  handler: async (
    ctx,
    { instanceName },
  ): Promise<{ enabled: boolean; budgetChars?: number }> => {
    const inst = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    return {
      enabled: inst?.config?.curationEnabled === true,
      budgetChars: inst?.config?.curationBudgetChars,
    };
  },
});

/** Effective curation settings for an instance (admin UI): whether the opt-in is
 *  on + the clamped budget, so the "Rationalize" button gates on the SAME budget/
 *  threshold the server enforces (not the fixed injection gauge — codex P2). */
export const curationSettings = query({
  args: { instanceName: v.string() },
  handler: async (
    ctx,
    { instanceName },
  ): Promise<{ enabled: boolean; budgetChars: number }> => {
    await requireAdmin(ctx);
    const inst = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    return {
      enabled: inst?.config?.curationEnabled === true,
      budgetChars: clampCurationBudget(inst?.config?.curationBudgetChars),
    };
  },
});

/** Recent curations for a target (agent), for the AgentFilesTab. Admin-only.
 *  Never returns the content copies — only the reviewable proposal's SIZE +
 *  status; the proposal body is fetched on demand (getProposal). */
export const listCurations = query({
  args: { instanceName: v.string(), agentId: v.string() },
  handler: async (ctx, { instanceName, agentId }) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("agentFileCurations")
      .withIndex("by_target_updated", (q) =>
        q.eq("instanceName", instanceName).eq("agentId", agentId),
      )
      .order("desc") // newest-first across ALL files (by updatedAt)
      .take(50);
    return rows.map((r) => ({
      _id: r._id,
      name: r.name,
      status: r.status,
      beforeSize: r.beforeSize,
      proposedSize: r.proposedSize ?? null,
      budgetChars: r.budgetChars,
      failureReason: r.failureReason ?? null,
      trigger: r.trigger,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  },
});

/** The proposed before/after for the review mini-diff (admin-only, on demand so
 *  the content is not shipped with the list). */
export const getProposal = query({
  args: { curationId: v.id("agentFileCurations") },
  handler: async (ctx, { curationId }) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(curationId);
    if (!row || row.status !== "proposed") return null;
    return {
      _id: row._id,
      name: row.name,
      beforeContent: row.beforeContent ?? "",
      proposedContent: row.proposedContent ?? "",
      beforeSize: row.beforeSize,
      proposedSize: row.proposedSize ?? 0,
      budgetChars: row.budgetChars,
      overBudget: row.failureReason === "over_budget",
      // The admin feedback THIS proposal was seeded with (relaunch context).
      feedback: row.feedback ?? null,
    };
  },
});
