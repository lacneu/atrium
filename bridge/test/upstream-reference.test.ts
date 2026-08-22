/**
 * The upstream reference tag is ONE version, and it is the version we promise (G3).
 *
 * Three artefacts each name an upstream tag, and until now nothing tied them
 * together:
 *  - `bridge/src/compat.ts` — `maxValidated`, the version Atrium claims to support;
 *  - `test/fixtures/openclaw_upstream_frames.json` — `upstream_tag`, the tag whose
 *    own unit tests the replayed wire shapes were extracted from;
 *  - `docs/UPSTREAM_INTERPRETATION.md` — the tag the whole
 *    comparison was written against.
 *
 * Raising `maxValidated` without re-extracting the fixtures leaves the bridge
 * validated against shapes from an OLDER gateway while asserting it matches the
 * newer one — the interpretation contract silently stops being checked. The
 * upstream-diff script reports a moved contract, but the report is advisory and
 * lives outside this repo; the enforcement has to be here, where the version bump
 * happens. That is exactly the gap recorded as G-73 ("the signal was emitted, then
 * ignored").
 *
 * This is the whole gate: bump the ceiling, go red, re-extract and update the doc.
 *
 * DECIDED LIMIT, stated so it cannot be mistaken for more. This catches a ceiling
 * raised WITHOUT NOTICING that the fixtures and the document exist — the failure that
 * actually happened. It cannot prove the scenarios were genuinely re-extracted:
 * someone who edits the two tag strings and leaves the old shapes in place passes it.
 * Proving re-extraction needs the upstream tag, and CI deliberately does not clone
 * another organisation's GitHub on every PR (decided in lot 14). A checked-in
 * "I ran the diff" artefact would not fix it either — it is one more string to type.
 * The mechanical proof lives where the tag IS available: run
 * `openclaw-notes/atrium/live-bench/upstream-diff.sh`, which exits non-zero when a
 * contract moved.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { promisedVersion } from "./helpers/vendored.js";

const FIXTURE = new URL("./fixtures/openclaw_upstream_frames.json", import.meta.url);
const DOC = new URL(
  "../../docs/UPSTREAM_INTERPRETATION.md",
  import.meta.url,
);

/** `v2026.7.1` → `2026.7.1`. The two sources spell the same tag differently, and a
 *  substring comparison would accept `v2026.7.10` as a match for `2026.7.1`. */
function bare(tag: string): string {
  return tag.replace(/^v/, "");
}

describe("the upstream reference tag (G3)", () => {
  const promised = promisedVersion();

  it("the replayed frames were extracted from the version we promise", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8")) as {
      upstream_tag?: string;
    };
    expect(
      typeof fixture.upstream_tag,
      "the fixture must SAY which tag it came from",
    ).toBe("string");
    expect(
      bare(fixture.upstream_tag!),
      `openclaw_upstream_frames.json holds shapes from ${fixture.upstream_tag}, but ` +
        `compat.ts promises ${promised}. Re-extract the scenarios from the new tag ` +
        `(the upstream test file:line is cited per scenario) before raising the ` +
        `ceiling — otherwise the interpretation contracts are pinned to a gateway ` +
        `we no longer claim to support.`,
    ).toBe(promised);
  });

  it("the comparison document was written against that same version", () => {
    const doc = readFileSync(DOC, "utf-8");
    // The doc states its reference tag in prose. Anchored on the sentence, and the
    // assertion is that it MATCHED — a reworded heading must fail loudly rather than
    // disarm the gate by matching nothing.
    const m = doc.match(
      /Reference source: `github\.com\/openclaw\/openclaw` at tag \*\*`(v[0-9][^`]*)`\*\*/,
    );
    expect(
      m,
      "upstream-interpretation-comparison.md no longer declares its reference tag in " +
        "the expected sentence — restore it, or this gate checks nothing.",
    ).not.toBeNull();
    expect(
      bare(m![1]!),
      `the comparison document is written against ${m![1]}, but compat.ts promises ` +
        `${promised}. Re-run the upstream diff, re-run the changed zones, and update ` +
        `the document before raising the ceiling.`,
    ).toBe(promised);
  });

  it("does not describe the drift detector as lagging when it does not", () => {
    // A doc turned load-bearing by the two tests above must not carry claims that
    // have quietly become false. This one had: it still described the runtime drift
    // detector as vendored at 2026.6.11 long after it moved to the ceiling, which is
    // the kind of stale reassurance that makes a reader dismiss a REAL warning.
    const doc = readFileSync(DOC, "utf-8");
    const drift = readFileSync(
      new URL("../src/providers/openclaw/protocol-drift.ts", import.meta.url),
      "utf-8",
    ).match(/DRIFT_VENDORED_VERSION\s*=\s*"([^"]+)"/);
    expect(drift, "DRIFT_VENDORED_VERSION is no longer a literal").not.toBeNull();
    // The doc says "No internal offset", so the CODE must have none either.
    // Comparing only doc-to-code would let both slide back to an older version
    // together while the sentence claiming there is no gap stays on screen — the
    // guard would then be measuring self-consistency, not the fact it names.
    expect(
      drift![1],
      `the drift detector vendors ${drift![1]} while the bridge promises ${promised}: ` +
        `unknown-field warnings against a ${promised} gateway would be schema ` +
        `staleness, and the comparison document says there is no such offset. Either ` +
        `re-vendor the detector or stop claiming the gap is closed.`,
    ).toBe(promised);
    // Whitespace-NORMALISED: the doc wraps its prose, and the first version of this
    // regex sat across a line break and matched nothing — the test passed while the
    // claim it was written to catch was false on screen.
    const flat = doc.replace(/\s+/g, " ");
    const stale = [...flat.matchAll(/vendors its schema at `([^`]+)`/g)].map(
      (x) => x[1]!,
    );
    expect(
      stale.length,
      "the document no longer states which version the drift detector vendors — " +
        "restore the claim or this check is vacuous",
    ).toBeGreaterThan(0);
    for (const claimed of stale) {
      expect(
        claimed,
        `the document says the drift detector vendors ${claimed}; the code says ` +
          `${drift![1]}.`,
      ).toBe(drift![1]);
    }
  });
});
