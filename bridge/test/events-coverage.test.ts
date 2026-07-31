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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { stripComments } from "../scripts/lib/derive-event-catalogue.mjs";

import {
  CLASSIFIED_EVENTS,
  DRIFT_VENDORED_VERSION,
} from "../src/providers/openclaw/protocol-drift.js";
import { vendoredVersions } from "./helpers/vendored.js";


/** A `handled` verdict must point at code that EXISTS.
 *
 *  Review passes 4 and 5 found six classifications claiming a consumption the code does
 *  not perform — `run_status` "polled" by nothing, `chat_completions` "dispatched" to an
 *  endpoint never built, headers "carried" that are never sent. Five of the six named no
 *  verifiable anchor at all: they were prose, and prose cannot be falsified by a test.
 *
 *  So every `handled` carries `anchor: {file, token}`, and this asserts the token is
 *  present in that file AFTER COMMENTS ARE STRIPPED. The stripping is not pedantry: most
 *  of these names appear in explanatory comments too, and an anchor satisfied by a
 *  comment would certify exactly the vague claim this rule exists to kill. The same
 *  stripper the catalogue deriver uses, so the two cannot disagree.
 *
 *  WHAT THIS DOES NOT PROVE: that the code reached by the anchor is FED, or that it does
 *  what the prose says. `session.operation` had a real reader at a real line and was
 *  still wrong — nothing delivers the event. That class stays a human read; this rule
 *  removes the other five.
 */
function anchorViolations(
  entries: Record<string, { status: string; anchor?: { file: string; token: string } }>,
  label: string,
): string[] {
  const bad: string[] = [];
  for (const [name, e] of Object.entries(entries)) {
    if (e.status !== "handled") {
      if (e.anchor !== undefined) {
        bad.push(`${label} ${name}: only \`handled\` carries an anchor`);
      }
      continue;
    }
    const anchor = e.anchor;
    if (anchor === undefined || !anchor.file || !anchor.token) {
      bad.push(`${label} ${name}: \`handled\` requires anchor {file, token}`);
      continue;
    }
    // Production code only, and canonically so. Two bypasses were found in a row:
    // `src/../test/foo.test.ts` (pass 7, literal segments) and `src/%2e%2e/test/foo.test.ts`
    // (pass 8 — WHATWG URL decodes the escape, so a segment check on the raw string sees
    // nothing wrong). Rather than enumerate spellings, the rule is now a whitelist of
    // harmless characters plus a check on the RESOLVED path: a test certifies that a claim
    // is TESTED, never that the build DOES it.
    if (!/^src\/[A-Za-z0-9_./-]+\.ts$/.test(anchor.file) || anchor.file.includes("%")) {
      bad.push(`${label} ${name}: anchor must point into src/, not ${anchor.file}`);
      continue;
    }
    const at = new URL(`../${anchor.file}`, import.meta.url);
    if (!at.pathname.includes("/bridge/src/") || at.pathname.includes("/..")) {
      bad.push(`${label} ${name}: anchor resolves outside src/ (${anchor.file})`);
      continue;
    }
    let body: string;
    try {
      body = readFileSync(at, "utf-8");
    } catch {
      bad.push(`${label} ${name}: anchor file ${anchor.file} does not exist`);
      continue;
    }
    const code = (stripComments as (s: string) => string)(body);
    if (!code.includes(anchor.token)) {
      bad.push(
        `${label} ${name}: token ${JSON.stringify(anchor.token)} is absent from ` +
          `${anchor.file} outside comments — the claim cites code that is not there`,
      );
    }
  }
  return bad;
}

interface EventEntry {
  status: "handled" | "ignored" | "gap";
  /** Only on `handled`: the code that performs the consumption being claimed. */
  anchor?: { file: string; token: string };
  by?: string;
  why?: string;
  note?: string;
}
interface EventManifest {
  version: string;
  catalogue: string;
  counts?: Record<string, number>;
  events: Record<string, EventEntry>;
}
interface Catalogue {
  derivedFrom: string;
  events: string[];
}

const VALID_STATUSES = new Set(["handled", "ignored", "gap"]);
/** The prose each status owes the reader. A status with no justification is a shrug. */
const REQUIRED_PROSE: Record<string, keyof EventEntry> = {
  handled: "by",
  ignored: "why",
  gap: "note",
};

function readJson<T>(rel: string): T {
  return JSON.parse(
    readFileSync(new URL(rel, import.meta.url), "utf-8"),
  ) as T;
}

describe("the announced event catalogue is fully classified", () => {
  const versions = vendoredVersions();

  it("there is at least one vendored version to check (the gate cannot pass empty)", () => {
    // Lot 14's lesson: a gate that iterates an empty list is green for the wrong
    // reason. Assert the corpus is non-empty before asserting anything about it.
    expect(versions.length).toBeGreaterThan(0);
  });

  for (const version of versions) {
    describe(version, () => {
      const catalogue = readJson<Catalogue>(
        `../protocol/openclaw/${version}/event-catalogue.json`,
      );
      const manifest = readJson<EventManifest>(
        `../protocol/openclaw/events/${version}.json`,
      );

      it("the manifest classifies THIS version", () => {
        expect(manifest.version).toBe(version);
      });

      it("the catalogue is non-empty and free of duplicates", () => {
        expect(catalogue.events.length).toBeGreaterThan(0);
        expect(new Set(catalogue.events).size).toBe(catalogue.events.length);
      });

      it("every ANNOUNCED family is classified, with its justification", () => {
        const unclassified: string[] = [];
        const unjustified: string[] = [];
        for (const name of catalogue.events) {
          const entry = manifest.events[name];
          if (entry === undefined) {
            unclassified.push(name);
            continue;
          }
          if (!VALID_STATUSES.has(entry.status)) {
            unjustified.push(`${name}: unknown status ${JSON.stringify(entry.status)}`);
            continue;
          }
          const owed = REQUIRED_PROSE[entry.status];
          const prose = owed === undefined ? undefined : entry[owed];
          if (typeof prose !== "string" || prose.trim() === "") {
            unjustified.push(`${name}: status "${entry.status}" requires \`${owed}\``);
          }
        }
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
        // Three separate corrections rotted while the tallies were prose in a `$comment`
        // and in the lot note — each time, a `str.replace` that matched nothing and said
        // nothing (review passes 4, 5 and 6). A number nobody recomputes is a claim, and
        // this file exists to stop claims from outliving their truth.
        const c = manifest.counts;
        const by = (s: string): number =>
          Object.values(manifest.events).filter((e) => e.status === s).length;
        expect(c, "the manifest must publish its tallies").toBeDefined();
        expect(c).toEqual({
          total: Object.keys(manifest.events).length,
          handled: by("handled"),
          gap: by("gap"),
          ignored: by("ignored"),
        });
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
