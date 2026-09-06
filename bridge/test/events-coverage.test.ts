// The ANNOUNCED-event ratchet (W9 slice 2b, point 7 — G-70).
//
// The gateway tells every client what it emits: `hello-ok.features.events`, populated
// upstream from `GATEWAY_EVENTS`. Atrium read the handshake for `server.version` and
// `policy.maxPayload` and threw the catalogue away, so an unhandled event family was
// only ever discovered the way every frame defect of July was discovered — a user hit
// it first, and someone patched afterwards.
//
// This test makes the catalogue a CONTRACT instead of a courtesy. It enforces a
// BIJECTION between the vendored catalogue (protocol/openclaw/<version>/event-catalogue.json,
// derived from upstream) and Atrium's classification (coverage/events-<version>.json):
//
//   1. every announced family is classified — `handled` needs `by`, `ignored` needs
//      `why`, `gap` REQUIRES a `note` saying what is unsupported and what it costs;
//   2. no orphan classification entries — a family upstream dropped must leave the
//      manifest, because a stale claim misleads exactly as much as a missing one;
//   3. the manifest names the version it classifies.
//
// WHY A CLASSIFICATION AND NOT A SUBSET ASSERTION: measured at v2026.7.1 on 2026-07-30,
// the catalogue announces 30 families and Atrium actually FEEDS 4 of them (review pass 4
// corrected this: `session.operation` has a reader that nothing delivers to). A
// "everything announced must be handled" assertion would be red on arrival for 26 entries
// and would be weakened
// within the day — which is how tautological guards are born (lot 25). What CAN fire,
// and fires for a real reason, is exhaustiveness: vendor a version whose catalogue grew
// and CI stays red until a human classifies the newcomer.
//
// This runs in CI with no gateway and no upstream checkout: the catalogue is vendored.
// That is deliberate — lot 47 left its upstream verification conditional on a local
// checkout, so it was absent exactly where regressions land.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";


import {
  BROADCAST_ONLY_EVENTS,
  CLASSIFIED_EVENTS,
  DRIFT_VENDORED_VERSION,
} from "../src/providers/openclaw/protocol-drift.js";
import {
  type CoverageEntry as EventEntry,
  anchorViolations,
  classificationViolations,
  derivedCounts,
} from "./helpers/coverage-rules.js";
import { vendoredVersions } from "./helpers/vendored.js";



interface EventManifest {
  version: string;
  catalogue: string;
  counts?: Record<string, number>;
  events: Record<string, EventEntry>;
  /** Families the gateway can BROADCAST without announcing (broadcast-catalogue.json
   *  minus event-catalogue.json). Present exactly when the broadcast catalogue is
   *  vendored for this version; entries may carry the frame-discovery `dossier`/`proof`. */
  broadcastOnly?: Record<string, EventEntry & { dossier?: unknown; proof?: unknown }>;
  broadcastOnlyCounts?: Record<string, number>;
}
interface BroadcastCatalogue {
  derivedFrom: string;
  events: string[];
  scopes: Record<string, string[]>;
}
interface Catalogue {
  derivedFrom: string;
  events: string[];
}



function readJson<T>(rel: string): T {
  return JSON.parse(
    readFileSync(new URL(rel, import.meta.url), "utf-8"),
  ) as T;
}

/** One read per vendored version, shared by every gate below: two describes reading the
 *  same files separately would let a future in-memory mutation in one block show a
 *  different manifest to the other. `broadcast` is undefined where the broadcast
 *  catalogue is not vendored. */
const VERSIONS = vendoredVersions();
const LEDGER = new Map(
  VERSIONS.map((version) => [
    version,
    {
      catalogue: readJson<Catalogue>(`../protocol/openclaw/${version}/event-catalogue.json`),
      manifest: readJson<EventManifest>(`../protocol/openclaw/events/${version}.json`),
      broadcast: existsSync(
        new URL(`../protocol/openclaw/${version}/broadcast-catalogue.json`, import.meta.url),
      )
        ? readJson<BroadcastCatalogue>(`../protocol/openclaw/${version}/broadcast-catalogue.json`)
        : undefined,
    },
  ]),
);

describe("the announced event catalogue is fully classified", () => {

  it("there is at least one vendored version to check (the gate cannot pass empty)", () => {
    // Lot 14's lesson: a gate that iterates an empty list is green for the wrong
    // reason. Assert the corpus is non-empty before asserting anything about it.
    expect(VERSIONS.length).toBeGreaterThan(0);
  });

  for (const [version, { catalogue, manifest }] of LEDGER) {
    describe(version, () => {

      it("the manifest classifies THIS version", () => {
        expect(manifest.version).toBe(version);
      });

      it("the catalogue is non-empty and free of duplicates", () => {
        expect(catalogue.events.length).toBeGreaterThan(0);
        expect(new Set(catalogue.events).size).toBe(catalogue.events.length);
      });

      it("every ANNOUNCED family is classified, with its justification", () => {
        const { unclassified, unjustified } = classificationViolations(
          catalogue.events,
          manifest.events,
        );
        expect(
          unclassified,
          "the gateway announces these and nobody has said what Atrium does with them",
        ).toEqual([]);
        expect(unjustified, "a classification without prose is a shrug").toEqual([]);
      });

      it("the RUNTIME set mirrors this manifest exactly (vendored version only)", () => {
        // The bridge runs from `dist/` where `protocol/` is absent, so the runtime sensor
        // compares against a literal set rather than reading this file. A literal that
        // drifts from the manifest is the hand-kept list G-68 was about, one file over:
        // it would either miss a classified family (noise on every connect) or claim one
        // that was never classified (silence exactly where the ratchet was meant to speak).
        if (version !== DRIFT_VENDORED_VERSION) return;
        expect([...CLASSIFIED_EVENTS].sort()).toEqual(
          Object.keys(manifest.events).sort(),
        );
      });


      it("the published COUNTS are derived, not remembered", () => {
        expect(manifest.counts, "the manifest must publish its tallies").toBeDefined();
        expect(manifest.counts).toEqual(derivedCounts(manifest.events));
      });

      it("every `handled` CITES code that exists", () => {
        expect(anchorViolations(manifest.events, version)).toEqual([]);
      });

      it("no ORPHAN entry — a family upstream dropped must leave the manifest", () => {
        const announced = new Set(catalogue.events);
        const orphans = Object.keys(manifest.events).filter((n) => !announced.has(n));
        expect(
          orphans,
          "these are classified but no longer announced: a stale claim misleads as much as a missing one",
        ).toEqual([]);
      });
    });
  }
});

describe("the BROADCAST-ONLY families are fully classified", () => {
  // Upstream keeps two vocabularies: what the gateway ANNOUNCES (`GATEWAY_EVENTS`, the
  // catalogue above) and what it can BROADCAST (`EVENT_SCOPE_GUARDS`, the larger table).
  // A ratchet on the announced list alone said nothing about the difference, and that is
  // where `config.changed` lived: sent on every config edit, dropped unread, and no gate
  // knew it existed. This gate classifies the difference with the same vocabulary and the
  // same anchor rule as the announced families.
  const withCatalogue = [...LEDGER].filter(([, l]) => l.broadcast !== undefined);
  const withoutCatalogue = [...LEDGER].filter(([, l]) => l.broadcast === undefined);

  it("the broadcast catalogue is vendored for the version the sensor runs on (the mirror cannot be vacuous)", () => {
    expect(withCatalogue.length).toBeGreaterThan(0);
    expect(withCatalogue.map(([v]) => v)).toContain(DRIFT_VENDORED_VERSION);
  });

  it("the RUNTIME set mirrors the derived difference of the version the sensor runs on", () => {
    // The bridge runs from `dist/` where `protocol/` is absent, so the runtime sensor
    // compares against a literal; this keeps the literal equal to the derivation.
    const ledger = LEDGER.get(DRIFT_VENDORED_VERSION);
    expect(ledger?.broadcast, "the sensor's version must carry the broadcast catalogue").toBeDefined();
    const announced = new Set(ledger!.catalogue.events);
    const derived = ledger!.broadcast!.events.filter((e) => !announced.has(e));
    expect([...BROADCAST_ONLY_EVENTS].sort()).toEqual([...derived].sort());
  });

  for (const [version, { manifest }] of withoutCatalogue) {
    it(`${version} has no broadcast catalogue and CLAIMS none — a classification of a list nobody derived is a claim`, () => {
      // REACHABLE today: 2026.6.11 and 2026.7.1 carry no broadcast catalogue, because
      // the vendoring script refuses to re-vendor those tags (it requires
      // `schema/closed-object.ts`, which upstream added later). Until that is fixed,
      // the manifest must stay silent rather than carry a hand-typed list.
      expect(manifest.broadcastOnly).toBeUndefined();
      expect(manifest.broadcastOnlyCounts).toBeUndefined();
    });
  }

  for (const [version, { catalogue, manifest, broadcast }] of withCatalogue) {
    if (broadcast === undefined) continue; // narrowed above; the type does not know
    describe(version, () => {
      const announced = new Set(catalogue.events);
      const broadcastOnly = broadcast.events.filter((e) => !announced.has(e));

      it("the broadcast catalogue is non-empty, duplicate-free, and names a scope for every family", () => {
        expect(broadcast.events.length).toBeGreaterThan(0);
        expect(new Set(broadcast.events).size).toBe(broadcast.events.length);
        for (const e of broadcast.events) expect(broadcast.scopes[e], e).toBeDefined();
      });

      it("every broadcast-only family is classified, with its justification", () => {
        const { unclassified, unjustified } = classificationViolations(
          broadcastOnly,
          manifest.broadcastOnly ?? {},
        );
        expect(
          unclassified,
          "the gateway can send these without announcing them, and nobody has said what Atrium does with them",
        ).toEqual([]);
        expect(unjustified, "a classification without prose is a shrug").toEqual([]);
      });

      it("no ORPHAN entry — a family that became announced, or left the table, must leave this section", () => {
        const orphans = Object.keys(manifest.broadcastOnly ?? {}).filter(
          (n) => !broadcastOnly.includes(n),
        );
        expect(orphans).toEqual([]);
      });

      it("every `handled` CITES code that exists", () => {
        expect(anchorViolations(manifest.broadcastOnly ?? {}, `${version} broadcast-only`)).toEqual([]);
      });

      it("the published COUNTS are derived, not remembered", () => {
        expect(manifest.broadcastOnlyCounts).toEqual(derivedCounts(manifest.broadcastOnly ?? {}));
      });
    });
  }
});
