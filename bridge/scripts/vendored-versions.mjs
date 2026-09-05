#!/usr/bin/env node
// Prints the vendored protocol versions, OLDEST FIRST, one per line.
//
// Exists so that tooling outside this repo (the upstream-diff script in the bench
// harness) can ask the repo which contracts it actually holds, instead of grepping
// `maxValidated` out of compat.ts. Those two answers are NOT the same question: the
// ceiling is what we promise, the vendored set is what we can compare against, and
// the upstream diff must start from the newest thing it can actually diff.
//
// It reuses the bridge's own `compareVersions` on purpose. A second comparator would
// be a second chance to sort `2026.10.1` before `2026.6.11`, which is precisely the
// bug the shared test helper was written to kill.

import { readdirSync } from "node:fs";
import path from "node:path";

import { compareVersions, parseVersion } from "../src/compat.ts";

const dir = path.join(import.meta.dirname, "..", "protocol", "openclaw");
const versions = readdirSync(dir, { withFileTypes: true })
  // Only VERSION-shaped directories are vendored contracts: `coverage/` and
  // `events/` (manifests) live beside them and sorted as "the newest vendored
  // contract" (upstream-diff.sh then tried to clone `vevents`).
  .filter((e) => e.isDirectory() && parseVersion(e.name) !== null)
  .map((e) => e.name)
  .sort((a, b) => {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (pa === null || pb === null) return a.localeCompare(b);
    return compareVersions(pa, pb);
  });

if (versions.length === 0) {
  console.error("no vendored protocol directory");
  process.exit(1);
}
console.log(versions.join("\n"));
