# Atrium load harness

A local, opt-in harness that characterizes how the backend behaves under many
**concurrent chats across multiple instances**, and acts as a standing regression
gate for the reactive read path (e.g. the 0.9.0 subscription split, future Hermes
work). It is **not** wired into CI and spends **no** model tokens.

## What it does

One process, two halves (one tool by design — no k6/Artillery):

- **Subscribe side** — `ConvexClient` (the real reactive WS path): spawns `R` authed
  "browsers", each subscribing to the hot queries `listChats`, `getChatAgent`,
  `listByChat`, `getStreamingText` on its `C` chats. Counts `onUpdate` callbacks
  (the real re-run signal) and measures update latency.
- **Synthetic write side** — plain HTTP `POST /bridge/ingest`: drives a turn per
  chat (`startAssistant` → `K` `appendDelta` → `finalize`) concurrently across every
  chat. It hits the ingest **contract**, not vendor frames, so it is OpenClaw- and
  Hermes-agnostic, and needs no gateway.

It reports first-delta + finalize latency percentiles, reactive re-runs per
subscriber during the write burst, and ingest errors.

## Prerequisites

The local dev stack must be running (`bash dev.sh` → Convex API on `:3212`, HTTP
actions on `:3213`), with `OPENCLAW_ENABLE_ANON_AUTH=1` and `BRIDGE_INGEST_SECRET`
set on the deployment (both are already set for local dev). The harness uses the
dev-gated seeders in `convex/dev.ts` (`seedAgentCatalogue`, `seedChatsForUser`,
`deleteAgentsByInstance`, `makeGrantlessUser`, `enrichProbe`).

## Run

```bash
node scripts/loadtest/run.mjs --users 10 --chats 5 --agents 300 --instances 2 --deltas 15
```

Flags (all optional): `--users` (R browsers), `--chats` (C per user), `--agents`
(catalogue size, split across `--instances`), `--instances` (M), `--deltas` (K per
turn), `--deltaMs` (cadence between deltas), `--settleMs`, and connection overrides
`--url` / `--site` / `--secret` (default to the local dev ports + `devingest`).

`provision()` is idempotent: it deletes the harness's `lt-inst-*` agents before
re-seeding, so repeated runs don't accumulate a growing catalogue. It does NOT reset
the whole DB — anonymous users + their chats/messages accumulate across runs (they
are owner-scoped and don't skew per-subscriber metrics). To clear everything,
`npx convex run dev:reset '{}'`.

## How to read it

- **first-delta latency** = `startAssistant` → the subscriber sees the first token
  (via `getStreamingText`). Grows with total concurrent turns — the streaming-WRITE
  throughput of the single backend (+ this single-process driver).
- **finalize latency** = `finalize` → the subscriber's `listByChat` reflects the
  completed message. Should stay LOW and roughly FLAT as concurrency grows — the
  read path is owner-scoped and (since 0.9.0) does not re-run per delta.
- **re-runs / subscriber** should be bounded by that user's OWN chat count, NOT total
  system concurrency. A jump that scales with *users* (not own chats) is a
  cross-user re-run amplification regression — investigate.
- **ingest errors** should be 0. A "too many … (limit: …)" throw is a per-function
  cap blow (read it against the 32k-docs / 4,096-calls / 16-MiB limits).

The `authprobe.mjs` script is a standalone check that anonymous dev auth + bootstrap
+ an authed query work from Node (the foundation the harness builds on).
