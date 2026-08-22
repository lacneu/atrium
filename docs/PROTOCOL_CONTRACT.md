# Protocol Contract — schema-driven, per-version bridge compatibility

Per-version compatibility is enforced by three mechanisms that work together.

1. **A vendored schema and a CI ratchet.** Each supported gateway version has its
   schemas checked in under `bridge/protocol/<provider>/<version>/` beside a
   coverage manifest that classifies every exported schema and field as handled,
   ignored or a declared gap. `bridge/test/protocol-coverage.test.ts` walks the
   vendored schemas and fails on anything unclassified, so raising the supported
   ceiling stays red until a human triages the new surface.
2. **A runtime drift detector.** `bridge/src/providers/openclaw/protocol-drift.ts`
   observes the live stream against the vendored shape. It is observe-only by
   design — an unknown frame must never break a turn — and its runtime sets are
   bijection-tested against the manifest.
3. **An honest report.** Both surface on `/capabilities` as an additive
   `protocol` section (vendored version, coverage summary, observed drift). The
   compat poller bounds and persists it, unioning drift across a multi-bridge
   deployment, and Settings ▸ Bridge renders it per provider: aligned-or-drifted
   badge, vendored version, coverage counts, and the declared gaps.

The versions actually vendored are the directories under `bridge/protocol/`;
the ceiling the bridge claims is `maxValidated` in `bridge/src/compat.ts`.
Neither is restated here — a version written into prose is a version that goes
stale.

## Where the wire contract comes from

The bridge converts Atrium ↔ gateway wire protocols (OpenClaw and Hermes).
OpenClaw publishes its authoritative wire contract as TypeBox schemas
(`packages/gateway-protocol/src/schema/*.ts`), generated to JSON Schema and
versioned by git tag; the gateway validates inbound frames against it. Atrium
consumes that artifact directly rather than inferring the contract from the
normalizer, so what the bridge supports is a checked fact rather than something
a reader has to reconstruct by audit.

Three artefacts carry it, and each has one job:

| Artefact | Holds |
|---|---|
| `bridge/protocol/<provider>/<version>/` | The vendored upstream schemas, verbatim, plus a provenance record |
| `bridge/protocol/openclaw/coverage/<version>.json` | One classification per leaf field: handled, ignored, or a declared gap |
| `bridge/src/compat.ts` | The capability manifest and the supported ceiling (`maxValidated`) |

## Vendored schemas and the coverage manifest

**Vendor the contract.** For each gateway version in the validated range
(the same range VCOMPAT names), vendor the protocol schema into the repo:

```
bridge/protocol/openclaw/<version>/
  *.ts                          # TypeBox source, imported verbatim from upstream
  PROVENANCE.json               # raw-upstream sha256 per file + the derived block
  session-event-snapshot.json   # DERIVED artifact (see below)
bridge/protocol/openclaw/coverage/<version>.json
```

**What earns a version claim.** `validatedVersions` (and `maxValidated`, which decides
whether a gateway is "within support") rests on an attestation the live bench writes into
the vendored directory:

```
bridge/protocol/openclaw/<version>/BENCH.json
  {
    "kind": "atrium-bench-attestation",
    "gatewayVersion": "<version>",     // must match the directory it sits in
    "verdict": "GO",                   // only a GO earns a claim
    "scenarios": ["basic-turn", …],    // the ids the run exercised
    "providers": {"<id>": "openclaw"}, // which provider drove each one
    "flags": [],                       // any --skip-* / --scenario given: must be empty
    "atriumSha": "<40 hex>",           // the Atrium commit the run exercised
    "vendoredSha256": "<64 hex>"       // hash of this directory, BENCH.json excluded
  }
```

It is not a signature — the same hand runs the bench, writes the file and makes the
commit, so authenticity is out of reach. It records CONSISTENCY, and the check that makes
it load-bearing is that the test RE-COMPUTES `vendoredSha256` from the directory instead
of trusting the number the file carries about itself. Versions validated before this rule
existed are grandfathered by an explicit, dated list in `bridge/src/compat.ts`; the test
asserts that list and the enforced set are disjoint, so the exemption cannot grow.

**Derived artifacts.** Some of the surface is not in a schema at all: the
gateway flattens the return shape of `buildSessionEventSnapshot` onto every
agent event, and that shape lives in gateway source, not in the published
contract. The vendoring script extracts its field names from the upstream
source with the TypeScript parser and writes them beside the schemas, with the
source file's own hash in `PROVENANCE.json`. The bridge's known-field set is
DERIVED from that artifact rather than maintained by hand — a hand-kept set is
always one production incident behind. The vendoring refuses to run against a
modified or unidentifiable checkout, and the integrity test re-derives the
artifact and compares it field by field.

**The coverage manifest.** Every leaf
field of the event/params surface gets exactly one classification:

```json
{
  "chat.delta.deltaText":   { "status": "handled", "by": "normalizer.ts handleChat" },
  "chat.delta.replace":     { "status": "gap", "note": "bare-deltaText replacement corrupts text; no fixture observed" },
  "chat.error.errorKind":   { "status": "gap", "note": "context_length never classified — overflow initiative" },
  "chat.final.usage":       { "status": "gap", "note": "no main-turn token/cost telemetry" },
  "agent.isHeartbeat":      { "status": "ignored", "why": "keep-alive; armRecv already refreshed by any own frame" }
}
```

**The CI ratchet (the determinism):** a unit test walks the vendored schema
and fails if any field lacks a manifest entry. Bumping the supported gateway
version = vendoring its schema = the test enumerates every NEW field and
stays RED until a human classifies each one (handled / ignored-with-reason /
gap-with-note). A protocol evolution can no longer arrive silently: **the
diff between two vendored versions IS the migration checklist.**

The output is a support matrix carried by the `/compat` payload: what this
bridge build supports, and what it does not.

## The runtime drift detector

The bridge already tallies inbound frame shapes per turn (`tallyFrame`).
Extend it: classify each shape against the vendored schema matching the
CONNECTED gateway's hello version.

- Unknown event/field → bounded counter + ONE SOC2-safe log line (shape only,
  never content) + exposed on `/compat` as `protocolDrift`.
- **Frames are NEVER rejected.** Unknown fields flow through exactly as today
  (robustness first — the gateway may legitimately be newer than the bridge).
- Deterministic: same frame → same classification; counters reset per process.

This is the early warning for a common operational case: the host updates its
gateway before the bridge image. Drift surfaces as an admin-visible counter the
day it starts, instead of as unexplained behaviour in a chat.

## How it surfaces: /compat → Convex → Bridge tab

`/compat` (already polled by the `bridgeCompat` cron every 5 min) grows a
`protocol` section:

```json
{
  "protocol": {
    "provider": "openclaw",
    "vendoredVersions": ["2026.6.10"],
    "gatewayVersion": "2026.6.11",
    "coverage": { "handled": 41, "ignored": 7, "gaps": 5 },
    "drift": [ { "shape": "event/chat/steer/-/-", "count": 12 } ]
  }
}
```

Convex persists it; the Settings ▸ Bridge tab (already per-provider) renders
the matrix + drift — the operator sees, factually and live: what this bridge
build supports vs what the connected gateway emits.

**Hermes:** same interface. Until Hermes publishes a machine-readable schema,
its `protocol` section reports `"schema": "none-published"` — an honest,
visible statement instead of implied parity.

## Deliberate limits

- **Schema validation never gates a frame.** The normalizer's tolerance is a
  property of the design, not an omission: the contract layer observes and
  reports, it does not reject. A gateway may legitimately be newer than the
  bridge.
- **The normalizer is not generated from the schema.** It encodes behaviour —
  graces, dedup, isolation — and not only shapes.
