// NON-INTERACTIVE instance provisioning — the scripted counterpart of the admin
// "Ajouter une instance" form, for a control plane that orders a new gateway and
// has its installer bind it to Atrium with no admin at a browser.
//
// PARITY IS THE CONTRACT. A provisioned instance must arrive EXACTLY as a
// hand-created one: no agent, no grant, no permission. That parity is not asserted
// here, it is a property of the code this module deliberately does NOT touch —
// `applyDiscovery` stamps every agent it finds with `enabled: false`, and the
// availability resolver's output gate drops non-enabled agents from every pool.
// So a freshly provisioned instance is invisible to everyone, including users with
// no grant at all (who otherwise fall into the default-allow all-pool at
// agents.ts `effective = direct.length > 0 ? direct : allPoolKeys`), until an admin
// curates it by hand. Provisioning that ever wrote `enabled` or a grant row would
// silently widen every ungranted user to a new entity's gateway — the exact
// isolation this feature is sold on.
//
// IDEMPOTENCE IS THE OTHER CONTRACT: the caller is a control plane that retries on
// timeout, and the qualification criterion is a second pass with no persistent
// change. Two hazards make that non-trivial, and both are handled here rather than
// in the admin path they come from:
//   - `admin.upsertInstance` is NOT an upsert: with no `instanceId` it INSERTS
//     unconditionally, so a retried create yields TWO rows sharing `name` — the
//     immutable ROUTING KEY that `agents`, `userAgents`, `chats` and
//     `instanceDiscovery` all reference. We resolve by name and patch instead.
//   - `bridgeAuth.mintBridgeSecret` ROTATES: a replayed mint would issue a new
//     secret and lock out the bridge already installed with the old one. We mint
//     only when absent, and rotation must be asked for EXPLICITLY.

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { generateApiKey, hashKey } from "./lib/apikeys";
import { envLabel } from "./lib/envLabel";

/** What a provisioning call did to the instance row. */
export type ProvisionOutcome = "created" | "updated" | "unchanged";
/** What it did to the per-bridge secret. */
export type SecretOutcome = "minted" | "rotated" | "existing";

/**
 * The instance NAME is the routing key: `agents`, `userAgents`, `chats` and
 * `instanceDiscovery` all reference an instance by it, and it cannot be changed
 * afterwards (admin.upsertInstance rejects a rename outright). A scripted caller
 * gets no chance to fix a typo, so the charset is checked at CREATE time.
 *
 * Checked on create ONLY: an instance created before this rule exists must stay
 * updatable by the same script, and rejecting it here would strand it.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Managed fields, resolved to what should be stored. `null` CLEARS, `undefined`
 *  LEAVES ALONE — a partial payload must never silently wipe a value an admin set
 *  in the UI, and a control plane must still be able to unset one on purpose. */
type Managed = {
  gatewayUrl: string;
  displayName?: string | null;
  bridgeUrl?: string | null;
  gatewayVersion?: string | null;
  gatewayHttpUrl?: string | null;
  kind: "openclaw" | "hermes";
  transport?: "ws" | "rest" | null;
};

/** Trim, then treat "" as an explicit clear (the admin form's convention). */
function normalize(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Apply a `null`-clears / `undefined`-keeps field onto its current value. */
function resolveField<T>(
  incoming: T | null | undefined,
  current: T | undefined,
): T | undefined {
  if (incoming === undefined) return current;
  if (incoming === null) return undefined;
  return incoming;
}

/**
 * Register or update an instance by NAME, writing ONLY the managed fields and
 * ONLY when at least one of them actually changes. Never touches `config`,
 * `capabilities`, `streamTransport` or `defaultAgentId` — those belong to the
 * admin UI, and a provisioning replay must not roll them back.
 *
 * INTERNAL: identity is checked at the HTTP route against the API-key principal's
 * `instances.provision` permission. Mirrors instanceSync.runInstanceSync, which is
 * likewise unguarded here and gated there — a service principal has no user
 * identity for requireAdmin to check.
 */
export const applyProvision = internalMutation({
  args: {
    name: v.string(),
    gatewayUrl: v.string(),
    displayName: v.optional(v.union(v.string(), v.null())),
    bridgeUrl: v.optional(v.union(v.string(), v.null())),
    gatewayVersion: v.optional(v.union(v.string(), v.null())),
    gatewayHttpUrl: v.optional(v.union(v.string(), v.null())),
    kind: v.union(v.literal("openclaw"), v.literal("hermes")),
    transport: v.optional(
      v.union(v.literal("ws"), v.literal("rest"), v.null()),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ instanceId: Id<"instances">; outcome: ProvisionOutcome }> => {
    const name = args.name.trim();
    const gatewayUrl = normalize(args.gatewayUrl);
    if (gatewayUrl === null || gatewayUrl === undefined) {
      throw new Error("gatewayUrl_required");
    }

    // `by_name` is an INDEX, not a unique constraint (the sync route says as much
    // where it uses `.first()`). Take TWO: a pre-existing duplicate must be
    // refused loudly, not silently resolved to whichever row sorts first — that
    // would have the script configure one row while the bridge routes to another.
    const rows = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", name))
      .take(2);
    if (rows.length > 1) throw new Error("instance_name_ambiguous");
    const existing = rows[0];

    if (existing === undefined) {
      if (!NAME_PATTERN.test(name)) throw new Error("invalid_instance_name");
      const instanceId = await ctx.db.insert("instances", {
        name,
        gatewayUrl,
        displayName: resolveField(normalize(args.displayName), undefined),
        bridgeUrl: resolveField(normalize(args.bridgeUrl), undefined),
        gatewayVersion: resolveField(normalize(args.gatewayVersion), undefined),
        gatewayHttpUrl: resolveField(normalize(args.gatewayHttpUrl), undefined),
        kind: args.kind,
        transport: resolveField(args.transport, undefined),
      });
      return { instanceId, outcome: "created" };
    }

    const next: Managed = {
      gatewayUrl,
      displayName: resolveField(normalize(args.displayName), existing.displayName),
      bridgeUrl: resolveField(normalize(args.bridgeUrl), existing.bridgeUrl),
      gatewayVersion: resolveField(
        normalize(args.gatewayVersion),
        existing.gatewayVersion,
      ),
      gatewayHttpUrl: resolveField(
        normalize(args.gatewayHttpUrl),
        existing.gatewayHttpUrl,
      ),
      kind: args.kind,
      transport: resolveField(args.transport, existing.transport),
    };
    const unchanged =
      next.gatewayUrl === existing.gatewayUrl &&
      next.displayName === existing.displayName &&
      next.bridgeUrl === existing.bridgeUrl &&
      next.gatewayVersion === existing.gatewayVersion &&
      next.gatewayHttpUrl === existing.gatewayHttpUrl &&
      // An UNSET kind is legacy-equivalent to "openclaw" (schema convention), so
      // comparing raw would report a change on every replay of an openclaw
      // instance created before `kind` existed.
      next.kind === (existing.kind ?? "openclaw") &&
      next.transport === existing.transport;
    if (unchanged) return { instanceId: existing._id, outcome: "unchanged" };
    await ctx.db.patch(existing._id, {
      gatewayUrl: next.gatewayUrl,
      displayName: next.displayName ?? undefined,
      bridgeUrl: next.bridgeUrl ?? undefined,
      gatewayVersion: next.gatewayVersion ?? undefined,
      gatewayHttpUrl: next.gatewayHttpUrl ?? undefined,
      kind: next.kind,
      transport: next.transport ?? undefined,
    });
    return { instanceId: existing._id, outcome: "updated" };
  },
});

/** Does this instance already hold a bridge secret? Presence only — never the
 *  hash, which is the whole point of storing a hash. */
export const bridgeSecretPresent = internalQuery({
  args: { instanceId: v.id("instances") },
  handler: async (ctx, { instanceId }): Promise<boolean> => {
    const row = await ctx.db
      .query("bridgeAuth")
      .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
      .first();
    return row !== null;
  },
});

/**
 * Persist a minted bridge secret for a SERVICE principal (no signed-in operator).
 * The admin twin, bridgeAuth.storeBridgeSecret, calls requireAdmin + getActor and
 * writes an `auditLog` row — impossible here: `auditLog` requires two
 * `Id<"users">` and an API key has neither. Attribution for this path is the
 * `api.call` trace event the route writes, carrying the principal, the instance
 * and the secret outcome.
 */
export const storeProvisionedBridgeSecret = internalMutation({
  args: {
    instanceId: v.id("instances"),
    hashedSecret: v.string(),
    prefix: v.string(),
    lastFour: v.string(),
    principalId: v.string(),
  },
  handler: async (
    ctx,
    { instanceId, hashedSecret, prefix, lastFour, principalId },
  ) => {
    const inst = await ctx.db.get(instanceId);
    if (inst === null) throw new Error("instance_not_found");
    // One active secret per instance — same rotation semantics as the admin path.
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
      createdByPrincipal: principalId,
    });
  },
});

/**
 * Provision an instance and make sure it has a bridge secret. ACTION: minting is
 * CSPRNG + async hash, illegal in a mutation.
 *
 * The plaintext is returned EXACTLY ONCE, at the call that mints it. A replay
 * finds the secret present and returns `existing` with NO plaintext — which is
 * the correct answer for a retry, because the bridge already holds it.
 *
 * `rotateBridgeSecret` is the deliberate escape hatch for the one case a replay
 * cannot serve: the installer lost the plaintext before writing it to the host.
 * It is EXPLICIT because it BREAKS the running bridge — the plain replay a
 * qualification second pass performs must never reach it.
 */
export const provisionInstance = internalAction({
  args: {
    name: v.string(),
    gatewayUrl: v.string(),
    displayName: v.optional(v.union(v.string(), v.null())),
    bridgeUrl: v.optional(v.union(v.string(), v.null())),
    gatewayVersion: v.optional(v.union(v.string(), v.null())),
    gatewayHttpUrl: v.optional(v.union(v.string(), v.null())),
    kind: v.union(v.literal("openclaw"), v.literal("hermes")),
    transport: v.optional(
      v.union(v.literal("ws"), v.literal("rest"), v.null()),
    ),
    rotateBridgeSecret: v.optional(v.boolean()),
    /** API-key principal id, for attribution on a minted secret. */
    principalId: v.string(),
  },
  handler: async (
    ctx,
    { rotateBridgeSecret, principalId, ...instance },
  ): Promise<{
    instanceId: Id<"instances">;
    name: string;
    outcome: ProvisionOutcome;
    bridgeSecret: SecretOutcome;
    /** Present ONLY when this call minted or rotated. Never recoverable later. */
    plaintext?: string;
    prefix?: string;
    lastFour?: string;
  }> => {
    const { instanceId, outcome } = await ctx.runMutation(
      internal.instanceProvision.applyProvision,
      instance,
    );
    const present = await ctx.runQuery(
      internal.instanceProvision.bridgeSecretPresent,
      { instanceId },
    );
    if (present && rotateBridgeSecret !== true) {
      return {
        instanceId,
        name: instance.name.trim(),
        outcome,
        bridgeSecret: "existing",
      };
    }
    const generated = generateApiKey(envLabel());
    const hashedSecret = await hashKey(generated.plaintext);
    await ctx.runMutation(
      internal.instanceProvision.storeProvisionedBridgeSecret,
      {
        instanceId,
        hashedSecret,
        prefix: generated.prefix,
        lastFour: generated.lastFour,
        principalId,
      },
    );
    return {
      instanceId,
      name: instance.name.trim(),
      outcome,
      bridgeSecret: present ? "rotated" : "minted",
      plaintext: generated.plaintext,
      prefix: generated.prefix,
      lastFour: generated.lastFour,
    };
  },
});
