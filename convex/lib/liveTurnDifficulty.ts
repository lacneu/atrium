// Server side of the live-turn difficulty (the rules live in ./turnDifficulty): read
// the FACTS of one streaming message, with bounded reads, for every surface that shows
// the verdict — chatReads.liveTurnDifficulty (sidebar + bubble) and the diagnostic
// chat-state (diagnose). One loader, so the two cannot disagree.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { deliveryPartStamp } from "./deliveryRuns";
import {
  LIVE_PART_WINDOW,
  WAITING_PHASES,
  failedThenQuietTool,
  repeatedFailureFacts,
  type DifficultyToolPart,
  type TurnDifficultyFacts,
} from "./turnDifficulty";

/** The cadence of `liveTurnActivity`: a live turn stamps its last activity at most
 *  once per this interval. Rule 3 (2 minutes of silence) needs no finer grain, and a
 *  subscriber of the difficulty re-runs at most once per stamp while text streams. */
export const LIVE_ACTIVITY_STAMP_MS = 15_000;

/** Upsert a turn's activity row. `at` undefined = leave the stamp as it is (a
 *  phase change that proves no gateway activity). */
export async function writeLiveActivity(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  patch: { at?: number; phase: string | undefined },
): Promise<void> {
  const existing = await ctx.db
    .query("liveTurnActivity")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .first();
  const fields = {
    phase: patch.phase,
    ...(patch.at !== undefined ? { at: patch.at } : {}),
  };
  if (existing === null) {
    await ctx.db.insert("liveTurnActivity", { messageId, ...fields });
  } else {
    await ctx.db.patch(existing._id, fields);
  }
}

/**
 * Record that a live turn did something (a token, a snapshot, a heartbeat) —
 * THROTTLED. Called from the stream mutations that already hold the live row and are
 * about to patch it: returns the cursor field to MERGE into that patch (`{}` when the
 * stamp is not due) and writes the activity row only when it is. Off the stamp, the
 * cost is one comparison; on it, one indexed read and one write. `phase` = the live
 * row's phase AFTER this write, carried along so the activity row never keeps a
 * phase the row dropped for longer than one interval.
 */
export async function stampLiveActivity(
  ctx: MutationCtx,
  row: { messageId: Id<"messages">; activityStampedAt?: number },
  now: number,
  phase: string | undefined,
): Promise<{ activityStampedAt?: number }> {
  if (
    row.activityStampedAt !== undefined &&
    now - row.activityStampedAt < LIVE_ACTIVITY_STAMP_MS
  ) {
    return {};
  }
  await writeLiveActivity(ctx, row.messageId, { at: now, phase });
  return { activityStampedAt: now };
}

/** Drop a turn's activity row — wherever its live-text row is deleted. */
export async function clearLiveActivity(
  ctx: MutationCtx,
  messageId: Id<"messages">,
): Promise<void> {
  const rows = await ctx.db
    .query("liveTurnActivity")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .take(8);
  for (const r of rows) await ctx.db.delete(r._id);
}

/**
 * The difficulty facts of `message` while it streams, or null.
 *
 * READS: the message's latest LIVE_PART_WINDOW parts, and — ONLY when rule 3 is a
 * candidate (the latest tool call failed) — the live row's PHASE and the throttled
 * activity row. Never the live-text row's text or `updatedAt` as a clock: that row is
 * rewritten on every token, and a query depending on it re-runs on every token.
 * Here a healthy turn re-runs the loader on tool events; a turn writing after a
 * failure, at most once per LIVE_ACTIVITY_STAMP_MS.
 *
 * NO WALL CLOCK: the loader returns the moment of the last activity, never "how long
 * ago". The query stays deterministic over its reads (cacheable); the reader's clock
 * turns the facts into a verdict (turnDifficultyVerdict), re-evaluated by a client
 * timer set at `quietSince + STALL_AFTER_FAILURE_MS` — no write is needed for a quiet
 * turn to become flagged.
 *
 * GENERATION: a bubble reopened by a delegated result carries the parts of the turn
 * that opened it. Only the parts of the run that is streaming NOW count — those
 * stamped with its delivery run, or, for an ordinary turn, the unstamped ones — so a
 * struggle that ended with the first run is not reported against the second.
 */
export async function loadLiveTurnDifficultyFacts(
  ctx: QueryCtx,
  message: Doc<"messages">,
): Promise<TurnDifficultyFacts | null> {
  if (message.status !== "streaming") return null;
  const rows = await ctx.db
    .query("messageParts")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .order("desc")
    .take(LIVE_PART_WINDOW);
  const runStamp = deliveryPartStamp(message.runId);
  const current = (announceRun: string | undefined): boolean =>
    runStamp === undefined
      ? announceRun === undefined
      : announceRun === runStamp ||
        (announceRun !== undefined && announceRun === message.announceReplayRun);
  const tools: DifficultyToolPart[] = rows
    .filter((r) => current(r.announceRun))
    .sort((a, b) => a.order - b.order)
    .flatMap((r) =>
      r.part.kind === "tool" ? [{ name: r.part.name, phase: r.part.phase }] : [],
    );

  const repeated = repeatedFailureFacts(tools);
  if (repeated !== null) return repeated;

  const tool = failedThenQuietTool(tools);
  if (tool === null) return null;
  const activity = await ctx.db
    .query("liveTurnActivity")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .first();
  // Last observable activity: the message doc moves on every part write (the failure
  // itself, a plan update, a file); the activity row, at most once per stamp interval,
  // on tokens, snapshots, heartbeats and real phases. A stamp at `at` covers what
  // happened up to one interval later (a later token would have stamped again), so
  // the silence is counted from there: the alarm can come later, never earlier.
  const quietSince = Math.max(
    message.updatedAt,
    activity?.at === undefined ? 0 : activity.at + LIVE_ACTIVITY_STAMP_MS,
  );
  const phase = activity?.phase;
  // The turn says it is waiting on something legitimate: silence is expected.
  if (phase !== undefined && WAITING_PHASES.has(phase)) return null;
  return { kind: "failed_then_quiet", tool, quietSince };
}
