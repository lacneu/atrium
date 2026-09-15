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
 * `/frame-discovery contextBudgetStatus` was the open question until the 2026.9.4
 * derived session-event snapshot carried the field — it left this allowlist on
 * 2026-09-12 (see
 * protocol/openclaw/undeclared-describe-reads.json `$resolved`). The flat sibling
 * read is still undeclared and still listed.
 *
 * WHAT THAT "DECLARATION" IS, stated exactly: no contract declares it. Upstream
 * publishes no result schema for `sessions.describe`, and no vendored TypeBox schema
 * names `contextBudgetStatus`. The reference below is the session-event snapshot — a
 * DERIVED artifact (scripts/vendor-protocol.mjs, PROVENANCE.json `derived`) listing
 * what the TAGGED IMPLEMENTATION copies off the session row
 * (session-event-payload.ts:120 at v2026.9.4). The field is observed in that
 * implementation, not promised by a contract. The describe carries it only because it answers with that same row
 * builder (sessions-read-by-key.ts `buildGatewaySessionRow`, session-utils-row.ts:515)
 * (reached through the `session-utils.ts` re-export) — a source reading, pinned by
 * mechanical anchors and watched files in the bench's upstream-anchors.txt and
 * upstream-watchlist.txt, so a version bump that touches that path raises an alert.
 * This test cannot see that on its own: were the describe to stop projecting the
 * field while the events kept it, it would stay green. And the projection itself
 * returns NOTHING unless a status is stored, the provider and model SELECTED to build
 * the row (`rowModelProvider`/`rowModel`, session-utils-row.ts:515 — not necessarily
 * the displayed identity, which may be canonicalised) are non-empty, its
 * contextTokens is a finite positive number, the status names that same provider and
 * model, a non-blank session id equal to the entry's, and a budget equal to
 * contextTokens, with no live model switch pending (context-token-provenance.ts:125-151).
 * Its absence removes all THREE nested inputs — the estimate, the prompt budget and
 * the overflow — each of which the flat fallback read may still supply
 * (models-roster.ts selectBudgetAssessment). The fill then comes from an estimate,
 * else the counter when usable, else UNKNOWN (core/context-budget.ts
 * sessionFillDetail); a positive overflow keeps its own path to compact_or_block
 * (core/presend-guard.ts presendAction).
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

/** Every field name the pinned version's DERIVED session-event snapshot carries (no
 *  contract declares the describe result), plus the three enumerated agent fields. */
function referenceFields(): Set<string> {
  const snap = JSON.parse(
    read(
      `../protocol/openclaw/${DRIFT_VENDORED_VERSION}/session-event-snapshot.json`,
    ),
  ) as { fields: string[] };
  const reference = new Set(snap.fields);
  // The describe row carries names the session snapshot does not list:
  // `thinkingLevels` and `thinkingDefault` are declared in agents-models-skills.ts
  // (`agentRuntime` is in both, so adding it changes nothing). Checking the snapshot
  // alone flagged those as undeclared dependencies when they are nothing of the kind
  // — a gate that cries wolf gets an allowlist entry per false alarm and stops
  // meaning anything.
  for (const f of DESCRIBE_AGENT_FIELDS) reference.add(f);
  return reference;
}

/** The agent facts the session describe carries alongside the session row.
 *
 *  ENUMERATED, not unioned from whole files. Taking every property name of even
 *  two vendored schemas was still far too permissive: `sessions.ts` declares
 *  `reason` (on the session-operation event), `agents-models-skills.ts` declares
 *  `enabled`, `query`, `error` — none of them on the describe result. Any one of
 *  those names would let a future undeclared read sail through, which is exactly
 *  the code->reference hole this gate exists to close, reopened for the names most
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
  // TWO sources: the guard's capture stays in server.ts, the gauge's projection and
  // the projector pair live with the roster (models-roster.ts).
  const sources = {
    server: read("../src/server.ts"),
    roster: read("../src/providers/openclaw/models-roster.ts"),
  };
  const found = new Set<string>();
  // BOTH consumers of the describe row, because they disagreed: the guard's
  // capture read the budget figures flat, the gauge's projection read them
  // nested. Sweeping only the first is how that disagreement stayed invisible.
  const regions: Array<[keyof typeof sources, string, string, RegExp]> = [
    [
      "server",
      "const captureDescribe",
      "if (sess) captureDescribe(sess)",
      /\bs\.([A-Za-z_][A-Za-z0-9_]*)/g,
    ],
    [
      "roster",
      "function parseSessionMeta",
      "export function dedupeModels",
      /\bsess\.([A-Za-z_][A-Za-z0-9_]*)/g,
    ],
    // The PROJECTOR PAIR — contextBudgetFields and selectBudgetAssessment, which
    // sit together. Their reads were only ever caught by COINCIDENCE, through the
    // flat duplicates in captureDescribe, so the day `/frame-discovery` settles the
    // shape and the flat fallback goes away, or a new sub-field is added here
    // alone, the code->reference blind spot would reopen on the nested side. Both
    // functions name their row `o` for exactly this sweep.
    [
      "roster",
      "function contextBudgetFields",
      // The projector pair's OWN end: parseSessionMeta follows it in the module.
      "export function parseSessionMeta",
      /\bo\.([A-Za-z_][A-Za-z0-9_]*)/g,
    ],
  ];
  for (const [file, from, to, pattern] of regions) {
    const src = sources[file];
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

describe("a session-describe field we read must be in the reference set, or on the record as absent from it", () => {
  it("the reference set is the session payload, and NOT a union of whole schemas", () => {
    const reference = referenceFields();
    // Every enumerated agent field must really be declared upstream — a rename
    // there must fail here rather than quietly empty the reference.
    const agentSchema = read(
      `../protocol/openclaw/${DRIFT_VENDORED_VERSION}/${AGENT_SCHEMA}`,
    );
    for (const f of DESCRIBE_AGENT_FIELDS) {
      expect(agentSchema, `${f} is no longer declared in ${AGENT_SCHEMA}`).toContain(
        f,
      );
      expect(reference.has(f)).toBe(true);
    }
    // And the names that made the union approach useless must NOT be in it: each
    // is declared somewhere in the vendored contract, none is on the describe.
    for (const foreign of ["reason", "enabled", "query", "trigger"]) {
      expect(
        reference.has(foreign),
        `${foreign} is declared elsewhere in the contract, not on the session describe — its presence here would let a future undeclared read through`,
      ).toBe(false);
    }
  });

  it("every captured field is in the derived snapshot or the enumerated agent fields, or on the record as absent from both", () => {
    const reference = referenceFields();
    const allowed = declaredUndeclaredReads();
    const captured = capturedFields();

    // The sweep must actually find something; an empty region would make this
    // gate pass by measuring nothing (the failure mode of every derived check).
    expect(captured.length).toBeGreaterThan(4);

    const unaccounted = captured.filter(
      (f) => !reference.has(f) && !allowed.has(f),
    );
    expect(
      unaccounted,
      `these fields are read off the gateway's session describe but appear in neither ${DRIFT_VENDORED_VERSION}'s derived session-event snapshot (plus the enumerated agent fields) nor undeclared-describe-reads.json. They will arrive undefined in production and whatever depends on them will fall open in silence. Declare each one — with what the code does when it is absent — or stop reading it.`,
    ).toEqual([]);
  });

  it("the allowlist stays HONEST: no entry for a field the reference set carries, or unread", () => {
    const reference = referenceFields();
    const captured = new Set(capturedFields());
    for (const [field, entry] of declaredUndeclaredReads()) {
      expect(
        reference.has(field),
        `${field} IS carried by ${DRIFT_VENDORED_VERSION}'s derived session-event snapshot (or the enumerated agent fields) — remove it from the allowlist, it is no longer an unlisted dependency`,
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
      "estimatedPromptTokens",
      "overflowTokens",
      "promptBudgetBeforeReserve",
    ]);
  });
});
