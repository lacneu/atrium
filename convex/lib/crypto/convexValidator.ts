// Convex validators for the encrypted-secret envelope (lib/crypto/cipher.ts).
// Kept SEPARATE from cipher.ts so the pure crypto stays free of any Convex import
// (and unit-testable in plain Node). Schema + mutation args use these.

import { v } from "convex/values";

/**
 * The persisted shape of an `EncryptedSecret` (cipher.ts). Stored as base64
 * strings; `wrappedDataKey` is reserved for a future KMS envelope (absent for the
 * local cipher). The plaintext is NEVER stored — only this envelope.
 */
export const encryptedSecretValidator = v.object({
  v: v.number(),
  alg: v.string(),
  keyRef: v.string(),
  iv: v.string(),
  ciphertext: v.string(),
  wrappedDataKey: v.optional(v.string()),
});

/**
 * Which gateway credential a secret row holds. Provider-scoped by convention:
 * OpenClaw uses `token` + `deviceIdentity`; Hermes uses `apiKey`. (Field/kind
 * matching is left to the consumer — not enforced here.)
 */
export const secretFieldValidator = v.union(
  v.literal("token"),
  v.literal("deviceIdentity"),
  v.literal("apiKey"),
);
