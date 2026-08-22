# Hybrid rehydration — rolling summary + verbatim tail

## The constraint

Atrium is the source of truth for conversations; gateway sessions are ephemeral
— they reset daily and on idle, and a multi-agent chat re-keys its session per
turn. So on every fresh session the bridge has to re-establish the conversation
by prepending one text block to the user's message
(`internal.stream.rehydrationContext`).

That block competes with the turn itself for the model's context window, and
three properties follow:

- **A purely verbatim tail costs tokens in proportion to the window.** A
  200k-token model would re-ingest hundreds of thousands of characters of
  history on every cold start — daily, and on every agent switch in a
  per-turn-routed chat.
- **Anything past the budget is gone.** A tail alone loses the beginning of a
  long conversation entirely, so what was agreed early is unavailable.
- **The gateway cannot compensate.** A provider whose context engine owns
  compaction skips the gateway's own safeguard, and an oversized context fails
  the turn outright. Rehydration must therefore fit the budget before the
  request is sent, not rely on anything downstream trimming it.

## How the context is composed

Two independent layers, both provider-agnostic — nothing beyond an ordinary
`chat.send` is required of the gateway.

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

## Deliberate limits

- **No retrieval tools over compacted history.** The Sources panel and the
  agent's own tools cover targeted recall.
- **One rolling summary per chat, updated incrementally** — no
  re-summarization hierarchy. A chat's history is bounded enough that a flat
  summary holds.
- **No UI surface.** This is invisible infrastructure; the context meter
  already shows session usage.
