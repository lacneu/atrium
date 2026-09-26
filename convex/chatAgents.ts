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

import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { enrichUserAgents, type EnrichedUserAgent } from "./agents";
import { requireAgentMembership } from "./chats";
import { requireActive } from "./lib/access";
import { auditImpersonated } from "./lib/audit";
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

/** The roster of agents, bounded. Oldest first. */
export async function chatAgentRows(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
): Promise<Doc<"chatAgents">[]> {
  return await ctx.db
    .query("chatAgents")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .take(MAX_CHAT_AGENTS);
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
  return row !== null;
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
    const rows = await chatAgentRows(ctx, chatId);
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
