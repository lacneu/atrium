# Protocol Contract — schema-driven, per-version bridge compatibility

Status: ALL THREE increments SHIPPED. Inc 1 = vendored schema @2026.6.11 +
coverage manifest + CI ratchet (`bridge/protocol/openclaw/` +
`bridge/test/protocol-coverage.test.ts`). Inc 2 = runtime drift detector
(`bridge/src/providers/openclaw/protocol-drift.ts`, observe-only, wired into
RunManager.feed; exposed as the additive `protocol` section of /capabilities —
version + COVERAGE_SUMMARY matrix + drift; runtime sets bijection-tested
against the manifest). Inc 3 = the compat poller picks + bounds + persists the
section (drift UNIONED across multi-bridge deployments) and Settings ▸ Bridge
renders it per provider: "aligned"/drift badge, vendored version, coverage
counts, collapsed declared-gap list. Companion to the factual audit in
[protocol-schema-coverage.md](protocol-schema-coverage.md).

## Problem

The bridge converts Atrium ↔ gateway wire protocols (OpenClaw today, Hermes
next). Today the answer to "which protocol features does the bridge support,
against WHICH exact gateway version, and what changed?" lives in three places
that drift independently:

- the hand-maintained capability manifest (`bridge/src/compat.ts`, VCOMPAT:
  capability → minVersion) — feature-level, coarse;
- the normalizer/observer code itself — the de-facto truth, readable only by
  audit (the coverage report above took a dedicated pass);
- tribal memory of what each validated OpenClaw version emits (fixtures pin
  individual shapes, not the full surface).

Meanwhile OpenClaw publishes the authoritative wire contract as TypeBox
schemas (`packages/gateway-protocol/src/schema/*.ts`), generated to JSON
Schema, versioned by git tag. The gateway validates inbound frames against it.
Nothing on our side consumes that artifact — every protocol evolution reaches
us as a runtime surprise (e.g. the announce runs this week).

## Solution — three increments, strongest-determinism first

### Increment 1 — Vendored per-version schema + coverage manifest (CI ratchet)

**Vendor the contract.** For each gateway version in the validated range
(the same range VCOMPAT names), vendor the protocol schema into the repo:

```
bridge/protocol/openclaw/2026.6.10/   # generated JSON Schema or TypeBox source
bridge/protocol/openclaw/coverage.json
```

**Author the coverage manifest once** (seeded from the audit): every leaf
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

Outputs: a generated, human-readable support matrix (doc or /compat payload)
— the factual "voici ce qu'Atrium supporte, voici ce qu'il ne supporte pas".

### Increment 2 — Runtime drift detector (observe-only, never gating)

The bridge already tallies inbound frame shapes per turn (`tallyFrame`).
Extend it: classify each shape against the vendored schema matching the
CONNECTED gateway's hello version.

- Unknown event/field → bounded counter + ONE SOC2-safe log line (shape only,
  never content) + exposed on `/compat` as `protocolDrift`.
- **Frames are NEVER rejected.** Unknown fields flow through exactly as today
  (robustness first — the gateway may legitimately be newer than the bridge).
- Deterministic: same frame → same classification; counters reset per process.

This is the early-warning for the operational reality: the NAS updates
OpenClaw before the bridge image. Today that surfaces as user-visible
weirdness; with drift detection it surfaces as an admin-visible counter the
day it starts.

### Increment 3 — Surface it: /compat → Convex → Bridge tab

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

## What this buys (mapped to the ask)

| Ask | Mechanism |
|---|---|
| "features supportées par Atrium / pas supportées" | coverage manifest → generated matrix |
| "supporté par le bridge pour une version EXACTE" | vendored schema per validated version + hello-version match |
| "les différences à prendre en compte" | CI ratchet lists every unclassified new field on version bump |
| "forte robustesse" | drift detector is observe-only; frames never rejected |
| "plus déterministe" | classification is static (CI) + pure (runtime); no guesswork left in code review |

## Non-goals

- Runtime schema VALIDATION as a gate (reject frames) — explicitly rejected:
  the normalizer's tolerance is a feature; the contract layer observes.
- Auto-generating the normalizer from the schema — the normalizer encodes
  BEHAVIOR (graces, dedup, isolation), not just shapes.

## Seed backlog (from the audit, ranked)

1. ~~`chat.error.errorKind`~~ — DONE: `handleChat` terminalizes main-lane
   `chat:error`/`chat:aborted`, allowlists `errorKind`, persists it as the
   message's `errorCode` (actionable localized headline in the error card) and
   flags `context_length` on the `chat.gateway_pressure` trace.
2. ~~`usage` on main-lane final~~ — RESOLVED at the source that actually
   exists: the real gateway never emits `usage` on chat events (0 occurrences
   across live captures — the manifest note documents it); main-turn cost rides
   `sessions.describe` instead (SessionPanel cumulative + `chat.gateway_pressure`
   `costUsd`, per-turn = delta between consecutive traces).
3. `replace=true` on bare `deltaText` — honor replacement (one-line fix +
   fixture).
4. ~~Main-lane `chat:error`/`aborted` terminalization~~ — DONE (same code
   path as item 1; the 180s recv-timeout hang on an unpaired chat:error is gone).
5. `AgentInternalEventSchema` — the formal announce input contract; future
   source for structured announce results (status/statsLine/attachments).
