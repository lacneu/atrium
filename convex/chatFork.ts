// BRANCH a conversation (ChatGPT's "branch in a new chat"): from any assistant
// reply, fork a NEW chat carrying the same visible history up to (and including)
// that message — so the user explores a tangent while the original continues.
//
// Everything downstream already exists:
//   - the fork's messages are REAL copies in the new chat (loadChatView, search,
//     export, the viewer all just work);
//   - the fork has NO gateway binding (`openclawChatId` unset) → its first send
//     opens a FRESH gateway session → the existing hybrid rehydration re-grounds
//     the agent with the copied history (rolling summary + verbatim tail). The
//     agent-side context carryover costs zero new bridge code, on BOTH providers.
//
// Copy semantics (deliberate):
//   - messages: terminal ones only (complete/error/aborted), text + error fields;
//     `orderTime` is stamped to the SOURCE's effectiveOrder so the logical order
//     is preserved exactly (fresh `_creationTime` keeps the newest-N windowing
//     invariant — see lib/messageOrder);
//   - parts: file + media only (the attachments you keep working with — the
//     viewer/renditions follow since the storageId is shared); tool/provenance/
//     reasoning parts stay in the original (analysis metadata, not conversation);
//   - the rolling summary row is carried over IFF its watermark does not cover
//     content BEYOND the branch point (a branch must never "know" about later
//     turns through the summary);
//   - correlation fields (runId, turnSessionKey, attachedDocCount) are NOT
//     copied — they belong to the source's live sessions.

import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireActive } from "./lib/access";
import { auditImpersonated } from "./lib/audit";
import { compareOrder, effectiveOrder } from "./lib/messageOrder";
import { recordFileForPart, isFilePart } from "./lib/files";
import { minChatSortKey } from "./chats";

/** Copy bound = the visible window (loadChatView's MESSAGE_WINDOW): the fork
 *  shows exactly what the user sees in the source. Older context still reaches
 *  the AGENT through the carried rolling summary when one covers it. */
export const FORK_MESSAGE_CAP = 200;

/** Delegation MARKER tool names (mirror of the frontend's SPAWN_TOOL_NAMES in
 *  assistantEmptyState.ts): the ONLY tool parts the fork copies — the
 *  in-context sub-agent cards (MessageSubAgents) gate their subscription on a
 *  spawn part being PRESENT on the message, so without the marker the copied
 *  subAgents rows below would never render in the branch. */
const SPAWN_TOOL_NAMES = new Set([
  "sessions_spawn",
  "delegate_task",
  "mixture_of_agents",
]);

export const forkChat = mutation({
  args: {
    branchMessageId: v.id("messages"),
    // User-chosen name for the branch (the fork dialog). Blank/absent = the
    // source title is copied (untitled stays untitled).
    title: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { branchMessageId, title },
  ): Promise<{ chatId: Id<"chats"> }> => {
    const { userId, actor } = await requireActive(ctx);
    // The source chat is DERIVED from the branch message (single arg, minimal
    // IDOR surface) — then ownership-gated before anything is read further.
    const branchMsg = await ctx.db.get(branchMessageId);
    if (branchMsg === null) throw new ConvexError("bad_branch_point");
    const sourceChatId = branchMsg.chatId;
    const source = await ctx.db.get(sourceChatId);
    // OWNERSHIP FIRST: every state-dependent refusal below must come after it,
    // or the distinct error codes would leak a foreign message's existence.
    if (source === null || source.userId !== userId) {
      throw new ConvexError("forbidden");
    }
    // Only REGULAR conversations fork — the hidden utility chats (documentary/
    // summarizer/curator/converter) are machinery, not conversations.
    if (source.kind !== undefined) throw new ConvexError("not_forkable");
    // Branch points are settled ASSISTANT replies (the only place the UI
    // offers the action; enforced server-side):
    //  - a USER row can sit QUEUED with the far-future orderTime sentinel —
    //    copying it would corrupt the fork's logical order (every later send
    //    would sort BEFORE it);
    //  - a STREAMING reply has no stable content — the terminal filter below
    //    would silently drop the branch point itself.
    if (branchMsg.role !== "assistant" || branchMsg.status === "streaming") {
      throw new ConvexError("bad_branch_point");
    }

    // History up to AND INCLUDING the branch point, in logical order, terminal
    // messages only (an in-flight streaming turn has no stable content to copy).
    // BOUNDED read ANCHORED AT THE BRANCH POINT (never collect() the whole
    // chat, and never a take from the chat HEAD — messages sent after the
    // branch in another tab would crowd the window and silently amputate the
    // copied history): range down from the branch message's _creationTime, so
    // the window always holds the branch point plus a full CAP of its own
    // past. Same windowing invariant loadChatView relies on (orderTime-bearing
    // rows have a recent _creationTime; see lib/messageOrder) — accepted edge:
    // a turn REGENERATED after the branch (fresh creation, old orderTime) is
    // outside the range and stays uncopied.
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) =>
        q
          .eq("chatId", sourceChatId)
          .lte("_creationTime", branchMsg._creationTime),
      )
      .order("desc")
      .take(FORK_MESSAGE_CAP * 2);
    const ordered = [...recent].sort(compareOrder);
    const idx = ordered.findIndex((m) => m._id === branchMessageId);
    // The anchor guarantees the branch row is in the read — this is a pure
    // defense-in-depth invariant check.
    if (idx === -1) throw new ConvexError("bad_branch_point");
    const upTo = ordered
      .slice(0, idx + 1)
      .filter((m) => m.status !== "streaming");
    const slice =
      upTo.length > FORK_MESSAGE_CAP ? upTo.slice(-FORK_MESSAGE_CAP) : upTo;
    const truncated = slice.length < upTo.length;

    const now = Date.now();
    // New chats land at the TOP of their section, same rule as createChat.
    const minKey = await minChatSortKey(ctx, userId, source.projectId ?? null);
    // The last ROUTED turn within the copied history (composer preselection).
    const lastRoutedInSlice = [...slice]
      .reverse()
      .find(
        (m) =>
          m.routedAgentId !== undefined && m.routedInstanceName !== undefined,
      );
    const forkId = await ctx.db.insert("chats", {
      userId,
      updatedAt: now,
      archived: false,
      sortKey: minKey - 1,
      // Same binding as the source: the tangent continues with the same agent.
      ...(source.instanceName !== undefined
        ? { instanceName: source.instanceName }
        : {}),
      ...(source.agentId !== undefined ? { agentId: source.agentId } : {}),
      // The user's per-chat session knobs (model / reasoning / fast mode) ride:
      // the branch continues the SAME configured conversation, so its first
      // dispatch must re-apply the same intent, not the instance defaults.
      ...(source.sessionSettings !== undefined
        ? { sessionSettings: source.sessionSettings }
        : {}),
      // The gateway session meta rides too — the header chips show the real
      // model immediately, and above all `sessionMeta.contextTokens` (the
      // context WINDOW size) is the BUDGET rehydrationContext sizes the
      // injected history with: without it the fork's first send would use the
      // default window and could overshoot a small-context model. The SOURCE
      // session's USAGE measures (used tokens / cost) never ride: the fork is
      // a fresh session, its meter must not show the old one's consumption.
      // SINGLE-AGENT chats only: on a per-turn-routed source the meta
      // describes whichever agent spoke LAST, which may postdate the branch
      // point and differ from the branch's preselected agent — NO meta beats
      // misleading chips and a wrong budget, so a multi-agent fork starts
      // bare (default budget) until its first turn's describe.
      ...(source.sessionMeta !== undefined && source.perTurnRouting !== true
        ? {
            sessionMeta: {
              ...source.sessionMeta,
              totalTokens: undefined,
              estimatedCostUsd: undefined,
              // Per-turn window-usage stamp: a usage measure like the two
              // above — a fresh forked session must not show the source's.
              activeTokens: undefined,
              activeTokensAt: undefined,
            },
          }
        : {}),
      // Per-turn ROUTING state rides too (a multi-agent source stays
      // multi-agent, and the composer defaults to the last agent used) —
      // derived from the COPIED slice, not the source chat's current state:
      // the source may have been routed to a different agent AFTER the branch
      // point, and the branch must never preselect an agent from its own
      // future. EXCEPT `routingSegment`: that is the source's live gateway
      // session key segment; sharing it would make the fork resume the
      // ORIGINAL's agent session.
      ...(source.perTurnRouting !== undefined
        ? { perTurnRouting: source.perTurnRouting }
        : {}),
      ...(lastRoutedInSlice !== undefined
        ? {
            lastRoutedInstanceName: lastRoutedInSlice.routedInstanceName,
            lastRoutedAgentId: lastRoutedInSlice.routedAgentId,
          }
        : {}),
      // The dialog's name wins; else the title is copied as-is (user data;
      // untitled stays untitled so every surface keeps its localized
      // fallback). Provenance rides forkedFromChatId.
      ...(title?.trim()
        ? { title: title.trim() }
        : source.title !== undefined
          ? { title: source.title }
          : {}),
      ...(source.projectId !== undefined
        ? { projectId: source.projectId }
        : {}),
      forkedFromChatId: sourceChatId,
      // Deliberately NO openclawChatId: the first send opens a FRESH gateway
      // session, which is what triggers the rehydration re-grounding. The
      // one-shot flag makes that explicit for OpenClaw, whose gateway creates
      // the session row (systemSent truthy) before the bridge's freshness
      // check — see getChatRouting; consumed by stream.finalize.
      forkPendingRehydration: true,
    });

    const idMap = new Map<Id<"messages">, Id<"messages">>();
    for (const msg of slice) {
      const newMsgId = await ctx.db.insert("messages", {
        chatId: forkId,
        userId,
        role: msg.role,
        status: msg.status,
        text: msg.text,
        ...(msg.error !== undefined ? { error: msg.error } : {}),
        ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
        // Per-turn agent attribution rides (the per-message agent chip; also
        // what the composer's "last used agent" default reads through).
        ...(msg.routedInstanceName !== undefined
          ? { routedInstanceName: msg.routedInstanceName }
          : {}),
        ...(msg.routedAgentId !== undefined
          ? { routedAgentId: msg.routedAgentId }
          : {}),
        // Quote-reply anchor rides: the collapsed header + the rehydration
        // preamble both read these. quotedMessageId remaps through idMap
        // (the quoted assistant turn precedes the quoting user turn, so it
        // was copied earlier in this chronological loop); a miss keeps the
        // excerpt without an anchor — same semantics as a deleted quoted
        // message (header shows, click quietly gives up).
        ...(msg.quotedExcerpt !== undefined
          ? { quotedExcerpt: msg.quotedExcerpt }
          : {}),
        ...(msg.quotedBlockIndex !== undefined
          ? { quotedBlockIndex: msg.quotedBlockIndex }
          : {}),
        ...(msg.quotedMessageId !== undefined &&
        idMap.has(msg.quotedMessageId)
          ? { quotedMessageId: idMap.get(msg.quotedMessageId)! }
          : {}),
        // Preserve the SOURCE logical order exactly. Safe w.r.t. the windowing
        // invariant: these rows have a fresh _creationTime (inside the newest-N
        // window) and an orderTime strictly in the past (before any future send
        // in the fork), so they sort as the history they are.
        orderTime: effectiveOrder(msg),
        updatedAt: msg.updatedAt,
      });
      idMap.set(msg._id, newMsgId);
      const parts = await ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", msg._id))
        .collect();
      // Source `files` rows for this message (lazy: only when a file part
      // exists) — the copy must carry row-level metadata the part does not
      // hold, e.g. origin:"pasted" (hidden by default in Settings > Files).
      let srcFileRows: { storageId: string; origin?: "pasted" }[] | null = null;
      for (const p of parts) {
        // Delegation MARKER tool parts ride (they gate the in-context sub-agent
        // cards — see SPAWN_TOOL_NAMES); every other tool/provenance/reasoning
        // part stays in the original (analysis metadata, not conversation).
        if (p.part.kind === "tool" && SPAWN_TOOL_NAMES.has(p.part.name)) {
          await ctx.db.insert("messageParts", {
            messageId: newMsgId,
            order: p.order,
            part: p.part,
          });
          continue;
        }
        if (!isFilePart(p.part)) continue; // file + media only (see header)
        const part = p.part; // narrowed const (survives the closure below)
        await ctx.db.insert("messageParts", {
          messageId: newMsgId,
          order: p.order,
          part,
        });
        if (srcFileRows === null) {
          srcFileRows = await ctx.db
            .query("files")
            .withIndex("by_message", (q) => q.eq("messageId", msg._id))
            .collect();
        }
        const srcRow = srcFileRows.find((f) => f.storageId === part.storageId);
        // Keep the files-table invariant (a files row exists iff a file/media
        // part exists) — same storageId, no blob duplication.
        await recordFileForPart(ctx, {
          messageId: newMsgId,
          chatId: forkId,
          userId,
          direction: msg.role === "user" ? "inbound" : "outbound",
          ...(source.instanceName !== undefined
            ? { instanceName: source.instanceName }
            : {}),
          part,
          createdAt: now,
          ...(srcRow?.origin !== undefined ? { origin: srcRow.origin } : {}),
        });
      }
    }

    // Sub-agent result cards: a delegated turn's visible ANSWER can live in a
    // subAgents row (resultText, correlated by parentMessageId) while the
    // parent message text is EMPTY — without the rows, the fork would show a
    // blank "generic" bubble where the source shows the child's result. Copy
    // the TERMINAL rows of copied messages, re-keyed; a still-RUNNING child is
    // skipped (its observer settles the SOURCE row only — a copy would show
    // "waiting" forever). Bounded read ANCHORED to the copied era: a child row
    // is first written during its parent's turn, so rows for copied messages
    // sit at creation times >= the oldest copied message — range from that
    // floor ASCENDING, so the copied era wins the cap over children spawned by
    // turns AFTER the branch point. EXPLICIT eviction policy: beyond 2*CAP
    // observation rows since the oldest copied message, the newest cards are
    // dropped from the copy — a display-only loss, traded against an unbounded
    // read inside this mutation.
    const eraFloor = Math.min(...slice.map((m) => m._creationTime));
    const subAgentRows = await ctx.db
      .query("subAgents")
      .withIndex("by_chat", (q) =>
        q.eq("chatId", sourceChatId).gte("_creationTime", eraFloor),
      )
      .take(FORK_MESSAGE_CAP * 2);
    for (const row of subAgentRows) {
      if (row.status === "running") continue;
      const mappedParent =
        row.parentMessageId !== undefined
          ? idMap.get(row.parentMessageId)
          : undefined;
      if (mappedParent === undefined) continue; // parent not copied (post-branch)
      const { _id, _creationTime, ...rest } = row;
      await ctx.db.insert("subAgents", {
        ...rest,
        chatId: forkId,
        parentMessageId: mappedParent,
        // UNIQUE key: `childSessionKey` is globally one-row-per-key (the
        // by_child index — observer upserts and the Interact panel resolve by
        // it with .first()). Reusing the source key would let a LATE update of
        // the real child patch the COPY (cross-chat corruption) and break the
        // source's own lookups. The `fork:` PREFIX keeps the display-parsed
        // tail intact (short label, MoA role suffixes) while the strict
        // `agent:...` head parsers correctly yield "unknown" on copies;
        // interactions refuse it explicitly (subAgentInteractions).
        childSessionKey: `fork:${forkId}:${row.childSessionKey}`,
      });
    }

    // Carry the rolling summary IFF it covers ONLY content up to the branch
    // point — a summary whose watermark extends past the branch would leak later
    // turns into the fork's agent context. The fork's own summarize engine
    // rebuilds coverage naturally otherwise.
    const summary = await ctx.db
      .query("chatSummaries")
      .withIndex("by_chat", (q) => q.eq("chatId", sourceChatId))
      .first();
    if (
      summary !== null &&
      summary.summary !== "" &&
      summary.watermarkOrderTime <= effectiveOrder(branchMsg)
    ) {
      await ctx.db.insert("chatSummaries", {
        chatId: forkId,
        summary: summary.summary,
        watermarkOrderTime: summary.watermarkOrderTime,
        coveredCount: summary.coveredCount,
        updatedAt: now,
        failureCount: 0,
        nextEligibleAt: 0,
        ...(summary.lastAgentId !== undefined
          ? { lastAgentId: summary.lastAgentId }
          : {}),
        ...(summary.lastInstanceName !== undefined
          ? { lastInstanceName: summary.lastInstanceName }
          : {}),
        // NOT copied: scanFloorCreationTime — it lives in the SOURCE's
        // _creationTime space; the fork's copies are all newer than that floor,
        // but resetting keeps the engine's monotonic contract clean.
      });
    }

    // Cross-identity attribution: an admin forking while impersonating writes
    // a chat + copied content under the user's identity — audited like
    // chats.createChat (no-op when the user acts as themselves).
    await auditImpersonated(ctx, actor, "chat.fork", {
      resource: "chat",
      resourceId: forkId,
    });

    return { chatId: forkId, ...(truncated ? { truncated: true } : {}) } as {
      chatId: Id<"chats">;
    };
  },
});
