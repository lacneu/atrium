// The AGENTS of a conversation: the primary (the chat's binding) and the others the
// owner put in the room.
//
// WHAT "ADDING AN AGENT" MEANS. A gateway session answers with exactly one agent —
// OpenClaw 2026.9.6 refuses an agentId that does not match the session key
// (session-request-agent.ts), and has no agent membership for a session at all.
// Atrium already runs several agents on one visible thread: a turn addressed to
// another agent re-keys the gateway session and rehydrates the thread for it
// (per-turn routing, `chats.perTurnRouting` + `routingSegment`). Adding an agent
// therefore changes WHO MAY BE ADDRESSED, not the transport: the roster is what a
// participant may talk to, and what the composer offers first to everyone.
//
// WHO DECIDES. The owner, and the managers they named — the same authority as the
// people roster (convex/lib/chatAccess.ts). Every turn runs under the OWNER's
// identity on the gateway, so an agent the owner is not entitled to could never
// answer anyway: it is refused at the source rather than failing later at
// dispatch. A manager must hold the agent too — they cannot put in the room an
// agent they could not use themselves.

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { enrichUserAgents, type EnrichedUserAgent } from "./agents";
import { requireAgentMembership } from "./chats";
import { requireActive, requireOwnedChat } from "./lib/access";
import { auditImpersonated } from "./lib/audit";
import { assertNoPendingPurge, deadAccessRow, liveAccessRows } from "./lib/agentPurge";
import { isChatBusy } from "./lib/outboxQueue";
import { liveTalkCall } from "./talk";
import {
  canManageRoom,
  resolveChatAccess,
  type ChatAccess,
  type ChatRole,
  type RoomRole,
} from "./lib/chatAccess";

/** Agents a conversation may hold BESIDES its primary. A product bound that also
 *  bounds every read of the roster. */
export const MAX_CHAT_AGENTS = 8;

export interface ChatAgentView {
  instanceName: string;
  agentId: string;
  displayName: string | null;
  emoji: string | null;
  description: string | null;
  model: string | null;
  /** The bridge family of its instance — what the composer groups agents by. */
  kind: "openclaw" | "hermes";
  role: "primary" | "member";
  /** The VIEWER may address this agent. For the owner: in their own grants and
   *  still present. For a guest: the same test on the OWNER's grants — a guest
   *  speaks on the owner's delegation (send.ts). The panel says when it is not. */
  usable: boolean;
  /** Removed from its gateway since it was added. */
  gone: boolean;
  addedAt: number | null;
}

/** Every roster row, bounded, oldest first — including one a pending agent purge
 *  revoked: what the room's LIMIT counts (the row still occupies its place until
 *  the sweep deletes it, and the bounded read must still see every live row). */
async function chatAgentRowsRaw(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
): Promise<Doc<"chatAgents">[]> {
  return await ctx.db
    .query("chatAgents")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .take(MAX_CHAT_AGENTS);
}

/** The roster of agents, bounded. Oldest first. A delegation a pending agent purge
 *  revoked is not part of it (lib/agentPurge): every room read and gate goes
 *  through here or isConversationAgent. */
export async function chatAgentRows(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
): Promise<Doc<"chatAgents">[]> {
  return await liveAccessRows(ctx, "rooms", await chatAgentRowsRaw(ctx, chatId));
}

/** Is this agent one a PARTICIPANT may address in this chat: the primary, or a
 *  roster row. Shared by the send gate and its tests. */
export async function isConversationAgent(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  ref: { instanceName: string; agentId: string },
): Promise<boolean> {
  if (chat.instanceName === ref.instanceName && chat.agentId === ref.agentId) {
    return true;
  }
  const row = await ctx.db
    .query("chatAgents")
    .withIndex("by_chat_instance_agent", (q) =>
      q
        .eq("chatId", chat._id)
        .eq("instanceName", ref.instanceName)
        .eq("agentId", ref.agentId),
    )
    .first();
  // A delegation the purge revoked is not one: the agent may already be back
  // (re-discovered, re-enabled) on the owner's grants (codex pass 8).
  return row !== null && !(await deadAccessRow(ctx, "rooms", row));
}

/**
 * The agent a person's view of the composer projects the NEXT send onto, and
 * whose rights resolve it.
 *
 * The dispatch resolves every turn of a conversation on its OWNER's grants
 * (bridge.ts passes the chat owner), a guest's included — that is the delegation —
 * and a guest addresses only the room's agents (send.ts refuses any other). Every
 * projection of the next send (capabilities, availability, stream transport) must
 * resolve the same way, or it describes a send that will never happen: the guest's
 * own grants may be narrower, wider, or none. A selection outside the room is
 * dropped, exactly as if nothing were selected.
 */
export async function roomProjection(
  ctx: QueryCtx | MutationCtx,
  access: ChatAccess,
  routedAgent: { instanceName: string; agentId: string } | null,
): Promise<{
  resolver: Id<"users">;
  routedAgent: { instanceName: string; agentId: string } | null;
}> {
  const resolver = access.chat.userId;
  if (routedAgent === null || access.role === "owner") return { resolver, routedAgent };
  return {
    resolver,
    routedAgent: (await isConversationAgent(ctx, access.chat, routedAgent))
      ? routedAgent
      : null,
  };
}

const refKey = (instanceName: string, agentId: string) =>
  `${instanceName.length}:${instanceName}/${agentId}`;

async function agentView(
  ctx: QueryCtx,
  ref: { instanceName: string; agentId: string },
  role: ChatAgentView["role"],
  addedAt: number | null,
  mine: Map<string, EnrichedUserAgent>,
): Promise<ChatAgentView> {
  const own = mine.get(refKey(ref.instanceName, ref.agentId));
  // Names are non-secret and every person in the room already sees who answers;
  // the row is read directly when the viewer has no grant on the agent.
  const row =
    own === undefined
      ? await ctx.db
          .query("agents")
          .withIndex("by_instance_agent", (q) =>
            q.eq("instanceName", ref.instanceName).eq("agentId", ref.agentId),
          )
          .first()
      : null;
  const gone =
    own !== undefined
      ? own.state === "deleted"
      : row === null || row.presentInLastOk === false;
  const instance =
    own === undefined
      ? await ctx.db
          .query("instances")
          .withIndex("by_name", (q) => q.eq("name", ref.instanceName))
          .first()
      : null;
  return {
    instanceName: ref.instanceName,
    agentId: ref.agentId,
    displayName: own?.displayName ?? row?.displayName ?? null,
    emoji: own?.emoji ?? row?.emoji ?? null,
    description: own?.description ?? row?.description ?? null,
    model: own?.model ?? row?.model ?? null,
    kind: own?.kind ?? instance?.kind ?? "openclaw",
    role,
    usable: own !== undefined && !gone,
    gone,
    addedAt,
  };
}

/**
 * The conversation's agents as the VIEWER sees them: the primary first, then the
 * ones added, each flagged with whether this viewer may address it. Null when the
 * chat is unreachable (deleted, or not theirs) — never a throw on a URL id.
 */
export const listChatAgents = query({
  args: { chatId: v.string() },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{
    viewerRole: ChatRole;
    /** The viewer's standing in the room (owner, manager, member, viewer). */
    viewerRoomRole: RoomRole;
    /** How the room's gateways authenticate Atrium: "token" (one shared identity —
     *  the gateway tells nobody apart), "trusted-proxy" (one identity per person),
     *  or "mixed" when the room's agents live on instances that differ (the answer
     *  then depends on the agent a turn reaches). What the panel tells people. */
    authMode: "token" | "trusted-proxy" | "mixed" | null;
    /** Under trusted-proxy: do participants' turns reach the gateway as THEIRS
     *  ("self") or as the owner's ("owner")? `instances.participantIdentity`. */
    participantIdentity: "owner" | "self";
    primary: ChatAgentView | null;
    agents: ChatAgentView[];
    limit: number;
  } | null> => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return null;
    const access = await resolveChatAccess(ctx, id, userId);
    if (access === null) return null;
    // Whose grants make an agent usable here: the owner's for a guest (the
    // delegation), the reader's own otherwise.
    const authorizing =
      access.role === "participant" ? access.chat.userId : userId;
    const mine = new Map(
      (await enrichUserAgents(ctx, authorizing)).map((a) => [
        refKey(a.instanceName, a.agentId),
        a,
      ]),
    );
    const { chat } = access;
    const primary =
      chat.instanceName && chat.agentId
        ? await agentView(
            ctx,
            { instanceName: chat.instanceName, agentId: chat.agentId },
            "primary",
            null,
            mine,
          )
        : null;
    const agents: ChatAgentView[] = [];
    for (const row of await chatAgentRows(ctx, id)) {
      agents.push(await agentView(ctx, row, "member", row.addedAt, mine));
    }
    // WHOSE NAME a participant writes under is decided PER INSTANCE — the dispatch
    // reads `participantIdentity` on the instance of the agent each turn reaches. One
    // mode for the room only when every agent's instance agrees; otherwise "mixed",
    // and the panel says it depends on the agent chosen (never the primary's mode
    // presented as the room's).
    const names = new Set<string>();
    if (chat.instanceName) names.add(chat.instanceName);
    for (const a of agents) names.add(a.instanceName);
    const modes = new Set<string>();
    let authMode: "token" | "trusted-proxy" | "mixed" | null = null;
    let participantIdentity: "owner" | "self" = "owner";
    for (const name of names) {
      const instance = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", name))
        .first();
      if (instance === null) continue;
      const mode = instance.authMode ?? "token";
      const identity =
        mode === "trusted-proxy" && instance.participantIdentity === "self" ? "self" : "owner";
      modes.add(`${mode}:${identity}`);
      authMode = mode;
      participantIdentity = identity;
    }
    if (modes.size > 1) {
      authMode = "mixed";
      participantIdentity = "owner";
    }
    return {
      viewerRole: access.role,
      viewerRoomRole: access.roomRole,
      authMode,
      participantIdentity,
      primary,
      agents,
      limit: MAX_CHAT_AGENTS,
    };
  },
});

/**
 * Agents the OWNER may still add: their own conversational, present agents, minus
 * the primary and the ones already in the room. Empty for anyone else — the
 * candidate list is the owner's tool, like `listInvitable` for people.
 */
export const listAddableAgents = query({
  args: { chatId: v.string() },
  handler: async (
    ctx,
    { chatId },
  ): Promise<
    Array<{
      instanceName: string;
      agentId: string;
      displayName: string | null;
      emoji: string | null;
      description: string | null;
      model: string | null;
      kind: "openclaw" | "hermes";
    }>
  > => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return [];
    const access = await resolveChatAccess(ctx, id, userId);
    if (access === null || !canManageRoom(access)) return [];
    const taken = new Set<string>();
    if (access.chat.instanceName && access.chat.agentId) {
      taken.add(refKey(access.chat.instanceName, access.chat.agentId));
    }
    for (const row of await chatAgentRows(ctx, id)) {
      taken.add(refKey(row.instanceName, row.agentId));
    }
    // A manager is offered what BOTH they and the owner hold: every turn runs as
    // the owner, and nobody puts in the room an agent they could not use.
    const ownerKeys =
      access.roomRole === "owner"
        ? null
        : new Set(
            (await enrichUserAgents(ctx, access.chat.userId)).map((a) =>
              refKey(a.instanceName, a.agentId),
            ),
          );
    return (await enrichUserAgents(ctx, userId))
      .filter(
        (a) =>
          a.state !== "deleted" &&
          !taken.has(refKey(a.instanceName, a.agentId)) &&
          (ownerKeys === null || ownerKeys.has(refKey(a.instanceName, a.agentId))),
      )
      .map((a) => ({
        instanceName: a.instanceName,
        agentId: a.agentId,
        displayName: a.displayName,
        emoji: a.emoji,
        description: a.description,
        model: a.model ?? null,
        kind: a.kind,
      }));
  },
});

export const addChatAgent = mutation({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { chatId, instanceName, agentId }) => {
    const { userId, actor } = await requireActive(ctx);
    const access = await resolveChatAccess(ctx, chatId, userId);
    if (access === null) throw new Error("Forbidden: chat not reachable");
    if (!canManageRoom(access)) {
      throw new Error("Forbidden: you do not manage this conversation's agents");
    }
    // The owner's OWN entitlement, and a conversational agent: every turn to it
    // runs under the owner's identity, so this is the gate that decides whether it
    // can ever answer here.
    await requireAgentMembership(ctx, access.chat.userId, instanceName, agentId);
    if (access.roomRole !== "owner") {
      await requireAgentMembership(ctx, userId, instanceName, agentId);
    }
    // Not an agent its gateway no longer has: the grant can outlive it (a picker
    // left open across a discovery), and the row would take one of the room's
    // places with nothing behind it. Same source and rule as rebindChatAgent.
    const target = (await enrichUserAgents(ctx, access.chat.userId)).find(
      (a) => a.instanceName === instanceName && a.agentId === agentId,
    );
    if (target?.state === "deleted") {
      throw new Error("Invalid: agent is deleted on its gateway");
    }
    // Never "already a member" on an old delegation the purge sweep is about to
    // delete: refused (retryable) until it is gone (lib/agentPurge).
    await assertNoPendingPurge(ctx, instanceName, agentId);
    const { chat } = access;
    if (chat.instanceName === instanceName && chat.agentId === agentId) {
      return { added: false as const, reason: "already-primary" as const };
    }
    const existing = await ctx.db
      .query("chatAgents")
      .withIndex("by_chat_instance_agent", (q) =>
        q
          .eq("chatId", chatId)
          .eq("instanceName", instanceName)
          .eq("agentId", agentId),
      )
      .first();
    if (existing !== null) {
      return { added: false as const, reason: "already-member" as const };
    }
    const rows = await chatAgentRowsRaw(ctx, chatId);
    if (rows.length >= MAX_CHAT_AGENTS) {
      // A CODE the panel localizes, like `participants_limit`.
      throw new Error(`chat_agents_limit:${MAX_CHAT_AGENTS}`);
    }
    await ctx.db.insert("chatAgents", {
      chatId,
      instanceName,
      agentId,
      // Who actually added it — the owner or a manager (provenance).
      addedBy: userId,
      addedAt: Date.now(),
    });
    // The use of an agent, delegated under someone else's identity: audited.
    await auditImpersonated(ctx, actor, "chat.agent_add", { resource: "chat", resourceId: chatId });
    return { added: true as const };
  },
});

export const removeChatAgent = mutation({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { chatId, instanceName, agentId }) => {
    const { userId, actor } = await requireActive(ctx);
    const access = await resolveChatAccess(ctx, chatId, userId);
    if (access === null) throw new Error("Forbidden: chat not reachable");
    if (!canManageRoom(access)) {
      throw new Error("Forbidden: you do not manage this conversation's agents");
    }
    const row = await ctx.db
      .query("chatAgents")
      .withIndex("by_chat_instance_agent", (q) =>
        q
          .eq("chatId", chatId)
          .eq("instanceName", instanceName)
          .eq("agentId", agentId),
      )
      .first();
    if (row === null) return { removed: false as const };
    await ctx.db.delete(row._id);
    await auditImpersonated(ctx, actor, "chat.agent_remove", { resource: "chat", resourceId: chatId });
    return { removed: true as const };
  },
});

/** Does the chat hold a turn parked in its queue — accepted, not yet dispatched. */
async function hasQueuedTurn(ctx: QueryCtx, chatId: Id<"chats">): Promise<boolean> {
  const queued = await ctx.db
    .query("outbox")
    .withIndex("by_chat_status", (q) => q.eq("chatId", chatId).eq("status", "queued"))
    .first();
  return queued !== null;
}

/** Messages one transaction pins to the former primary when the primary changes.
 *  A bound on the documents (and bytes) a single mutation reads; the rest of a long
 *  thread follows in scheduled continuations. */
export const PRIMARY_PIN_BATCH = 256;

/**
 * Pin the history to the agent that ANSWERED it, before the primary changes.
 *
 * A message carrying no routing stamp means "the chat's primary" to every reader —
 * the thread's attribution chip (resolveMessageAgents), the export, a regenerate's
 * target, the rehydration labels and the since-search (`by_chat_routed_instance_agent`).
 * Changing the primary without this would silently
 * re-attribute every unstamped turn to the NEW primary: the very re-labelling
 * `rebindChatAgent` refuses by only acting on an empty thread. Stamping the former
 * primary explicitly keeps "absent = the primary" true for every reader, with no
 * reader having to learn a new rule.
 *
 * What is stamped: an unstamped USER turn (its reply inherits the stamp, as a routed
 * turn's does), and an unstamped ASSISTANT message that no user turn precedes (a
 * spontaneous announce — nothing for it to inherit from). An imported message is left
 * alone: it carries its own label from another deployment, and no agent here answered
 * it.
 *
 * ONE BATCH, from the chat's cursor (`historyPin`) up to `until`, stamped with
 * `agent` — which MUST be the chat's primary at the time of the write. That is what
 * makes a long thread safe: pinning the current primary on its own turns changes no
 * reader's attribution, so the batches may run while the conversation goes on, and
 * the primary only changes once nothing unstamped is left before the change (the
 * last batch runs in setPrimaryAgent's own transaction). Returns whether the thread
 * is pinned through `until`.
 */
export async function pinUnroutedBatch(
  ctx: MutationCtx,
  chat: Doc<"chats">,
  agent: { instanceName: string; agentId: string },
  until: number,
): Promise<boolean> {
  // THE CURSOR IS (time, ids at that time), not the time alone: `_creationTime` is not
  // unique, and a strict `>` on it skipped a message sharing the time of the last one
  // pinned — left unstamped, then read as the new primary's. The range starts AT the
  // cursor's time; the ids already pinned there are skipped, and read on top of the
  // batch so a tie group of any size still makes progress.
  const after = chat.historyPin?.through ?? 0;
  const atAfter = new Set((chat.historyPin?.atThrough ?? []).map(String));
  let sawUser = chat.historyPin?.sawUser ?? false;
  if (until < after) return true;
  const read = await ctx.db
    .query("messages")
    .withIndex("by_chat", (q) =>
      q.eq("chatId", chat._id).gte("_creationTime", after).lte("_creationTime", until),
    )
    .take(PRIMARY_PIN_BATCH + atAfter.size);
  const rows = read.filter((m) => !(m._creationTime === after && atAfter.has(String(m._id))));
  for (const m of rows) {
    const unrouted =
      m.routedAgentId === undefined &&
      m.routedInstanceName === undefined &&
      m.importedAgentLabel === undefined;
    if (unrouted && (m.role === "user" || (m.role === "assistant" && !sawUser))) {
      await ctx.db.patch(m._id, {
        routedInstanceName: agent.instanceName,
        routedAgentId: agent.agentId,
      });
    }
    if (m.role === "user") sawUser = true;
  }
  const done = read.length < PRIMARY_PIN_BATCH + atAfter.size;
  const last = rows[rows.length - 1];
  if (last !== undefined) {
    const through = last._creationTime;
    const atThrough = rows.filter((m) => m._creationTime === through).map((m) => m._id);
    if (through === after) {
      for (const id of chat.historyPin?.atThrough ?? []) atThrough.push(id);
    }
    await ctx.db.patch(chat._id, { historyPin: { through, atThrough, sawUser } });
  }
  return done;
}

/** A long thread's pin, one batch per run, to whoever is primary WHEN it runs (see
 *  pinUnroutedBatch), up to the newest message; it reschedules itself until done. */
export const continuePinUnroutedHistory = internalMutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;
    const newest = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .first();
    const done =
      !chat.instanceName ||
      !chat.agentId ||
      newest === null ||
      (await pinUnroutedBatch(
        ctx,
        chat,
        { instanceName: chat.instanceName, agentId: chat.agentId },
        newest._creationTime,
      ));
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.chatAgents.continuePinUnroutedHistory, {
        chatId,
      });
    }
  },
});

/**
 * Make one of the room's agents the conversation's PRIMARY, at any point of it.
 *
 * THE PRIMARY is the chat's binding (`chats.instanceName/agentId`): the target of a
 * send that names no agent, the author of the rolling summary (chatSummaries resolves
 * the chat's binding, so it follows by construction), the target of the session
 * operations when no routed session exists. It is chosen HERE and only here — the
 * composer picks the next message's agent, never the conversation's.
 *
 * WHO. The owner, as for `rebindChatAgent`: the binding is the owner's conversation
 * identity on the gateway. The target must already be in the room (a `chatAgents`
 * row), and pass the same gates as adding it: the owner's grants, conversational, not
 * deleted on its gateway.
 *
 * WHAT MOVES WITH IT, and why:
 *  - The former primary becomes an added agent of the room (a `chatAgents` row, with
 *    the usual provenance); the new one leaves the roster — the primary is never a
 *    row. The count is unchanged, so the room's limit cannot be crossed.
 *  - The history is pinned to the former primary first (pinUnroutedBatch), so no
 *    past turn changes author. A thread too long for one transaction is pinned first
 *    in scheduled batches, to the primary it still has, and the change is refused
 *    ("preparing") until it is done: the primary never changes while any reader would
 *    still see a former turn as the new primary's.
 *  - The chat's non-routed session (`openclawChatId`) is the FORMER primary's gateway
 *    session: bindChatTarget drops it, and the chat switches to per-turn routing, so
 *    every later send is routed explicitly and — the new primary starting on a fresh
 *    segment — re-hydrated from the thread. The persisted routing tuple
 *    (`lastRouted*` + `routingSegment`) is KEPT: it names the session actually in
 *    use, whoever is primary, so a turn back to that agent still resumes it warm and
 *    a turn to the new primary is detected as a switch.
 *  - An EMPTY thread has no history to carry: the binding moves and nothing else —
 *    per-turn routing would only force rehydration on for a chat with nothing to
 *    rehydrate.
 *
 * NOT WHILE A TURN RUNS OR WAITS: its frames, its queued follow-ups and its session
 * all belong to the agent it was sent to (same rule as the panel's reset). NOT DURING
 * A CALL on another agent: the call is pinned to the agent it was minted for.
 */
export const setPrimaryAgent = mutation({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { chatId, instanceName, agentId }) => {
    const { userId, actor } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    if (chat.instanceName === instanceName && chat.agentId === agentId) {
      return { changed: false as const, reason: "already-primary" as const };
    }
    const member = await ctx.db
      .query("chatAgents")
      .withIndex("by_chat_instance_agent", (q) =>
        q.eq("chatId", chatId).eq("instanceName", instanceName).eq("agentId", agentId),
      )
      .first();
    if (member === null) {
      throw new Error("Invalid: agent is not part of this conversation");
    }
    // Not on a delegation a pending purge revoked (lib/agentPurge).
    await assertNoPendingPurge(ctx, instanceName, agentId);
    // The same gates as putting it in the room: every turn to it runs under the
    // owner's identity.
    await requireAgentMembership(ctx, userId, instanceName, agentId);
    const target = (await enrichUserAgents(ctx, userId)).find(
      (a) => a.instanceName === instanceName && a.agentId === agentId,
    );
    if (target?.state === "deleted") {
      throw new Error("Invalid: agent is deleted on its gateway");
    }
    const call = await liveTalkCall(ctx, chatId);
    if (call !== null && (call.instanceName !== instanceName || call.agentId !== agentId)) {
      throw new Error("TALK_CALL_ACTIVE");
    }
    // Busy also while a turn WAITS in the queue, not only while one runs (isChatBusy
    // ignores `queued` rows): a row sent with no agent named goes to whoever is
    // primary when it DRAINS, and its message is pinned below to the former one — it
    // would be answered by the new primary under the old one's name.
    if ((await isChatBusy(ctx, chatId)) || (await hasQueuedTurn(ctx, chatId))) {
      return { changed: false as const, reason: "busy" as const };
    }
    const former =
      chat.instanceName && chat.agentId
        ? { instanceName: chat.instanceName, agentId: chat.agentId }
        : null;
    // The NEWEST message bounds the pinning — read, not the clock: a row written
    // after this mutation is a turn routed after the change, never the former
    // primary's by default.
    const newest = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .first();
    const hasHistory = newest !== null;
    if (
      former !== null &&
      newest !== null &&
      !(await pinUnroutedBatch(ctx, chat, former, newest._creationTime))
    ) {
      // Too long for one transaction: what was stamped stays (the primary's own
      // turns, still its own), the rest follows in batches, and the change waits.
      // Asked again meanwhile, it pins from the cursor the same way: a second chain
      // of batches is redundant work, never a wrong stamp.
      await ctx.scheduler.runAfter(0, internal.chatAgents.continuePinUnroutedHistory, {
        chatId,
      });
      return { changed: false as const, reason: "preparing" as const };
    }
    // Moves the binding, drops the former primary's session id and access facts,
    // and removes the new primary's roster row (the primary is never a row).
    await ctx.runMutation(internal.bridge.bindChatTarget, { chatId, instanceName, agentId });
    if (former !== null) {
      await ctx.db.insert("chatAgents", {
        chatId,
        instanceName: former.instanceName,
        agentId: former.agentId,
        addedBy: userId,
        addedAt: Date.now(),
      });
    }
    await ctx.db.patch(chatId, {
      updatedAt: Date.now(),
      ...(hasHistory ? { perTurnRouting: true } : {}),
    });
    await auditImpersonated(ctx, actor, "chat.primary_set", {
      resource: "chat",
      resourceId: chatId,
    });
    return { changed: true as const };
  },
});
