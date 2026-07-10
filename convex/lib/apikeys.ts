// API-key cryptographic helpers (pure, ctx-free).
//
// SECURITY (D3): plaintext keys are NEVER stored or logged — only the SHA-256
// hash. The plaintext is returned exactly once (at mint) to the caller and then
// discarded. Both functions use Web Crypto (`crypto.getRandomValues` +
// `crypto.subtle`), which is available in the default Convex V8 runtime AND in
// httpActions — so this file needs NO "use node" and can be imported by the
// mint action, the verification httpAction, and the (deterministic) unit test.
//
// RUNTIME NOTE (D3): generateApiKey() is non-deterministic (CSPRNG) and hashKey
// is async crypto — both are therefore ILLEGAL in queries/mutations. Minting
// MUST happen in an action; verification happens in the httpAction. This file
// stays pure so those callers compose it freely.

// Base62 alphabet for the random secret body (URL/Bearer safe, no separators).
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Plaintext layout: "oc_<label>_" + <BODY_LEN base62 chars>, where <label> is
// the deployment's ATRIUM_ENV_LABEL (e.g. oc_dev_…, oc_prod_…) — the same
// label the feedback report references carry, so a pasted key and a pasted
// reference identify their environment the same unambiguous way (the Convex
// deploy-key idea: `prod:deployment|secret`). Unlabeled deployments keep the
// legacy "oc_live_" namespace. 40 base62 chars is ~238 bits of entropy —
// comfortably beyond brute-force, and the full string is only ever compared by
// its hash, so the namespace is display/labeling only, never trust.
const LEGACY_NAMESPACE_LABEL = "live";
const BODY_LEN = 40;

export type GeneratedApiKey = {
  /** Full secret, shown to the caller exactly once. NEVER persist or log. */
  plaintext: string;
  /** Non-secret leading segment for display (namespace + first 4 body chars). */
  prefix: string;
  /** Non-secret trailing 4 chars for disambiguation in lists. */
  lastFour: string;
};

/**
 * Generate a fresh API key. Uses crypto.getRandomValues (CSPRNG) to fill a
 * base62 body without modulo bias by rejection-sampling bytes. Non-deterministic
 * => ACTION-ONLY (see file header / D3). `environmentLabel` (the deployment's
 * sanitized ATRIUM_ENV_LABEL, null when unset) becomes the key namespace.
 */
export function generateApiKey(
  environmentLabel?: string | null,
): GeneratedApiKey {
  const namespace = `oc_${environmentLabel ?? LEGACY_NAMESPACE_LABEL}_`;
  const body = randomBase62(BODY_LEN);
  const plaintext = `${namespace}${body}`;
  // Prefix is the namespace + first 4 body chars (non-secret display only).
  const prefix = `${namespace}${body.slice(0, 4)}`;
  const lastFour = body.slice(-4);
  return { plaintext, prefix, lastFour };
}

/**
 * SHA-256 hex digest of a plaintext key. The ONLY form ever stored / compared.
 * Async (crypto.subtle) => cannot run in a query/mutation; called from the mint
 * action and the verification httpAction.
 */
export async function hashKey(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

/** Rejection-sampled base62 string of length `n` (no modulo bias). */
function randomBase62(n: number): string {
  const out: string[] = [];
  // Pull bytes in batches; reject the top of the byte range that would bias
  // toward the first (256 mod 62) symbols. 62*4 = 248 is the largest multiple
  // of 62 <= 256, so bytes >= 248 are rejected.
  const limit = 248;
  while (out.length < n) {
    const buf = new Uint8Array(n - out.length);
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= limit) continue; // reject to avoid bias
      out.push(BASE62[byte % 62]!);
      if (out.length === n) break;
    }
  }
  return out.join("");
}

/** Lowercase hex encoding of a byte array. */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
