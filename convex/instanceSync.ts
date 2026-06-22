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
import type { Id } from "./_generated/dataModel";
import { discoverInstanceAgents } from "./agents";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";

/** The outcome of a force-sync. The UI maps these to localized `m.*` toasts; the API/MCP
 *  (which has no i18n) gets the matching `SYNC_STATUS_DETAIL` English explanation. */
export type SyncStatus =
  | "synced"
  | "no_agents"
  | "no_bridge_url"
  | "deploy_misconfigured"
  | "unreachable"
  | "unauthorized"
  | "not_served";

/** Stable, server-side English detail per status — so an agent calling the API can ACT
 *  on the result without a message catalog (advisor: the MCP consumer has no i18n). */
export const SYNC_STATUS_DETAIL: Record<SyncStatus, string> = {
  synced: "Agents synced from the gateway.",
  no_agents:
    "The bridge serves this instance but returned no agents — pair the device on the gateway (or check the instance config), then sync again.",
  no_bridge_url:
    "No bridge serves this instance — set its Bridge URL (Settings -> Agents -> Instances).",
  deploy_misconfigured:
    "BRIDGE_SHARED_SECRET is missing on the Convex deployment.",
  unreachable:
    "The bridge did not respond — check it is running and its URL is correct.",
  unauthorized:
    "The bridge rejected authentication — BRIDGE_SHARED_SECRET is out of sync between Convex and the bridge.",
  not_served:
    "The bridge does not serve this instance — its secret must be in BRIDGE_INSTANCE_SECRETS and its credentials must be valid.",
};

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

/** Resolve an instance NAME -> its id (`.first()`: `instances.name` is not schema-unique).
 *  For the API/MCP route, which works with human-friendly names; null when unknown. */
export const instanceIdByName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<Id<"instances"> | null> => {
    const inst = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    return inst?._id ?? null;
  },
});

/**
 * Shared sync logic (NO auth) — force an immediate sync for ONE instance: poke its bridge
 * (resolve + connect -> pairing) AND pull THAT instance's agents into Convex now. SCOPED
 * to the target: never polls or mutates other instances. Called by BOTH the admin UI
 * action (forceInstanceSync) and the selfheal-gated API route, so they behave identically.
 * Returns a SPECIFIC `status` (see SyncStatus) so callers report the exact cause + fix.
 */
export const runInstanceSync = internalAction({
  args: { instanceId: v.id("instances") },
  handler: async (
    ctx,
    { instanceId },
  ): Promise<{ status: SyncStatus; agents: number }> => {
    const target = await ctx.runQuery(internal.instanceSync.syncTargetInternal, {
      instanceId,
    });
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!sharedSecret) return { status: "deploy_misconfigured", agents: 0 };
    // No bridge serves this instance: no own bridgeUrl and not the env-served / sole
    // instance — the #1 setup miss (set the instance's Bridge URL).
    if (target === null || target.bridgeUrl === null) {
      return { status: "no_bridge_url", agents: 0 };
    }
    const base = target.bridgeUrl.replace(/\/$/, "");
    // BEST-EFFORT: resolve any pending creds + connect (-> pairing if not yet paired). Its
    // result is intentionally NOT used to classify — a transient refresh hiccup must not
    // block a SERVED instance. The /agents discovery below is the authoritative check.
    await pokeBridge(target.instanceName, target.bridgeUrl);
    const disc = await discoverInstanceAgents(ctx, target.instanceName, base, sharedSecret);
    if (disc.synced) return { status: "synced", agents: disc.agentCount };
    if (!disc.reached) return { status: "unreachable", agents: 0 };
    if (disc.httpStatus === 401) return { status: "unauthorized", agents: 0 };
    if (disc.httpStatus === 409) return { status: "not_served", agents: 0 };
    // Reached + served, but no agents applied — the device is not paired yet.
    return { status: "no_agents", agents: 0 };
  },
});

/** Admin (UI "Synchroniser maintenant"): gate on the admin role, then run the shared sync. */
export const forceInstanceSync = action({
  args: { instanceId: v.id("instances") },
  handler: async (
    ctx,
    { instanceId },
  ): Promise<{ status: SyncStatus; agents: number }> => {
    // Admin gate (reuse the agent-files admin check — an internal query, since an action
    // ctx cannot call requireAdmin directly).
    await ctx.runQuery(internal.agentFiles.checkAdminAccess, {});
    return await ctx.runAction(internal.instanceSync.runInstanceSync, {
      instanceId,
    });
  },
});
