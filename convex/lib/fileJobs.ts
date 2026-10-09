// FILE JOBS WAITING FOR THEIR UPLOADS (transcript projection `on`, phase 4 — codex
// passes 22–23). A service job that judges delivered files (a conversion, a documentary
// fetch) whose answer the transcript settled must not be judged — nor its hidden chat
// cleaned up — while the run's upload is in flight (`messages.uploadsInFlightUntil`,
// stream.noteUploadStarted). Every path that can fail or clean up such a job honours it,
// under ONE overall bound. Nothing here is read for a conversation that never stored
// transcript text: the marker exists only there.

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** One upload's window as the bridge announces it, capped (the bridge's per-upload
 *  timeout plus its part write, bridge/src/convex-writer.ts UPLOAD_MARKER_WINDOW_MS). */
export const UPLOAD_MARKER_MAX_MS = 10 * 60_000;

/** The whole wait for uploads in flight: four successive files at the full per-upload
 *  window. Past it the job is settled with what arrived — a bridge that keeps announcing
 *  uploads can never hold it forever. */
export const FILE_JOB_MAX_DEFER_MS = 4 * UPLOAD_MARKER_MAX_MS;

/** Is an upload in flight into an answer of this (hidden) service chat? Bounded read. */
export async function uploadInFlightIn(ctx: QueryCtx, chatId: Id<"chats">, now: number): Promise<boolean> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .order("desc")
    .take(8);
  return recent.some((m) => m.role === "assistant" && (m.uploadsInFlightUntil ?? 0) > now);
}
