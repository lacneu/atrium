/// <reference types="vite/client" />
//
// Pure unit tests for the secret cipher (ctx-free, like lib/apikeys). Web Crypto
// (AES-GCM) is available in the Node test runtime. Each test fails if its target
// regresses (round-trip, IV uniqueness, envelope shape, tamper/wrong-key
// rejection, scheme dispatch, key/env validation).

import { describe, expect, it } from "vitest";
import {
  CipherRegistry,
  CryptoError,
  LocalAesGcmCipher,
  fromBase64,
  toBase64,
  type EncryptedSecret,
} from "./cipher";
import {
  LOCAL_MASTER_KEY_ENV,
  loadLocalCrypto,
  loadLocalMasterKey,
} from "./keyProvider";

const KEY_A = new Uint8Array(32).fill(7);
const KEY_B = new Uint8Array(32).fill(9);
const b64Key = (k: Uint8Array) => toBase64(k);

describe("LocalAesGcmCipher round-trip", () => {
  it("encrypts then decrypts back to the exact plaintext (ascii, unicode, json, empty)", async () => {
    const c = new LocalAesGcmCipher(KEY_A);
    for (const pt of [
      "operator-token-abc123",
      "dëvïce-idéntïté—🔐",
      JSON.stringify({ id: "d", publicKey: "p", privateKey: "-----BEGIN…" }),
      "",
    ]) {
      const sealed = await c.encrypt(pt);
      expect(await c.decrypt(sealed)).toBe(pt);
    }
  });

  it("emits a well-formed envelope (keyRef/alg/v + base64 iv/ciphertext)", async () => {
    const c = new LocalAesGcmCipher(KEY_A);
    const s = await c.encrypt("x");
    expect(s.keyRef).toBe("local:v1");
    expect(s.alg).toBe("AES-256-GCM");
    expect(s.v).toBe(1);
    expect(s.wrappedDataKey).toBeUndefined(); // local never wraps a data key
    expect(fromBase64(s.iv).length).toBe(12); // GCM nonce
    expect(fromBase64(s.ciphertext).length).toBeGreaterThan(0);
  });

  it("uses a UNIQUE iv per call (no nonce reuse → ciphertext differs each time)", async () => {
    const c = new LocalAesGcmCipher(KEY_A);
    const a = await c.encrypt("same");
    const b = await c.encrypt("same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("honors the key version in keyRef", () => {
    expect(new LocalAesGcmCipher(KEY_A, "v2").keyRef).toBe("local:v2");
  });
});

describe("LocalAesGcmCipher rejects tampering / wrong key (authenticated)", () => {
  it("REJECTS a flipped ciphertext byte (GCM auth tag)", async () => {
    const c = new LocalAesGcmCipher(KEY_A);
    const s = await c.encrypt("secret");
    const bytes = fromBase64(s.ciphertext);
    bytes[0] ^= 0x01; // flip one bit
    const tampered: EncryptedSecret = { ...s, ciphertext: toBase64(bytes) };
    await expect(c.decrypt(tampered)).rejects.toBeInstanceOf(CryptoError);
  });

  it("REJECTS a flipped iv", async () => {
    const c = new LocalAesGcmCipher(KEY_A);
    const s = await c.encrypt("secret");
    const iv = fromBase64(s.iv);
    iv[0] ^= 0x01;
    await expect(c.decrypt({ ...s, iv: toBase64(iv) })).rejects.toBeInstanceOf(
      CryptoError,
    );
  });

  it("REJECTS decryption under a DIFFERENT master key (and does not return plaintext)", async () => {
    const sealed = await new LocalAesGcmCipher(KEY_A).encrypt("topsecret");
    const other = new LocalAesGcmCipher(KEY_B);
    await expect(other.decrypt(sealed)).rejects.toThrow(/auth tag mismatch/);
  });

  it("REJECTS an unsupported alg rather than silently mis-decrypting", async () => {
    const c = new LocalAesGcmCipher(KEY_A);
    const s = await c.encrypt("x");
    await expect(c.decrypt({ ...s, alg: "DES" })).rejects.toThrow(/unsupported alg/);
  });

  it("constructor REJECTS a non-256-bit key", () => {
    expect(() => new LocalAesGcmCipher(new Uint8Array(16))).toThrow(CryptoError);
  });
});

describe("AAD context-binding (prevents ciphertext relocation)", () => {
  it("round-trips when the SAME aad is supplied at encrypt + decrypt", async () => {
    const c = new LocalAesGcmCipher(KEY_A);
    const s = await c.encrypt("tok", "instanceA:token");
    expect(await c.decrypt(s, "instanceA:token")).toBe("tok");
  });

  it("REJECTS decryption under a DIFFERENT aad (a relocated ciphertext)", async () => {
    const c = new LocalAesGcmCipher(KEY_A);
    const s = await c.encrypt("tok", "instanceA:token");
    // Same key + ciphertext, but pretend it was moved to instance B / another field.
    await expect(c.decrypt(s, "instanceB:token")).rejects.toThrow(/AAD mismatch/);
    await expect(c.decrypt(s, "instanceA:deviceIdentity")).rejects.toThrow(
      /AAD mismatch/,
    );
  });

  it("REJECTS when aad is omitted at decrypt but was set at encrypt (and vice-versa)", async () => {
    const c = new LocalAesGcmCipher(KEY_A);
    const withAad = await c.encrypt("tok", "ctx");
    await expect(c.decrypt(withAad)).rejects.toBeInstanceOf(CryptoError);
    const noAad = await c.encrypt("tok");
    await expect(c.decrypt(noAad, "ctx")).rejects.toBeInstanceOf(CryptoError);
  });
});

describe("CipherRegistry scheme dispatch (KMS-ready)", () => {
  it("decrypts a locally-keyed envelope via the registered scheme", async () => {
    const { encryptCipher, registry } = loadLocalCrypto({
      [LOCAL_MASTER_KEY_ENV]: b64Key(KEY_A),
    });
    const s = await encryptCipher.encrypt("via-registry");
    expect(await registry.decrypt(s)).toBe("via-registry");
  });

  it("THROWS a clear error for an unregistered scheme (e.g. a future aws-kms ref)", () => {
    const reg = new CipherRegistry().register("local", () => undefined);
    expect(() => reg.resolve("aws-kms:arn:aws:kms:…")).toThrow(
      /no cipher registered for keyRef/,
    );
  });

  it("THROWS for a known scheme but unknown key version (rotation safety)", () => {
    const { registry } = loadLocalCrypto({ [LOCAL_MASTER_KEY_ENV]: b64Key(KEY_A) });
    // local:v1 is registered; a v2 envelope must NOT silently resolve to v1.
    expect(() => registry.resolve("local:v2")).toThrow(/no cipher registered/);
  });
});

describe("loadLocalMasterKey (env validation, fail-fast)", () => {
  it("loads a valid base64 32-byte key", () => {
    expect(loadLocalMasterKey({ [LOCAL_MASTER_KEY_ENV]: b64Key(KEY_A) })).toEqual(
      KEY_A,
    );
  });

  it("throws when the env var is missing/blank", () => {
    expect(() => loadLocalMasterKey({})).toThrow(/Missing ATRIUM_SECRET_KEY/);
    expect(() => loadLocalMasterKey({ [LOCAL_MASTER_KEY_ENV]: "   " })).toThrow(
      /Missing ATRIUM_SECRET_KEY/,
    );
  });

  it("throws on a wrong-length key (not 32 bytes)", () => {
    expect(() =>
      loadLocalMasterKey({ [LOCAL_MASTER_KEY_ENV]: toBase64(new Uint8Array(16)) }),
    ).toThrow(/32 bytes/);
  });
});
