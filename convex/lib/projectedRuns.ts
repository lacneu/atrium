// Where a run of a projected session already WROTE (redesign phase 4). Kept apart from
// lib/bubbleProjectionStore.ts so stream.ts can ask it without importing the store
// (which itself calls into stream.ts's finalize core).

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Who may own a bubble a projection reads or writes: the instance whose bridge reads
 *  the session, and that session. A bubble stamped for another instance or another session
 *  key is never the run's — whatever runId it carries (codex phase 4 pass 1: a runId one
 *  instance publishes can name another instance's bubble in a multi-instance chat). */
export type BubbleScope = { instanceName?: string; sessionKey?: string };

/** The bubble belongs to `scope` (an unstamped field names nobody, so it does not refuse). */
export function bubbleInScope(
  m: { boundInstance?: string; turnSessionKey?: string },
  scope: BubbleScope,
): boolean {
  if (scope.instanceName !== undefined && m.boundInstance !== undefined && m.boundInstance !== scope.instanceName) {
    return false;
  }
  if (scope.sessionKey !== undefined && m.turnSessionKey !== undefined && m.turnSessionKey !== scope.sessionKey) {
    return false;
  }
  return true;
}

/** The bubble the live overlay opened for segment k of a run, IN SCOPE: k = 0 — where the
 *  run wrote (`runBubbles`: a delivery merged into a parent, or an adopted run whose id a
 *  merge rotated away), else the run's own bubble; k > 0 — the steer segment. */
export async function liveBubbleFor(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  runId: string,
  segment: number,
  scope: BubbleScope = {},
): Promise<Id<"messages"> | null> {
  if (segment === 0) {
    const recorded = await ctx.db
      .query("runBubbles")
      .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
      .take(4);
    for (const r of recorded) {
      const m = await ctx.db.get(r.messageId);
      if (m !== null && m.chatId === chatId && bubbleInScope(m, scope) && !laterLinkedSegment(m, runId)) return r.messageId;
    }
  }
  const own = (
    await ctx.db
      .query("messages")
      .withIndex("by_chat_run_segment", (q) =>
        q
          .eq("chatId", chatId)
          .eq("runId", runId)
          .eq("runSegment", segment === 0 ? undefined : segment),
      )
      .take(4)
  ).find((m) => m.role === "assistant" && bubbleInScope(m, scope));
  if (own !== undefined || segment === 0) return own?._id ?? null;
  // A LATER segment of a run whose bubbles the live stream opened under its other name
  // (stream.ts `linkRunBubble`): they carry that name, found through the first segment's.
  const client = await linkedClientRunOf(ctx, chatId, runId, scope);
  if (client === null) return null;
  const linked = (
    await ctx.db
      .query("messages")
      .withIndex("by_chat_run_segment", (q) => q.eq("chatId", chatId).eq("runId", client).eq("runSegment", segment))
      .take(4)
  ).find((m) => m.role === "assistant" && m.transcriptRunId === runId && bubbleInScope(m, scope));
  return linked?._id ?? null;
}

/** A late link's record names the run's EARLIEST bubble (stream.ts `linkRunBubble`): one
 *  born at a later segment (the run was cut before it showed anything) is that segment's,
 *  never the first's. */
export function laterLinkedSegment(m: { transcriptRunId?: string; runSegment?: number }, runId: string): boolean {
  return m.transcriptRunId === runId && m.runSegment !== undefined && m.runSegment > 0;
}

/** The CLIENT run the live stream opened the bubbles of execution run `runId` under, when
 *  the gateway stated that link late (stream.ts `linkRunBubble`) — read from the earliest
 *  bubble, the one the run's record names. Null for every other run. */
export async function linkedClientRunOf(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  runId: string,
  scope: BubbleScope = {},
): Promise<string | null> {
  const recorded = await ctx.db
    .query("runBubbles")
    .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
    .take(4);
  for (const r of recorded) {
    const m = await ctx.db.get(r.messageId);
    if (m !== null && m.chatId === chatId && m.transcriptRunId === runId && m.runId !== undefined && bubbleInScope(m, scope)) {
      return m.runId;
    }
  }
  return null;
}

/**
 * The bubble of a run the transcript already proved OVER and whose bubble is settled —
 * or null. A live frame of such a run arriving late (a stashed delivery, a replay) must
 * not open a second bubble for it: the late frames of a settled run only reconcile
 * (CU-7/CU-8, ui/src/pages/chat/chat-gateway.ts:257-304 at v2026.9.8). Its writes then
 * land on the settled bubble, where the stream mutations drop text and keep parts.
 */
export async function settledProjectedBubble(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  runId: string,
  scope: BubbleScope = {},
  /** The steer segment the live overlay is opening (0: the run's first). The settled
   *  bubble of THAT segment, never another one's (codex phase 4 pass 2). */
  segment = 0,
): Promise<Id<"messages"> | null> {
  if (await transcriptRunSettled(ctx, chatId, runId, scope)) {
    const bubble = await liveBubbleFor(ctx, chatId, runId, segment, scope);
    if (bubble === null) return null;
    const message = await ctx.db.get(bubble);
    return message !== null && message.role === "assistant" && message.status !== "streaming"
      ? bubble
      : null;
  }
  // The transcript knows no such run over. `runId` may be the CLIENT name of a queued
  // input's execution (OpenClaw 2026.10.33), whose rows carry the execution run: the
  // bubble the live stream opened under it then states that run (stream.ts
  // `linkRunBubble`), and is the one a late frame of the client run lands on once that
  // run is over. One index read for a run that has no bubble yet.
  const own = (
    await ctx.db
      .query("messages")
      .withIndex("by_chat_run_segment", (q) =>
        q
          .eq("chatId", chatId)
          .eq("runId", runId)
          .eq("runSegment", segment === 0 ? undefined : segment),
      )
      .take(4)
  ).find((m) => m.role === "assistant" && m.transcriptRunId !== undefined && bubbleInScope(m, scope));
  if (own === undefined || own.status === "streaming") return null;
  return (await transcriptRunSettled(ctx, chatId, own.transcriptRunId!, scope)) ? own._id : null;
}

/** The transcript proved `runId` over, in the scope's session. */
async function transcriptRunSettled(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  runId: string,
  scope: BubbleScope,
): Promise<boolean> {
  const runs = await ctx.db
    .query("transcriptRuns")
    .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
    .take(4);
  return runs.some(
    (r) =>
      r.settledAt !== undefined && (scope.sessionKey === undefined || r.sessionKey === scope.sessionKey),
  );
}

/** A settled run RESUMED by its replay (an errored delivery the gateway runs again, codex
 *  phase 4 pass 12): its transcript state streams again — no longer over, its old
 *  terminal dropped — until the replay's own terminal or an idle read settles it. */
export async function reopenTranscriptRun(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  runId: string,
  now: number,
): Promise<void> {
  const runs = await ctx.db
    .query("transcriptRuns")
    .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
    .take(4);
  for (const r of runs) {
    if (r.settledAt === undefined && r.status === "streaming") continue;
    await ctx.db.patch(r._id, {
      status: "streaming",
      settledAt: undefined,
      terminalAt: undefined,
      emptyFinal: undefined,
      updatedAt: now,
    });
  }
}
