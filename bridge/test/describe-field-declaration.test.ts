/**
 * THE MISSING DIRECTION OF THE TRUTH RATCHET.
 *
 * `truth-ratchet.json` enforces manifest -> code: a field DECLARED in the
 * coverage manifest must have a true classification (a `handled` must anchor a
 * real consumer, a `gap` must not be consumed). Nothing enforced the other way —
 * code -> manifest. So a field the bridge READS off a gateway payload, but that
 * no pinned contract declares, was invisible: it simply arrived `undefined`,
 * every guard built on it fell open, and no suite went red.
 *
 * That is not hypothetical. The pre-send context guard depends on the gateway's
 * own budget assessment, which no pinned version declares. With nothing to
 * describe it, its shape got instructed TWICE from observation — and the two
 * instructions disagree about where the figures sit: the gauge's projection reads
 * them nested under `contextBudgetStatus`, the guard's capture read the same
 * names flat on the session row.
 *
 * What is MEASURED (live prod, 2026-08-05): 200 consecutive pre-send decisions,
 * `fillSource` = "counter" every single time, never "gateway_estimate". The flat
 * read finds nothing, and a turn died of `context_length` at a reported 51 % of
 * window. What is NOT established is which shape — if either — this gateway build
 * actually produces, so the guard now reads both places and
 * `/frame-discovery contextBudgetStatus` is the open question.
 *
 * The way to settle it is the LOCAL bench (`bridge/local-openclaw/up.sh`), not
 * production: boot the pinned gateway and read a real `sessions.describe`. One
 * observed row answers which shape — if either — the build emits.
 *
 * The guard's own suite could not catch any of it: every fixture there hands it a
 * describe carrying the flat shape. Green tests over a shape production may never
 * produce — the whole hazard of a payload nobody declared.
 *
 * This gate closes that direction for the session describe: the payload whose
 * reads decide whether a turn is sent. It sweeps BOTH of its consumers, because
 * sweeping one is exactly how their disagreement survived.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DRIFT_VENDORED_VERSION } from "../src/providers/openclaw/protocol-drift.js";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

/** Every field name the pinned contract declares on the session describe. */
function declaredFields(): Set<string> {
  const snap = JSON.parse(
    read(
      `../protocol/openclaw/${DRIFT_VENDORED_VERSION}/session-event-snapshot.json`,
    ),
  ) as { fields: string[] };
  const declared = new Set(snap.fields);
  // The describe row carries names declared across SEVERAL vendored schemas, not
  // only the session snapshot: `agentRuntime`, `thinkingLevels` and
  // `thinkingDefault` live in agents-models-skills.ts. Checking the snapshot
  // alone flagged those three as undeclared dependencies when they are nothing of
  // the kind — a gate that cries wolf gets an allowlist entry per false alarm and
  // stops meaning anything.
  for (const f of DESCRIBE_AGENT_FIELDS) declared.add(f);
  return declared;
}

/** The agent facts the session describe carries alongside the session row.
 *
 *  ENUMERATED, not unioned from whole files. Taking every property name of even
 *  two vendored schemas was still far too permissive: `sessions.ts` declares
 *  `reason` (on the session-operation event), `agents-models-skills.ts` declares
 *  `enabled`, `query`, `error` — none of them on the describe result. Any one of
 *  those names would let a future undeclared read sail through, which is exactly
 *  the code->contract hole this gate exists to close, reopened for the names most
 *  likely to collide.
 *
 *  Three names, each anchoring a read this gate has actually seen. Their presence
 *  in the vendored schema is asserted below, so an upstream rename fails here
 *  instead of quietly emptying the reference. */
const DESCRIBE_AGENT_FIELDS = [
  "agentRuntime",
  "thinkingLevels",
  "thinkingDefault",
] as const;
const AGENT_SCHEMA = "agents-models-skills.ts";

/** The fields `captureDescribe` reads off the gateway's session object.
 *
 *  Derived from the SOURCE, never restated: a hand-maintained list is the very
 *  thing that let three reads go undeclared. */
function capturedFields(): string[] {
  const src = read("../src/server.ts");
  const found = new Set<string>();
  // BOTH consumers of the describe row, because they disagreed: the guard's
  // capture read the budget figures flat, the gauge's projection read them
  // nested. Sweeping only the first is how that disagreement stayed invisible.
  const regions: Array<[string, string, RegExp]> = [
    [
      "const captureDescribe",
      "if (sess) captureDescribe(sess)",
      /\bs\.([A-Za-z_][A-Za-z0-9_]*)/g,
    ],
    [
      "function parseSessionMeta",
      "function contextBudgetFields",
      /\bsess\.([A-Za-z_][A-Za-z0-9_]*)/g,
    ],
    // The PROJECTOR PAIR — contextBudgetFields and selectBudgetAssessment, which
    // sit together. Their reads were only ever caught by COINCIDENCE, through the
    // flat duplicates in captureDescribe, so the day `/frame-discovery` settles the
    // shape and the flat fallback goes away, or a new sub-field is added here
    // alone, the code->contract blind spot would reopen on the nested side. Both
    // functions name their row `o` for exactly this sweep.
    [
      "function contextBudgetFields",
      // The projector's OWN end. Anchoring on the next exported function swept
      // 40 further lines and attributed their `o.` reads to the describe.
      "Fetch `models.list` once per OWNER",
      /\bo\.([A-Za-z_][A-Za-z0-9_]*)/g,
    ],
  ];
  for (const [from, to, pattern] of regions) {
    const start = src.indexOf(from);
    const end = src.indexOf(to);
    expect(
      start,
      `${from} moved or was renamed — this gate is now sweeping nothing`,
    ).toBeGreaterThan(-1);
    expect(end, `${to} moved or was renamed`).toBeGreaterThan(start);
    for (const m of src.slice(start, end).matchAll(pattern)) {
      if (m[1] !== undefined) found.add(m[1]);
    }
  }
  // What this gate CANNOT see, stated rather than implied: a read reached through
  // a helper, a destructuring, or bracket notation. Closing those needs an AST
  // pass; until then the two hot regions above are swept textually and a new
  // read added in either is caught.
  return [...found].sort();
}

function declaredUndeclaredReads(): Map<
  string,
  { reason: string; whenAbsent: string; keepBecause: string }
> {
  const doc = JSON.parse(read("../protocol/openclaw/undeclared-describe-reads.json")) as {
    fields: Record<
      string,
      { reason: string; whenAbsent: string; keepBecause: string }
    >;
  };
  return new Map(Object.entries(doc.fields));
}

describe("a session-describe field we read must be declared somewhere", () => {
  it("the reference set is the session payload, and NOT a union of whole schemas", () => {
    const declared = declaredFields();
    // Every enumerated agent field must really be declared upstream — a rename
    // there must fail here rather than quietly empty the reference.
    const agentSchema = read(
      `../protocol/openclaw/${DRIFT_VENDORED_VERSION}/${AGENT_SCHEMA}`,
    );
    for (const f of DESCRIBE_AGENT_FIELDS) {
      expect(agentSchema, `${f} is no longer declared in ${AGENT_SCHEMA}`).toContain(
        f,
      );
      expect(declared.has(f)).toBe(true);
    }
    // And the names that made the union approach useless must NOT be in it: each
    // is declared somewhere in the vendored contract, none is on the describe.
    for (const foreign of ["reason", "enabled", "query", "trigger"]) {
      expect(
        declared.has(foreign),
        `${foreign} is declared elsewhere in the contract, not on the session describe — its presence here would let a future undeclared read through`,
      ).toBe(false);
    }
  });

  it("every captured field is in the contract, or on the record as absent from it", () => {
    const declared = declaredFields();
    const allowed = declaredUndeclaredReads();
    const captured = capturedFields();

    // The sweep must actually find something; an empty region would make this
    // gate pass by measuring nothing (the failure mode of every derived check).
    expect(captured.length).toBeGreaterThan(4);

    const unaccounted = captured.filter(
      (f) => !declared.has(f) && !allowed.has(f),
    );
    expect(
      unaccounted,
      `these fields are read off the gateway's session describe but appear in neither ${DRIFT_VENDORED_VERSION}'s contract nor undeclared-describe-reads.json. They will arrive undefined in production and whatever depends on them will fall open in silence. Declare each one — with what the code does when it is absent — or stop reading it.`,
    ).toEqual([]);
  });

  it("the allowlist stays HONEST: no entry for a field that is declared, or unread", () => {
    const declared = declaredFields();
    const captured = new Set(capturedFields());
    for (const [field, entry] of declaredUndeclaredReads()) {
      expect(
        declared.has(field),
        `${field} IS declared by ${DRIFT_VENDORED_VERSION} — remove it from the allowlist, it is no longer an undeclared dependency`,
      ).toBe(false);
      expect(
        captured.has(field),
        `${field} is on the allowlist but nothing reads it any more — delete the entry rather than carrying a dependency that no longer exists`,
      ).toBe(true);
      // An entry that does not say what happens without the field is a
      // silencer, not a declaration.
      expect(entry.whenAbsent.length, `${field} must state its absent-behaviour`).toBeGreaterThan(40);
    }
  });

  it("the known-absent set is the budget assessment and its flat fallbacks", () => {
    // Pins the CURRENT extent of the hole. If a fourth appears, this fails and a
    // reviewer decides whether it is acceptable — the point of a ratchet.
    expect([...declaredUndeclaredReads().keys()].sort()).toEqual([
      "contextBudgetStatus",
      "estimatedPromptTokens",
      "overflowTokens",
      "promptBudgetBeforeReserve",
    ]);
  });
});
