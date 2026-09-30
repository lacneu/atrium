// Group-manager CLAIM of a newly discovered agent, and the RESERVATION it creates.
//
// The use case: a user drives an agent that creates new agents on the gateway
// (the OpenClaw "forge"). A new agent arrives disabled (applyDiscovery stamps
// enabled:false). Its creator — as manager of their group — may make it usable by
// THAT group without an admin, and without offering it to anyone else. So a claim
// enables the agent AND reserves it: a reserved agent never joins the no-group
// all-pool, never becomes the instance default, and is offered only to the members
// of the groups it is assigned to (plus admin-made direct grants). Guests of a
// member's conversation still reach it through that member — a room turn runs on
// the owner's grants (send.ts) — by the room delegation, not by an offer to them.
//
// What is claimable is deliberately narrow — an agent nobody has made a decision
// about yet:
//   - discovered and present on the gateway;
//   - explicitly disabled (enabled === false, the discovery stamp) and never
//     decided on (no enablementDecidedAt — an admin toggle, either way, sets it);
//   - created after the claim epoch (a row that predates the marker has no history,
//     so its "disabled" may be an admin's decision — fail-closed);
//   - not reserved, and granted to nobody (no groupAgents / userAgents row).

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

const APP_META_KEY = "singleton";

/** Why an agent cannot be claimed, or null when it can. */
export type ClaimRefusal =
  | "unknown"
  | "not_discovered"
  | "absent"
  | "reserved"
  | "enabled"
  | "decided"
  | "no_epoch"
  | "predates_epoch"
  | "granted";

/** A reserved agent is withheld from the all-pool and from default election. */
export function isReserved(agent: Pick<Doc<"agents">, "reservedForGroupId">): boolean {
  return agent.reservedForGroupId !== undefined;
}

/** The claim epoch (appMeta.agentClaimEpoch), or null when not stamped yet. */
export async function agentClaimEpoch(
  ctx: QueryCtx | MutationCtx,
): Promise<number | null> {
  const meta = await ctx.db
    .query("appMeta")
    .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
    .unique();
  return meta?.agentClaimEpoch ?? null;
}

/** The row-local conditions (no reads): everything but the grant check. */
export function claimRefusalOfRow(
  agent: Doc<"agents"> | null,
  epoch: number | null,
): ClaimRefusal | null {
  if (agent === null) return "unknown";
  if (agent.source !== "discovered") return "not_discovered";
  if (agent.presentInLastOk !== true) return "absent";
  if (isReserved(agent)) return "reserved";
  if (agent.enabled !== false) return "enabled";
  if (agent.enablementDecidedAt !== undefined) return "decided";
  if (epoch === null) return "no_epoch";
  if (agent._creationTime <= epoch) return "predates_epoch";
  return null;
}

/** Full claimability: the row-local conditions, then "granted to nobody". */
export async function claimRefusal(
  ctx: QueryCtx | MutationCtx,
  agent: Doc<"agents"> | null,
  epoch: number | null,
): Promise<ClaimRefusal | null> {
  const local = claimRefusalOfRow(agent, epoch);
  if (local !== null || agent === null) return local;
  const shared = await ctx.db
    .query("groupAgents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", agent.instanceName).eq("agentId", agent.agentId),
    )
    .first();
  if (shared !== null) return "granted";
  const direct = await ctx.db
    .query("userAgents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", agent.instanceName).eq("agentId", agent.agentId),
    )
    .first();
  if (direct !== null) return "granted";
  return null;
}
