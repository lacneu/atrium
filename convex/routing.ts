// Routing resolver (multi-agent). Maps a CHAT to an OpenClaw target from the
// user's `userAgents` (M:N). The target returned is ALWAYS one the user is
// authorized for (∈ userAgents) — this is the dispatch-time authorization (IDOR
// defense). Legacy group/override routing has been REMOVED (single user, no
// migration); no userAgents => a clear "no_agent" failure, never a silent target.
//
// SECURITY: emits ONLY non-secret names — instanceName, agentId, canonical.
// Gateway tokens / device identities live in the bridge env, never here.

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
  failReason: "no_agent" | null;
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
async function isDeleted(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<boolean> {
  const agent = await ctx.db
    .query("agents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
  return agent !== null && agent.presentInLastOk === false;
}

export async function resolveTargetForChat(
  ctx: QueryCtx | MutationCtx,
  chat: Doc<"chats">,
  userId: Id<"users">,
): Promise<ChatResolution> {
  const profile = await getProfile(ctx, userId);
  const canonical = profile?.canonical ?? `u-${userId.slice(0, 10)}`;

  // Candidate set = the EFFECTIVE union (direct userAgents ∪ group agents), the
  // dispatch-time authorization boundary (IDOR defense). With NO groups this is
  // the direct `by_user` rows in the same order with the same effective default,
  // so the resolution below is byte-identical to pre-P2; a group-only user can
  // now dispatch, and a group-bound chat is honored by the membership check.
  // Deletion is applied here via isDeleted() (NOT via the enriched `state`),
  // preserving the exact pre-P2 "absent row + successful poll => still served"
  // semantics that `state` cannot reconstruct.
  const uas = await getEffectiveGrants(ctx, userId);
  if (uas.length === 0) {
    return { target: null, rebind: null, failReason: "no_agent" };
  }

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
      if (!(await isDeleted(ctx, u.instanceName, u.agentId))) return u;
    }
    return null;
  };

  // Bound chat: honor the binding unless membership was revoked or the agent was
  // deleted on the gateway.
  if (chat.instanceName && chat.agentId) {
    const member = uas.find(
      (u) => u.instanceName === chat.instanceName && u.agentId === chat.agentId,
    );
    if (member && !(await isDeleted(ctx, member.instanceName, member.agentId))) {
      return {
        target: asTarget(member, "chat-binding"),
        rebind: null,
        failReason: null,
      };
    }
    // revoked or deleted → fall through to a present fallback.
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
