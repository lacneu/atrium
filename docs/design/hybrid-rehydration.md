# Hybrid rehydration — rolling summary + verbatim tail

## Problem

Atrium is the source of truth for conversations; gateway sessions are ephemeral
(daily/idle resets, per-turn re-keying for multi-agent chats). On every fresh
session the bridge re-injects the conversation as ONE text block prepended to the
user's message (`internal.stream.rehydrationContext`). Today that block is a
purely VERBATIM tail budgeted at ~50% of the model's context window:

- **Token waste that scales with the window.** A 200k-token model re-ingests up
  to ~300k characters of history on EVERY cold start — daily, and on every
  agent switch in a per-turn-routed chat.
- **Everything beyond the budget is silently dropped.** Long conversations lose
  their beginning entirely (`[…début omis…]`); the agent has no idea what was
  agreed weeks ago.
- **The gateway cannot compensate.** OpenClaw's own compaction is inert on
  codex-style providers (`ownsCompaction=true` skips the safeguard — upstream
  issues #7477/#15669/#71325, closed stale; see
  `openclaw-notes/docs/runbook-context-overflow.md`). Oversized contexts crash
  the agent ("Context overflow", event-loop saturation).

## Prior art considered

- **lossless-claw (LCM plugin)** — chunk summaries condensed into a DAG +
  verbatim fresh tail + retrieval tools, stored in SQLite on the gateway.
  Excellent for the gateway's OWN long-running sessions, but it does not solve
  Atrium's problem: our rehydration payload is assembled ATRIUM-side and injected
  into a *fresh* session — LCM never sees the history it would need to compact,
  and a giant first message still burns the tokens. It also couples every
  instance to a plugin install + version floor (2026.5.12+) and does not exist
  for Hermes. It remains a fine OPTIONAL gateway-side complement for in-session
  growth between resets.
- **OpenClaw Dreaming** — background consolidation (cron, off-hours) of session
  transcripts into durable memory. Philosophically the model we adopt:
  consolidate ASYNCHRONOUSLY, off the hot path, so the hot path stays instant.

## Solution

Two independent layers, both provider-agnostic (no gateway feature used beyond
ordinary `chat.send`):

### 1. Budget-capped hybrid composer (hot path, instant)

`rehydrationContext` now composes, within `min(windowBudget, 60k chars)`:

```
[header]
[Résumé de la partie antérieure de la conversation (N messages) :]
<rolling summary — bounded to ~35% of the budget>
[…messages intermédiaires omis…]          (only when a coverage gap exists)
Utilisateur : …                            (verbatim tail, newest-first budget walk,
Assistant : …                               chronological render — unchanged format)
[footer]
```

- The **hard cap** (60k chars ≈ 20k tokens) bounds the cold-start cost on any
  window size — the summary carries the older context instead of raw verbatim.
- The composer is a PURE function (`convex/lib/rehydration.ts`), fully unit
  tested; `rehydrationContext` feeds it data.
- **Fallback ladder** (never blocks, never degrades below today's behavior):
  no summary yet / engine disabled / summary lagging → verbatim tail + honest
  omission marker, exactly like today (plus the cap). Rehydration NEVER waits
  for summarization.

### 2. Rolling-summary engine (async, mirrors the documentary pattern)

A per-user HIDDEN chat (`chats.kind = "summarizer"`) hosts summarization turns,
exactly like the documentary-fetch engine (`kind:"documentary"`):

- **Trigger**: after a regular chat turn finalizes, `maybeScheduleSummarize`
  checks: enough unsummarized chars since the watermark (admin-tunable per
  instance, default 8k), no job in flight
  (`pendingSummarize` + `isChatBusy` — serial per user), failure backoff
  elapsed, injection enabled. All guards fail → do nothing.
- **Job**: rotate `openclawChatId = summarize:<chatId>:<ts>` (fresh gateway
  session), force `rehydration:false` (same override as documentary), bind the
  hidden chat to the admin's DEDICATED summarizer agent when one is granted on
  the chat's instance (agent type `"summarizer"`, resolved default-first like
  the documentary type — same-instance REQUIRED so content never leaves its
  gateway), else the TARGET CHAT'S OWN agent (a boundary the content already
  crossed). Send ONE prompt = the `history_summary` injection filled with
  {previous_summary} + {new_messages} (the chunk between the watermark and the
  target, ≤ 24k chars, cut at a turn boundary).
- **Correlate**: at `stream.finalize` of the hidden chat (mirroring
  `correlateDocumentaryFetch`, with the same late-finalize guard), store the
  reply as the new summary (clamped to 6k chars), advance the watermark,
  reset failures. Error/aborted/empty → failure backoff (5min × 2^n, cap 6h).
- **Stuck healing**: the existing stuck-streams watchdog releases
  `pendingSummarize` the same way it releases `pendingFetch`.
- **Catch-up**: each job advances the watermark by one bounded chunk; a long
  backlog converges over successive turns. The composer stays honest about the
  gap meanwhile. The chunk pool is read ASCENDING FROM THE WATERMARK (a paged
  scan that skips dense already-covered regions), in LOGICAL message order, with
  a 6-hour creation-time slack for queued follow-ups — no window anchoring can
  silently mark unread history as covered, and short-message backlogs still
  advance (full-window jobs may go below the 8k minimum). The FRESH TAIL kept out
  of summarization is SIZE-based (newest turns up to ~12k chars, min 4 / max 12
  messages) — a conversation of a few huge digests still becomes summarizable.
- **The LLM doing the work is the agent's own model via OpenClaw** — no local
  compute (Synology CPU-only), no new credentials, works identically on every
  OpenClaw version Atrium supports and on Hermes later (it is just a turn).

### Storage

New table `chatSummaries` (one row per conversational chat):
`{ chatId, summary, watermarkOrderTime, coveredCount, updatedAt, failureCount,
nextEligibleAt }`. The in-flight job state lives on the hidden chat's
`pendingSummarize { targetChatId, watermarkTarget, coveredCountTarget,
createdAt }` (the documentary `pendingFetch` shape).

### Configurability

- **Which agent summarizes**: mark an agent with the `"summarizer"` type
  (Instances ▸ agent curation) to dedicate it; none ⇒ each chat's own agent.
- **The prompt framing**: the `history_summary` entry in the prompt-injection
  registry — per-instance customizable and togglable. **Disabling removes ONLY
  Atrium's framing** (the job ships the bare material for an agent whose own
  briefing carries the instructions) — it never turns the feature off.
- **The feature switch**: the instance's `rehydration` config (Bridge settings).
  Rehydration off ⇒ no summaries are produced (and none would be consumed).

### Invalidation

Deleting a message with `orderTime ≤ watermark` resets the summary row (drop +
watermark 0) — the engine rebuilds from scratch on subsequent turns. Deleting a
chat deletes its summary row and, if it was the target of an in-flight job,
releases the hidden chat's lock. A summary can transiently describe content
that was later deleted mid-job — accepted lossy behavior, like the verbatim
tail it replaces.

### Observability (SOC2 content-free)

Trace events `chat.summary` — op `dispatch` (chunkChars, coveredCount),
`correlate` (summaryChars, watermark advance), `fail` (reason). The bridge's
existing `rehydrate` trace gains `summaryUsed` + `summaryChars` counts.

## Non-goals (v1)

- No retrieval tools over compacted history (lcm_grep-style) — the Sources
  panel + the agent's own tools cover targeted recall; revisit if needed.
- No re-summarization hierarchy (DAG): ONE rolling summary per chat, updated
  incrementally, is sufficient at chat scale (vs LCM's agent-lifetime scale).
- No UI surface: invisible infrastructure. The context meter already shows
  session usage.
