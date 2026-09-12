// WHAT THE INVERSION CLOSES — AND WHAT IT DELIBERATELY DOES NOT.
//
// The anonymiser kept a `VOCABULARY_KEYS` value verbatim wherever its key appeared, at
// any depth, as long as the ancestors were "known". So user text placed under ANY known
// key survived: `{"<knownKey>":{"status":"<a sentence>"}}` came out intact with
// `masked: 0`. An adversarial review demonstrated it on `lifecycle.data.error`
// (2026-09-12); a sweep over the real vocabulary then measured the true extent —
// **586 of 594 keys**. Patching the demonstrated case would have left 585.
//
// The rule now: an OBJECT under a known key is FREE-FORM unless its shape is declared
// (`DECLARED_OBJECT_KEYS`). This test sweeps the WHOLE vocabulary so a future key, or a
// future entry in that list, cannot re-open the hole quietly.
//
// It uses `knownKeysFromCoverage` deliberately: the same probe against `baseKnownKeys()`
// returns a reassuring zero, because that set is far narrower than the one the promoter
// actually passes. Testing this in the wrong configuration is how the first fix was
// declared complete when it was not.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- untyped .mjs
import * as anon from "../scripts/lib/anonymize-capture.mjs";

const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "2026.9.4";

const { anonymizeFrame, createPseudonymiser, knownKeysFromCoverage } = anon as {
  anonymizeFrame: (...a: unknown[]) => unknown;
  createPseudonymiser: (l?: unknown[], r?: Map<string, string>) => unknown;
  knownKeysFromCoverage: (c: unknown, s?: string[]) => Set<string>;
};

function realVocabulary(): Set<string> {
  const coverage = JSON.parse(
    readFileSync(join(BRIDGE, `protocol/openclaw/coverage/${VERSION}.json`), "utf8"),
  );
  const snapRaw = JSON.parse(
    readFileSync(join(BRIDGE, `protocol/openclaw/${VERSION}/session-event-snapshot.json`), "utf8"),
  );
  const snapshot: string[] = Array.isArray(snapRaw)
    ? snapRaw
    : (snapRaw.fields ?? Object.keys(snapRaw));
  return knownKeysFromCoverage(coverage, snapshot);
}

/** Place a secret under `<key>` in one of the shapes a frame can take.
 *
 *  The secret is TOKEN-SHAPED on purpose. An earlier version of this file used
 *  "Alice has cancer", and an adversarial review showed the sweep was then practically
 *  vacuous: the sentence has spaces, so it failed the value-shape guard of the day for
 *  EVERY key, and the test would have stayed green with the whole inversion deleted. A
 *  test whose subject cannot survive the rule it is meant to exercise proves nothing. */
const SECRET = "AliceMartin";

/** Mirror of DECLARED_OBJECT_KEYS — the keys whose object shape the contract declares
 *  and which therefore keep the full vocabulary one level deeper. */
const DECLARED = new Set([
  "agentRuntime", "agents", "content", "contextBudgetStatus", "data", "delivery",
  "expandedParticipants", "frame", "identity", "message", "model", "models",
  "participants", "payload", "plan", "plugins", "providers", "retry", "schedule",
  "session", "state", "stateVersion", "steps", "task", "thinkingLevels",
]);

const SHAPE: Record<string, (k: string) => unknown> = {
  plainString: (k) => ({ [k]: SECRET }),
  subObject: (k) => ({ [k]: { status: SECRET } }),
  arrayOfObjects: (k) => ({ [k]: [{ status: SECRET }] }),
  arrayOfScalars: (k) => ({ [k]: [SECRET] }),
  nestedTwice: (k) => ({ [k]: { inner: { status: SECRET } } }),
};

/** The walker has TWO vocabularies for `payload.data`, and a sweep that only probes one
 *  measures half the surface: `stream:"plan"` unions `readerKeys` in, so a key reachable
 *  only there (`job`) was invisible to this file until an adversarial review said so. */
const STREAMS = ["lifecycle", "plan"] as const;

function leaks(
  build: (k: string) => unknown,
  key: string,
  keys: Set<string>,
  stream: (typeof STREAMS)[number] = "lifecycle",
): boolean {
  const stats = { frames: 0, verbatim: 0, pseudonymised: 0, masked: 0 };
  const out = anonymizeFrame(
    { event: "agent", payload: { stream, data: build(key) } },
    createPseudonymiser([], new Map()),
    stats,
    keys,
    new Set(),
    0,
    new Map(),
  );
  return JSON.stringify(out).includes(SECRET);
}

describe("an object under an UNDECLARED key is free-form — the inversion", () => {
  it("no undeclared key publishes a secret nested inside an object", () => {
    const keys = realVocabulary();
    const offenders: string[] = [];
    for (const stream of STREAMS) {
      // `plainString` and `arrayOfScalars` put the secret DIRECTLY under the key, which
      // is the separate known hole pinned below — not what the inversion governs. The
      // inversion's job is the CONTAINER: a secret nested inside an object under an
      // undeclared key must not survive.
      const nested = ["subObject", "arrayOfObjects", "nestedTwice"] as const;
      for (const shapeName of nested) {
        const build = SHAPE[shapeName]!;
        for (const k of keys) {
          if (DECLARED.has(k)) continue;
          if (leaks(build, k, keys, stream)) offenders.push(`${k} (${shapeName}, ${stream})`);
        }
      }
    }
    offenders.sort();
    // Before the inversion this listed 586 keys. The subject is token-shaped, so a
    // green here means the KEY rule did the work — not the value's punctuation.
    expect(offenders).toEqual([]);
  });

  it("the sweep is not vacuous — the same secret DOES survive where the rule allows it", () => {
    // `status` is protocol vocabulary, so a value under it is published by design. If
    // this ever went green, the probe would have stopped reaching the rule at all and
    // the test above would be measuring nothing.
    const keys = realVocabulary();
    expect(leaks(SHAPE.plainString!, "status", keys)).toBe(true);
  });
});

// THE HOLE THAT REMAINS, PINNED SO IT CANNOT WIDEN QUIETLY.
//
// `VOCABULARY_KEYS` names a POSITION in the contract; this walker only knows names, so a
// value under one of those 28 names is published wherever it sits — including numbers
// and scalars. A value-SHAPE guard was tried on 2026-09-12 and reverted: too permissive
// (`Alice`, `PATIENT-12345`, `sk-proj-…` are all valid tokens) and too strict (it masked
// `image/svg+xml` and `ollama/llama3.1:8b`, which the bridge reads, with nothing able to
// detect the loss). The sound fix validates against the vendored schema and is its own
// lot. Until then this records the EXTENT, so widening it fails here.
describe("the remaining hole is bounded and NAMED", () => {
  // 28 keys publish a token-shaped value wherever it sits, because `VOCABULARY_KEYS`
  // names a POSITION in the contract and this walker only knows names. Bounding the
  // COUNT was not enough — an adversarial review pointed out that swapping one key for
  // another, or adding a 29th, left the assertion green. The list is spelled out so any
  // change to it is a review event, and so the extent is legible without running a probe.
  const PUBLISHING = [
    "channel", "chatType", "contentType", "elevatedLevel", "errorKind", "event", "kind",
    "mime", "mimeType", "model", "modelProvider", "operation", "origin", "phase",
    "provider", "reasoningLevel", "role", "sendPolicy", "state", "status", "stopReason",
    "stream", "subagentControlScope", "subagentRole", "thinkingLevel", "traceLevel",
    "type", "verboseLevel",
  ];

  it("EXACTLY these keys publish a value, in every stream context", () => {
    const keys = realVocabulary();
    for (const stream of STREAMS) {
      const publishing = [...keys]
        .filter((k) => leaks(SHAPE.plainString!, k, keys, stream))
        .sort();
      expect(publishing, `stream=${stream}`).toEqual([...PUBLISHING].sort());
    }
  });
});
