// Encrypted OTLP auth headers — admin-only. The generic OTLP exporter is the ONE
// integration whose secret is configured in the UI (the operator's choice) rather
// than the deployment env. Mirrors instanceSecrets.ts (D3): AES-GCM encryption is
// non-deterministic + async, so it is ILLEGAL in a mutation. `setOtlpHeaders` is
// an ACTION: it VALIDATES the header shape (so a malformed blob can't silently
// wedge the vendor on every flush), encrypts (AAD-bound so the ciphertext can't be
// relocated to another row/field), then ctx.runMutation into `storeOtlpHeaders`
// (requireAdmin + upsert + audit in ONE transaction). The plaintext NEVER reaches
// the db; the ciphertext is NEVER returned to the browser (status exposes only a
// `headersSet` boolean).

import { v } from "convex/values";
import { action, internalMutation, mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { getActor, requireAdmin } from "../lib/access";
import { recordAudit } from "../lib/audit";
import { loadLocalCrypto } from "../lib/crypto/keyProvider";
import { encryptedSecretValidator } from "../lib/crypto/convexValidator";
import type { EncryptedSecret } from "../lib/crypto/cipher";
import { parseOtlpHeaders } from "./otlpShared";

// AAD binds the headers ciphertext to its SINGLETON context (it can't be decrypted
// after being copied into an instanceSecret row or another field). Recomputed at
// decrypt from this same constant; NEVER stored in the envelope.
export const OTLP_HEADERS_AAD = "integration:otlp:headers";

/**
 * Internal: persist the already-ENCRYPTED headers envelope on the integrationConfig
 * singleton. Separated from the action so requireAdmin + upsert + audit run in ONE
 * transaction (the action holds no db). Auth identity propagates through runMutation.
 */
export const storeOtlpHeaders = internalMutation({
  args: { secret: encryptedSecretValidator },
  handler: async (ctx, { secret }) => {
    await requireAdmin(ctx);
    const row = await ctx.db
      .query("integrationConfig")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .unique();
    if (row === null) {
      await ctx.db.insert("integrationConfig", {
        key: "singleton",
        otlp: { headersSecret: secret },
      });
    } else {
      await ctx.db.patch(row._id, {
        otlp: { ...(row.otlp ?? {}), headersSecret: secret },
      });
    }
    const actor = await getActor(ctx);
    await recordAudit(ctx, actor, "integration.otlp.headers.set", {
      resource: "integration",
    });
  },
});

/**
 * Set (or rotate) the operator's OTLP auth headers. ACTION (D3: AES-GCM encrypt is
 * non-deterministic). VALIDATES the shape first (parseOtlpHeaders throws a clear,
 * secret-free error on malformed JSON / illegal header name / control char in a
 * value), encrypts the CANONICAL form bound to OTLP_HEADERS_AAD, then persists via
 * storeOtlpHeaders. Returns only `{ ok, count }` (the header COUNT, never a value).
 * Requires ATRIUM_SECRET_KEY in the deployment env. Admin gating + audit happen in
 * storeOtlpHeaders.
 */
export const setOtlpHeaders = action({
  args: { headersJson: v.string() },
  handler: async (
    ctx,
    { headersJson },
  ): Promise<{ ok: true; count: number }> => {
    const headers = parseOtlpHeaders(headersJson); // throws OtlpHeaderError if bad
    const canonical = JSON.stringify(headers);
    const { encryptCipher } = loadLocalCrypto();
    const secret = await encryptCipher.encrypt(canonical, OTLP_HEADERS_AAD);
    await ctx.runMutation(internal.integrations.otlpSecret.storeOtlpHeaders, {
      secret,
    });
    return { ok: true, count: Object.keys(headers).length };
  },
});

/**
 * Remove the stored OTLP auth headers (admin). Deterministic → a mutation.
 * Idempotent (no-op when none set). The endpoint/enabled knobs stay (they live in
 * setIntegrationConfig); this clears ONLY the secret.
 */
export const clearOtlpHeaders = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const row = await ctx.db
      .query("integrationConfig")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .unique();
    if (row === null || row.otlp?.headersSecret === undefined) return; // idempotent
    const { headersSecret: _drop, ...restOtlp } = row.otlp;
    await ctx.db.patch(row._id, { otlp: restOtlp });
    const actor = await getActor(ctx);
    await recordAudit(ctx, actor, "integration.otlp.headers.clear", {
      resource: "integration",
    });
  },
});

/**
 * Decrypt the stored headers envelope → `{ header: value }` (the flush action calls
 * this with the envelope it read via vendorOverrides). Returns `{}` when no headers
 * are set (auth-less collector). Throws on a decrypt/parse failure so the flush
 * records a vendor failure and does NOT advance the cursor. NEVER logs the value.
 */
export async function decryptOtlpHeaders(
  secret: EncryptedSecret | undefined,
): Promise<Record<string, string>> {
  if (secret === undefined) return {};
  const { registry } = loadLocalCrypto();
  const json = await registry.decrypt(secret, OTLP_HEADERS_AAD);
  return parseOtlpHeaders(json);
}
