/**
 * WHICH KNOWLEDGE SOURCES AN AGENT SEARCHES — the `openclaw-knowledge` plugin (>= 4.0),
 * driven from Atrium (rules in lib/knowledge.ts):
 *
 *  - DISCOVERY: every agent discovery (the bridge's `/agents`, polled and on a manual
 *    sync) carries the plugin's `knowledge.sources` answer per agent — feature
 *    detection, the allowlist, the agent default — stored in `agentKnowledge`. The
 *    composer reads THAT, never the gateway: no call per keystroke.
 *  - THE CONVERSATION'S CHOICE (owner only, per agent — `chatKnowledgeChoices`): applied
 *    at once to the session the next turn uses when that agent is the current one
 *    (bridge `POST /knowledge` op "apply"), and put again by the bridge on every OpenClaw
 *    session the conversation opens with that agent, before its first turn
 *    (lastGateBeforeSend → /send `knowledgeChoice`).
 *  - THE AGENT DEFAULT (administrator): written through the gateway's validated
 *    `config.patch` by the bridge (op "default-set"); the confirmed read-back is stored.
 */

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import {
  requireActive,
  requireOwnedChat,
  requirePermission,
  requireReachableChat,
} from "./lib/access";
import { auditImpersonated } from "./lib/audit";
import { nameBoundWriteAllowed } from "./lib/instanceCascade";
import { PERMISSIONS } from "./lib/rbac";
import {
  MAX_KNOWLEDGE_CHOICES_PER_CHAT,
  MAX_KNOWLEDGE_SOURCES,
  dispatchKnowledgeChoice as decideKnowledgeDispatch,
  knowledgeChoiceRefusal,
  normalizeKnowledgeFacts,
  type KnowledgeChoice,
} from "./lib/knowledge";
import { capabilitiesForInstance } from "./lib/compat";
import { readDoc as readCompatDoc } from "./compat";
import { capabilityOf } from "../src/chat/capabilities";
import { roomProjection, isConversationAgent } from "./chatAgents";
import { postBridge } from "./agentFiles";
import { getEffectiveGrants } from "./agents";

const choiceValidator = v.union(
  v.object({ kind: v.literal("default") }),
  v.object({ kind: v.literal("off") }),
  v.object({
    kind: v.literal("sources"),
    sources: v.array(v.string()),
    injection: v.optional(v.union(v.literal("auto"), v.literal("hybrid"), v.literal("tool"))),
  }),
);

const injectionValidator = v.union(
  v.literal("auto"),
  v.literal("hybrid"),
  v.literal("tool"),
  v.literal("off"),
);

/** The admin default write: the POST's timeout, and the budget the bridge is given for
 *  the whole procedure under it (reads, the patch, a read-back after a lost answer). */
export const KNOWLEDGE_DEFAULT_POST_TIMEOUT_MS = 45_000;
export const KNOWLEDGE_DEFAULT_BRIDGE_BUDGET_MS = 38_000;

/** Same freshness rule as the other capability gates (bridge.ts): a snapshot is
 *  evidence for three poll intervals, from a reachable poll only. */
const COMPAT_MAX_AGE_MS = 15 * 60_000;

async function instanceByName(ctx: QueryCtx, name: string) {
  return await ctx.db
    .query("instances")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
}

async function factsFor(
  ctx: QueryCtx,
  instanceName: string,
  agentId: string,
): Promise<Doc<"agentKnowledge"> | null> {
  return await ctx.db
    .query("agentKnowledge")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
}

async function choiceRow(
  ctx: QueryCtx,
  chatId: Id<"chats">,
  instanceName: string,
  agentId: string,
): Promise<Doc<"chatKnowledgeChoices"> | null> {
  return await ctx.db
    .query("chatKnowledgeChoices")
    .withIndex("by_chat_agent", (q) =>
      q.eq("chatId", chatId).eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
}

/** Does a FRESH compat snapshot of this very instance POSITIVELY declare the knowledge
 *  control? (An older bridge ignores the /send field: the turn would run unapplied.) */
export async function knowledgeConfirmed(
  ctx: QueryCtx,
  instanceName: string,
  provider: string,
): Promise<boolean> {
  const doc = await readCompatDoc(ctx);
  const usable =
    doc !== null && doc.reachable === true && Date.now() - doc.fetchedAt < COMPAT_MAX_AGE_MS;
  const snap = usable ? capabilitiesForInstance(doc.targets, instanceName) : null;
  return (
    snap !== null && snap.provider === provider && capabilityOf(snap.capabilities, "knowledgePolicy")
  );
}

/** What a turn to (chat, instance, agent) carries — decided in the send's last-gate
 *  transaction (bridge.ts lastGateBeforeSend), never from an earlier read.
 *
 *  PRODUCT RULE (Olivier, same as the permission mode): a choice applies to turns
 *  dispatched AFTER it. A message that already passed this gate goes out under the
 *  choice in force when it was dispatched — the revision decided here — even if the
 *  owner records a newer choice while it is on its way; the NEXT message carries the new
 *  one. The bridge only ever refuses a turn whose OWN choice (or a newer one it was told
 *  about) is not on the session, never re-targets it. Pinned by knowledge.test.ts. */
export type TurnKnowledge =
  | { kind: "none" }
  | { kind: "refuse"; revision: number }
  | { kind: "send"; choice: KnowledgeChoice; revision: number };

export async function decideTurnKnowledge(
  ctx: QueryCtx,
  chat: Doc<"chats">,
  target: { instanceName: string; agentId: string },
): Promise<TurnKnowledge> {
  const row = await choiceRow(ctx, chat._id, target.instanceName, target.agentId);
  if (row === null) return { kind: "none" };
  const instance = await instanceByName(ctx, target.instanceName);
  const provider = instance?.kind ?? "openclaw";
  const decision = decideKnowledgeDispatch({
    stored: { choice: row.choice, revision: row.revision, overrideEver: row.overrideEver },
    provider,
    confirmed: provider === "openclaw" ? await knowledgeConfirmed(ctx, target.instanceName, provider) : false,
  });
  if (decision === null) return { kind: "none" };
  if ("refuse" in decision) return { kind: "refuse", revision: row.revision };
  return { kind: "send", choice: decision.send.choice, revision: decision.send.revision };
}

/** The agent a session operation on this chat reaches when nobody names one (the last
 *  routed agent on a per-turn chat, else the bound one) — getChatRouting's rule. */
function currentAgentRef(chat: Doc<"chats">): { instanceName: string; agentId: string } | null {
  const instanceName =
    chat.perTurnRouting === true
      ? (chat.lastRoutedInstanceName ?? chat.instanceName)
      : chat.instanceName;
  const agentId =
    chat.perTurnRouting === true ? (chat.lastRoutedAgentId ?? chat.agentId) : chat.agentId;
  return instanceName === undefined || agentId === undefined ? null : { instanceName, agentId };
}

/**
 * May THIS conversation reach this agent for its knowledge choice (codex pass 17)? One of
 * its own — the bound agent, a room agent, the last one a per-turn chat routed to — or
 * one its OWNER may address (the dispatch resolves every turn on the owner's grants).
 * ONE rule for the composer's read (knowledgeControl) and the owner's write
 * (setKnowledgeChoice): an agent outside it is neither shown nor chosen for.
 */
export async function knowledgeAgentReachable(
  ctx: QueryCtx,
  chat: Doc<"chats">,
  ref: { instanceName: string; agentId: string },
): Promise<boolean> {
  if (await isConversationAgent(ctx, chat, ref)) return true;
  if (chat.lastRoutedInstanceName === ref.instanceName && chat.lastRoutedAgentId === ref.agentId) {
    return true;
  }
  return (await getEffectiveGrants(ctx, chat.userId)).some(
    (g) => g.instanceName === ref.instanceName && g.agentId === ref.agentId,
  );
}

/**
 * What the composer's "Connaissances" section shows — to EVERY reader of the
 * conversation (participants see the choice, they do not change it), for the agent the
 * next message goes to. Everything the view decides from is here; the decisions live in
 * src/chat/knowledgeView.ts.
 */
export const knowledgeControl = query({
  args: {
    chatId: v.id("chats"),
    routedAgent: v.optional(v.object({ instanceName: v.string(), agentId: v.string() })),
  },
  handler: async (ctx, { chatId, routedAgent }) => {
    const { userId } = await requireActive(ctx);
    const access = await requireReachableChat(ctx, userId, chatId);
    const room = await roomProjection(ctx, access, routedAgent ?? null);
    const ref = room.routedAgent ?? currentAgentRef(access.chat);
    if (ref === null) return null;
    // Never another agent's sources: an arbitrary `routedAgent` outside the rule gets
    // nothing (codex pass 17).
    if (!(await knowledgeAgentReachable(ctx, access.chat, ref))) return null;
    const instance = await instanceByName(ctx, ref.instanceName);
    const provider = instance?.kind ?? "openclaw";
    const facts = await factsFor(ctx, ref.instanceName, ref.agentId);
    const row = await choiceRow(ctx, chatId, ref.instanceName, ref.agentId);
    return {
      target: ref,
      provider,
      viewerRole: access.role,
      // The bridge serving this instance can put a choice on a session.
      supported:
        provider === "openclaw" && (await knowledgeConfirmed(ctx, ref.instanceName, provider)),
      facts:
        facts === null
          ? null
          : {
              available: facts.available,
              reason: facts.reason ?? null,
              injection: facts.injection ?? null,
              defaultSources: facts.defaultSources ?? [],
              overridesAllowed: facts.overridesAllowed === true,
              sources: facts.sources ?? [],
              fetchedAt: facts.fetchedAt,
            },
      choice: row?.choice ?? null,
      apply: row?.apply ?? null,
      revision: row?.revision ?? null,
    };
  },
});

/**
 * Choose which knowledge sources THIS agent searches in THIS conversation. OWNER only;
 * it applies to the turns dispatched from now on (see decideTurnKnowledge's product
 * rule — a message already past its last gate keeps the choice it was dispatched with);
 * only among the sources the plugin lists for the agent; `default` removes the choice's
 * effect (the agent's default applies again) and is always allowed.
 */
export const setKnowledgeChoice = mutation({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
    choice: choiceValidator,
  },
  handler: async (ctx, { chatId, instanceName, agentId, choice }) => {
    const { userId, actor } = await requireActive(ctx);
    // Throws for anyone but the owner — participants SEE the choice, never set it.
    const chat = await requireOwnedChat(ctx, userId, chatId);
    // An agent this conversation can route to: one of its own (bound, in the room) or one
    // the owner may address (the dispatch resolves every turn on the OWNER's grants).
    const ref = { instanceName, agentId };
    if (!(await knowledgeAgentReachable(ctx, chat, ref))) {
      throw new Error("Forbidden: agent_not_in_conversation");
    }
    const instance = await instanceByName(ctx, instanceName);
    const facts = await factsFor(ctx, instanceName, agentId);
    const normalized: KnowledgeChoice =
      choice.kind === "sources"
        ? {
            kind: "sources",
            sources: [...new Set(choice.sources)],
            ...(choice.injection === undefined ? {} : { injection: choice.injection }),
          }
        : choice;
    const refusal = knowledgeChoiceRefusal({
      isOwner: true,
      provider: instance?.kind ?? "openclaw",
      facts:
        facts === null
          ? null
          : {
              available: facts.available,
              overridesAllowed: facts.overridesAllowed,
              sources: facts.sources ?? [],
            },
      choice: normalized,
    });
    if (refusal !== null) throw new Error(`Forbidden: ${refusal}`);
    const existing = await choiceRow(ctx, chatId, instanceName, agentId);
    if (existing === null) {
      const held = await ctx.db
        .query("chatKnowledgeChoices")
        .withIndex("by_chat_agent", (q) => q.eq("chatId", chatId))
        .take(MAX_KNOWLEDGE_CHOICES_PER_CHAT);
      // A conversation's choices are bounded, so a fork carries every one of them.
      if (held.length >= MAX_KNOWLEDGE_CHOICES_PER_CHAT) {
        throw new Error("Forbidden: too_many_choices");
      }
    }
    const revision = (existing?.revision ?? 0) + 1;
    const now = Date.now();
    // Sticky until a reset is CONFIRMED on a session (recordKnowledgeApply/Turn): a new
    // row stating `default` has never put an override anywhere; a legacy row without the
    // flag keeps it unknown (= may be there).
    const overrideEver =
      normalized.kind !== "default" ||
      (existing === null ? false : existing.overrideEver !== false);
    const doc = {
      choice: normalized,
      revision,
      overrideEver,
      setBy: userId,
      setAt: now,
      apply: { revision, status: "pending" as const, at: now },
    };
    if (existing === null) {
      await ctx.db.insert("chatKnowledgeChoices", { chatId, instanceName, agentId, ...doc });
    } else {
      await ctx.db.patch(existing._id, doc);
    }
    await ctx.scheduler.runAfter(0, internal.knowledge.dispatchKnowledgeChoice, {
      chatId,
      userId,
      instanceName,
      agentId,
      revision,
    });
    await auditImpersonated(ctx, actor, "chat.knowledge_choice", {
      resource: "chat",
      resourceId: chatId,
    });
  },
});

/** Record an outcome — only for the revision it was made for. */
export const recordKnowledgeApply = internalMutation({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
    revision: v.number(),
    status: v.union(
      v.literal("applied"),
      v.literal("deferred"),
      v.literal("failed"),
      // Applied minus the ids the agent's allowlist no longer holds (codex pass 19).
      v.literal("clamped"),
    ),
    reason: v.optional(v.string()),
    effectiveSources: v.optional(v.array(v.string())),
    // Applied for sending, but the old override is STILL STORED (codex pass 16).
    inert: v.optional(v.boolean()),
    dropped: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const row = await choiceRow(ctx, args.chatId, args.instanceName, args.agentId);
    // STALE: a newer choice was made meanwhile; its own apply (and, whatever happens,
    // the next turn's enforcement against the described session) settles the session.
    if (row === null || row.revision !== args.revision) return;
    await ctx.db.patch(row._id, {
      // A `default` confirmed on the session: no override of Atrium's is left there. An
      // INERT one (the reset refused, overrides disabled) leaves it stored: kept.
      ...(args.status === "applied" && args.inert !== true && row.choice.kind === "default"
        ? { overrideEver: false }
        : {}),
      apply: {
        revision: args.revision,
        status: args.status,
        ...(args.reason === undefined ? {} : { reason: args.reason }),
        ...(args.status === "clamped" && args.dropped !== undefined ? { dropped: args.dropped } : {}),
        ...(args.effectiveSources === undefined ? {} : { effectiveSources: args.effectiveSources }),
        at: Date.now(),
      },
    });
  },
});

/** The routing a dispatch needs, and whether `revision` is still the current choice —
 *  one read. */
export const claimKnowledgeApply = internalQuery({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
    revision: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ current: boolean; choice: KnowledgeChoice | null; confirmed: boolean }> => {
    const row = await choiceRow(ctx, args.chatId, args.instanceName, args.agentId);
    if (row === null || row.revision !== args.revision) {
      return { current: false, choice: null, confirmed: false };
    }
    const instance = await instanceByName(ctx, args.instanceName);
    const provider = instance?.kind ?? "openclaw";
    return {
      current: true,
      choice: row.choice,
      confirmed: provider === "openclaw" && (await knowledgeConfirmed(ctx, args.instanceName, provider)),
    };
  },
});

/** Read an outcome from the bridge's `/knowledge` apply answer. Exported for tests. */
export async function readKnowledgeApplyResponse(response: Response): Promise<{
  status: "applied" | "deferred" | "failed" | "clamped";
  reason?: string;
  effectiveSources?: string[];
  inert?: true;
  dropped?: string[];
}> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const b = (body ?? {}) as {
    ok?: unknown;
    result?: unknown;
    snapshot?: { effectiveSources?: unknown };
    dropped?: unknown;
    error?: { code?: unknown; reason?: unknown };
  };
  if (response.ok && b.ok === true) {
    if (b.result === "deferred") return { status: "deferred" };
    if (b.result === "inert") return { status: "applied", inert: true };
    // Applied minus the revoked ids (codex pass 19): ids only, bounded — else nothing
    // to report, an ordinary apply.
    const dropped = Array.isArray(b.dropped)
      ? b.dropped
          .filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(x))
          .slice(0, MAX_KNOWLEDGE_SOURCES)
      : [];
    if (b.result === "clamped" && dropped.length > 0) return { status: "clamped", dropped };
    const eff = b.snapshot?.effectiveSources;
    return {
      status: "applied",
      ...(Array.isArray(eff) ? { effectiveSources: eff.filter((x): x is string => typeof x === "string").slice(0, 64) } : {}),
    };
  }
  const err = (typeof b.error === "object" && b.error !== null ? b.error : {}) as {
    code?: unknown;
    reason?: unknown;
  };
  const token = (x: unknown) => (typeof x === "string" && /^[a-z_]{1,48}$/.test(x) ? x : null);
  return { status: "failed", reason: token(err.reason) ?? token(err.code) ?? "bridge_error" };
}

/**
 * Apply the choice NOW to the session the next turn uses — when that session belongs to
 * this agent. Another agent's choice waits for that agent's next turn (a per-turn switch
 * opens a fresh session, which the send path brings to the choice before `chat.send`).
 * Never throws: every outcome is RECORDED for the composer.
 */
export const dispatchKnowledgeChoice = internalAction({
  args: {
    chatId: v.id("chats"),
    userId: v.id("users"),
    instanceName: v.string(),
    agentId: v.string(),
    revision: v.number(),
  },
  handler: async (ctx, { chatId, userId, instanceName, agentId, revision }) => {
    const record = async (
      status: "applied" | "deferred" | "failed" | "clamped",
      reason?: string,
      effectiveSources?: string[],
      inert?: true,
      dropped?: string[],
    ) => {
      await ctx.runMutation(internal.knowledge.recordKnowledgeApply, {
        chatId,
        instanceName,
        agentId,
        revision,
        status,
        ...(reason === undefined ? {} : { reason }),
        ...(effectiveSources === undefined ? {} : { effectiveSources }),
        ...(inert === undefined ? {} : { inert }),
        ...(dropped === undefined ? {} : { dropped }),
      });
    };
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!sharedSecret) {
      await record("failed", "not_configured");
      return;
    }
    const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
      chatId,
      userId,
      currentSession: true,
    });
    if (!routing || routing.target === null) {
      await record("failed", "no_agent");
      return;
    }
    if (routing.target.instanceName !== instanceName || routing.target.agentId !== agentId) {
      // Not this agent's session: the next turn TO this agent applies it first.
      await record("deferred", "next_turn");
      return;
    }
    if (!routing.bridgeUrl) {
      await record("failed", "not_configured");
      return;
    }
    const claim = await ctx.runQuery(internal.knowledge.claimKnowledgeApply, {
      chatId,
      instanceName,
      agentId,
      revision,
    });
    // Superseded by a newer choice: its own dispatch applies and reports.
    if (!claim.current || claim.choice === null) return;
    // The target's bridge is not CONFIRMED to take the choice (no fresh snapshot
    // declaring it): an older bridge would answer 404 — said as what it is.
    if (!claim.confirmed) {
      await record("failed", "unsupported_gateway");
      return;
    }
    let outcome: Awaited<ReturnType<typeof readKnowledgeApplyResponse>>;
    try {
      const response = await fetch(`${routing.bridgeUrl.replace(/\/$/, "")}/knowledge`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", Authorization: sharedSecret },
        body: JSON.stringify({
          op: "apply",
          chatId,
          openclawChatId: routing.openclawChatId,
          instanceName,
          agentId,
          canonical: routing.target.canonical,
          // Same person, same gateway name: the SAME per-conversation socket as /send.
          ...(routing.gatewayUser === undefined ? {} : { gatewayUser: routing.gatewayUser }),
          choice: claim.choice,
          revision,
        }),
      });
      outcome = await readKnowledgeApplyResponse(response);
    } catch (err) {
      console.error("bridge POST /knowledge failed:", err);
      outcome = { status: "failed", reason: "bridge_unreachable" };
    }
    await record(outcome.status, outcome.reason, outcome.effectiveSources, outcome.inert, outcome.dropped);
  },
});

/** A send's report of the choice it carried (the /send answer's `knowledge`). */
export const recordKnowledgeTurn = internalMutation({
  args: {
    chatId: v.id("chats"),
    instanceName: v.string(),
    agentId: v.string(),
    report: v.any(),
  },
  handler: async (ctx, { chatId, instanceName, agentId, report }) => {
    const r = (report ?? {}) as {
      status?: unknown;
      reason?: unknown;
      revision?: unknown;
      snapshot?: { effectiveSources?: unknown };
      dropped?: unknown;
    };
    if (typeof r.revision !== "number") return;
    const row = await choiceRow(ctx, chatId, instanceName, agentId);
    if (row === null || row.revision !== r.revision) return;
    // `clamped` (codex pass 15): the turn went under the choice, minus the sources the
    // operator took out of the allowlist since — ids only, bounded.
    const dropped = Array.isArray(r.dropped)
      ? r.dropped
          .filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(x))
          .slice(0, MAX_KNOWLEDGE_SOURCES)
      : [];
    const status =
      r.status === "failed"
        ? "failed"
        : r.status === "clamped" && dropped.length > 0
          ? "clamped"
          : r.status === "applied" || r.status === "unchanged" || r.status === "inert"
            ? "applied"
            : null;
    if (status === null) return;
    // `inert` (codex pass 16): sent under the default, the old override still stored.
    const inert = r.status === "inert";
    const reason =
      typeof r.reason === "string" && /^[a-z_]{1,48}$/.test(r.reason) ? r.reason : undefined;
    const eff = r.snapshot?.effectiveSources;
    await ctx.db.patch(row._id, {
      ...(status === "applied" && !inert && row.choice.kind === "default" ? { overrideEver: false } : {}),
      apply: {
        revision: row.revision,
        status,
        ...(status === "failed" ? { reason: reason ?? "rejected" } : {}),
        ...(status === "clamped" ? { dropped } : {}),
        ...(Array.isArray(eff)
          ? { effectiveSources: eff.filter((x): x is string => typeof x === "string").slice(0, 64) }
          : row.apply.effectiveSources !== undefined && status === "applied"
            ? { effectiveSources: row.apply.effectiveSources }
            : {}),
        at: Date.now(),
      },
    });
  },
});

// --- Discovery ---------------------------------------------------------------------

/** Store what the bridge's discovery read, per agent. An absent entry for an agent
 *  leaves its row as it was (an older bridge sends no `knowledge` at all). */
export async function applyKnowledgeDiscovery(
  ctx: MutationCtx,
  instanceName: string,
  entries: Record<string, unknown>,
): Promise<void> {
  if (!(await nameBoundWriteAllowed(ctx, instanceName))) return;
  const now = Date.now();
  for (const [agentId, raw] of Object.entries(entries).slice(0, 200)) {
    if (agentId.length === 0 || agentId.length > 128) continue;
    const facts = normalizeKnowledgeFacts(raw);
    if (facts === null) continue;
    const existing = await ctx.db
      .query("agentKnowledge")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", instanceName).eq("agentId", agentId),
      )
      .first();
    // Never an OLDER reading over a newer one (codex pass 4): both stamps are the same
    // bridge's clock (the instance's bridge sends discovery and the admin's read-back).
    // A reading WITHOUT a stamp cannot be ordered: it never overwrites a row that has one
    // (codex pass 20 — a late, unstamped copy of an old absence erased a state written
    // after the plugin came back). A row without a stamp still takes it, as before.
    if (
      existing !== null &&
      existing.observedAt !== undefined &&
      (facts.observedAt === undefined || facts.observedAt < existing.observedAt)
    ) {
      continue;
    }
    const doc = facts.available
      ? {
          available: true,
          reason: undefined,
          // No raw view this time: the baseline is dropped rather than kept stale (the
          // bridge then compares the written config with the effective view shown).
          config: facts.config,
          ownAllowlist: facts.ownAllowlist,
          contract: facts.contract,
          observedAt: facts.observedAt,
          configured: facts.configured,
          injection: facts.injection,
          defaultSources: facts.defaultSources,
          overridesAllowed: facts.overridesAllowed,
          sources: facts.sources,
          fetchedAt: now,
        }
      : facts.reason === "unreadable" && existing !== null && existing.available
        ? // One unreadable answer is not evidence the plugin left: last-good stands,
          // only its age moves on (the composer then shows it as stale).
          null
        : {
            available: false,
            reason: facts.reason,
            config: undefined,
            ownAllowlist: undefined,
            contract: undefined,
            observedAt: facts.observedAt,
            configured: undefined,
            injection: undefined,
            defaultSources: undefined,
            overridesAllowed: undefined,
            sources: undefined,
            fetchedAt: now,
          };
    if (doc === null) continue;
    if (existing === null) {
      await ctx.db.insert("agentKnowledge", { instanceName, agentId, ...doc });
    } else {
      await ctx.db.patch(existing._id, doc);
    }
  }
}

export const recordKnowledgeDiscovery = internalMutation({
  args: { instanceName: v.string(), entries: v.any() },
  handler: async (ctx, { instanceName, entries }) => {
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return;
    await applyKnowledgeDiscovery(ctx, instanceName, entries as Record<string, unknown>);
  },
});

// --- The agent default (administrators) ----------------------------------------------

/** Admin: what the Settings card needs about the instance itself. */
export const knowledgeAdminInstance = query({
  args: { instanceName: v.string() },
  handler: async (ctx, { instanceName }) => {
    await requirePermission(ctx, PERMISSIONS.ADMIN_MANAGE);
    const instance = await instanceByName(ctx, instanceName);
    return {
      provider: instance?.kind ?? "openclaw",
      supported:
        (instance?.kind ?? "openclaw") === "openclaw" &&
        (await knowledgeConfirmed(ctx, instanceName, "openclaw")),
    };
  },
});

/**
 * Admin: the agents of one instance that HAVE the plugin, a PAGE at a time (codex pass
 * 22 — a fixed `.take(200)` hid every agent past it, and its default could not be
 * edited). The card loads more on demand and says when more remain.
 */
export const agentKnowledgePage = query({
  args: { instanceName: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { instanceName, paginationOpts }) => {
    await requirePermission(ctx, PERMISSIONS.ADMIN_MANAGE);
    const result = await ctx.db
      .query("agentKnowledge")
      .withIndex("by_instance_and_available", (q) =>
        q.eq("instanceName", instanceName).eq("available", true),
      )
      .paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map((r) => ({
        agentId: r.agentId,
        available: r.available,
        reason: r.reason ?? null,
        configured: r.configured === true,
        injection: r.injection ?? null,
        defaultSources: r.defaultSources ?? [],
        overridesAllowed: r.overridesAllowed === true,
        sources: r.sources ?? [],
        fetchedAt: r.fetchedAt,
        config: r.config ?? null,
        contract: r.contract ?? 1,
        ownAllowlist: r.ownAllowlist ?? null,
        defaultWriteRefused: r.defaultWriteRefused ?? null,
      })),
    };
  },
});

export const checkKnowledgeAdmin = internalQuery({
  args: {},
  handler: async (ctx): Promise<null> => {
    await requirePermission(ctx, PERMISSIONS.ADMIN_MANAGE);
    return null;
  },
});

export const bridgeUrlFor = internalQuery({
  args: { instanceName: v.string() },
  handler: async (ctx, { instanceName }): Promise<{ bridgeUrl: string | null; kind: string } | null> => {
    const inst = await instanceByName(ctx, instanceName);
    if (inst === null) return null;
    return { bridgeUrl: inst.bridgeUrl?.trim() || null, kind: inst.kind ?? "openclaw" };
  },
});

/** Store the bridge's CONFIRMED read-back of an agent default (or a scope refusal). */
export const recordAgentDefault = internalMutation({
  args: {
    instanceName: v.string(),
    agentId: v.string(),
    knowledge: v.optional(v.any()),
    config: v.optional(v.any()),
    ownAllowlist: v.optional(v.boolean()),
    observedAt: v.optional(v.number()),
    writeRefused: v.optional(v.string()),
  },
  handler: async (ctx, { instanceName, agentId, knowledge, config, ownAllowlist, observedAt, writeRefused }) => {
    if (!(await nameBoundWriteAllowed(ctx, instanceName))) return;
    const existing = await ctx.db
      .query("agentKnowledge")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", instanceName).eq("agentId", agentId),
      )
      .first();
    if (knowledge !== undefined) {
      await applyKnowledgeDiscovery(ctx, instanceName, {
        [agentId]: {
          available: true,
          info: knowledge,
          ...(config === undefined ? {} : { config }),
          ...(ownAllowlist === undefined ? {} : { ownAllowlist }),
          ...(observedAt === undefined ? {} : { observedAt }),
        },
      });
      const after = await ctx.db
        .query("agentKnowledge")
        .withIndex("by_instance_agent", (q) =>
          q.eq("instanceName", instanceName).eq("agentId", agentId),
        )
        .first();
      if (after !== null) await ctx.db.patch(after._id, { defaultWriteRefused: undefined });
      return;
    }
    if (writeRefused !== undefined && existing !== null) {
      await ctx.db.patch(existing._id, { defaultWriteRefused: writeRefused });
    }
  },
});

/**
 * An administrator sets an agent's DEFAULT knowledge policy on its gateway: the injection
 * mode and the default sources, among those the plugin allows for the agent. `expected`
 * is the default the admin was shown: a default changed since (another operator, the CLI)
 * is refused rather than overwritten unseen. Returns the outcome for the card.
 */
export const setAgentKnowledgeDefault = action({
  args: {
    instanceName: v.string(),
    agentId: v.string(),
    injection: injectionValidator,
    sources: v.array(v.string()),
    expected: v.object({
      injection: v.string(),
      defaultSources: v.array(v.string()),
      // The raw config view the admin's card was built on (agentKnowledge.config).
      config: v.optional(
        v.object({
          injection: v.union(v.string(), v.null()),
          sources: v.union(v.array(v.string()), v.null()),
        }),
      ),
    }),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true } | { ok: false; code: string; reason?: string }> => {
    await ctx.runQuery(internal.knowledge.checkKnowledgeAdmin, {});
    const inst = await ctx.runQuery(internal.knowledge.bridgeUrlFor, {
      instanceName: args.instanceName,
    });
    if (inst === null) return { ok: false, code: "instance_not_found" };
    if (inst.kind !== "openclaw") return { ok: false, code: "knowledge_unavailable", reason: "unsupported_gateway" };
    if (args.sources.length === 0 || args.sources.length > 16) {
      return { ok: false, code: "invalid" };
    }
    let status: number;
    let data: unknown;
    try {
      ({ status, data } = await postBridge(
        "/knowledge",
        {
          op: "default-set",
          instanceName: args.instanceName,
          agentId: args.agentId,
          injection: args.injection,
          sources: args.sources,
          expected: args.expected,
          // The bridge's budget for the whole write — below this POST's own timeout, so
          // the admin always hears the bridge's verdict (applied, refused, or honestly
          // unknown) rather than "bridge unreachable" (codex pass 6).
          budgetMs: KNOWLEDGE_DEFAULT_BRIDGE_BUDGET_MS,
        },
        KNOWLEDGE_DEFAULT_POST_TIMEOUT_MS,
        inst.bridgeUrl,
      ));
    } catch {
      return { ok: false, code: "bridge_unreachable" };
    }
    const body = (data ?? {}) as {
      ok?: unknown;
      knowledge?: unknown;
      config?: unknown;
      ownAllowlist?: unknown;
      observedAt?: unknown;
      error?: { code?: unknown; reason?: unknown };
    };
    const stamp = {
      ...(typeof body.observedAt === "number" ? { observedAt: body.observedAt } : {}),
      // Rides with the raw view (codex pass 18).
      ...(typeof body.ownAllowlist === "boolean" ? { ownAllowlist: body.ownAllowlist } : {}),
    };
    if (status >= 200 && status < 300 && body.ok === true && body.knowledge !== undefined) {
      await ctx.runMutation(internal.knowledge.recordAgentDefault, {
        instanceName: args.instanceName,
        agentId: args.agentId,
        knowledge: body.knowledge,
        ...(body.config === undefined ? {} : { config: body.config }),
        ...stamp,
      });
      await ctx.runMutation(internal.agentFiles.auditFromAction, {
        action: "admin.knowledge_default",
        resource: "agent",
        resourceId: `${args.instanceName}/${args.agentId}`,
      });
      return { ok: true };
    }
    const token = (x: unknown) => (typeof x === "string" && /^[a-zA-Z_]{1,48}$/.test(x) ? x : null);
    const code = token(body.error?.code) ?? `http_${status}`;
    if (code === "scope_refused") {
      await ctx.runMutation(internal.knowledge.recordAgentDefault, {
        instanceName: args.instanceName,
        agentId: args.agentId,
        writeRefused: "scope_refused",
      });
    }
    // A default changed since the admin looked: store what it is now, so the card
    // shows it.
    if (code === "stale_default" && body.knowledge !== undefined) {
      await ctx.runMutation(internal.knowledge.recordAgentDefault, {
        instanceName: args.instanceName,
        agentId: args.agentId,
        knowledge: body.knowledge,
        ...(body.config === undefined ? {} : { config: body.config }),
        ...stamp,
      });
    }
    const reason = token(body.error?.reason);
    return { ok: false, code, ...(reason === null ? {} : { reason }) };
  },
});
