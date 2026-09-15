# OpenClaw Upstream Interpretation Comparison — Control UI vs Atrium Bridge

Factual comparison of how the **official OpenClaw Control UI** (the `ui/`
client in the upstream repo) and the **gateway source** interpret the
WebSocket protocol, versus the Atrium bridge normalizer
(`bridge/src/providers/openclaw/normalizer.ts`) and turn-sink
(`bridge/src/core/turn-sink.ts`). Companion to
[PROTOCOL_CONTRACT.md](PROTOCOL_CONTRACT.md), which describes the vendored-schema
ratchet; the per-field classification lives in the coverage manifests under
`bridge/protocol/openclaw/coverage/`.

Reference source: `github.com/openclaw/openclaw` at tag **`v2026.9.4`** — the
exact `maxValidated` gateway version in `bridge/src/compat.ts`.

> **WHAT "ANCHORED AT v2026.9.4" DOES AND DOES NOT MEAN.** The CONCLUSIONS below were
> re-verified against that tag, zone by zone, at each revision. The `file:line`
> CITATIONS were not all re-resolved: most were written against the tag of the revision
> that introduced them, and upstream line numbers move constantly (1230 commits between
> 2026.8.2 and 2026.9.1 alone). An adversarial review on 2026-09-12 resolved a sample
> and found roughly thirty that now point at unrelated code — `ChatEventSchema` cited at
> `logs-chat.ts:197-202` when it lives at 430-436, `agent-runner.ts` cited when the file
> is down to one line, a documented 150 ms cadence that is now `LIVE_TEXT_PACING_MS = 75`.
> Those three, and the anchors of §1 and §5 it named, are corrected. The rest are NOT,
> and a stale anchor is worse than none: it lets a real contract change be "verified"
> against lines that have nothing to do with it.
>
> So: trust the prose, re-resolve any `file:line` you are about to rely on, and fix it
> in place when it has moved. The only citations mechanically checked today are the ones
> in `bridge/test/fixtures/openclaw_upstream_frames.json` — and nothing checks them
> either: `upstream-frames.test.ts` replays the frames and never reads a `description`.
> Making those resolvable by a test is owed work, not done work. Upstream
references below (`$UP/…`) are paths inside that tag. The Control UI is a
**reference interpretation, not a spec**: where Atrium diverges on purpose
(multi-version support, multi-instance, two providers, durable persistence),
the divergence is documented as deliberate rather than "fixed".

No internal offset: the runtime drift detector vendors its schema at
`2026.9.4` (`DRIFT_VENDORED_VERSION`, `protocol-drift.ts`), the same version as
the validated ceiling. An unknown-field warning against a 2026.9.x gateway is
therefore real drift, not schema staleness — it names a field the published
contract does not declare, and should be read as such.

**Revision of 2026-09-12 (v2026.9.2 → v2026.9.4).** Re-verified zone by zone
against the upstream tag (report:
`openclaw-notes/atrium/bench-runs/upstream-diff-2026.9.2-vs-2026.9.4/` — 36
watchlist files changed, one mechanical anchor broken), then proved live: full
catalogue GO 11/11, attestation `bridge/protocol/openclaw/2026.9.4/BENCH.json`.
**The wire contract HOLDS.** The announce identity, the chat.send dedup carriers
and the compaction handlers are byte-identical; the broken anchor was a MOVE, not
a change — `agent-run-terminal-outcome` went to `@openclaw/normalization-core`
with the reason ladder line-for-line identical, and `settlementWarning` (new on
its `ok` variant) never reaches the wire. The two session-lock messages the
normalizer matches verbatim are unchanged.

`2026.9.3` is deliberately absent from `validatedVersions`: nothing was ever run
against it. `withinSupport` covers it as an intermediate version; a number in
that list means a bench earned it.

One new field is DECLARED — not adopted, nothing reads it: `chat.status.retry`
(`{attempt, maxAttempts, reason:"rate_limit"}`), declared in `protocol-drift` so
a provider back-off is not badged unknown, and left a manifest gap because no
`status` frame is read yet. Two consequences worth stating plainly: a `status`
frame is **no longer startup-only** (it now arrives mid-turn, after tools, while
the provider waits), and a rate-limited turn therefore shows "post-processing" in
Atrium while the Control UI shows "Retrying… 2/10". That is the best candidate in
the frame-discovery queue.

A long-standing gap closed on the way: `contextBudgetStatus` — the pre-send
context guard's own input, depended on since the guard existed and declared by NO
pinned version through 2026.9.2 — is **declared by the 2026.9.4 contract**. It
left `undeclared-describe-reads.json`; what remains open is only whether the
gateway omits the assessment under a context engine that owns compaction.

New surface (Skill Workshop, update reports, cloud workers, the Plugins
workspace, task history) is vendored and classified, not adopted.

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
(`$UP/packages/gateway-protocol/src/schema/logs-chat.ts:430-436`), four frames
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
gateway abort paths (`"aborted"`, `"restart"`, `"timeout"`, `"rpc"` — a
generic RPC/internal abort reason, of which a user Stop is one example —
`"auth-revoked"`; arbitrary caller values like `"user"`
also occur). Crucially, **the gateway consumes stopReason before emission**:
`buildAgentRunTerminalOutcome` maps it into `state` (`rpc|stop` → `aborted`
only when status ≠ ok; `timeout` + aborted → **`error`**, not `aborted`;
stale-generation `restart` frames are suppressed entirely —
`$UP/src/agents/agent-run-terminal-outcome.ts:96-174`,
`server-chat.agent-events.test.ts:2966-2989`).

`errorKind` is a closed enum `refusal | timeout | rate_limit | context_length
| unknown` (wire mirror `ChatEventErrorKindSchema`,
`$UP/packages/gateway-protocol/src/schema/logs-chat.ts:308-314`). It is
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
  (`normalizer.ts`, the `state === "aborted"` branch of the chat handler) **matches the reference interpretation exactly**:
  `state` already carries the gateway's decision. Client-side stopReason
  interpretation would duplicate (and risk diverging from) a classification
  the gateway has already rendered.
- Atrium extracts **more** signal than the Control UI, not less: bucketed
  `stopReason` telemetry (`KNOWN_STOP_REASONS` in `normalizer.ts`),
  `errorKind` persisted as message `errorCode`, plus its own actionable
  classes upstream does not have (`context_length` via widened text regex —
  live gateways rarely populate `errorKind` — `session_init_conflict`,
  `provider_internal`, `empty_response`/`empty_response_silent`).
- Post-answer `error` frames: Control UI keeps the answer and shows a
  banner; Atrium finalizes `complete` and downgrades the class to a
  diagnostic trace (the normalizer's `chat:error AFTER the run ended` branch,
  `diagnosticErrorKind`). Same "keep the text" spirit,
  different surface — deliberate (Atrium chats are durable documents; a
  transient provider hiccup after a full answer is telemetry, not UX).
- The stopReason bucket list names the closed constants a 2026.9.4 terminal
  carries (`toolUse`, `end_turn`, `tool_calls`, `restart`, `superseded`,
  `auth-revoked`, `archive`, `delete`, beside the historical `tool_use` /
  `content_filter`), each with its upstream provenance in the code. It used to
  miss all eight (corrected 2026-09-13), which sent a gateway restart, a revoked
  login and a deleted session to the same `"other"` bucket. Trace-only impact;
  free text still buckets.

---

## 2. Announce/delivery vs `chat.send`: session contention

### Upstream policy — steer by default, interrupt when the mode says so

The DEFAULT queue policy does not kill either side of the announce×send
race; an EFFECTIVE `interrupt` mode does. On 2026.8.1+ no mechanism by which an
announce kills a LIVE turn was found on the production paths read (below —
sources, with a consistent live observation). Re-verified at
v2026.9.4 — this heading used to read "there is no kill policy". Contention is
resolved by:

- **Steering**: a `chat.send` arriving while a run is active on the session
  defaults to queue mode `"steer"` — the message is **injected into the
  active run** (`$UP/src/auto-reply/reply/queue/settings.ts:31-36`,
  `reply-run-registry.message-injection.ts`). Refused steering degrades to a
  FIFO **followup queue** drained after the active run ends. When the
  EFFECTIVE mode is `"interrupt"` the active run is aborted before the new
  one runs (`$UP/src/auto-reply/reply/get-reply-run-queue.ts:33`, through
  `interruptReplyRunTarget` → `abortByUser`, a generic user abort). That
  mode resolves send field → message directive (`/queue interrupt`,
  `get-reply-directives-apply.ts:595`, persisted to the session by a
  directive-only message) → session → channel → config → `steer`.
- **Announce delivery**: a sub-agent announce steers into the requester's
  active turn (`subagent-announce-direct-delivery.ts:314,347`,
  `steeringMode:"all"`, path `steered`) or, when the requester is idle,
  runs as a separate in-process `agent` run whose `idempotencyKey`/runId is
  `announce:v1:<childSessionKey>:<childRunId>`
  (`$UP/src/agents/announce-idempotency.ts:11-18`) — the exact shape
  Atrium's `isDeliveryRunId` recognizes. **The queue policy never makes an
  announce kill a user turn**, and on 2026.8.1+ no other such mechanism was
  found for a live turn on the paths read (below).
- **Serialization is the per-session LANE, not the admission**: every embedded
  run executes inside `session:<key>` (`$UP/src/agents/embedded-agent-runner/lanes.ts`,
  `run-orchestrator.ts` `enqueueSession`), a lane created with `maxConcurrent: 1`
  (`$UP/src/process/command-queue.ts`) and targeted by no concurrency setter
  (`server-lanes.ts` sets Cron/Main/Nested/Subagent, `background-work.ts` only
  `background:<owner>`). `beginSessionWorkAdmission` itself lets two holders of
  the same identity coexist (`isCompetingSessionWorkAdmissionActive`); it only
  makes newcomers wait behind lifecycle mutations (reset, compaction). Runs
  and admissions are killed on purpose in
  the cases found at v2026.9.4 — a list from reading, not a proof of
  completeness (it used to say "only reset/delete"): an effective
  `interrupt` queue mode (above; at admission too when the send carries the
  field, `$UP/src/gateway/server-methods/chat-send-admission.ts:293,542`, and
  `sessions.steer` forces it, `sessions-messaging.ts:299`), a session
  reset/delete (`session-reset-service.ts:1305`), a session archive/delete
  drain (`sessions-lifecycle-drain.ts`, `stopReason` = the action), a
  compaction checkpoint restore (`sessions-compaction-checkpoints.ts:226`),
  a worker placement move (`server-worker-placement-move-barrier.ts:79`,
  `server-worker-placement-startup.ts:325`), a sub-agent kill (on the CHILD
  session, `subagent-control-kill-runtime.ts:282`), a reply session rollover
  (`$UP/src/auto-reply/reply/session.ts:518`, turned into `abortForRestart`
  by the active turn, `reply-turn-admission.ts:318-320` — `stopReason:"restart"`).
  Atrium's bridge
  never sets `queueMode` on its `chat.send` calls (a declared gap in
  `protocol-drift`, inventoried by `outbound-ratchet.test.ts`), but that does
  NOT keep its turns out of the `interrupt` path: a directive in the user's
  text, the session, the channel or the config still select it.

**Where an announce kill could exist.** On 2026.7.x a live user turn was aborted
(`chat:aborted`, `stopReason:"rpc"`, zero content) and the announce started 4 s
later — measured in production (2026-07-21) and attributed to the prompt-lock
takeover by its timing; no frame proves the cause, and `rpc` is that
gateway's default stop reason (below). **On 2026.8.1+ no mechanism by which an
announce kills a live `chat.send` turn was found on the production paths read**
(2026-09-14; the same guards are present at v2026.8.1, 8.2, 9.1, 9.2 and 9.4 —
an absence on the instructed paths, not a proof over every possible path):

- the announce's separate run waits in the one-slot `session:<key>` lane until
  the live turn has left it (above);
- `claimAgentSessionWriter`
  (`$UP/src/agents/embedded-agent-runner/run/session-bootstrap.ts:364-420`) does
  supersede a previous writer — emitting for it a lifecycle
  `{phase:"end", aborted:true, status:"superseded", stopReason:"superseded"}` —
  but only through `supersedeEmbeddedAgentRunByRunId`, which refuses a stopped
  handle (`runs.ts` `isEmbeddedRunHandleSupersedable`), and a finished run's
  handle is stopped (`attempt-prompt-phase.ts` `stopAcceptingSteerMessages` in
  a `finally`);
- for an ACTIVE requester the delivery first attempts an active wake that
  injects the completion into its live run
  (`subagent-announce-direct-delivery.ts:307-349`). When that wake is not
  queued, the nominal fallback is a separate direct run, which the one-slot
  lane above serializes behind the live turn — but the function can also
  return before that run: a source owner that changed
  (`sourceOwnerChangedResult`), a cron requester session no longer active
  (`completion_handoff_pending`), or an aborted signal (`path: "none"`).

Observed live on 2026.9.4 (`announce-race-observe`, an observation scenario of
the private live-bench catalogue at `<hors-dépôt>/live-bench/scenarios.mjs`,
run only when selected with `--scenario` — it asserts nothing and is never
part of an attestation; run 2026-09-14T21-57 UTC): a child
finished during the parent's turn; the full capture holds no `announce:*` run
and no `superseded`, the parent ended `stop`, and the exported session
transcript shows the completion persisted INSIDE the parent's turn as a user
entry with idempotency key `announce:v1:<childKey>:<childRunId>:active-wake`
and provenance `{kind:"inter_session", sourceTool:"subagent_announce"}`. The
residue is a run killed by its own lane TIMEOUT, which is already being aborted
— not the race. Late writes are still fenced by
`SessionTranscriptWriterClaimReboundError`
(`$UP/src/config/sessions/transcript-write-context.ts:240`), and a starting run
can find its turn already claimed (`ActiveTurnClaimError`,
`$UP/src/gateway/worker-environments/placement-turn-claims.ts:57`).
(Corrected 2026-09-14: this paragraph said the race kill happens at writer
ownership on 2026.8.1+ — earlier still, "emergent, not policy".)

The upstream terminals DIFFER by cause, but no single `stopReason` proves the
race. `superseded` is NOT exclusive to the writer takeover: every run ended
by `createAgentRunSupersededAbortError` carries it, and that error is created
at six sites (one under an import alias, which a search on the canonical
name misses) — among them a CLI turn whose session incarnation or lifecycle
revision moved before it executed
(`$UP/src/agents/command/attempt-execution.ts:930`; also
`auto-reply/reply/agent-runner-cli-candidate.ts:161`,
`auto-reply/reply/reply-run-registry.operation.ts:565` (`supersede`, imported
as `createSupersededError`),
`embedded-agent-runner/run/deferred-lifecycle-owner.ts:113`,
`embedded-agent-runner/run/attempt-stream-prepare.ts:520`,
`gateway/worker-environments/worker-turn-run-owner.ts:67`), mapped to
`superseded` by `agent-run-terminal-outcome.ts:538-545`. The other kills found
while reading — examples, NOT an exhaustive list — carry a generic `aborted`
(`interrupt` queue mode),
`restart` (rollover, restart), `archive`/`delete` (lifecycle drain), `timeout`
(maintenance expiry of an active run, `$UP/src/gateway/server-maintenance.ts`
→ `abortChatRunById`), `rpc` (a generic RPC/internal abort reason used by
paths scoped to one run or to a whole session, `chat-abort-handler.ts`:
`chat.abort` — with or without a `runId` — or `sessions.abort` from another
client, a compaction checkpoint restore via `session-run-interruption.ts`, a
worker placement cancel `server-worker-placement-cancel.ts`, an ordinary
gateway shutdown `server-run-shutdown.ts` `abortActiveRuns`),
`auth-revoked` (provider logout), `stop` (a `/stop` command sent as a message,
`chat-send-pre-admission.ts`), or no value at all — but
no `stopReason` alone can tell the race apart. Until 2026-09-14 the bridge's
preemption flag decided on a signature that ignored `stopReason`, so
`convex/preemptRepark.ts` could RE-DISPATCH a turn killed on purpose; the flag
is now never set, on any version (verdict
below). Re-verified at v2026.9.4: the default queue mode
is still `steer` (`queue/settings.ts:36`), no `status:"queued"` ack exists on
`chat.send` (a replayed send answers `in_flight`), and the announce id stays
`announce:v1:<childKey>:<childRunId>`.

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
- A run killed through `chat-abort.ts` broadcasts `chat`
  `{state:"aborted", stopReason, message?}` plus a lifecycle
  `{phase:"end", status:"cancelled", aborted:true, stopReason}`; for a
  `controlUiVisible:false` run only the `chat` broadcast is suppressed — the
  lifecycle is still emitted (`chat-abort.ts` `abortChatRunById`). A writer
  takeover of a supersedable run emits its own lifecycle `superseded`
  terminal (above).
- Steering emits **nothing** at injection time; the text appears inside the
  carrying run's stream. An announce injected into an active requester
  (`active-wake`) therefore produces no `announce:*` run and no frame of its
  own: only the requester's session transcript records it.

The Control UI keeps its own client-side queue (no dispatch while a run is
active; "Steer" is just a `chat.send` relying on the gateway's steer mode).

### Atrium behavior and verdict

- Atrium's recovery model used to handle both shapes ATTRIBUTED to the race:
  a send meeting an open announce (`reparkIfBusy` re-parks the paced dispatch,
  with `preemptOpenTurn` as its belt when the send still takes the sink over
  locally), and the inverse, a real turn aborted with zero content right
  before a delivery (the `gatewayPreempted` repark). Since 2026-09-14 only the
  first direction is
  recovered automatically: the inverse one (a real turn aborted with zero
  content) has a terminal but no DISCRIMINATING frame, so it is no longer
  re-dispatched (next bullet). The comments in `preemptRepark.ts` and
  `run-manager.ts` say where the race was attributed (2026.7.x, by timing) and
  why no such mechanism was found on the production paths read on 2026.8.1+
  (they used to place it at writer ownership, earlier still call it emergent
  or a "one run per session" policy).
- The retired `gatewayPreempted` signature (a variable of `turn-sink.ts`
  `flushFinal` until 2026-09-14: an
  aborted terminal finalized as a gateway abort, on a real non-delivery run,
  with no Stop signalled to the bridge, no visible text, no tool call and no
  hosted work) could not, on its own, tell what produced the terminal — among
  others, a `chat-abort.ts` broadcast (`chat.abort`/`sessions.abort` from
  another client, checkpoint restore, worker placement cancel, gateway
  shutdown, archive/delete, auth revocation, maintenance timeout, `/stop` sent
  as a message) or a lifecycle terminal projected by `server-chat.ts` (writer
  takeover `superseded`, `interrupt` → `aborted`, rollover/restart `restart`),
  and the sub-agent-recency check (`preemptRepark.ts` `recentChildren` /
  `deliveryImminent`, a temporal correlation) does not separate those causes
  either. **Retired
  2026-09-14** (`turn-sink.ts` `flushFinal`; `bridge_ingest.ts` ignores the
  field from any bridge): the bridge never sets the flag on any gateway
  version. On >= 2026.8.1 no announce-kill mechanism was found on the
  production paths read (above), while known deliberate causes of such an
  abort exist, and re-dispatching a turn one of those causes ended would undo
  it.
  Before 2026.8.1 no frame tells the announce kill apart: `rpc` is that
  gateway's DEFAULT stop reason on the active send's terminal
  (`$UP@v2026.7.1/src/gateway/server-methods/chat.ts`
  `activeRunAbort.entry?.abortStopReason ?? "rpc"`, and for agent runs
  `server-methods/agent.ts` `resolveAbortedAgentStopReason`), also the reason
  of a `chat.abort` from another client (`abortOrigin: "rpc", stopReason:
  "rpc"`; `abortOrigin` never reaches the wire), and the recent-child check is
  a temporal correlation — a live attempt to reproduce the incident on a
  2026.7.1 bench (2026-09-14) neither killed the live turn nor produced any
  discriminating frame. Re-dispatching on that shape acts on a supposition, so
  the turn keeps its honest aborted card there. What is established is only
  that the mechanism the incident was attributed to was not found on the
  production paths read from 2026.8.1 — not that it was the cause on 7.x. A first
  fix tried to detect the race by the writer takeover's `superseded`
  terminal: it was aimed at a situation the sources and the bench show does
  not occur for a live turn, and was withdrawn; a second kept the historical
  signature below 2026.8.1 and was withdrawn for the same reason. The Convex
  receiver (`preemptRepark.ts`) stays until its outbox fields are migrated
  out.
- Deliberate divergence: Atrium's queue lives in Convex (durable outbox),
  the Control UI's lives in browser state. Parallel architectures; the
  upstream followup queue (`chatQueuedTurns` cancellation identities) is not
  modeled by Atrium. The bridge never sets `queueMode`, yet a `chat.send`
  landing while a separate `announce:*` run is live IS admitted into the
  gateway followup queue on 2026.8.1+ under the default `steer` mode (an
  effective `interrupt` mode from the session, channel or config aborts the
  announce instead, above) (measured live 2026-09-14 on 2026.9.4: the client
  run gets an empty `chat final` with no lifecycle, and the reply comes back
  later under a followup run id — a UUID with no wire link to the client run —
  which Atrium refused as a foreign run and then retried, so the model answered
  twice). Nothing on the wire can repair that afterwards: the `chat.send` ack
  (`status:"started"`) is sent before the queue decision
  (`chat-send-handler.ts:503-531`), and nothing on the wire links the client run to
  the followup run: the gateway holds both identities only in its own state
  (`chat-send-turn-adoption.ts:43-52`), and names them together in a log line
  only when the late reply is DROPPED (`chat-send-late-followup.ts:27-36`) —
  a delivered followup writes no such line. So the bridge narrows
  it (defect 18) — preventing it only when the delivery run is visible to the
  bridge and the release check succeeds within its budget: it holds a send
  while a delivery run it can see is live
  (spontaneous turn open or still finalizing, or announce frames stashed). A
  run ENDING is not the gateway releasing it: the run's lifecycle `end` and
  `chat final` are broadcast before `clearActiveEmbeddedRun`
  (`post-run.ts:638-644`, behind an awaited trajectory flush,
  `deferred-lifecycle-owner.ts:62-78`; trajectory capture is on by default),
  while admission reads that registry (`runs.ts:1017`,
  `get-reply-run-admission.ts:508`). So after a delivery the bridge also asks
  `chat.history` for `sessionInfo.hasActiveRun` — true across that window for
  a run that ended normally (`chat-history-handler.ts:493-503`,
  `runs.ts:1160-1187`) — and waits while it is true. That check only NARROWS
  the window. The signal is not the admission predicate: it also counts
  terminal persistence and projected or queued states
  (`session-active-runs.ts:245-262`), and misses an aborted handle still
  registered or a recovery owner. And it fails open: an absent field, a failed
  call, or a run still counted once a bounded wait is spent (30 s per send,
  shared by its checks, RPC time included — a policy bound, not an upstream
  fact) lets the send go as before. Also not covered: a
  delivery run whose first frame has not reached the bridge when the send goes
  out. Live proof of the hold: bench scenario `announce-reverse-hold` (the send
  held ~41 s, the reply ran under the client run itself, once); the release
  window itself was not caught live.

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
  `$UP/src/config/sessions/transcript-write-context.ts:240`, identical
  2026.8.1 → 2026.9.4): the SQLite replacement. The session row's writer
  claim and lifecycle revision are re-validated before a transcript write
  (`session-accessor.sqlite-transcript-write.ts`), and a rebound refuses it.
  **Not only mid-turn**: the same error is thrown BEFORE generation, while
  the attempt is prepared (`run/session-bootstrap.ts`
  `prepareInitialSessionWriter`, `run/pre-persisted-user-turn.ts`
  `preparePersistedCurrentUserTurn`), and at commits once the model has run
  (`run/settled-turn-finalization.ts`), where streamed content may already
  exist. The TEXT names neither moment (`<Name>: <message>`, plus ` <- ` and
  a JSON object of hashes when a refusal is passed); the STREAM does: a
  generating run emits `lifecycle start` before its provider loop
  (`packages/agent-core/src/agent-loop.ts` `agent_start`), and on every run of
  a full 2026.9.4 bench capture only `chat` status and `agent` `run_status`
  frames preceded it. Upstream treats it as a
  runtime COORDINATION error on the main path (no model fallback,
  `failover-error.ts:758-761`; `model-fallback-runner.ts:611-612` rethrows it) but,
  unlike the 2026.7.x lock, **retries it** on the announce path when nothing
  was sent (`subagent-announce-delivery-retry.ts`
  `isTransientAnnounceDeliveryError`; the regex at `:70` is only its
  definition). Refusal codes are redacted (`session-rebound`,
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
  The **writer-claim rebound** is classified `session_write_conflict` by the
  text classifier, deliberately NOT in `RETRYABLE_KINDS`: upstream throws that
  text at commits after the model ran, where tools may have had external
  effects, and the retry's zero-content gate cannot see work that left no
  visible part. The same text is also thrown before generation, where a retry
  is safe, and the stream tells the two apart where the text cannot: the
  OpenClaw normalizer upgrades the rebound to `session_init_conflict` when the
  turn saw no generation frame (anything but `status`, `run_status` and the
  failure's own terminals), no known frame loss (socket closed mid-turn,
  pre-ack buffer overflow), no refused foreign-run frame and no transcript
  recovery. The true class stays on the trace channel. (Corrected 2026-09-13:
  this paragraph first called the rebound "always mid-turn", then
  "indistinguishable on the wire".) Pinned by
  `writer-rebound-before-generation.test.ts`,
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
  (`convex/bridge.ts`), the auto-retry mints fresh keys
  (`autoretry-<id>-<n>-<now>`), and so did the preempt re-park
  (`preempt-<messageId>-<now>`) while it was reachable. When it does
  happen the bridge classifies the refusal as `chat_request_conflict`
  (`bridge/src/core/dispatch-errors.ts`): a downstream rejection with its own
  card, deliberately outside the bounded auto-retry, since the first turn is
  still running on the gateway.
- The `dispatchKey` alias minted on preempt-repark
  (`preempt-<messageId>-<now>`, the `dispatchKey` assignment in
  `preemptRepark.ts` `reparkAfterPreempt`) WAS necessary to that mechanism, and
  safe against upstream: the abort path writes *both* the abort marker and the
  terminal `chat:` entry, so a re-POST under the original key would replay the
  "aborted" payload — for up to ~60 min (abort marker), not just the 5 min
  dedupe TTL; the alias's fresh timestamp made every repark a never-seen key
  regardless of TTL, cap, or gateway restart. Since the inverse repark was
  retired (2026-09-14, §2) nothing new reaches it: the alias only matters for a
  recovery row created before that change — still held `pending`, already
  flipped `queued` (the flip clears `preemptHold` and stamps `dispatchKey`), or
  promoted `pending` again by the drain — until the outbox fields are migrated
  out.
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
| Announce×send kill | **Inverse recovery retired (2026-09-14)** — on 2026.8.1+ no announce-kill mechanism was found on the production paths read (under the default `steer` mode the send is queued as a followup instead: defect 18, narrowed by the bridge holding the send while a delivery run it can see is live or finalizing, then while the gateway still counts a run — a fail-open, bounded check — §2); on 2026.7.x the measured incident is attributed to the prompt-lock takeover by timing only, no frame proves it, so `gatewayPreempted` is no longer minted or relayed and the zero-content aborted turn keeps its honest card; `reparkIfBusy` (the other direction) stands |
| Embedded-lock downgrade | **Sound via the `hasRealContent()` gate** (the homologue of upstream "send evidence"), not via the "post-generation" argument, which mid-turn takeovers disprove |
| Init-conflict retry | **Conformant** with upstream channel-side retry treatment |
| Compaction | **Explicit signals consumed** — `{stream:"compaction"}` is the primary mid-turn signal (marker + widened budget, no buffer reset); the `abandoned` heuristic survives as the multi-version/Hermes fallback and stands down when explicit signals are present; `session.operation`/`sessions.changed` remain unconsumed (rotation detection covers the manual path) |
| chat.send idempotency | **Conformant** for a faithful duplicate; since 2026.9.2 a key reused with other content is refused (`chat-request-conflict`), classified as its own downstream rejection, never retried; the preempt `dispatchKey` alias WAS necessary to the retired inverse repark (abort markers poison the original key for ~60 min) and stays only for a recovery row created before 2026-09-14 (held, flipped `queued`, or promoted again), until the outbox fields are migrated out |
| Config changes / model roster | **Handled** — `config.changed` (broadcast-only, never announced) invalidates the per-connection roster and triggers a refresh pushed to Convex under the roster's own observation stamp; a frame gap invalidates in the transport and the next publish re-asks and reports the newer answer; the scope-guard table is vendored beside the announced catalogue, and a family in neither vocabulary is named on receipt |

Fixtures extracted from upstream unit tests at `v2026.9.1` are vendored in
`bridge/test/fixtures/openclaw_upstream_frames.json` and replayed by
`bridge/test/upstream-frames.test.ts`.
