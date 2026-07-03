// Routing resolver (multi-agent). Maps a CHAT to an OpenClaw target from the
// user's `userAgents` (M:N). The target returned is ALWAYS one the user is
// authorized for (∈ userAgents) — this is the dispatch-time authorization (IDOR
// defense). Legacy group/override routing has been REMOVED (single user, no
// migration); no userAgents => a clear "no_agent" failure, never a silent target.
//
// SECURITY: emits ONLY non-secret names — instanceName, agentId, canonical.
// Gateway tokens / device identities live in the bridge env, never here.

import { resolveAgentTypes } from "./lib/agentTypes";
import { Doc, Id } from "./_generated/dataModel";
import { QueryCtx, MutationCtx } from "./_generated/server";
import { getProfile } from "./lib/access";
import { getEffectiveGrants } from "./agents";

export interface ResolvedTarget {
  instanceName: string;
  agentId: string;
  canonical: string;
  source: "chat-binding" | "user-default";
}

export interface ChatResolution {
  target: ResolvedTarget | null;
  /** When set, persist this binding onto the chat (unbound chat resolved to the
   *  default, OR the bound agent was deleted on the gateway → re-bind). */
  rebind: { instanceName: string; agentId: string } | null;
  /** `no_agent`: the user has no usable agent at all. `agent_restricted`: the
   *  chat is bound to an agent the user is NO LONGER entitled to (admin narrowed
   *  their set) — the chat is READ-ONLY, never silently re-routed to a different
   *  agent (the user's explicit choice). */
  failReason: "no_agent" | "agent_restricted" | null;
}

/** Is this (instance, agent) DELETED on the gateway? `agents.presentInLastOk` is
 *  set false ONLY by a SUCCESSFUL poll that omitted the agent (applyDiscovery,
 *  guarded on a non-empty result); a failed or never-run poll NEVER touches it
 *  (recordDiscoveryFailure leaves rows + presence intact). So `presentInLastOk
 *  === false` is reliable last-good knowledge of deletion that a later discovery
 *  outage must NOT erase (Codex P2): a blip must not resurrect a known-deleted
 *  agent. An ABSENT row = never discovered (unknown) => NOT deleted (serve the
 *  binding; the gateway arbitrates) — assignment only ever grants discovered
 *  agents anyway, and a present agent during a blip keeps presentInLastOk===true
 *  (so it is served, the stale-blip case). */
async function readAgentRow(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
) {
  return await ctx.db
    .query("agents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
}

async function isDeleted(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<boolean> {
  const agent = await readAgentRow(ctx, instanceName, agentId);
  return agent !== null && agent.presentInLastOk === false;
}

/** A UTILITY-ONLY agent (e.g. type "summarizer"/"documentary" without
 *  "conversational") must never be routable for user chats: the admin granted it
 *  for a dedicated Atrium action, not for conversation. An UNKNOWN row keeps the
 *  legacy default (conversational). */
async function isNonConversational(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<boolean> {
  const agent = await readAgentRow(ctx, instanceName, agentId);
  return (
    agent !== null && !resolveAgentTypes(agent.types).includes("conversational")
  );
}

/** The user's OpenClaw canonical (profile slug, or the stable u-<id> fallback) —
 *  the identity segment session keys AND health targets are scoped by. ONE source
 *  for the fallback expression (was duplicated across the two resolvers). */
export async function canonicalForUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const profile = await getProfile(ctx, userId);
  return profile?.canonical ?? `u-${userId.slice(0, 10)}`;
}

export async function resolveTargetForChat(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  userId: Id<"users">,
): Promise<ChatResolution> {
  const canonical = await canonicalForUser(ctx, userId);

  // Candidate set = the EFFECTIVE union (direct userAgents ∪ group agents), the
  // dispatch-time authorization boundary (IDOR defense). With NO groups this is
  // the direct `by_user` rows in the same order with the same effective default,
  // so the resolution below is byte-identical to pre-P2; a group-only user can
  // now dispatch, and a group-bound chat is honored by the membership check.
  // Deletion is applied here via isDeleted() (NOT via the enriched `state`),
  // preserving the exact pre-P2 "absent row + successful poll => still served"
  // semantics that `state` cannot reconstruct.
  const uas = await getEffectiveGrants(ctx, userId);
  // The conversational-type requirement protects USER chats from routing to a
  // utility-only agent. HIDDEN utility chats (documentary/summarizer) are bound to
  // exactly such agents BY DESIGN — exempt them (codex P1: the filter would mark
  // every dedicated documentary/summarizer dispatch agent_restricted).
  const requireConversational = chat.kind === undefined;
  // NOTE: no early `uas.length === 0 -> no_agent` shortcut. A chat bound to a
  // PRESENT agent the user is no longer entitled to must classify as
  // agent_restricted (read-only) EVEN when the admin removed the user's last grant
  // (uas empty) -- so the dispatch reason matches the UI's read-only state. The
  // bound block below handles that; pickFallback returns null for an empty uas, so
  // an unbound/gone chat still ends in `no_agent`.

  const asTarget = (
    u: { instanceName: string; agentId: string },
    source: ResolvedTarget["source"],
  ): ResolvedTarget => ({
    instanceName: u.instanceName,
    agentId: u.agentId,
    canonical,
    source,
  });

  // Pick a PRESENT fallback agent (Codex P2 — never route to a deleted agent):
  // the default if it isn't deleted, else the first non-deleted assigned agent.
  // null when ALL assigned agents are deleted → fail no_agent (never dispatch to
  // an absent agent, which is the prod "Agent X no longer exists" bug).
  const pickFallback = async (): Promise<(typeof uas)[number] | null> => {
    const ordered = [...uas].sort((a, b) =>
      a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1,
    );
    for (const u of ordered) {
      if (await isDeleted(ctx, u.instanceName, u.agentId)) continue;
      if (
        requireConversational &&
        (await isNonConversational(ctx, u.instanceName, u.agentId))
      )
        continue;
      return u;
    }
    return null;
  };

  // Bound chat: honor the binding unless membership was revoked or the agent was
  // deleted on the gateway.
  if (chat.instanceName && chat.agentId) {
    const member = uas.find(
      (u) => u.instanceName === chat.instanceName && u.agentId === chat.agentId,
    );
    if (member) {
      if (!(await isDeleted(ctx, member.instanceName, member.agentId))) {
        if (
          requireConversational &&
          (await isNonConversational(ctx, member.instanceName, member.agentId))
        ) {
          // Present but retyped UTILITY-ONLY: read-only, never silently re-routed
          // (the agent_restricted semantics).
          return { target: null, rebind: null, failReason: "agent_restricted" };
        }
        return {
          target: asTarget(member, "chat-binding"),
          rebind: null,
          failReason: null,
        };
      }
      // In the effective set but DELETED on the gateway → fall through to a
      // present fallback (the agent is gone, not restricted).
    } else {
      // NOT in the user's effective set. RESTRICTION (the agent is still PRESENT --
      // an admin narrowed the user's access -> READ-ONLY, never silently re-routed)
      // vs GONE: a purge (removeInstanceAgent deleted the row) OR a gateway deletion
      // (the row survives with presentInLastOk:false until a manual purge). Both
      // "gone" cases fall through to the fallback/rebind like any deleted agent, so
      // the restriction applies ONLY when the agent is present.
      const boundInstance = chat.instanceName;
      const boundAgent = chat.agentId;
      const row = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) =>
          q.eq("instanceName", boundInstance).eq("agentId", boundAgent),
        )
        .first();
      if (row !== null && row.presentInLastOk !== false) {
        return { target: null, rebind: null, failReason: "agent_restricted" };
      }
      // Gone (purged or gateway-deleted) -> fall through to a present fallback.
    }
  }

  // HIDDEN utility chats (documentary/summarizer) never fall back: their binding
  // IS the content boundary (the prompt carries conversation excerpts targeted at
  // THAT agent on THAT instance). A deleted/purged bound agent fails the job —
  // re-routing to an arbitrary remaining grant would cross an agent/instance
  // boundary the engine guarantees it never crosses (codex P2). The dispatch-fail
  // path releases the job lock with backoff.
  if (chat.kind !== undefined) {
    return { target: null, rebind: null, failReason: "no_agent" };
  }
  const fb = await pickFallback();
  if (fb === null) {
    return { target: null, rebind: null, failReason: "no_agent" };
  }
  const alreadyBound =
    chat.instanceName === fb.instanceName && chat.agentId === fb.agentId;
  return {
    target: asTarget(fb, "user-default"),
    rebind: alreadyBound
      ? null
      : { instanceName: fb.instanceName, agentId: fb.agentId },
    failReason: null,
  };
}

/**
 * Per-TURN routing for the multi-agent router: the user picks the agent for THIS turn.
 * `chosen === null` → byte-identical legacy chat routing (`resolveTargetForChat`), so a
 * single-agent chat — including a chat bound to a now-revoked agent — keeps its exact
 * read-only / fallback semantics. When a turn-agent IS chosen, it is validated against the
 * user's EFFECTIVE grants (the same dispatch-time IDOR boundary): not entitled →
 * `agent_restricted` (per-OPTION — the chat itself is not bound/read-only); deleted on the
 * gateway → `no_agent`; else → the target with NEVER a rebind (a per-turn chat has no
 * single binding to persist). The client-supplied `chosen` is therefore authorized here at
 * the trust boundary, not merely filtered in the composer.
 */
export async function resolveTargetForTurn(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  userId: Id<"users">,
  chosen: { instanceName: string; agentId: string } | null,
): Promise<ChatResolution> {
  if (chosen === null) return resolveTargetForChat(ctx, chat, userId);

  const canonical = await canonicalForUser(ctx, userId);
  const uas = await getEffectiveGrants(ctx, userId);
  const member = uas.find(
    (u) => u.instanceName === chosen.instanceName && u.agentId === chosen.agentId,
  );
  if (!member) {
    // The user is NOT entitled to the picked agent (admin never granted / revoked it).
    // Per-option restriction — never silently re-routed to a different agent.
    return { target: null, rebind: null, failReason: "agent_restricted" };
  }
  if (await isDeleted(ctx, member.instanceName, member.agentId)) {
    // Entitled but gone on the gateway (the composer should have filtered it out).
    return { target: null, rebind: null, failReason: "no_agent" };
  }
  if (
    chat.kind === undefined &&
    (await isNonConversational(ctx, member.instanceName, member.agentId))
  ) {
    // A forged/stale pick of a utility-only agent — same per-option restriction.
    // (Hidden utility chats never route per-turn, but keep the exemption aligned.)
    return { target: null, rebind: null, failReason: "agent_restricted" };
  }
  return {
    target: {
      instanceName: member.instanceName,
      agentId: member.agentId,
      canonical,
      source: "user-default",
    },
    rebind: null,
    failReason: null,
  };
}
