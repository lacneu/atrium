// Server-side device-identity minting for the Credentials form's "Generate" button.
// Mints an Ed25519 operator device identity in the SAME shape + byte format as the CLI
// deploy/compose/generate-device-identity.mjs (proven to pair with the gateway), stores
// it ENCRYPTED (AAD-bound, exactly like setInstanceSecret), and returns ONLY the
// non-secret half (id + publicKey) so the admin can pair it on the gateway. The PRIVATE
// KEY never reaches the browser.
//
// RUNTIME: WebCrypto Ed25519 in the default Convex V8 runtime (verified supported there)
// — NO "use node" (self-hosted Convex runs only the V8 runtime; same convention as
// cipher.ts / apikeys.ts). Keygen is non-deterministic + async, so it MUST run in an
// ACTION (illegal in a query/mutation).

import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { loadLocalCrypto } from "./lib/crypto/keyProvider";
import { toBase64 } from "./lib/crypto/cipher";

/** The non-secret half an admin needs to PAIR the device on the gateway. */
export interface DeviceIdentityPublic {
  id: string;
  publicKey: string;
}

const HEX = "0123456789abcdef";
/** Uint8Array -> lowercase hex (the gateway expects the id as sha256 HEX). */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  }
  return out;
}

/** Uint8Array -> base64url (unpadded), the wire format the gateway expects for the
 *  public key (identical to node's JWK `x`). */
function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Wrap PKCS#8 DER in a PEM block. Ed25519 PKCS#8 is 48 bytes -> a single 64-char
 *  base64 line, matching node's `privateKey.export({type:"pkcs8",format:"pem"})` (incl.
 *  the trailing newline) so the value is byte-identical to the CLI. */
function toPkcs8Pem(der: Uint8Array): string {
  const lines = toBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Mint a fresh Ed25519 device identity. Async (WebCrypto). Mirrors the proven CLI
 * (deploy/compose/generate-device-identity.mjs) so the output pairs with the gateway:
 * publicKey = base64url(raw 32-byte key) unpadded, id = sha256 hex of those raw bytes,
 * privateKey = PKCS#8 PEM. Returns the FULL identity (incl. the private key) — callers
 * MUST encrypt it at rest and NEVER return the private half to a client. Exported for tests.
 */
export async function mintDeviceIdentity(): Promise<{
  id: string;
  publicKey: string;
  privateKey: string;
}> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPubBuf = await crypto.subtle.exportKey("raw", kp.publicKey);
  const pkcs8Buf = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const idDigest = await crypto.subtle.digest("SHA-256", rawPubBuf);
  return {
    id: toHex(new Uint8Array(idDigest)),
    publicKey: toBase64Url(new Uint8Array(rawPubBuf)),
    privateKey: toPkcs8Pem(new Uint8Array(pkcs8Buf)),
  };
}

/**
 * Admin: generate a device identity for an instance, store it ENCRYPTED, and return ONLY
 * the non-secret half (id + publicKey) for pairing. The private key never leaves the
 * server. Admin gating + audit happen inside storeInstanceSecret (same as
 * setInstanceSecret). Needs ATRIUM_SECRET_KEY (loadLocalCrypto throws clearly if unset).
 */
export const generateDeviceIdentity = action({
  args: { instanceId: v.id("instances") },
  handler: async (ctx, { instanceId }): Promise<DeviceIdentityPublic> => {
    const identity = await mintDeviceIdentity();
    const { encryptCipher } = loadLocalCrypto();
    const secret = await encryptCipher.encrypt(
      JSON.stringify(identity),
      `${instanceId}:deviceIdentity`,
    );
    await ctx.runMutation(internal.instanceSecrets.storeInstanceSecret, {
      instanceId,
      field: "deviceIdentity",
      secret,
    });
    return { id: identity.id, publicKey: identity.publicKey };
  },
});
