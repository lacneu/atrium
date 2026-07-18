// Chat lifecycle (public, ACTIVE-user scoped).
//
// All chat mutations require an ACTIVE role (user|admin): a merely-authenticated
// "pending" user is rejected by requireActive. Profile creation happens at login
// via me.bootstrap (the only thing a pending user may call), not here.

import { resolveAgentTypes } from "./lib/agentTypes";
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireActive, requireOwnedChat } from "./lib/access";
import { getEffectiveGrants } from "./agents";
import { auditImpersonated } from "./lib/audit";
import { deleteFilesByMessage } from "./lib/files";
import { releaseDanglingDocumentaryFetch } from "./documentAttachments";
import { purgeSummaryForChat } from "./chatSummaries";

async function requireOwnedProject(
  ctx: MutationCtx,
  userId: Id<"users">,
  projectId: Id<"projects">,
) {
  const project = await ctx.db.get(projectId);
  if (project === null) throw new Error("Not found: project");
  if (project.userId !== userId) throw new Error("Forbidden: project not owned");
  return project;
}

// Smallest sortKey among the user's chats in a given project (null = no project),
// so a new/moved chat can be placed above all of them (minKey - 1).
export async function minChatSortKey(
  ctx: MutationCtx,
  userId: Id<"users">,
  projectId: Id<"projects"> | null,
): Promise<number> {
  const chats = await ctx.db
    .query("chats")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const keys = chats
    .filter((c) => (c.projectId ?? null) === projectId && !c.archived)
    .map((c) => c.sortKey ?? 0);
  return keys.length ? Math.min(...keys) : 0;
}

// Allowed chat color tokens (preset, NOT freeform hex — preserves theme
// coherence). Mirrored client-side in the color picker. "" / undefined = none.
const CHAT_COLORS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;
const chatColorValidator = v.union(
  ...CHAT_COLORS.map((c) => v.literal(c)),
  v.null(),
);

// Authorize a (user, instance, agent) chat binding against the user's EFFECTIVE
// agent set (red-team B / IDOR): the bridge routes by these names, so Convex is
// the SOLE authorization point. Uses getEffectiveGrants — the SAME cascade set the
// dispatch (resolveTargetForChat) and the picker (listMyAgents) use — so any agent
// the user can SEE in the picker (direct grant, group-shared, or — for a groupless
// user — every agent via the all-pool) can be bound; an out-of-set agent throws.
// Exported: send.ts applies the SAME gate to a per-turn routedAgent BEFORE
// stamping routedInstanceName on the user message — that stamp is what the
// ingest authorization's per-turn branch trusts (chatAllowsInstance), so it
// must only ever hold a VALIDATED route, never raw client input (codex P1).
export async function requireAgentMembership(
  ctx: MutationCtx,
  userId: Id<"users">,
  instanceName: string,
  agentId: string,
) {
  const grants = await getEffectiveGrants(ctx, userId);
  const ok = grants.some(
    (g) => g.instanceName === instanceName && g.agentId === agentId,
  );
  if (!ok) {
    throw new Error("Forbidden: agent not assigned to this user");
  }
  // A UTILITY-ONLY agent (summarizer/documentary without "conversational") is
  // never a valid binding for a NORMAL chat: the picker hides it and routing
  // refuses it — refusing at creation too keeps a forged/stale client from
  // persisting a chat that is born agent_restricted (codex P2).
  const row = await ctx.db
    .query("agents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
  if (row !== null && !resolveAgentTypes(row.types).includes("conversational")) {
    throw new Error("Forbidden: agent is utility-only (not conversational)");
  }
}

export const createChat = mutation({
  args: {
    title: v.optional(v.string()),
    openclawChatId: v.optional(v.string()),
    projectId: v.optional(v.id("projects")),
    // The agent this chat binds to (from the picker, or auto when the user has
    // exactly one). BOTH or NEITHER — an unbound chat resolves to the user's
    // default at dispatch. Authorized server-side against userAgents (IDOR gate).
    instanceName: v.optional(v.string()),
    agentId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { title, openclawChatId, projectId, instanceName, agentId },
  ) => {
    const { userId, actor } = await requireActive(ctx);
    if (projectId) await requireOwnedProject(ctx, userId, projectId);
    // Binding must be both-or-neither, and authorized against userAgents.
    if ((instanceName === undefined) !== (agentId === undefined)) {
      throw new Error("Invalid: instanceName and agentId must be set together");
    }
    if (instanceName !== undefined && agentId !== undefined) {
      await requireAgentMembership(ctx, userId, instanceName, agentId);
    }
    const now = Date.now();
    // New chats go to the TOP: a key below the current minimum sortKey.
    const minKey = await minChatSortKey(ctx, userId, projectId ?? null);
    const chatId = await ctx.db.insert("chats", {
      userId,
      title,
      openclawChatId,
      projectId,
      instanceName,
      agentId,
      archived: false,
      sortKey: minKey - 1,
      updatedAt: now,
    });
    await auditImpersonated(ctx, actor, "chat.create", {
      resource: "chat",
      resourceId: chatId,
    });
    return chatId;
  },
});

export const renameChat = mutation({
  args: { chatId: v.id("chats"), title: v.string() },
  handler: async (ctx, { chatId, title }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.db.patch(chatId, { title, updatedAt: Date.now() });
    await auditImpersonated(ctx, actor, "chat.rename", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

// Write-back of a per-chat OpenClaw knob (reasoning level / model) from the chat
// header's "Advanced" panel. Persists the INTENT (sessionSettings) and schedules
// an IMMEDIATE bridge patch so the gateway applies it now and the live
// `sessionMeta` (the chip's source of truth) refreshes — the user can rely on
// what the header shows, not an optimistic guess. Owner-scoped. The bridge ALSO
// re-applies these before every turn so they survive a session reset/roll.
//
// NOTE: `verboseLevel` is intentionally NOT exposed here — the bridge pins it to
// "full" per connection to receive complete streaming frames; letting the user
// lower it would silently degrade streaming. (Documented in docs/CHAT_UX_DESIGN.md.)
//
// UNSET (`null`) semantics — the per-line ↺ "back to inherited" (CONF amendment
// A2, LIFTED by the 6.5 bench probe): the gateway's `sessions.patch
// { key, <field>: null }` returns ok:true and REMOVES the stored override, so
// the session falls back to the agent/admin default. Passing `null` here (a)
// deletes the key from the `sessionSettings` intent (so per-turn re-apply stops
// pushing it) and (b) records the field name in the intent's `clears` list, so
// the unset SURVIVES like a set (red-team P2-4): the bridge patches the explicit
// null immediately AND re-applies it before every turn — an unset lost to a
// bridge outage is repaired on the next turn instead of leaving the gateway
// override forever. Setting a field again removes it from `clears`.
export const setSessionKnob = mutation({
  args: {
    chatId: v.id("chats"),
    thinkingLevel: v.optional(v.union(v.string(), v.null())),
    model: v.optional(v.union(v.string(), v.null())),
    fastMode: v.optional(v.union(v.boolean(), v.null())),
  },
  handler: async (ctx, { chatId, thinkingLevel, model, fastMode }) => {
    const { userId, actor } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);

    // Defensive bound: enum ids are short. The gateway is the real validator, but
    // we cap length so a malformed value can never bloat a patch payload.
    if (typeof thinkingLevel === "string" && thinkingLevel.length > 64) {
      throw new Error("Invalid thinkingLevel");
    }
    if (typeof model === "string" && model.length > 128) {
      throw new Error("Invalid model");
    }

    // Merge onto existing intent so changing one knob never drops the other.
    // `null` = unset: remove the key from the intent AND persist the field name
    // in the intent's `clears` (deduplicated) — one source of truth the bridge
    // consumes both on the immediate /patch and on every per-turn re-apply
    // (P2-4: unsets survive like sets). Setting a field removes it from clears.
    const next: {
      thinkingLevel?: string;
      model?: string;
      fastMode?: boolean;
      clears?: string[];
    } = { ...(chat.sessionSettings ?? {}) };
    const clears = new Set(next.clears ?? []);
    if (thinkingLevel !== undefined) {
      if (thinkingLevel === null) {
        delete next.thinkingLevel;
        clears.add("thinkingLevel");
      } else {
        next.thinkingLevel = thinkingLevel;
        clears.delete("thinkingLevel");
      }
    }
    if (model !== undefined) {
      if (model === null) {
        delete next.model;
        clears.add("model");
      } else {
        next.model = model;
        clears.delete("model");
      }
    }
    if (fastMode !== undefined) {
      if (fastMode === null) {
        delete next.fastMode;
        clears.add("fastMode");
      } else {
        next.fastMode = fastMode;
        clears.delete("fastMode");
      }
    }
    if (clears.size > 0) next.clears = [...clears];
    else delete next.clears;
    await ctx.db.patch(chatId, { sessionSettings: next });

    // Immediate apply: the bridge patches the gateway, re-describes, and reports
    // the CONFIRMED live meta back (chip stays honest). Cannot fetch from a
    // mutation, hence the scheduled internalAction. `userId` (== chat owner,
    // enforced above) routes the patch to the same instance/agent as sends.
    // No separate `clears` arg: the action reads the PERSISTED intent.
    await ctx.scheduler.runAfter(0, internal.bridge.dispatchPatch, {
      chatId,
      userId,
    });

    await auditImpersonated(ctx, actor, "chat.session_knob", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

// Owner-initiated session realignment from the session panel (CONF-4b
// "Réinitialiser la session"): schedules the SAME internal.bridge.dispatchReset
// that messages.deleteMessage uses (without a regenerate outbox), so the
// gateway flips systemSent=false and the next turn re-hydrates from the
// current Convex transcript. Messages are NOT deleted.
export const resetSession = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.scheduler.runAfter(0, internal.bridge.dispatchReset, {
      chatId,
      userId,
    });
    await auditImpersonated(ctx, actor, "chat.reset", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

// Shared bounded cascade: delete a chat AND its dependent rows (messages,
// their parts, pending outbox). Convex has no cascade, so we do it explicitly.
// Bounded `.take()` keeps each pass within mutation limits; very large chats
// would need a self-scheduled continuation (noted; typical chats fit in one).
// Reused by deleteChat and by projects.deleteProject (cascade-on-delete).
export async function cascadeDeleteChat(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<void> {
  const chat = await ctx.db.get(chatId);
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .take(500);
  for (const m of messages) {
    const parts = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", m._id))
      .take(500);
    for (const p of parts) await ctx.db.delete(p._id);
    // Mirror the files-row invariant on the chat-cascade part deletion.
    await deleteFilesByMessage(ctx, m._id);
    // L2: purge this message's documentary attachments — their rows reference the
    // message and getDocumentAttachments would otherwise still surface (download)
    // them. Rows only (storage blobs follow the same convention as message media).
    const docs = await ctx.db
      .query("documentAttachments")
      .withIndex("by_source_message", (q) => q.eq("sourceMessageId", m._id))
      .collect();
    for (const d of docs) await ctx.db.delete(d._id);
    // Live-text row (present iff the message is mid-stream) — drop it with the message.
    const live = await ctx.db
      .query("streamingText")
      .withIndex("by_message", (q) => q.eq("messageId", m._id))
      .collect();
    for (const s of live) await ctx.db.delete(s._id);
    // SSE transport (Phase 1): purge un-GC'd stream chunks of a mid-stream message
    // deleted with the chat (they hold text). Bounded GC, scheduled only when present.
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
    await ctx.db.delete(m._id);
  }
  // Purge the chat's NON-TERMINAL outbox — `pending` (in-flight) AND `queued`
  // (parked follow-ups) — so a later drainNextQueued can't dispatch a deleted
  // chat's queued send. Indexed by chat (not a global by_status scan).
  for (const status of ["pending", "queued"] as const) {
    const rows = await ctx.db
      .query("outbox")
      .withIndex("by_chat_status", (q) =>
        q.eq("chatId", chatId).eq("status", status),
      )
      .collect();
    for (const o of rows) await ctx.db.delete(o._id);
  }
  // Sub-agent observations (Track B monitor) hold chat content (the child's result/error
  // text) keyed by chatId — purge them with the chat so a deleted chat/user leaves no
  // orphaned sub-agent rows (codex P1). Indexed by chat; a chat has few sub-agents.
  const subAgents = await ctx.db
    .query("subAgents")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .collect();
  for (const s of subAgents) await ctx.db.delete(s._id);
  // The per-tool DETAIL rows (args + result) live in their own table keyed by chat;
  // purge them with the chat too so no orphaned child content lingers.
  const subAgentToolParts = await ctx.db
    .query("subAgentToolParts")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .collect();
  for (const p of subAgentToolParts) await ctx.db.delete(p._id);
  // The user's sub-agent INTERACTIONS (2c) hold conversation content keyed by chat.
  const subAgentInteractions = await ctx.db
    .query("subAgentInteractions")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .collect();
  for (const i of subAgentInteractions) await ctx.db.delete(i._id);
  // The owner's document drafts (edited-file text is user content).
  if (chat) {
    const draftRows = await ctx.db
      .query("documentDrafts")
      .withIndex("by_user_chat_filename", (q) =>
        q.eq("userId", chat.userId).eq("chatId", chatId),
      )
      .collect();
    for (const d of draftRows) await ctx.db.delete(d._id);
  }
  // The owner's bookmarks (rows are owner-only by construction — the mutations
  // are owner-scoped): drop them with the chat, labels are user content.
  if (chat) {
    const bookmarkRows = await ctx.db
      .query("chatBookmarks")
      .withIndex("by_user_chat", (q) =>
        q.eq("userId", chat.userId).eq("chatId", chatId),
      )
      .collect();
    for (const b of bookmarkRows) await ctx.db.delete(b._id);
  }
  // Per-user read state: drop the owner's chatReads row with the chat (rows are
  // owner-only by construction — markChatSeen is owner-scoped and no-ops under
  // impersonation), so deletions never leave orphans eating the myChatReads
  // window (codex P2).
  if (chat) {
    const read = await ctx.db
      .query("chatReads")
      .withIndex("by_user_chat", (q) =>
        q.eq("userId", chat.userId).eq("chatId", chatId),
      )
      .first();
    if (read) await ctx.db.delete(read._id);
  }
  // L2: if this chat held the SOURCE of an in-flight documentary fetch, release the
  // hidden chat's lock (same as deleteMessage). `chatId` is skipped when IT is the
  // documentary chat — it is being deleted here anyway.
  if (chat) await releaseDanglingDocumentaryFetch(ctx, chat.userId, chatId);
  // Hybrid rehydration: drop the chat's rolling-summary row and, if this chat was
  // the target of an in-flight summarize job, release the hidden chat's lock.
  if (chat) {
    try {
      await purgeSummaryForChat(ctx, chatId, chat.userId);
    } catch (e) {
      console.error("[chatsum] purge on delete:", (e as Error)?.message ?? e);
    }
  }
  await ctx.db.delete(chatId);
}

export const deleteChat = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await cascadeDeleteChat(ctx, chatId);
    await auditImpersonated(ctx, actor, "chat.delete", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

export const pinChat = mutation({
  args: { chatId: v.id("chats"), pinned: v.boolean() },
  handler: async (ctx, { chatId, pinned }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.db.patch(chatId, { pinned });
  },
});

/** WORKING-SET toggle: hidden=true removes the chat from the left sidebar
 *  (it stays in its folder — the folder page / search still reach it);
 *  hidden=false puts it back. Stored as `true`/absent so the default (absent)
 *  keeps every pre-existing chat visible. */
export const setChatSidebar = mutation({
  args: { chatId: v.id("chats"), hidden: v.boolean() },
  handler: async (ctx, { chatId, hidden }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.db.patch(chatId, { sidebarHidden: hidden ? true : undefined });
  },
});

export const setChatColor = mutation({
  args: { chatId: v.id("chats"), color: chatColorValidator },
  handler: async (ctx, { chatId, color }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await ctx.db.patch(chatId, { color: color ?? undefined });
  },
});

export const moveChatToProject = mutation({
  args: { chatId: v.id("chats"), projectId: v.union(v.id("projects"), v.null()) },
  handler: async (ctx, { chatId, projectId }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    if (projectId) await requireOwnedProject(ctx, userId, projectId);
    const minKey = await minChatSortKey(ctx, userId, projectId);
    await ctx.db.patch(chatId, {
      projectId: projectId ?? undefined,
      sortKey: minKey - 1, // drop at the top of the destination list
    });
    await auditImpersonated(ctx, actor, "chat.move", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

// Reorder: place `chatId` between two neighbours via a fractional key. The
// client passes the sortKeys of the chats now above/below the drop slot
// (either may be null at a list edge). ONE row write — no N-row renumbering.
export const reorderChat = mutation({
  args: {
    chatId: v.id("chats"),
    prevKey: v.union(v.number(), v.null()),
    nextKey: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { chatId, prevKey, nextKey }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    let key: number;
    if (prevKey === null && nextKey === null) key = 0;
    else if (prevKey === null) key = nextKey! - 1;
    else if (nextKey === null) key = prevKey + 1;
    else key = (prevKey + nextKey) / 2;
    await ctx.db.patch(chatId, { sortKey: key });
  },
});

// Generate a short-lived upload URL for an attachment. Scoped to an
// authenticated user so anonymous callers cannot upload blobs.
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireActive(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});
