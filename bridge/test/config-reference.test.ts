/**
 * THE CONFIGURATION REFERENCE IS CHECKED AGAINST THE CODE.
 *
 * A configuration page that drifts is worse than no page: a reader — human or
 * agent — follows it literally, sets a variable nothing reads, and gets a stack
 * that starts and then fails somewhere unrelated. This repo already learned that
 * the expensive way on a media path (`.env.example` asked for two variables the
 * compose file consumed nowhere; the pipeline failed silently).
 *
 * So the same both-directions discipline as `describe-field-declaration.test.ts`:
 * a variable the bridge READS must be documented, and a variable documented as
 * the bridge's must be read. Either gap fails the build.
 *
 * SCOPE, stated rather than implied: the BRIDGE's own environment, read through
 * the typed helpers in `src/config.ts`. Convex-deployment and compose variables
 * live in other files with other consumers; they are documented on the same page
 * but not enforced here.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

/** Variables the bridge reads, DERIVED from the source — never restated. */
function readByBridge(): string[] {
  const src = read("../src/config.ts");
  const found = new Set<string>();
  // The typed helpers: requireEnv("X"), optionalEnv("X", d), parseIntEnv("X", d)…
  for (const m of src.matchAll(
    /\b(?:requireEnv|optionalEnv|optionalEnvOrNull|optionalVersionEnv|parseIntEnv|parseBoolEnv|parseSecretsList)\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  )) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  // Direct reads, for the few that bypass the helpers.
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found].sort();
}

/** Variables the reference documents as the BRIDGE's — the two bridge tables. */
function documentedForBridge(): string[] {
  const doc = read("../../docs/CONFIGURATION.md");
  const start = doc.indexOf("### Bridge — required");
  const end = doc.indexOf("### Front end — build-time");
  expect(
    start,
    "the bridge section was renamed — this gate is now checking nothing",
  ).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const found = new Set<string>();
  // Table cells only: a name mentioned in prose does not count as documented.
  for (const m of doc.slice(start, end).matchAll(/^\|\s*`([A-Z][A-Z0-9_]{2,})`/gm)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  // A row may document a pair, e.g. `A` / `B`.
  for (const m of doc.slice(start, end).matchAll(/`([A-Z][A-Z0-9_]{2,})`\s*\/\s*`([A-Z][A-Z0-9_]{2,})`/g)) {
    if (m[1]) found.add(m[1]);
    if (m[2]) found.add(m[2]);
  }
  return [...found].sort();
}

describe("docs/CONFIGURATION.md matches what the bridge actually reads", () => {
  it("the sweep finds a real surface (an empty one would pass by measuring nothing)", () => {
    expect(readByBridge().length).toBeGreaterThan(10);
    expect(documentedForBridge().length).toBeGreaterThan(10);
  });

  it("every variable the bridge reads is documented", () => {
    const documented = new Set(documentedForBridge());
    const undocumented = readByBridge().filter((v) => !documented.has(v));
    expect(
      undocumented,
      "the bridge reads these and the reference does not mention them: an operator cannot set what nothing tells them about, and the failure surfaces far from the cause",
    ).toEqual([]);
  });

  it("every variable documented as the bridge's is really read by it", () => {
    const actual = new Set(readByBridge());
    const phantom = documentedForBridge().filter((v) => !actual.has(v));
    expect(
      phantom,
      "the reference documents these as the bridge's and nothing reads them — exactly the shape of the media-path trap: set faithfully, consumed by no one",
    ).toEqual([]);
  });
});
