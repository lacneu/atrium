---
name: frame-discovery
description: >-
  Instruct ONE protocol frame/field of a provider contract (OpenClaw or Hermes)
  end to end: trace it in the pinned upstream sources, decide its use for
  Atrium, implement the full chain when adopted, prove it on the live bench or
  the golden corpus, and record the verdict in the coverage manifest under the
  truth ratchet — or, for an EMISSION of the `agent` channel (a stream, a
  stream/phase pair or a data key), in the emission registry under the
  emission ratchet. No supposition — every claim carries an upstream file+symbol.
  Triggers: "/frame-discovery <Schema.field>", "/frame-discovery agent:<stream>
  [/<phase>|.<key>]", "instruis la trame", "instruis l'émission", "découverte
  de trame", "analyse ce champ du protocole", "frame discovery".
---

# frame-discovery — instruct one protocol frame, factually, to a proven verdict

The unit of work is ONE field path (`Schema.field`) of a provider contract. The
deliverable is its coverage-manifest entry brought to a PROVEN state — never a
count made prettier. The ledger of record is
`bridge/protocol/openclaw/coverage/<version>.json` (meta-schema:
`bridge/protocol/coverage.schema.json`; truth guard:
`bridge/test/coverage-truth.test.ts`; enforcement scope:
`bridge/protocol/openclaw/truth-ratchet.json`).

**This skill never commits, pushes, or amends. The maintainer owns git history:
finish green, stop, report.**

## Inputs

- The field path, e.g. `CronJobState.consecutiveErrors`. Provider defaults to
  openclaw; say `hermes:` for the Hermes surface.
- OR an emission of the OpenClaw `agent` channel: `agent:<stream>` (a stream),
  `agent:<stream>/<phase>` (a pair, `-` = no phase key) or `agent:<stream>.<key>`
  (a data key). `AgentEventSchema.data` has no schema upstream, so these are not
  in the coverage manifest: they are listed by the vendored emission inventory
  (`bridge/protocol/openclaw/<version>/agent-emissions.json`) and classified in
  the emission registry (see "Emission mode" below). `add-gateway-version` sends
  every emission its diff reports as added or modified here, BEFORE the bench.
- Optional guidance (which Atrium surface the maintainer has in mind).

## Steps

1. **Sync the upstream ledger first.** `node bridge/scripts/contrib-sync.mjs`.
   If an entry linked to this field changed state (merged/rejected), adjust the
   plan before instructing: a merged upstream fix may change the answer.

2. **Pin the sources.** The version under instruction is the one in the
   manifest's directory name; its exact upstream commit is in
   `bridge/protocol/openclaw/<version>/PROVENANCE.json` (`upstreamSha`). Work in
   `<hors-dépôt>/openclaw-upstream` (or `<hors-dépôt>/hermes-upstream`) checked
   out at that SHA/tag — verify with `git describe --tags` before reading
   anything. A claim made against the wrong tag is a supposition with a serial
   number.

3. **Instruct at the source — the dossier.** In the upstream checkout, establish
   with exact `path` (+ symbol) references:
   - **writers**: every site that sets the field, and on what occasion;
   - **resets**: every site that clears it (the consecutiveErrors lesson: three
     distinct reset paths, one of them surprising);
   - **upstreamUse**: what upstream itself does with it (their TUI, doctor,
     scheduler policy) — this is where the field's real meaning lives;
   - **wire**: which gateway method/event carries it, in which direction.
   Record all of it in the entry's `dossier`. Refusal rule: any sentence without
   a file+symbol behind it does not enter the dossier.

4. **Decide, and say it.**
   - **Adopt**: name the Atrium surface and the user value.
   - **Ignore**: write the `why` — it must describe a deliberate exclusion. A
     why that names a breakage is a `gap`, not an `ignored` (the offerHeaders
     lesson).
   - **Upstream defect proven** while instructing: switch to the
     `upstream-contrib` skill; link the resulting id in the entry's `contrib`.

5. **Implement the full chain** (adopt only): bridge → Convex → UI, one test per
   hop — a fact carried faithfully by one normalizer dies in the next one that
   re-types what it keeps (five hops on the cron delivery verdict). Every fix
   proven failing by neutralization. Loop `/codex:review` until a clean pass
   (repo rule), on the lot's final state.

6. **Prove.**
   - Preferred: a FULL-catalogue live-bench GO
     (`<hors-dépôt>/live-bench/run-live-bench.mjs`, never `--scenario`/`--skip-*`
     — a GO over a subset earns no attestation) whose capture shows the field;
     promote with `node bridge/scripts/promote-capture.mjs --run <dir>`; the
     `proof` is then `{kind: "golden-corpus", ref: "<scenario>"}`.
   - Admitted fallback: `{kind: "deterministic-test", ref, note}` when the frame
     cannot be elicited live yet — the `note` must say WHY, and the live proof
     stays owed.

7. **Record.** Update the entry (`status`, `by`, `anchor` for handled —
   bridge-relative `src/…` file + token present in the comment-stripped source;
   `knownReaders` for any code that touches the field while the flow does not
   happen; `proof`; `verifiedVersions ⊆ validatedVersions`; `contrib`). Apply
   the same edit to EVERY vendored manifest that carries the field. Add the
   field to `bridge/protocol/openclaw/truth-ratchet.json` (`scan: true` only if
   the bare token is distinctive enough to sweep for — check first: Atrium may
   legitimately use the same word elsewhere, the idempotencyKey case) AND to
   `FROZEN_TRUTH_FLOOR` in `bridge/test/coverage-truth.test.ts`, same change.
   Update `COVERAGE_SUMMARY` (counts + gapList) in
   `bridge/src/providers/openclaw/protocol-drift.ts` — the drift test recounts
   the manifest and refuses a stale literal. If the field is read in a function
   no group of `bridge/protocol/openclaw/read-sites.json` names, add that read
   site to its schema's group: the truth guard (`coverage-truth.test.ts` V3)
   refuses a `gap`/`ignored` field its schema's read sites touch, and a schema
   the bridge reads with no read site at all.

8. **Gates, then stop.** `cd bridge && npm run typecheck && npm test`; repo root
   `npm run typecheck && npm test` when convex/src changed. Report: dossier
   summary, decision, proof, files touched. Do not commit.

## Emission mode (`agent:<stream>[/<phase>|.<key>]`)

The same steps, with the emission's own ledger and proofs:

- **Ledger**: `bridge/protocol/openclaw/emissions/<version>.json` (meta-schema
  `bridge/protocol/emissions.schema.json`, ratchet
  `bridge/test/emissions-coverage.test.ts`). Pairs live under
  `streams.<stream>.phases`, data keys under `streams.<stream>.keys`, keys a
  gateway rewrite adds after emission under `rewrites` (`<scope>:<function>:<key>`).
- **Step 3, the dossier**: start from the inventory's rows for the emission —
  `file`, `function`, `lines`, the emitter `chain`, the keys and whether they are
  `optional` — then read those sites in the pinned checkout. A row marked opaque
  carries its reason and origin: say what the value really is, or why it cannot
  be known. Read what the Control UI does with it (`ui/src`): it is upstream's
  own reading of the frame.
- **Step 4, decide**: `handled` (Atrium reads it), `ignored` (a deliberate
  exclusion — the why must not describe a breakage, or it is a `gap`), or `gap`
  with the identifier of the écart it belongs to (`F1`, `N4`, …) and its impact.
- **Step 6, prove**: a `golden-corpus` proof names a scenario (or
  `<version>/<scenario>`) whose capture CARRIES the pair or the unmasked key — the
  ratchet opens the file and checks; otherwise a `deterministic-test` proof names
  a bridge test that names the phase or key, with the note saying why no capture
  shows it. The live bench lists the inventoried pairs no run has captured
  (`emission-check.md` of the run): that list is the queue of scenarios to write.
- **Step 7, record**: the entry (`status`, `by` + `anchor` + `proof` for handled;
  `gap` + `note`; `why`). If the inventory itself changed (a new version
  vendored), regenerate the drift detector's known vocabulary
  (`cd bridge && node scripts/emission-vocabulary.mjs --write`;
  `emission-vocabulary.test.ts` holds it to the inventory element by element)
  and, when a coverage schema describes that stream's data
  (`read-sites.json` `emissionStreams`, e.g. `AgentActivityItem` ↔ `item`), keep
  its manifest entries consistent with the registry: the truth guard refuses a
  contradiction.

## Guardrails

- Never bump `validatedVersions`/`maxValidated` here — that is the bench
  attestation path's job (`bridge/test/bench-attestation.test.ts` explains).
- Anything written to `docs/` follows the stabilization conventions: present
  tense, anonymized (`client-1`, `<hors-dépôt>/…`), counts and field names only.
- One field per run. A second interesting field found on the way becomes its own
  run, not a rider.
