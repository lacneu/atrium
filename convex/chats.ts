// Chat lifecycle (public, ACTIVE-user scoped).
//
// All chat mutations require an ACTIVE role (user|admin): a merely-authenticated
// "pending" user is rejected by requireActive. Profile creation happens at login
// via me.bootstrap (the only thing a pending user may call), not here.

import { resolveAgentTypes } from "./lib/agentTypes";
import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireActive, requireOwnedChat, requireReachableChat } from "./lib/access";
import { ROSTER_READ_WINDOW } from "./lib/chatAccess";
import { liveTalkCall } from "./talk";
import { enrichUserAgents, getEffectiveGrants } from "./agents";
import { auditImpersonated } from "./lib/audit";
import { isChatBusy } from "./lib/outboxQueue";
import { releaseDanglingDocumentaryFetch } from "./documentAttachments";
import { purgeSummaryForChat } from "./chatSummaries";
import { AGENT_REQUEST_DELETE_READS, deleteChatAgentRequests } from "./agentRequests";
import { CHAT_WITHDRAW_BATCH, withdrawAllChatNotifications } from "./notifications";
import { drainNextQueued } from "./lib/outboxQueue";
import { isTrashed, purgeDateFor } from "./lib/trash";
import {
  BLOB_RELEASE_READS,
  releaseBlob,
  storageIdsOfOutbox,
  storageIdsOfPart,
} from "./lib/blobs";

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
    .filter((c) => (c.projectId ?? null) === projectId && !c.archived && !isTrashed(c))
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

/**
 * Move a chat that has said NOTHING yet onto another agent.
 *
 * PRODUCTION REPORT (2026-07-31). A chat is bound to its agent at creation; when the
 * agent picked at creation sits on a gateway that is down, the conversation had
 * exactly one way out: delete it. This mutation moves an EMPTY chat's binding — the
 * conversation panel offers it on a thread that has not spoken. The composer never
 * calls it: its pick routes the next turn (turn 1 included), and a started
 * conversation changes its primary through `chatAgents.setPrimaryAgent`.
 *
 * THE GUARD IS "NO MESSAGE AT ALL", not "no user turn". Message attribution falls
 * back to the chat's primary agent for any message carrying no explicit routing
 * stamp (`resolveMessageAgents`), so rebinding a thread that already holds messages
 * could silently re-label who said what. An empty thread has nothing to re-label.
 * A chat with assistant-only content (a spontaneous announce) is therefore REFUSED
 * here and stays locked — a known gap, kept narrow on purpose.
 *
 * Authorization is `requireAgentMembership`, the same gate `createChat` applies:
 * this reaches the same field by the same right, so it must not be an easier door.
 */
export const rebindChatAgent = mutation({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { chatId, instanceName, agentId }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    await requireAgentMembership(ctx, userId, instanceName, agentId);
    // Entitlement is not the whole predicate. `requireAgentMembership` accepts an
    // agent the gateway has DELETED — the picker renders those as disabled rows, so
    // the UI never offers one, but a stale client or a direct call would bind a chat
    // to an agent no dispatch can reach: the first turn then fails `no_agent`, or
    // silently falls back to a DIFFERENT agent than the one the user was shown.
    //
    // Read the state from `enrichUserAgents`, the SAME source the picker renders
    // from, rather than re-deriving it. The first attempt here tested
    // `presentInLastOk === false` and missed the other half: a grant whose `agents`
    // row is GONE after a successful discovery is also "deleted". Two spellings of
    // one rule is how they drift — and this one drifted before it had shipped.
    // `unknown`/`stale` (discovery absent or failing) deliberately still pass: the
    // agent may be perfectly fine and we simply cannot see it.
    const entitled = await enrichUserAgents(ctx, userId);
    const target = entitled.find(
      (a) => a.instanceName === instanceName && a.agentId === agentId,
    );
    if (target?.state === "deleted") {
      throw new Error("Invalid: agent is deleted on its gateway");
    }
    // NOT WHILE SOMEONE IS SPEAKING. A rebind moves the whole conversation to
    // another agent; the live voice call is pinned to the one it was minted for and
    // would be left addressing a session this chat no longer uses. Same rule as the
    // per-turn route in `send.ts`, same code, so the composer explains it once.
    const call = await liveTalkCall(ctx, chatId);
    if (
      call !== null &&
      (call.instanceName !== instanceName || call.agentId !== agentId)
    ) {
      throw new Error("TALK_CALL_ACTIVE");
    }
    const firstMessage = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    if (firstMessage !== null) {
      throw new Error("Invalid: chat already has messages");
    }
    // Delegate the WRITE rather than patching here: `bindChatTarget` also drops the
    // stale provider conversation id, which belonged to the previous agent. An empty
    // chat rarely holds one, but duplicating the rule is how the two copies drift.
    //
    // THE EMPTINESS CHECK ABOVE AND THIS WRITE ARE ATOMIC. `ctx.runMutation` from a
    // MUTATION runs "within the same transaction […] in a sub-transaction" (convex
    // `GenericMutationCtx.runMutation`); it is from an ACTION that "each runMutation
    // call is a separate write transaction". A reviewer read the action contract onto
    // this call and reported a race where a concurrent first message slips between the
    // read and the write — it cannot, and Convex's OCC would abort this mutation
    // anyway, the `messages` read being in its read set. Moving this handler into an
    // action, or splitting it in two, WOULD open that race.
    //
    // What is NOT atomic is a rebind racing a send from another surface.
    //
    // KNOWN GAP, stated rather than implied: tab B fires its first send toward agent
    // A with no routedAgent (the pick equals the primary it displays), tab A rebinds
    // to B while that request is still in transit, and the send lands afterwards. It
    // resolves against the CURRENT binding and is answered by the new agent, with
    // nothing shown to the sender. Closing it properly means giving `sendMessage` a
    // precondition — the binding generation the client displayed — and refusing
    // atomically when it no longer matches. That is a change to the hottest path in
    // the app and does not belong in this lot.
    await ctx.runMutation(internal.bridge.bindChatTarget, {
      chatId,
      instanceName,
      agentId,
    });
    // CLEAR THE PER-TURN ROUTING RESIDUE. `bindChatTarget` moves the binding; it
    // does not touch `perTurnRouting`/`lastRouted*`/`routingSegment`, and rightly so
    // — the dispatch calls it MID-conversation, where that history is real.
    //
    // Here it is not. A thread can reach "no messages" by having its first turn
    // DELETED (the truncation removes them all) while those four fields survive on
    // the chat. Rebind such a chat to B and: the composer's default selection falls
    // back to the persisted lastRouted A, so the chip shows A; turn 1 goes to B (it
    // carries no routedAgent); and turn 2 — with `perTurnRouting` still set — is
    // stamped explicitly for A. The user moved the conversation and their messages
    // quietly go back to the old agent. An empty thread has no routing history, so
    // carrying one is simply false.
    await ctx.db.patch(chatId, {
      updatedAt: Date.now(),
      perTurnRouting: undefined,
      lastRoutedInstanceName: undefined,
      lastRoutedAgentId: undefined,
      routingSegment: undefined,
    });
    // The new primary was perhaps already in the room as an ADDED agent. The
    // primary is never a `chatAgents` row (convex/chatAgents.ts), so that row goes:
    // left, the same agent would be listed twice and counted against the limit.
    // The former primary simply leaves the room — the owner re-adds it if wanted.
    const duplicate = await ctx.db
      .query("chatAgents")
      .withIndex("by_chat_instance_agent", (q) =>
        q.eq("chatId", chatId).eq("instanceName", instanceName).eq("agentId", agentId),
      )
      .first();
    if (duplicate !== null) await ctx.db.delete(duplicate._id);
    await auditImpersonated(ctx, actor, "chat.rebind", {
      resource: "chat",
      resourceId: chatId,
    });
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
    // A reset DURING an active turn resets the very session the run is
    // writing — the run dies or trips the session-lock conflict (the family
    // behind prod report ms746b01…). The UI disables the action while the
    // chat is busy; this guard makes it impossible rather than advised
    // against. Stop the turn first, then reset.
    if (await isChatBusy(ctx, chatId)) {
      return { ok: false as const, reason: "busy" as const };
    }
    await ctx.scheduler.runAfter(0, internal.bridge.dispatchReset, {
      chatId,
      userId,
    });
    await auditImpersonated(ctx, actor, "chat.reset", {
      resource: "chat",
      resourceId: chatId,
    });
    return { ok: true as const };
  },
});

// Delete a chat and EVERYTHING that hangs off it — the PERMANENT purge, run when a
// trashed conversation's retention ends (trash.purgeTrash), when its owner or an
// admin deletes it from the trash, and when an account is deleted. (Deleting a
// conversation from the sidebar moves it to the trash: moveChatToTrash below.)
//
// Convex has no cascade, and one transaction has a read budget: a group within the
// published limits (a full room of bookmarking members, hundreds of messages with
// their parts) can hold more dependent rows than one transaction may read — done in
// one pass, the deletion failed whole and the conversation became undeletable.
//
// So: the chat row goes FIRST, in the caller's transaction — from that instant
// nothing reaches the conversation (every access check reads the chat) — and its
// dependents follow in batches of at most CHAT_SWEEP_BUDGET reads, the first one
// inline (a typical chat is gone at once) unless the caller purges many chats at
// once, the rest self-scheduled (sweepDeletedChat). Every dependent is found by its
// chat (or its message), so the sweep needs nothing of the row it deleted but the
// owner's id, which it carries. Each batch is idempotent and resumable: a row is
// deleted only once what hangs off it is gone.
//
// RESUMABLE BEYOND ITS OWN CHAIN. A `chatPurges` row is written with the deletion
// and removed by the batch that finishes; every batch stamps it. A chain that died
// (a batch that threw — the scheduler does not retry those) leaves a stale stamp,
// and the trash cron re-arms it (trash.purgeTrash).
//
// BLOBS GO WITH THEIR LAST HOLDER. Every deleted row that names a storage blob
// releases it in the same transaction (lib/blobs.releaseBlob): the blob is deleted
// only when nothing else — a fork's copy, a documentary attachment, a rendition —
// still references it. (A deleted blob is unreachable; on a self-hosted backend its
// bytes stay on disk until a physical collector reclaims them — lib/blobs.)
export async function cascadeDeleteChat(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  opts: { inline?: boolean } = {},
): Promise<void> {
  const chat = await ctx.db.get(chatId);
  if (chat === null) return;
  // Hybrid rehydration: drop the chat's rolling-summary row and, if this chat was
  // the target of an in-flight summarize job, release the hidden chat's lock —
  // now, not when the sweep ends: the lock would hold the owner's summarizer.
  try {
    await purgeSummaryForChat(ctx, chatId, chat.userId);
  } catch (e) {
    console.error("[chatsum] purge on delete:", (e as Error)?.message ?? e);
  }
  await ctx.db.delete(chatId);
  await dropReadMarkers(ctx, chatId, chat.userId);
  const now = Date.now();
  const ledger = await ctx.db
    .query("chatPurges")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .first();
  if (ledger === null) {
    await ctx.db.insert("chatPurges", {
      chatId,
      ownerId: chat.userId,
      startedAt: now,
      updatedAt: now,
    });
  }
  if (opts.inline === false) {
    await ctx.scheduler.runAfter(0, internal.chats.sweepDeletedChat, {
      chatId,
      ownerId: chat.userId,
    });
    return;
  }
  await sweepChatDependents(ctx, chatId, chat.userId);
}

/**
 * Put a conversation in the TRASH: hidden everywhere at once, restorable until
 * `purgeAfter` (lib/trash). Nothing is deleted — seats, messages, files and blobs
 * all stay, so a restore gives back exactly what was there.
 *
 * WHAT HAPPENS TO WORK IN FLIGHT. A reply already streaming is left to finish: the
 * bridge's writes land in the trashed conversation as they would anywhere (the
 * ingest path does not look at the trash), so the stream path cannot break, and a
 * restore shows the reply. What has NOT left yet is held rather than dropped: a
 * queued follow-up is not drained while the chat is in the trash
 * (lib/outboxQueue.drainNextQueued), and a pending turn not yet sent is re-parked
 * by the dispatch (bridge.reparkRowIfBusy). A restore drains them.
 *
 * The conversation's bell entries are withdrawn for everyone (a mention or an
 * agent question would link to a page nobody can open), and a new one is not rung
 * while it stays there (notifications.notifyUser).
 *
 * False when it already was in the trash (its dates are kept).
 */
export async function moveChatToTrash(
  ctx: MutationCtx,
  chat: Doc<"chats">,
  trashedBy: Id<"users">,
  /** Documents this call touched (read + written) are added here — a caller that
   *  trashes many conversations in one transaction budgets on it. */
  meter?: { spent: number },
): Promise<boolean> {
  if (isTrashed(chat)) return false;
  const now = Date.now();
  await ctx.db.patch(chat._id, {
    trashedAt: now,
    purgeAfter: purgeDateFor(now),
    trashedBy,
  });
  let spent = 1 + (await withdrawAllChatNotifications(ctx, chat._id));
  // A restore comes back without read markers — "no marker" reads as "no unread
  // dot", never a false one.
  spent += await dropReadMarkers(ctx, chat._id, chat.userId);
  if (meter !== undefined) meter.spent += spent;
  return true;
}

/** The most documents one moveChatToTrash can touch: the chat, a full first
 *  withdrawal batch of bell entries (read + delete) and the read markers of a full
 *  roster window (the seats, then a marker read + delete per reader). */
export const TRASH_CHAT_MAX_COST =
  2 + 2 * CHAT_WITHDRAW_BATCH + ROSTER_READ_WINDOW + 2 * (1 + ROSTER_READ_WINDOW);

/**
 * Delete a conversation's READ MARKERS now, for its owner and every seat — at trash
 * time and at the start of a purge. `chatReads.myChatReads` returns markers without
 * reading the chats (it stays off the chats' write path on purpose), so a marker
 * left behind would keep naming a conversation that is trashed or gone. Bounded by
 * the roster window.
 */
async function dropReadMarkers(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  ownerId: Id<"users">,
): Promise<number> {
  const seats = await ctx.db
    .query("chatParticipants")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .take(ROSTER_READ_WINDOW);
  let spent = seats.length;
  for (const reader of [ownerId, ...seats.map((seat) => seat.userId)]) {
    const marker = await ctx.db
      .query("chatReads")
      .withIndex("by_user_chat", (q) => q.eq("userId", reader).eq("chatId", chatId))
      .first();
    spent += 1;
    if (marker !== null) {
      await ctx.db.delete(marker._id);
      spent += 1;
    }
  }
  return spent;
}

/**
 * Take a conversation out of the trash, as it was: its seats give their holders
 * access again, its held turns drain. A conversation whose folder was deleted
 * meanwhile (a folder's deletion trashes its conversations and removes the folder)
 * comes back at the root.
 */
export async function restoreFromTrash(ctx: MutationCtx, chat: Doc<"chats">): Promise<void> {
  let folderGone = false;
  if (chat.projectId !== undefined) {
    const folder = await ctx.db.get(chat.projectId);
    folderGone = folder === null || folder.userId !== chat.userId;
  }
  await ctx.db.patch(chat._id, {
    trashedAt: undefined,
    purgeAfter: undefined,
    trashedBy: undefined,
    ...(folderGone ? { projectId: undefined } : {}),
  });
  await drainNextQueued(ctx, chat._id);
}

/** Reads one chat-deletion batch may spend, across ALL its dependents. */
export const CHAT_SWEEP_BUDGET = 1024;

export const sweepDeletedChat = internalMutation({
  args: { chatId: v.id("chats"), ownerId: v.id("users") },
  handler: async (ctx, { chatId, ownerId }) => {
    await sweepChatDependents(ctx, chatId, ownerId);
  },
});

/**
 * One bounded batch of a deleted chat's dependents; schedules the next while any
 * remain. Phases in order — the non-terminal outbox first (nothing may drain from a
 * deleted chat), then the roster with what each person kept there, the owner's own
 * state, the messages with what hangs off them, the sub-agent rows, the room's
 * agents, the agent requests, and the conversation-keyed leftovers (bell entries,
 * delivery timings, ended calls) — each taking only what the budget left allows.
 */
async function sweepChatDependents(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  ownerId: Id<"users">,
): Promise<void> {
  let budget = CHAT_SWEEP_BUDGET;
  const more = async () => {
    // The progress stamp the trash cron reads to tell a live chain from a dead one.
    const ledger = await ctx.db
      .query("chatPurges")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    if (ledger !== null) await ctx.db.patch(ledger._id, { updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.chats.sweepDeletedChat, { chatId, ownerId });
  };
  /** Read and delete up to what the budget allows; true when the range is empty. */
  const drain = async (
    rows: ReadonlyArray<{ _id: Id<TableNames> }>,
    asked: number,
  ): Promise<boolean> => {
    budget -= rows.length;
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length < asked;
  };
  /** The same, for rows that name storage blobs: each row is deleted, THEN its
   *  blobs are released (lib/blobs.releaseBlob), in this transaction, so the last
   *  holder to go releases the blob. A row's release is charged to the budget; when it
   *  runs out the rest of the page waits for the next batch (at least one row is
   *  always processed, so the sweep progresses). */
  const drainReleasing = async <T extends { _id: Id<TableNames> }>(
    rows: ReadonlyArray<T>,
    asked: number,
    blobsOf: (row: T) => Id<"_storage">[],
  ): Promise<boolean> => {
    budget -= rows.length;
    let done = 0;
    for (const r of rows) {
      const blobs = blobsOf(r);
      if (done > 0 && budget < blobs.length * BLOB_RELEASE_READS) return false;
      await ctx.db.delete(r._id);
      for (const blob of blobs) {
        budget -= BLOB_RELEASE_READS;
        await releaseBlob(ctx, blob, { reason: "chat_purge" });
      }
      done += 1;
    }
    return rows.length < asked;
  };

  // 1. The outbox, EVERY status. The non-terminal ones first — `pending`
  //    (in-flight) AND `queued` (parked follow-ups) — so drainNextQueued can't
  //    dispatch a deleted chat's send; then the settled `sent` / `failed` rows,
  //    which still carry the turn's text, quotes, mentions and attachment
  //    references and would otherwise outlive the conversation for good.
  for (const status of ["pending", "queued", "sent", "failed"] as const) {
    const asked = Math.max(budget, 0);
    const rows = await ctx.db
      .query("outbox")
      .withIndex("by_chat_status", (q) => q.eq("chatId", chatId).eq("status", status))
      .take(asked);
    if (!(await drainReleasing(rows, asked, storageIdsOfOutbox)) || budget <= 0) return more();
  }

  // 2. GROUP CHAT roster: each seat with that person's read marker, their bookmarks
  //    and document drafts (a participant keeps both too) and their "you were
  //    added" entry. A seat goes
  //    only once its holder's state here is gone. Left behind, a roster row keeps a
  //    slot in the person's bounded participation scan, and would hand back access
  //    were the chat id ever reused.
  for (;;) {
    const seat = await ctx.db
      .query("chatParticipants")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    budget -= 1;
    if (seat === null) break;
    if (!(await dropMemberState(ctx, chatId, seat.userId, () => budget, (n) => (budget -= n)))) {
      return more();
    }
    const added = await ctx.db
      .query("notifications")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", `chat_added:${String(seat._id)}`))
      .take(8);
    await drain(added, 8);
    await ctx.db.delete(seat._id);
    if (budget <= 0) return more();
  }

  // 3. The owner's own state here: read marker, bookmarks (labels are user content)
  //    and document drafts (edited-file text).
  if (!(await dropMemberState(ctx, chatId, ownerId, () => budget, (n) => (budget -= n)))) {
    return more();
  }
  if (budget <= 0) return more();

  // 4. Messages, each with what hangs off it: parts and their mirrored files rows
  //    (the file-mirror invariant) — each releasing its blob —, documentary
  //    attachments (their blobs too), the live-text row and the live-activity stamp,
  //    the stream chunks (their own bounded GC), and the entries of whoever it
  //    named. A message goes only once all of that is gone.
  for (;;) {
    const m = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    budget -= 1;
    if (m === null) break;
    {
      const asked = Math.max(budget, 0);
      const parts = await ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .take(asked);
      if (!(await drainReleasing(parts, asked, (p) => storageIdsOfPart(p.part))) || budget <= 0) {
        return more();
      }
    }
    {
      const asked = Math.max(budget, 0);
      const files = await ctx.db
        .query("files")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .take(asked);
      if (!(await drainReleasing(files, asked, (f) => [f.storageId])) || budget <= 0) {
        return more();
      }
    }
    {
      const asked = Math.max(budget, 0);
      const docs = await ctx.db
        .query("documentAttachments")
        .withIndex("by_source_message", (q) => q.eq("sourceMessageId", m._id))
        .take(asked);
      const blobsOfDoc = (d: Doc<"documentAttachments">) =>
        d.storageId === undefined ? [] : [d.storageId];
      if (!(await drainReleasing(docs, asked, blobsOfDoc)) || budget <= 0) return more();
    }
    const hanging = [
      (n: number) =>
        ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", m._id)).take(n),
      (n: number) =>
        ctx.db
          .query("liveTurnActivity")
          .withIndex("by_message", (q) => q.eq("messageId", m._id))
          .take(n),
    ];
    for (const read of hanging) {
      const asked = Math.max(budget, 0);
      if (!(await drain(await read(asked), asked)) || budget <= 0) return more();
    }
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
    budget -= 1;
    if ((m.mentions?.length ?? 0) > 0) {
      const named = await ctx.db
        .query("notifications")
        .withIndex("by_dedupe", (q) => q.eq("dedupeKey", `mention:${String(m._id)}`))
        .take(64);
      await drain(named, 64);
    }
    await ctx.db.delete(m._id);
    if (budget <= 0) return more();
  }

  // 5. Sub-agent observations, their per-tool detail, and the user's sub-agent
  //    interactions — conversation content keyed by chat.
  //    `runBubbles` rides with them: ids only, and meaningless without the chat.
  for (const table of [
    "subAgents",
    "subAgentToolParts",
    "subAgentInteractions",
    "runBubbles",
  ] as const) {
    const asked = Math.max(budget, 0);
    const rows = await ctx.db
      .query(table)
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .take(asked);
    if (!(await drain(rows, asked)) || budget <= 0) return more();
  }

  // 6. The conversation's added agents.
  {
    const asked = Math.max(budget, 0);
    const rows = await ctx.db
      .query("chatAgents")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .take(asked);
    if (!(await drain(rows, asked)) || budget <= 0) return more();
  }

  // 6b. The owner's knowledge choices for this conversation's agents.
  {
    const asked = Math.max(budget, 0);
    const rows = await ctx.db
      .query("chatKnowledgeChoices")
      .withIndex("by_chat_agent", (q) => q.eq("chatId", chatId))
      .take(asked);
    if (!(await drain(rows, asked)) || budget <= 0) return more();
  }

  // 7. What the agent asked and what was answered, with their bell entries.
  {
    const limit = Math.floor(budget / AGENT_REQUEST_DELETE_READS);
    if (limit < 1) return more();
    if (await deleteChatAgentRequests(ctx, chatId, limit)) return more();
  }

  // 8. What is keyed on the conversation alone: every bell entry about it (any
  //    kind, anyone's), the delivery-latency samples recorded on it, and its ENDED
  //    voice calls. A call not ended yet is left to the talk janitor (its hard TTL):
  //    the hangup authorizes on that row, and the unmount after a deletion must
  //    still be able to close the gateway-owned call.
  {
    const asked = Math.max(budget, 0);
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .take(asked);
    if (!(await drain(rows, asked)) || budget <= 0) return more();
  }
  {
    const asked = Math.max(budget, 0);
    const rows = await ctx.db
      .query("deliveryTimings")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .take(asked);
    if (!(await drain(rows, asked)) || budget <= 0) return more();
  }
  {
    const asked = Math.max(budget, 0);
    const rows = await ctx.db
      .query("talkSessions")
      .withIndex("by_chat_live", (q) => q.eq("chatId", chatId).gte("endedAt", 0))
      .take(asked);
    if (!(await drain(rows, asked)) || budget <= 0) return more();
  }

  // Done. L2: if this chat held the SOURCE of an in-flight documentary fetch,
  // release the hidden chat's lock — only now that its messages are gone.
  await releaseDanglingDocumentaryFetch(ctx, ownerId, chatId);
  for (const ledger of await ctx.db
    .query("chatPurges")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .take(8)) {
    await ctx.db.delete(ledger._id);
  }
}

/**
 * One person's state in a deleted chat — read marker, then bookmarks — within the
 * sweep's budget. True when none is left.
 */
async function dropMemberState(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
  left: () => number,
  spend: (n: number) => void,
): Promise<boolean> {
  const read = await ctx.db
    .query("chatReads")
    .withIndex("by_user_chat", (q) => q.eq("userId", userId).eq("chatId", chatId))
    .first();
  spend(1);
  if (read !== null) await ctx.db.delete(read._id);
  const asked = Math.max(left(), 0);
  const marks = await ctx.db
    .query("chatBookmarks")
    .withIndex("by_user_chat", (q) => q.eq("userId", userId).eq("chatId", chatId))
    .take(asked);
  spend(marks.length);
  for (const b of marks) await ctx.db.delete(b._id);
  if (marks.length >= asked) return false;
  // Document drafts: edited-file text, kept per reader (owner AND participants).
  const draftsAsked = Math.max(left(), 0);
  const drafts = await ctx.db
    .query("documentDrafts")
    .withIndex("by_user_chat_filename", (q) => q.eq("userId", userId).eq("chatId", chatId))
    .take(draftsAsked);
  spend(drafts.length);
  for (const d of drafts) await ctx.db.delete(d._id);
  return drafts.length < draftsAsked;
}

/** Delete a conversation from the sidebar / a folder menu: it goes to the TRASH
 *  (moveChatToTrash), restorable by its owner for the retention period. Owner-only,
 *  as before — a participant leaves a conversation, they do not delete it. */
export const deleteChat = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId, actor } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    await moveChatToTrash(ctx, chat, actor.realUserId);
    await auditImpersonated(ctx, actor, "chat.trash", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

export const pinChat = mutation({
  args: { chatId: v.id("chats"), pinned: v.boolean() },
  handler: async (ctx, { chatId, pinned }) => {
    const { userId } = await requireActive(ctx);
    // A pin is a personal preference, like the sidebar opt-out below: a guest may
    // pin a conversation they were invited into, and it is written on THEIR
    // membership — `chats.pinned` is the owner's, and writing it would reorder the
    // owner's sidebar.
    const access = await requireReachableChat(ctx, userId, chatId);
    if (access.role === "owner") {
      await ctx.db.patch(chatId, { pinned });
      return;
    }
    const row = await ctx.db
      .query("chatParticipants")
      .withIndex("by_chat_user", (q) => q.eq("chatId", chatId).eq("userId", userId))
      .unique();
    if (row === null) return; // left between the access check and here
    await ctx.db.patch(row._id, { pinned: pinned ? true : undefined });
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
    // Removing a conversation from YOUR sidebar is a personal preference, so a
    // participant may do it — but it is written where it belongs to them. The
    // chat's own flag is per CHAT: writing a participant's choice there would take
    // the conversation off everybody else's sidebar too.
    const access = await requireReachableChat(ctx, userId, chatId);
    if (access.role === "owner") {
      await ctx.db.patch(chatId, { sidebarHidden: hidden ? true : undefined });
      return;
    }
    const row = await ctx.db
      .query("chatParticipants")
      .withIndex("by_chat_user", (q) => q.eq("chatId", chatId).eq("userId", userId))
      .unique();
    if (row === null) return; // left between the access check and here
    await ctx.db.patch(row._id, { sidebarHidden: hidden ? true : undefined });
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
