// Encrypted gateway CREDENTIALS — admin-only. Mirrors apiKeys.ts (D3): AES-GCM
// encryption is non-deterministic (random IV) + async, so it is ILLEGAL in a
// mutation. So `setInstanceSecret` is an ACTION: it encrypts in the V8 runtime
// (binding the ciphertext to its context via AAD `<instanceId>:<field>`), then
// ctx.runMutation into `storeInstanceSecret` (an internalMutation) which does
// requireAdmin + upsert + audit in ONE transaction. The plaintext NEVER reaches
// the db; the ciphertext is NEVER returned to the browser — only the bridge
// fetches the decrypted form server-side (a later step).

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { getActor, requireAdmin } from "./lib/access";
import { recordAudit } from "./lib/audit";
import { loadLocalCrypto } from "./lib/crypto/keyProvider";
import {
  encryptedSecretValidator,
  secretFieldValidator,
} from "./lib/crypto/convexValidator";

/**
 * Internal: persist an already-ENCRYPTED secret envelope for (instance, field).
 * Separated from the action so requireAdmin + upsert + audit run in ONE
 * transaction (the action holds no db). One row per (instanceId, field): patch if
 * it exists, else insert. Auth identity propagates through runMutation.
 */
export const storeInstanceSecret = internalMutation({
  args: {
    instanceId: v.id("instances"),
    field: secretFieldValidator,
    secret: encryptedSecretValidator,
  },
  handler: async (ctx, { instanceId, field, secret }) => {
    await requireAdmin(ctx);
    const inst = await ctx.db.get(instanceId);
    if (inst === null) throw new Error("Instance not found");
    const existing = await ctx.db
      .query("instanceSecrets")
      .withIndex("by_instance_field", (q) =>
        q.eq("instanceId", instanceId).eq("field", field),
      )
      .unique();
    if (existing === null) {
      await ctx.db.insert("instanceSecrets", {
        instanceId,
        field,
        secret,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.patch(existing._id, { secret, updatedAt: Date.now() });
    }
    const actor = await getActor(ctx);
    // Audit WHO + WHICH instance — never the field value (which is the secret's
    // ciphertext, already non-plaintext, but kept out of the log regardless).
    await recordAudit(ctx, actor, "instance.secret.set", {
      resource: "instance",
      resourceId: instanceId,
    });
  },
});

/**
 * Set (or rotate) a gateway credential for an instance. ACTION (D3: AES-GCM
 * encrypt is non-deterministic). Encrypts the plaintext bound to AAD
 * `<instanceId>:<field>` (so the ciphertext can't be relocated to another
 * instance/field), then persists via storeInstanceSecret. Returns only
 * `{ ok: true }` — NEVER the plaintext or the ciphertext. Requires
 * `ATRIUM_SECRET_KEY` in the Convex deployment env (throws a clear error if
 * unset). Admin gating + audit happen inside storeInstanceSecret.
 */
export const setInstanceSecret = action({
  args: {
    instanceId: v.id("instances"),
    field: secretFieldValidator,
    plaintext: v.string(),
  },
  handler: async (
    ctx,
    { instanceId, field, plaintext },
  ): Promise<{ ok: true }> => {
    if (plaintext.trim().length === 0) {
      throw new Error("Refused: empty secret");
    }
    const { encryptCipher } = loadLocalCrypto();
    const secret = await encryptCipher.encrypt(plaintext, `${instanceId}:${field}`);
    await ctx.runMutation(internal.instanceSecrets.storeInstanceSecret, {
      instanceId,
      field,
      secret,
    });
    return { ok: true };
  },
});

/** Remove a gateway credential (admin). Deterministic → a mutation. Idempotent. */
export const clearInstanceSecret = mutation({
  args: { instanceId: v.id("instances"), field: secretFieldValidator },
  handler: async (ctx, { instanceId, field }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("instanceSecrets")
      .withIndex("by_instance_field", (q) =>
        q.eq("instanceId", instanceId).eq("field", field),
      )
      .unique();
    if (existing === null) return; // idempotent
    await ctx.db.delete(existing._id);
    const actor = await getActor(ctx);
    await recordAudit(ctx, actor, "instance.secret.clear", {
      resource: "instance",
      resourceId: instanceId,
    });
  },
});

/**
 * INTERNAL: the ENCRYPTED envelopes for one instance (the step-3b credential fetch
 * reads these, then decrypts in the httpAction). Returns ciphertext only — the
 * decryption (which needs the master key) happens in the calling ACTION/httpAction,
 * NOT here (a query can't run async crypto). NEVER exposed to the browser; the only
 * caller is the per-bridge-authenticated credentials endpoint, scoped to the
 * RESOLVED instanceId (never a self-asserted name).
 */
export const getInstanceSecretEnvelopes = internalQuery({
  args: { instanceId: v.id("instances") },
  handler: async (ctx, { instanceId }) => {
    const rows = await ctx.db
      .query("instanceSecrets")
      .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
      .collect();
    return rows.map((r) => ({ field: r.field, secret: r.secret }));
  },
});

/**
 * Admin: which gateway credentials are SET (presence + updatedAt only — NEVER the
 * envelope/ciphertext). The Settings UI uses this to render "configured / not set"
 * per instance and field.
 */
export const listInstanceSecretStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("instanceSecrets").take(1000);
    return rows.map((r) => ({
      instanceId: r.instanceId,
      field: r.field,
      updatedAt: r.updatedAt,
    }));
  },
});
