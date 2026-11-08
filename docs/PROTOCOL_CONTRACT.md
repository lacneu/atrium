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
  discovered the same way, by symbol, from the frame senders its transports hand out. Those
  are a known, named set (`SENDER_ROOTS`): each transport and the senders it returns, each
  with its contract — which argument is the event and which the payload, by position or by
  property of one object argument, never by a parameter's name. Each listed sender must be
  found by symbol (through a binding or an identifier: `broadcast: broadcastInternal`), with
  a signature that bears its contract out (the event argument typed as a string, the payload
  argument present); another member of a transport that hands the transport's delivery a
  string is a candidate sender and must be listed, as a sender or as a non-sender with why.
  Anything else refuses the derivation. Every value derived from a sender — a wrapper, a
  property it is stored in, a parameter it is passed to, a spread into a typed object — is
  followed to its calls, whatever the names of its arguments or parameters; a destructuring
  is a reference like a call, and a literal key (`ops["send"]`) like a name. A sender
  stored in an object slot is also followed through the object, nested ones included: an
  object handed whole to a binding of another type carries the slot into that type's own
  declaration, whose reads are then followed by name; a returned object reaches its
  function's callers. A private class field that holds the object is followed through its
  reads in the class (`this.f`, `{ f } = this`, a rest of the instance) and through its
  literal keys anywhere. A use of the object that could read the slot unseen — a computed
  key, code outside the analysed sources, an array, a class field other code can read, a
  computed key on the instance of a class that holds it, a function nobody in the analysed
  sources calls — is an escape, and so is a read the following sees that no
  reference followed: either makes the sender open, whatever else reads it, so a sender is
  unresolved. A slot that no use of its object reads, with no escape, is listed as unread
  (`unreadSlots`) instead of open. Each call's payload is the
  template of every sender the callee may hold, each with the call's arguments substituted
  for its own parameters, so it is the final form, with every spread and field replacement
  the wrappers applied, and with what was done to the payload before the send: its writes
  (one key down included, through an alias included), and the effects of the functions it
  was handed to, read from their bodies. A payload sent through an alias (`const a = b`,
  `const { data } = b`) carries what was done to `b` up to the send, after the alias too. A
  sender's payload, or its data, handed before the send to code whose effects are not
  modeled makes the call unresolved; handed to a frame sender, it keeps its shape, since a
  send is a delivery and the transport's body is not analysed. A member reached only through
  a declared type (the checker sees its signature, no body) is code whose effects are not
  modeled, unless a per-version declaration names it read-only (`READ_ONLY_MEMBERS`, beside
  `SENDER_ROOTS` in the extractor): the type and member, the argument, the upstream
  evidence, and the fingerprint (`sha256`) of every body that evidence rests on. The
  declaration holds only while it is checked true at the version derived: each body present
  and unchanged, the member still declared, the named factory still providing it, and no
  other object of the analysed sources providing it; otherwise the derivation refuses and the
  entry is reviewed again. At 2026.9.36 it names `ChatRunState.recordProgressEvent`, which
  copies the event (JSON round trip) and writes nothing into it. A bus emission's object takes
  the same writes and modeled effects; an effect not modeled there is a limit the soundness
  contract states. A literal stream is a fabricated frame; an agent event passed on with its
  own data (or its data plus a recorded rewrite) is a relay with its origins named; a call
  whose event or final payload cannot be evaluated is unresolved, and vendoring refuses it.
  A sender only plugins can call (reached from the public plugin
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

### The extractor's soundness contract

**What it guarantees.** Every sender the transports hand out is found by symbol, from the
known set and the contracts `SENDER_ROOTS` declares. Every reference to an emitter or a
sender is classified, an identifier or a literal key alike (`completeness.unaccounted`
is 0). Every call it reaches is evaluated to its final payload. What it reports is one of
the following:

- a fabricated frame;
- a relay with its origins;
- an open entry that only plugins can call;
- an unread slot, with the proof that no use reads it;
- an opaque row naming the value it could not read;
- an unresolved call.

**What it refuses instead of guessing.** Vendoring stops, naming each site, on:

- an unaccounted reference;
- an unresolved sender call: an event not evaluated, a payload not determined, a payload
  (or its data) handed beforehand to code whose effects are not modeled, or a sender whose
  object escapes;
- a listed sender absent;
- a contract the signature does not bear out;
- a candidate sender nobody listed;
- a transport moved;
- a read-only member declaration that no longer holds: a body changed or absent, the member
  or its factory gone, another object providing the member.

The inventory it refused is kept for examination. The extractor is corrected, never the
inventory.

**Its known limits.** A static analysis of an arbitrary program cannot be complete: values
computed at run time, reflection, code loaded from outside the analysed sources and
aliasing beyond what it follows escape it by nature. In particular:

- a write through another holder of the object it does not follow (an object stored in a
  map and written there later) is not seen;
- an instance whose private field holds the object is not followed where it is handed: a
  read of that field there under a computed key is not seen;
- the following of an object that holds a sender is bounded (depth, number of bindings):
  past the bound the object escapes, and the sender is unresolved;
- a send is taken to leave its payload as it was: the transport's body is not analysed, so
  a transport that wrote into a payload before a second send of it would not be seen;
- a member declared read-only is trusted as reviewed: the fingerprints lock the bodies the
  review read, not the functions those bodies call, which the review covers only at the
  version it names;
- an effect is valued from a function's body only to a bounded depth, and a library function
  counts as having no effect only when it is named as such. Past that bound, a callee that
  only reads the object, through every call it hands it on to, has no effect (read once per
  function, whatever the depth); a callee that writes into it there, and code outside the
  analysed sources at any depth:
  - make a sender's call unresolved, naming what was reached;
  - are not marked on a bus emission's object: its row carries the keys the evaluator sees;
- the evaluator is flow-insensitive beyond straight-line code before the send;
- a value known only by its declared type is an over-approximation.

The two nets below cover what the analysis cannot see, and the unmarked bus effects.

**The two nets at run time.**

- **The bench's emission check.** Every frame captured on the live bench must be in the
  inventory. A captured frame the inventory does not carry, on a core stream, is a defect
  of the extractor, not of the gateway.
- **The drift detector in production** counts, by stream, every phase and key that the
  supported version's inventory does not carry, under the naming rules above.

**When one fires.**

- **The bench check reports a frame.** Find the emitter in the upstream source and write a
  synthetic mirror of the form the extractor missed. Correct the extractor so the mirror
  passes, or so it refuses the form. Then re-derive the version and classify what the new
  inventory adds.
- **The drift detector reports a shape.** Read the digest or the name it counts, and see
  whether the supported version emits it (the inventory and the upstream source).
  - If it does, the inventory missed it: the bench check's procedure applies.
  - If it does not, the gateway runs a version or a plugin the support does not cover.
    That is a version question, not an extractor one.

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
