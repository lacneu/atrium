// THE FILES TRANSCRIPT ROWS CARRY, COPIED ONCE (transcript redesign, final design §3.5,
// step 2 — projection `on` only).
//
// A stored row's file blocks (lib/transcriptContent.ts) each get one document here, keyed
// the way the Control UI identifies a file: a gateway-managed copy by (instance, session,
// artifactId) — a replay with the same idempotency key keeps the same artifact id upstream
// (src/gateway/internal-source-reply-persistence.test.ts:249 at v2026.9.33), so it is one
// copy —, any other reference by (row, block index). Never by name, path or content.
//
// The bridge copies the bytes (bridge/src/core/artifact-copier.ts) and reports here:
//   - `finalizeCopy`: `copied`, under the uniqueness guard — a copy that lost a race
//     releases its blob; the stored blob's own sha256 must equal what streamed;
//   - `noteCopyFailure`: `gone` (the gateway no longer has it), `refused` (it can never be
//     copied), or a transient failure — retried with a backoff, a bounded number of times,
//     then `refused` with `attempts_exhausted`. Never silently dropped.
// A `pending` file is handed back to the bridge by every read of its session (with a short
// lease, so two copies rarely start), and by the resume cron when nothing reads it.

import { v } from "convex/values";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { chatAllowsInstance } from "./lib/ingestAuthz";
import { blobReference, releaseBlob } from "./lib/blobs";
import { fileBlocksOf, type RowBlock, type RowFileBlock } from "./lib/transcriptContent";
import { deriveCopiedFileOnLiveBubble, syncBubbleRowParts } from "./lib/rowParts";
import { liveBubbleFor } from "./lib/projectedRuns";
import { segmentOfRow, steerSeqsOf } from "./lib/transcriptProjection";

/** Files one answer hands to the bridge (bridge transcript-shadow.ts `MAX_FILES_TO_COPY`). */
export const MAX_FILES_HANDED = 16;
/** A handed file is not handed again before this (the bridge's whole in-process retry,
 *  1 s + 5 s + 30 s, plus the transfer itself). */
export const COPY_LEASE_MS = 2 * 60_000;
/** The backoff after a failed in-process retry: 5 min, doubling, at most 6 h. */
const RESUME_BASE_MS = 5 * 60_000;
const RESUME_MAX_MS = 6 * 60 * 60_000;
/** Failed retry schedules before a file is declared `refused` (`attempts_exhausted`) —
 *  about a day of backoff: visible, never pending forever. */
export const MAX_COPY_ATTEMPTS = 10;
/** Files one row may record (a row keeps at most MAX_ROW_BLOCKS blocks). */
const MAX_FILES_PER_ROW = 64;

/** The closed vocabulary of reasons a file is `gone` / `refused` / retried. */
const REASONS: ReadonlySet<string> = new Set([
  "artifact_not_found",
  "not_found",
  "file-not-found",
  "unsupported-format",
  "delivery-failed",
  "too_large",
  "media_disabled",
  "download_unsupported",
  "remote_source",
  "unsupported_source",
  "omitted",
  "path_escape",
  "symlink_rejected",
  "not_a_file",
  "invalid_filename",
  "not_in_this_mount",
  "route_absent",
  "attempts_exhausted",
]);
const reasonOf = (r: string): string => (REASONS.has(r) ? r : "other");

export type FileToCopy = {
  fileId: Id<"transcriptFiles">;
  sessionKey: string;
  artifactId?: string;
  mediaSource?: string;
  kind: string;
  mimeType?: string;
  sizeBytes?: number;
  label?: string;
  attempts: number;
};

/** The first state of a file block: what can be copied waits for it; what never can is
 *  stated at once. */
function initialState(b: RowFileBlock): { state: Doc<"transcriptFiles">["state"]; reason?: string } {
  if (b.errorCode === "file-not-found") return { state: "gone", reason: "file-not-found" };
  if (b.errorCode !== undefined) return { state: "refused", reason: b.errorCode };
  if (b.omitted === true) return { state: "refused", reason: "omitted" };
  if (b.artifactId !== undefined || b.mediaSource !== undefined) return { state: "pending" };
  if (b.remote === true) return { state: "refused", reason: "remote_source" };
  return { state: "refused", reason: "unsupported_source" };
}

/**
 * Record the files of rows whose content was just stored (projection `on`): one document
 * per file block, idempotent — a managed file already recorded for this session (a replay,
 * the same artifact on another row) and a block already recorded for this row are left as
 * they are. Returns how many were inserted. Charged to the caller's query budget.
 */
export async function recordRowFiles(
  ctx: MutationCtx,
  a: { chatId: Id<"chats">; instanceName: string; sessionKey: string; now: number },
  rows: ReadonlyArray<{ entryId: string; blocks?: readonly RowBlock[] }>,
  budget: { queries: number },
): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    for (const { index, block } of fileBlocksOf(row.blocks).slice(0, MAX_FILES_PER_ROW)) {
      // A remote reference is not a copy: the row shows it as is (no record, no download).
      if (block.remote === true && block.url !== undefined) continue;
      budget.queries++;
      const known =
        block.artifactId !== undefined
          ? await ctx.db
              .query("transcriptFiles")
              .withIndex("by_instance_session_artifact", (q) =>
                q
                  .eq("instanceName", a.instanceName)
                  .eq("sessionKey", a.sessionKey)
                  .eq("artifactId", block.artifactId)
                  .eq("chatId", a.chatId),
              )
              .first()
          : await ctx.db
              .query("transcriptFiles")
              .withIndex("by_chat_entry", (q) =>
                q.eq("chatId", a.chatId).eq("entryId", row.entryId).eq("blockIndex", index),
              )
              .first();
      if (known !== null) continue;
      const first = initialState(block);
      await ctx.db.insert("transcriptFiles", {
        chatId: a.chatId,
        instanceName: a.instanceName,
        sessionKey: a.sessionKey,
        entryId: row.entryId,
        blockIndex: index,
        ...(block.artifactId !== undefined ? { artifactId: block.artifactId } : {}),
        ...(block.mediaSource !== undefined ? { mediaSource: block.mediaSource } : {}),
        kind: block.kind,
        ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
        ...(block.sizeBytes !== undefined ? { sizeBytes: block.sizeBytes } : {}),
        ...(block.label !== undefined ? { label: block.label } : {}),
        state: first.state,
        ...(first.reason !== undefined ? { reason: first.reason } : {}),
        attempts: 0,
        ...(first.state === "pending" ? { nextAttemptAt: a.now } : {}),
        updatedAt: a.now,
      });
      inserted++;
    }
  }
  return inserted;
}

const toCopy = (f: Doc<"transcriptFiles">): FileToCopy => ({
  fileId: f._id,
  sessionKey: f.sessionKey,
  ...(f.artifactId !== undefined ? { artifactId: f.artifactId } : {}),
  ...(f.mediaSource !== undefined ? { mediaSource: f.mediaSource } : {}),
  kind: f.kind,
  ...(f.mimeType !== undefined ? { mimeType: f.mimeType } : {}),
  ...(f.sizeBytes !== undefined ? { sizeBytes: f.sizeBytes } : {}),
  ...(f.label !== undefined ? { label: f.label } : {}),
  attempts: f.attempts,
});

/**
 * The session's files due for a copy, LEASED to the caller (not handed again for
 * COPY_LEASE_MS): every read of the session hands them back, so a bridge that restarted, or
 * whose copy failed, picks them up at the next read — never later than the resume cron.
 */
export async function leaseFilesToCopy(
  ctx: MutationCtx,
  a: { chatId: Id<"chats">; sessionKey: string; now: number },
): Promise<FileToCopy[]> {
  const due = await ctx.db
    .query("transcriptFiles")
    .withIndex("by_chat_session_state", (q) =>
      q.eq("chatId", a.chatId).eq("sessionKey", a.sessionKey).eq("state", "pending").lte("nextAttemptAt", a.now),
    )
    .take(MAX_FILES_HANDED);
  for (const f of due) await ctx.db.patch(f._id, { nextAttemptAt: a.now + COPY_LEASE_MS });
  return due.map(toCopy);
}

/** hex → base64 (the `_storage.sha256` encoding). */
function hexToBase64(hex: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  let bin = "";
  for (let i = 0; i < 64; i += 2) bin += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

/** The file a bridge reports about — when it is that bridge's to report. */
async function ownedFile(
  ctx: MutationCtx,
  fileId: string,
  boundInstanceName: string,
): Promise<Doc<"transcriptFiles"> | null> {
  const id = ctx.db.normalizeId("transcriptFiles", fileId);
  if (id === null) return null;
  const file = await ctx.db.get(id);
  if (file === null) return null;
  // The cross-gateway write barrier, atomic with the write (lib/ingestAuthz).
  if (file.instanceName !== boundInstanceName || !(await chatAllowsInstance(ctx, file.chatId, boundInstanceName))) {
    throw new Error("forbidden: cross-instance transcript file");
  }
  return file;
}

/**
 * A blob a copy report did not keep: deleted only when NOTHING references it
 * (lib/blobs.ts `blobReference`, the one list of holders — the transcript file that already
 * holds it included, and any upload registration whatever its age). A report can name a blob
 * that is in use — a retransmitted report names the very blob its first delivery finalized
 * (codex review 16) — and deleting it would break every row that shows it.
 */
async function discardUnheldBlob(ctx: MutationCtx, storageId: Id<"_storage">): Promise<void> {
  if ((await ctx.db.system.get("_storage", storageId)) === null) return;
  if ((await blobReference(ctx, storageId, { countUploads: true })) !== null) return;
  await ctx.storage.delete(storageId);
}

/**
 * The bridge copied a file's bytes into `storageId`. Finalized `copied` only when the blob
 * is what streamed (its own size and sha256) and no copy finalized first. A REPLAY of the
 * report that finalized it (same file, same blob: an HTTP retransmission) gets the same
 * answer and changes nothing. Any other blob a report does not keep — the loser of two
 * concurrent copies, a checksum mismatch — is deleted only when nothing holds it.
 */
export const finalizeCopy = internalMutation({
  args: {
    boundInstanceName: v.string(),
    fileId: v.string(),
    storageId: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    mimeType: v.string(),
  },
  handler: async (ctx, args) => {
    const storageId = ctx.db.system.normalizeId("_storage", args.storageId);
    if (storageId === null) return { ok: false as const, reason: "bad_storage_id" };
    const file = await ownedFile(ctx, args.fileId, args.boundInstanceName);
    if (file !== null && file.state === "copied" && file.storageId === storageId) {
      // The report that finalized this copy, delivered again: the same answer, nothing done.
      return { ok: true as const, state: "copied" as const, duplicate: false };
    }
    const meta = await ctx.db.system.get("_storage", storageId);
    if (file === null || file.state !== "pending") {
      // The chat was purged, or another copy (or a verdict) came first: the loser of the
      // race discards its blob — when nothing holds it.
      await discardUnheldBlob(ctx, storageId);
      return { ok: true as const, state: file?.state ?? "deleted", duplicate: true };
    }
    const expected = hexToBase64(args.sha256);
    if (meta === null || expected === null || meta.sha256 !== expected || meta.size !== args.sizeBytes) {
      await discardUnheldBlob(ctx, storageId);
      return { ok: false as const, reason: "checksum_mismatch" };
    }
    await ctx.db.patch(file._id, {
      state: "copied",
      storageId,
      sha256: args.sha256,
      sizeBytes: args.sizeBytes,
      ...(file.mimeType === undefined && args.mimeType !== "" ? { mimeType: args.mimeType.slice(0, 128) } : {}),
      reason: undefined,
      nextAttemptAt: undefined,
      updatedAt: Date.now(),
    });
    // Final design step 3: the bubble of the row that carries it shows it now.
    const row = await ctx.db
      .query("transcriptRows")
      .withIndex("by_chat_session_entry", (q) =>
        q.eq("chatId", file.chatId).eq("sessionKey", file.sessionKey).eq("entryId", file.entryId),
      )
      .first();
    if (row?.messageId !== undefined) {
      await syncBubbleRowParts(ctx, row.messageId);
    } else if (row !== null && row.runId !== undefined) {
      // …and while its run is still live, its live bubble shows it at once (the Control
      // UI shows a row's file as soon as the row exists).
      const cuts = await steerSeqsOf(ctx, file.chatId, file.sessionKey, row.runId);
      const live = await liveBubbleFor(ctx, file.chatId, row.runId, segmentOfRow(row.seq, cuts) ?? 0, {
        instanceName: file.instanceName,
        sessionKey: file.sessionKey,
      });
      const copied = await ctx.db.get(file._id);
      if (live !== null && copied !== null) await deriveCopiedFileOnLiveBubble(ctx, live, copied);
    }
    return { ok: true as const, state: "copied" as const, duplicate: false };
  },
});

/** The bridge could not copy a file: a verdict (`gone`, `refused`) or a transient failure
 *  (`retry`: the backoff, then `refused` after MAX_COPY_ATTEMPTS). A file no longer
 *  `pending` is left as it is. */
export const noteCopyFailure = internalMutation({
  args: {
    boundInstanceName: v.string(),
    fileId: v.string(),
    outcome: v.union(v.literal("gone"), v.literal("refused"), v.literal("retry")),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const file = await ownedFile(ctx, args.fileId, args.boundInstanceName);
    if (file === null || file.state !== "pending") return { ok: true as const, state: file?.state ?? "deleted" };
    const now = Date.now();
    if (args.outcome !== "retry") {
      await ctx.db.patch(file._id, {
        state: args.outcome,
        reason: reasonOf(args.reason),
        nextAttemptAt: undefined,
        updatedAt: now,
      });
      return { ok: true as const, state: args.outcome };
    }
    const attempts = file.attempts + 1;
    if (attempts >= MAX_COPY_ATTEMPTS) {
      await ctx.db.patch(file._id, {
        state: "refused",
        reason: "attempts_exhausted",
        attempts,
        nextAttemptAt: undefined,
        updatedAt: now,
      });
      return { ok: true as const, state: "refused" as const };
    }
    const backoff = Math.min(RESUME_MAX_MS, RESUME_BASE_MS * 2 ** (attempts - 1));
    await ctx.db.patch(file._id, { attempts, reason: reasonOf(args.reason), nextAttemptAt: now + backoff, updatedAt: now });
    return { ok: true as const, state: "pending" as const };
  },
});

/** Instances the resume cron visits per run. */
const RESUME_INSTANCES = 64;

/**
 * The cron's lease: for EACH instance, its pending files due now, most overdue first, at
 * most MAX_FILES_HANDED, each leased like a read leases them.
 *
 * Selected by due time through an index, per instance (codex review 17): the oldest 100
 * pending files of the whole deployment, filtered afterwards, were the same 100 on every
 * run when one instance was unreachable — its lease did not move them — and a healthy
 * instance's due file behind them was never offered.
 */
export const leaseDueForResume = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const out: Array<{ instanceName: string; files: FileToCopy[] }> = [];
    const instances = await ctx.db.query("instances").take(RESUME_INSTANCES);
    const names = [...new Set(instances.map((i) => i.name))];
    for (const instanceName of names) {
      const due = await ctx.db
        .query("transcriptFiles")
        .withIndex("by_instance_state_next", (q) =>
          q.eq("instanceName", instanceName).eq("state", "pending").gte("nextAttemptAt", 0).lte("nextAttemptAt", now),
        )
        .take(MAX_FILES_HANDED);
      if (due.length === 0) continue;
      for (const f of due) await ctx.db.patch(f._id, { nextAttemptAt: now + COPY_LEASE_MS });
      out.push({ instanceName, files: due.map(toCopy) });
    }
    return out;
  },
});

/**
 * THE RESUME CRON: the pending files nobody's read handed over (a session nobody opens
 * again after the bridge restarted, a copy that failed its in-process retries) are sent to
 * their instance's bridge (`/transcript-files/copy`), which copies them over a short
 * operator connection. A bridge that is unreachable leaves them `pending` (their lease
 * lapses and the next run tries again).
 */
export const resumePending = internalAction({
  args: {},
  handler: async (ctx) => {
    const groups: Array<{ instanceName: string; files: FileToCopy[] }> = await ctx.runMutation(
      internal.transcriptFiles.leaseDueForResume,
      {},
    );
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (groups.length === 0 || !sharedSecret) return { instances: 0 };
    let sent = 0;
    for (const g of groups) {
      const perInstance: string | null = await ctx.runQuery(internal.agentFiles.bridgeUrlForInstance, {
        instanceName: g.instanceName,
      });
      const bridgeUrl = perInstance ?? process.env.BRIDGE_URL ?? null;
      if (!bridgeUrl) continue;
      try {
        const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/transcript-files/copy`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: sharedSecret },
          body: JSON.stringify({ instanceName: g.instanceName, files: g.files }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) sent++;
        await res.body?.cancel().catch(() => {});
      } catch {
        // Unreachable: the lease lapses, the next run hands them again.
      }
    }
    return { instances: sent };
  },
});

/** Files one purge step deletes (each may release its blob: a few reads). */
export const FILE_PURGE_BATCH = 50;

/** Delete a purged chat's file records and release their blobs (lib/blobs: a blob goes only
 *  when nothing else holds it). Returns whether more remain. */
export async function purgeChatFiles(ctx: MutationCtx, chatId: Id<"chats">): Promise<boolean> {
  const files = await ctx.db
    .query("transcriptFiles")
    .withIndex("by_chat_entry", (q) => q.eq("chatId", chatId))
    .take(FILE_PURGE_BATCH);
  for (const f of files) {
    await ctx.db.delete(f._id);
    if (f.storageId !== undefined) await releaseBlob(ctx, f.storageId, { reason: "transcript_file_purged" });
  }
  return files.length === FILE_PURGE_BATCH;
}

/** Delete the file records one row carries and release their blobs — a bubble a person
 *  deleted takes the files its rows showed with it (final design step 3). */
export async function purgeRowFiles(ctx: MutationCtx, row: { chatId: Id<"chats">; entryId: string }): Promise<number> {
  const files = await ctx.db
    .query("transcriptFiles")
    .withIndex("by_chat_entry", (q) => q.eq("chatId", row.chatId).eq("entryId", row.entryId))
    .take(64);
  for (const f of files) {
    await ctx.db.delete(f._id);
    if (f.storageId !== undefined) await releaseBlob(ctx, f.storageId, { reason: "transcript_file_purged" });
  }
  return files.length;
}
