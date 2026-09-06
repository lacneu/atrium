// The Hermes half of the announced-surface ratchet (W9 slice 2b, point 7 — G-70).
//
// The asymmetry is real and is stated rather than smoothed over. OpenClaw announces an
// EVENT CATALOGUE at handshake time and Atrium threw it away — that was G-70's defect and
// events-coverage.test.ts is its ratchet. Hermes announces BOOLEAN CAPABILITIES through
// `GET /v1/capabilities`, and Atrium has always read them (`client.ts` capabilities()).
// So the missing half here was never the reading: it is that nobody ever wrote down what
// Atrium DOES with each declared capability.
//
// Measured at 0.19.0 on 2026-07-30, which is why this gate exists at all: 24 capabilities
// declared, 19 of them true, and 5 of those true ones consumed by nothing in the adapter
// (`responses_api`, `run_submission`, `run_events_sse`, `session_resources`, `skills_api`).
// That set is NON-EMPTY, and checking so was the precondition — lot 47 measured the
// `features` lockstep first and found an empty intersection, which is a guard that can
// never fire, so it was not built. This one can.
//
// Every key of the vendored contract is classified, whatever its boolean value: a
// capability appearing upstream is the news, and a `false` today can be `true` tomorrow.

import { existsSync, readFileSync, readdirSync } from "node:fs";

import { CLASSIFIED_HERMES_CAPABILITIES } from "../src/providers/hermes/classified-capabilities.js";
import { describe, expect, it } from "vitest";

import {
  type CoverageEntry as FeatureEntry,
  anchorViolations,
  classificationViolations,
  derivedCounts,
} from "./helpers/coverage-rules.js";

interface FeatureManifest {
  version: string;
  contract: string;
  counts?: Record<string, number>;
  features: Record<string, FeatureEntry>;
}
interface RestContract {
  version: string;
  /** NOT all booleans: `session_continuity_header` and `session_key_header` carry the
   *  HEADER NAME upstream expects (`"X-Hermes-Session-Id"`). Typing this `boolean` and
   *  testing `=== true` silently excluded both from the "declared" set — two offered
   *  capabilities that no gate could ever count (found while reconciling the published
   *  numbers in review pass 5). Anything not `false` is OFFERED. */
  features: Record<string, boolean | string>;
}

/** A capability upstream OFFERS: declared with anything other than `false`. */
const isOffered = (v: boolean | string | undefined): boolean =>
  v !== undefined && v !== false;

const PROTOCOL = new URL("../protocol/hermes/", import.meta.url);
const read = <T,>(rel: string): T =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf-8")) as T;

/** Vendored Hermes contract directories — every one, not a pinned constant.
 *
 *  Raised in adversarial review: this file read `VERSION = "0.19.0"`, so vendoring a new
 *  Hermes contract left the gate green while it re-checked the OLD one — proactive drift
 *  detection switched off for exactly the version that just arrived. W10/G1 fixed this
 *  same shape for OpenClaw ("pinned to a single directory, it went green on a version
 *  nobody had examined"), and it came back here.
 *
 *  Discovered by the MARKER FILE, not by the name parsing as a version — the second
 *  review pass broke the name test in one line: the vendoring script accepts its version
 *  argument freely, so a directory named `0.20.0+build.1` would be skipped in SILENCE
 *  while the corpus stayed non-empty thanks to the old one, and CI would pass having
 *  checked nothing new. A directory holding a `rest-contract.json` IS a vendored
 *  contract, whatever it is called. */
function vendoredVersions(): string[] {
  return readdirSync(PROTOCOL, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        existsSync(new URL(`${e.name}/rest-contract.json`, PROTOCOL)),
    )
    .map((e) => e.name);
}

describe("the capability surface Hermes publishes is fully classified", () => {
  const versions = vendoredVersions();

  it("there is at least one vendored contract (an empty ratchet checks nothing)", () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  for (const VERSION of versions) {
  describe(VERSION, () => {
  const contract = read<RestContract>(
    `../protocol/hermes/${VERSION}/rest-contract.json`,
  );
  const manifest = read<FeatureManifest>(
    `../protocol/hermes/features/${VERSION}.json`,
  );

  it("the manifest classifies THIS contract version", () => {
    expect(manifest.version).toBe(VERSION);
    expect(contract.version).toBe(VERSION);
  });

  it("the contract declares a non-empty surface (the gate cannot pass empty)", () => {
    expect(Object.keys(contract.features).length).toBeGreaterThan(0);
  });

  it("every DECLARED capability is classified, with its justification", () => {
    // The same rule the OpenClaw ledgers are held to (helpers/coverage-rules.ts).
    const { unclassified, unjustified } = classificationViolations(
      Object.keys(contract.features),
      manifest.features,
    );
    expect(
      unclassified,
      "Hermes declares these capabilities and nobody has said what Atrium does with them",
    ).toEqual([]);
    expect(unjustified, "a classification without prose is a shrug").toEqual([]);
  });

  it("the RUNTIME set mirrors this manifest exactly", () => {
    // The literal the discovery poll compares against. A literal that drifts from the
    // manifest would either flag a classified capability on every poll, or stay silent on
    // one nobody classified — the hand-kept-list defect, one file over.
    expect([...CLASSIFIED_HERMES_CAPABILITIES].sort()).toEqual(
      Object.keys(manifest.features).sort(),
    );
  });

  it("the published COUNTS are derived, not remembered", () => {
    expect(manifest.counts, "the manifest must publish its tallies").toBeDefined();
    expect(manifest.counts).toEqual({
      ...derivedCounts(manifest.features),
      // Hermes' ledger also publishes how many capabilities the contract OFFERS.
      offered: Object.values(contract.features).filter((v) => v !== false).length,
    });
  });

  it("every `handled` CITES code that exists", () => {
    expect(anchorViolations(manifest.features, VERSION)).toEqual([]);
  });

  it("no ORPHAN entry — a capability upstream dropped must leave the manifest", () => {
    const declared = new Set(Object.keys(contract.features));
    const orphans = Object.keys(manifest.features).filter((n) => !declared.has(n));
    expect(orphans).toEqual([]);
  });

  it("the measurement that justifies this gate still holds: the gap set is NON-EMPTY", () => {
    // The lot-47 precondition, kept executable rather than left in a note. If every
    // declared capability were consumed, this ratchet would be a guard that cannot fire
    // and should be deleted rather than quietly maintained.
    const gaps = Object.entries(manifest.features).filter(
      ([name, e]) => e.status === "gap" && isOffered(contract.features[name]),
    );
    expect(
      gaps.length,
        "no declared-true capability is unconsumed — this gate has nothing left to guard",
      ).toBeGreaterThan(0);
      });
    });
  }
});
