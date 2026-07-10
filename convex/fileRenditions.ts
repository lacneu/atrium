// Document RENDITIONS (Release B of the right-column viewer): an Office file
// (pptx/docx/xlsx…) an agent or user put in a chat is rendered to a faithful PDF
// by the INSTANCE-DESIGNATED converter agent (its own gateway skills do the
// conversion — Atrium embeds none), so the viewer shows it with the same pdf.js
// path as a native PDF.
//
// Mirrors the proven hidden-chat utility pattern (documentary/curator/summarizer):
//   requestRendition (viewer click)
//     -> authorize (the source storageId must be a `files` row the caller owns)
//     -> idempotent `pending` row keyed by sourceStorageId (the cache key)
//     -> hidden kind:"converter" chat + a user turn carrying the SOURCE FILE as an
//        ATTACHMENT (rides the existing dispatch → OpenClaw + Hermes both) + the
//        conversion prompt
//     -> dispatch
//   correlateConversion  [stream.finalize, kind:"converter"]
//     -> the delivered PDF part becomes the rendition (ready); no PDF -> failed
//   getRendition (viewer reactive read, IDOR-guarded) -> status + pdf URL
//
// Instance-level designation (NOT per-user grants): resolveConverterTarget reads
// the instance config; the admin's choice IS the authorization. Content never
// crosses instances (the file's own instance converts it, like curator).

import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireActive } from "./lib/access";
import { resolveConverterTarget } from "./agents";
import { contentLocaleForInstance } from "./lib/serverLocale";
import { isChatBusy } from "./lib/outboxQueue";

// ===========================================================================
// Pure policy (exported for unit tests)
// ===========================================================================

/** Office mimeTypes that need conversion to be previewed. */
const CONVERTIBLE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.ms-powerpoint", // ppt
  "application/msword", // doc
  "application/vnd.ms-excel", // xls
  "application/vnd.oasis.opendocument.text", // odt
  "application/vnd.oasis.opendocument.presentation", // odp
  "application/vnd.oasis.opendocument.spreadsheet", // ods
  "application/rtf",
]);
const CONVERTIBLE_EXTENSIONS = new Set([
  "pptx", "ppt", "docx", "doc", "xlsx", "xls", "odt", "odp", "ods", "rtf",
]);

function extOf(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const i = filename.lastIndexOf(".");
  if (i <= 0 || i === filename.length - 1) return null;
  return filename.slice(i + 1).toLowerCase();
}

/** Is this file a convertible Office document (mime OR extension)? The viewer
 *  offers "render as PDF" only for these; a native PDF/image/text never converts. */
export function isConvertibleDocument(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  if (CONVERTIBLE_MIMES.has(mime)) return true;
  const ext = extOf(filename);
  return ext !== null && CONVERTIBLE_EXTENSIONS.has(ext);
}

/** Does a delivered part look like the produced PDF? (mime OR .pdf extension —
 *  agent deliveries sometimes ship application/octet-stream.) */
export function isPdfPart(part: {
  mimeType?: string | null;
  filename?: string | null;
}): boolean {
  const mime = (part.mimeType ?? "").toLowerCase();
  if (mime === "application/pdf") return true;
  return extOf(part.filename) === "pdf";
}

/** Pick the delivered PDF from a converter turn's parts: the FIRST file/media
 *  part that is a PDF. Pure so the correlation rule is unit-testable. */
export function pickDeliveredPdf<
  T extends { kind: string; mimeType?: string | null; filename?: string | null; storageId?: unknown },
>(parts: T[]): T | null {
  for (const p of parts) {
    if ((p.kind === "media" || p.kind === "file") && p.storageId && isPdfPart(p)) {
      return p;
    }
  }
  return null;
}

/** How long a `pending` rendition may sit before the watchdog fails it. */
export const RENDITION_TIMEOUT_MS = 5 * 60 * 1000;

const CONVERSION_PROMPT: Record<string, string> = {
  fr:
    "Convertis en PDF le fichier joint, en préservant fidèlement la mise en page, " +
    "les polices et les visuels. Ne renvoie QUE le fichier PDF résultant, sans " +
    "commentaire.",
  en:
    "Convert the attached file to PDF, faithfully preserving its layout, fonts and " +
    "visuals. Return ONLY the resulting PDF file, with no commentary.",
};

/** The conversion briefing (localized to the instance content language). */
export function buildConversionPrompt(locale: string): string {
  return CONVERSION_PROMPT[locale] ?? CONVERSION_PROMPT.en!;
}

// ===========================================================================
// Authorization + hidden-chat plumbing
// ===========================================================================

/** The `files` row for a storage blob the CALLER owns, or null. The trust
 *  boundary for both the trigger and the read: a rendition may only be requested
 *  or served for a file the caller actually owns (never an arbitrary storageId). */
async function ownedFile(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  storageId: Id<"_storage">,
): Promise<Doc<"files"> | null> {
  const rows = await ctx.db
    .query("files")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .collect();
  // A storageId is unique per upload, but be defensive: only a row owned by the
  // caller authorizes. (Outbound agent files are owned by the chat's user too.)
  return rows.find((r) => r.userId === userId) ?? null;
}

/** Find (or lazily create) the user's HIDDEN converter chat, bound to `target`. */
async function ensureConverterChat(
  ctx: MutationCtx,
  userId: Id<"users">,
  target: { instanceName: string; agentId: string },
  now: number,
): Promise<Doc<"chats">> {
  const existing = await ctx.db
    .query("chats")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .filter((q) => q.eq(q.field("kind"), "converter"))
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
    kind: "converter" as const,
    title: "Conversions",
    instanceName: target.instanceName,
    agentId: target.agentId,
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}

// ===========================================================================
// Public API
// ===========================================================================

export type RenditionView =
  | { status: "unconfigured" }
  | { status: "pending" }
  | { status: "ready"; pdfUrl: string; filename: string }
  | { status: "failed"; reason: string };

/** Reactive read for the viewer: the rendition state for a source file (by its
 *  storageId), IDOR-guarded to the caller-owned source. `unconfigured` = no
 *  converter designated on the instance (the viewer shows the download fallback,
 *  no error). */
export const getRendition = query({
  args: { sourceStorageId: v.id("_storage") },
  handler: async (ctx, { sourceStorageId }): Promise<RenditionView> => {
    const { userId } = await requireActive(ctx);
    const file = await ownedFile(ctx, userId, sourceStorageId);
    if (file === null) return { status: "unconfigured" }; // not the caller's file
    const row = await ctx.db
      .query("fileRenditions")
      .withIndex("by_source", (q) => q.eq("sourceStorageId", sourceStorageId))
      .first();
    if (row === null) {
      // No rendition yet: report whether conversion is even possible so the
      // viewer shows "render as PDF" vs the plain download fallback. `pending`
      // here means "convertible + a converter is configured" — the viewer
      // triggers requestRendition on it; it does NOT mean a job is in flight.
      const target = await resolveConverterTarget(
        ctx,
        await instanceOfChat(ctx, file.chatId),
      );
      return target === null ? { status: "unconfigured" } : { status: "pending" };
    }
    if (row.status === "ready" && row.pdfStorageId) {
      const url = await ctx.storage.getUrl(row.pdfStorageId);
      if (url) return { status: "ready", pdfUrl: url, filename: row.sourceFilename };
      return { status: "failed", reason: "storage_gone" };
    }
    if (row.status === "failed") {
      return { status: "failed", reason: row.failureReason ?? "conversion_failed" };
    }
    return { status: "pending" };
  },
});

/** The instance a chat runs on (converter resolution is per the FILE's instance). */
async function instanceOfChat(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
): Promise<string> {
  const chat = await ctx.db.get(chatId);
  return chat?.instanceName ?? "";
}

/** Trigger a conversion (from the viewer). Idempotent: a pending/ready row is
 *  returned as-is; a failed row is retried. Authorization: the source file must
 *  be a `files` row the caller owns. */
export const requestRendition = mutation({
  args: { sourceStorageId: v.id("_storage") },
  handler: async (ctx, { sourceStorageId }): Promise<RenditionView> => {
    const { userId } = await requireActive(ctx);
    const now = Date.now();

    const file = await ownedFile(ctx, userId, sourceStorageId);
    if (file === null) throw new ConvexError("forbidden");
    if (!isConvertibleDocument(file.mimeType, file.filename)) {
      throw new ConvexError("not_convertible");
    }

    // Idempotency: the row IS the guard (turnRetry pattern). A concurrent second
    // click sees pending/ready and no-ops.
    const existing = await ctx.db
      .query("fileRenditions")
      .withIndex("by_source", (q) => q.eq("sourceStorageId", sourceStorageId))
      .first();
    if (existing && existing.status !== "failed") {
      return existing.status === "ready" && existing.pdfStorageId
        ? {
            status: "ready",
            pdfUrl: (await ctx.storage.getUrl(existing.pdfStorageId)) ?? "",
            filename: existing.sourceFilename,
          }
        : { status: "pending" };
    }

    const instanceName = await instanceOfChat(ctx, file.chatId);
    const target = await resolveConverterTarget(ctx, instanceName);
    if (target === null) return { status: "unconfigured" };

    // Create/reset the pending row (the cache key) BEFORE dispatch.
    let renditionId: Id<"fileRenditions">;
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "pending" as const,
        failureReason: undefined,
        pdfStorageId: undefined,
        converterInstance: target.instanceName,
        converterAgentId: target.agentId,
        updatedAt: now,
      });
      renditionId = existing._id;
    } else {
      renditionId = await ctx.db.insert("fileRenditions", {
        sourceStorageId,
        chatId: file.chatId,
        userId,
        sourceFilename: file.filename,
        sourceMimeType: file.mimeType,
        status: "pending" as const,
        converterInstance: target.instanceName,
        converterAgentId: target.agentId,
        createdAt: now,
        updatedAt: now,
      });
    }

    const hidden = await ensureConverterChat(ctx, userId, target, now);
    // Serialize: one conversion per hidden chat at a time (mirrors documentary).
    // If the chat is BUSY, the pending row stays queued — drainNextRendition
    // (called when the current conversion settles) picks it up, so opening
    // several files converts them one-by-one instead of timing all-but-one out.
    if (!hidden.pendingConvert && !(await isChatBusy(ctx, hidden._id))) {
      await dispatchRenditionTurn(ctx, hidden, {
        renditionId,
        sourceStorageId,
        filename: file.filename,
        mimeType: file.mimeType,
      });
    }
    return { status: "pending" };
  },
});

/** Build + dispatch ONE conversion turn on the hidden chat: a user message whose
 *  attachment is the source file, under a fresh per-job gateway session. Shared
 *  by the trigger (when the chat is idle) and the queue drain. Assumes the chat
 *  is idle (caller checked). */
async function dispatchRenditionTurn(
  ctx: MutationCtx,
  hidden: Doc<"chats">,
  job: {
    renditionId: Id<"fileRenditions">;
    sourceStorageId: Id<"_storage">;
    filename: string;
    mimeType: string;
  },
): Promise<void> {
  const now = Date.now();
  const instance = await ctx.db
    .query("instances")
    .withIndex("by_name", (q) => q.eq("name", hidden.instanceName!))
    .first();
  const locale = await contentLocaleForInstance(ctx, instance?.config);
  const prompt = buildConversionPrompt(locale);
  const msgId = await ctx.db.insert("messages", {
    chatId: hidden._id,
    userId: hidden.userId,
    role: "user" as const,
    status: "complete" as const,
    text: prompt,
    updatedAt: now,
  });
  await ctx.db.patch(hidden._id, {
    // A per-job unique openclawChatId → the bridge builds a FRESH gateway session
    // (no cross-job contamination), same as documentary/curator.
    pendingConvert: { renditionId: job.renditionId, createdAt: now },
    openclawChatId: `convert:${job.renditionId}:${now}`,
    updatedAt: now,
  });
  const outboxId = await ctx.db.insert("outbox", {
    chatId: hidden._id,
    userId: hidden.userId,
    clientMessageId: `convert-${job.renditionId}-${now}`,
    messageId: msgId,
    text: prompt,
    // The source file rides the turn as an ATTACHMENT — the dispatch resolves it
    // to base64 (inline) or a shared-fs reference (both providers).
    attachmentIds: [job.sourceStorageId],
    attachments: [
      {
        storageId: job.sourceStorageId,
        filename: job.filename,
        mimeType: job.mimeType,
      },
    ],
    status: "pending" as const,
  });
  await ctx.scheduler.runAfter(0, internal.bridge.dispatch, { outboxId });
}

/** Dispatch the user's OLDEST still-pending rendition IF their converter chat is
 *  now idle. Called when a conversion settles (correlate/fail) so a queue of
 *  Office files opened together converts one-by-one. No-op when nothing is
 *  waiting or the chat is still busy. */
async function drainNextRendition(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const hidden = await ctx.db
    .query("chats")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .filter((q) => q.eq(q.field("kind"), "converter"))
    .first();
  if (!hidden || hidden.pendingConvert) return; // gone, or a job is in flight
  if (await isChatBusy(ctx, hidden._id)) return;
  // Oldest pending rendition for this user (by_user_status; _creationTime order).
  const next = await ctx.db
    .query("fileRenditions")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "pending"),
    )
    .order("asc")
    .first();
  if (!next) return;
  // The designated converter may have changed since this row was queued — re-bind
  // the hidden chat to the row's recorded converter (same instance; content never
  // crosses instances).
  await ctx.db.patch(hidden._id, {
    instanceName: next.converterInstance,
    agentId: next.converterAgentId,
  });
  const rebound = (await ctx.db.get(hidden._id))!;
  await dispatchRenditionTurn(ctx, rebound, {
    renditionId: next._id,
    sourceStorageId: next.sourceStorageId,
    filename: next.sourceFilename,
    mimeType: next.sourceMimeType,
  });
}

// ===========================================================================
// Correlate (from stream.finalize on a kind:"converter" chat)
// ===========================================================================

/** Called from stream.finalize when a `kind:"converter"` chat's assistant message
 *  finalizes: the delivered PDF becomes the rendition (ready); no PDF -> failed.
 *  Best-effort (a correlation failure must never abort the turn lifecycle). */
export async function correlateConversion(
  ctx: MutationCtx,
  hiddenChat: Doc<"chats">,
  assistantMessage: Doc<"messages">,
): Promise<void> {
  const pending = hiddenChat.pendingConvert;
  if (!pending) return;
  const rendition = await ctx.db.get(pending.renditionId);
  const now = Date.now();
  // Clear the lock first (even if the rendition row is gone) so the hidden chat
  // is never wedged.
  await ctx.db.patch(hiddenChat._id, { pendingConvert: undefined });
  if (rendition === null || rendition.status !== "pending") return;

  const parts = await ctx.db
    .query("messageParts")
    .withIndex("by_message", (q) => q.eq("messageId", assistantMessage._id))
    .collect();
  const pdf = pickDeliveredPdf(
    parts.map((p) => p.part as { kind: string; mimeType?: string; filename?: string; storageId?: Id<"_storage"> }),
  );
  if (pdf && pdf.storageId) {
    await ctx.db.patch(rendition._id, {
      status: "ready" as const,
      pdfStorageId: pdf.storageId,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(rendition._id, {
      status: "failed" as const,
      failureReason: "no_pdf_delivered",
      updatedAt: now,
    });
  }
  // The chat is idle again → convert the next queued Office file (if any).
  await drainNextRendition(ctx, hiddenChat.userId);
}

/** Cron: fail `pending` renditions older than the timeout so the viewer's spinner
 *  is always bounded — covers the gap where the dispatch was accepted but the
 *  gateway never streamed/finalized (no stale stream row for the watchdog to
 *  catch). Also clears any hidden-chat lock still pointing at the timed-out row.
 *  Bounded scan; self-reschedules on a full batch. */
export const timeoutStaleRenditions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RENDITION_TIMEOUT_MS;
    const BATCH = 50;
    const stale = await ctx.db
      .query("fileRenditions")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(BATCH);
    let failed = 0;
    for (const r of stale) {
      if (r.createdAt >= cutoff) continue; // still within the grace window
      await ctx.db.patch(r._id, {
        status: "failed" as const,
        failureReason: "timeout",
        updatedAt: Date.now(),
      });
      failed++;
      // Clear a converter chat still locked on THIS rendition (defensive; the
      // stuck-stream watchdog usually clears it first).
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_user", (q) => q.eq("userId", r.userId))
        .filter((q) => q.eq(q.field("kind"), "converter"))
        .first();
      if (chat?.pendingConvert?.renditionId === r._id) {
        await ctx.db.patch(chat._id, { pendingConvert: undefined });
        // Freed the lock → let the user's next queued file convert.
        await drainNextRendition(ctx, r.userId);
      }
    }
    if (stale.length === BATCH) {
      await ctx.scheduler.runAfter(0, internal.fileRenditions.timeoutStaleRenditions, {});
    }
    return { failed };
  },
});

/** Fail the in-flight rendition of a converter chat + clear its lock (dispatch
 *  failure, or the stuck-stream watchdog). Mirrors failCurationForChat. */
export const failRenditionForChat = internalMutation({
  args: {
    chatId: v.id("chats"),
    reason: v.string(),
  },
  handler: async (ctx, { chatId, reason }) => {
    const chat = await ctx.db.get(chatId);
    if (!chat || chat.kind !== "converter") return;
    const pending = chat.pendingConvert;
    await ctx.db.patch(chatId, { pendingConvert: undefined });
    if (pending) {
      const rendition = await ctx.db.get(pending.renditionId);
      if (rendition && rendition.status === "pending") {
        await ctx.db.patch(rendition._id, {
          status: "failed" as const,
          failureReason: reason,
          updatedAt: Date.now(),
        });
      }
    }
    // The chat is idle again → convert the next queued Office file (if any).
    await drainNextRendition(ctx, chat.userId);
  },
});
