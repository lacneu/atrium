#!/usr/bin/env node
// Generate the @convex-dev/auth signing key pair as TWO files next to .env:
//   - jwt_private_key.pem  → point JWT_PRIVATE_KEY_FILE at it
//   - jwks.json            → point JWKS_FILE at it
// They are a MATCHING pair (the JWKS is the public half of the private key) and
// MUST be generated together — a mismatch makes sign-in fail.
//
// Why files (not inline env): the PEM is multiline and a dotenv line / Docker
// Compose can't hold it cleanly. bootstrap-env.sh / convex-env-push.sh read the
// `<KEY>_FILE` path verbatim (real newlines preserved) and push it to the Convex
// deployment env with `convex env set`.
//
// Uses ONLY Node's built-in crypto — no dependencies, runs with a bare `node`.
// Output is the standard RS256 shape @convex-dev/auth expects: a PKCS#8 PEM
// private key and a JWKS of `{ keys: [{ use: "sig", kty, n, e }] }`.
//
// Usage (from deploy/compose):  node generate-auth-keys.mjs
//   --force   overwrite existing files (default: refuse, to avoid clobbering
//             a live key — rotating it would lock out every existing session)

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const force = process.argv.includes("--force");
const here = new URL(".", import.meta.url).pathname;
const pemPath = resolve(here, "jwt_private_key.pem");
const jwksPath = resolve(here, "jwks.json");

for (const p of [pemPath, jwksPath]) {
  if (existsSync(p) && !force) {
    console.error(`refusing to overwrite ${p} (pass --force to rotate the key)`);
    process.exit(1);
  }
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const jwk = publicKey.export({ format: "jwk" }); // publicKey is already a KeyObject
const jwks = JSON.stringify({ keys: [{ use: "sig", ...jwk }] });

writeFileSync(pemPath, pem, { mode: 0o600 });
writeFileSync(jwksPath, jwks + "\n", { mode: 0o600 });

console.log("Wrote:");
console.log(`  ${pemPath}`);
console.log(`  ${jwksPath}`);
console.log("");
console.log("Now set in .env (paths are relative to .env, so portable):");
console.log("  JWT_PRIVATE_KEY_FILE=jwt_private_key.pem");
console.log("  JWKS_FILE=jwks.json");
console.log("");
console.log("Keep these files secret and OUT of git (deploy/compose/.gitignore");
console.log("already ignores *.pem and jwks.json). Then run ./bootstrap-env.sh.");
