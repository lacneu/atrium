# OpenClaw Upstream Interpretation Comparison — Control UI vs Atrium Bridge

Factual comparison of how the **official OpenClaw Control UI** (the `ui/`
client in the upstream repo) and the **gateway source** interpret the
WebSocket protocol, versus the Atrium bridge normalizer
(`bridge/src/providers/openclaw/normalizer.ts`) and turn-sink
(`bridge/src/core/turn-sink.ts`). Companion to
[PROTOCOL_CONTRACT.md](PROTOCOL_CONTRACT.md), which describes the vendored-schema
ratchet; the per-field classification lives in the coverage manifests under
`bridge/protocol/openclaw/coverage/`.

Reference source: `github.com/openclaw/openclaw` at tag **`v2026.9.2`** — the
exact `maxValidated` gateway version in `bridge/src/compat.ts`. Upstream
references below (`$UP/…`) are paths inside that tag. The Control UI is a
**reference interpretation, not a spec**: where Atrium diverges on purpose
(multi-version support, multi-instance, two providers, durable persistence),
the divergence is documented as deliberate rather than "fixed".

No internal offset: the runtime drift detector vendors its schema at
`2026.9.2` (`DRIFT_VENDORED_VERSION`, `protocol-drift.ts`), the same version as
the validated ceiling. An unknown-field warning against a 2026.9.x gateway is
therefore real drift, not schema staleness — it names a field the published
contract does not declare, and should be read as such.

**Revision of 2026-09-06 (v2026.9.1 → v2026.9.2).** Re-verified zone by zone
against the upstream tag (report:
`openclaw-notes/atrium/bench-runs/upstream-diff-2026.9.1-vs-2026.9.2/`), then
proved live: full catalogue GO 11/11, attestation
`bridge/protocol/openclaw/2026.9.2/BENCH.json`. Nothing Atrium reads on the
wire changed shape; what moved is called out inline under **Changed since
2026.9.1** in §1, §2 and §5. §3 and §4 were re-checked and still hold. The one
behavioural change is in §5: the `chat.send` idempotency key is now bound to
the content it was first used with.

**Revision of 2026-09-03 (v2026.8.2 → v2026.9.1).** Re-verified zone by zone
against the upstream tag (report:
`openclaw-notes/atrium/bench-runs/upstream-diff-2026.8.2-vs-2026.9.1/`), then
proved live: full catalogue GO 11/11, attestation
`bridge/protocol/openclaw/2026.9.1/BENCH.json`. What moved between 2026.7.1 and
2026.9.1 is called out inline below under **Changed since 2026.7.1**; nothing
Atrium reads regressed, and one latent break — dead since 2026.8.1 — was found
and fixed (§3). Sections without such a note were re-checked and still hold.

---

## 1. Chat lifecycle: `delta` / `final` / `error` / `aborted`, `stopReason`, `errorKind`

### Upstream contract

The wire contract is the TypeBox union `ChatEventSchema`
(`$UP/packages/gateway-protocol/src/schema/logs-chat.ts:197-202`), four frames
discriminated by `state`, common base `{runId, sessionKey, agentId?,
spawnedBy?, seq}`:

| `state` | Own fields | Emitted when |
|---|---|---|
| `delta` | `deltaText` (required), `replace?`, `message?` (cumulative snapshot), `usage?` | per assistant stream frame, throttled 150 ms; a buffered delta is flushed just before any terminal (`server-chat.ts:789-935`) |
| `final` | `message?` (may be absent), `usage?`, `stopReason?` | lifecycle `end` whose terminal outcome is `done` (`server-chat.ts:954-1002`) |
| `aborted` | `message?` (partial text), `errorMessage?` (tool-validation summary only), `stopReason?` | terminal outcome `cancelled`/`aborted`, or direct `broadcastChatAborted` (`chat-abort.ts:422-465`) |
| `error` | `errorMessage?`, `errorKind?`, `usage?`, `stopReason?`, `message` = `"Error: …"` text | lifecycle `error`, or `end` classified `failed`/`timed_out`/`hard_timeout`; lifecycle errors get a 15 s retry grace before emission (`server-chat.ts:186,772-787`) |

**`stopReason` is a free-form string at the wire level** (`Type.Optional(
Type.String())` — no wire enum). Producers: the model runtime enum
`"stop"|"length"|"toolUse"|"error"|"aborted"` (`$UP/packages/llm-core/src/
types.ts:283`, raw provider values like `end_turn` may also pass through) and
gateway abort paths (`"aborted"`, `"restart"`, `"timeout"`, `"rpc"` = the
user Stop default, `"auth-revoked"`; arbitrary caller values like `"user"`
also occur). Crucially, **the gateway consumes stopReason before emission**:
`buildAgentRunTerminalOutcome` maps it into `state` (`rpc|stop` → `aborted`
only when status ≠ ok; `timeout` + aborted → **`error`**, not `aborted`;
stale-generation `restart` frames are suppressed entirely —
`$UP/src/agents/agent-run-terminal-outcome.ts:96-174`,
`server-chat.agent-events.test.ts:2966-2989`).

`errorKind` is a closed enum `refusal | timeout | rate_limit | context_length
| unknown` (wire mirror `ChatEventErrorKindSchema`,
`$UP/packages/gateway-protocol/src/schema/logs-chat.ts:282-288`). It is
populated from a structured kind on the lifecycle event, then from the
`FailoverReason` (`server-chat.ts:240-288`), then from a timeout probe; in
practice the fallback never yields `"unknown"`, and a generic 5xx is
deliberately left unbadged.

**Changed since 2026.7.1** (re-verified at v2026.9.1, no impact on what the
bridge reads):

- **`message` is no longer emitted on `state:"error"`** (since 2026.8.1):
  `emitChatTerminal` omits it and the upstream tests assert its absence
  (`server-chat.agent-events.test.ts:5120`). The `"Error: …"` prefix is now
  built by the Control UI (`chat-gateway.ts:174-179`). Atrium reads
  `errorMessage` first, so nothing changed for it — but the `message` fallback
  in its coverage manifest is dead code against a ≥2026.8.1 gateway.
- **`detectErrorKind` is gone from the core** (deprecated shim in
  `plugin-sdk/infra-runtime.ts:34-77`); the derivation above replaced it. The
  enum and its five values are unchanged.
- **NEW `errorDetail` on `state:"error"`** (2026.9.1,
  `logs-chat.ts:337-391`): a bounded, redacted record — `provider`, `model`,
  `failoverReason`, `providerRuntimeFailureKind`, `providerErrorType`,
  `httpStatus`, `providerErrorMessagePreview`. Purely additive: `errorMessage`
  is still emitted. The Control UI reads exactly one thing from it
  (`providerRuntimeFailureKind === "auth_refresh"`, `chat-gateway.ts:156-168`).
  Atrium does not read it yet — the failure classifier still works from the
  text; the structured field is the better source and is queued
  (`ChatErrorEvent.errorDetail`, gap).
- **A fifth chat state exists**: `state:"status"` (`ChatStatusEventSchema`,
  since 2026.8.1) carries the run's startup phase before any delta. Atrium does
  not read it; it is declared in `KNOWN_CHAT_FIELDS_BY_STATE` so a declared
  state is not reported as drift.
- **`executionSettled`** on the lifecycle terminal (2026.9.1) short-circuits
  the 15 s retry grace: a settled failure reaches the wire immediately instead
  of after the grace. Atrium finalizes on the lifecycle itself — no impact.

**Changed since 2026.9.1** (re-verified at v2026.9.2, no impact on what
Atrium reads): (a) under socket back-pressure the gateway coalesces a run's
pending text deltas per client (`liveText: {group, coalesce}` in
`server-broadcast.ts:503-530`) — fewer `chat:delta` frames with longer
`deltaText` and a non-contiguous `payload.seq`; the envelope `seq` stays
contiguous and a terminal always drains the queue first, and Atrium reads the
cumulative `message` snapshot before any delta (`normalizer.ts`); (b) a
replaceable provisional assistant item (`replace:true, replaceable:true`) now
clears the prefix on the cumulative text, so the `final` and the assistant
stream agree; (c) a retryable HTTP 5xx or a reset is no longer promoted to
`stopReason:"timeout"` — only a recorded timeout is (`run-termination.ts:134-156`),
and `providerStarted` may arrive without `timeoutPhase`; (d) request-side only:
`chat.history` gains `maxBytes`, `chat.metadata` gains `authProfileId`,
`chat.startup` accepts a short id, and `chat.send` gains `mentions` — none
sent by the bridge, all optional.

### Control UI interpretation

The Control UI's **live event reducer reads neither `stopReason` nor
`errorKind`**. Its `ChatEventPayload` type does declare `stopReason` (and
`errorDetail`, `yielded`; not `errorKind`) —
`$UP/ui/src/pages/chat/chat-history.ts:186-200` at v2026.9.2 — but the
reducer discriminates on `state` only: `final` → done, `aborted` →
interrupted/killed, `error` → interrupted/failed + raw `errorMessage` banner
(`$UP/ui/src/pages/chat/chat-gateway.ts:155-280`, unchanged 9.1 → 9.2). The
only readers of `stopReason` in the UI work on persisted history records
(`chat-agent-run-grouping.ts:58-62,116-129`, `terminal-reply-recovery.ts:24-28`)
and on the talk result, never on a live frame. On `error` it
materializes already-streamed parts as visible messages and shows the error
banner *next to* the kept text.

### Atrium behavior and verdict

- The normalizer's refusal to reclassify `chat:aborted` by `stopReason`
  (`normalizer.ts:898-909`) **matches the reference interpretation exactly**:
  `state` already carries the gateway's decision. Client-side stopReason
  interpretation would duplicate (and risk diverging from) a classification
  the gateway has already rendered.
- Atrium extracts **more** signal than the Control UI, not less: bucketed
  `stopReason` telemetry (`KNOWN_STOP_REASONS`, `normalizer.ts:192-203`),
  `errorKind` persisted as message `errorCode`, plus its own actionable
  classes upstream does not have (`context_length` via widened text regex —
  live gateways rarely populate `errorKind` — `session_init_conflict`,
  `provider_internal`, `empty_response`/`empty_response_silent`).
- Post-answer `error` frames: Control UI keeps the answer and shows a
  banner; Atrium finalizes `complete` and downgrades the class to a
  diagnostic trace (`turn-sink.ts:1379-1383`). Same "keep the text" spirit,
  different surface — deliberate (Atrium chats are durable documents; a
  transient provider hiccup after a full answer is telemetry, not UX).
- Diagnostic nit: our stopReason bucket list spells `tool_use` /
  `content_filter` (Anthropic style) while the upstream model enum emits
  `toolUse` — such values land in the `"other"` bucket. Trace-only impact.

---

## 2. Announce/delivery vs `chat.send`: session contention

### Upstream policy — there is no kill policy

At v2026.9.1 upstream still has **no deliberate preemption** in the
announce×send race. Contention is resolved by:

- **Steering**: a `chat.send` arriving while a run is active on the session
  defaults to queue mode `"steer"` — the message is **injected into the
  active run** (`$UP/src/auto-reply/reply/queue/settings.ts:30-36`,
  `agent-runner.ts:1263-1304`). Refused steering degrades to a FIFO
  **followup queue** drained after the active run ends. Only queue mode
  `"interrupt"` (or `/reset`) aborts the active run.
- **Announce delivery**: a sub-agent announce steers into the requester's
  active turn ("internal handoffs into an active requester turn",
  `subagent-announce-delivery.ts:674-725`) or, when the requester is idle,
  runs as a separate in-process `agent` run whose `idempotencyKey`/runId is
  `announce:v1:<childSessionKey>:<childRunId>`
  (`$UP/src/agents/announce-idempotency.ts:11-18`) — the exact shape
  Atrium's `isDeliveryRunId` recognizes. **An announce never kills a user
  turn by design.**
- **Admission serialization**: `beginSessionWorkAdmission` queues new work
  per session identity — newcomers wait, they do not steal
  (`$UP/src/sessions/session-lifecycle-admission.ts:327-378`). Only
  `sessions.reset`/`sessions.delete` interrupt admissions (dying with
  `stopReason:"restart"`).

The bidirectional kills observable in production are therefore **emergent,
not policy**. Since 2026.8.1 the mechanism is the SQLite transcript write
fence (see §3): the run whose transcript write finds the session claimed by
another writer dies with `SessionTranscriptWriterClaimReboundError`
(`$UP/src/agents/transcript-write-context.ts:239`), or a starting run finds
its turn already claimed (`ActiveTurnClaimError`,
`$UP/src/agents/placement-turn-claims.ts:57`). The pre-2026.8.1 prompt-lock
takeover this section used to cite is gone. Which side loses depends on
timing — both directions of the race are possible, consistent with what
Atrium has observed. Re-verified at v2026.9.2: `queue/settings.ts` is
byte-identical (default `steer`), no `status:"queued"` ack exists on
`chat.send`, and the announce id stays `announce:v1:<childKey>:<childRunId>`.

**Changed since 2026.9.1**: an announce that cannot wait for the requester's
transcript commit (`transcript_commit_wait_unsupported`) is no longer
downgraded to a best-effort re-steer — it takes the direct path, so one more
`announce:v1:…` run may reach the parent session instead of an invisible
injection (a path Atrium already merges); a requester recovering from a
timeout answers `completion_handoff_pending` (retryable, no frame) rather than
delivering. Neither is a kill; the direct announce still goes through
admission and waits.

### Wire visibility

- Followup admission is **invisible on the wire** except as an early `chat`
  final (`{status:"ok"}` dedupe entry) — there is **no `status:"queued"`
  ack**.
- A killed run broadcasts `chat` `{state:"aborted", stopReason, message?}`
  plus a lifecycle `{phase:"end", status:"cancelled", aborted:true}`;
  `controlUiVisible:false` runs are killed **without any broadcast**
  (`chat-abort.ts:528`).
- Steering emits **nothing** at injection time; the text appears inside the
  carrying run's stream.

The Control UI keeps its own client-side queue (no dispatch while a run is
active; "Steer" is just a `chat.send` relying on the gateway's steer mode).

### Atrium behavior and verdict

- Atrium's recovery model (`convex/preemptRepark.ts`: `reparkIfBusy` for one
  direction, `preemptOpenTurn` + repark for the other) **covers both
  observable outcomes correctly**. However, comments attributing the kill to
  a gateway "one run per session" policy (`preemptRepark.ts:5-8`,
  `run-manager.ts:348-352`, `convex/bridge.ts:1037-1039`) describe an
  emergent takeover mechanism as if it were deliberate gateway policy — the
  policy does not exist in upstream code. The recovery is right; the causal
  attribution in the comments is not.
- The `gatewayPreempted` signature (`chat:aborted` + zero content + no user
  Stop, `turn-sink.ts:1218-1238`) intercepts exactly the
  `broadcastChatAborted` frame — but upstream emits that same frame for
  operator `chat.abort`, timeouts, restarts and provider-down; the
  sub-agent-recency proof (`preemptRepark.ts:118-136`) is Atrium's own
  discriminator with no upstream equivalent.
- Deliberate divergence: Atrium's queue lives in Convex (durable outbox),
  the Control UI's lives in browser state. Parallel architectures; the
  upstream followup queue (`chatQueuedTurns` cancellation identities) is not
  modeled by Atrium and does not need to be — the bridge never admits into
  the gateway followup queue.

---

## 3. Session locks: init conflict vs embedded takeover

### Upstream lifecycle

- **`reply session initialization conflicted`**
  (`$UP/src/auto-reply/reply/session.ts`): thrown at the very start of the
  reply flow — before prompt construction, before any model call — when the
  OCC commit of the session-state snapshot loses to a concurrent writer
  twice (one internal retry with a fresh snapshot). **Pre-generation: nothing
  has been generated or streamed; the whole inbound turn dies.** Upstream
  channels treat it as transient and retry with backoff (Telegram/Slack/
  WhatsApp handlers).
- **`session file changed while embedded prompt lock was released`** —
  **GONE since 2026.8.1.** `attempt.session-lock.ts` and
  `EmbeddedAttemptSessionTakeoverError` do not exist in 2026.8.1, 2026.8.2 or
  2026.9.1: transcripts moved to SQLite and the file lock went with them. The
  paragraph that described the release/re-acquire fence applied to 2026.7.x
  only. Atrium's regex for that sentence was therefore **dead against every
  gateway ≥ 2026.8.1**, and with it the "downgrade to complete after streamed
  content" it guarded (found 2026-09-03, fixed — see the verdict below).
- **`session writer claim changed before transcript persistence`**
  (`SessionTranscriptWriterClaimReboundError`,
  `$UP/src/config/sessions/transcript-write-context.ts:239`, identical
  2026.8.1 → 2026.9.1): the SQLite replacement. Every transcript commit
  re-validates the session row's writer claim and lifecycle revision inside
  the transaction (`session-accessor.sqlite-transcript-write.ts:366-417`);
  a rebound refuses the write. **Always mid-turn** — it fires at a commit, not
  at a post-generation re-acquire — so streamed content may already exist.
  Upstream treats it as a runtime COORDINATION error (no model fallback,
  `failover-error.ts:719-723`) but, unlike the 2026.7.x lock, **retries it** on
  the announce path (`subagent-announce-delivery-retry.ts:70` classifies it
  transitory). Refusal codes are redacted (`session-rebound`,
  `session-entry-missing`) — no filesystem path reaches the message.
- **`Session <id> already has an active turn claim`** (`ActiveTurnClaimError`,
  `$UP/src/gateway/worker-environments/placement-turn-claims.ts:57`): joins the
  coordination family at 2026.9.1 (`failover-error.ts:46-52`), so a busy
  session no longer cycles the whole provider fallback chain.
- The init conflict's OCC now also reads the **parent/main** session rows
  (`relatedSessionKeys`, `session.ts:590-601`): same message, but a write on a
  parent session can now trigger it. Upstream retries up to **5 times** with
  250 ms → 4 s backoff (`SESSION_INIT_CONFLICT_MAX_ATTEMPTS`), not the single
  internal retry described above.

None of these messages receives special handling in the Control UI: they arrive
as `state:"error"` with the raw text in `errorMessage`, **no `errorKind`**, no
retry. The UI keeps already-streamed text as messages next to the error.

### Atrium behavior and verdict

- The embedded-flavor **downgrade-to-complete** (gated on `hasRealContent()`)
  was sound for 2026.7.x, where upstream refused any retry once content had
  been emitted ("send evidence"). It is **unreachable on ≥ 2026.8.1**: the
  message it keys on no longer exists. It is kept for the 7.x rows of the
  support matrix and NOT extended to the SQLite successor — deliberately: that
  one is retried by upstream itself, so closing the bubble `complete` could
  present a reply that a retry then supersedes.
- **Fixed 2026-09-03** (`bridge/src/core/failure-classifier.ts`): the three
  ≥ 2026.8.1 coordination messages — the writer-claim rebound, the active turn
  claim, and the `was deleted while starting work` sibling — are classified
  instead of falling into the generic bucket, which was the exact failure mode
  of the 2026-08-04 production incident, latent again since 2026.8.1.
  They do NOT share one class. The active turn claim and the
  `while starting work` sibling are pre-generation, so they join
  `session_init_conflict`, the transient class the bounded auto-retry keys on.
  The **writer-claim rebound is mid-turn** — it fires "before transcript
  persistence", after the model ran and after tools may have had external
  effects — so it has its own `session_write_conflict`, which is deliberately
  NOT in `RETRYABLE_KINDS`: the retry's zero-content gate cannot see work that
  left no visible part, and re-dispatching would repeat it. Pinned by
  `failure-classifier.test.ts`, `convex/turnRetry.test.ts` and by the golden
  frame `writer-claim-rebound-after-content` (which also proves the bubble
  stays an honest error, with content preserved).
- The init-flavor handling (transient `session_init_conflict` + bounded
  auto-retry) matches upstream's own retries — which are up to five attempts
  with backoff at 2026.9.1, not one. Refusing the downgrade for init is
  correct: the error is pre-generation, so no content can have come from that
  turn.

---

## 4. Compaction

### Upstream state machine

Three closed reasons: `manual | threshold | overflow`
(`$UP/src/agents/sessions/agent-session.ts:201,324`).

- `threshold`: runs **between** requests; no run is abandoned.
- `overflow`: the failed assistant message is removed and the LLM request is
  **replayed inside the same run, same `runId`** (one attempt).
- `manual` (`sessions.compact` RPC): an active run is aborted *first*, then
  compaction runs.

Wire signals (all real, all explicit):

- **`{stream:"compaction", data:{phase:"start"}}`** and
  **`{…, data:{phase:"end", willRetry, completed}}`** agent events
  (`embedded-agent-subscribe.handlers.compaction.ts`). Mid-turn overflow
  compaction emits **no lifecycle `end` at all** — the run pauses
  (`livenessState:"paused"`) and continues.
- Manual compaction additionally emits `session.operation`
  (`operation:"compact"`, phase start/end) and `sessions.changed`
  (`reason:"compact"`) to `sessions.subscribe` subscribers — the latter
  carrying the **rotated `sessionId`** (rotation is conditional on
  `truncateAfterCompaction`; the `sessionKey` never changes;
  `usageFamilySessionIds` chains old→new).

The Control UI drives its compaction indicator **entirely from the explicit
signals**: `compaction start` → active; `end` + `willRetry && completed` →
"retrying" until the matching lifecycle terminal; `session.operation` covers
the manual path (`$UP/ui/src/pages/chat/tool-stream.ts:317-495`).

### Atrium behavior

The explicit `{stream:"compaction"}` agent events are the **primary mid-turn
signal** (`normalizer.ts` `handleCompaction`), aligned with the Control UI's
interpretation:

- `phase:"start"` ⇒ one persisted `midturn` marker (per-turn guard shared
  with the fallback heuristic and the rotation detector) + the widened
  silence budget (`COMPACTION_RECV_TIMEOUT`), and **never a buffer reset** —
  the overflow replay continues on the same `runId` with the streamed prefix
  intact (fixture-pinned, `compaction-explicit-stream-signals`).
- `phase:"end", willRetry:true` (the overflow replay — the path that emits
  **no lifecycle end whatsoever**) keeps the widened budget until visible
  content resumes, which restores the normal budget (`applyVisible` — there
  is no lifecycle `start` to key on).
- `phase:"end", willRetry:false` restores the normal budget immediately.
- Total silence after a `start` still settles the actionable
  `compaction_timeout` error (deadlock parity with the heuristic path).
- A `chat:aborted` on the explicit path (active window or overflow replay)
  **terminalizes normally**: upstream never aborts a run to compact mid-turn
  (overflow pauses, threshold runs between requests, manual aborts *before*
  the compaction events), so such an abort is a real user Stop / operator /
  timeout. The abort swallow is reserved for the heuristic path, where the
  abandoned-derived abort genuinely precedes a replay.

The `livenessState:"abandoned"` heuristic is retained as the
**multi-version fallback** (validated gateways ≥ 2026.5.19 emit no
compaction stream; the Hermes provider never does). When explicit signals
were seen in the turn, the heuristic stands down: an abandoned `end` during
an active compaction window is absorbed (the explicit signal governs), and
outside one it is treated as the plain terminal upstream defines
(`replayInvalid` without visible text — a normal follow-on grace, no reset,
no widened wait).

Rotation is still detected via pre-send `sessions.describe` vs first-frame
session id ("preflight"); an explicit compaction suppresses the follow-up
rotation signal (same compaction, one marker).

Remaining deliberate gaps:

1. **`session.operation` and `sessions.changed` (`reason:"compact"`, rotated
   sessionId, checkpoint counts) are not consumed** — the bridge holds no
   `sessions.subscribe` subscription. The manual path is covered by the
   rotation detector and by Atrium's own `sessions.compact` calls.
2. Upstream's `manual/threshold/overflow` taxonomy is not persisted; Atrium
   keeps its `preflight`/`midturn` phases (a free-string field end-to-end,
   so the taxonomy can be enriched without a schema migration).

What Atrium already uses from the explicit API: `sessions.compact` (manual)
and `sessions.compaction.list` (content-free history). The detected events
are persisted as `{kind:"compaction"}` message parts and pressure traces —
a durable surface the Control UI does not have.

---

## 5. `chat.send` idempotency

### Upstream derivation and dedupe window

- **Control UI derivation**: `idempotencyKey` **is** the client-generated
  run UUID (`crypto.randomUUID`), assigned once at enqueue time and **reused
  verbatim on every retry** (`$UP/ui/src/pages/chat/chat-send-queue-state.ts:83`,
  `chat-send-delivery.ts:211,258`, `chat-send-request.ts:53` at v2026.9.2).
  No content hash, no timestamp on the client side.
- **Gateway validation**: `NonEmptyString`, opaque, no normalization — the
  key *becomes* the run's `runId`
  (`$UP/src/gateway/server-methods/chat-send-session.ts:88`; "chat.send
  idempotency keys are exact protocol identities", `chat-queued-turns.ts:39`).
- **Dedupe window**: one `Map<string, DedupeEntry>` **per gateway process**
  (all connections, all sessions). Keys `chat:<idempotencyKey>` (terminal
  results) and `pending-chat:<idempotencyKey>` (admission reservations).
  Sweep every 60 s; **TTL 5 min** (`DEDUPE_TTL_MS`), **cap 1000** entries
  oldest-first — active/pending runs always survive both. Separate
  aborted-run markers live **60 min** (`ABORTED_RUN_TTL_MS`).
- **Duplicate behavior**: a duplicate with the SAME content is always an ack,
  never silence — terminal cached → same payload replayed with
  `meta:{cached:true}`; abort marker → synthesized aborted payload
  (`{runId, status:"timeout", summary:"aborted", stopReason?, endedAt}`,
  `chat-abort-authorization.ts:48-54`); pending/active/queued →
  `{runId, status:"in_flight"}`.
- **Since 2026.9.2 the key is bound to its content.** The gateway stores a
  request identity with the key — `sha256(JSON.stringify([message,
  mentions]))`, `chat-send-request.ts:248-256` — at admission, and a reuse of
  the key with DIFFERENT input is refused: `INVALID_REQUEST` with
  `details.reason: "chat-request-conflict"` and the message "This message ID
  was already used for different input…" (`chat-send-pre-admission.ts:148-155`),
  while the original run keeps running. After the RAM window the comparison
  falls back to the transcript's submitted input (`:189-217`). "Always an ack"
  therefore holds for a faithful duplicate only.
- The announce idempotency family (`announce:v1:<childKey>:<runId>`) is a
  **separate, persisted delivery identity** — unrelated to the chat.send
  dedupe map.

### Atrium behavior and verdict

- Bridge derivation: `webchat-<sha256(sessionKey|clientMessageId)>`
  (`openclaw-client.ts:1007-1018`), stable across Convex's at-least-once
  dispatch — this **exploits the upstream window correctly** (re-POSTs
  replay/`in_flight` while the run is active, since active entries outlive
  the TTL).
- The 2026.9.2 content binding is the one place where a stable key can hurt:
  the bridge composes the sent `message` from the user's text plus, on a
  fresh session, a rehydration prefix (`server.ts`, `computeFreshSession` /
  `rehydrationDecision`) and, per instance, a media-delivery instruction — so
  a re-POST of the same outbox row after a lost ack can carry a different
  text under the same key. Rare in practice: Convex never re-POSTs a row
  (`convex/bridge.ts`), the preempt re-park and the auto-retry mint fresh keys
  (`preempt-<messageId>-<now>`, `autoretry-<id>-<n>-<now>`). When it does
  happen the bridge classifies the refusal as `chat_request_conflict`
  (`bridge/src/core/dispatch-errors.ts`): a downstream rejection with its own
  card, deliberately outside the bounded auto-retry, since the first turn is
  still running on the gateway.
- The `dispatchKey` alias minted on preempt-repark
  (`preempt-<messageId>-<now>`, `preemptRepark.ts:306`) is **confirmed
  necessary and safe** against upstream: the abort path writes *both* the
  abort marker and the terminal `chat:` entry, so a re-POST under the
  original key would replay the "aborted" payload — for up to ~60 min (abort
  marker), not just the 5 min dedupe TTL. The alias's fresh timestamp makes
  every repark a never-seen key regardless of TTL, cap, or gateway restart.
- Theoretical edge (orthogonal to preemption): retrying the *same* message
  more than 5 min after its terminal entry was evicted would start a new
  turn instead of replaying — inherent to the upstream window, shared by
  the Control UI.

---

## 6. Config changes: `config.changed` and the model roster

### Upstream contract

The gateway broadcasts `config.changed` on every persisted configuration change — RPC
writes, `config_set` from an agent or the CLI, doctor repairs, and hand edits of the
config file alike — from one place, `onConfigCandidateCommitted`
(`src/gateway/server-reload-managed.ts`), present since v2026.7.2-beta.5. The payload is
`{path, hash, ts}`: the hash is the projected config revision (observed form
`hmac-sha256:v1:…`), stable for one persisted revision and different for the next. The
event carries `READ` scope (`src/gateway/server-broadcast.ts`) and is sent with
`dropIfSlow: true`: a client whose socket buffer is over the gateway's limit does not
receive it, and its envelope sequence number is consumed so the client's gap detector
fires. Every first-party client — the Control UI, the desktop and mobile apps — listens
and refreshes; the Control UI also reschedules its agent roster. (`dropIfSlow` and the
call site are read at v2026.9.1 and not vendored: the derived catalogue below records
the scope-guard table, not the per-family send options.)

The event is **broadcast but never announced**: it is absent from `GATEWAY_EVENTS`
(`src/gateway/server-methods-list.ts`), the list `hello-ok.features.events` is built
from, and present only in the scope-guard table every broadcast is checked against
(`EVENT_SCOPE_GUARDS`, `src/gateway/server-broadcast.ts`). The gateway keeps two
vocabularies, and the second is the larger: at v2026.9.1 six families reach a client's
socket without ever being declared to it.

### Atrium behavior and verdict

The bridge caches the gateway's `models.list` answer per owner on the per-chat session
connection, which stays open fifteen minutes past the chat's last activity. The event is
read at the connection's intake and reported to a per-session policy: every notice
invalidates every owner's cached roster — kept, not deleted, so a failed re-ask still has
a roster to serve; never deduplicated by hash, since an answer computed while the gateway
is mid-reload is the old roster under the new hash — coalesced over a burst; the session
then re-describes itself, waits for a post-change answer and pushes it to Convex, so the
model picker follows the gateway's configuration without a turn. A refresh that could not
publish the post-change roster is retried once. An envelope frame gap invalidates in the
transport itself — a low-precision signal on a socket the gateway just called slow — and
the next publish (a send, a knob patch) re-asks off its own path and reports the newer
answer alone. The frame is then queued unchanged and dropped by the per-chat
normalizer, like the shutdown notice (observe-only). A cached success also carries a soft
ten-minute bound: past it the roster is served as is and refreshed off the turn, never
blocking a send or a knob patch; a failed re-ask keeps the last good roster, and a
session with nothing in hand publishes its meta without the roster field, which Convex
keeps on record — for the roster's current owner only: the owner of the latest knob
publish accepted, so a turn routed to another agent whose ask failed never inherits the
previous agent's list, and another agent's answer landing late is ignored whatever its
stamp. Ordering between publishers is by observation time in Convex, never by the
bridge, on two clocks: the knob fields by the describe's, the roster by the gateway's
answer — a describe held across a slow ask is older than the roster it rode with — and a
roster answered after its publish is reported alone, as an unstamped meta that carries
nothing else. With nothing in hand a publish waits for the answer, the only case where
waiting buys the user anything. An empty model list, a roster whose every model the
gateway marks unavailable, or an answer without a model list, is a failure that keeps
the last good roster, never an empty picker. Verdict: **handled**, proven by a
deterministic test over a real connection.

The scope-guard table is vendored as a derived artifact beside the announced catalogue;
its difference from the announced list is classified per version with the same statuses
and the same anchor rule; and the drift sensor names, on receipt, any event family in
neither vocabulary. Of the six families at v2026.9.1: `config.changed` and the run's side
result (`chat.side_result`, admitted and handled by the normalizer) are handled; the board
events and the progressive session-catalog delivery are addressed to surfaces or requests
Atrium never has (ignored, verifiably); the per-phase `chat.send` timing is a gap.

## Conformance summary

| Zone | Verdict |
|---|---|
| stopReason/errorKind refusal | **Conformant** — the Control UI reads neither; `state` carries the gateway's pre-rendered decision |
| Announce×send kill | **Recovery correct, attribution wrong** — no upstream kill policy exists; kills are emergent session-file takeovers, bidirectional by timing |
| Embedded-lock downgrade | **Sound via the `hasRealContent()` gate** (the homologue of upstream "send evidence"), not via the "post-generation" argument, which mid-turn takeovers disprove |
| Init-conflict retry | **Conformant** with upstream channel-side retry treatment |
| Compaction | **Explicit signals consumed** — `{stream:"compaction"}` is the primary mid-turn signal (marker + widened budget, no buffer reset); the `abandoned` heuristic survives as the multi-version/Hermes fallback and stands down when explicit signals are present; `session.operation`/`sessions.changed` remain unconsumed (rotation detection covers the manual path) |
| chat.send idempotency | **Conformant** for a faithful duplicate; since 2026.9.2 a key reused with other content is refused (`chat-request-conflict`), classified as its own downstream rejection, never retried; the preempt `dispatchKey` alias is necessary (abort markers poison the original key for ~60 min) and timing-independent |
| Config changes / model roster | **Handled** — `config.changed` (broadcast-only, never announced) invalidates the per-connection roster and triggers a refresh pushed to Convex under the roster's own observation stamp; a frame gap invalidates in the transport and the next publish re-asks and reports the newer answer; the scope-guard table is vendored beside the announced catalogue, and a family in neither vocabulary is named on receipt |

Fixtures extracted from upstream unit tests at `v2026.9.1` are vendored in
`bridge/test/fixtures/openclaw_upstream_frames.json` and replayed by
`bridge/test/upstream-frames.test.ts`.
