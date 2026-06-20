// Application-level secret encryption (pure, ctx-free) — the foundation for
// storing gateway credentials (token, device identity, auth mode) encrypted AT
// REST in Convex instead of in the bridge's env. Additive: this file wires into
// NOTHING yet; it is a standalone tool.
//
// SECURITY: plaintext secrets are encrypted with AES-256-GCM (authenticated:
// tampering with the ciphertext fails decryption). The master key never lives in
// this pure module — it is passed in (see keyProvider.ts, the only env-coupled
// part), so this file stays unit-testable with a known key.
//
// RUNTIME NOTE: encryption is NON-deterministic (random IV) and async
// (crypto.subtle), so — exactly like lib/apikeys.ts — it is ILLEGAL in a Convex
// query/mutation. When wired, encrypt/decrypt MUST run in an ACTION (or an
// httpAction for the bridge's fetch). Web Crypto is in the default Convex V8
// runtime, so this needs NO "use node".
//
// CRYPTO-AGILITY / KMS-READY: every ciphertext is a self-describing ENVELOPE
// carrying `keyRef` + `alg` + `v`. Decryption dispatches on `keyRef` via a
// `CipherRegistry` keyed by scheme ("local", later "aws-kms" / "vault"), so an
// external KMS slots in WITHOUT a schema or call-site change — a future
// KmsEnvelopeCipher registers under its scheme and populates `wrappedDataKey`.
// Only the local cipher is implemented here.

export class CryptoError extends Error {}

/**
 * A self-describing encrypted secret (the envelope persisted in place of the
 * plaintext). Base64 fields are Convex-storable strings.
 */
export interface EncryptedSecret {
  /** Envelope schema version (bump if this shape changes). */
  v: number;
  /** Data cipher that produced `ciphertext` (e.g. "AES-256-GCM"). */
  alg: string;
  /**
   * Which key custody encrypted this, `"<scheme>:<id>"`. Decryption routes on the
   * scheme: "local:v1" (the env master key, rotatable to v2…), later
   * "aws-kms:<arn>" / "vault:<path>". This is the crypto-agility hinge.
   */
  keyRef: string;
  /** Base64 of the random 12-byte GCM nonce (unique per encryption). */
  iv: string;
  /** Base64 of the GCM ciphertext (the 16-byte auth tag is appended by WebCrypto). */
  ciphertext: string;
  /**
   * KMS ENVELOPE ONLY (absent for "local"): base64 of the per-secret data key,
   * wrapped by the external KMS CMK. A KmsEnvelopeCipher unwraps this via the KMS,
   * then AES-GCM-decrypts `ciphertext` with it. Reserved here; not produced yet.
   */
  wrappedDataKey?: string;
}

/**
 * Encrypts/decrypts secret strings. `keyRef` tags the key NEW secrets get.
 *
 * `aad` (Additional Authenticated Data) BINDS a ciphertext to its CONTEXT — pass
 * e.g. `"<instanceId>:<field>"`. GCM authenticates integrity but NOT location, so
 * without AAD a stored ciphertext is portable (it would decrypt cleanly if copied
 * into a different row/field). The SAME `aad` must be supplied at decrypt; a
 * mismatch fails. AAD is RECOMPUTED from context at decrypt — it is NEVER stored
 * in the envelope. (Optional here; populate real context when this is wired.)
 */
export interface Cipher {
  /** Stable id of the key this cipher encrypts NEW secrets under (-> `keyRef`). */
  readonly keyRef: string;
  encrypt(plaintext: string, aad?: string): Promise<EncryptedSecret>;
  decrypt(secret: EncryptedSecret, aad?: string): Promise<string>;
}

const ALG = "AES-256-GCM";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

/**
 * Local AES-256-GCM cipher: the master key lives in the Convex deployment env
 * (NOT in the DB). `version` lets the master key rotate (decryption finds the
 * right key by `keyRef = "local:<version>"`).
 */
export class LocalAesGcmCipher implements Cipher {
  readonly keyRef: string;
  readonly #key: Promise<CryptoKey>;

  constructor(rawKey: Uint8Array, version = "v1") {
    if (rawKey.length !== KEY_BYTES) {
      throw new CryptoError(
        `local master key must be ${KEY_BYTES} bytes (AES-256), got ${rawKey.length}`,
      );
    }
    this.keyRef = `local:${version}`;
    // importKey is async but DETERMINISTIC (same bytes -> same key); cache it.
    this.#key = crypto.subtle.importKey("raw", toArrayBuffer(rawKey), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }

  async encrypt(plaintext: string, aad?: string): Promise<EncryptedSecret> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await this.#key;
    const data = new TextEncoder().encode(plaintext);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(gcmParams(iv, aad), key, toArrayBuffer(data)),
    );
    return {
      v: 1,
      alg: ALG,
      keyRef: this.keyRef,
      iv: toBase64(iv),
      ciphertext: toBase64(ct),
    };
  }

  async decrypt(secret: EncryptedSecret, aad?: string): Promise<string> {
    if (secret.alg !== ALG) {
      throw new CryptoError(`unsupported alg "${secret.alg}" (expected ${ALG})`);
    }
    const key = await this.#key;
    let pt: ArrayBuffer;
    try {
      pt = await crypto.subtle.decrypt(
        gcmParams(fromBase64(secret.iv), aad),
        key,
        toArrayBuffer(fromBase64(secret.ciphertext)),
      );
    } catch {
      // GCM auth-tag mismatch (tampered ciphertext/iv, wrong key, or AAD/context
      // mismatch) — never leak which; a clean failure is the security-correct
      // outcome.
      throw new CryptoError(
        "decryption failed (auth tag mismatch, wrong key, or AAD mismatch)",
      );
    }
    return new TextDecoder().decode(pt);
  }
}

/** Resolves a `keyRef` to the Cipher that can decrypt it (undefined if it can't). */
export type CipherResolver = (keyRef: string) => Cipher | undefined;

/**
 * Routes decryption by the `keyRef` SCHEME (the part before the first ":"). The
 * KMS-ready seam: register "local" now, ".register('aws-kms', …)" later — no
 * call site changes. `encryptCipher` is the cipher NEW secrets are written with.
 */
export class CipherRegistry {
  readonly #byScheme = new Map<string, CipherResolver>();

  register(scheme: string, resolver: CipherResolver): this {
    this.#byScheme.set(scheme, resolver);
    return this;
  }

  /** Find the cipher for a stored secret's `keyRef`, or throw a clear error. */
  resolve(keyRef: string): Cipher {
    const scheme = keyRef.split(":", 1)[0] ?? "";
    const cipher = this.#byScheme.get(scheme)?.(keyRef);
    if (!cipher) {
      throw new CryptoError(`no cipher registered for keyRef "${keyRef}"`);
    }
    return cipher;
  }

  decrypt(secret: EncryptedSecret, aad?: string): Promise<string> {
    return this.resolve(secret.keyRef).decrypt(secret, aad);
  }
}

/** AES-GCM params with optional context-binding AAD (recomputed, never stored). */
function gcmParams(iv: Uint8Array, aad?: string): AesGcmParams {
  const params: AesGcmParams = { name: "AES-GCM", iv: toArrayBuffer(iv) };
  if (aad !== undefined) {
    params.additionalData = toArrayBuffer(new TextEncoder().encode(aad));
  }
  return params;
}

/**
 * Copy a Uint8Array into a fresh, genuine `ArrayBuffer` (never SharedArrayBuffer).
 * WebCrypto's strict DOM types require an ArrayBuffer-backed BufferSource, which a
 * `Uint8Array<ArrayBufferLike>` (e.g. from TextEncoder / a view) does not satisfy.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

/** Uint8Array -> base64 (loop, not spread — safe for any size). */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** base64 -> Uint8Array. Throws (via atob) on invalid base64. */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export { toBase64, fromBase64 };
