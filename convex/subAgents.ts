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
import { internalMutation, query, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireActive, requireOwnedChat } from "./lib/access";
import { drainNextQueued, SUBAGENT_STALE_TTL_MS } from "./lib/outboxQueue";

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

/** Terminal child lifecycle states (no longer holding the chat — see isChatBusy). */
function isTerminalStatus(status: string): boolean {
  return status === "done" || status === "error" || status === "aborted";
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
    taskName: v.optional(v.string()),
    status: STATUS,
    resultText: v.optional(v.string()),
    phase: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
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
        taskName: args.taskName,
        status: args.status,
        resultText: args.resultText,
        phase: args.phase,
        errorMessage: args.errorMessage,
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
      parentMessageId?: typeof args.parentMessageId;
      updatedAt: number;
    } = { updatedAt: now };
    // Never downgrade a terminal child back to running (reorder-tolerance).
    if (!(terminal && args.status === "running")) {
      patch.status = args.status;
    }
    if (args.resultText !== undefined) patch.resultText = args.resultText;
    if (args.errorMessage !== undefined) patch.errorMessage = args.errorMessage;
    // Drop a stale phase update once the child is terminal.
    if (args.phase !== undefined && !terminal) patch.phase = args.phase;
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
    const stale = await ctx.db
      .query("subAgents")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "running").lt("updatedAt", cutoff),
      )
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
