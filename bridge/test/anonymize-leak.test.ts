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

const { anonymizeFrame, createPseudonymiser, knownKeysFromCoverage, readerVocabulary, declaredObjectKeys } =
  anon as {
    anonymizeFrame: (...a: unknown[]) => unknown;
    createPseudonymiser: (l?: unknown[], r?: Map<string, string>) => unknown;
    knownKeysFromCoverage: (c: unknown, s?: string[]) => Set<string>;
    readerVocabulary: () => Set<string>;
    declaredObjectKeys: () => Set<string>;
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

/** DERIVED from the source — `declaredObjectKeys()` hands back a copy — never a
 *  hand-written mirror. This file first carried one and
 *  it had already drifted when a review read the two side by side: the mirror was missing
 *  `job`, so the one key the mirror existed to skip was being swept as if undeclared. A
 *  mirror of a list whose whole purpose is to be short and reviewed is a second source of
 *  truth that nothing compares. */
const DECLARED = declaredObjectKeys();

const SHAPE: Record<string, (k: string) => unknown> = {
  plainString: (k) => ({ [k]: SECRET }),
  subObject: (k) => ({ [k]: { status: SECRET } }),
  arrayOfObjects: (k) => ({ [k]: [{ status: SECRET }] }),
  arrayOfScalars: (k) => ({ [k]: [SECRET] }),
  nestedTwice: (k) => ({ [k]: { inner: { status: SECRET } } }),
};

/** The walker has TWO vocabularies for `payload.data`, and a sweep that only probes one
 *  measures half the surface: `stream:"plan"` unions `readerKeys` in.
 *
 *  Probing both streams over the SAME key set was not enough, and a review caught why:
 *  the domain came from the coverage manifest alone, so the two keys that live only in
 *  the reader vocabulary (`explanation`, `job`) were never probed at all. Of those, only
 *  `explanation` is what the plan union exists to CARRY; `job` is reader vocabulary for
 *  the cron result and is unprobed for the same reason. The `plan` sweep therefore runs
 *  over the UNION, and the assertions below refuse a future narrowing of that domain. */
const STREAMS = ["lifecycle", "plan"] as const;

function sweepKeys(stream: (typeof STREAMS)[number], base: Set<string>): Set<string> {
  return stream === "plan" ? new Set([...base, ...readerVocabulary()]) : base;
}

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
        for (const k of sweepKeys(stream, keys)) {
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

  it("the reader vocabulary CARRIES what the plan and cron cards are built from", () => {
    // The behavioural invariant, stated on its own. A review pointed out that the delta
    // assertion below couples it with a second, unrelated claim about one manifest, so a
    // future manifest declaring `explanation` would redden a test about the walker.
    // `explanation` builds the plan card (core/plan-part.ts), `job` the cron card
    // (core/cron-part.ts); neither is a protocol field, which is why the union exists.
    const reader = readerVocabulary();
    expect(reader.has("explanation")).toBe(true);
    expect(reader.has("job")).toBe(true);
    // `title` is NOT asserted either way here, and the reason is worth keeping. A stale
    // comment called it a plan-card leaf; it is not (`planPartFromPlanStream` reads
    // `explanation` and the steps, nothing else), and a first correction pinned
    // `reader.has("title") === false` on that basis. That pin was WRONG at a wider scope:
    // the provenance reader does read `items[].title` (core/provenance.ts:91), and since
    // `items` is not a declared container its objects are walked with `readerVocabulary()`
    // alone — where `title` is absent. Pinning its absence would have blocked that repair.
    // The provenance fidelity gap is filed as its own lot; this assertion stays silent on
    // it rather than taking a side it cannot prove.
  });

  it("…and for THIS corpus they are exactly the part the manifest misses", () => {
    // An attestation about 2026.9.4, not about the walker. A red here means the vendored
    // manifest changed what it declares — a corpus review event, not a regression. The
    // assertion above is the one that guards behaviour.
    const known = realVocabulary();
    expect([...readerVocabulary()].filter((k) => !known.has(k)).sort()).toEqual([
      "explanation",
      "job",
    ]);
    // The self-referential loop that stood here is gone: it rebuilt the domain from
    // `readerVocabulary()` and then checked that same value was in it — always true.
    // BOTH, not just one: a `sweepKeys` that unioned `explanation` and dropped `job`
    // left all nine tests green (raised in review).
    for (const k of ["explanation", "job"]) {
      expect(sweepKeys("plan", known).has(k), k).toBe(true);
    }
  });

  it("EXACTLY these object shapes are declared — adding one is a review event", () => {
    // The sweep SKIPS declared keys, by design: a declared container keeps the full
    // vocabulary one level deeper, which is what `{job:{status:…}}` publishing a value
    // means. So an addition to that list widens the surface in a way no other assertion
    // in this file can see — `job` was measured: declared, `{job:{status:SECRET}}` comes
    // out verbatim; undeclared, it comes out masked. The list is therefore spelled out
    // here, exactly as the 28 publishing keys are, so the "review event" the source
    // comment promises is enforced instead of hoped for.
    expect([...DECLARED].sort()).toEqual([
      "agentRuntime", "agents", "content", "contextBudgetStatus", "data", "delivery",
      "expandedParticipants", "frame", "identity", "job", "message", "model", "models",
      "participants", "payload", "plan", "plugins", "providers", "retry", "schedule",
      "session", "state", "stateVersion", "steps", "task", "thinkingLevels",
    ]);
  });

  it("the sweep is not vacuous — the same secret DOES survive where the rule allows it", () => {
    // `status` is protocol vocabulary, so a value under it is published by design. If
    // this ever went RED, the probe would have stopped reaching the rule at all and the
    // test above would be measuring nothing.
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
      const publishing = [...sweepKeys(stream, keys)]
        .filter((k) => leaks(SHAPE.plainString!, k, keys, stream))
        .sort();
      expect(publishing, `stream=${stream}`).toEqual([...PUBLISHING].sort());
    }
  });
});

describe("the declared list is handed out as a COPY", () => {
  it("mutating what `declaredObjectKeys()` returns cannot reach the walker", () => {
    // `return DECLARED_OBJECT_KEYS` instead of `new Set(...)` left every assertion in this
    // file green, because nothing here mutated the value it got back. The export exists to
    // deny a consumer a `.delete("job")` that silently changes a masking decision, so that
    // denial is what gets tested.
    const first = declaredObjectKeys();
    first.delete("job");
    expect(declaredObjectKeys().has("job")).toBe(true);
    expect(DECLARED.has("job")).toBe(true);
  });
});

// THE REASON THE `plan` UNION EXISTS, PINNED.
//
// `planPartFromPlanStream` (core/plan-part.ts:78) builds the card from `explanation` and
// the step leaves. Of those, ONLY `explanation` needs the union: `step`, `steps` and
// `status` are protocol fields and the manifest already names them (measured on
// 2026.9.4). `explanation` is not, so walked with the manifest vocabulary alone it was
// masked AS A KEY and a promoted plan card silently lost it. The union fixed that;
// nothing asserted the fix, and the two sweeps above cannot: they prove a secret does NOT
// survive, and this is a case where a KEY must.
describe("a promoted plan card keeps its shape and loses its text", () => {
  it("`explanation` survives as a key on the plan stream, its content masked", () => {
    const keys = realVocabulary();
    const stats = { frames: 0, verbatim: 0, pseudonymised: 0, masked: 0 };
    const out = anonymizeFrame(
      {
        event: "agent",
        payload: {
          stream: "plan",
          data: {
            kind: "plan",
            explanation: `${SECRET} needs a second opinion`,
            steps: [{ step: `call ${SECRET}`, status: "pending" }],
          },
        },
      },
      createPseudonymiser([], new Map()),
      stats,
      keys,
      new Set(),
      0,
      new Map(),
    ) as { payload: { data: Record<string, unknown> } };

    const data = out.payload.data;
    // The READER's field names are intact — this is what the fidelity gate went red on.
    expect(Object.keys(data)).toEqual(["kind", "explanation", "steps"]);
    expect(Object.keys((data.steps as Record<string, unknown>[])[0]!)).toEqual([
      "step",
      "status",
    ]);
    // `status` is protocol vocabulary, so the step's state is published by design.
    expect((data.steps as Record<string, unknown>[])[0]!.status).toBe("pending");
    // The prose is not — and the MASK is asserted, not merely the secret's absence. A
    // review pointed out that `not.toContain(SECRET)` also passes on `""`, `null` or a
    // dropped value: that is not a leak, but it is not fidelity either, and this fixture
    // is the one that proves a promoted plan card still reads like a plan card.
    expect(data.explanation).toBe("XxxxxXxxxxx xxxxx x xxxxxx xxxxxxx");
    expect((data.steps as Record<string, unknown>[])[0]!.step).toBe("xxxx XxxxxXxxxxx");
    expect(JSON.stringify(data)).not.toContain(SECRET);
  });

  it("…and the same KEY on another stream is masked, key and value", () => {
    // Proves the union is load-bearing: `explanation` is reader-only vocabulary, so
    // outside the plan node the key does not survive. Delete the union and the test
    // above fails while this one still passes.
    const keys = realVocabulary();
    const stats = { frames: 0, verbatim: 0, pseudonymised: 0, masked: 0 };
    const out = anonymizeFrame(
      { event: "agent", payload: { stream: "lifecycle", data: { explanation: SECRET } } },
      createPseudonymiser([], new Map()),
      stats,
      keys,
      new Set(),
      0,
      new Map(),
    ) as { payload: { data: Record<string, unknown> } };
    // Pinned EXACTLY, not merely "the key is absent": a walker that returned `{}` — or
    // dropped the node entirely — satisfied the absence check while proving nothing
    // (raised in review). The key is masked AND so is its value.
    expect(out.payload.data).toEqual({ xxxxxxxxxxx: "XxxxxXxxxxx" });
  });
});

// A PSEUDONYM THAT EQUALS ITS INPUT PUBLISHES IT.
//
// The minter numbered pseudonyms `id1`, `id2`, … and never compared a candidate with the
// token it was replacing, so `identifier("id1")` returned `"id1"`: the value came out
// verbatim while the run COUNTED it as pseudonymised — the one outcome the file's "no
// value survives" rule forbids, and invisible in the stats for exactly that reason. The
// same held for a value already shaped like the first minted UUID. Reachable on purpose:
// an agent, a chat or a tool may be named `id1`.
describe("a MINTED pseudonym is never its own input", () => {
  // Scoped deliberately. `identifier()` has identities that are CORRECT and stay:
  // a built-in tool name (`exec`) is published on purpose so a red snapshot stays
  // diagnosable, and an empty or separator-only token has nothing to mint. What must
  // never happen is a minted pseudonym — an `id<n>`, a UUID, a tool alias — coming out
  // equal to the value it replaced. (`stats.pseudonymised` counts the deliberate
  // identities too; that is a label on a counter, not a value that escaped.)
  const pseudonymiser = () =>
    createPseudonymiser([], new Map()) as { identifier: (v: string) => string };

  it("does not hand back the token it was asked to replace", () => {
    expect(pseudonymiser().identifier("id1")).not.toBe("id1");
    expect(pseudonymiser().identifier("00000000-0000-4000-8000-000000000001")).not.toBe(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("stays injective and stable when it skips a candidate", () => {
    // The COLLIDING token must come FIRST. A review showed the earlier sequence
    // (`abc` then `id1`) never skipped at all — by the time `id1` arrived its candidate
    // was already `id2` — so the guard against re-issuing a skipped pseudonym was never
    // exercised and could be deleted with this test still green.
    //
    // Here `id1` collides immediately and is pushed to `id2`; `abc` then starts from
    // `id2` and must be pushed off it in turn. Without that guard both come out `id2`.
    const p = pseudonymiser();
    const got = ["id1", "abc", "id1", "abc"].map((t) => p.identifier(t));
    expect(got).toEqual(["id2", "id3", "id2", "id3"]);
  });

  it("refuses a tool alias that is the tool's own name", () => {
    // The same fixed point in the OTHER pseudonym space: the walker returns the alias
    // verbatim for `toolName`/`data.name`, so `tool_1 -> tool_1` republished the name.
    expect(() => createPseudonymiser([], new Map([["tool_1", "tool_1"]]))).toThrow(
      /alias for "tool_1" is the name itself/,
    );
    expect(() => createPseudonymiser([], new Map([["acme", "tool_1"]]))).not.toThrow();
  });
});
