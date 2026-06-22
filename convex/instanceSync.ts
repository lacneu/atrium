// On-demand instance sync — make the bridge pick up a just-saved credential and pull the
// gateway's state NOW, instead of waiting for the periodic crons (agents discovery is
// every 2 min). Two entry points:
//
//   - `pokeInstanceBridge` (internalAction): scheduled FIRE-AND-FORGET right after a
//     credential write (setInstanceSecret / generateDeviceIdentity). POSTs the bridge's
//     /refresh-credentials so it resolves the now-configured instance and connects to its
//     gateway — triggering the operator PAIRING request in seconds instead of at the next
//     self-heal poll. Best-effort: the credential write already succeeded; a down bridge
//     just means the self-heal loop catches up later.
//
//   - `forceInstanceSync` (admin action): the "Synchroniser maintenant" button. Pokes the
//     bridge AND pulls THAT instance's agents into Convex at once, so after approving the
//     pairing on the gateway the discovered agents land immediately (finishing the instance
//     configuration) rather than on the 2-min cron. SCOPED to the target instance.
//
// Both route to the bridge with the SAME scoped resolution as the pollers
// (resolveBridgeUrlForDispatch): an instance without its own `bridgeUrl` uses the env
// BRIDGE_URL only when it is the served/sole instance — never another instance's bridge.

import { action, internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { discoverInstanceAgents } from "./agents";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";

/** Resolve an instance's name + the bridge URL that actually serves it (scoped exactly
 *  like the pollers). null bridgeUrl => this bridge does not serve the instance (do not
 *  poke). NO auth gate — internal only: called by the scheduled poke (no user identity)
 *  and by forceInstanceSync (which gates admin separately). */
export const syncTargetInternal = internalQuery({
  args: { instanceId: v.id("instances") },
  handler: async (
    ctx,
    { instanceId },
  ): Promise<{ instanceName: string; bridgeUrl: string | null } | null> => {
    const inst = await ctx.db.get(instanceId);
    if (inst === null) return null;
    const all = await ctx.db.query("instances").collect();
    const bridgeUrl = resolveBridgeUrlForDispatch(
      { bridgeUrl: inst.bridgeUrl },
      {
        instanceName: inst.name,
        served: process.env.BRIDGE_INSTANCE_NAME ?? null,
        isSole: all.length === 1,
      },
    );
    return { instanceName: inst.name, bridgeUrl: bridgeUrl ?? null };
  },
});

/**
 * POST /refresh-credentials to the bridge URL that serves this instance (already scoped by
 * syncTargetInternal). The bridge resolves the instance + connects to its gateway,
 * triggering pairing. BEST-EFFORT: returns false (never throws) when there is no serving
 * bridge or it is unreachable — the caller's credential write must not depend on it.
 */
async function pokeBridge(
  instanceName: string,
  bridgeUrl: string | null,
): Promise<boolean> {
  const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
  if (!bridgeUrl || !sharedSecret) return false;
  try {
    const res = await fetch(
      `${bridgeUrl.replace(/\/$/, "")}/refresh-credentials?instance=${encodeURIComponent(
        instanceName,
      )}`,
      {
        method: "POST",
        // Bare shared secret (not Bearer) — same Convex->bridge contract as dispatch.
        headers: { Authorization: sharedSecret },
      },
    );
    return res.ok;
  } catch {
    // Bridge down/unreachable: the bridge's own self-heal poll picks the change up later.
    return false;
  }
}

/** Scheduled after a credential write: nudge the bridge to take it into account NOW. */
export const pokeInstanceBridge = internalAction({
  args: { instanceId: v.id("instances") },
  handler: async (ctx, { instanceId }): Promise<void> => {
    const target = await ctx.runQuery(internal.instanceSync.syncTargetInternal, {
      instanceId,
    });
    if (target !== null) await pokeBridge(target.instanceName, target.bridgeUrl);
  },
});

/**
 * Admin: force an immediate sync for ONE instance — poke its bridge (resolve + connect ->
 * pairing) AND pull THAT instance's agents into Convex now, so an admin completes setup
 * right after approving the pairing instead of waiting for the discovery cron. SCOPED to
 * the target: never polls or mutates other instances. Returns a 3-state `status` so the UI
 * reports honestly WITHOUT guessing the cause: `synced` (agents applied), `no_agents` (the
 * bridge answered but no agents came back — the device may not be paired yet, OR the
 * instance is misconfigured for this bridge; the UI tells the admin to check both), or
 * `unreachable` (no serving bridge / transport error).
 */
export const forceInstanceSync = action({
  args: { instanceId: v.id("instances") },
  handler: async (
    ctx,
    { instanceId },
  ): Promise<{
    status: "synced" | "no_agents" | "unreachable";
    agents: number;
  }> => {
    // Admin gate (reuse the agent-files admin check — an internal query, since an action
    // ctx cannot call requireAdmin directly).
    await ctx.runQuery(internal.agentFiles.checkAdminAccess, {});
    const target = await ctx.runQuery(internal.instanceSync.syncTargetInternal, {
      instanceId,
    });
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (target === null || target.bridgeUrl === null || !sharedSecret) {
      return { status: "unreachable", agents: 0 };
    }
    // Resolve + connect (-> pairing if not yet paired).
    const reached = await pokeBridge(target.instanceName, target.bridgeUrl);
    // Pull ONLY this instance's agents (scoped — same discovery the cron uses).
    const disc = await discoverInstanceAgents(
      ctx,
      target.instanceName,
      target.bridgeUrl.replace(/\/$/, ""),
      sharedSecret,
    );
    // `no_agents` deliberately does NOT guess WHY (not-paired vs misconfigured) — the bridge
    // answered but applied nothing; the UI message points the admin at both causes.
    const status = disc.synced
      ? "synced"
      : reached || disc.reached
        ? "no_agents"
        : "unreachable";
    return { status, agents: disc.agentCount };
  },
});
