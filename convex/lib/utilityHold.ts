// THE UTILITY HOLD — Atrium's background jobs do not create a gateway session while a
// person is deciding an approval on that gateway.
//
// WHY. OpenClaw abandons a pending approval wait when ANY session is created on the
// gateway meanwhile. `exec.approval.waitDecision` (and the plugin / system-agent waits)
// capture a gateway-wide access revision when the wait starts and re-check it once the
// decision arrives (upstream src/gateway/server-methods/approval-request-authority.ts:71,
// :116-118 at v2026.9.36; unchanged at v2026.11.5-beta.1). Every committed session row
// advances that revision, whatever the RPC that wrote it
// (src/gateway/server-runtime-subscriptions.ts:638), so a command the person allowed
// ends `approval-request-failed` and never runs.
//
// Each utility job — the rolling summary, the documentary fetch, the agent-file
// curation, the document conversion — runs on a FRESH gateway session (its hidden chat
// rotates `openclawChatId` per job). Its creation is the one Atrium decides alone and can
// postpone without making anyone wait for anyone: the job is held at dispatch while an
// approval of the same instance is open, and re-checked until it is not.
//
// The summary is also held while the conversation it summarizes is still working. It is
// decided at the end of a turn, often while a sub-agent of that turn is about to ask for
// an approval that does not exist yet (measured on the live bench, 2026-11-07: the
// sub-agent asked 0.3 to 2.4 s after the summary was decided) — no approval to see, and a
// session created a second later.
//
// What this cannot cover: a session someone else creates during the wait (another
// conversation's first message, the OpenClaw Control UI, a sub-agent spawn, a cron run),
// an approval Atrium never sees, and the round trip between this decision and the
// bridge's session creation. Only an upstream fix closes those.

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isChatBusy, projectedGatewayHoldUntil } from "./outboxQueue";

/** The hidden chat kinds whose dispatch creates a fresh gateway session per job. */
export const UTILITY_CHAT_KINDS: ReadonlySet<string> = new Set([
  "summarizer",
  "documentary",
  "curator",
  "converter",
]);

/** How long a held job waits before it asks again. */
export const UTILITY_HOLD_RECHECK_MS = 15_000;

/**
 * Longest a job is held, counted from its first hold: above the 30 minutes an exec
 * approval stays open by default upstream. Past it the job is never sent while
 * something still holds it — it is cancelled (bridge.cancelUtilityJob); a job nothing
 * holds any more simply leaves.
 */
export const UTILITY_HOLD_MAX_MS = 35 * 60_000;

/**
 * Why a utility job was withdrawn without being sent — the curated code its lock is
 * released with (a rendition's `failureReason`, a curation's, a documentary fetch's, a
 * summary's `cancel` trace):
 * - `target_changed`: the hidden chat no longer routes to the target the job was
 *   enqueued for; sending would carry its content elsewhere;
 * - `approval_still_pending`: past the bound, an approval of the instance is still open;
 * - `source_still_busy`: past the bound, the summarized conversation is still working.
 */
export type UtilityCancelReason = "target_changed" | "approval_still_pending" | "source_still_busy";

/** Open requests read per status when asking about an instance — a bound on the read,
 *  far above what is ever open at once (the expiry sweep closes rows past their
 *  deadline). */
const OPEN_REQUESTS_READ = 200;

/** `submitting` too: the person clicked, but the gateway has not taken the decision yet
 *  — its wait is still open, and a session created now still breaks it. */
const OPEN_STATUSES = ["pending", "submitting"] as const;

export type UtilityHoldReason = "approval_pending" | "source_busy";

export interface UtilityHold {
  reason: UtilityHoldReason;
  /** When the held dispatch asks again. */
  retryAt: number;
}

/**
 * Should a utility job's session creation wait, and until when is it worth asking again?
 *
 * - An approval is open on the instance the job would run on (any conversation, any
 *   person — the gateway's revision is global): wait, and ask again at the earliest
 *   deadline among them or after UTILITY_HOLD_RECHECK_MS, whichever comes first.
 * - Otherwise, for a summary (`sourceChatId`), the summarized conversation is working:
 *   wait UTILITY_HOLD_RECHECK_MS.
 * - Otherwise null: dispatch now.
 *
 * Questions and credentials do not hold: after the answer, upstream reads the question's
 * session again rather than comparing the revision captured when the wait started
 * (src/gateway/server-methods/question.ts:474-487; a revision that moved during that read
 * restarts it, src/gateway/question-session-access.ts:94-174).
 */
export async function utilitySessionHold(
  ctx: QueryCtx,
  args: { instanceName: string; sourceChatId?: Id<"chats"> },
  now: number,
): Promise<UtilityHold | null> {
  let earliestDeadline: number | null = null;
  for (const status of OPEN_STATUSES) {
    const open = await ctx.db
      .query("agentRequests")
      .withIndex("by_instance_and_status", (q) =>
        q.eq("instanceName", args.instanceName).eq("status", status),
      )
      .take(OPEN_REQUESTS_READ);
    for (const request of open) {
      if (request.kind !== "approval" || request.expiresAt <= now) continue;
      if (earliestDeadline === null || request.expiresAt < earliestDeadline) {
        earliestDeadline = request.expiresAt;
      }
    }
  }
  if (earliestDeadline !== null) {
    return {
      reason: "approval_pending",
      retryAt: Math.min(earliestDeadline, now + UTILITY_HOLD_RECHECK_MS),
    };
  }
  if (
    args.sourceChatId !== undefined &&
    (await sourceConversationWorking(ctx, args.sourceChatId, now))
  ) {
    return { reason: "source_busy", retryAt: now + UTILITY_HOLD_RECHECK_MS };
  }
  return null;
}

/**
 * Is the conversation doing anything that may raise an approval in the next seconds?
 * A turn in dispatch, a bubble streaming, a sub-agent running, or a run the gateway
 * reports active before its bubble exists (the projection's facts).
 *
 * Deliberately NOT `isChatBusy`: under the transcript projection a running sub-agent
 * does not make a conversation busy for a SEND (the gateway places the reply itself),
 * but it is exactly the run most likely to ask for an approval after its parent's turn
 * ended — the case this hold exists for. Background tasks (`kind: "task"`) are left
 * out, as everywhere else: they do not run in a session of their own.
 */
async function sourceConversationWorking(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  now: number,
): Promise<boolean> {
  const dispatching = await ctx.db
    .query("outbox")
    .withIndex("by_chat_status", (q) => q.eq("chatId", chatId).eq("status", "pending"))
    .first();
  if (dispatching !== null) return true;
  const streaming = await ctx.db
    .query("messages")
    .withIndex("by_chat_status", (q) => q.eq("chatId", chatId).eq("status", "streaming"))
    .first();
  if (streaming !== null) return true;
  for (const kind of [undefined, "subagent"] as const) {
    const running = await ctx.db
      .query("subAgents")
      .withIndex("by_chat_status_kind", (q) =>
        q.eq("chatId", chatId).eq("status", "running").eq("kind", kind),
      )
      .first();
    if (running !== null) return true;
  }
  return (await projectedGatewayHoldUntil(ctx, chatId, now)) !== null;
}

/** The `createdAt` of the job lock a hidden chat holds now (its kind's own lock), or
 *  undefined when no job holds it. */
export function utilityLockCreatedAt(chat: Doc<"chats">): number | undefined {
  switch (chat.kind) {
    case "summarizer":
      return chat.pendingSummarize?.createdAt;
    case "documentary":
      return chat.pendingFetch?.createdAt;
    case "curator":
      return chat.pendingCurate?.createdAt;
    case "converter":
      return chat.pendingConvert?.createdAt;
    default:
      return undefined;
  }
}

/**
 * Does a hidden utility chat have a job in progress — a lock, or a dispatch, a reply or
 * a run still under way? Such a chat is never re-bound to another target: the job's
 * pending row would follow the binding (each dispatch reads it), and the rebinding is
 * left to the start of the next job.
 */
export async function utilityJobActive(ctx: QueryCtx, chat: Doc<"chats">): Promise<boolean> {
  if (utilityLockCreatedAt(chat) !== undefined) return true;
  return await isChatBusy(ctx, chat._id);
}
