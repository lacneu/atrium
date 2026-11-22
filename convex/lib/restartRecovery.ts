// A TURN THE GATEWAY CUT, AND ITS OWN RECOVERY (projection `on`).
//
// When a gateway restart (or a stop followed by a start) interrupts a running main-session
// turn, the gateway resumes it by itself once it is back: it appends a `user` entry
// "[System] Your previous turn was interrupted…" with `provenance {kind: "internal_system",
// sourceTool: "main_session_restart_recovery"}` and starts a NEW run — a fresh uuid, also
// the entry's idempotency key (`<runId>:user`) — that answers (upstream
// src/agents/main-session-recovery/main-session-restart-dispatch.ts
// `resumeMainSessionWithinAdmission`, `buildResumeMessage`; the provenance since
// v2026.7.2-beta.3, on every validated version). The Control UI shows that entry as a
// notice between the interrupted work and the recovery's answer ("System · restart
// recovery", ui/src/pages/chat/system-notice-kinds.ts, chat-system-notice.ts).
//
// THE LINK. Upstream keeps "which run this recovery resumes" in its session store only
// (`restartRecoveryDeliverySourceRunId`): nothing in the entry, its provenance or the
// recovery run's frames names the interrupted run. What the transcript does state is the
// ORDER, and it is NOT a proof by itself: the recovery is an ordinary `agent` request
// sent by a gateway that is up again (five seconds after its start, later under its
// retries, or after a tool timeout with no restart at all —
// main-session-restart-recovery-runtime.ts, main-session-recovery-lifecycle.ts
// `isRecoveryInterruption`), so another run of the session may have written in between.
// The row right before the entry therefore names the resumed run only when it also
// states a turn that was CUT (`resumedRunFromRow`, upstream's own reading of an
// interrupted turn's tail: pre-persisted-user-turn.ts `isInterruptedTurnEntry`) — read
// by `seq`, never by a time.
//
// DERIVED, NEVER LATCHED. What an entry names (`recoversRunId`) and what a bubble says of
// it (`interruption.recoveryRunId`) are read again from the rows at every projection pass
// (`recoveryOf`): an entry a covering read retracted, or whose preceding row was, stops
// stating it. (Rows are deleted only with their conversation.) Only rows are read there;
// the bubble is told in a transaction of its own (`tellLater`).

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { countedRows } from "./bubbleProjection";
import { liveBubbleFor } from "./projectedRuns";
import { steerSeqsOf } from "./transcriptProjection";

/** Upstream `MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL` (src/sessions/input-provenance.ts). */
const RECOVERY_SOURCE_TOOL = "main_session_restart_recovery";

/** Upstream `isMainSessionRestartRecoveryInputProvenance`: `internal_system`, and the
 *  source tool compared case-insensitively. */
export function isRecoveryEntry(row: { role: string; provenanceKind?: string; provenanceSourceTool?: string }): boolean {
  return (
    row.role.toLowerCase() === "user" &&
    row.provenanceKind === "internal_system" &&
    row.provenanceSourceTool?.trim().toLowerCase() === RECOVERY_SOURCE_TOOL
  );
}

export type Interruption = NonNullable<Doc<"messages">["interruption"]>;

/** What changes in what a bubble says of a cut turn. `shutdown: null`,
 *  `recoveryRunId: null` and `unanswered: false` REMOVE the fact: `unanswered` and
 *  `recoveryRunId` are derived from the rows at every projection pass, and an announced
 *  shutdown stops being a fact about a turn that resumed live. */
export type InterruptionChange = { shutdown?: "restart" | "stop" | null; recoveryRunId?: string | null; unanswered?: boolean };

/** Apply a change to a bubble's interruption; returns whether it changed. */
export async function noteInterruption(
  ctx: MutationCtx,
  message: Doc<"messages">,
  change: InterruptionChange,
): Promise<boolean> {
  const prev = message.interruption ?? {};
  const shutdown = change.shutdown === undefined ? prev.shutdown : (change.shutdown ?? undefined);
  const recoveryRunId = change.recoveryRunId === undefined ? prev.recoveryRunId : (change.recoveryRunId ?? undefined);
  const unanswered = change.unanswered === undefined ? prev.unanswered : change.unanswered ? (true as const) : undefined;
  if (prev.shutdown === shutdown && prev.recoveryRunId === recoveryRunId && prev.unanswered === unanswered) return false;
  const next: Interruption = {
    ...(shutdown !== undefined ? { shutdown } : {}),
    ...(recoveryRunId !== undefined ? { recoveryRunId } : {}),
    ...(unanswered === true ? { unanswered } : {}),
  };
  await ctx.db.patch(message._id, { interruption: Object.keys(next).length > 0 ? next : undefined });
  return true;
}

type Scope = { chatId: Id<"chats">; instanceName: string; sessionKey: string };

/**
 * The run the row RIGHT BEFORE a recovery entry says was executing, by what each kind of
 * row carries (bridge transcript-rows.ts `readTranscriptIdentity`, upstream
 * packages/gateway-client/src/session-projection-message-identity.ts):
 *  - a row a run PRODUCED names that run (`__openclaw.runId`), and it is the run the
 *    recovery resumes only when the row is the tail of a turn that was CUT — upstream's
 *    predicate, transcribed (pre-persisted-user-turn.ts `isInterruptedTurnEntry` at
 *    v2026.9.36): a tool result; a `custom` row that is real tool activity (the
 *    `openclaw.nested-tool.v1` row, the only custom row that carries tool calls — the
 *    bridge keeps them as `toolCallIds`); an assistant row that stopped on a tool call,
 *    or that the shutdown aborted with nothing written. Proven. Anything else concludes
 *    nothing: a `custom` row without tool calls (the gateway's `run-failed-before-reply`
 *    notice names a run that FAILED, maybe another one, between the interruption and the
 *    recovery; a row from a bridge that does not send the calls); an assistant row that
 *    ended its reply (another run's end, or — upstream also resumes a run whose final
 *    reply was captured but not delivered — this one's: the row cannot tell); any other
 *    role;
 *  - an input STEERED into a run names its own send as `runId` and the run it went into
 *    as `steerTargetRunId` — the executed run is the latter (upstream: the steered-into
 *    run stays the source), proven;
 *  - any other input row (the turn's own send, a queued or held input, a sub-agent
 *    announce or a channel input, another recovery entry) names only the id it was SENT
 *    under: a run of that id may never have existed. Not proven — the caller believes it
 *    only if such a run is known;
 *  - a row that named no run (a compaction marker, a system notice), even one Convex
 *    shows with a presentation owner: nothing.
 * `null`: nothing can be concluded.
 */
export function resumedRunFromRow(row: {
  role: string;
  runId?: string;
  steerTargetRunId?: string;
  presentationOwner?: boolean;
  stopReason?: string;
  toolCallIds?: readonly string[];
  visible?: boolean;
}): { runId: string; proven: boolean } | null {
  const role = row.role.toLowerCase();
  if (role === "user") {
    if (row.steerTargetRunId !== undefined) return { runId: row.steerTargetRunId, proven: true };
    return row.runId === undefined ? null : { runId: row.runId, proven: false };
  }
  if (row.runId === undefined || row.presentationOwner === true) return null;
  const cut =
    role === "toolresult" ||
    (role === "custom" && (row.toolCallIds?.length ?? 0) > 0) ||
    (role === "assistant" && (row.stopReason === "toolUse" || (row.stopReason === "aborted" && row.visible === false)));
  return cut ? { runId: row.runId, proven: true } : null;
}

/** The bubble that shows the END of a run: its last steer segment's, else the nearest
 *  earlier one that has a bubble. */
async function lastBubbleOf(ctx: MutationCtx, scope: Scope, runId: string): Promise<Doc<"messages"> | null> {
  const cuts = await steerSeqsOf(ctx, scope.chatId, scope.sessionKey, runId);
  for (let k = cuts.seqs.length; k >= 0; k--) {
    const id = await liveBubbleFor(ctx, scope.chatId, runId, k, { instanceName: scope.instanceName, sessionKey: scope.sessionKey });
    if (id === null) continue;
    const m = await ctx.db.get(id);
    if (m !== null) return m;
  }
  return null;
}

/** What the recovery reads are charged to: the projection's shared budget. */
export type RecoveryMeter = { queries: number; bytes: number };
const charge = (meter: RecoveryMeter, docs: readonly unknown[]): void => {
  meter.queries++;
  for (const d of docs) meter.bytes += JSON.stringify(d).length;
};

/** The run the rows say `entry` resumes, read NOW — never what was remembered. Rows only. */
async function derivedResumedRun(ctx: MutationCtx, scope: Scope, entry: Doc<"transcriptRows">, meter: RecoveryMeter): Promise<string | null> {
  if (!isRecoveryEntry(entry) || entry.runId === undefined || entry.retracted === true || entry.instanceName !== scope.instanceName) return null;
  const before = await ctx.db
    .query("transcriptRows")
    .withIndex("by_chat_session_seq", (q) =>
      q.eq("chatId", scope.chatId).eq("sessionKey", scope.sessionKey).eq("sessionId", entry.sessionId).lt("seq", entry.seq),
    )
    .order("desc")
    .take(4);
  charge(meter, before);
  // The row RIGHT before the entry, and only it: a hole would name an older run.
  const prev = countedRows(before)[0];
  if (prev === undefined || prev.seq !== entry.seq - 1 || prev.instanceName !== scope.instanceName) return null;
  const named = resumedRunFromRow(prev);
  if (named === null || named.runId === entry.runId) return null;
  if (!named.proven) {
    // An input row names its send: believed only when the gateway is known to have run
    // a run under that id in this session.
    const ran = await ctx.db
      .query("transcriptRuns")
      .withIndex("by_chat_session_run", (q) =>
        q.eq("chatId", scope.chatId).eq("sessionKey", scope.sessionKey).eq("runId", named.runId),
      )
      .first();
    charge(meter, ran === null ? [] : [ran]);
    if (ran === null) return null;
  }
  return named.runId;
}

/**
 * THE BUBBLE IS TOLD IN ITS OWN TRANSACTION. Saying a recovery on a bubble means reading
 * that message — its whole text — and the transcript's ingestion and projection read
 * within a byte budget that this feature must not spend on text it does not use (a page
 * naming fourteen large bubbles went past the transaction's read limit, and its retries
 * with it). Here only ROWS are read, charged to the caller's budget; the bubble is told
 * by `tellRecoveredBubble`, scheduled, one run per transaction. `withdraw`: the recovery
 * run an entry no longer attributes to this run.
 */
async function tellLater(ctx: MutationCtx, scope: Scope, runId: string, withdraw?: string): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.transcriptProjection.noteRunRecovery, {
    chatId: scope.chatId,
    sessionKey: scope.sessionKey,
    instanceName: scope.instanceName,
    runId,
    ...(withdraw !== undefined ? { withdraw } : {}),
  });
}

/**
 * Read again which run `entry` resumes and keep what it carries (`recoversRunId`, what the
 * display grouping and a later-born bubble read) equal to it. When it stops naming a run,
 * that run's bubble is told. Returns the resumed run, or null — also while the row before
 * the entry is not stored yet (a live post that overtook its read).
 */
async function rederiveRecovery(ctx: MutationCtx, scope: Scope, entry: Doc<"transcriptRows">, meter: RecoveryMeter): Promise<string | null> {
  const resumed = await derivedResumedRun(ctx, scope, entry, meter);
  const was = entry.recoversRunId;
  if (was === (resumed ?? undefined)) return resumed;
  await ctx.db.patch(entry._id, { recoversRunId: resumed ?? undefined });
  if (was !== undefined && entry.runId !== undefined) await tellLater(ctx, scope, was, entry.runId);
  return resumed;
}

/**
 * A recovery entry was stored, or its run is projected: find the run it resumes and say
 * so — on the entry now, on that run's bubble in a transaction of its own. Read from the
 * rows every time. Returns the resumed run, or null.
 */
export async function resolveRecovery(
  ctx: MutationCtx,
  scope: Scope,
  entry: Doc<"transcriptRows">,
  meter: RecoveryMeter,
): Promise<string | null> {
  const resumed = await rederiveRecovery(ctx, scope, entry, meter);
  if (resumed !== null) await tellLater(ctx, scope, resumed);
  return resumed;
}

/** The recovery run that resumed `runId`, by the entries that name it — each read again
 *  from the rows (null: none, or more than one — never a guess). Rows only: for a run no
 *  entry names, ONE index range that returns nothing. */
export async function recoveryOf(ctx: MutationCtx, scope: Scope, runId: string, meter: RecoveryMeter): Promise<string | null> {
  const named = await ctx.db
    .query("transcriptRows")
    .withIndex("by_chat_recovers", (q) => q.eq("chatId", scope.chatId).eq("recoversRunId", runId))
    .take(3);
  charge(meter, named);
  const runs = new Set<string>();
  for (const e of named) {
    if (e.sessionKey !== scope.sessionKey || e.instanceName !== scope.instanceName) continue;
    if ((await rederiveRecovery(ctx, scope, e, meter)) === runId && e.runId !== undefined) runs.add(e.runId);
  }
  return runs.size === 1 ? [...runs][0]! : null;
}

/** Ask for the bubble of `runId` to say that `recoveryRunId` resumed it. */
export async function noteRecoveredRun(ctx: MutationCtx, scope: Scope, runId: string): Promise<void> {
  await tellLater(ctx, scope, runId);
}

/** Bubbles of one run read per transaction when its earlier segments are cleared: a
 *  message is read whole, and eight of the largest stay far under the read limit. A run
 *  with more segments continues in the next transaction. */
const RECOVERY_CLEAR_PAGE = 8;

/**
 * The scheduled half (`transcriptProjection.noteRunRecovery`): what the rows say NOW of
 * the recovery of `runId`, on EXACTLY ONE bubble of that run — the one that shows its end
 * (its last steer segment's, where the cut is read) — and on no other: a steer cut
 * received after the bubble was told moves the run's end to a later bubble, and the
 * earlier one must stop saying it, whether the fact is then said again or withdrawn.
 * Every call places the fact and clears the run's other bubbles, newest first,
 * `RECOVERY_CLEAR_PAGE` per transaction (`below`: the continuation). Its own
 * transactions: this run's rows and bubbles, nothing else.
 */
export async function tellRecoveredBubble(
  ctx: MutationCtx,
  scope: Scope,
  runId: string,
  withdraw?: string,
  below?: number,
): Promise<void> {
  const by = await recoveryOf(ctx, scope, runId, { queries: 0, bytes: 0 });
  const bubble = await lastBubbleOf(ctx, scope, runId);
  if (below === undefined && bubble !== null && bubble.role === "assistant") {
    if (by !== null) await noteInterruption(ctx, bubble, { recoveryRunId: by });
    // What the entry made this bubble say, and only that.
    else if (withdraw !== undefined && bubble.interruption?.recoveryRunId === withdraw) await noteInterruption(ctx, bubble, { recoveryRunId: null });
  }
  // A bubble of ANOTHER run that shows this run's first segment (a merged delivery) may
  // state that other run's recovery: only what this run's entries said is taken from it.
  const stale = (m: Doc<"messages">): boolean =>
    m._id !== bubble?._id &&
    m.role === "assistant" &&
    m.interruption?.recoveryRunId !== undefined &&
    (m.runId === runId || m.interruption.recoveryRunId === by || m.interruption.recoveryRunId === withdraw);
  if (below === undefined) {
    const recorded = await ctx.db
      .query("runBubbles")
      .withIndex("by_chat_run", (q) => q.eq("chatId", scope.chatId).eq("runId", runId))
      .take(4);
    for (const r of recorded) {
      const m = await ctx.db.get(r.messageId);
      if (m !== null && m.chatId === scope.chatId && stale(m)) await noteInterruption(ctx, m, { recoveryRunId: null });
    }
  }
  const page = await ctx.db
    .query("messages")
    .withIndex("by_chat_run_segment", (q) => {
      const own = q.eq("chatId", scope.chatId).eq("runId", runId);
      return below === undefined ? own : own.lt("runSegment", below);
    })
    .order("desc")
    .take(RECOVERY_CLEAR_PAGE);
  for (const m of page) if (stale(m)) await noteInterruption(ctx, m, { recoveryRunId: null });
  const next = page.at(-1)?.runSegment;
  if (page.length === RECOVERY_CLEAR_PAGE && next !== undefined) {
    await ctx.scheduler.runAfter(0, internal.transcriptProjection.noteRunRecovery, {
      chatId: scope.chatId,
      sessionKey: scope.sessionKey,
      instanceName: scope.instanceName,
      runId,
      ...(withdraw !== undefined ? { withdraw } : {}),
      below: next,
    });
  }
}
