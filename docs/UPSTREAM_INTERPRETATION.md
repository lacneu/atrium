# OpenClaw Upstream Interpretation Comparison — Control UI vs Atrium Bridge

Factual comparison of how the **official OpenClaw Control UI** (the `ui/`
client in the upstream repo) and the **gateway source** interpret the
WebSocket protocol, versus the Atrium bridge normalizer
(`bridge/src/providers/openclaw/normalizer.ts`) and turn-sink
(`bridge/src/core/turn-sink.ts`). Companion to
[PROTOCOL_CONTRACT.md](PROTOCOL_CONTRACT.md), which describes the vendored-schema
ratchet; the per-field classification lives in the coverage manifests under
`bridge/protocol/openclaw/coverage/`.

Reference source: `github.com/openclaw/openclaw` at tag **`v2026.9.8`** — the
exact `maxValidated` gateway version in `bridge/src/compat.ts`.

> **WHAT "ANCHORED AT v2026.9.8" MEANS.** The CONCLUSIONS below were re-verified against that
> tag, zone by zone, at each revision. The `file:line` CITATIONS are checked as well: every
> citation of this document and of the scenario descriptions of
> `bridge/test/fixtures/openclaw_upstream_frames.json` is recorded in
> `bridge/protocol/openclaw/citations.json` with the tag it is read at, its full path and a
> literal fragment of the cited code, and `bridge/test/upstream-citations.test.ts` refuses a
> citation that is not recorded, a record whose lines are not the lines written here, a citation
> without a file name, and — when a checkout of the tag is reachable — a literal that is not
> inside the cited lines. A review of 2026-09-12 had found about thirty citations pointing at
> unrelated code (`ChatEventSchema` cited at lines 197-202 of `logs-chat.ts` when it lives at
> 430-436, a documented 150 ms cadence that is now `LIVE_TEXT_PACING_MS = 75`); on 2026-09-15
> every citation was re-read at its tag and the moved ones were corrected in place.
>
> What the check does not prove: the literal shows the cited lines contain that fragment, chosen
> by a reader to embody the claim — not that the prose around it is right, and a range wider
> than the claim still passes. In CI, where no upstream checkout exists, only the record and the
> citations of Atrium code are checked, and the test says so instead of implying more.

Upstream
references below (`$UP/…`) are paths inside that tag. The Control UI is a
**reference interpretation, not a spec**: where Atrium diverges on purpose
(multi-version support, multi-instance, two providers, durable persistence),
the divergence is documented as deliberate rather than "fixed".

No internal offset: the runtime drift detector vendors its schema at
`2026.9.8` (`DRIFT_VENDORED_VERSION`, `protocol-drift.ts`), the same version as
the validated ceiling. An unknown-field warning against a 2026.9.x gateway is
therefore real drift, not schema staleness — it names a field the published
contract does not declare, and should be read as such.

**Revision of 2026-10-04 (v2026.9.7 → v2026.9.8).** A reliability hotfix ("No
intentional capability changes", upstream CHANGELOG). Re-verified against the tag
(report: `openclaw-notes/atrium/bench-runs/upstream-diff-2026.9.7-vs-2026.9.8/` — none of
the 140 files watched until then changed, 42 anchors held; the 86 vendored schema modules
and both event catalogues are byte-identical beyond their provenance header). The five
zone-2 files that carry the silent-reply change below were outside the watchlist and are
now on it. Of the 111
non-test source files that changed outside the watchlist, the gateway-side ones were
read zone by zone: the WebSocket authorization rework (`grantGeneration` beside
`generation`, `$UP/src/gateway/auth-policy.ts:99-131`) does not move for a shared-token
client without an `Origin` header; session-row publication, the transcript workers and
the Talk relay are refactors with identical output; the `sessions_send` agent-to-agent
ping-pong and announce step are removed (`sessions-send-tool.a2a.ts`), which Atrium never
read. Four citations moved and were corrected in place; none of the six zones below
changed its conclusion.

One behaviour changed WITHOUT a wire change, and it is the one to keep in mind when
reading §2: a silent reply (`NO_REPLY` or an empty answer) is now allowed only in a
channel group (`$UP/src/shared/silent-reply-policy.ts:33-42`), and a run started through
the `agent` method — announce, requester-settle wake, sub-agent child, inter-session
delivery — resolves its reply expectation to `required` unless that policy allows it
(`resolveCommandReplyExpectation`, `$UP/src/agents/command/attempt-execution.helpers.ts:44-71`).
An empty one is retried with a visible-answer instruction, then ends as an incomplete
turn instead of settling in silence; the sub-agent and settle prompts stopped asking
for `NO_REPLY`. The token, the run ids (`announce:v1:…`, `announce:requester-settle:…`)
and the frame shapes are unchanged, `chat.send` turns are not concerned, and the full
bench (sub-agent merge, chain, parallel, async task, reverse hold) stayed green — so
nothing was adapted; Atrium's silent-settle paths are simply taken less often.

**Upgrade note.** The agent database schema is still 24, as in 2026.9.7. The official
image entrypoint runs `openclaw doctor --fix` before every start, which migrates a
2026.9.6 state 23 → 24 at the first boot (one `.pre-startup-migration-*.bak` per
database). The gateway's single-owner lease (`$UP/src/infra/gateway-owner-lease.ts:180`,
enforced on the server start path since #160193) survives a killed container: stop the
old gateway gracefully, or the next container is refused for up to five minutes.

**Revision of 2026-10-03 (v2026.9.6 → v2026.9.7).** Re-verified zone by zone
against the upstream tag (report:
`openclaw-notes/atrium/bench-runs/upstream-diff-2026.9.6-vs-2026.9.7/` — 65
watchlist files changed, 35 anchors held, 3 broke: two were MOVES of the same
code — the session lane width, now `getDefaultLaneConcurrency`, still 1 for every
`session:` lane, and the supersession predicate, moved to `runs.probes.ts` — and one
is a real change, the Control UI now reading `errorKind`, §1). Every `file:line`
citation was re-read at the new tag: 82 ranges had MOVED and were corrected in
place; three literals had to be re-chosen (a test turned into an `it.each`, a
grouping predicate rewritten, the `rpc` abort case split into its own test).

**Four wire changes WITHOUT negotiation, all adapted in the bridge:**

- **Append-only live text.** A socket receives a run's cumulative text ONCE; after
  that, `chat` deltas drop `message` and keep `deltaText`, and `agent` `assistant`
  events drop `data.text` and keep `data.delta`
  (`$UP/src/gateway/server-chat-live-text.ts:17-28`), for as long as the socket
  received the previous publication of the key (`canSendDelta`,
  `$UP/src/gateway/server-broadcast-live-text.ts:214-224`). No capability turns it
  on or off; terminals keep their message. Read raw, the normalizer's snapshot lock
  froze the live reply on its first fragment. The bridge now rebuilds the
  cumulative fields AT THE CONNECTION, before any reader, exactly as the Control UI
  does (`GatewayChatStreamProjection`,
  `$UP/packages/gateway-client/src/chat-stream-projection.ts:7-56`): every reader
  keeps seeing 9.6-shaped frames, and on 9.6 the projection is the identity. A delta
  that arrives with no baseline means this side lost a frame; the Control UI
  reconnects (`$UP/ui/src/api/gateway-chat-events.ts:59-74`), the bridge withholds
  the fragment and re-reads the run's in-flight text (`chat.history` →
  `inFlightRun`, `resolveInFlightRunSnapshot`, `$UP/src/gateway/chat-abort.ts:335-357`).
- **The `tasks.*` RPCs are gone** (`tasks.list|get|cancel|history` and
  `schema/tasks.ts`; the Control UI's own test asserts it sends none of them,
  `run-transcript.e2e.test.ts:130`). The background-task probe answers empty from
  this version on (`TASKS_RPC_RETIRED_IN`, bridge `compat.ts`), never sent; the
  `task` event left the announced catalogue but stays broadcastable. With the registry
  gone, a media task's id is its own run id, `tool:<toolName>:<uuid>`
  (`$UP/src/agents/tools/media-generate-background-shared.ts:220,280`), so its delivery
  run reads `image_generate:tool:image_generate:<uuid>:ok:agent-loop`. The bridge and
  Convex grammars of the delivery family accept both id shapes, each still anchored
  on a uuid — measured on the bench, where the 9.6 grammar left the engagement
  running forever.
- **`errorKind:"state_contention"`** replaces the SQLite sentence on the `chat.send`
  failure path with fixed copy (§1). Read as `gateway_storage_busy`, never retried.

What else changed and is NOT adopted (§1, §2, §4): steering no longer yields to a
waiting followup, the gateway queue is readable on `chat.history`
(`pendingInputs.queued`/`queuedCount`, receipts `queued`/`cancelled`) and
cancellable (`chat.abort.discardPendingInput`), `SessionRow.status` may say
`interrupted`, a `session.narration` event exists for a narration-mode
subscription, and a run may continue after an unfinished plan with a new
`lifecycle start` on the same run. **Upgrade note, one-way:** the agent database
schema moves 23 → 24 (`OPENCLAW_AGENT_SCHEMA_VERSION`,
`$UP/src/state/openclaw-agent-db-contract.ts:29`) and is NOT migrated at boot: the
gateway refuses every session until `openclaw doctor --fix` has run.

**Revision of 2026-09-25 (v2026.9.5 → v2026.9.6).** Re-verified zone by zone
against the upstream tag (report:
`openclaw-notes/atrium/bench-runs/upstream-diff-2026.9.5-vs-2026.9.6/` — 55
watchlist files changed, 38 anchors held, none broke), then proved live: full
catalogue GO 17/17 on the patched distribution image. Every `file:line` citation
was re-read at the new tag: 58 ranges had MOVED and were corrected in place, and
TWO claims had disappeared with the code they cited — the compaction checkpoint
restore, removed upstream with the checkpoints themselves (#154131), and the
`sessions.steer` interrupt, which now lives in a shared helper (both corrected
below).

**The wire contract HOLDS on zones 1 to 5.** `ChatEvent` and `errorKind` are
byte-identical, no preemption policy and no `status:"queued"` ack appeared, the
announce identity and the dedup window are unchanged, and the session-lock
sentences the classifier matches are intact. What changed, and what Atrium does:

- **Compaction checkpoints are RETIRED** with `sessions.compaction.list|branch|restore`
  and the row fields `compactionCheckpointCount` / `latestCompactionCheckpoint`.
  Atrium's on-demand history read is refused by name from 2026.9.6 on
  (`COMPACTION_CHECKPOINTS_RETIRED_IN`, bridge `compat.ts`), never sent.
- **Two new `chat.send` admission refusals.** `UNAVAILABLE "session transcript is
  rebuilding; retry shortly"` (`retryable`, no reservation left) joins the transient
  session-conflict class and its bounded retry; `Session "<key>" is paused as a
  precaution…` — a session paused after a provider refusal until
  `sessions.providerReview.continue` — is named `session_paused_review` and never
  retried. The continue flow is a DECLARED GAP.
- **A new deliberate `rpc` abort**: revoking an operator's authority (device, role,
  profile identity) aborts its admitted runs (`operator-run-cancellation.ts:134-138`).
  Same `chat:aborted` frame as any `rpc`, read as such.
- **Two behaviours owed a bench scenario, not measured**: an announce interrupted by a
  gateway restart is now RESUMED under a fresh UUID run Atrium does not attribute (its
  reply may exist gateway-side and stay unseen), and an injection may be refused with
  `reply_expectation_mismatch` when a required send meets an optional run.

**Revision of 2026-09-20 (v2026.9.4 → v2026.9.5).** Re-verified zone by zone
against the upstream tag (report:
`openclaw-notes/atrium/bench-runs/upstream-diff-2026.9.4-vs-2026.9.5/` — 58
watchlist files changed, 35 anchors held, 2 broke), then proved live: full
catalogue GO 14/14, attestation `bridge/protocol/openclaw/2026.9.5/BENCH.json`.
Every `file:line` citation of this document and of the frames fixture was re-read
at the new tag; 14 ranges had MOVED and were corrected in place, and **none had
disappeared** — each cited claim is still there, which is the substance of the
"contract holds" below.

**The wire contract HOLDS on zones 2, 3 and 5.** No preemption policy appeared in
the announce×send contention, no `status:"queued"` ack, the two session-lock
messages the normalizer matches verbatim are unchanged, and the dedup TTLs are
identical. The two broken anchors are real and are each recorded:

- `[-] $UP/ui/src/pages/chat/chat-gateway.ts :: stopReason` — the Control UI now
  BRANCHES on `stopReason` rather than merely displaying it
  (`$UP/ui/src/pages/chat/chat-gateway.ts:122-125`, `stopReason === "auth-revoked"`).
  A field that was decorative upstream has become load-bearing there; Atrium's
  reading is unchanged and still takes the verdict from `state`, which is the
  divergence this document exists to record.
- `[+] $UP/src/gateway/server-methods/sessions-read-by-key.ts :: const row = buildGatewaySessionRow({`
  — the session describe is now assembled through a shared row builder. The fields
  Atrium reads are the same ones; the assembly moved.

**DECLARED GAP, not a conclusion.** 2026.9.5 adds a RETRACTION delta —
`delta { deltaText: "", replace: true }` — and the bridge normalizer drops any
delta whose text is empty (`bridge/src/providers/openclaw/normalizer.ts:2216`,
the `&& deltaText` guard), so Atrium keeps a text the gateway has just withdrawn.
Written here because it is known and unfixed, not because it was measured on the
bench: the catalogue never elicits a retraction. It is owed a scenario before it
can be called handled.

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
context guard's own input, depended on since the guard existed and named by NO
pinned artifact through 2026.9.2 — is **carried by the 2026.9.4 derived
session-event snapshot**. No contract declares it (no vendored schema names it,
and `sessions.describe` has no result schema): it is observed in the tagged
implementation, which projects it on the session row the describe also answers
with. It left `undeclared-describe-reads.json`; that file's `$resolved` entry
states the projection's exact omission conditions and the anchors that watch the
describe path.

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
(`$UP/packages/gateway-protocol/src/schema/logs-chat.ts:487-493`), four frames
discriminated by `state`, common base `{runId, sessionKey, agentId?,
spawnedBy?, seq}`:

| `state` | Own fields | Emitted when |
|---|---|---|
| `delta` | `deltaText` (required), `replace?`, `message?` (cumulative snapshot), `usage?` | per assistant stream frame, paced at 75 ms (`LIVE_TEXT_PACING_MS`); a buffered delta is flushed just before any terminal (`server-chat.ts:889-900,1054-1060`) |
| `final` | `message?` (may be absent), `usage?`, `stopReason?` | lifecycle `end` whose terminal outcome is `done` (`server-chat.ts:598-608,1091-1118`) |
| `aborted` | `message?` (partial text), `errorMessage?` (tool-validation summary only), `stopReason?` | terminal outcome `cancelled`/`aborted`, or direct `broadcastChatAborted` (`chat-abort.ts:436-475`) |
| `error` | `errorMessage?`, `errorKind?`, `errorDetail?`, `usage?`, `stopReason?`, `message?` — declared; the gateway's own error payload sets neither `message` (since 2026.8.1) nor `usage` (`server-chat.ts:1112-1124`) | lifecycle `error`, or `end` classified `failed`/`timed_out`/`hard_timeout`; lifecycle errors get a 15 s retry grace before emission (`server-chat.ts:106-111,309,1720-1739`) |

**`stopReason` is a free-form string at the wire level** (`Type.Optional(
Type.String())` — no wire enum). Producers: the model runtime enum
`"stop"|"length"|"toolUse"|"error"|"aborted"` (`$UP/packages/llm-core/src/types.ts:357`,
raw provider values like `end_turn` may also pass through) and
gateway abort paths (`"aborted"`, `"restart"`, `"timeout"`, `"rpc"` — a
generic RPC/internal abort reason, of which a user Stop is one example —
`"auth-revoked"`; arbitrary caller values like `"user"`
also occur). Crucially, **the gateway consumes stopReason before emission**:
`buildAgentRunTerminalOutcome` maps it into `state` (`rpc|stop` → `aborted`
only when status ≠ ok; `timeout` + aborted → **`error`**, not `aborted`;
stale-generation `restart` frames are suppressed entirely — rules at
`$UP/packages/normalization-core/src/agent-run-terminal-outcome.ts:91-129`, suppression at
`$UP/src/gateway/server-chat.ts:552-569`,
`server-chat.agent-events.test.ts:3105-3167,3721-3740`).

`errorKind` is a closed enum `refusal | timeout | rate_limit | context_length
| state_contention | unknown` (wire mirror `ChatEventErrorKindSchema`,
`$UP/packages/gateway-protocol/src/schema/logs-chat.ts:363-370`). It is
populated from a structured kind on the lifecycle event, then from the
`FailoverReason` (`server-chat.ts:158-206`), then from a timeout probe; in
practice the fallback never yields `"unknown"`, and a generic 5xx is
deliberately left unbadged.

**Changed since 2026.7.1** (re-verified at v2026.9.1, no impact on what the
bridge reads):

- **`message` is no longer emitted on `state:"error"`** (since 2026.8.1):
  `emitChatTerminal` omits it and the upstream tests assert its absence
  (`server-chat.agent-events.test.ts:3803,4531,4806`). The `"Error: …"` prefix is now
  built by the Control UI (`chat-gateway.ts:82-97`). Atrium reads
  `errorMessage` first, so nothing changed for it — but the `message` fallback
  in its coverage manifest is dead code against a ≥2026.8.1 gateway.
- **`detectErrorKind` is gone from the core** (deprecated shim in
  `plugin-sdk/infra-runtime.ts:133-176`); the derivation above replaced it. The
  enum and its five values are unchanged.
- **NEW `errorDetail` on `state:"error"`** (2026.9.1,
  `logs-chat.ts:394-448`): a bounded, redacted record — `provider`, `model`,
  `failoverReason`, `providerRuntimeFailureKind`, `providerErrorType`,
  `httpStatus`, `providerErrorMessagePreview`. Purely additive: `errorMessage`
  is still emitted. The Control UI reads exactly one thing from it
  (`providerRuntimeFailureKind === "auth_refresh"`, `chat-gateway.ts:65-77,253-259`).
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
`server-broadcast.ts:469-503`) — fewer `chat:delta` frames with longer
`deltaText` and a non-contiguous `payload.seq`; the envelope `seq` stays
contiguous and a terminal always drains the queue first, and Atrium reads the
cumulative `message` snapshot before any delta (`normalizer.ts`); (b) a
replaceable provisional assistant item (`replace:true, replaceable:true`) now
clears the prefix on the cumulative text, so the `final` and the assistant
stream agree; (c) a retryable HTTP 5xx or a reset is no longer promoted to
`stopReason:"timeout"` — only a recorded timeout is (`run-termination.ts:131-141,156-182`),
and `providerStarted` may arrive without `timeoutPhase`; (d) request-side only:
`chat.history` gains `maxBytes`, `chat.metadata` gains `authProfileId`,
`chat.startup` accepts a short id, and `chat.send` gains `mentions` — none
sent by the bridge, all optional.

**Changed since 2026.9.6** (re-verified at v2026.9.7):

- **Append-only deltas** — see the revision note above. What the normalizer reads is
  unchanged because the connection restores `message` / `data.text` first
  (`bridge/src/providers/openclaw/live-text-baseline.ts`).
- **NEW `errorKind:"state_contention"`**, with exactly one producer: the `chat.send`
  setup/dispatch failure path, for a TYPED SQLite BUSY/LOCKED only
  (`$UP/src/sessions/session-run-error-presentation.ts:10-17`). It is terminal, and
  its `errorMessage` is fixed copy that no longer contains "database is locked" —
  "…SQLite transaction admission remained busy. Execution may have occurred; check
  the recorded outcome before resending." The lifecycle relay's own allowlist does
  not contain it, so a run's lifecycle never carries it. Atrium reads the kind as
  `gateway_storage_busy` (same fact, same no-retry policy) and matches the fixed
  sentence as a fallback.
- **NEW startup phase `waiting_for_state`** on the non-terminal `state:"status"`
  frame, declared without a producer at the tag. Atrium keeps status frames
  eventless.
- **A `chat:error` may FOLLOW a `chat:aborted`** on the same run when the deferred
  save of the stopped partial fails
  (`$UP/src/gateway/server-methods/chat-aborted-partial.ts:151,173-174`). The bridge's
  finalize is first-terminal-wins, so the turn stays `aborted`.
- **`SessionRow.status` gains `"interrupted"`**
  (`$UP/packages/gateway-protocol/src/schema/sessions-row.ts:28-36`), no longer folded
  into `failed` by the projection (`session-utils-display.ts:140`). Atrium does not
  read `SessionRow.status`.

### Control UI interpretation

The Control UI's reducer discriminates on `state` — `final` → done, `aborted` →
interrupted/killed, `error` → interrupted/failed + raw `errorMessage` banner — but
it is NOT blind to the classification fields, and was not at v2026.9.6 either:
every terminal is first folded into the shared session projection, which maps
`errorKind === "timeout"` to a `timeout` run and a `final` with `stopReason ===
"error"` to `error` (`$UP/packages/gateway-client/src/session-projection-run-event.ts:46-73`).
Since 2026.9.5 it rewrites `aborted` + `stopReason "auth-revoked"`, and since
2026.9.7 it branches on `errorKind === "state_contention"`
(`$UP/ui/src/pages/chat/chat-gateway.ts:85-87,254-258`): the raw text without the
"Error:" prefix, a warning-toned banner and a "Check status" action. Readers of
`stopReason` on persisted history records remain
(`chat-agent-run-grouping.ts:58-62,106-120`, `terminal-reply-recovery.ts:24-28`). On
`error` it materializes already-streamed parts as visible messages and shows the
error banner *next to* the kept text. From 2026.9.7 the reducer no longer reads
`deltaText` at all: the text of a delta comes from the `message` the connection
rebuilt.

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
  one runs (`$UP/src/auto-reply/reply/get-reply-run-queue.ts:31`, through
  `interruptReplyRunTarget` → `abortByUser`, a generic user abort). That
  mode resolves send field → message directive (`/queue interrupt`,
  `get-reply-directives-apply.ts:561`, persisted to the session by a
  directive-only message) → session → channel → config → `steer`.
- **Announce delivery**: a sub-agent announce steers into the requester's
  active turn (`subagent-announce-direct-delivery.ts:308,342`,
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
  field, `$UP/src/gateway/server-methods/chat-send-admission.ts:277,558`, and
  `sessions.steer` forces it, `sessions-messaging.ts:109`), a session
  reset/delete (`session-reset-service.ts:935`), a session archive/delete
  drain (`sessions-lifecycle-drain.ts`, `stopReason` = the action), an
  operator's authority revoked (`operator-run-cancellation.ts:134-138`, new at
  v2026.9.6 — a compaction checkpoint restore was on this list until checkpoints
  were retired), a worker placement move (`server-worker-placement-move-barrier.ts:79`,
  `server-worker-placement-startup.ts:322`), a sub-agent kill (on the CHILD
  session, `subagent-control-kill-runtime.ts:357-362`), a reply session rollover
  (`$UP/src/auto-reply/reply/session.ts:462`, turned into `abortForRestart`
  by the active turn, `reply-turn-admission.ts:303-305` — `stopReason:"restart"`).
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
  (`$UP/src/agents/embedded-agent-runner/run/session-bootstrap.ts:426-482`) does
  supersede a previous writer — emitting for it a lifecycle
  `{phase:"end", aborted:true, status:"superseded", stopReason:"superseded"}` —
  but only through `supersedeEmbeddedAgentRunByRunId`, which refuses a stopped
  handle (`runs.ts` `isEmbeddedRunHandleSupersedable`), and a finished run's
  handle is stopped (`attempt-prompt-phase.ts` `stopAcceptingSteerMessages` in
  a `finally`);
- for an ACTIVE requester the delivery first attempts an active wake that
  injects the completion into its live run
  (`subagent-announce-direct-delivery.ts:324-366`). When that wake is not
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
and no `superseded`, and the parent ended `stop` — those three facts are in the
capture and stay verifiable there.

The completion itself is filed INSIDE the parent's turn as a user entry with
provenance `{kind:"inter_session", sourceTool:"subagent_announce"}` and an
idempotency key ending `:active-wake`. That shape is established FROM THE
UPSTREAM SOURCES (the announce delivery module composes that suffix at a single
site, for the steer into the live run; the direct announce and the settle keep
the bare key, and the durable generated-media handoff carries `:agent-loop`.
That suffix identifies the STRING, not its producer: base keys are built by
prefixing a caller-supplied announce id, and a harness caller chooses that id
freely, so a delivery that is a turn of its own can end the same way. Nothing in
the transcript distinguishes the two, which is why Atrium reads none of them as
a continuation of the running turn); a transcript read by hand during the run
agreed with
it, but this scenario exports no transcript, so the run directory does NOT hold
that evidence and it must not be cited as the proof (corrected 2026-09-16). The
residue is a run killed by its own lane TIMEOUT, which is already being aborted
— not the race. Late writes are still fenced by
`SessionTranscriptWriterClaimReboundError`
(`$UP/src/config/sessions/transcript-write-context.ts:411`), and a starting run
can find its turn already claimed (`ActiveTurnClaimError`,
`$UP/src/gateway/worker-environments/placement-turn-claims.ts:53`).
(Corrected 2026-09-14: this paragraph said the race kill happens at writer
ownership on 2026.8.1+ — earlier still, "emergent, not policy".)

The upstream terminals DIFFER by cause, but no single `stopReason` proves the
race. `superseded` is NOT exclusive to the writer takeover: every run ended
by `createAgentRunSupersededAbortError` carries it, and that error is created
at six sites (one under an import alias, which a search on the canonical
name misses) — among them a CLI turn whose session incarnation or lifecycle
revision moved before it executed
(`$UP/src/agents/command/attempt-execution.ts:530`; also
`auto-reply/reply/agent-runner-cli-candidate.ts:183`,
`auto-reply/reply/reply-run-registry.operation.ts:519` (`supersede`, imported
as `createSupersededError`),
`embedded-agent-runner/run/deferred-lifecycle-owner.ts:158`,
`embedded-agent-runner/run/attempt-stream-prepare.ts:442`,
`gateway/worker-environments/worker-turn-run-owner.ts:72`), mapped to
`superseded` by `src/agents/agent-run-terminal-outcome.ts:526-533`. The other kills found
while reading — examples, NOT an exhaustive list — carry a generic `aborted`
(`interrupt` queue mode),
`restart` (rollover, restart), `archive`/`delete` (lifecycle drain), `timeout`
(maintenance expiry of an active run, `$UP/src/gateway/server-maintenance.ts`
→ `abortChatRunById`), `rpc` (a generic RPC/internal abort reason used by
paths scoped to one run or to a whole session, `chat-abort-handler.ts`:
`chat.abort` — with or without a `runId` — or `sessions.abort` from another
client, an operator's authority revoked (v2026.9.6), a
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

**Changed since 2026.9.6** (re-verified at v2026.9.7; no preemption policy, no
`status:"queued"` ack, the announce identity is unchanged — nothing here moves
`convex/preemptRepark.ts`):

- **Steering no longer yields to a waiting followup.** `shouldSteer` stopped reading
  the queue (`$UP/src/auto-reply/reply/get-reply-run-admission.ts:553-562`): a newer
  message is parked as a steer candidate and injected into the ACTIVE run; only a
  refused injection falls back to a followup at its place
  (`agent-runner-steer-adoption.ts:104-141`). On the wire the client run looks the
  same either way (ack `started`, one bare `chat` final); only the reply's carrier
  changes. Atrium does not send while it sees activity, so its nominal path is
  untouched; the leaking cases are the "send while busy" bench family's.
- **The gateway queue is readable and cancellable.** `chat.history` marks a pending
  receipt `queued:true` while its run is a live queued turn, `cancelled:true` once
  withdrawn (`$UP/src/gateway/server-methods/chat-history-handler.ts:231-250`), and
  `pendingInputs` gains `items[].queued` and `queuedCount`
  (`$UP/src/gateway/server-methods/chat-pending-inputs.ts:72-113`);
  `chat.abort {runId, discardPendingInput:true}` withdraws a queued input (exact
  `runId` required, `chat-abort-handler.ts:84-91`). Not read by Atrium yet.
- **A run cancelled before execution started** carries `executionStarted:false,
  providerStarted:false` on its lifecycle end and no longer ends the session status
  (`$UP/src/gateway/chat-abort.ts:621-630`). Atrium decides on `state`.

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
  another client, operator revocation, worker placement cancel, gateway
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
  (`chat-send-handler.ts:562-590`), and nothing on the wire links the client run to
  the followup run: the gateway holds both identities only in its own state
  (`chat-send-turn-adoption.ts:16-25`), and names them together in a log line
  only when the late reply is DROPPED (`chat-send-late-followup.ts:39-48`) —
  a delivered followup writes no such line. So the bridge narrows
  it (defect 18) — preventing it only when the delivery run is visible to the
  bridge and the release check succeeds within its budget: it holds a send
  while a delivery run it can see is live
  (spontaneous turn open or still finalizing, or announce frames stashed). A
  run ENDING is not the gateway releasing it: the run's lifecycle `end` and
  `chat final` are broadcast before `clearActiveEmbeddedRun`
  (`post-run.ts:673-679`, behind an awaited trajectory flush,
  `deferred-lifecycle-owner.ts:103-119`; trajectory capture is on by default),
  while admission reads that registry (`embedded-agent-runner/runs.ts:917`,
  `get-reply-run-admission.ts:511-512`). So after a delivery the bridge also asks
  `chat.history` for `sessionInfo.hasActiveRun` — true across that window for
  a run that ended normally (`chat-history-handler.ts:368-378`,
  `embedded-agent-runner/runs.ts:1059-1086`) — and waits while it is true. That check only NARROWS
  the window. The signal is not the admission predicate: it also counts
  terminal persistence and projected or queued states
  (`session-active-runs.ts:256-273`), and misses an aborted handle still
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
  `$UP/src/config/sessions/transcript-write-context.ts:411`, identical
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
  `failover-error.ts:702-705`; `model-fallback-runner.ts:605-606` rethrows it) but,
  unlike the 2026.7.x lock, the announce delivery's own retry loop **may retry
  it**: `isTransientAnnounceDeliveryError`
  (`subagent-announce-delivery-retry.ts:136-171`, used at `subagent-announce-delivery-retry.ts:248`) returns no
  retry on send evidence, then defers to a typed retryability when one exists,
  then refuses a permanent non-writer error, and only then retries a writer
  rebound. When a direct delivery has failed, its disposition is `ambiguous`
  on send evidence, otherwise `permanent_failure` for this rebound unless a
  typed retryability decides otherwise
  (`subagent-announce-direct-delivery.ts:612-623`,
  `isPermanentAnnounceDeliveryError` at `subagent-announce-delivery-retry.ts:173-179`). The regex at
  `subagent-announce-delivery-retry.ts:58-59` is only
  the shared definition. The retry file is byte-identical 2026.9.2 → 2026.9.4;
  the direct-delivery classification block is unchanged in meaning
  (`subagent-announce-direct-delivery.ts:689-700` at v2026.9.2). Refusal codes are redacted (`session-rebound`,
  `session-entry-missing`) — no filesystem path reaches the message.
  **Since 2026.9.3 (absent from the v2026.9.1 and v2026.9.2 sources; read at
  v2026.9.4), when it ends a generating run the wire does not carry this
  sentence.** The gateway maps it to the storage failure
  `transcript_writer_fenced` (`$UP/src/infra/sqlite-error-diagnostics.ts:11`)
  and renders it as the user-facing copy "⚠️ Agent run failed: the transcript
  writer no longer owned this session. Retry in the current session; if it
  repeats, check Gateway logs."
  (`failover/assistant-request-failure-copy.ts:48-49,76`), which becomes the
  lifecycle `error` (`embedded-agent-subscribe.handlers.lifecycle.ts:164-180,233`)
  and the chat error's `errorMessage` (`server-chat.ts:607,1125`). Atrium
  classifies both renderings as `session_write_conflict`; the copy's "Retry"
  does not make it retryable. A failed run also leaves its partial text in the
  transcript as an assistant entry with `stopReason: "error"`
  (`assistant-error-transcript.ts:58-104,141-149`, same versions), returned by
  `sessions.get` with its `content` and `stopReason` intact: the bridge's
  transcript recovery never takes such an entry as the reply. Another valid
  reply or message-tool delivery of the same turn still comes back; with none,
  the recovery keeps polling and settles with its honest cause.
- **`Session <id> already has an active turn claim`** (`ActiveTurnClaimError`,
  `$UP/src/gateway/worker-environments/placement-turn-claims.ts:53`): joins the
  coordination family at 2026.9.1 (`failover-error.ts:52-58`), so a busy
  session no longer cycles the whole provider fallback chain.
- The init conflict's OCC now also reads the **parent/main** session rows
  (`relatedSessionKeys`, `auto-reply/reply/session.ts:593-605`): same message, but a write on a
  parent session can now trigger it. Upstream retries up to **5 times** with
  250 ms → 4 s backoff (`SESSION_INIT_CONFLICT_MAX_ATTEMPTS`), not the single
  internal retry described above.

None of these messages receives special handling in the Control UI: they arrive
as `state:"error"` with the raw text in `errorMessage`, **no `errorKind`**, no
retry — except the writer-claim rebound ending a generating run since 2026.9.3,
whose `errorMessage` carries the `transcript_writer_fenced` user-facing copy
instead of the raw text (above). The UI keeps already-streamed text as messages next to the error.

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
(`$UP/src/agents/sessions/agent-session-types.ts:33,48`).

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
the manual path (`$UP/ui/src/pages/chat/tool-stream-status.ts:208-291`).

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
   sessionId) are not consumed** — the bridge holds no
   `sessions.subscribe` subscription. The manual path is covered by the
   rotation detector and by Atrium's own `sessions.compact` calls.
2. Upstream's `manual/threshold/overflow` taxonomy is not persisted; Atrium
   keeps its `preflight`/`midturn` phases (a free-string field end-to-end,
   so the taxonomy can be enriched without a schema migration).

What Atrium already uses from the explicit API: `sessions.compact` (manual),
and `sessions.compaction.list` (content-free history) on gateways BELOW v2026.9.6 —
the checkpoints it listed were retired there, and the read is refused by name. The detected events
are persisted as `{kind:"compaction"}` message parts and pressure traces —
a durable surface the Control UI does not have.

---

**Changed since 2026.9.6** (re-verified at v2026.9.7): the compaction emitters are
unchanged. NEW, and not a compaction: when a run that must reply ends with visible
text while its saved plan has unfinished steps, the runner queues a hidden
`openclaw.plan-completion-check` follow-up and continues the SAME run
(`$UP/src/agents/embedded-agent-runner/run/attempt-stream-prepare.ts:285-300`) — no
lifecycle terminal, then a new `lifecycle start` on the same run id. The normalizer
reads that start as a run start and must never infer a compaction from it.

## 5. `chat.send` idempotency

### Upstream derivation and dedupe window

- **Control UI derivation**: `idempotencyKey` **is** the client-generated
  run UUID (`crypto.randomUUID`), assigned once at enqueue time and **reused
  verbatim on every retry** (`$UP/ui/src/pages/chat/chat-send-queue-state.ts:94`,
  `chat-send-delivery.ts:211,258`, `ui/src/pages/chat/chat-send-request.ts:53` at v2026.9.2).
  No content hash, no timestamp on the client side.
- **Gateway validation**: `NonEmptyString`, opaque, no normalization — the
  key *becomes* the run's `runId`
  (`$UP/src/gateway/server-methods/chat-send-session.ts:103`; "chat.send
  idempotency keys are exact protocol identities", `chat-queued-turns.ts:65`).
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
  `chat-abort-authorization.ts:56-62`); pending/active/queued →
  `{runId, status:"in_flight"}`.
- **Since 2026.9.2 the key is bound to its content.** The gateway stores a
  request identity with the key — `sha256(JSON.stringify([message,
  mentions]))`, `server-methods/chat-send-request.ts:308-316` — at admission, and a reuse of
  the key with DIFFERENT input is refused: `INVALID_REQUEST` with
  `details.reason: "chat-request-conflict"` and the message "This message ID
  was already used for different input…" (`chat-send-pre-admission.ts:177-184`),
  while the original run keeps running. After the RAM window the comparison
  falls back to the transcript's submitted input (`chat-send-pre-admission.ts:222-250`). "Always an ack"
  therefore holds for a faithful duplicate only.
- The announce idempotency family (`announce:v1:<childKey>:<runId>`) is a
  **separate, persisted delivery identity** — unrelated to the chat.send
  dedupe map.

### Atrium behavior and verdict

- Bridge derivation: `webchat-<sha256(sessionKey|clientMessageId)>`
  (`bridge/src/providers/openclaw/openclaw-client.ts:1334-1345`), stable across Convex's at-least-once
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

Fixtures built from upstream sources at `v2026.9.4` — copied from upstream unit tests, or
composed: the fixture's `_about` lists every composed part, and only the three scenarios composed
throughout say `COMPOSED` in their own description — are vendored in
`bridge/test/fixtures/openclaw_upstream_frames.json` and replayed by
`bridge/test/upstream-frames.test.ts`; their citations are checked by
`bridge/test/upstream-citations.test.ts`.
