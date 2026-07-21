# OpenClaw Upstream Interpretation Comparison — Control UI vs Atrium Bridge

Factual comparison of how the **official OpenClaw Control UI** (the `ui/`
client in the upstream repo) and the **gateway source** interpret the
WebSocket protocol, versus the Atrium bridge normalizer
(`bridge/src/providers/openclaw/normalizer.ts`) and turn-sink
(`bridge/src/core/turn-sink.ts`). Companion to
[protocol-schema-coverage.md](protocol-schema-coverage.md) (schema-surface
coverage) and [protocol-contract.md](protocol-contract.md) (vendored-schema
ratchet).

Reference source: `github.com/openclaw/openclaw` at tag **`v2026.7.1`** — the
exact `maxValidated` gateway version in `bridge/src/compat.ts`. Upstream
references below (`$UP/…`) are paths inside that tag. The Control UI is a
**reference interpretation, not a spec**: where Atrium diverges on purpose
(multi-version support, multi-instance, two providers, durable persistence),
the divergence is documented as deliberate rather than "fixed".

Known internal offset: the runtime drift detector vendors its schema at
`2026.6.11` (`DRIFT_VENDORED_VERSION`, `protocol-drift.ts:24`) while the
validated ceiling is `2026.7.1`. Unknown-field warnings against a 2026.7.x
gateway may therefore be schema staleness, not real drift.

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
| unknown` (`$UP/src/infra/errors.ts:150`; wire mirror
`ChatEventErrorKindSchema`). It is populated from a structured kind on the
lifecycle event or by **regex detection on the error text**
(`detectErrorKind`, `errors.ts:152-187`); in practice the fallback never
yields `"unknown"`.

### Control UI interpretation

The Control UI **does not read `stopReason` or `errorKind` at all**. Its
`ChatEventPayload` type does not even declare the fields
(`$UP/ui/src/pages/chat/chat-history.ts:464-473`); the reducer discriminates
on `state` only: `final` → done, `aborted` → interrupted/killed, `error` →
interrupted/failed + raw `errorMessage` banner
(`$UP/ui/src/pages/chat/chat-gateway.ts:155-280`). On `error` it
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

At v2026.7.1 upstream has **no deliberate preemption** in the
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
not policy**: during LLM streaming the run releases its prompt lock; if
another writer touches the session file, the run that *detects* the change on
reacquire dies with `EmbeddedAttemptSessionTakeoverError`
(`attempt.session-lock.ts:1147-1151`). Which side loses depends on timing —
both directions of the race are possible, consistent with what Atrium has
observed.

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
- **`session file changed while embedded prompt lock was released`**
  (`EmbeddedAttemptSessionTakeoverError`,
  `attempt.session-lock.ts:1147-1152`): the runner releases the file lock
  *for the duration of generation* (fence = file fingerprint), re-acquires
  and re-checks in the `finally` after the model call settles. The error is
  thrown only when a foreign modification cannot be explained (owned-write
  reconciliation, benign ctime drift, and benign appended-line
  classification all run first).
  - At the canonical throw site (post-`finally`), **generation is complete**
    and assistant messages have been persisted incrementally during the
    stream.
  - **But the same error can also fire mid-turn**: transcript writes between
    steps of a multi-tool turn re-take the lock and re-check the fence
    (`withSessionWriteLock`); a takeover there aborts the rest of the turn
    with partial streamed text.
  - Upstream never regenerates on this error: the model-fallback chain is
    aborted (`isNonProviderRuntimeCoordinationError`), and the announce path
    marks it **permanent as soon as there is "send evidence"**
    (`visibleReplySent` / `sentBeforeError` / delivery results,
    `subagent-announce-delivery.ts:383-397`) — retrying would duplicate the
    delivery.

Neither message receives special handling in the Control UI: both arrive as
`state:"error"` with the raw text in `errorMessage`, **no `errorKind`**
(`detectErrorKind` matches neither), no retry. The UI keeps already-streamed
text as messages next to the error.

### Atrium behavior and verdict

- The embedded-flavor **downgrade-to-complete** (`normalizer.ts:1512-1540`,
  gated on `hasRealContent()`) is **sound, but for a better reason than its
  comment states**. "The embedded lock is post-generation" is too strong —
  mid-turn takeovers exist. What makes the downgrade correct is the
  `hasRealContent()` gate itself: it is the exact homologue of upstream's
  "send evidence" criterion, and upstream likewise refuses any retry once
  content has been emitted. Edge case shared with upstream: a mid-turn
  takeover in a multi-step turn closes truncated text as complete — upstream
  has no more-correct behavior to imitate (it also refuses the retry).
- The init-flavor handling (transient `session_init_conflict` + bounded
  auto-retry) matches upstream's own channel-side retries. Refusing the
  downgrade for init is correct: the error is pre-generation, so no content
  can have come from that turn.

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
  verbatim on every retry** (`$UP/ui/src/pages/chat/chat-send.ts:275,334,
  452,595,1072-1103`). No content hash, no timestamp.
- **Gateway validation**: `NonEmptyString`, opaque, no normalization — the
  key *becomes* the run's `runId`
  (`$UP/src/gateway/server-methods/chat.ts:3802`; "chat.send idempotency
  keys are exact protocol identities", `chat-queued-turns.ts:36`).
- **Dedupe window**: one `Map<string, DedupeEntry>` **per gateway process**
  (all connections, all sessions). Keys `chat:<idempotencyKey>` (terminal
  results) and `pending-chat:<idempotencyKey>` (admission reservations).
  Sweep every 60 s; **TTL 5 min** (`DEDUPE_TTL_MS`), **cap 1000** entries
  oldest-first — active/pending runs always survive both. Separate
  aborted-run markers live **60 min** (`ABORTED_RUN_TTL_MS`).
- **Duplicate behavior** (always an ack, never silence/error): terminal
  cached → same payload replayed with `meta:{cached:true}`; abort marker →
  synthesized "aborted" payload; pending/active/queued →
  `{runId, status:"in_flight"}`.
- The announce idempotency family (`announce:v1:<childKey>:<runId>`) is a
  **separate, persisted delivery identity** — unrelated to the chat.send
  dedupe map.

### Atrium behavior and verdict

- Bridge derivation: `webchat-<sha256(sessionKey|clientMessageId)>`
  (`openclaw-client.ts:518-533`), stable across Convex's at-least-once
  dispatch — this **exploits the upstream window correctly** (re-POSTs
  replay/`in_flight` while the run is active, since active entries outlive
  the TTL).
- The `dispatchKey` alias minted on preempt-repark
  (`preempt-<messageId>-<now>`, `preemptRepark.ts:293`) is **confirmed
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

## Summary of findings

| Zone | Verdict |
|---|---|
| stopReason/errorKind refusal | **Conformant** — the Control UI reads neither; `state` carries the gateway's pre-rendered decision |
| Announce×send kill | **Recovery correct, attribution wrong** — no upstream kill policy exists; kills are emergent session-file takeovers, bidirectional by timing |
| Embedded-lock downgrade | **Sound via the `hasRealContent()` gate** (the homologue of upstream "send evidence"), not via the "post-generation" argument, which mid-turn takeovers disprove |
| Init-conflict retry | **Conformant** with upstream channel-side retry treatment |
| Compaction | **Explicit signals consumed** — `{stream:"compaction"}` is the primary mid-turn signal (marker + widened budget, no buffer reset); the `abandoned` heuristic survives as the multi-version/Hermes fallback and stands down when explicit signals are present; `session.operation`/`sessions.changed` remain unconsumed (rotation detection covers the manual path) |
| chat.send idempotency | **Conformant**; the preempt `dispatchKey` alias is necessary (abort markers poison the original key for ~60 min) and timing-independent |

Fixtures extracted from upstream unit tests at `v2026.7.1` are vendored in
`bridge/test/fixtures/openclaw_upstream_frames.json` and replayed by
`bridge/test/upstream-frames.test.ts`.
