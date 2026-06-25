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
turn), `--deltaChars` (pad each delta toward a realistic reply size), `--deltaMs`
(cadence between deltas), `--settleMs`, `--assert` (regression-gate mode, below), and
connection overrides `--url` / `--site` / `--secret` (default to the local dev ports
+ `devingest`).

## Regression gate (`--assert`) — guard against FUTURE perf regressions

```bash
node scripts/loadtest/run.mjs --users 3 --chats 3 --agents 6 --instances 1 --deltas 30 --deltaMs 30 --assert
```

With `--assert` the run prints the usual report, then checks **structural** (count-based,
not timing-flaky) thresholds and **exits non-zero on a breach** — so a change that
regresses the streaming perf invariants fails this gate. It is the load-test half of the
"no perf regressions in future development" guard (the unit-test half lives in
`convex/bridgeIngest.test.ts` — the 0.9.0 subscription-split read-set invariant). It needs
the local dev stack (Convex `:3212`/`:3213`), so run it as a **pre-release / on-demand
gate**, not in the no-backend CI unit run. The thresholds (CFG-relative):

- **push amplification ≤ `deltas*0.6 + 2`** — a reactive query must not re-push more than
  the full live text per flush (the live-text isolation / 0.9.0 split holding). Baseline ≈ K/2.
- **re-runs/subscriber ≤ `chats*(deltas+12) + 30`** — a subscriber must re-run only for its
  OWN chats' turns; a cross-user amplification regression (re-runs scaling with TOTAL chats)
  trips it. (Verified: injecting the 0.9.0 regression — `appendDelta` also patching the
  `messages` doc — pushed re-runs/sub from ~104 to ~195 and the gate FAILED, exit 1.)
- **appendDelta write late/early ratio ≤ 2.5** — catches a per-delta write growing with
  position (an O(n)/delta → O(n²)/turn write regression).
- **ingest errors = 0**.

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
