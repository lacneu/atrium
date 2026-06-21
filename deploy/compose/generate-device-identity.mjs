#!/usr/bin/env node
// Generate an Ed25519 operator DEVICE IDENTITY for an OpenClaw gateway.
//
// Each bridge authenticates to its gateway with an operator token PLUS a paired
// Ed25519 device. This mints the device half: a JSON object
//   { id, publicKey, privateKey }
// in the EXACT shape the bridge expects (`parseDeviceIdentity`, bridge/src/config.ts)
// and the gateway pairs against — byte-for-byte compatible with the reference
// OpenWebUI pipe's `generate_device_identity`:
//   - publicKey : base64url(raw 32-byte Ed25519 public key), no '=' padding
//   - id        : sha256 hex of those raw 32 public-key bytes
//   - privateKey: PKCS#8 PEM
//
// The single-line JSON it prints works for BOTH delivery modes:
//   - Env mode : paste it as OPENCLAW_DEVICE_IDENTITY=... (the PEM newlines are
//                already escaped as \n, which a dotenv line needs).
//   - UI  mode : paste the same string into Settings -> Agents -> Instances ->
//                (instance) -> Credentials (JSON.parse restores the PEM newlines).
//
// Generating the device is HALF of pairing: the gateway must still APPROVE this
// device's publicKey (operator pairing) or the bridge gets NOT_PAIRED. On a
// gateway you administer:  openclaw devices list  ->  openclaw devices approve <id>.
//
// Uses ONLY Node's built-in crypto — no dependencies, runs with a bare `node`.
//
// Usage (from deploy/compose):
//   node generate-device-identity.mjs                 # print env-ready JSON to stdout
//   node generate-device-identity.mjs olivier.device.json   # also write to a file
//   node generate-device-identity.mjs olivier.device.json --force   # overwrite

import { generateKeyPairSync, createHash } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const outFile = args.find((a) => !a.startsWith("--"));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

// Raw 32-byte public key: the JWK `x` is base64url(raw key) with no padding,
// which is exactly the wire format the gateway expects.
const jwk = publicKey.export({ format: "jwk" });
const publicKeyB64Url = jwk.x; // already base64url, unpadded
const rawPublicKey = Buffer.from(publicKeyB64Url, "base64url");

const identity = {
  id: createHash("sha256").update(rawPublicKey).digest("hex"),
  publicKey: publicKeyB64Url,
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
};

// JSON.stringify escapes the PEM's real newlines as \n -> env-ready single line.
const line = JSON.stringify(identity);

if (outFile) {
  if (existsSync(outFile) && !force) {
    console.error(
      `Refusing to overwrite ${outFile} (a paired device's private key is ` +
        `unrecoverable). Pass --force to overwrite.`,
    );
    process.exit(1);
  }
  writeFileSync(outFile, line + "\n", { mode: 0o600 });
  console.error(`Wrote device identity to ${outFile} (id ${identity.id})`);
} else {
  console.log(line);
}
