// Key provisioning for the secret cipher — the ONLY env-coupled part. Keeps the
// master key out of cipher.ts so the crypto stays pure/unit-testable. Reads the
// local AES-256 master key from the Convex deployment env and builds the
// scheme-routed CipherRegistry.
//
// IRREDUCIBLE ENV FLOOR: the master key cannot itself live in the encrypted DB
// (chicken-and-egg) — it stays a Convex env var. When an external KMS is added
// later, the CMK lives in the KMS and this loader gains a ".register('aws-kms',…)"
// resolver; the local master key becomes optional. Set it with:
//   npx convex env set ATRIUM_SECRET_KEY "$(openssl rand -base64 32)"

import {
  CipherRegistry,
  CryptoError,
  LocalAesGcmCipher,
  fromBase64,
  type Cipher,
} from "./cipher";

/** Env var holding the base64 of a 32-byte (AES-256) master key. */
export const LOCAL_MASTER_KEY_ENV = "ATRIUM_SECRET_KEY";

/** Current local key version (bump + add a new env var to rotate). */
const LOCAL_KEY_VERSION = "v1";

/**
 * Read + validate the local master key from env. Fail-fast with a clear,
 * non-secret message (mirrors the bridge's loadConfig discipline). Pure-ish: env
 * is injected for tests.
 */
export function loadLocalMasterKey(
  env: Record<string, string | undefined> = process.env,
): Uint8Array {
  const raw = (env[LOCAL_MASTER_KEY_ENV] ?? "").trim();
  if (!raw) {
    throw new CryptoError(
      `Missing ${LOCAL_MASTER_KEY_ENV} (base64 of 32 random bytes; ` +
        `generate: openssl rand -base64 32)`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(raw);
  } catch {
    throw new CryptoError(`${LOCAL_MASTER_KEY_ENV} is not valid base64`);
  }
  if (bytes.length !== 32) {
    throw new CryptoError(
      `${LOCAL_MASTER_KEY_ENV} must decode to 32 bytes (AES-256), got ${bytes.length}`,
    );
  }
  return bytes;
}

/**
 * Build the local crypto: the cipher NEW secrets are encrypted with
 * (`encryptCipher`) and a registry that can DECRYPT any locally-keyed envelope
 * (current + future versions route by `keyRef`). The KMS hook is one
 * `.register("aws-kms", …)` away.
 */
export function loadLocalCrypto(
  env: Record<string, string | undefined> = process.env,
): { encryptCipher: Cipher; registry: CipherRegistry } {
  const masterKey = loadLocalMasterKey(env);
  const current = new LocalAesGcmCipher(masterKey, LOCAL_KEY_VERSION);
  const registry = new CipherRegistry().register("local", (keyRef) =>
    keyRef === current.keyRef ? current : undefined,
  );
  return { encryptCipher: current, registry };
}
