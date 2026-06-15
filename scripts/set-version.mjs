#!/usr/bin/env node
// Set the SINGLE lockstep version across every independently-built artifact in
// this repo — the root app/npm package, the bridge, and the mcp server — in ONE
// shot. Atrium is an APPLICATION shipped as a cohesive whole (2 Docker images + a
// thin npm artifact + an MCP), so all artifacts carry the SAME version (lockstep);
// this is NOT a library monorepo with independent per-package release cadences.
//
// Used by the release CI to stamp the version from the git tag (single source of
// truth), and runnable locally. We shell out to `npm version` per package dir
// because npm updates BOTH package.json AND package-lock.json version fields
// SURGICALLY — it does not rewrite the dependency tree, so it is safe across
// platforms (no optional-dep / WASM-binding churn, unlike `npm install`).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const version = process.argv[2];
// Plain SemVer (optionally a pre-release suffix). Reject anything else so a bad
// tag (e.g. "latest", "v1") can never be stamped into the artifacts.
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Usage: set-version.mjs <semver>  (got: ${version ?? "<none>"})`);
  process.exit(1);
}

// Each directory that ships an artifact. They all carry the SAME version.
const targets = [".", "bridge", "mcp"];

for (const dir of targets) {
  const cwd = join(repoRoot, dir);
  execFileSync(
    "npm",
    ["version", version, "--no-git-tag-version", "--allow-same-version"],
    { cwd, stdio: "inherit" },
  );
}
console.log(`\nAll artifacts set to ${version}.`);
