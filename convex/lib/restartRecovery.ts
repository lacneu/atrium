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
// ORDER: the entry is appended right after the interrupted run's last row, while nothing
// else can write (the gateway was down). So the run a recovery resumes is the run of the
// row right before its entry — read here by `seq`, never by a time (`resumedRunFromRow`
// says what each kind of row there states).

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
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

/** What changes in what a bubble says of a cut turn. `shutdown: null` and
 *  `unanswered: false` REMOVE the fact: `unanswered` is derived from the rows at every
 *  projection pass, and an announced shutdown stops being a fact about a turn that
 *  resumed live. */
export type InterruptionChange = { shutdown?: "restart" | "stop" | null; recoveryRunId?: string; unanswered?: boolean };

/** Apply a change to a bubble's interruption; returns whether it changed. */
export async function noteInterruption(
  ctx: MutationCtx,
  message: Doc<"messages">,
  change: InterruptionChange,
): Promise<boolean> {
  const prev = message.interruption ?? {};
  const shutdown = change.shutdown === undefined ? prev.shutdown : (change.shutdown ?? undefined);
  const recoveryRunId = change.recoveryRunId ?? prev.recoveryRunId;
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
 *  - a row a run PRODUCED (assistant, tool result, nested tool, hidden or not) names that
 *    run (`__openclaw.runId`): proven;
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
}): { runId: string; proven: boolean } | null {
  if (row.role.toLowerCase() === "user") {
    if (row.steerTargetRunId !== undefined) return { runId: row.steerTargetRunId, proven: true };
    return row.runId === undefined ? null : { runId: row.runId, proven: false };
  }
  if (row.runId === undefined || row.presentationOwner === true) return null;
  return { runId: row.runId, proven: true };
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

/**
 * A recovery entry was stored (or read again while still unresolved): find the run it
 * resumes and say so — on the entry (`recoversRunId`, what the display grouping and a
 * later-born bubble read) and on that run's bubble, when it has one. Returns the resumed
 * run, or null while the row before the entry is not stored yet (a live post that
 * overtook its read): resolved again when the recovery run is projected.
 */
export async function resolveRecovery(
  ctx: MutationCtx,
  scope: Scope,
  entry: Doc<"transcriptRows">,
): Promise<string | null> {
  if (!isRecoveryEntry(entry) || entry.runId === undefined || entry.instanceName !== scope.instanceName) return null;
  let resumed = entry.recoversRunId ?? null;
  if (resumed === null) {
    const before = await ctx.db
      .query("transcriptRows")
      .withIndex("by_chat_session_seq", (q) =>
        q.eq("chatId", scope.chatId).eq("sessionKey", scope.sessionKey).eq("sessionId", entry.sessionId).lt("seq", entry.seq),
      )
      .order("desc")
      .take(1);
    // The row RIGHT before the entry, and only it: a hole would name an older run.
    const prev = before[0];
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
      if (ran === null) return null;
    }
    resumed = named.runId;
    await ctx.db.patch(entry._id, { recoversRunId: resumed });
  }
  await noteRecoveredRun(ctx, scope, resumed, entry.runId);
  return resumed;
}

/** Say on the bubble of `runId` that the gateway's recovery run resumed it. */
export async function noteRecoveredRun(ctx: MutationCtx, scope: Scope, runId: string, recoveryRunId: string): Promise<void> {
  const bubble = await lastBubbleOf(ctx, scope, runId);
  if (bubble !== null && bubble.role === "assistant") await noteInterruption(ctx, bubble, { recoveryRunId });
}

/** The recovery run that resumed `runId`, by its stored entry (null: none, or more than
 *  one entry names it — never a guess). */
export async function recoveryOf(ctx: MutationCtx, scope: Scope, runId: string): Promise<string | null> {
  const entries = (
    await ctx.db
      .query("transcriptRows")
      .withIndex("by_chat_recovers", (q) => q.eq("chatId", scope.chatId).eq("recoversRunId", runId))
      .take(3)
  ).filter((e) => e.sessionKey === scope.sessionKey && e.instanceName === scope.instanceName && e.runId !== undefined);
  const runs = new Set(entries.map((e) => e.runId!));
  return runs.size === 1 ? [...runs][0]! : null;
}
