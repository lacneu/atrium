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
import { asyncTaskStartFromTool, taskChildKey } from "../src/core/async-task.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
// @ts-expect-error -- untyped .mjs
import { consumedReadings } from "../scripts/lib/replay-fidelity.mjs";
import { cronPartFromTool, isCronTool, printableCronSchedule } from "../src/core/cron-part.js";
import { MAX_PROVENANCE_ITEMS, isProvenanceStream, parseProvenanceReport } from "../src/core/provenance.js";

const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "2026.9.4";

const {
  anonymizeFrame,
  createPseudonymiser,
  knownKeysFromCoverage,
  readerVocabulary,
  declaredObjectKeys,
  provenanceVocabulary,
  captureReaderRules,
} = anon as {
  anonymizeFrame: (...a: unknown[]) => unknown;
  createPseudonymiser: (l?: unknown[], r?: Map<string, string>) => unknown;
  knownKeysFromCoverage: (c: unknown, s?: string[]) => Set<string>;
  readerVocabulary: () => Set<string>;
  declaredObjectKeys: () => Set<string>;
  provenanceVocabulary: () => Set<string>;
  captureReaderRules: (entries: unknown[], readers: unknown, consumed: unknown) => unknown;
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
    // alone — where `title` is absent. Pinning its absence would have blocked that repair,
    // which is the provenance domain (defect 13): `title` is carried inside a provenance
    // report and nowhere else, and is still not in `readerVocabulary()`.
  });

  it("…and for THIS corpus they are exactly the part the manifest misses", () => {
    // An attestation about 2026.9.4, not about the walker. A red here means the vendored
    // manifest changed what it declares — a corpus review event, not a regression. The
    // assertion above is the one that guards behaviour.
    const known = realVocabulary();
    // Defect 13 added the cron SCHEDULE leaves and `detail` (the lifecycle error object);
    // `timeoutMs`, `error`, `reason` and `code` joined the reader vocabulary too, but 2026.9.4
    // already names them, so they do not appear here.
    expect([...readerVocabulary()].filter((k) => !known.has(k)).sort()).toEqual([
      "at", "atMs", "cron", "detail", "every", "everyMs", "explanation", "expr", "job", "tz",
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

// ── Defect 13: what the provenance, cron and task readers consume survives promotion ──
describe("a promoted capture still READS the same — provenance, cron schedule, task bound", () => {
  // The bridge's OWN readers decide which reader-consumed values survive — the promoter hands
  // in the built ones, this suite the sources.
  const READERS = {
    isProvenanceStream, parseProvenanceReport, MAX_PROVENANCE_ITEMS, asyncTaskStartFromTool,
    isCronTool, cronPartFromTool, printableCronSchedule, taskChildKey,
  };
  type Promoted = { payload: { data: Record<string, unknown> } };
  /** A capture of these frames, promoted as `promoteSlice` does: one pseudonymiser, the rules
   *  only the whole capture decides computed over the same objects, and — deciding every kept
   *  value — what the REAL reading stack consumes when the frames are replayed in a turn acked
   *  for their run (`consumedReadings`, the fidelity gate's own replay). */
  const promoteFrames = async (frames: unknown[], toolNames: string[] = [], readers: unknown = READERS): Promise<Promoted[]> => {
    const entries = [
      { receivedAt: 0, frame: { type: "res", payload: { runId: "webchat-r1" } } },
      ...frames.map((frame, i) => ({ receivedAt: 10 + i, frame })),
    ];
    const consumed = await consumedReadings(RunManager, entries, readers);
    const pseudo = createPseudonymiser([], new Map());
    const shared = captureReaderRules(entries, readers, consumed);
    return frames.map(
      (frame) =>
        anonymizeFrame(
          frame,
          pseudo,
          { frames: 0, verbatim: 0, pseudonymised: 0, masked: 0, maskedKeys: 0 },
          realVocabulary(),
          new Set(toolNames),
          null,
          new Map(),
          readers,
          shared,
          consumed,
        ) as Promoted,
    );
  };
  const promote = async (frame: unknown, toolNames: string[] = [], readers: unknown = READERS): Promise<Promoted> =>
    (await promoteFrames([frame], toolNames, readers))[0]!;
  /** A cron tool frame, in its wire form. */
  const cronFrame = (phase: string, extra: Record<string, unknown>) =>
    agent("tool", { name: "automations", phase, toolCallId: "c1", ...extra });
  const agent = (stream: string, data: unknown) => ({
    type: "event",
    event: "agent",
    payload: { runId: "webchat-r1", sessionKey: "agent:a:atrium:chat:u:c", stream, data },
  });
  // Every value a reader must NOT publish carries one of these tokens.
  const SECRETS = ["Martin", "alice", "olivier", "patients", "2026-06-01", "Europe", "Paris", "30 9"];
  const DOCUMENTS = {
    v: 1, source: "knowledge", kind: "documents", pluginId: "martin-rag", pluginName: "Martin Plugin",
    injected: { chars: 1300, position: "system_append", truncated: true },
    retrieval: { route: "pgvector", collections: ["patients_martin"], lightrag: { mode: "mix" } },
    items: [
      { file_name: "Dossier-Martin.pdf", title: "Dossier Martin", collection: "patients_martin", score: 0.93, text: "Martin: diabete" },
      { text: "Synthese Martin", context: true },
    ],
  };
  const MEMORY = {
    v: 1, source: "hindsight", kind: "memory", pluginId: "hindsight-openclaw",
    retrieval: { route: "recall", bank: "alice::direct%3Aolivier::olivier" },
    items: [{ id: "mem_martin_1", type: "observation", date: "2026-06-01", score: 0.8, text: "Martin prefers mornings" }],
  };
  /** The report as the reader sees it — its shape and control values, never its text. */
  const shape = (p: ReturnType<typeof parseProvenanceReport>) =>
    p === null
      ? null
      : {
          v: p.v,
          group: p.group,
          fields: Object.keys(p).sort(),
          items: p.items.map((i) => ({ keys: Object.keys(i).sort(), context: i.context === true })),
          injected: p.injected === undefined ? null : { keys: Object.keys(p.injected).sort(), truncated: p.injected.truncated },
          retrieval: p.retrieval === undefined ? null : Object.keys(p.retrieval).sort(),
        };

  it("a documents and a memory report read back with the same shape, and publish none of their content", async () => {
    for (const report of [DOCUMENTS, MEMORY]) {
      const raw = parseProvenanceReport({ ...report });
      expect(raw, "the raw report is valid").not.toBeNull();
      const out = (await promote(agent("martin-rag.provenance", report)));
      expect(shape(parseProvenanceReport(out.payload.data)), report.kind).toEqual(shape(raw));
      const text = JSON.stringify(out);
      for (const secret of SECRETS) expect(text, `${report.kind}: ${secret}`).not.toContain(secret);
    }
  });

  it("the report vocabulary applies to the report ALONE — the same payload on another stream stays masked", async () => {
    const out = (await promote(agent("lifecycle", DOCUMENTS)));
    const data = out.payload.data;
    expect(parseProvenanceReport(data), "not a report outside its stream").toBeNull();
    expect(Object.keys(data)).not.toContain("injected");
    expect(JSON.stringify(data)).not.toContain("file_name");
  });

  it("a report the reader would refuse is no report — a version other than 1 keeps nothing", async () => {
    const out = (await promote(agent("martin-rag.provenance", { ...DOCUMENTS, v: 7 })));
    expect(out.payload.data.v, "`v` is no protocol key outside a recognised report").toBeUndefined();
    expect(parseProvenanceReport(out.payload.data)).toBeNull();
  });

  it("an INVALID report keeps none of its booleans — no reader consumes them", async () => {
    // No pluginId: parseProvenanceReport refuses it, so bits kept here would be bits nobody
    // reads, and the fidelity gate (both sides refused) could never see them (codex).
    const { pluginId: _omitted, ...invalid } = DOCUMENTS;
    const out = (await promote(agent("martin-rag.provenance", { ...invalid, items: [{ context: true }, { context: false }] })));
    expect(JSON.stringify(out)).not.toContain("true");
  });

  it("JSON inside an item's TEXT is content, not a report — nothing in it is published", async () => {
    const text = JSON.stringify({ context: true, truncated: false, timeoutMs: 12_345_678, v: 1 });
    const out = (await promote(agent("martin-rag.provenance", { ...DOCUMENTS, injected: undefined, items: [{ text }] })));
    const json = JSON.stringify(out);
    expect(json).not.toContain("true");
    expect(json).not.toContain("12345678");
    expect(parseProvenanceReport(out.payload.data)?.items[0]?.context).toBeUndefined();
  });

  it("EVERY provenance position publishes only what its reader consumes — strings, numbers, booleans", async () => {
    // A sweep by value TYPE, per node: the string SECRET, an unmistakable number, `true`.
    // Only `items[].context` and `injected.truncated` may keep a boolean, only the report's
    // `v` a number (fixed at 1). Excluded: the probes that make the frame NO REPORT (a `v`
    // other than 1, a `kind` other than memory/documents, a non-string pluginId/source, a
    // non-array items). The reader refuses such a frame, no provenance rule applies, and it is
    // an ordinary `data` walk — whose values under protocol keys (`kind` is VOCABULARY_KEYS,
    // `pluginId`/`source` are in the 2026.9.4 vocabulary) are the pre-existing positional hole
    // pinned by "the remaining hole is bounded and NAMED", not this rule.
    const derecognises = (where: string, key: string, probe: unknown) =>
      where === "report" &&
      (key === "v" ||
        key === "kind" ||
        key === "items" ||
        ((key === "pluginId" || key === "source") && typeof probe !== "string"));
    const NUMBER = 98_765_432;
    const base = () => ({
      v: 1, pluginId: "p", source: "s", kind: "documents",
      items: [{ file_name: "f" }], injected: { position: "p" }, retrieval: { lightrag: { mode: "m" } },
    });
    type Base = ReturnType<typeof base>;
    const positions: Array<[string, (b: Base) => Record<string, unknown>]> = [
      ["report", (b) => b],
      ["item", (b) => b.items[0]!],
      ["injected", (b) => b.injected],
      ["retrieval", (b) => b.retrieval],
      ["lightrag", (b) => b.retrieval.lightrag],
    ];
    const booleanAllowed = new Set(["item.context", "injected.truncated"]);
    for (const [where, at] of positions) {
      for (const key of provenanceVocabulary()) {
        // `on-exit` stands for the values a control-value allowlist could publish.
        for (const probe of [SECRET, NUMBER, true, "on-exit"] as const) {
          if (derecognises(where, key, probe)) continue;
          const report = base();
          at(report)[key] = probe;
          const json = JSON.stringify((await promote(agent("p.provenance", report))));
          const label = `${where}.${key} = ${String(probe)}`;
          if (probe === true) {
            expect(json.includes("true"), label).toBe(booleanAllowed.has(`${where}.${key}`));
          } else {
            expect(json, label).not.toContain(String(probe));
          }
        }
      }
    }
  });

  it("a cron card still prints the schedule BRANCH it was given, its values masked", async () => {
    const schedule = { kind: "cron", expr: "30 9 * * 1", tz: "Europe/Paris" };
    const data = {
      name: "automations",
      phase: "result",
      toolCallId: "c1",
      args: { action: "add", job: { name: "martin", schedule, payload: { kind: "agentTurn", message: "hi" } } },
      result: { details: { id: "j1", name: "martin", schedule } },
    };
    const raw = cronPartFromTool("automations", "completed", data.args, data.result);
    expect(raw?.schedule).toBe("cron 30 9 * * 1 (Europe/Paris)");
    const out = (await promote(agent("tool", data), ["automations"])).payload.data;
    const promoted = cronPartFromTool("automations", "completed", out.args, out.result);
    expect(promoted?.schedule).toMatch(/^cron \S.* \(.+\)$/);
    for (const secret of SECRETS) expect(JSON.stringify(out), secret).not.toContain(secret);
  });

  it("the schedule kinds printed BARE by the card (`on-exit`, `stream`) survive as themselves", async () => {
    for (const schedule of [
      { kind: "on-exit", command: "make Martin" },
      { kind: "stream", command: ["tail", "-f", "Martin.log"], mode: "line" },
    ]) {
      const data = { name: "automations", phase: "result", toolCallId: "c1", args: { action: "add", job: { name: "n", schedule } }, result: { details: { id: "j1", name: "n", schedule } } };
      const out = (await promote(agent("tool", data), ["automations"])).payload.data;
      expect(cronPartFromTool("automations", "completed", out.args, out.result)?.schedule).toBe(schedule.kind);
      expect(JSON.stringify(out)).not.toContain("Martin");
    }
  });

  it("a timeoutMs anywhere but a real async task's details is masked like any number", async () => {
    const secret = 12_345_678;
    const cases = [
      agent("lifecycle", { phase: "error", blob: { timeoutMs: secret } }),
      agent("tool", { name: "exec", phase: "result", toolCallId: "c1", result: { details: { timeoutMs: secret } } }),
      // Each acceptance condition on its own: a taskId without `async: true`, then `async: true`
      // without a taskId — the reader opens no engagement for either.
      agent("tool", { name: "exec", phase: "result", toolCallId: "c1", result: { details: { taskId: "t", timeoutMs: secret } } }),
      agent("tool", { name: "exec", phase: "result", toolCallId: "c1", result: { details: { async: true, timeoutMs: secret } } }),
      agent("tool", { name: "exec", phase: "result", toolCallId: "c1", args: { timeoutMs: secret } }),
      agent("tool", { name: "exec", phase: "start", toolCallId: "c1", result: { details: { async: true, taskId: "t", timeoutMs: secret } } }),
      // The `item` stream hands no result to the reader.
      agent("item", { name: "exec", phase: "result", toolCallId: "c1", result: { details: { async: true, taskId: "t", timeoutMs: secret } } }),
      // NOT here: a NAMELESS call. Measured on the replay, the stack does open its engagement
      // (the sink hands the reader an empty name, which it accepts), so its bound IS consumed
      // and kept — reading `asyncTaskStartFromTool` alone had suggested otherwise.
      // An ERRORED result reaches the sink as phase `error`: no engagement, nothing to keep.
      agent("tool", { name: "exec", phase: "result", toolCallId: "c1", isError: true, result: { details: { async: true, taskId: "t", timeoutMs: secret } } }),
    ];
    for (const frame of cases) expect(JSON.stringify((await promote(frame, ["exec"])))).not.toContain(String(secret));
    // …and a real async task's bound, with no readers handed in, is masked too: fail closed.
    // (`null`, not `undefined`: the helper's default would hand the readers back in.)
    const real = agent("tool", { name: "exec", phase: "result", toolCallId: "c1", result: { details: { async: true, taskId: "t", timeoutMs: 300_000 } } });
    expect(JSON.stringify((await promote(real, ["exec"], null)))).not.toContain("300000");
    expect(JSON.stringify((await promote(real, ["exec"])))).toContain('"timeoutMs":300000');
  });

  it("a schedule kind is kept on a schedule the cron card READS — never by key name elsewhere", async () => {
    // A global allowlist published five symbols wherever a `kind` sat (codex): inside a
    // document excerpt that parses as JSON, inside any free-form blob.
    const report = { ...DOCUMENTS, items: [{ text: JSON.stringify({ kind: "stream", note: "Martin" }) }] };
    expect(JSON.stringify((await promote(agent("martin-rag.provenance", report))))).not.toContain('"kind":"stream"');
    const blob = (await promote(agent("lifecycle", { phase: "error", blob: { kind: "stream" } })));
    expect(JSON.stringify(blob)).not.toContain('"kind":"stream"');
    const notCron = (await promote(agent("tool", { name: "exec", phase: "start", toolCallId: "c1", args: { job: { schedule: { kind: "on-exit" } } } }), ["exec"]));
    expect(JSON.stringify(notCron)).not.toContain("on-exit");
  });

  it("a schedule kind read from the INPUT job alone, or from the result details alone, survives", async () => {
    // The pair the card is built from on the wire: the start frame's args (buffered by the
    // normalizer) and the result frame's details.
    const [inStart, inResult] = (await promoteFrames(
      [
        cronFrame("start", { args: { action: "add", job: { name: "n", schedule: { kind: "on-exit", command: "x" } } } }),
        cronFrame("result", { result: { details: { id: "j1" } } }),
      ],
      ["automations"],
    ));
    expect(cronPartFromTool("automations", "completed", inStart!.payload.data.args, inResult!.payload.data.result)?.schedule).toBe("on-exit");
    const [dStart, dResult] = (await promoteFrames(
      [
        cronFrame("start", { args: { action: "add" } }),
        cronFrame("result", { result: { details: { id: "j1", name: "n", schedule: { kind: "stream", command: ["x"] } } } }),
      ],
      ["automations"],
    ));
    expect(cronPartFromTool("automations", "completed", dStart!.payload.data.args, dResult!.payload.data.result)?.schedule).toBe("stream");
  });

  it("a NON-MUTATING cron action keeps no schedule kind — the reader never builds the card", async () => {
    const json = JSON.stringify(
      (await promoteFrames(
        [
          cronFrame("start", { args: { action: "get", id: "j1", job: { schedule: { kind: "stream" } } } }),
          cronFrame("result", { result: { details: { id: "j1", name: "n", schedule: { kind: "on-exit", command: "x" } } } }),
        ],
        ["automations"],
      )),
    );
    expect(json).not.toContain("on-exit");
    expect(json).not.toContain('"kind":"stream"');
  });

  it("an ERRORED cron call keeps no schedule kind — the sink never builds its card", async () => {
    const json = JSON.stringify(
      (await promoteFrames(
        [
          cronFrame("start", { args: { action: "add", job: { schedule: { kind: "stream", command: ["x"] } } } }),
          cronFrame("result", { isError: true, result: { details: { id: "j1", schedule: { kind: "on-exit", command: "x" } } } }),
        ],
        ["automations"],
      )),
    );
    expect(json).not.toContain("on-exit");
    expect(json).not.toContain('"kind":"stream"');
  });

  it("the args buffer behaves as the normalizer's: no empty id, shared by every tool, capped", async () => {
    const tool = (name: string, phase: string, toolCallId: string, extra: Record<string, unknown>) =>
      agent("tool", { name, phase, toolCallId, ...extra });
    const start = { args: { action: "add", job: { schedule: { kind: "on-exit", command: "x" } } } };
    const result = { result: { details: { id: "j1" } } };
    const kept = async (frames: unknown[]) => JSON.stringify((await promoteFrames(frames, ["automations", "exec"]))).includes("on-exit");
    // Sanity: the same pair with a real id IS read — the three cases below are not vacuous.
    expect((await kept([tool("automations", "start", "c1", start), tool("automations", "result", "c1", result)]))).toBe(true);
    // An empty id is never buffered: the result reads its own (absent) args, and builds no card.
    expect((await kept([tool("automations", "start", "", start), tool("automations", "result", "", result)]))).toBe(false);
    // Another tool starting with the same id overwrites the buffered input.
    expect(
      (await kept([
        tool("automations", "start", "c1", start),
        tool("exec", "start", "c1", { args: { command: "ls" } }),
        tool("automations", "result", "c1", result),
      ])),
    ).toBe(false);
    // Past MAX_TOOL_ARGS buffered calls, a new start is not buffered at all.
    const flood = Array.from({ length: 2_000 }, (_, i) => tool("exec", "start", `x${i}`, { args: {} }));
    expect((await kept([...flood, tool("automations", "start", "c1", start), tool("automations", "result", "c1", result)]))).toBe(false);
  });

  it("the INPUT schedule's kind is not kept when the result's schedule is the one printed", async () => {
    const [start, result] = (await promoteFrames(
      [
        cronFrame("start", { args: { action: "add", job: { schedule: { kind: "on-exit", command: "x" } } } }),
        cronFrame("result", { result: { details: { id: "j1", schedule: { kind: "stream", command: ["x"] } } } }),
      ],
      ["automations"],
    ));
    expect(JSON.stringify(start)).not.toContain("on-exit");
    expect(cronPartFromTool("automations", "completed", start!.payload.data.args, result!.payload.data.result)?.schedule).toBe("stream");
  });

  it("a STRING schedule the reader prints keeps its branch word, the rest masked", async () => {
    const [start, result] = (await promoteFrames(
      [cronFrame("start", { args: { action: "add" } }), cronFrame("result", { result: { details: { id: "j1", schedule: "cron 30 9 * * 1" } } })],
      ["automations"],
    ));
    expect(cronPartFromTool("automations", "completed", start!.payload.data.args, result!.payload.data.result)?.schedule).toBe("cron 00 0 * * 0");
  });

  it("the cron job the reader PARSES out of the result text keeps its schedule kind — and only the first", async () => {
    const job = (kind: string) => JSON.stringify({ id: "j1", name: "n", schedule: { kind, command: "make Martin" } });
    const raw = [
      cronFrame("start", { args: { action: "add" } }),
      cronFrame("result", { result: { content: [{ type: "text", text: job("on-exit") }, { type: "text", text: job("stream") }] } }),
    ];
    const read = (frames: Array<{ payload: { data: Record<string, unknown> } }>) =>
      cronPartFromTool("automations", "completed", frames[0]!.payload.data.args, frames[1]!.payload.data.result)?.schedule;
    expect(read(raw as never)).toBe("on-exit");
    const promoted = (await promoteFrames(raw, ["automations"]));
    expect(read(promoted)).toBe("on-exit");
    const json = JSON.stringify(promoted);
    expect(json, "the second job is not read, so its kind is not kept").not.toContain('"kind":"stream"');
    expect(json).not.toContain("Martin");
  });

  it("a report the reader refuses LATER — no valid item, too large — keeps nothing", async () => {
    const empty = { ...DOCUMENTS, injected: { truncated: true }, items: [{}] };
    expect(parseProvenanceReport(empty)).toBeNull();
    expect(JSON.stringify((await promote(agent("martin-rag.provenance", empty))))).not.toContain("true");
    // Over the reader's JSON budget: refused raw. Promotion must not turn it into a report.
    const big = { ...DOCUMENTS, items: Array.from({ length: 20 }, () => ({ file_name: "f", context: true, text: "M".repeat(2_000) })) };
    expect(parseProvenanceReport(big)).toBeNull();
    const out = (await promote(agent("martin-rag.provenance", big)));
    expect(parseProvenanceReport(out.payload.data)).toBeNull();
    expect(JSON.stringify(out)).not.toContain("true");
  });

  it("only the items the reader READS keep their context flag", async () => {
    const report = { ...DOCUMENTS, items: Array.from({ length: MAX_PROVENANCE_ITEMS + 1 }, () => ({ file_name: "f", context: true })) };
    const json = JSON.stringify((await promote(agent("martin-rag.provenance", report))));
    expect(json.split('"context":true').length - 1).toBe(MAX_PROVENANCE_ITEMS);
  });

  it("a task's declared timeout survives inside the reader's bounds, and is masked outside them", async () => {
    const start = async (details: Record<string, unknown>) => {
      const out = (await promote(
        agent("tool", { name: "image_generate", phase: "result", toolCallId: "c1", result: { details } }),
        ["image_generate"],
      )).payload.data;
      return { out, read: asyncTaskStartFromTool("image_generate", "completed", out.result) };
    };
    expect((await start({ async: true, taskId: "t1", timeoutMs: 300_000 })).read?.timeoutMs).toBe(300_000);
    // Published as the reader reads it — rounded — not with a precision nothing consumes.
    const fractional = (await start({ async: true, taskId: "t1", timeoutMs: 300_000.4 }));
    expect(fractional.read?.timeoutMs).toBe(300_000);
    expect(JSON.stringify(fractional.out)).not.toContain("300000.4");
    // An epoch-sized number under the same key is no bound: the reader drops it, and so does
    // promotion — it must not leave the capture as a date.
    const epoch = (await start({ async: true, taskId: "t1", timeoutMs: 1_785_204_000_000 }));
    expect(epoch.read?.timeoutMs).toBeUndefined();
    expect(JSON.stringify(epoch.out)).not.toContain("1785204000000");
  });

  it("a lifecycle error OBJECT keeps the key the reader picks, never its text", async () => {
    const out = (await promote(agent("lifecycle", { phase: "error", error: { detail: "Martin quota exceeded" } })));
    const error = out.payload.data.error as Record<string, unknown>;
    expect(Object.keys(error)).toEqual(["detail"]);
    expect(String(error.detail)).not.toContain("Martin");
  });

  it("frames the reading stack never CONSUMES keep none of the reader-consumed values — foreign session, foreign run, not an agent event", async () => {
    // Scope, stated: this is about the values the reader rules keep (`v`, `truncated`, a task
    // bound). Values under protocol keys of an unrecognised `data` node are the positional hole
    // pinned by "the remaining hole is bounded and NAMED" (defect 12), not this rule.
    // Measured on the real replay, not assumed: once the capture's own session is established
    // (the replay takes its session from the acked run's first frame, so every case starts with
    // one), a frame of another session, a frame of another run and a non-agent event are refused.
    const as = (sessionKey: string, runId: string, event: string, stream: string, data: unknown) => ({
      type: "event",
      event,
      payload: { runId, sessionKey, stream, data },
    });
    const OWN = "agent:a:atrium:chat:u:c";
    const OTHER = "agent:b:atrium:chat:v:d";
    const own = as(OWN, "webchat-r1", "agent", "lifecycle", { phase: "start" });
    const task = { name: "image_generate", phase: "result", toolCallId: "t1", result: { details: { async: true, taskId: "t", timeoutMs: 300_000 } } };
    const cases: Array<[string, unknown[]]> = [
      ["foreign session report", [own, as(OTHER, "webchat-r1", "agent", "martin-rag.provenance", DOCUMENTS)]],
      ["foreign session task", [own, as(OTHER, "webchat-r1", "agent", "tool", task)]],
      ["foreign run report", [own, as(OWN, "webchat-other", "agent", "martin-rag.provenance", DOCUMENTS)]],
      ["foreign run task", [own, as(OWN, "webchat-other", "agent", "tool", task)]],
      ["not an agent event", [own, as(OWN, "webchat-r1", "chat", "martin-rag.provenance", DOCUMENTS)]],
    ];
    for (const [label, frames] of cases) {
      const json = JSON.stringify(await promoteFrames(frames, ["image_generate"]));
      expect(json, label).not.toContain('"v":1');
      expect(json, label).not.toContain('"truncated":true');
      expect(json, label).not.toContain("300000");
    }
    // Sanity: the same report and task in the capture's own session and run ARE consumed and kept.
    const kept = JSON.stringify(
      await promoteFrames([own, as(OWN, "webchat-r1", "agent", "martin-rag.provenance", DOCUMENTS), as(OWN, "webchat-r1", "agent", "tool", task)], ["image_generate"]),
    );
    expect(kept).toContain('"v":1');
    expect(kept).toContain('"timeoutMs":300000');
  });

  it("a FOREIGN-run start between an admitted start and its result lends nothing — the admitted one is read", async () => {
    // The normalizer refuses the foreign-run start (measured: the card prints `on-exit`), so its
    // args never reach the buffer. A replay of every raw frame did overwrite it (codex).
    const start = (runId: string, kind: string) => ({
      type: "event",
      event: "agent",
      payload: {
        runId,
        sessionKey: "agent:a:atrium:chat:u:c",
        stream: "tool",
        data: { name: "automations", phase: "start", toolCallId: "c1", args: { action: "add", job: { schedule: { kind, command: "x" } } } },
      },
    });
    const json = JSON.stringify(
      await promoteFrames([start("webchat-r1", "on-exit"), start("webchat-other", "stream"), cronFrame("result", { result: { details: { id: "j1" } } })], ["automations"]),
    );
    expect(json, "the admitted start's schedule kind is kept").toContain('"kind":"on-exit"');
    expect(json, "the refused start's is not").not.toContain('"kind":"stream"');
  });


  it("a lifecycle error's NESTED failure class is kept when a turn closes with it, and only then", async () => {
    const error = (errorKind: string) => agent("lifecycle", { phase: "error", error: { message: "Martin overflow", errorKind } });
    const kept = JSON.stringify(await promote(error("context_length")));
    expect(kept).toContain('"errorKind":"context_length"');
    expect(kept).not.toContain("Martin");
    // A value the normalizer does not accept classifies nothing: masked.
    expect(JSON.stringify(await promote(error("Martin_kind")))).not.toContain("Martin_kind");
    // An error of another run is never read.
    const own = agent("lifecycle", { phase: "start" });
    const foreign = { ...error("context_length"), payload: { ...error("context_length").payload, runId: "webchat-other" } };
    expect(JSON.stringify(await promoteFrames([own, foreign]))).not.toContain('"errorKind":"context_length"');
    // …not even when the capture's OWN turn closes with the very same class from another frame:
    // the reading belongs to the frame that closed the turn, not to its value (codex).
    // The own terminal carries its class NESTED too: a root `errorKind` is a vocabulary key kept
    // everywhere, and would prove nothing about the attribution (codex).
    const ownNestedError = agent("lifecycle", { phase: "error", error: { message: "own boom", errorKind: "context_length" } });
    const [, promotedForeign, promotedOwn] = await promoteFrames([own, foreign, ownNestedError]);
    expect(JSON.stringify(promotedForeign)).not.toContain('"errorKind":"context_length"');
    expect(JSON.stringify(promotedOwn), "the own terminal's class is kept").toContain('"errorKind":"context_length"');
  });

  it("a schedule's kind is not kept when the card prints its expression instead", async () => {
    const [start, result] = await promoteFrames(
      [cronFrame("start", { args: { action: "add" } }), cronFrame("result", { result: { details: { id: "j1", schedule: { kind: "on-exit", expr: "0 5 * * *" } } } })],
      ["automations"],
    );
    expect(cronPartFromTool("automations", "completed", start!.payload.data.args, result!.payload.data.result)?.schedule).toBe("cron 0 0 * * *");
    expect(JSON.stringify(result)).not.toContain("on-exit");
  });

  it("a NAMELESS async call's bound is kept — the stack opens its engagement (measured)", async () => {
    const out = JSON.stringify(await promote(agent("tool", { phase: "result", toolCallId: "c1", result: { details: { async: true, taskId: "t", timeoutMs: 300_000 } } })));
    expect(out).toContain('"timeoutMs":300000');
  });
});
