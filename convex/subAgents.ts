// Sub-agent observation store (increment 1 of the sub-agent monitor).
//
// The bridge OBSERVES the child runs a chat's agent spawns via the gateway
// `sessions_spawn` tool (inbound only — it never changes what Atrium sends) and
// upserts one `subAgents` row per child, keyed by `childSessionKey`. This module
// owns the two seams:
//   - `upsertSubAgent`  (internalMutation): the bridge ingest write. Upsert by
//     childSessionKey — insert on first sight, patch status/result/phase after.
//   - `listSubAgents`   (public query): OWNER-SCOPED read of a chat's sub-agent
//     rows, for the (later) UI. The query is the per-user isolation boundary.
//
// SECURITY: `upsertSubAgent` is an internalMutation — NOT callable from a browser
// or the public client; the bridge reaches it through the authenticated
// `POST /bridge/ingest` httpAction (see convex/bridge_ingest.ts). `listSubAgents`
// is public but goes through `requireOwnedChat`, so a caller only ever sees their
// own chats' sub-agents.

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { postBridge } from "./agentFiles";
import type { Id } from "./_generated/dataModel";
import { requireActive, requireOwnedChat } from "./lib/access";
import { drainNextQueued, SUBAGENT_STALE_TTL_MS } from "./lib/outboxQueue";
import { deliveryChildKey } from "./lib/deliveryRuns";

/** Bounded reaper batch (mirrors stuckStreams.BATCH) — running rows are few. */
const REAP_BATCH = 50;
// User-visible (monitor) reason for a reaped child, shown as its errorMessage. FR
// (the app is mono-lingual); short + content-free — no path/blob/PHI.
const STALE_SUBAGENT_MESSAGE =
  "Sous-agent expiré — aucune activité, observateur probablement perdu";

const STATUS = v.union(
  v.literal("running"),
  v.literal("done"),
  v.literal("error"),
  v.literal("aborted"),
);

/** The child's STATIC session config (model / reasoning / speed / scope). CONFIG, not
 *  content — SOC2-safe (the obs MCP may surface these). NO live telemetry here. */
const SESSION_META = v.object({
  model: v.optional(v.string()),
  modelProvider: v.optional(v.string()),
  thinkingLevel: v.optional(v.string()),
  fastMode: v.optional(v.boolean()),
  controlScope: v.optional(v.string()),
  subagentRole: v.optional(v.string()),
  spawnDepth: v.optional(v.number()),
  context: v.optional(v.string()),
  runtime: v.optional(v.string()),
  mode: v.optional(v.string()),
  cleanup: v.optional(v.string()),
  sandbox: v.optional(v.string()),
  gatewayKind: v.optional(v.string()),
  // Extended spawn args + child session statics (see bridge SubAgentSessionMeta).
  label: v.optional(v.string()),
  cwd: v.optional(v.string()),
  agentId: v.optional(v.string()),
  lightContext: v.optional(v.boolean()),
  sessionId: v.optional(v.string()),
  spawnedWorkspaceDir: v.optional(v.string()),
});
export type SubAgentSessionMeta = {
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  controlScope?: string;
  subagentRole?: string;
  spawnDepth?: number;
  context?: string;
  runtime?: string;
  mode?: string;
  cleanup?: string;
  sandbox?: string;
  gatewayKind?: string;
  label?: string;
  cwd?: string;
  agentId?: string;
  lightContext?: boolean;
  sessionId?: string;
  spawnedWorkspaceDir?: string;
};

// Run telemetry (runtime/tokens/cost) — content-free numbers, written by the bridge
// only on already-scheduled upserts (heartbeat/terminal), never per-tick.
const TELEMETRY = v.object({
  runtimeMs: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  estimatedCostUsd: v.optional(v.number()),
  startedAt: v.optional(v.number()),
});
export type SubAgentTelemetry = {
  runtimeMs?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  startedAt?: number;
};

/** Terminal child lifecycle states (no longer holding the chat — see isChatBusy). */
function isTerminalStatus(status: string): boolean {
  return status === "done" || status === "error" || status === "aborted";
}

/** One captured child tool: NAME + lifecycle status only (SOC2 — never args/results). */
export type SubAgentTool = {
  name: string;
  status: "running" | "done";
  toolCallId?: string;
};

/**
 * Merge an incoming child-tool list into the stored one, REORDER-TOLERANT (the
 * observer fires upserts off any ordering chain): dedupe by toolCallId (else name),
 * keep the first-seen ORDER, and let "done" win over "running" so a late
 * earlier-running frame never un-finishes a tool that already completed. Exported
 * for unit tests (the upsert's reorder-tolerance is the whole point).
 */
export function mergeSubAgentTools(
  existing: SubAgentTool[] | undefined,
  incoming: SubAgentTool[] | undefined,
): SubAgentTool[] | undefined {
  if (incoming === undefined) return existing;
  const out: SubAgentTool[] = [];
  const at = new Map<string, number>();
  const keyOf = (t: SubAgentTool): string => t.toolCallId ?? `name:${t.name}`;
  for (const t of existing ?? []) {
    at.set(keyOf(t), out.length);
    out.push({ ...t });
  }
  for (const t of incoming) {
    const k = keyOf(t);
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, out.length);
      out.push({ ...t });
    } else if (t.status === "done") {
      out[i] = { ...out[i], name: t.name, status: "done" };
    }
  }
  return out;
}

/**
 * Upsert a sub-agent observation by `childSessionKey`.
 *
 * INSERT on first sight (carries chatId + taskName + parentMessageId from the
 * spawn registration); PATCH on every later child frame (status/result/phase +
 * updatedAt). The bridge fires these best-effort and off any per-message ordering
 * chain, so they may arrive slightly out of order — hence two guards that make the
 * upsert reorder-tolerant:
 *   - STATUS REGRESSION: a terminal status (`done`/`error`) is never downgraded
 *     back to `running` (a late spawn-registration must not un-finalize a child
 *     that already reported its `chat:final`).
 *   - PHASE on terminal: once terminal, a stale `phase` update is ignored.
 * Fields are only overwritten when the caller actually supplies them, so a
 * phase-only update never wipes a taskName learned at registration.
 *
 * DISPATCH HOLD (A/B fix): a `running` row makes the chat BUSY (isChatBusy), so a
 * user's follow-up sent while a sub-agent runs is QUEUED, not mis-routed into the
 * yielded child. This upsert is the release valve: on any write that leaves the
 * child TERMINAL (done/error/aborted — incl. the observer's TTL watchdog), it
 * drains the held send (see maybeDrainOnTerminal). The drain is guarded, so the
 * LAST sub-agent to finish is the one that actually dispatches.
 */
export const upsertSubAgent = internalMutation({
  args: {
    chatId: v.id("chats"),
    parentMessageId: v.optional(v.id("messages")),
    childSessionKey: v.string(),
    kind: v.optional(v.union(v.literal("subagent"), v.literal("task"))),
    bornOfRun: v.optional(v.string()),
    taskName: v.optional(v.string()),
    status: STATUS,
    resultText: v.optional(v.string()),
    phase: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    tools: v.optional(
      v.array(
        v.object({
          name: v.string(),
          status: v.union(v.literal("running"), v.literal("done")),
          toolCallId: v.optional(v.string()),
        }),
      ),
    ),
    sessionMeta: v.optional(SESSION_META),
    telemetry: v.optional(TELEMETRY),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("childSessionKey", args.childSessionKey))
      .first();

    if (existing === null) {
      // Ignore an upsert for a chat that no longer exists (deleted mid-flight): a child frame
      // arriving after the chat was purged must NOT recreate an orphaned row holding chat
      // content (codex P1). A patch path can't reach here for a purged chat — the cascade
      // deletes its rows, so `existing` is null and this guard catches the re-insert.
      if ((await ctx.db.get(args.chatId)) === null) return null;
      const insertedId = await ctx.db.insert("subAgents", {
        chatId: args.chatId,
        parentMessageId: args.parentMessageId,
        childSessionKey: args.childSessionKey,
        kind: args.kind,
        bornOfRun: args.bornOfRun,
        taskName: args.taskName,
        status: args.status,
        resultText: args.resultText,
        phase: args.phase,
        errorMessage: args.errorMessage,
        tools: args.tools,
        sessionMeta: args.sessionMeta,
        telemetry: args.telemetry,
        createdAt: now,
        updatedAt: now,
      });
      // First-sight TERMINAL (a child observed already finished, e.g. it ended
      // before its spawn frame was ingested): the chat may have a send held behind
      // it — drain now. A first-sight `running` child holds the chat (no drain).
      await maybeDrainOnTerminal(ctx, args.chatId, args.status);
      return insertedId;
    }

    const terminal =
      existing.status === "done" ||
      existing.status === "error" ||
      existing.status === "aborted";
    const patch: {
      status?: "running" | "done" | "error" | "aborted";
      resultText?: string;
      phase?: string;
      errorMessage?: string;
      taskName?: string;
      tools?: SubAgentTool[];
      sessionMeta?: SubAgentSessionMeta;
      telemetry?: SubAgentTelemetry;
      parentMessageId?: typeof args.parentMessageId;
      kind?: "subagent" | "task";
      bornOfRun?: string;
      updatedAt: number;
    } = { updatedAt: now };
    // Fill-only metadata (never rewritten once set).
    if (args.kind !== undefined && existing.kind === undefined) {
      patch.kind = args.kind;
    }
    if (args.bornOfRun !== undefined && existing.bornOfRun === undefined) {
      patch.bornOfRun = args.bornOfRun;
    }
    // Never downgrade a terminal child back to running (reorder-tolerance).
    if (!(terminal && args.status === "running")) {
      patch.status = args.status;
    }
    // Overflow-recovery transition (error -> done): the gateway can abandon an
    // attempt with a chat:error, truncate tool results, resume the SAME run and
    // finish clean — the observer keeps observing and the real terminal lands
    // here. The stale provisional error must not linger on a SUCCEEDED child.
    const recoveredToDone =
      existing.status === "error" && patch.status === "done";
    if (args.resultText !== undefined) patch.resultText = args.resultText;
    if (args.errorMessage !== undefined) patch.errorMessage = args.errorMessage;
    else if (recoveredToDone && existing.errorMessage !== undefined) {
      // Explicit undefined => Convex removes the field.
      patch.errorMessage = undefined;
    }
    // Drop a stale phase update once the child is terminal.
    if (args.phase !== undefined && !terminal) patch.phase = args.phase;
    // Merge the child's tools (accumulates across frames — a finished child KEEPS
    // the tools it used, so merge even when terminal). Reorder-tolerant.
    if (args.tools !== undefined) {
      patch.tools = mergeSubAgentTools(existing.tools, args.tools);
    }
    // Merge the static session config last-known-non-null (a later frame without a
    // session object never wipes a captured field; the observer only sends it on a
    // real change, so this is a rare write).
    if (args.sessionMeta !== undefined) {
      patch.sessionMeta = { ...existing.sessionMeta, ...args.sessionMeta };
    }
    // Telemetry: last-write-wins while running; once terminal the FINAL numbers stand
    // (a stale straggler heartbeat must not roll runtime/tokens backwards) — unless
    // the terminal write carried none, then a late value is better than nothing.
    // The overflow-recovery done supersedes the provisional error's numbers: the
    // resumed run's terminal write carries the REAL final runtime/tokens/cost.
    if (args.telemetry !== undefined) {
      if (!terminal || recoveredToDone) {
        patch.telemetry = { ...existing.telemetry, ...args.telemetry };
      } else if (existing.telemetry === undefined) {
        patch.telemetry = args.telemetry;
      }
    }
    // Backfill identity fields only if not already set (registration carries them;
    // later child frames don't, so don't clobber).
    if (args.taskName !== undefined && existing.taskName === undefined) {
      patch.taskName = args.taskName;
    }
    if (
      args.parentMessageId !== undefined &&
      existing.parentMessageId === undefined
    ) {
      patch.parentMessageId = args.parentMessageId;
    }
    await ctx.db.patch(existing._id, patch);
    // The STORED status after this write: `patch.status` when we wrote one, else
    // the unchanged `existing.status` (the reorder guard dropped a late `running`
    // over a terminal row → it stays terminal). Drain when terminal so a follow-up
    // held behind this child dispatches the moment it goes done/error/aborted.
    // Hybrid rehydration: a child reaching a TERMINAL state may unblock the
    // summarize watermark (its parent was held back while it ran) AND its result
    // is fresh summarizable content — re-evaluate (scheduled, guard-quiet; codex
    // P2: without this the settle only mattered at the NEXT user turn).
    // The overflow-recovery transition (error -> done) is ALSO a summarizable
    // settle: the recovered child's resultText only lands now, and the summary
    // engine counts only done children — without this the recovered digest
    // never reaches summarization/rehydration until an unrelated later event.
    const settledNow =
      (patch.status !== undefined &&
        patch.status !== "running" &&
        existing.status === "running") ||
      recoveredToDone;
    if (settledNow) {
      await ctx.scheduler.runAfter(
        0,
        internal.chatSummaries.maybeScheduleSummarize,
        { chatId: existing.chatId },
      );
    }
    await maybeDrainOnTerminal(
      ctx,
      args.chatId,
      patch.status ?? existing.status,
    );
    return existing._id;
  },
});

/**
 * If `status` is terminal, attempt to drain the chat's held send. BARE (no
 * try/catch), matching bridge.failDispatch / stream.finalize: a transient drain
 * failure must roll back this whole upsert atomically so the bridge's idempotent
 * retry re-runs cleanly — never commit a terminal status while losing the drain
 * (which would strand a queued follow-up). `drainNextQueued` is itself
 * isChatBusy-guarded (so it no-ops while ANOTHER sub-agent is still running or a
 * turn is in flight) + OCC-safe + idempotent (so it never double-dispatches
 * against a concurrent turn-end drain). Hence "no remaining running sub-agent" is
 * enforced by the guard, not re-checked here.
 */
async function maybeDrainOnTerminal(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  status: string,
): Promise<void> {
  if (isTerminalStatus(status)) {
    await drainNextQueued(ctx, chatId);
  }
}

/**
 * REAPER for stale `running` sub-agent rows (scheduled by the cron in
 * convex/crons.ts). A running row gates isChatBusy, so a DEAD observer (dropped
 * terminal upsert / bridge restart / connection-close killing its in-memory TTL
 * watchdog) that never writes a terminal status would hold the chat — and queue
 * every future send — FOREVER. This terminalizes such rows out-of-band:
 *   - writes them `status: "error"` (the SAME terminal path a real failure takes),
 *     so the monitor surfaces a failed sub-agent the user SEES, AND
 *   - routes the release through maybeDrainOnTerminal (NOT a bespoke drain), so the
 *     send held behind the dead child dispatches FIFO via the existing drain.
 *
 * Bounded by the `by_status_updated` range read (only running rows older than the
 * stale TTL) + a batch cap; self-reschedules when a full batch is processed. All
 * stale rows are flipped BEFORE any per-chat drain so a chat with >1 stale child is
 * fully terminal before isChatBusy is re-evaluated (else the drain would see a
 * still-"running" sibling and skip — mirrors the stuck-stream watchdog). Idempotent:
 * the range matches only `running` rows, so a second pass never re-sees a reaped row
 * (no double-drain). A genuinely LIVE child has a fresh `updatedAt` → outside the
 * range → never touched.
 */
export const reapStaleSubAgents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - SUBAGENT_STALE_TTL_MS;
    // Task engagements are EXCLUDED from the 20-minute pass (long generations
    // are legitimate; their truth is the gateway registry + the client-side
    // reconciliation) — but they get a 24h SAFETY-NET pass below, so a task
    // whose delivery was lost on a gateway without tasks.get still expires
    // instead of spinning the indicator forever.
    const stale = await ctx.db
      .query("subAgents")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "running").lt("updatedAt", cutoff),
      )
      .filter((q) => q.neq(q.field("kind"), "task"))
      .take(REAP_BATCH);
    const taskCutoff = now - 24 * 60 * 60 * 1000;
    const staleTasks = await ctx.db
      .query("subAgents")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "running").lt("updatedAt", taskCutoff),
      )
      .filter((q) => q.eq(q.field("kind"), "task"))
      .take(REAP_BATCH);

    const touchedChats = new Set<Id<"chats">>();
    for (const row of stale) {
      await ctx.db.patch(row._id, {
        status: "error",
        errorMessage: STALE_SUBAGENT_MESSAGE,
        updatedAt: now,
      });
      touchedChats.add(row.chatId);
    }
    for (const row of staleTasks) {
      await ctx.db.patch(row._id, {
        status: "error",
        errorMessage: "background task expired (no delivery, unverifiable)",
        updatedAt: now,
      });
      touchedChats.add(row.chatId);
    }
    // Drain per touched chat AFTER all flips (see the head-of-line note above), via
    // the SAME terminal-drain the observer-driven terminal upsert uses.
    for (const chatId of touchedChats) {
      await maybeDrainOnTerminal(ctx, chatId, "error");
    }
    // A full batch likely means more stale rows remain; the ones handled are now
    // terminal, so the next range read can't re-see them (converges).
    if (stale.length === REAP_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.subAgents.reapStaleSubAgents,
        {},
      );
    }
    return { reaped: stale.length };
  },
});

/**
 * OWNER-SCOPED list of a chat's sub-agent observations, newest spawn first.
 * `requireOwnedChat` is the access boundary — a caller can only read their own
 * chats' rows. Returns [] for a chat with no sub-agents.
 */
/** Thread-level "the turn is still working" signal — INDEPENDENT of the Tools
 *  toggle (the clean view must show a spinner too). True while a sub-agent of
 *  this chat RUNS, and while a freshly-finished one has not yet been delivered
 *  back into a settled reply (child done AFTER the chat's last completed
 *  assistant stamp = the gateway is composing the announce). The client caps
 *  the delivering window locally (a NO_REPLY announce produces no new stamp). */
export const turnActivity = query({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{ running: boolean; deliveringSince: number | null }> => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    // RUNNING is exact whatever the chat's history: one indexed probe on
    // (chatId, status) — a long-lived child created before 50 newer
    // delegations must still hold the composer/spinner.
    const running =
      (await ctx.db
        .query("subAgents")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", chatId).eq("status", "running"),
        )
        .first()) !== null;
    // DELIVERING scans the recently-UPDATED terminal rows (bounded): a
    // finished child whose announce has not merged yet — including an ERROR
    // one (the observer keeps error children alive for the documented
    // error→done recovery, and failures announce too). by_chat_status_updated
    // orders by updatedAt, so a long-lived child that JUST finished is never
    // pushed out of the window by 20 younger siblings. Older-than-window rows
    // degrade to no-spinner — never to a wrong signal.
    const done = await ctx.db
      .query("subAgents")
      .withIndex("by_chat_status_updated", (q) =>
        q.eq("chatId", chatId).eq("status", "done"),
      )
      .order("desc")
      .take(20);
    const errored = await ctx.db
      .query("subAgents")
      .withIndex("by_chat_status_updated", (q) =>
        q.eq("chatId", chatId).eq("status", "error"),
      )
      .order("desc")
      .take(10);
    const rows = [...done, ...errored];
    // A child whose announce ALREADY merged is delivered — never "delivering",
    // whatever the write order (its detached terminal upsert can land AFTER
    // the merge settled, making updatedAt > lastSettle misleading). The merge
    // history carries the announce run ids, which embed the childSessionKey.
    const mergedRuns: string[] = [];
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(10);
    for (const m of recent) {
      if (m.runId !== undefined && deliveryChildKey(m.runId) !== null) {
        mergedRuns.push(m.runId);
      }
      for (const r of m.mergedAnnounceRuns ?? []) mergedRuns.push(r);
    }
    let deliveringSince: number | null = null;
    for (const r of rows) {
      // A background-task row's "delivery" is the run that settled it: when
      // it merged, mergedRuns above already covers it; when it was silent
      // (NO_REPLY), nothing will arrive — either way "delivering" would be a
      // false 45s indicator. Tasks only ever contribute to `running`.
      if (r.kind === "task") continue;
      // NO chat-level lastAssistantAt filter here: a NEWER user turn settling
      // after this child finished would mask a REAL in-flight delivery. The
      // per-row checks below (merged announce / parent finalized after the
      // child) are the correlated tests; stale never-announced terminals are
      // bounded by the client's display cap, not by the chat clock.
      // Announce already merged → delivered (write order can't fool this).
      // Task-delivery runs (`image_generate:<taskId>:ok`) do NOT contain the
      // row key (`task:<taskId>`) literally — resolve through the shared
      // correlation instead.
      if (
        mergedRuns.some(
          (run) =>
            run.includes(r.childSessionKey) ||
            deliveryChildKey(run) === r.childSessionKey,
        )
      ) {
        continue;
      }
      // The child's own PARENT message is the window-independent test: its
      // merge history (or its own announce runId) names this child even when
      // the parent scrolled beyond the recent-messages scan above. INLINE
      // delivery: the parent settled AFTER the child finished → the report
      // rode inside that turn, no announce will follow (a detached terminal
      // upsert landing late is the remaining race — the client's short
      // display cap bounds that residue). Anchor-less rows degrade to that
      // same cap.
      if (r.parentMessageId !== undefined) {
        const parentDoc = await ctx.db.get(r.parentMessageId);
        if (parentDoc !== null) {
          const parentRuns = [
            ...(parentDoc.runId !== undefined ? [parentDoc.runId] : []),
            ...(parentDoc.mergedAnnounceRuns ?? []),
          ];
          if (
            parentRuns.some(
              (run) =>
                run.startsWith("announce:") && run.includes(r.childSessionKey),
            )
          ) {
            continue;
          }
          if (
            parentDoc.finalizedAt !== undefined &&
            parentDoc.finalizedAt >= r.updatedAt
          ) {
            continue;
          }
        }
      }
      deliveringSince = Math.max(deliveringSince ?? 0, r.updatedAt);
    }
    return { running, deliveringSince };
  },
});

export const listSubAgents = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    const rows = await ctx.db
      .query("subAgents")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
    // Stable, useful order for a future UI: most-recently-spawned first.
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return rows;
  },
});

/**
 * Upsert one of a sub-agent's TOOL-CALL details (args + result) by
 * (childSessionKey, toolCallId). Kept in its OWN table (NOT the `subAgents.tools[]`
 * summary array) so a many-tool child does not re-push the whole array per write
 * (the streamingText write-amplification lesson). INSERT on first sight (usually the
 * `start` frame, args known); PATCH on the later `result`/`update` frame (status →
 * done/error, resultText set). Reorder-tolerant, mirroring `upsertSubAgent`:
 *   - a terminal status (done/error) is never downgraded back to running;
 *   - argsText/resultText are only overwritten when SUPPLIED, so a stale running
 *     frame that omits them never wipes a captured value.
 * Best-effort + off any ordering chain (the bridge fires it fire-and-forget).
 */
export const upsertSubAgentToolPart = internalMutation({
  args: {
    chatId: v.id("chats"),
    childSessionKey: v.string(),
    toolCallId: v.string(),
    name: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
    ),
    argsText: v.optional(v.string()),
    resultText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("subAgentToolParts")
      .withIndex("by_child_tool", (q) =>
        q
          .eq("childSessionKey", args.childSessionKey)
          .eq("toolCallId", args.toolCallId),
      )
      .first();

    if (existing === null) {
      // Don't recreate detail for a chat purged mid-flight (mirrors upsertSubAgent).
      if ((await ctx.db.get(args.chatId)) === null) return null;
      return await ctx.db.insert("subAgentToolParts", {
        chatId: args.chatId,
        childSessionKey: args.childSessionKey,
        toolCallId: args.toolCallId,
        name: args.name,
        status: args.status,
        argsText: args.argsText,
        resultText: args.resultText,
        updatedAt: now,
      });
    }

    const terminal = existing.status === "done" || existing.status === "error";
    const patch: {
      name: string;
      status?: "running" | "done" | "error";
      argsText?: string;
      resultText?: string;
      updatedAt: number;
    } = { updatedAt: now, name: args.name };
    if (!(terminal && args.status === "running")) patch.status = args.status;
    if (args.argsText !== undefined) patch.argsText = args.argsText;
    if (args.resultText !== undefined) patch.resultText = args.resultText;
    await ctx.db.patch(existing._id, patch);
    return existing._id;
  },
});

/**
 * OWNER-SCOPED detail of ONE sub-agent's tool calls (args + result), first-seen
 * order. The panel fetches this ON DEMAND when it opens a sub-agent (the Sources-
 * panel pattern) so the heavy per-tool content never rides the always-loaded
 * `listSubAgents`. `requireOwnedChat` is the access boundary; the result is further
 * filtered to this chat's rows (defense-in-depth, since a childSessionKey is a bare
 * UUID lane that does not embed the chatId).
 */
export const listSubAgentToolParts = query({
  args: { chatId: v.id("chats"), childSessionKey: v.string() },
  handler: async (ctx, { chatId, childSessionKey }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    const rows = await ctx.db
      .query("subAgentToolParts")
      .withIndex("by_child", (q) => q.eq("childSessionKey", childSessionKey))
      .collect();
    return rows
      .filter((r) => r.chatId === chatId)
      .sort((a, b) => a._creationTime - b._creationTime);
  },
});


// ===========================================================================
// Background-task engagement RECONCILIATION: verify pending `task:` rows
// against the gateway's task registry (tasks.get via the bridge) instead of
// expiring the thread indicator on a blind timeout. Fail-soft everywhere —
// an unreachable gateway or an unknown id leaves the local state untouched.
// ===========================================================================

/** The chat's RUNNING task engagements + bridge target, ownership-gated. */
export const pendingTaskEngagements = internalQuery({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{
    instanceName: string;
    bridgeUrl: string | null;
    taskIds: string[];
  } | null> => {
    const { userId } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    if (!chat.instanceName) return null;
    // Filter INSIDE the query so 20+ running sub-agent rows can never
    // saturate the batch before a task row is reached, and order by
    // updatedAt ASCENDING (by_chat_status_updated): each successful probe
    // refreshes updatedAt, pushing the row to the back — the batch ROTATES,
    // so a chat with more than 20 live tasks still reconciles all of them
    // over successive polls (tasks have no reaper fallback).
    const rows = await ctx.db
      .query("subAgents")
      .withIndex("by_chat_status_updated", (q) =>
        q.eq("chatId", chatId).eq("status", "running"),
      )
      .order("asc")
      .filter((q) => q.eq(q.field("kind"), "task"))
      .take(20);
    const taskIds = rows
      .filter((r) => r.childSessionKey.startsWith("task:"))
      .map((r) => r.childSessionKey.slice("task:".length));
    if (taskIds.length === 0) return null;
    const inst = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", chat.instanceName!))
      .first();
    return {
      instanceName: chat.instanceName,
      bridgeUrl: inst?.bridgeUrl ?? null,
      taskIds,
    };
  },
});

/** Refresh a poll-confirmed STILL-RUNNING engagement so the stale-row reaper
 *  (SUBAGENT_STALE_TTL_MS) never falsely errors a long legitimate task. */
export const refreshTaskEngagement = internalMutation({
  args: { chatId: v.id("chats"), taskId: v.string() },
  handler: async (ctx, { chatId, taskId }) => {
    const row = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("childSessionKey", `task:${taskId}`))
      .filter((q) => q.eq(q.field("chatId"), chatId))
      .first();
    if (row === null || row.status !== "running") return null;
    await ctx.db.patch(row._id, { updatedAt: Date.now() });
    return null;
  },
});

/** Apply a gateway-verified terminal status onto an engagement row. */
export const settleTaskEngagement = internalMutation({
  args: {
    chatId: v.id("chats"),
    taskId: v.string(),
    status: v.union(v.literal("done"), v.literal("error")),
    errorMessage: v.optional(v.string()),
    /** Guard for "registry does not know this id": only settle a row older
     *  than this (a fresh row may simply have raced the task's creation). */
    onlyIfOlderThanMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { chatId, taskId, status, errorMessage, onlyIfOlderThanMs },
  ) => {
    const row = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("childSessionKey", `task:${taskId}`))
      .filter((q) => q.eq(q.field("chatId"), chatId))
      .first();
    if (row === null || row.status !== "running") return null;
    if (
      onlyIfOlderThanMs !== undefined &&
      Date.now() - row.updatedAt < onlyIfOlderThanMs
    ) {
      return null;
    }
    await ctx.db.patch(row._id, {
      status,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      updatedAt: Date.now(),
    });
    // Same post-settle hooks as the upsert path: the summarize watermark
    // waits on unsettled children — a registry-driven settle must release it.
    await ctx.scheduler.runAfter(
      0,
      internal.chatSummaries.maybeScheduleSummarize,
      { chatId },
    );
    await maybeDrainOnTerminal(ctx, chatId, status);
    return null;
  },
});

const TERMINAL_TASK_STATUSES: Record<string, "done" | "error"> = {
  succeeded: "done",
  failed: "error",
  timed_out: "error",
  cancelled: "error",
  lost: "error",
};

/** Reconcile the chat's pending background tasks with the gateway registry.
 *  Called by the thread while its activity indicator is up — the indicator
 *  then reflects the gateway's truth, not a local guess. */
export const reconcileTaskEngagements = action({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<null> => {
    const pending = await ctx.runQuery(
      internal.subAgents.pendingTaskEngagements,
      { chatId },
    );
    if (pending === null) return null;
    let data: unknown;
    try {
      const res = await postBridge(
        "/tasks-probe",
        { instanceName: pending.instanceName, taskIds: pending.taskIds },
        50_000,
        pending.bridgeUrl,
      );
      if (res.status !== 200) return null; // fail soft — keep local state
      data = res.data;
    } catch {
      return null;
    }
    const tasks = (data as { tasks?: unknown[] } | null)?.tasks;
    if (!Array.isArray(tasks)) return null;
    for (const t of tasks) {
      if (typeof t !== "object" || t === null) continue;
      const r = t as Record<string, unknown>;
      const taskId = typeof r.taskId === "string" ? r.taskId : null;
      const status = typeof r.status === "string" ? r.status : null;
      if (taskId === null || status === null) continue;
      if (status === "not_found") {
        // The registry EXPLICITLY does not know this id (purged after
        // retention): settle an OLD row as lost — never a fresh one (the
        // probe may have raced the task's creation). Transient probe errors
        // never reach here (the bridge omits them from the batch).
        await ctx.runMutation(internal.subAgents.settleTaskEngagement, {
          chatId,
          taskId,
          status: "error",
          errorMessage: "task no longer known to the gateway registry",
          onlyIfOlderThanMs: 60 * 60 * 1000,
        });
        continue;
      }
      const mapped = TERMINAL_TASK_STATUSES[status];
      if (mapped === undefined) {
        // queued/running CONFIRMED by the registry: refresh the row so the
        // stale-reaper never falsely errors a long legitimate task.
        await ctx.runMutation(internal.subAgents.refreshTaskEngagement, {
          chatId,
          taskId,
        });
        continue;
      }
      await ctx.runMutation(internal.subAgents.settleTaskEngagement, {
        chatId,
        taskId,
        status: mapped,
        ...(typeof r.error === "string" && r.error !== ""
          ? { errorMessage: r.error.slice(0, 400) }
          : {}),
      });
    }
    return null;
  },
});
