// PER-BRIDGE authentication secret (bridge -> Convex). The isolation foundation for
// step 3b: each bridge gets its OWN secret whose SHA-256 hash is stored against ONE
// instance, so a presented secret RESOLVES to exactly that instance (by_hash). The
// instance identity is therefore PROVEN by possession of the secret, not self-
// asserted — which lets the credential-decrypt endpoint (3b) return ONLY the calling
// bridge's gateway secrets, restoring the "one bridge ⇒ one gateway" isolation that a
// single shared BRIDGE_INGEST_SECRET cannot give.
//
// Mirrors apiKeys.ts (D3): generate + hash are CSPRNG/async (ILLEGAL in a mutation),
// so mint is an ACTION that hashes then runMutation-persists; only the hash is
// stored; the plaintext is returned ONCE at mint and never again. One active secret
// per instance (rotate = replace).

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getActor, requireAdmin } from "./lib/access";
import { recordAudit } from "./lib/audit";
import { generateApiKey, hashKey } from "./lib/apikeys";

/**
 * Internal: persist a freshly-minted bridge secret (already hashed) for an instance,
 * REPLACING any existing one (rotation). requireAdmin + delete-old + insert + audit
 * in ONE transaction. Auth identity propagates through runMutation.
 */
export const storeBridgeSecret = internalMutation({
  args: {
    instanceId: v.id("instances"),
    hashedSecret: v.string(),
    prefix: v.string(),
    lastFour: v.string(),
  },
  handler: async (ctx, { instanceId, hashedSecret, prefix, lastFour }) => {
    await requireAdmin(ctx);
    const inst = await ctx.db.get(instanceId);
    if (inst === null) throw new Error("Instance not found");
    const actor = await getActor(ctx);
    // Rotation: one active secret per instance — drop the previous row(s) first.
    const existing = await ctx.db
      .query("bridgeAuth")
      .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    await ctx.db.insert("bridgeAuth", {
      instanceId,
      hashedSecret,
      prefix,
      lastFour,
      createdAt: Date.now(),
      createdBy: actor.realUserId,
    });
    await recordAudit(ctx, actor, "bridge.secret.mint", {
      resource: "instance",
      resourceId: instanceId,
    });
  },
});

/**
 * Mint (or rotate) the per-bridge secret for an instance. ACTION (CSPRNG + async
 * hash). Returns the plaintext EXACTLY ONCE — the operator sets it as the bridge's
 * env var; it is never recoverable afterwards (only the hash is stored). Admin gating
 * + audit happen inside storeBridgeSecret.
 */
export const mintBridgeSecret = action({
  args: { instanceId: v.id("instances") },
  handler: async (
    ctx,
    { instanceId },
  ): Promise<{ plaintext: string; prefix: string; lastFour: string }> => {
    const generated = generateApiKey();
    const hashedSecret = await hashKey(generated.plaintext);
    await ctx.runMutation(internal.bridgeAuth.storeBridgeSecret, {
      instanceId,
      hashedSecret,
      prefix: generated.prefix,
      lastFour: generated.lastFour,
    });
    return {
      plaintext: generated.plaintext,
      prefix: generated.prefix,
      lastFour: generated.lastFour,
    };
  },
});

/** Revoke an instance's bridge secret (admin). Idempotent. After this the bridge
 *  can no longer authenticate until a new secret is minted. */
export const revokeBridgeSecret = mutation({
  args: { instanceId: v.id("instances") },
  handler: async (ctx, { instanceId }) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("bridgeAuth")
      .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
      .collect();
    if (rows.length === 0) return; // idempotent
    for (const row of rows) await ctx.db.delete(row._id);
    const actor = await getActor(ctx);
    await recordAudit(ctx, actor, "bridge.secret.revoke", {
      resource: "instance",
      resourceId: instanceId,
    });
  },
});

/**
 * Admin: which instances have a bridge secret configured (presence + non-secret
 * prefix/lastFour + timestamps — NEVER the hash). The Settings UI renders
 * "configured / not set" + last-used from this.
 */
export const listBridgeAuthStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("bridgeAuth").take(1000);
    return rows.map((r) => ({
      instanceId: r.instanceId,
      prefix: r.prefix,
      lastFour: r.lastFour,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? null,
    }));
  },
});

/**
 * INTERNAL: resolve a presented bridge secret HASH to the instance it authenticates.
 * The verification primitive 3b's decrypt endpoint will use — the caller hashes the
 * presented secret (async crypto in the httpAction) and passes the hash here. Returns
 * the bound instance (id + name + its NON-SECRET gateway config) or null. NEVER exposes
 * the hash/secret. The gateway config (url/version/httpUrl/kind) rides along so the
 * bridge can self-configure its gateway connection from Convex (no env) — the secret
 * fields stay in `instanceSecrets`, fetched separately by the decrypt endpoint.
 */
export const resolveBridgeInstanceBySecretHash = internalQuery({
  args: { hash: v.string() },
  handler: async (
    ctx,
    { hash },
  ): Promise<{
    authId: Id<"bridgeAuth">;
    instanceId: Id<"instances">;
    instanceName: string;
    gatewayUrl: string;
    gatewayVersion: string | null;
    gatewayHttpUrl: string | null;
    kind: "openclaw" | "hermes";
  } | null> => {
    const row = await ctx.db
      .query("bridgeAuth")
      .withIndex("by_hash", (q) => q.eq("hashedSecret", hash))
      .unique();
    if (row === null) return null;
    const inst = await ctx.db.get(row.instanceId);
    if (inst === null) return null; // tolerate a dangling row (instance deleted)
    return {
      authId: row._id,
      instanceId: row.instanceId,
      instanceName: inst.name,
      gatewayUrl: inst.gatewayUrl,
      gatewayVersion: inst.gatewayVersion ?? null,
      gatewayHttpUrl: inst.gatewayHttpUrl ?? null,
      kind: inst.kind ?? "openclaw",
    };
  },
});

/** INTERNAL: record last-used on a successful bridge auth (best-effort heartbeat). */
export const touchBridgeLastUsed = internalMutation({
  args: { authId: v.id("bridgeAuth") },
  handler: async (ctx, { authId }) => {
    const row = await ctx.db.get(authId);
    if (row !== null) await ctx.db.patch(authId, { lastUsedAt: Date.now() });
  },
});
