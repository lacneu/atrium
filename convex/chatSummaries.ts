// Hybrid rehydration — the ROLLING-SUMMARY engine (docs/design/hybrid-rehydration.md).
//
// Maintains ONE rolling summary per conversational chat so rehydration can inject
// "summary of the older conversation + verbatim recent tail" instead of a purely
// verbatim (and therefore capped-and-lossy) block. The summarization work is done by
// the chat's OWN agent via an ordinary gateway turn in a HIDDEN per-user chat —
// exactly the documentary-fetch pattern (kind:"documentary" → kind:"summarizer"):
// no gateway feature dependency, no local compute, provider-agnostic (Hermes-ready).
//
// FLOW:
//   1. stream.finalize (regular chat turn) → schedules maybeScheduleSummarize.
//   2. maybeScheduleSummarize: guards (enough new content, engine enabled, no job in
//      flight, backoff elapsed) → dispatches ONE summarize turn in the hidden chat
//      (fresh gateway session via openclawChatId rotation, rehydration forced OFF).
//   3. stream.finalize (summarizer chat) → correlateSummarize: store the reply as the
//      new summary, advance the watermark. Errors → failure backoff.
//   4. Stuck jobs are released by the stuck-streams watchdog (like pendingFetch).
//
// Every path is best-effort: a summarize failure NEVER affects a user turn —
// rehydration just keeps composing from the last good summary (or none).

import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { writeTraceEvent } from "./observability";
import { isChatBusy } from "./lib/outboxQueue";
import { deleteFilesByMessage } from "./lib/files";
import { requireActive } from "./lib/access";
import { resolveSummarizerTarget } from "./agents";
import { resolveTargetForChat } from "./routing";
import { compareOrder, effectiveOrder } from "./lib/messageOrder";
import {
  effectiveTemplate,
  fillTemplate,
  resolveInjection,
} from "./lib/promptInjections";
import {
  summarizeSessionNonce,
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
  SUMMARY_MAX_CHARS,
  clampSummary,
  freshTailCount,
  summaryBackoffMs,
} from "./lib/rehydration";

/** Bounded newest-window read when building a chunk (mirrors rehydration's bounded
 *  tail read, wider). A backlog larger than this window converges over several jobs;
 *  content older than the window that was never summarized stays in the honest
 *  "omitted" gap — the exact legacy behavior for such chats. */
const CHUNK_READ_WINDOW = 240;

/** One summarize lifecycle's correlation key across the trace surface
 *  (`summary.dispatch` → `summary.correlate` | `summary.fail`). */
export function summaryCorrelationId(
  targetChatId: Id<"chats">,
  createdAt: number,
): string {
  return `chatsum:${targetChatId}:${createdAt}`;
}

/** Find (or lazily create) the user's HIDDEN summarizer chat, bound to `target`
 *  (the TARGET chat's own agent — the conversation content never crosses an agent
 *  boundary it hasn't already crossed). Mirrors ensureDocumentaryChat. */
async function ensureSummarizerChat(
  ctx: MutationCtx,
  userId: Id<"users">,
  target: { instanceName: string; agentId: string },
  now: number,
): Promise<Doc<"chats">> {
  const existing = await ctx.db
    .query("chats")
    .withIndex("by_user_kind", (q) =>
      q.eq("userId", userId).eq("kind", "summarizer"),
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
    kind: "summarizer" as const,
    title: "Synthèse",
    instanceName: target.instanceName,
    agentId: target.agentId,
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}

/**
 * Purge the hidden summarizer chat's SETTLED job rows: every non-streaming message
 * (with its parts / streamingText rows / outbox rows) + any undispatched outbox row.
 * The hidden chat holds COPIES of conversation excerpts (each job's prompt) and the
 * produced summaries — retention hygiene demands they live only as long as the job
 * needs them (codex P1: released/expired copies must not linger, and a not-yet-
 * dispatched prompt containing now-deleted content must never reach the agent).
 * Streaming rows are left alone (a live gateway turn is finalizing into them); the
 * next dispatch's cleanup sweeps them once settled.
 */
/** Cascade-purge EVERY content row of a hidden utility chat (messages +
 *  messageParts + files + streamingText + streamChunks + outbox + sub-agent
 *  tables). Generic by hiddenChatId — reused by the curator cleanup. Exported so
 *  the copies-of-user-content hygiene is single-source across hidden kinds. */
export async function cleanupHiddenChatContent(
  ctx: MutationCtx,
  hiddenChatId: Id<"chats">,
): Promise<void> {
  // Cancel anything not yet dispatched FIRST (pending/queued) — deleting the row
  // makes bridge.dispatch a no-op (it re-reads the row and returns on null).
  for (const status of ["pending", "queued"] as const) {
    const rows = await ctx.db
      .query("outbox")
      .withIndex("by_chat_status", (q) =>
        q.eq("chatId", hiddenChatId).eq("status", status),
      )
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  }
  const msgs = await ctx.db
    .query("messages")
    .withIndex("by_chat", (q) => q.eq("chatId", hiddenChatId))
    .collect();
  let anyStreamingLeft = false;
  for (const m of msgs) {
    if (m.status === "streaming") {
      anyStreamingLeft = true;
      continue;
    }
    const parts = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", m._id))
      .collect();
    for (const pt of parts) await ctx.db.delete(pt._id);
    // Files-row invariant (like every other message-deletion path): a summary
    // reply that carried a file/media part also created `files` rows — purge them
    // or they linger orphaned in the user's file list.
    await deleteFilesByMessage(ctx, m._id);
    const live = await ctx.db
      .query("streamingText")
      .withIndex("by_message", (q) => q.eq("messageId", m._id))
      .collect();
    for (const st of live) await ctx.db.delete(st._id);
    // SSE transport: chunks of an un-GC'd reply hold TEXT — schedule the bounded
    // purge exactly like cascadeDeleteChat (only when present).
    if (
      await ctx.db
        .query("streamChunks")
        .withIndex("by_message_seq", (q) => q.eq("messageId", m._id))
        .first()
    ) {
      await ctx.scheduler.runAfter(0, internal.stream.deleteStreamChunksStep, {
        messageId: m._id,
      });
    }
    const ob = await ctx.db
      .query("outbox")
      .withIndex("by_message", (q) => q.eq("messageId", m._id))
      .collect();
    for (const o of ob) await ctx.db.delete(o._id);
    await ctx.db.delete(m._id);
  }
  // Ancillary CONTENT tables keyed by chat (mirror of cascadeDeleteChat): a
  // summarizer agent that spawned children / recorded interactions leaves copies
  // there too. Skipped while a streaming reply remains (its rows are live; the
  // next settle's sweep finishes the job).
  if (!anyStreamingLeft) {
    const subAgents = await ctx.db
      .query("subAgents")
      .withIndex("by_chat", (q) => q.eq("chatId", hiddenChatId))
      .collect();
    for (const sa of subAgents) await ctx.db.delete(sa._id);
    const subAgentToolParts = await ctx.db
      .query("subAgentToolParts")
      .withIndex("by_chat", (q) => q.eq("chatId", hiddenChatId))
      .collect();
    for (const pt of subAgentToolParts) await ctx.db.delete(pt._id);
    const subAgentInteractions = await ctx.db
      .query("subAgentInteractions")
      .withIndex("by_chat", (q) => q.eq("chatId", hiddenChatId))
      .collect();
    for (const it of subAgentInteractions) await ctx.db.delete(it._id);
  }
}

/** Scheduled post-settle sweep of the hidden chat (from correlate/fail — deleting
 *  the reply row INSIDE its own finalize transaction would be fragile). Skips when
 *  a NEW job locked the chat meanwhile (its rows are live). */
export const cleanupSummarizerChat = internalMutation({
  args: { hiddenChatId: v.id("chats") },
  handler: async (ctx, { hiddenChatId }) => {
    const hidden = await ctx.db.get(hiddenChatId);
    if (!hidden || hidden.kind !== "summarizer") return;
    if (hidden.pendingSummarize) return "in_flight"; // a live job owns the current rows
    await cleanupHiddenChatContent(ctx, hiddenChatId);
  },
});

/** Per-child cap when a sub-agent RESULT rides in history/summarization — a child
 *  can return very large answers; bounded like every other injected surface. */
export const SUBAGENT_RESULT_HISTORY_CAP = 8_000;

/** Sub-agent results anchored to this chat's messages. Sub-agent-driven turns
 *  often carry an EMPTY parent text (the visible content IS the child's final
 *  answer) — without this join, rehydration, the summarizer and the gauge are all
 *  blind to the conversation's real content (live-diagnosed: a 30k-token digest
 *  chat whose usable text totalled 2.6k chars). ONE bounded by_chat read per walk. */
export interface ChildResultsIndex {
  /** parentMessageId -> formatted, capped result blocks (done children only). */
  byMsg: Map<string, string[]>;
  /** Messages with a child still RUNNING: their content is not settled — the
   *  summarizer must not advance the watermark past them. */
  unsettled: Set<string>;
}

export async function loadChildResults(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
  // OPTIONAL creation-time range (the engine's page walk): children are CREATED
  // during their parent's turn, so a ranged read reaches the children of OLD
  // unsummarized parents even when the chat holds more children than the newest
  // window — without it their parents would look empty and the watermark could
  // pass them, silently dropping their results from the summary (codex P2).
  range?: { fromMs: number; toMs: number },
): Promise<ChildResultsIndex> {
  // NEWEST window: recent + still-running children are the ones that gate the
  // watermark and carry fresh content — an ascending read could miss them past
  // the cap and let the floor advance over a running parent (codex P2).
  const newest = await ctx.db
    .query("subAgents")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .order("desc")
    .take(500);
  const rows = [...newest];
  if (range) {
    const CHILD_CREATION_SLACK_MS = 60 * 60 * 1000;
    const ranged = await ctx.db
      .query("subAgents")
      .withIndex("by_chat", (q) =>
        q
          .eq("chatId", chatId)
          .gte("_creationTime", range.fromMs - CHILD_CREATION_SLACK_MS)
          .lte("_creationTime", range.toMs + CHILD_CREATION_SLACK_MS),
      )
      .take(500);
    const seen = new Set(newest.map((r) => r._id as string));
    for (const r of ranged) {
      if (!seen.has(r._id as string)) rows.push(r);
    }
  }
  const byMsg = new Map<string, string[]>();
  const unsettled = new Set<string>();
  for (const r of rows) {
    if (!r.parentMessageId) continue;
    const key = r.parentMessageId as string;
    if (r.status === "running") {
      unsettled.add(key);
      continue;
    }
    const text = (r.resultText ?? "").trim();
    if (r.status !== "done" || text.length === 0) continue;
    const capped =
      text.length > SUBAGENT_RESULT_HISTORY_CAP
        ? `${text.slice(0, SUBAGENT_RESULT_HISTORY_CAP - 1)}…`
        : text;
    const label = r.taskName
      ? `[Résultat du sous-agent « ${r.taskName} » :]`
      : "[Résultat du sous-agent :]";
    const list = byMsg.get(key) ?? [];
    list.push(`${label}\n${capped}`);
    byMsg.set(key, list);
  }
  return { byMsg, unsettled };
}

/** A turn's HISTORY text: its own text + its children's results. */
export function enrichedTurnText(
  m: Doc<"messages">,
  children: ChildResultsIndex,
): string {
  const own = m.text.trim();
  const kids = children.byMsg.get(m._id as string) ?? [];
  if (kids.length === 0) return own;
  return own.length > 0 ? `${own}\n${kids.join("\n")}` : kids.join("\n");
}

/** The complete turns usable for summarization/rehydration, NEWEST-first,
 *  bounded window. A turn counts when it has OWN text OR settled child results. */
function usableTurnsDesc(
  rows: Doc<"messages">[],
  watermark: number,
  children: ChildResultsIndex,
): Doc<"messages">[] {
  return rows
    .filter(
      (m) =>
        m.status === "complete" &&
        (m.role === "user" || m.role === "assistant") &&
        (m.text.trim().length > 0 ||
          (children.byMsg.get(m._id as string)?.length ?? 0) > 0) &&
        effectiveOrder(m) > watermark,
    )
    .sort((a, b) => effectiveOrder(b) - effectiveOrder(a) || b._creationTime - a._creationTime);
}

function renderTurn(m: Doc<"messages">, children: ChildResultsIndex): string {
  const label = m.role === "user" ? "Utilisateur" : "Assistant";
  return `${label} : ${enrichedTurnText(m, children)}`;
}

/** Outcome of one scheduling attempt — returned to the MANUAL caller so the panel
 *  can tell the user exactly why nothing was dispatched. */
export type ScheduleSummarizeOutcome =
  | "dispatched"
  | "in_flight"
  | "nothing_to_do"
  // The serving bridge does not echo turn session keys yet (pre-0.20): the
  // deterministic correlation the engine requires is unavailable — update the
  // bridge image.
  | "bridge_outdated"
  // A big already-covered region was crossed (scan floor advanced) without
  // reaching unsummarized content yet — a CONTINUATION attempt is already
  // scheduled; convergence needs no further user/turn activity.
  | "scanning"
  | "engine_off"
  | "backoff"
  | "no_agent";

/**
 * Post-turn check: dispatch ONE summarize job for `chatId` when it is due.
 * Called (fire-and-forget, scheduler.runAfter(0)) from stream.finalize on regular
 * chats. ALL guards fail-quiet — this must never throw into the turn lifecycle.
 */
export const maybeScheduleSummarize = internalMutation({
  args: { chatId: v.id("chats"), manual: v.optional(v.boolean()) },
  handler: async (ctx, { chatId, manual }) => {
    await scheduleSummarizeJob(ctx, chatId, { manual: manual === true });
  },
});

/**
 * MANUAL trigger (Réglages de session ▸ "Générer la synthèse"): the owner asks for
 * a summary NOW. Bypasses the auto-path's volume threshold and failure backoff
 * (explicit intent = retry now); still respects serialization (one job per user)
 * and the feature switches (a summary the bridge would never consume is refused
 * with an explicit outcome, not silently produced).
 */
export const requestSummarize = mutation({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{ outcome: ScheduleSummarizeOutcome }> => {
    const { userId } = await requireActive(ctx);
    const chat = await ctx.db.get(chatId);
    if (!chat || chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }
    return { outcome: await scheduleSummarizeJob(ctx, chatId, { manual: true }) };
  },
});

async function scheduleSummarizeJob(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  opts: { manual: boolean },
): Promise<ScheduleSummarizeOutcome> {
    const now = Date.now();
    const chat = await ctx.db.get(chatId);
    // Regular conversational chats only (never summarize the hidden utility chats).
    if (!chat || chat.kind !== undefined) return "no_agent";
    // ALWAYS resolve through the SAME routing as dispatch (codex P2 ×2): it
    // honors a valid binding byte-identically, covers legacy/unbound chats via
    // the default-agent fallback, and — critically — applies the restriction
    // checks (a bound agent later revoked or retyped utility-only must NOT
    // receive the transcript via the summarizer when normal dispatch refuses
    // it). Resolution only; the engine never rebinds the chat itself.
    const res = await resolveTargetForChat(ctx, chat, chat.userId);
    if (!res.target) return "no_agent";
    const boundInstance = res.target.instanceName;
    const boundAgent = res.target.agentId;

    // FEATURE switch: the instance's `rehydration` config (Bridge settings) — no
    // rehydration means summaries would never be consumed. The history_summary
    // INJECTION toggle below only controls Atrium's prompt FRAMING (a dedicated
    // agent may carry its own briefing), never the feature (user decision).
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", boundInstance))
      .first();
    if (instance?.config?.rehydration === false) return "engine_off";
    const compatDoc = await ctx.db
      .query("bridgeCompat")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .unique();
    // Per-instance first (multi-bridge: each instance follows ITS bridge's
    // kill-switch). When a target row for THIS instance exists, its null means
    // "pre-0.20 bridge = assumed enabled" and must NOT fall through to another
    // bridge's global value (codex P2). The top-level only serves docs with no
    // matching target (legacy / not yet re-polled).
    const compatTarget = compatDoc?.targets.find(
      (t) => t.instanceName === boundInstance,
    );
    // No explicit instance override -> honor the bridge's env-level kill-switch
    // (OPENCLAW_REHYDRATION=off, mirrored via /capabilities into bridgeCompat):
    // when the bridge would never consume a summary, never burn model turns
    // producing one.
    if (instance?.config?.rehydration === undefined) {
      const effective =
        compatTarget !== undefined
          ? (compatTarget.rehydrationDefault ?? null)
          : (compatDoc?.rehydrationDefault ?? null);
      if (effective === false) return "engine_off";
    }
    // DETERMINISTIC correlation is a HARD requirement, independent of the
    // rehydration knob: a bridge that does not echo turn session keys leaves
    // only a time-based join, which can settle the WRONG job during a rolling
    // upgrade (codex P2) — refuse to dispatch until the bridge is updated.
    const echo =
      compatTarget !== undefined
        ? (compatTarget.turnSessionEcho ?? null)
        : (compatDoc?.turnSessionEcho ?? null);
    if (echo !== true) return "bridge_outdated";
    const injection = resolveInjection(
      "history_summary",
      instance?.config?.promptInjections,
    );

    const row = await ctx.db
      .query("chatSummaries")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
    // Failure backoff — the MANUAL path ignores it (explicit retry-now intent).
    if (!opts.manual && row && now < row.nextEligibleAt) return "backoff";
    const watermark = row?.watermarkOrderTime ?? 0;

    // One job in flight per user (the hidden chat serializes, like documentary).
    const hiddenExisting = await ctx.db
      .query("chats")
      .withIndex("by_user_kind", (q) =>
        q.eq("userId", chat.userId).eq("kind", "summarizer"),
      )
      .first();
    if (hiddenExisting?.pendingSummarize) return "in_flight";
    if (hiddenExisting && (await isChatBusy(ctx, hiddenExisting._id)))
      return "in_flight";

    // Chunk = the OLDEST unsummarized complete turns, keeping the chat's newest
    // KEEP_RECENT_MESSAGES out (they stay verbatim-fresh), bounded by
    // CHUNK_MAX_CHARS. Not enough new content → nothing to do.
    //
    // The pool is read ASCENDING FROM THE WATERMARK — never a newest-window slice:
    // with a backlog wider than any window, a newest-anchored read would start the
    // chunk mid-history and the advanced watermark would silently mark everything
    // older as covered (codex P2: content neither summarized nor rehydrated). The
    // index range is on _creationTime with a slack for queued rows (their
    // effectiveOrder — orderTime — trails their _creationTime by minutes at most);
    // the exact cut is the effectiveOrder filter below.
    const children = await loadChildResults(ctx, chatId);
    const newestProbe = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(80);
    const newestUsable = usableTurnsDesc(newestProbe, watermark, children);
    // The size-based tail must weigh the ENRICHED content (a child digest in the
    // newest turns is fresh content).
    const tailCount = freshTailCount(
      newestUsable.map((m) => ({ text: enrichedTurnText(m, children) })),
    );
    if (newestUsable.length <= tailCount) return "nothing_to_do"; // nothing beyond the fresh tail
    const cutoffOrder = effectiveOrder(newestUsable[tailCount - 1]!);
    // The index range is on _creationTime but coverage is tracked by LOGICAL order:
    // a queued follow-up's _creationTime precedes its orderTime by its PARK time.
    // The slack must exceed any realistic park (queue drains are watchdog-bounded;
    // hours-long parks are already pathological) or a long-parked turn older than
    // the slack would be skipped forever (codex P2). A >6h park remains an accepted
    // residual, traded against re-reading slack-window rows on every job.
    const QUEUED_CREATION_SLACK_MS = 6 * 60 * 60 * 1000;
    // PAGED scan: a wide slack (or a dense already-covered region) can fill a
    // single read window with covered rows — filtered empty, the engine would
    // re-read the same window forever (stall). Page the cursor past covered
    // regions (bounded: MAX_PAGES × window per attempt).
    const MAX_PAGES = 6;
    // Resume from the PERSISTED floor: a covered region wider than one attempt's
    // page budget is crossed CUMULATIVELY across attempts instead of re-scanned
    // from scratch every time (which would stall the engine forever — codex P2).
    const baseFloor = watermark > 0 ? watermark - QUEUED_CREATION_SLACK_MS : 0;
    const priorFloor = row?.scanFloorCreationTime ?? 0;
    let cursor = Math.max(baseFloor, priorFloor);
    // A page may only advance the persisted floor when EVERY row in it is safe to
    // skip forever: settled AND (not a summarizable turn OR already covered). A
    // streaming row (text still coming) or an uncovered turn blocks the advance.
    const safeToSkip = (
      m: (typeof newestProbe)[number],
      idx: ChildResultsIndex,
    ): boolean =>
      m.status !== "streaming" &&
      // A parent whose sub-agent is still RUNNING is NOT safe: its content
      // arrives later — advancing the floor past it would orphan the result
      // behind the persistent cursor forever (codex P2).
      !idx.unsettled.has(m._id as string) &&
      !(
        (m.role === "user" || m.role === "assistant") &&
        (m.text.trim().length > 0 ||
          (idx.byMsg.get(m._id as string)?.length ?? 0) > 0) &&
        m.status === "complete" &&
        effectiveOrder(m) > watermark
      );
    let floorCandidate: number | null = null;
    let poolUnsorted: typeof newestProbe = [];
    let pageFull = false;
    // The children index for the page the POOL came from (page-ranged: reaches
    // the children of OLD parents beyond the global newest window — codex P2).
    let pageChildren: ChildResultsIndex = children;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) =>
          q.eq("chatId", chatId).gt("_creationTime", cursor),
        )
        .order("asc")
        .take(CHUNK_READ_WINDOW);
      pageFull = rows.length === CHUNK_READ_WINDOW;
      pageChildren =
        rows.length > 0
          ? await loadChildResults(ctx, chatId, {
              fromMs: rows[0]!._creationTime,
              toMs: rows[rows.length - 1]!._creationTime,
            })
          : children;
      poolUnsorted = rows.filter(
        (m) =>
          m.status === "complete" &&
          (m.role === "user" || m.role === "assistant") &&
          (m.text.trim().length > 0 ||
            (pageChildren.byMsg.get(m._id as string)?.length ?? 0) > 0) &&
          effectiveOrder(m) > watermark &&
          effectiveOrder(m) < cutoffOrder,
      );
      const allSafe = rows.every((m) => safeToSkip(m, pageChildren));
      if (poolUnsorted.length === 0 && pageFull && allSafe) {
        floorCandidate = rows[rows.length - 1]!._creationTime;
      }
      if (poolUnsorted.length > 0 || !pageFull) break;
      // A full pool-less page holding an UNSAFE row (streaming turn / running
      // child): STOP — advancing the cursor would let a later page's chunk move
      // the watermark past unsettled content, losing it forever (codex P2). The
      // unsafe row's settle re-triggers the engine.
      if (!allSafe) break;
      cursor = rows[rows.length - 1]!._creationTime;
    }
    // Persist the crossed covered region (monotonic) even when nothing dispatches,
    // so the NEXT attempt resumes past it.
    if (floorCandidate !== null && floorCandidate > priorFloor) {
      if (row) {
        await ctx.db.patch(row._id, { scanFloorCreationTime: floorCandidate });
      } else {
        await ctx.db.insert("chatSummaries", {
          chatId,
          summary: "",
          watermarkOrderTime: 0,
          coveredCount: 0,
          updatedAt: now,
          failureCount: 0,
          nextEligibleAt: 0,
          scanFloorCreationTime: floorCandidate,
        });
      }
    }
    const chunkPoolChrono = poolUnsorted
      // LOGICAL order, not _creationTime: a queued follow-up's orderTime trails
      // its _creationTime — unsorted, the prompt would be out of order AND
      // watermarkTarget (the last element) could sit BELOW an included message's
      // order, re-summarizing it next job (codex P2).
      .sort(compareOrder);
    if (chunkPoolChrono.length === 0) {
      // The scan ADVANCED through a covered region but hit the page budget before
      // reaching unsummarized content: continue IMMEDIATELY (strictly monotonic
      // floor -> bounded chain), or convergence would need one conversation turn
      // per 6 pages (codex P2). Carries the manual flag through.
      if (floorCandidate !== null && floorCandidate > priorFloor && pageFull) {
        await ctx.scheduler.runAfter(
          0,
          internal.chatSummaries.maybeScheduleSummarize,
          { chatId, manual: opts.manual },
        );
        return "scanning";
      }
      return "nothing_to_do";
    }
    const chunkMsgs: Doc<"messages">[] = [];
    const chunkLines: string[] = [];
    let chunkChars = 0;
    // UNCAPPED backlog volume — the trigger gate compares against THIS (the same
    // quantity the panel gauge shows), never against the per-job-capped chunk: a
    // threshold above CHUNK_MAX_CHARS could otherwise never be reached and the
    // auto path would stall despite a huge backlog (codex P2). The chunk itself
    // stays bounded; a large backlog converges over several jobs.
    let backlogChars = 0;
    for (const m of chunkPoolChrono) {
      if (pageChildren.unsettled.has(m._id as string)) break;
      backlogChars += renderTurn(m, pageChildren).length + 1;
    }
    for (const m of chunkPoolChrono) {
      // A turn whose sub-agent is STILL RUNNING is not settled: summarizing it
      // now would advance the watermark past content that arrives later — stop
      // the chunk (and the watermark) right before it; the child's settle
      // triggers a later job that picks it up complete.
      if (pageChildren.unsettled.has(m._id as string)) break;
      let line = renderTurn(m, pageChildren);
      if (chunkMsgs.length > 0 && chunkChars + line.length + 1 > CHUNK_MAX_CHARS)
        break;
      // A SINGLE turn larger than the whole per-job bound would otherwise ride
      // unbounded (the always-keep-one rule) — truncate its RENDER so every job
      // stays bounded (codex P2). Its tail is lost from the summary, like any
      // other clamped surface; the watermark still advances past it.
      if (chunkMsgs.length === 0 && line.length > CHUNK_MAX_CHARS) {
        line = `${line.slice(0, CHUNK_MAX_CHARS - 1)}…`;
      }
      chunkMsgs.push(m);
      chunkLines.push(line);
      chunkChars += line.length + 1;
    }
    // The minimum-content gate protects SHORT chats from pointless jobs — but when
    // the read WINDOW came back full, the backlog extends beyond it: dispatching a
    // sub-minimum chunk is then required, or the same window is re-read forever and
    // the watermark never advances (codex P2: many-short-messages stall).
    const windowFull = pageFull;
    // The MANUAL path skips the volume threshold: the user asked for a summary of
    // whatever is there now. The AUTO threshold is admin-tunable per instance
    // (Défauts de chat), bounded by lib/instanceConfig.
    const thresholdChars =
      instance?.config?.summarizeThresholdChars ?? CHUNK_MIN_CHARS;
    if (!opts.manual && backlogChars < thresholdChars && !windowFull)
      return "nothing_to_do";
    // The chunk can be EMPTY despite a non-empty pool (its first turn's sub-agent
    // is still running) — a manual/window-full bypass would otherwise crash on
    // the last-message read below (codex P2).
    if (chunkMsgs.length === 0) return "nothing_to_do";

    // The admin may grant a DEDICATED summarizer agent (type "summarizer") on the
    // chat's instance — it then owns the summary jobs (its system prompt can carry
    // a tailored briefing). Fallback: the chat's own agent (content stays within a
    // boundary it already crossed). Same-instance is REQUIRED either way.
    const dedicated = await resolveSummarizerTarget(
      ctx,
      chat.userId,
      boundInstance,
    );
    const target = dedicated ?? {
      instanceName: boundInstance,
      agentId: boundAgent,
    };
    const hidden = await ensureSummarizerChat(ctx, chat.userId, target, now);
    // Re-check the lock on the (possibly just-created) hidden row — `first()` above
    // and `ensureSummarizerChat` read the same row, so this is belt-and-braces
    // against a concurrent scheduler; OCC on the patch below serializes writers.
    if (hidden.pendingSummarize) return "in_flight";
    // Retention hygiene: the previous job's prompt/reply (conversation-excerpt
    // COPIES) are settled — purge them before this job writes its own rows.
    await cleanupHiddenChatContent(ctx, hidden._id);

    const template = effectiveTemplate("history_summary", injection);
    const text = fillTemplate(template, {
      previous_summary:
        row && row.summary.length > 0 ? row.summary : "(aucun — première synthèse)",
      new_messages: chunkLines.join("\n"),
      max_chars: String(SUMMARY_MAX_CHARS),
    });

    const last = chunkMsgs[chunkMsgs.length - 1]!;
    const msgId = await ctx.db.insert("messages", {
      chatId: hidden._id,
      userId: chat.userId,
      role: "user" as const,
      status: "complete" as const,
      text,
      updatedAt: now,
    });
    // FRESH gateway session per job (openclawChatId rotation — the documentary
    // lesson: a reused hidden session accumulates every prior job's content) +
    // rebind the hidden chat to THIS job's agent + set the job lock.
    await ctx.db.patch(hidden._id, {
      instanceName: target.instanceName,
      agentId: target.agentId,
      pendingSummarize: {
        targetChatId: chatId,
        watermarkTarget: effectiveOrder(last),
        coveredCountTarget: (row?.coveredCount ?? 0) + chunkMsgs.length,
        createdAt: now,
      },
      openclawChatId: `summarize:${chatId}:${now}`,
      updatedAt: now,
    });
    const outboxId = await ctx.db.insert("outbox", {
      chatId: hidden._id,
      userId: chat.userId,
      clientMessageId: `chatsum-${chatId}-${now}`,
      messageId: msgId,
      text,
      attachmentIds: [],
      status: "pending" as const,
    });
    await ctx.scheduler.runAfter(0, internal.bridge.dispatch, { outboxId });

    // SOC2-safe lifecycle trace: counts + opaque ids only, never message text.
    try {
      await writeTraceEvent(ctx, {
        kind: "chat.summary",
        direction: "internal",
        principalType: "user",
        principalId: chat.userId,
        chatId,
        correlationId: summaryCorrelationId(chatId, now),
        meta: JSON.stringify({
          op: "dispatch",
          hiddenChatId: hidden._id,
          chunkMessages: chunkMsgs.length,
          chunkChars,
          coveredCountTarget: (row?.coveredCount ?? 0) + chunkMsgs.length,
          firstSummary: !row || row.summary.length === 0,
        }),
      });
    } catch {
      // trace failure is never allowed to fail the schedule
    }
    return "dispatched";
}

/**
 * Called from stream.finalize when a `kind:"summarizer"` chat's assistant message
 * reaches a terminal status (the same hook + late-finalize guard as the documentary
 * correlate). Success → store the summary + advance the watermark; error/aborted/
 * empty → failure backoff. Always clears the job lock.
 */
export async function correlateSummarize(
  ctx: MutationCtx,
  hiddenChat: Doc<"chats">,
  message: Doc<"messages">,
): Promise<boolean> {
  const job = hiddenChat.pendingSummarize;
  if (!job) return false;
  // DETERMINISTIC job identity: the reply's turn ran under the job's rotated
  // openclawChatId (embedded in the echoed session key). A LATE reply of a
  // CANCELLED job whose row was created after the CURRENT job locked would pass a
  // purely time-based guard and settle the WRONG job with a summary of deleted
  // content (codex P2) — the nonce match cannot. Fallback for a pre-echo bridge
  // (no turnSessionKey): the legacy creation-time guard.
  const nonce = summarizeSessionNonce(job.targetChatId, job.createdAt);
  // NONCE OR NOTHING: a reply without the echoed session key can never settle a
  // job (the engine only dispatches against echo-capable bridges, so a missing
  // key here IS a foreign/legacy reply — a time-based fallback could settle the
  // wrong job during a rolling upgrade; codex P2).
  const identified =
    typeof message.turnSessionKey === "string" &&
    message.turnSessionKey.endsWith(`:${nonce}`);
  if (!identified) return false; // foreign/orphan reply: NEVER settles this job
  const now = Date.now();
  await ctx.db.patch(hiddenChat._id, { pendingSummarize: undefined });

  const target = await ctx.db.get(job.targetChatId);
  const row = target
    ? await ctx.db
        .query("chatSummaries")
        .withIndex("by_chat", (q) => q.eq("chatId", job.targetChatId))
        .unique()
    : null;
  if (!target) {
    // Target chat deleted mid-job: nothing to store, but the hidden chat still
    // holds the job's prompt + this reply (copies of the DELETED conversation) —
    // sweep them now; the deletion-time purge only saw settled rows (codex P2).
    await ctx.scheduler.runAfter(
      0,
      internal.chatSummaries.cleanupSummarizerChat,
      { hiddenChatId: hiddenChat._id },
    );
    return true;
  }

  const text = message.status === "complete" ? message.text.trim() : "";
  const ok = text.length > 0;
  if (ok) {
    const summary = clampSummary(text);
    // The producing agent = the hidden chat's binding for THIS job (set at
    // dispatch; jobs serialize, so it cannot have been rebound mid-flight).
    const producer = {
      lastAgentId: hiddenChat.agentId,
      lastInstanceName: hiddenChat.instanceName,
    };
    if (row) {
      await ctx.db.patch(row._id, {
        summary,
        watermarkOrderTime: job.watermarkTarget,
        coveredCount: job.coveredCountTarget,
        updatedAt: now,
        failureCount: 0,
        nextEligibleAt: now,
        ...producer,
      });
    } else {
      await ctx.db.insert("chatSummaries", {
        chatId: job.targetChatId,
        summary,
        watermarkOrderTime: job.watermarkTarget,
        coveredCount: job.coveredCountTarget,
        updatedAt: now,
        failureCount: 0,
        nextEligibleAt: now,
        ...producer,
      });
    }
  } else {
    await recordSummarizeFailure(
      ctx,
      job.targetChatId,
      now,
      `finalize_${message.status}`,
      job.createdAt,
    );
  }
  try {
    await writeTraceEvent(ctx, {
      kind: "chat.summary",
      direction: "internal",
      principalType: "user",
      principalId: hiddenChat.userId,
      chatId: job.targetChatId,
      correlationId: summaryCorrelationId(job.targetChatId, job.createdAt),
      meta: JSON.stringify(
        ok
          ? {
              op: "correlate",
              summaryChars: Math.min(text.length, SUMMARY_MAX_CHARS),
              coveredCount: job.coveredCountTarget,
            }
          : { op: "fail", reason: `finalize_${message.status}` },
      ),
    });
  } catch {
    // best-effort trace
  }
  // Retention hygiene: sweep the settled job rows (prompt + this reply) OUTSIDE the
  // reply's own finalize transaction. Skipped inside if a new job re-locked.
  await ctx.scheduler.runAfter(0, internal.chatSummaries.cleanupSummarizerChat, {
    hiddenChatId: hiddenChat._id,
  });
  if (ok) {
    // A backlog wider than one chunk converges over SEVERAL jobs — re-evaluate now
    // (guard-quiet: stops when the remainder is below the threshold) instead of
    // waiting for the next user turn (codex P2).
    await ctx.scheduler.runAfter(
      0,
      internal.chatSummaries.maybeScheduleSummarize,
      { chatId: job.targetChatId },
    );
  }
  return true;
}

/**
 * Release a summarize job whose turn failed OUTSIDE finalize (dispatch failure) or
 * was declared stuck by the watchdog. Clears the lock + applies the failure backoff
 * so the engine retries later instead of hammering. Best-effort (callers wrap).
 */
export async function failSummarizeForChat(
  ctx: MutationCtx,
  hiddenChat: Doc<"chats">,
  reason: "dispatch_error" | "stuck_stream",
): Promise<void> {
  const job = hiddenChat.pendingSummarize;
  if (!job) return;
  const now = Date.now();
  await ctx.db.patch(hiddenChat._id, { pendingSummarize: undefined });
  await recordSummarizeFailure(ctx, job.targetChatId, now, reason, job.createdAt);
  try {
    await writeTraceEvent(ctx, {
      kind: "chat.summary",
      direction: "internal",
      principalType: "user",
      principalId: hiddenChat.userId,
      chatId: job.targetChatId,
      correlationId: summaryCorrelationId(job.targetChatId, job.createdAt),
      meta: JSON.stringify({ op: "fail", reason }),
    });
  } catch {
    // best-effort trace
  }
  await ctx.scheduler.runAfter(0, internal.chatSummaries.cleanupSummarizerChat, {
    hiddenChatId: hiddenChat._id,
  });
}

/** Consecutive failures before the streak is escalated as an ANOMALY (admins get a
 *  bell notification + the /settings/anomalies entry; a single blip never alerts).
 *  Reported EXACTLY at the threshold — once per streak; a success resets the count
 *  and a NEW streak can escalate again. */
export const SUMMARY_FAILURE_ANOMALY_THRESHOLD = 3;

async function recordSummarizeFailure(
  ctx: MutationCtx,
  targetChatId: Id<"chats">,
  now: number,
  reason: string,
  jobCreatedAt: number,
): Promise<void> {
  const row = await ctx.db
    .query("chatSummaries")
    .withIndex("by_chat", (q) => q.eq("chatId", targetChatId))
    .unique();
  let failureCount = 1;
  if (row) {
    failureCount = row.failureCount + 1;
    await ctx.db.patch(row._id, {
      failureCount,
      nextEligibleAt: now + summaryBackoffMs(failureCount),
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("chatSummaries", {
      chatId: targetChatId,
      summary: "",
      watermarkOrderTime: 0,
      coveredCount: 0,
      updatedAt: now,
      failureCount: 1,
      nextEligibleAt: now + summaryBackoffMs(1),
    });
  }
  // Streak escalation -> anomaly + admin notification (existing pipeline). Content-
  // free evidence: opaque ids, counts, reason codes — never conversation text.
  if (failureCount === SUMMARY_FAILURE_ANOMALY_THRESHOLD) {
    try {
      await ctx.runMutation(internal.anomalies.reportAnomalyInternal, {
        kind: "chat.summary_failing",
        severity: "warn",
        message:
          `Le moteur de synthèse d'historique échoue en boucle pour une conversation ` +
          `(${failureCount} échecs consécutifs, dernière raison : ${reason}). ` +
          `La réhydratation retombe sur l'historique verbatim tronqué pour ce chat.`,
        correlationId: summaryCorrelationId(targetChatId, jobCreatedAt),
        evidence: JSON.stringify({
          chatId: targetChatId,
          failureCount,
          reason,
        }),
      });
    } catch (e) {
      console.error("[chatsum] anomaly report failed:", (e as Error)?.message ?? e);
    }
  }
}

/**
 * Invalidation on message deletion. Two independent hazards (codex P2):
 *  - STORED summary: a delete at-or-before the stored watermark makes the summary
 *    describe content that no longer exists → RESET the row (the engine rebuilds).
 *  - IN-FLIGHT job: a delete at-or-before the job's watermarkTarget poisons the
 *    chunk it is summarizing (and, when the stored row was reset above, its
 *    {previous_summary} baseline too) → RELEASE the lock so the late reply
 *    correlates against nothing and is dropped. The stored row stays valid when
 *    the delete only reaches the in-flight range.
 * Deletes strictly after both marks are outside any coverage — nothing to do.
 * Best-effort (caller wraps).
 */
export async function invalidateSummaryOnDeletion(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
  deletedEffectiveOrder: number,
): Promise<void> {
  const row = await ctx.db
    .query("chatSummaries")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .unique();
  if (
    row &&
    row.watermarkOrderTime > 0 &&
    deletedEffectiveOrder <= row.watermarkOrderTime
  ) {
    await ctx.db.patch(row._id, {
      summary: "",
      watermarkOrderTime: 0,
      coveredCount: 0,
      updatedAt: Date.now(),
      // The floor derives from the watermark's coverage — reset together.
      scanFloorCreationTime: 0,
    });
  }
  const hidden = await ctx.db
    .query("chats")
    .withIndex("by_user_kind", (q) =>
      q.eq("userId", userId).eq("kind", "summarizer"),
    )
    .first();
  if (
    hidden?.pendingSummarize?.targetChatId === chatId &&
    deletedEffectiveOrder <= hidden.pendingSummarize.watermarkTarget
  ) {
    await ctx.db.patch(hidden._id, { pendingSummarize: undefined });
    // The poisoned job's prompt holds COPIES of the now-deleted content. Purge its
    // settled rows and cancel an undispatched outbox row so it never reaches the
    // agent (codex P1). A turn already streaming on the gateway can't be unsent —
    // its rows settle and the next dispatch's cleanup sweeps them.
    await cleanupHiddenChatContent(ctx, hidden._id);
  }
}

/**
 * The chat OWNER's view of their rolling summary (Réglages de session ▸ Synthèse).
 * The summary is the user's own conversation content — full text is theirs to see.
 * Tolerant contract (null, never throws) like messages.getSessionMeta: a deleted/
 * foreign chatId renders the section empty instead of crashing the panel.
 */
export const getChatSummary = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const chat = await ctx.db.get(chatId);
    if (!chat || chat.userId !== userId) return null;
    const row = await ctx.db
      .query("chatSummaries")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
    // A summarize job currently running FOR THIS CHAT (reactive: the panel shows
    // "synthèse en cours…" and flips when the correlate lands).
    const hidden = await ctx.db
      .query("chats")
      .withIndex("by_user_kind", (q) =>
        q.eq("userId", userId).eq("kind", "summarizer"),
      )
      .first();
    const jobInFlight = hidden?.pendingSummarize?.targetChatId === chatId;
    // Processing indicators: when the job started, and whether the summarizer's
    // reply is actively STREAMING (vs dispatched-and-waiting). One bounded read.
    let jobStreaming = false;
    if (jobInFlight && hidden) {
      const newest = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", hidden._id))
        .order("desc")
        .take(3);
      jobStreaming = newest.some((m) => m.status === "streaming");
    }
    // GAUGE data: how much unsummarized content has accumulated vs the AUTO
    // trigger threshold. Bounded newest-window approximation (the exact engine
    // scan pages further): good enough for a progress bar; `pendingApprox` marks
    // a full window (the real backlog may be larger).
    const watermark =
      row !== null && row.summary.length > 0 ? row.watermarkOrderTime : 0;
    const GAUGE_READ = 240;
    const probe = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(GAUGE_READ);
    const gaugeChildren = await loadChildResults(ctx, chatId);
    const usable = probe
      .filter(
        (m) =>
          m.status === "complete" &&
          (m.role === "user" || m.role === "assistant") &&
          (m.text.trim().length > 0 ||
            (gaugeChildren.byMsg.get(m._id as string)?.length ?? 0) > 0) &&
          effectiveOrder(m) > watermark,
      )
      .sort(
        (a, b) =>
          effectiveOrder(b) - effectiveOrder(a) ||
          b._creationTime - a._creationTime,
      );
    const enriched = usable.map((m) => ({
      text: enrichedTurnText(m, gaugeChildren),
    }));
    let pendingChars = 0;
    for (const t of enriched.slice(freshTailCount(enriched))) {
      pendingChars += t.text.length + 14; // + role label overhead
    }
    // Resolve the SAME instance the engine will use (an unbound/legacy chat
    // falls back to the default agent's instance) so the displayed threshold
    // matches the trigger behavior (codex P3).
    let gaugeInstance = chat.instanceName ?? null;
    if (!gaugeInstance) {
      const res = await resolveTargetForChat(ctx, chat, userId);
      gaugeInstance = res.target?.instanceName ?? null;
    }
    let thresholdChars: number = CHUNK_MIN_CHARS;
    if (gaugeInstance) {
      const instance = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", gaugeInstance))
        .first();
      thresholdChars =
        instance?.config?.summarizeThresholdChars ?? CHUNK_MIN_CHARS;
    }
    return {
      summary: row?.summary ?? "",
      coveredCount: row?.coveredCount ?? 0,
      updatedAt: row?.updatedAt ?? 0,
      failureCount: row?.failureCount ?? 0,
      nextEligibleAt: row?.nextEligibleAt ?? 0,
      lastAgentId: row?.lastAgentId ?? null,
      lastInstanceName: row?.lastInstanceName ?? null,
      jobInFlight,
      jobStartedAt: jobInFlight
        ? (hidden?.pendingSummarize?.createdAt ?? null)
        : null,
      jobStreaming,
      pendingChars,
      thresholdChars,
      pendingApprox: probe.length === GAUGE_READ,
    };
  },
});

/**
 * Owner edit of the rolling summary (Réglages de session ▸ Synthèse ▸ Modifier).
 * The summary is the user's own content — an edit REFINES the text and FEEDS
 * FORWARD: it becomes {previous_summary} for the next summarize job. Coverage
 * (watermark/coveredCount) is untouched — the edit rewords what is covered, it
 * does not change WHAT is covered. Refused while a job is in flight (its reply
 * would immediately overwrite the edit) and when no summary exists yet.
 */
export const updateSummary = mutation({
  args: { chatId: v.id("chats"), summary: v.string() },
  handler: async (ctx, { chatId, summary }) => {
    const { userId } = await requireActive(ctx);
    const chat = await ctx.db.get(chatId);
    if (!chat || chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }
    const text = summary.trim();
    if (text.length === 0) {
      throw new Error("Invalid: empty summary");
    }
    const hidden = await ctx.db
      .query("chats")
      .withIndex("by_user_kind", (q) =>
        q.eq("userId", userId).eq("kind", "summarizer"),
      )
      .first();
    if (hidden?.pendingSummarize?.targetChatId === chatId) {
      throw new Error("Conflict: a summarize job is in flight");
    }
    const row = await ctx.db
      .query("chatSummaries")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .unique();
    if (!row || row.summary.length === 0) {
      throw new Error("Invalid: no summary to edit");
    }
    await ctx.db.patch(row._id, {
      summary: clampSummary(text),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Chat deletion: purge the summary row; release the hidden chat's job lock when the
 *  deleted chat was the in-flight target. Best-effort (caller wraps). */
export async function purgeSummaryForChat(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
): Promise<void> {
  const row = await ctx.db
    .query("chatSummaries")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .unique();
  if (row) await ctx.db.delete(row._id);
  const hidden = await ctx.db
    .query("chats")
    .withIndex("by_user_kind", (q) =>
      q.eq("userId", userId).eq("kind", "summarizer"),
    )
    .first();
  if (hidden?.pendingSummarize?.targetChatId === chatId) {
    // The in-flight job served the DELETED chat: release + purge its rows.
    await ctx.db.patch(hidden._id, { pendingSummarize: undefined });
    await cleanupHiddenChatContent(ctx, hidden._id);
  } else if (hidden && !hidden.pendingSummarize) {
    // No live job: sweep settled leftovers (may include this chat's old copies).
    await cleanupHiddenChatContent(ctx, hidden._id);
  }
  // A live job for ANOTHER chat: leave its rows alone — sweeping them would kill
  // its undispatched outbox while the lock stays set, wedging the user's
  // summarizer forever (codex P2). Its own settle sweeps later.
}
