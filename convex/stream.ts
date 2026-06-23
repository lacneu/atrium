// Mutations called BY THE BRIDGE to stream normalized OpenClaw events into the
// reactive DB. These map 1:1 onto the normalizer's stable bridge events
// (see backend/app/normalizer.py and docs/BRIDGE_PROTOCOL.md):
//
//   run.status (begin)  -> startAssistant  (creates the streaming message)
//   message.delta       -> appendDelta     (append text)
//   message.snapshot    -> setSnapshot     (replace text)
//   tool.status / media -> addPart         (structured parts)
//   message.final       -> finalize        (complete | error | aborted)
//
// SECURITY: these are `internalMutation`s — NOT callable from the browser.
// The bridge authenticates to Convex with a deploy/service key (bridge env
// only) and invokes them via `internal.stream.*`. They therefore carry no
// user identity; access scoping for these writes is structural (the bridge is
// trusted and only writes to the chat it was told to). Public read access is
// still gated per-user in messages.ts, so a user can never read another user's
// streamed message.

import { v } from "convex/values";
import { internalMutation, internalQuery, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { messagePart } from "./schema";
import { writeTraceEvent } from "./observability";
import { isFilePart, recordFileForPart } from "./lib/files";
import { drainNextQueued } from "./lib/outboxQueue";
import { correlateDocumentaryFetch } from "./documentAttachments";
import { compareOrder } from "./lib/messageOrder";

/**
 * Build the stable per-turn correlationId for an assistant message. Prefers
 * `chatId:runId` (the whole conversational turn); falls back to chatId, then to
 * the messageId, so a trace is always correlatable even mid-run.
 *
 * TODO(M8): the user half (send.ts traceSend) keys on `${chatId}:${outboxId}`,
 * which is never associated with this `${chatId}:${runId}`. Linking the two
 * halves end-to-end needs the bridge to carry a single correlationId across the
 * turn (write the runId back onto the outbox row, or echo a shared id through
 * startAssistant). Bridge wiring — deferred.
 */
function streamCorrelationId(
  chatId: Id<"chats">,
  runId: string | undefined,
  messageId: Id<"messages">,
): string {
  if (runId) return `${chatId}:${runId}`;
  if (chatId) return `${chatId}`;
  return `${messageId}`;
}

/**
 * Emit an `assistant.stream` trace (D2 metadata only — never message text).
 * Wrapped so a trace failure can NEVER abort the bridge's streaming mutation.
 */
async function traceStream(
  ctx: MutationCtx,
  args: {
    phase: "start" | "finalize";
    chatId: Id<"chats">;
    runId: string | undefined;
    messageId: Id<"messages">;
    streamStatus: "streaming" | "complete" | "error" | "aborted";
    textLen?: number;
  },
): Promise<void> {
  try {
    await writeTraceEvent(ctx, {
      kind: "assistant.stream",
      direction: "inbound",
      principalType: "system",
      principalId: "bridge",
      chatId: args.chatId,
      runId: args.runId,
      correlationId: streamCorrelationId(args.chatId, args.runId, args.messageId),
      meta: JSON.stringify({
        phase: args.phase,
        messageId: args.messageId,
        // String lifecycle status lives in meta (the `status` column is numeric).
        streamStatus: args.streamStatus,
        ...(args.textLen !== undefined ? { textLen: args.textLen } : {}),
      }),
    });
  } catch {
    // Best-effort: never break the primary stream write on a trace error.
  }
}

// Create the streaming assistant message for a run. Returns the message id the
// bridge then threads through the rest of the stream calls.
//
// We derive the owning user from the chat so the new message carries the same
// `userId` (needed for the per-user read scoping in messages.ts).
export const startAssistant = internalMutation({
  args: {
    chatId: v.id("chats"),
    runId: v.optional(v.string()),
  },
  handler: async (ctx, { chatId, runId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) {
      throw new Error("startAssistant: chat not found");
    }
    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId: chat.userId,
      role: "assistant",
      runId,
      status: "streaming",
      text: "",
      updatedAt: now,
    });
    // Create the live-text row WITH the message (one atomic mutation), so the
    // INVARIANT "streaming message <=> streamingText row exists" holds from t0 —
    // the watchdog (which ranges streamingText by heartbeat) can see a turn that
    // gets stuck BEFORE its first delta, and per-delta writes only touch this row,
    // never the messages doc (so loadChatView stops re-running per delta).
    await ctx.db.insert("streamingText", {
      messageId,
      chatId,
      text: "",
      updatedAt: now,
    });
    await ctx.db.patch(chatId, { updatedAt: now });
    await traceStream(ctx, {
      phase: "start",
      chatId,
      runId,
      messageId,
      streamStatus: "streaming",
    });
    return messageId;
  },
});

// The streamingText row for a message (the live-text home). `.first()` (not
// `.unique()`): the by_message invariant is one row, but the STREAMING write path
// must never throw on a stray duplicate — it updates the first and keeps flowing.
async function streamingRow(ctx: MutationCtx, messageId: Id<"messages">) {
  return await ctx.db
    .query("streamingText")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .first();
}

// Append incremental text (message.delta). Writes the LIVE-TEXT ROW, not the
// `messages` doc — so the heavy loadChatView (which reads `messages`) does NOT
// re-run on every delta; only the cheap getStreamingText query does. `updatedAt`
// here is the streaming heartbeat. `messages.text` is written once at finalize.
export const appendDelta = internalMutation({
  args: {
    messageId: v.id("messages"),
    text: v.string(),
  },
  handler: async (ctx, { messageId, text }) => {
    const now = Date.now();
    const row = await streamingRow(ctx, messageId);
    if (row === null) {
      // Defensive: startAssistant creates the row, but a delta arriving without
      // one (a race / a message MID-STREAM across the deploy to this version) still
      // streams — create it, deriving chatId from the message. PRESERVE any legacy
      // `liveText` prefix already streamed pre-deploy, else this delta would orphan
      // it and a no-text finalize would lose everything streamed before the deploy.
      const message = await ctx.db.get(messageId);
      if (message === null) throw new Error("appendDelta: message not found");
      // A late delta for an ALREADY-FINISHED turn (finalize/watchdog deleted the row
      // and set a terminal status) must NOT recreate a row: no finalize will run
      // again to delete it, so it would leak a phantom live row that getStreamingText
      // returns forever. Drop it — the turn is over (mirrors addPart's status guard).
      if (message.status !== "streaming") return;
      await ctx.db.insert("streamingText", {
        messageId,
        chatId: message.chatId,
        text: (message.liveText ?? "") + text,
        updatedAt: now,
      });
      return;
    }
    await ctx.db.patch(row._id, { text: row.text + text, updatedAt: now });
  },
});

// Replace the full streaming text (message.snapshot). Same live-text-row target.
export const setSnapshot = internalMutation({
  args: {
    messageId: v.id("messages"),
    text: v.string(),
  },
  handler: async (ctx, { messageId, text }) => {
    const now = Date.now();
    const row = await streamingRow(ctx, messageId);
    if (row === null) {
      const message = await ctx.db.get(messageId);
      if (message === null) throw new Error("setSnapshot: message not found");
      // See appendDelta: never recreate a row for a finished turn (no finalize will
      // delete it again) — a late snapshot for a terminal message is dropped.
      if (message.status !== "streaming") return;
      await ctx.db.insert("streamingText", {
        messageId,
        chatId: message.chatId,
        text,
        updatedAt: now,
      });
      return;
    }
    await ctx.db.patch(row._id, { text, updatedAt: now });
  },
});

// Add a structured part (tool.status / media / file / reasoning). Order is
// assigned monotonically per message based on existing parts so rendering is
// stable. For media/file the bridge must have already stored the blob via
// `ctx.storage.store(blob)` (in an action) and pass the resulting `_storage`
// id inside `part`.
export const addPart = internalMutation({
  args: {
    messageId: v.id("messages"),
    part: messagePart,
  },
  handler: async (ctx, { messageId, part }) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("addPart: message not found");
    }
    // Heartbeat: a turn streaming ONLY tool/media/reasoning parts (no text deltas)
    // must still refresh its live-text row, else the watchdog (which keys off that
    // row's updatedAt) would reap an actively-working turn as stuck. Bump if present;
    // create (preserving any legacy liveText) for a pre-deploy/race message with no
    // row yet. Does NOT touch the message doc — loadChatView re-runs on the part
    // INSERT below (the parts changed) regardless, so no extra per-text-delta churn.
    if (message.status === "streaming") {
      const liveRow = await streamingRow(ctx, messageId);
      if (liveRow !== null) {
        await ctx.db.patch(liveRow._id, { updatedAt: Date.now() });
      } else {
        await ctx.db.insert("streamingText", {
          messageId,
          chatId: message.chatId,
          text: message.liveText ?? "",
          updatedAt: Date.now(),
        });
      }
    }
    const existing = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    const order = existing.length;
    await ctx.db.insert("messageParts", { messageId, order, part });
    // Paired files-row write (invariant): a file/media part gets an owner-scoped
    // `files` row. addPart is append-only (no per-flush re-insert), so this never
    // duplicates. Direction from the message role; instanceName = the chat's
    // bound bridge snapshot.
    if (isFilePart(part)) {
      const chat = await ctx.db.get(message.chatId);
      await recordFileForPart(ctx, {
        messageId,
        chatId: message.chatId,
        userId: message.userId,
        direction: message.role === "user" ? "inbound" : "outbound",
        instanceName: chat?.instanceName,
        part,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(messageId, { updatedAt: Date.now() });
  },
});

// Mark the assistant turn done (message.final). `status` is "complete" on a
// clean finish, "error" when the normalizer surfaced an error, or "aborted".
// Optional `text` lets the bridge set the final authoritative text (the
// normalizer's final event carries the accumulated text). On an error turn the
// bridge passes BOTH partial text and error (mirrors the lifecycle-error
// fixture: final text "moitié" + error containing "Context overflow").
export const finalize = internalMutation({
  args: {
    messageId: v.id("messages"),
    status: v.union(
      v.literal("complete"),
      v.literal("error"),
      v.literal("aborted"),
    ),
    text: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { messageId, status, text, error }) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("finalize: message not found");
    }
    // A2: write the authoritative final text into the searchable/indexed `text`
    // ONCE here, and CLEAR `liveText` (so listByChat now reads `text`). Prefer the
    // normalizer's final text; fall back to whatever streamed into `liveText` (so
    // a final with no explicit text never wipes a streamed reply).
    // The live text now lives in the streamingText row; `message.liveText` is only
    // a fallback for a message that was mid-stream across a deploy to this version.
    const stRow = await streamingRow(ctx, messageId);
    const streamedText = stRow?.text ?? message.liveText ?? message.text;
    const finalText =
      text !== undefined && text !== "" ? text : streamedText;
    await ctx.db.patch(messageId, {
      status,
      text: finalText,
      liveText: undefined, // clear the legacy live field (optional → field removed)
      ...(error !== undefined ? { error } : {}),
      updatedAt: Date.now(),
    });
    // Delete the live-text row WITH the lifecycle flip (same atomic mutation) so the
    // "streaming <=> row exists" invariant holds and the watchdog won't re-see it.
    if (stRow !== null) await ctx.db.delete(stRow._id);
    // The finalized text length — never the text itself.
    const finalLen = finalText.length;
    await traceStream(ctx, {
      phase: "finalize",
      chatId: message.chatId,
      runId: message.runId,
      messageId,
      streamStatus: status,
      textLen: finalLen,
    });
    // The turn ended → the chat is now idle. Dispatch the next QUEUED send (if
    // any) — the engine of mid-turn message serialization (Phase 1).
    await drainNextQueued(ctx, message.chatId);

    // L2: a finished DOCUMENTARY fetch turn → correlate the returned files back to
    // the source reply's references. Best-effort: a correlation failure must NEVER
    // break the turn lifecycle. GUARD: only correlate when THIS finalizing message is
    // the reply to the CURRENT fetch. If an earlier fetch was declared stuck + released
    // and a NEW one started, a LATE finalize of the OLD gateway run must not correlate
    // against the new fetch's rows / clear its lock. The old run's assistant message
    // was created when it streamed (before the new fetch's dispatch), so its
    // _creationTime is strictly BEFORE the current pendingFetch.createdAt.
    const chat = await ctx.db.get(message.chatId);
    if (
      chat?.kind === "documentary" &&
      chat.pendingFetch &&
      message._creationTime >= chat.pendingFetch.createdAt
    ) {
      try {
        await correlateDocumentaryFetch(ctx, chat, message);
      } catch (e) {
        console.error("[docfetch] correlate failed:", (e as Error)?.message ?? e);
      }
    }
  },
});

// Mirror the gateway's `sessions.describe` onto the chat so the header strip can
// surface the model / reasoning level / context meter (CHAT_UX_DESIGN Part 2.1).
// The bridge calls this (via the ingest httpAction) when it learns a turn's
// session meta. INTERNAL (not browser-callable). All fields optional + stamped
// with `updatedAt` — never holds secrets (model/level names are non-sensitive).
export const setSessionMeta = internalMutation({
  args: {
    chatId: v.id("chats"),
    meta: v.object({
      model: v.optional(v.string()),
      modelProvider: v.optional(v.string()),
      agentRuntime: v.optional(v.string()),
      thinkingLevel: v.optional(v.string()),
      thinkingDefault: v.optional(v.string()),
      thinkingLevels: v.optional(
        v.array(v.object({ id: v.string(), label: v.string() })),
      ),
      availableModels: v.optional(
        v.array(v.object({ id: v.string(), label: v.string() })),
      ),
      verboseLevel: v.optional(v.string()),
      totalTokens: v.optional(v.number()),
      contextTokens: v.optional(v.number()),
      estimatedCostUsd: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { chatId, meta }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return; // chat gone (e.g. deleted mid-turn) — nothing to do
    await ctx.db.patch(chatId, {
      sessionMeta: { ...meta, updatedAt: Date.now() },
    });
  },
});

// SESSION RE-HYDRATION (see docs/SESSION_CONTINUITY_DESIGN.md + #61 follow-up).
// OpenClaw sessions are ephemeral (daily/idle reset, compaction); our webchat
// displays the FULL conversation. When the bridge detects a FRESH/rolled OpenClaw
// session (`sessions.describe.session.systemSent === false`) it asks for this
// bounded, display-of-prior-turns block and PREPENDS it to the new `chat.send`
// message — so the model's context matches what the user sees. We are the source
// of truth for the conversation; this re-grounds the gateway from it.
//
// V1 is TEXT-ONLY: earlier image/file turns survive only as their text trace
// (filenames/captions), not re-uploaded media — an accepted v1 cut.
//
// Budget: bounded by the chat's known context window (`sessionMeta.contextTokens`)
// minus a reserve, keeping the MOST RECENT turns (older turns dropped with a
// notice). Only `complete` user/assistant turns with text are included; the
// current turn (`excludeMessageId`) and streaming/empty rows are skipped.
export const rehydrationContext = internalQuery({
  args: {
    chatId: v.id("chats"),
    excludeMessageId: v.optional(v.id("messages")),
  },
  handler: async (
    ctx,
    { chatId, excludeMessageId },
  ): Promise<{ history: string | null; turnCount: number }> => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return { history: null, turnCount: 0 };

    // History is everything LOGICALLY BEFORE the current turn (see lib/messageOrder).
    // Ordering by raw _creationTime is wrong here: a mid-turn QUEUE follow-up inserted
    // in the pending-pre-ack window has a _creationTime EARLIER than the in-flight
    // turn's assistant reply. compareOrder (orderTime, tie-broken by _creationTime)
    // sorts a queued follow-up correctly, and "strictly before the CURRENT turn" both
    // KEEPS the prior assistant and EXCLUDES still-queued later follow-ups.
    const current = excludeMessageId ? await ctx.db.get(excludeMessageId) : null;

    // Budget: reserve ~50% of the window for the system prompt, the new user
    // message, and the reply. ~3 chars/token (conservative). Fallback window
    // when we have not yet learned the real one from a prior turn's meta.
    const windowTokens = chat.sessionMeta?.contextTokens ?? 32_000;
    const budgetChars = Math.max(2_000, Math.floor(windowTokens * 0.5) * 3);

    // Bounded tail read by _creationTime (valid: an orderTime-bearing row has a recent
    // _creationTime), then keep usable PRIOR turns in LOGICAL order within budget.
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(80);
    const usableDesc = recent
      .filter((m) => !(excludeMessageId && m._id === excludeMessageId))
      .filter((m) => current === null || compareOrder(m, current) < 0) // strictly before the current turn
      .filter(
        (m) =>
          m.status === "complete" &&
          (m.role === "user" || m.role === "assistant") &&
          m.text.trim().length > 0,
      )
      .sort((a, b) => compareOrder(b, a)); // newest logical first, for the budget walk

    const lines: string[] = [];
    let chars = 0;
    let truncated = false;
    for (const m of usableDesc) {
      const label = m.role === "user" ? "Utilisateur" : "Assistant";
      const line = `${label} : ${m.text.trim()}`;
      if (lines.length > 0 && chars + line.length > budgetChars) {
        truncated = true;
        break;
      }
      lines.push(line);
      chars += line.length + 1;
    }
    if (lines.length === 0) return { history: null, turnCount: 0 };

    lines.reverse(); // chronological (oldest -> newest)
    const header =
      "[Reprise d’une conversation antérieure de ce même fil. Pour continuité, " +
      "voici l’historique des messages précédents de cette conversation :]";
    const opener = truncated ? "[…début de la conversation plus ancien, omis…]\n" : "";
    const footer =
      "[Fin de l’historique. Le nouveau message de l’utilisateur suit ci-dessous.]";
    return {
      history: `${header}\n${opener}${lines.join("\n")}\n${footer}`,
      turnCount: lines.length,
    };
  },
});
