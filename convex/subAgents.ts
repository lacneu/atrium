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
import { internalMutation, query } from "./_generated/server";
import { requireActive, requireOwnedChat } from "./lib/access";

const STATUS = v.union(
  v.literal("running"),
  v.literal("done"),
  v.literal("error"),
  v.literal("aborted"),
);

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
      return await ctx.db.insert("subAgents", {
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
    return existing._id;
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
