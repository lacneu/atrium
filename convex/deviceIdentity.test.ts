// The device-identity minting (the Credentials "Generate" button) MUST produce a key
// that pairs with the gateway. These tests cross-validate the WebCrypto output against
// node:crypto (the runtime the proven CLI deploy/compose/generate-device-identity.mjs
// uses) so a format regression fails loudly instead of shipping an unpairable device.

import { describe, it, expect } from "vitest";
import { createPrivateKey, createPublicKey, createHash } from "node:crypto";
import { mintDeviceIdentity } from "./deviceIdentity";

describe("mintDeviceIdentity (Ed25519, gateway-pairing format)", () => {
  it("is self-consistent: publicKey = 32 raw bytes, id = sha256 hex of those bytes", async () => {
    const idn = await mintDeviceIdentity();
    const rawPub = Buffer.from(idn.publicKey, "base64url");
    expect(rawPub.length).toBe(32);
    expect(createHash("sha256").update(rawPub).digest("hex")).toBe(idn.id);
  });

  it("privateKey is valid PKCS#8 whose DERIVED public key matches publicKey (it pairs)", async () => {
    // Decisive: node parses our PEM and derives the SAME public key -> the keypair is
    // internally consistent and the pubkey encoding equals node's JWK `x` (the CLI format).
    const idn = await mintDeviceIdentity();
    const priv = createPrivateKey(idn.privateKey); // throws if not valid PKCS#8
    expect(priv.asymmetricKeyType).toBe("ed25519");
    const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string };
    expect(jwk.x).toBe(idn.publicKey);
  });

  it("privateKey PEM is BYTE-identical to node's canonical PKCS#8 export (CLI format)", async () => {
    // Reconstruct node's PEM from the same key; equality proves our manual PEM wrapping
    // (header / single 64-char line / footer / trailing newline) matches the CLI exactly.
    const idn = await mintDeviceIdentity();
    const nodePem = createPrivateKey(idn.privateKey).export({
      type: "pkcs8",
      format: "pem",
    });
    expect(idn.privateKey).toBe(nodePem);
  });

  it("produces a fresh random key each call (not a fixed/empty key)", async () => {
    const a = await mintDeviceIdentity();
    const b = await mintDeviceIdentity();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.id).not.toBe(b.id);
  });
});
