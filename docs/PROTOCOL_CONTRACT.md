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

**The manifest tells the truth about the code.** `bridge/test/coverage-truth.test.ts`
holds the manifest to the bridge source in both directions. A `handled` entry under
the truth ratchet anchors a token present in the comment-stripped source and carries
a proof. A `gap` or `ignored` entry may not be read where its schema is read:
`bridge/protocol/openclaw/read-sites.json` names, per schema, the functions that read
its payload (or build it, for a `*Params` schema), and the test collects, through the
TypeScript parser, the property names each of those functions touches and the receiver
each is read through — identified by its binding (declaration and scope, resolved by the
checker), never by its spelling, so a shadowing variable is another receiver. A field the manifest declares unread and that one of its schema's
read sites touches is refused, access by access, unless that very access is admitted (a
`gap` whose `knownReaders` token is `<receiver>.<field>` in that file) or excepted. An
exception names one concrete access — field, site, receivers — and is checked: a
homonym is refused when one of its receivers reads a handled field of the schema (that
receiver is the payload); a branch exception holds only when every access is provably
unreachable for the schema's own discriminant value, read from the vendored schema. A
schema the bridge reads with no read site is refused too;
the schemas still built inline in multi-purpose functions are listed, with the reason,
and that list can only shrink.

## The agent channel's emissions

`AgentEventSchema.data` is an open record upstream: no schema says which `stream`
values exist, which `data.phase` each one moves through, or which `data` keys it
carries. That surface is derived from the code that emits it.

```
bridge/protocol/openclaw/<version>/agent-emissions.json   # DERIVED inventory
bridge/protocol/openclaw/emissions/<version>.json          # its classification
```

- **The inventory.** `bridge/scripts/lib/derive-agent-emissions.mjs` loads the whole
  upstream program with its type checker, starts from the one dispatcher that hands an
  event to the public listeners, and discovers every emitter by following references.
  Each row is an emission site with its stream, phase and keys; a value it cannot
  resolve is an opaque row with its reason. It also records the frames the gateway
  fabricates on the channel, the keys it rewrites after emission, and the chat
  content-part types its display projection produces. Its completeness is accounted:
  every identifier spelled like an emitter is classified, and vendoring refuses an
  inventory that leaves one unaccounted. The gateway's senders are a second family
  discovered the same way, by symbol, from the frame senders its transports hand out: every
  value derived from one — a wrapper, a property it is stored in, a parameter it is passed
  to, a spread into a typed object — is followed to its calls, whatever the names of its
  arguments or parameters; a destructuring is a reference like a call. A sender stored in an
  object slot is also followed through the object: an object handed whole to a binding of
  another type carries the slot into that type's own declaration, whose reads are then
  followed by name; a slot that no use of its object reads, where no use could read it
  unseen (a computed key, code outside the analysed sources, a store into another object, a
  return), is listed as unread (`unreadSlots`) instead of open. Each call's payload is the
  template of every sender the callee may hold, each with the call's arguments substituted
  for its own parameters, so it is the final form, with every spread and field replacement
  the wrappers applied. A literal stream is a fabricated frame; an agent event passed on
  with its own data (or its data plus a recorded rewrite) is a relay with its origins
  named; a call whose event or final payload cannot be evaluated is unresolved, and
  vendoring refuses it. A sender only plugins can call (reached from the public plugin
  surface, with no call in the analysed sources) is an open entry: listed in `openSenders`
  with what the sender itself fixes, compared from one version to the next by the diff
  report, and never blocking, since what a plugin sends is the plugin's. A gap inside the
  analysed sources is never an open entry: it is unresolved and blocks. A sender's own body
  is the transport and is not analysed. A content-part type the projection compares after normalizing it
  (`trim`, `lowercase`) is recorded with that normalization. The vendoring script writes it beside the
  schemas; `PROVENANCE.json` records its fingerprint (`sha256`), the extractor's full
  output (`fullSha256`) and the extractor itself (`deriverSha256`), and
  `vendor-integrity.test.ts` recomputes the fingerprint and the summary.
- **The diff between two versions** is a readable report:
  `bridge/scripts/diff-agent-emissions.mjs <old> <new>` lists the streams, pairs and keys
  added or removed, the emission rows added, removed, modified or moved, and the open
  senders added or removed.
- **The classification.** Every (stream, phase) pair, every key an emitter writes and
  every key a gateway rewrite adds is classified: `handled` (an anchor present in the
  code and a proof — a golden capture that carries it, checked by opening the file, or a
  deterministic test that names it), `ignored` (a deliberate exclusion, said why) or
  `gap` (the identifier of the known defect and its impact).
  `bridge/test/emissions-coverage.test.ts` refuses the promised version until every
  emission of its inventory is classified, and refuses an entry for an emission the
  version no longer has.
- **The drift detector's known vocabulary** (`agent-emission-vocabulary.ts`: streams,
  phases per stream, keys per stream, content-part types) is generated from the
  vendored inventories (`bridge/scripts/emission-vocabulary.mjs --write`) and compared
  to them element by element. Every stream the vocabulary names is judged, dotted ones
  included (`codex_app_server.*`); only an unknown dotted stream is a plugin's own and left
  unjudged. Knowledge is per stream: a key only an emitter of
  unresolved stream writes is known on no stream. On a known stream, any `data.phase`
  its emitters do not write — on a stream that declares no phase included — is counted
  digested (`agent.<stream>.phase_<digest>`); a `data` key its emitters do not write is
  counted as `opaquekey_<key>` when only an unresolved emitter writes it, as
  `data_<key>` when another stream carries it, and digested (`datakey_<digest>`)
  otherwise. A content-part type is known exactly or under the projection's
  normalization. Never a value, never content.
- **On the live bench**, every captured agent frame must exist in the inventory (a
  core-stream frame it cannot vouch for means the extractor missed an emitter), and
  the inventoried pairs no capture shows are listed as the scenarios still to write.

The output is a support matrix carried by the `/compat` payload: what this
bridge build supports, and what it does not.

## The runtime drift detector

The bridge already tallies inbound frame shapes per turn (`tallyFrame`).
Extend it: classify each shape against the vendored schema matching the
CONNECTED gateway's hello version.

- Unknown event/field → bounded counter + ONE SOC2-safe log line (shape only,
  never content) + exposed on `/compat` as `protocolDrift`.
- A name appears in a shape only when it is vocabulary — spelled by the vendored
  schemas or emission inventories. Any other name or value (a field, a key, a phase, a
  stream, a state, a content-part type) appears as a digest: HMAC-SHA256, truncated to
  32 bits, under a key derived from the deployment's ingest secret
  (`HMAC-SHA256(BRIDGE_INGEST_SECRET, "atrium-drift-digest-v1")`). The same value gives
  the same digest across restarts and across the bridges of one deployment, and nobody
  without the secret can recompute one; rotating the secret changes every digest once.
  Without the secret (tests, development) the key is random per process. Announced event
  families and capabilities are named as announced: they are the gateway's protocol
  vocabulary, not payload values.
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
