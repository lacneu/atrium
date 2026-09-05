// THE CODE A VERSION CLAIM IS ABOUT (codex).
//
// `vendoredSha256` ties an attestation to the upstream surface it was benched
// against. Nothing tied it to OUR side of the contract: the normalizer, the frame
// readers and the manifest that decide how Atrium reads that surface. A GO could
// therefore be earned, then those files edited, and `maxValidated` would still rest
// on a run that never exercised the shipped code.
//
// `worktree.deltaSha256` does not close that: it hashes an uncommitted diff against
// a HEAD that moves, so it records provenance but can never be RE-COMPUTED. This
// digest can. It covers the production code that reads a gateway, and the bench
// attestation carries it so the guard can recompute it from the repository — the
// same reason `vendoredSha256` is load-bearing only because the test re-derives it.
//
// Deliberately NOT covered: tests (they do not change what the bridge reads at
// runtime, and a new test must not demand a fresh live run) and the vendored
// directories (already hashed, per version, by `vendoredSha256`).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The bridge's PRODUCTION code, whole.
 *
 *  A narrower list (compat + core + providers) was tried first and was wrong: this very
 *  lot puts 2026.8.1+ branches in `server.ts` and the plan-clear call in
 *  `convex-writer.ts`, both outside it, so editing them after a GO left the claim green
 *  (codex). The rule is now the component, not a hand-picked set — nothing to keep in
 *  sync, nothing to forget.
 *
 *  STATED LIMIT: it stops at the bridge. The bench also validates Atrium's resulting
 *  state through the dev probes, so a `convex/` regression after a GO does NOT turn the
 *  claim red. The bridge is what the harness rebuilds and restarts, so the causal link
 *  is real there and would be a pretence elsewhere — and a digest that went red on every
 *  product edit is a gate nobody would keep. Said out loud rather than left as a gap. */
export const SUPPORT_ROOTS = [
  "bridge/src",
  // …and HOW that source becomes the artifact the bench ran. The harness compiles with
  // these configs and the process loads dependencies resolved by this lockfile, so a
  // compiler-option or dependency change can move the running transport (`ws`, say)
  // with every source file untouched (codex). Hashing the manifests catches that; the
  // installed tree itself is not hashed, which is what the lockfile stands in for.
  "bridge/package.json",
  "bridge/package-lock.json",
  "bridge/tsconfig.json",
  "bridge/tsconfig.build.json",
];

function walk(abs, out) {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return; // a missing root shows up as a digest mismatch, never as a silent pass
  }
  if (st.isFile()) {
    out.push(abs);
    return;
  }
  for (const name of readdirSync(abs).sort()) {
    walk(join(abs, name), out);
  }
}

/** sha256 over "<posix path> <sha256 of contents>" per covered file, sorted.
 *  Returns null when NO file was found — an empty digest would otherwise agree with
 *  itself on a broken checkout. */
export function listSupportFiles(repoRoot) {
  const files = [];
  for (const root of SUPPORT_ROOTS) walk(join(repoRoot, root), files);
  return files
    .filter((f) => /\.(ts|mjs|js|json)$/.test(f))
    .filter((f) => !/\.test\.ts$/.test(f))
    .map((f) => relative(repoRoot, f).split(sep).join("/"))
    .sort();
}

/** The manifests, MINUS the artifact version number.
 *
 *  Release CI runs `scripts/set-version.mjs` (an `npm version` per package) BEFORE
 *  `npm test`, rewriting the very fields a byte-for-byte hash reads — so the gate would
 *  have gone red on every tagged build, on a change that alters nothing the bench
 *  exercised (codex). Only the stamped fields are dropped: dependencies, scripts and the
 *  resolved tree all stay in the digest, which is what the manifests are here for. */
export function canonicalize(rel, bytes) {
  if (!/\/package(-lock)?\.json$/.test(rel)) return bytes;
  let doc;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch {
    return bytes; // unparseable: hash it verbatim rather than silently ignoring it
  }
  delete doc.version;
  if (doc.packages && typeof doc.packages === "object" && doc.packages[""]) {
    delete doc.packages[""].version;
  }
  return Buffer.from(JSON.stringify(doc));
}

export function computeSupportDigest(repoRoot) {
  const covered = listSupportFiles(repoRoot);
  if (covered.length === 0) return null;
  const h = createHash("sha256");
  for (const rel of covered) {
    const bytes = canonicalize(rel, readFileSync(join(repoRoot, rel)));
    h.update(rel + " " + createHash("sha256").update(bytes).digest("hex") + "\n");
  }
  return h.digest("hex");
}
