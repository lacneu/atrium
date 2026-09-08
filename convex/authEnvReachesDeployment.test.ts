// Every auth environment variable the code READS is one a deployment can SET.
//
// THE DEFECT THIS GUARDS, found on 2026-09-12. Convex functions read their
// environment from the DEPLOYMENT, not from the container — so a variable only
// arrives if one of the push paths names it, and every one of those paths carries
// a hardcoded list. `AUTH_AUTHELIA_*` was read by `convex/auth.ts` and
// `convex/me.ts` and named by none of them: an operator could set all three
// correctly, restart everything, and get a sign-in screen reporting that no
// provider is configured. Nothing throws, nothing logs, and the deployment is
// simply unusable — the third time this shape appeared in one day.
//
// The rule spans files that have no reason to know about each other: TypeScript
// that reads `process.env`, a shell script, and a Helm template. Only a reader
// comparing them notices, which is exactly why it drifted.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

/**
 * Convex sources whose `process.env.AUTH_*` reads must be deployable — ALL of
 * them, discovered rather than listed. A hand-kept list is the same shape as the
 * hardcoded push lists this file exists to check: `convex/lib/authDomains.ts`
 * reads `AUTH_ALLOWED_EMAIL_DOMAINS`, the single most load-bearing variable of
 * the lot, and an earlier version of this guard did not look at it.
 */
function readerFiles(dir = "convex"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "_generated") out.push(...readerFiles(rel));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(rel);
    }
  }
  return out;
}

/** Every path that pushes environment INTO the Convex deployment. */
const PUSHERS = [
  "deploy/compose/convex-env-push.sh",
  "deploy/compose/bootstrap-env.sh",
  "deploy/helm/templates/bootstrap-job.yaml",
];

/** Where an operator LEARNS the variable exists. */
const SURFACES = [
  "deploy/compose/.env.example",
  "deploy/helm/values.yaml",
  "docs/CONFIGURATION.md",
];

function readAuthEnvNames(): string[] {
  const names = new Set<string>();
  for (const file of readerFiles()) {
    // `AUTH_` alone is a prefix in a template, not a variable: require a name.
    for (const m of read(file).matchAll(/process\.env\.(AUTH_[A-Z0-9]+[A-Z0-9_]*)\b/g)) {
      names.add(m[1]!);
    }
  }
  return [...names].sort();
}

describe("auth env vars reach the deployment that needs them", () => {
  test("the extraction still finds the variables it is meant to check", () => {
    // Without this the whole file passes vacuously the day a read is written
    // differently (destructured, aliased) — a guard that checks an empty list is
    // a guard that has stopped guarding, which is the failure mode of every
    // scanner. Two known names, from two different providers.
    const names = readAuthEnvNames();
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(names).toContain("AUTH_GOOGLE_ID");
    expect(names).toContain("AUTH_AUTHELIA_ISSUER");
    // Read by convex/lib/, which a hand-kept reader list missed.
    expect(names).toContain("AUTH_ALLOWED_EMAIL_DOMAINS");
  });

  test("every variable the code reads is pushed by every push path", () => {
    const names = readAuthEnvNames();
    const missing: string[] = [];
    for (const file of PUSHERS) {
      const body = read(file);
      for (const name of names) {
        if (!body.includes(name)) missing.push(`${file} does not push ${name}`);
      }
    }
    expect(
      missing,
      "a variable the code reads but no push path carries never reaches Convex: " +
        "the operator sets it, nothing happens, and nothing says why",
    ).toEqual([]);
  });

  test("every variable is discoverable by an operator", () => {
    // Reaching the deployment is not enough if nobody knows the name. The example
    // file and the values file are where a deployment is written; CONFIGURATION.md
    // is where it is read.
    const names = readAuthEnvNames();
    const missing: string[] = [];
    for (const file of SURFACES) {
      const body = read(file);
      for (const name of names) {
        if (!body.includes(name)) missing.push(`${file} does not mention ${name}`);
      }
    }
    expect(missing, "undocumented auth environment").toEqual([]);
  });
});
