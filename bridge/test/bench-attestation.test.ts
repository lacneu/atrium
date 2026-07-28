/**
 * WHAT EARNS A VERSION CLAIM (W11/G6).
 *
 * `validatedVersions` decides real behaviour: `withinSupport` returns true for every
 * version at or above `maxValidated`, so a bump nobody earned declares support the bench
 * never gave. Until now the evidence was a prose comment beside the list.
 *
 * This suite makes the claim rest on a file: `bridge/protocol/openclaw/<version>/
 * BENCH.json`, written by the live bench on a GO run over the complete catalogue.
 *
 * It is deliberately NOT a signature. The same hand runs the bench, writes the file and
 * makes the commit, so authenticity is out of reach — claiming otherwise would be the
 * self-attested-hash trap this program has already paid for. What is checked is that the
 * claim, the vendored surface and the repository AGREE:
 *
 *   * the attestation sits in the directory it names;
 *   * its `vendoredSha256` matches a hash RE-COMPUTED here from that directory;
 *   * the run was a GO, over the whole catalogue, with no skip flags;
 *   * its `atriumSha` is a real commit — when the checkout can answer that at all.
 *
 * And the exemption cannot grow: the grandfathered set and the enforced set must be
 * disjoint, so a new failure can never be silenced by adding a name to the list.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BENCH_GRANDFATHERED,
  COMPAT_MANIFEST,
  compareVersions,
  parseVersion,
} from "../src/compat.js";

const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL_ROOT = join(BRIDGE, "protocol/openclaw");
const CORPUS_ROOT = join(BRIDGE, "test/fixtures/golden");

interface Attestation {
  kind: string;
  version: number;
  gatewayVersion: string;
  verdict: string;
  at: string;
  scenarios: string[];
  providers: Record<string, string>;
  flags: string[];
  atriumSha: string | null;
  bridgeVersion: string | null;
  vendoredSha256: string;
}

/** The same hash the bench computes, RE-COMPUTED from the directory. A number an artifact
 *  carries about itself proves nothing; this one is only load-bearing because it is
 *  recomputed here — the same reason `vendor-integrity.test.ts` re-derives its snapshot. */
function hashDirectory(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (entry.name === "BENCH.json") continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else {
        hash.update(rel);
        hash.update("\0");
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

function readAttestation(version: string): Attestation | null {
  const file = join(PROTOCOL_ROOT, version, "BENCH.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Attestation;
}

/** OpenClaw scenario ids the golden corpus holds for a version — the catalogue floor. */
function corpusScenarios(version: string): string[] {
  const dir = join(CORPUS_ROOT, version);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}

const OPENCLAW = COMPAT_MANIFEST.providers.openclaw!;
const GRANDFATHERED = new Set(BENCH_GRANDFATHERED.openclaw);
/** Every claim that must be earned: `maxValidated` plus anything not grandfathered. */
const ENFORCED = OPENCLAW.validatedVersions.filter((v) => !GRANDFATHERED.has(v));

/** The exemption, PINNED. `ENFORCED` is `validatedVersions` minus the grandfather set, so
 *  asserting the two are disjoint proves nothing at all — it is true by construction, and
 *  adding a name to the exemption silently removed the obligation with it (raised in
 *  review). The only thing that actually freezes the list is a second copy, here, that a
 *  reviewer sees change. */
const FROZEN_GRANDFATHER = [
  "2026.5.19",
  "2026.6.1",
  "2026.6.5",
  "2026.6.10",
  "2026.6.11",
  "2026.7.1-beta.2",
  "2026.7.1-beta.5",
];

describe("the exemption is finite and CANNOT grow", () => {
  it("is exactly the list frozen when the rule was introduced", () => {
    // Widening the exemption in `compat.ts` now requires editing this list too — which is
    // exactly the visibility the rule needs. Narrowing it (validating an old version for
    // real) also lands here, deliberately: shrinking an exemption is a claim too.
    expect([...GRANDFATHERED].sort()).toEqual([...FROZEN_GRANDFATHER].sort());
  });

  it("holds nothing at or above maxValidated", () => {
    // The exemption is for the PAST. A version at or above the one that decides support
    // cannot be exempt, whatever the list says.
    const max = OPENCLAW.supportedRange?.maxValidated;
    expect(max, "the manifest declares no maxValidated").toBeTruthy();
    const ceiling = parseVersion(max!);
    expect(ceiling, `maxValidated ${max} is unparseable`).not.toBeNull();
    for (const version of GRANDFATHERED) {
      const parsed = parseVersion(version);
      expect(parsed, `${version} is unparseable`).not.toBeNull();
      expect(
        compareVersions(parsed!, ceiling!) < 0,
        `${version} is exempt but not below maxValidated`,
      ).toBe(true);
    }
  });

  it("maxValidated is ENFORCED, and something is", () => {
    const max = OPENCLAW.supportedRange?.maxValidated;
    expect(ENFORCED, `maxValidated ${max} must rest on an attestation`).toContain(max!);
    expect(ENFORCED.length, "nothing is enforced — the rule would be vacuous").
      toBeGreaterThan(0);
  });

  it("every grandfathered entry is a REAL claim", () => {
    // A name in the exemption that is not in the manifest is dead weight nobody prunes.
    for (const version of GRANDFATHERED) {
      expect(
        OPENCLAW.validatedVersions,
        `${version} is exempt but not claimed`,
      ).toContain(version);
    }
  });
});

describe("an enforced claim rests on a GO attestation", () => {
  for (const version of ENFORCED) {
    it(`${version}`, () => {
      const att = readAttestation(version);
      expect(
        att,
        `${version} is claimed with no BENCH.json — run the live bench for it`,
      ).not.toBeNull();
      expect(att!.kind).toBe("atrium-bench-attestation");
      expect(att!.gatewayVersion, "the attestation names another version").toBe(version);
      expect(att!.verdict, "only a GO earns a claim").toBe("GO");
      expect(att!.flags, "a GO over a SUBSET is not a GO over the catalogue").toEqual([]);
    });
  }
});

describe("the attestation agrees with the repository", () => {
  for (const version of ENFORCED) {
    it(`${version}: the vendored hash is RE-COMPUTED, not trusted`, () => {
      const att = readAttestation(version);
      expect(att).not.toBeNull();
      const actual = hashDirectory(join(PROTOCOL_ROOT, version));
      expect(
        att!.vendoredSha256,
        "the vendored surface changed after the bench ran — re-run it",
      ).toBe(actual);
    });

    it(`${version}: a corpus EXISTS for it`, () => {
      // Without this, a brand-new version with no golden directory passes every check
      // below with `scenarios: []` — a GO declared over nothing at all (raised in
      // review). The corpus is what the catalogue is measured against; no corpus, no
      // claim.
      expect(
        corpusScenarios(version).length,
        `${version} is claimed but has no golden corpus — promote a run for it`,
      ).toBeGreaterThan(0);
      const att = readAttestation(version);
      expect(att!.scenarios.length, "an empty catalogue is not a catalogue").
        toBeGreaterThan(0);
    });

    it(`${version}: the catalogue covers the corpus`, () => {
      // The corpus names the OpenClaw scenarios a run must have exercised. A `--skip-*`
      // run either omits one of them (caught here) or records the flag (caught above).
      const att = readAttestation(version);
      expect(att).not.toBeNull();
      const ran = new Set(att!.scenarios);
      for (const scenario of corpusScenarios(version)) {
        expect(ran, `${scenario} is in the corpus but not in the run`).toContain(scenario);
      }
    });

    it(`${version}: the Atrium commit is well-formed, and real when knowable`, () => {
      const att = readAttestation(version);
      expect(att).not.toBeNull();
      const sha = att!.atriumSha ?? "";
      expect(sha, "no commit recorded").toMatch(/^[0-9a-f]{40}$/);
      // Resolution needs the object, and CI clones SHALLOW (`actions/checkout` with no
      // fetch-depth), so a historical commit is genuinely unresolvable there. The check
      // therefore distinguishes "this commit does not exist" from "this checkout cannot
      // tell" — and says which, out loud, rather than passing silently either way.
      let shallow = true;
      try {
        shallow =
          execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: BRIDGE })
            .toString()
            .trim() === "true";
      } catch {
        console.warn(`[bench-attestation] ${version}: no git checkout — commit unverified`);
        return;
      }
      const known = (() => {
        try {
          // ANCESTOR of HEAD, not merely an object that exists: a detached or
          // other-branch commit satisfies `cat-file` while having nothing to do with the
          // code under test (raised in review).
          execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
            cwd: BRIDGE,
            stdio: "ignore",
          });
          return true;
        } catch {
          return false;
        }
      })();
      if (known) return;
      if (shallow) {
        console.warn(
          `[bench-attestation] ${version}: commit ${sha.slice(0, 12)} is not in ` +
            "this SHALLOW clone — well-formed but unverified here",
        );
        return;
      }
      throw new Error(
        `${version}: commit ${sha} is not an ancestor of HEAD — the attestation ` +
          "names a commit that is not part of the code being tested",
      );
    });
  }
});
