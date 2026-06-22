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
): Promise<void> {
  const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
  if (!bridgeUrl || !sharedSecret) return;
  try {
    await fetch(
      `${bridgeUrl.replace(/\/$/, "")}/refresh-credentials?instance=${encodeURIComponent(
        instanceName,
      )}`,
      {
        method: "POST",
        // Bare shared secret (not Bearer) — same Convex->bridge contract as dispatch.
        headers: { Authorization: sharedSecret },
      },
    );
  } catch {
    // Bridge down/unreachable (network/DNS): the self-heal poll picks the change up later.
    // BEST-EFFORT — the result is never used to gate the sync; the authoritative check is
    // the /agents discovery below (a transient refresh failure must not block a served
    // instance from syncing its agents).
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
 * the target: never polls or mutates other instances. Returns a SPECIFIC `status` so the
 * UI can tell the admin exactly what to fix instead of a generic "sync failed":
 *   - `synced`          — agents applied.
 *   - `no_agents`       — bridge serves the instance but returned no agents (the device is
 *                         likely not paired yet — approve it on the gateway, then re-sync).
 *   - `no_bridge_url`   — no bridge serves this instance (set its Bridge URL).
 *   - `deploy_misconfigured` — BRIDGE_SHARED_SECRET missing on the Convex deployment.
 *   - `unreachable`     — the bridge did not respond (down / wrong URL).
 *   - `unauthorized`    — the bridge rejected auth (BRIDGE_SHARED_SECRET mismatch).
 *   - `not_served`      — bridge up but does not serve this instance (its per-bridge secret
 *                         is not in BRIDGE_INSTANCE_SECRETS, or its creds don't resolve).
 */
export const forceInstanceSync = action({
  args: { instanceId: v.id("instances") },
  handler: async (
    ctx,
    { instanceId },
  ): Promise<{
    status:
      | "synced"
      | "no_agents"
      | "no_bridge_url"
      | "deploy_misconfigured"
      | "unreachable"
      | "unauthorized"
      | "not_served";
    agents: number;
  }> => {
    // Admin gate (reuse the agent-files admin check — an internal query, since an action
    // ctx cannot call requireAdmin directly).
    await ctx.runQuery(internal.agentFiles.checkAdminAccess, {});
    const target = await ctx.runQuery(internal.instanceSync.syncTargetInternal, {
      instanceId,
    });
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!sharedSecret) {
      return { status: "deploy_misconfigured", agents: 0 };
    }
    // No bridge serves this instance: it has no own bridgeUrl and is not the env-served /
    // sole instance — the #1 setup miss (set the instance's Bridge URL).
    if (target === null || target.bridgeUrl === null) {
      return { status: "no_bridge_url", agents: 0 };
    }
    const base = target.bridgeUrl.replace(/\/$/, "");
    // BEST-EFFORT: resolve any pending creds + connect (-> pairing if not yet paired). Its
    // result is intentionally NOT used to classify — a transient refresh hiccup must not
    // block a SERVED instance from syncing. The /agents discovery below is authoritative.
    await pokeBridge(target.instanceName, target.bridgeUrl);
    // Pull ONLY this instance's agents (scoped; same discovery as the cron) — this is the
    // authoritative check: it confirms the bridge serves the instance AND reaches the gateway.
    const disc = await discoverInstanceAgents(ctx, target.instanceName, base, sharedSecret);
    if (disc.synced) return { status: "synced", agents: disc.agentCount };
    if (!disc.reached) return { status: "unreachable", agents: 0 };
    if (disc.httpStatus === 401) return { status: "unauthorized", agents: 0 };
    if (disc.httpStatus === 409) return { status: "not_served", agents: 0 };
    // Reached + served, but no agents applied — the device is not paired yet.
    return { status: "no_agents", agents: 0 };
  },
});
