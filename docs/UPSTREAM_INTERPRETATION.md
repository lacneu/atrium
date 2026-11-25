# OpenClaw Upstream Interpretation Comparison — Control UI vs Atrium Bridge

Factual comparison of how the **official OpenClaw Control UI** (the `ui/`
client in the upstream repo) and the **gateway source** interpret the
WebSocket protocol, versus the Atrium bridge normalizer
(`bridge/src/providers/openclaw/normalizer.ts`) and turn-sink
(`bridge/src/core/turn-sink.ts`). Companion to
[PROTOCOL_CONTRACT.md](PROTOCOL_CONTRACT.md), which describes the vendored-schema
ratchet; the per-field classification lives in the coverage manifests under
`bridge/protocol/openclaw/coverage/`.

Reference source: `github.com/openclaw/openclaw` at tag **`v2026.10.33`** — the
exact `maxValidated` gateway version in `bridge/src/compat.ts`. The extended-stable line
before it, 2026.9.x up to v2026.9.36, stays supported: where the two differ, the text says
"on 2026.9.36", and a citation read at that tag says so on its own line (`at v2026.9.36`).

> **WHAT "ANCHORED AT v2026.10.33" MEANS.** The CONCLUSIONS below were re-verified against that
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
`2026.10.33` (`DRIFT_VENDORED_VERSION`, `protocol-drift.ts`), the same version as
the validated ceiling. An unknown-field warning against a validated gateway is
therefore real drift, not schema staleness — it names a field the published
contract does not declare, and should be read as such.

**Revision of 2026-11-24 (v2026.9.36 → v2026.10.33).** The next extended-stable release
(upstream commit `5196fbbf8983`), cut from the 2026.10 mainline rather than backported onto
the 9.x line. Both lines are supported, so sections 1 to 12 now describe v2026.10.33 and say
"on 2026.9.36" wherever the older line behaves differently. Every `file:line` citation was
re-read at the new tag: 124 had MOVED and were corrected in place, 36 were re-anchored on a
literal chosen anew because the code around them was rewritten or moved to another file, and
five are dated `at v2026.9.36` on their own line — the 2026.9.36 side of a difference, or code
that no longer exists. The live
suite ran GO on the tag, full catalogue, projection on (run
`openclaw-notes/atrium/bench-runs/2026-11-24T22-39-08-086Z/`).

Negotiation and the method table. A 2026.9.36 client is accepted as it is: `PROTOCOL_VERSION`
is 4 in both tags and `ConnectParams` is unchanged. The method table is append-only: 46
methods added, none removed or renamed. `schema/skill-curator.ts` and its schemas are gone;
the `skills.curator.*` methods remain and answer `INVALID_REQUEST`. The announced catalogue
gains `agent.identity.changed` and `session.reaction`; the scope-guard table also gains
`mcp.app.resourceUpdated` and `mcp.app.hostContextChanged`. Atrium reads none of the four
(`bridge/protocol/openclaw/events/2026.10.33.json`). Three reads can be shared between
identical callers for up to one second — `models.list`, `sessions.list` and `cron.list`
(`$UP/src/gateway/methods/core-descriptors.ts:110,230,322`); the catalogue has no scenario
that reads a child row during a status transition on a per-user socket, so that sharing is
not measured. The vendored contract is the schema modules, the three derived catalogues and
the emission inventory of the `agent` channel (`agent-emissions.json`), classified in
`bridge/protocol/openclaw/emissions/2026.10.33.json`.

What moved, zone by zone — each is described where it belongs:

- **Zone 1 (§1).** The live text of a run is RETIRED from the chat buffer when its transcript
  row is committed, and the terminal then carries `openclawDisplayContent` beside `content`;
  an admission stands in front of the gateway's event handler; a `chat:error` waits for the
  durable write of its terminal; a turn refused or cut by a draining gateway ends `aborted`
  with `stopReason:"restart"` where it ended in an error.
- **Zone 2 (§2).** A send admitted into the follow-up queue keeps its identity: no empty
  `chat final` at admission, the answer under the client run's own id, a repeated key
  answered `accepted`; the requester-settle run id gains a `:pause` segment.
- **Zone 3 (§3).** The failure copies the classifier matches were reworded; each is classified
  as before, beside the 2026.9.36 wording.
- **Zone 4 (§4, §9, §11).** The session row gains `usageReport`; a reasoning item's commit is
  receipted on the `thinking` stream; the retry status names five reasons.
- **Zone 5 (§5).** The request identity is a keyed digest persisted with the user turn, and
  the admission reads asynchronously.

**Upgrade note, one-way.** The agent database schema is 27
(`OPENCLAW_AGENT_SCHEMA_VERSION`, `$UP/src/state/openclaw-agent-db-contract.ts:9`); it is 24
on 2026.9.36. A state migrated by a 2026.10.33 gateway is not read by a 2026.9.x one.

**What the capture of that run shows** (20,036 events and 955 responses received; the capture
holds received frames only):

- *Retired live text.* 192 `chat` deltas carry `replace:true`, each with `deltaText:""` and a
  `message` whose text is empty. Every one comes after its run's last text and its
  `lifecycle` `finishing`, with the `seq` of the run's last `agent` event — strictly above the
  last delta's — and its terminal follows 22 to 732 ms later (median 47 ms). None arrives in
  the middle of a reply and none carries a non-empty tail: no scenario makes a run commit one
  assistant message and then write another. The bridge of that run emptied the live bubble on
  that frame and wrote the complete text at the `final` (its log holds no
  `snapshot_regression`): the blank that reading left on screen is what §1 now avoids.
- *Display content.* 191 of 216 `final` frames carry `openclawDisplayContent`: 189 empty
  lists, 2 holding the canvas block of an inline widget. `content` is the complete text in
  every one. The projection audit of the run reports no duplicated answer.
- *Context budget.* Every answer that returns a session row (185, the describe among them)
  carries `contextTokens`, for both models in use; 124 also carry `contextBudgetStatus`, whose
  `contextTokenBudget` equals the row's `contextTokens` in every one; the other 61 carry none.
- *Approvals.* The 14 `lifecycle` `waiting-approval` frames and the 9 `approval-resolved`
  ones carry `approvalId` and `toolCallId`. No `stream:"approval"` frame was emitted: every
  exec approval of the run waited in place.
- *Reasoning receipts.* 20 `thinking` frames of phase `persisted`, each with `itemId`,
  `messageId` and `messageRunId`.
- *Queued send.* One send reached the follow-up queue (`announce-reverse-hold`): acknowledged
  `started`, no empty `chat final`, and its answer came under the client run's own id. Its
  first frame was a `seq gap` report (expected 5, received 6), and its `chat final` carries
  `seq` 1 after deltas numbered up to 13 — the one place where the run's numbering goes
  backwards. Every one of the 42 `chat.send` acknowledgements says `started`; none says
  `accepted`, no key was repeated.
- *Order.* On each connection the envelope `seq` has no hole and never goes back; within each
  run the `agent` events arrive in increasing `seq`. No reordering by the admission is visible
  beyond the `chat final` above.
- *A field no schema declares.* The 220 `lifecycle` `model` frames that clear the observed
  model carry `sessionLifecycleRevision` beside `agentId`, `sessionId` and `lane`: the emitter
  spreads the run's whole identity onto the event, and the identity gains that member at this
  tag. It is in no schema and on no session row, so the drift detector declares it with the
  routing envelope (`AGENT_ROUTING_ENVELOPE_FIELDS`, `protocol-drift.ts`); Atrium does not
  read it.
- *Not exercised by the catalogue*, so still read in the sources only: a `:pause` settle run,
  a retry status (any reason), a question with a `value` or more than four options, a
  dropped queued input, a key reused with another text, the `rebuilding` refusal, a restart
  in the middle of a turn, an agent's `[embed]` of a video. The acknowledgement latency of
  `chat.send` cannot be read from the capture, which records no request; the bridge's log of
  the run holds no acknowledgement timeout over its 44 sends.

**Revision of 2026-11-02 (v2026.9.33 → v2026.9.36).** Three maintenance releases of the
extended-stable line (v2026.9.34, v2026.9.35, v2026.9.36), backports only, read as one diff
against v2026.9.33 (report: `openclaw-notes/atrium/bench-runs/upstream-diff-2026.9.33-vs-2026.9.36/`
— 8 of the 145 watched files changed, 42 anchors held). In `packages/gateway-protocol/src` three
files moved, all additively: two of the 86 vendored modules — the Control UI client cap
`ui-agent-github-settings` (`client-info.ts`; the bridge never declares it) and
`timeoutPhase: "tool_execution"` on a worker lifecycle terminal (`worker-admission.ts`) — and the
non-vendored `ui-command.ts` (an `agent-github-settings` UI command). Both event catalogues are
byte-identical. What the watched changes mean for Atrium, zone by zone:

- **Zone 1.** A run killed by a TOOL EXECUTION deadline now ends with
  `timeoutPhase: "tool_execution"` (`$UP/src/agents/agent-run-terminal-outcome.ts`,
  `isAgentRunResumableToolTimeout`), and its session row records `status: "interrupted"` with
  the advisory `lastRunError` "Tool execution timed out with an unknown outcome. Resume to verify
  state before repeating it." plus a restart-recovery checkpoint
  (`$UP/src/gateway/session-lifecycle-state.ts`) — where 2026.9.33 recorded a timeout. The
  Control UI shows `lastRunError` for any non-`done` status (`ui/src/pages/chat/chat-history-stream.ts`,
  unchanged). Atrium reads the run's own terminal as before; its transcript error reading takes
  `failed`/`timeout` only, so such a run shows Atrium's timeout reading, not upstream's resume
  advice, and the trace buckets `tool_execution` (like `preflight`/`post_turn` already) to
  `other`. Not exercised by the bench (no scenario hits a tool deadline).
- **Zone 2.** `chat.send`'s admission interrupt now stamps `stopReason: "restart"` only for a
  restart abort reason and `"rpc"` for every other interruption (it was the reverse default,
  `$UP/src/gateway/server-methods/chat-send-admission.ts`). Atrium decides nothing on either
  value (trace allowlist only). `attempt-execution.helpers.ts` changes concern the Claude CLI
  runtime only.
- **Zone 4.** A completed answer followed by a reasoning-only tail is kept instead of being
  replaced by the incomplete-turn warning (`run/incomplete-turn-resolution.ts`, `keptAnswer`):
  fewer "couldn't generate a response" terminals, same wire shape.
- **Zone 5.** `chat.send` now stores the normalized (trimmed) text as the inbound message even
  without a work context (`chat-send-request.ts`). The dedup window, the TTLs and the
  doublon-ack behaviour are unchanged; Atrium places transcript rows by identity, not by text.

Read outside the watchlist: `sessions_yield` is declared `async: false`, so a yield pauses an
async tool response and receives that response's async results with its own result
(`src/agents/tools/sessions-yield-tool.ts`); the yield/settle scenarios ran GO on it. Six
citations moved by one to thirty-one lines and were corrected in place. The live suite ran GO
on the tag before the ceiling moved.

**Revision of 2026-10-15 (v2026.9.9 → v2026.9.33).** The extended-stable line: v2026.9.33
is cut from v2026.9.9 and carries backports only (17 commits). Re-verified against the tag
(report: `openclaw-notes/atrium/bench-runs/upstream-diff-2026.9.9-vs-2026.9.33/` — none of the
145 watched files changed, 42 anchors held; `packages/gateway-protocol/src` is unchanged, the
86 vendored schema modules and both event catalogues are byte-identical beyond their
provenance header). Two citations moved by one or two lines and were corrected in place.
Read outside the watchlist, with no wire change for Atrium: the Control UI's typed stop command now asks `chat.abort` at SESSION scope (no
`runId`; `ui/src/pages/chat/chat-send-submit.ts`, `run-lifecycle.ts`) where it named the
run — a choice of that client: the `chat.abort` schema is unchanged, and Atrium's Stop keeps
naming the run when it knows it; a session archive/delete drain now issues its run
cancellations from a dedicated cancellation-started step rather than after the queue clear
(`sessions-lifecycle-drain.ts`); long streamed replies carrying reply directives reuse the
settled text instead of re-parsing the whole reply on every delta
(`embedded-agent-subscribe.handlers.messages.stream.ts`), a performance fix upstream proves
text-identical. The live suite ran GO on the tag before the ceiling moved.

**Revision of 2026-10-13 (v2026.9.8 → v2026.9.9).** A maintenance release of the 9.x
line. Re-verified against the tag (report: `openclaw-notes/atrium/bench-runs/upstream-diff-2026.9.8-vs-2026.9.9/`
— one of the 145 watched files changed, 42 anchors held; `packages/gateway-protocol/src`,
the 86 vendored schema modules and both event catalogues are byte-identical beyond their
provenance header). Two citations moved and were corrected in place. The one watched
change is a BEHAVIOUR change of `sessions.compact`, read in §4: a session the gateway has
no record of is now refused instead of answered as a refusal. Atrium maps it back to the
2026.9.8 answer, so neither the manual compaction nor the pre-send guard changes outcome.

**Revision of 2026-10-04 (v2026.9.7 → v2026.9.8).** A reliability hotfix ("No
intentional capability changes", upstream CHANGELOG). Re-verified against the tag
(report: `openclaw-notes/atrium/bench-runs/upstream-diff-2026.9.7-vs-2026.9.8/` — none of
the 140 files watched until then changed, 42 anchors held; the 86 vendored schema modules
and both event catalogues are byte-identical beyond their provenance header). The five
zone-2 files that carry the silent-reply change below were outside the watchlist and are
now on it. Of the 111
non-test source files that changed outside the watchlist, the gateway-side ones were
read zone by zone: the WebSocket authorization rework (`grantGeneration` beside
`generation`, `$UP/src/gateway/auth-policy.ts:98-130`) does not move for a shared-token
client without an `Origin` header; session-row publication, the transcript workers and
the Talk relay are refactors with identical output; the `sessions_send` agent-to-agent
ping-pong and announce step are removed (`sessions-send-tool.a2a.ts`), which Atrium never
read. Four citations moved and were corrected in place; none of the six zones below
changed its conclusion.

One behaviour changed WITHOUT a wire change, and it is the one to keep in mind when
reading §2: a silent reply (`NO_REPLY` or an empty answer) is now allowed only in a
channel group (`$UP/src/shared/silent-reply-policy.ts:32-41`), and a run started through
the `agent` method — announce, requester-settle wake, sub-agent child, inter-session
delivery — resolves its reply expectation to `required` unless that policy allows it
(`resolveCommandReplyExpectation`, `$UP/src/agents/command/attempt-execution.helpers.ts:48-75`).
An empty one is retried with a visible-answer instruction, then ends as an incomplete
turn instead of settling in silence; the sub-agent and settle prompts stopped asking
for `NO_REPLY`. The token, the run ids (`announce:v1:…`, `announce:requester-settle:…`)
and the frame shapes are unchanged, `chat.send` turns are not concerned, and the full
bench (sub-agent merge, chain, parallel, async task, reverse hold) stayed green — so
nothing was adapted; Atrium's silent-settle paths are simply taken less often.

**Upgrade note.** The agent database schema is still 24, as in 2026.9.7. The official
image entrypoint runs `openclaw doctor --fix` before every start, which migrates a
2026.9.6 state 23 → 24 at the first boot (one `.pre-startup-migration-*.bak` per
database). The gateway's single-owner lease (`$UP/src/infra/gateway-owner-lease.ts:284`,
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
  reconnects (`$UP/ui/src/api/gateway-chat-events.ts:57-72`), the bridge withholds
  the fragment and re-reads the run's in-flight text (`chat.history` →
  `inFlightRun`, `resolveInFlightRunSnapshot`, `$UP/src/gateway/chat-abort.ts:309-331`).
- **The `tasks.*` RPCs are gone** (`tasks.list|get|cancel|history` and
  `schema/tasks.ts`; the Control UI's own test asserts it sends none of them,
  `run-transcript.e2e.test.ts:130`). The background-task probe answers empty from
  this version on (`TASKS_RPC_RETIRED_IN`, bridge `compat.ts`), never sent; the
  `task` event left the announced catalogue but stays broadcastable. With the registry
  gone, a media task's id is its own run id, `tool:<toolName>:<uuid>`
  (`$UP/src/agents/tools/media-generate-background-shared.ts:227,302`), so its delivery
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
`$UP/src/state/openclaw-agent-db-contract.ts:29` at v2026.9.36) and is NOT migrated at boot: the
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
  profile identity) aborts its admitted runs (`operator-run-cancellation.ts:149-153`).
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
  (`$UP/ui/src/pages/chat/chat-gateway.ts:111-114`, `stopReason === "auth-revoked"`).
  A field that was decorative upstream has become load-bearing there; Atrium's
  reading is unchanged and still takes the verdict from `state`, which is the
  divergence this document exists to record.
- `[+] $UP/src/gateway/server-methods/sessions-read-by-key.ts :: const row = buildGatewaySessionRow({`
  — the session describe is now assembled through a shared row builder. The fields
  Atrium reads are the same ones; the assembly moved.

**The RETRACTION delta, handled without a capture.** 2026.9.5 adds a retraction —
`delta { deltaText: "", replace: true }`, carrying a `message` whose text is empty.
The append path still drops any delta whose text is empty
(`bridge/src/providers/openclaw/normalizer.ts:2128`, the `&& deltaText` guard), so
the retraction has its own branch in `handleChat`. From v2026.10.33 the same frame closes
every run whose text was committed to the transcript (§1): on the wire, a text taken back and
a text recorded are one frame, and the Control UI tells them apart by its durable rows. The
bubble does so by the transcript too (§1, "Live text is retired"): the emptying is held at
once and WRITTEN with what replaces the text shown — the run's next text, or the terminal
(a declared empty snapshot ahead of an empty final) — never on its own. A real retraction
therefore still ends on an empty bubble; a recorded text never leaves the screen. Both are
covered by deterministic tests, the retraction in upstream's own shape and the recording on
frames captured at v2026.10.33 (`bridge/test/retired-live-text.test.ts`). The `assistant`
stream's own retraction (`text: ""` with `replace`) is not read: the `chat` delta carries it.

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
(`$UP/packages/gateway-protocol/src/schema/logs-chat.ts:532-538`), four frames
discriminated by `state`, common base `{runId, sessionKey, agentId?,
spawnedBy?, seq}`:

| `state` | Own fields | Emitted when |
|---|---|---|
| `delta` | `deltaText` (required), `replace?`, `message?` (cumulative snapshot), `usage?` | per assistant stream frame, paced at 75 ms (`LIVE_TEXT_PACING_MS`); a buffered delta is flushed just before any terminal (`server-chat.ts:715-718,833`) |
| `final` | `message?` (may be absent), `usage?`, `stopReason?` | lifecycle `end` whose terminal outcome is `done` (`server-chat.ts:491-501,873-900`) |
| `aborted` | `message?` (partial text), `errorMessage?` (tool-validation summary only), `stopReason?` | terminal outcome `cancelled`/`aborted`, or direct `broadcastChatAborted` (`chat-abort.ts:405-444`) |
| `error` | `errorMessage?`, `errorKind?`, `errorDetail?`, `usage?`, `stopReason?`, `message?` — declared; the gateway's own error payload never sets `usage`, and sets `message` (the run's buffered text) only when the run has an assistant-transcript idempotency key and text, from 2026.9.5 (`server-chat.ts:895-907`) | lifecycle `error`, or `end` classified `failed`/`timed_out`/`hard_timeout`; lifecycle errors get a 15 s retry grace before emission (`server-chat.ts:91-96,254,1519-1538`) |

**`stopReason` is a free-form string at the wire level** (`Type.Optional(
Type.String())` — no wire enum). Producers: the model runtime enum
`"stop"|"length"|"toolUse"|"error"|"aborted"` (`$UP/packages/llm-core/src/types.ts:355`,
raw provider values like `end_turn` may also pass through) and
gateway abort paths (`"aborted"`, `"restart"`, `"timeout"`, `"rpc"` — a
generic RPC/internal abort reason, of which a user Stop is one example —
`"auth-revoked"`; arbitrary caller values like `"user"`
also occur). Crucially, **the gateway consumes stopReason before emission**:
`buildAgentRunTerminalOutcome` maps it into `state` (`rpc|stop` → `aborted`
only when status ≠ ok; `timeout` + aborted → **`error`**, not `aborted`;
stale-generation `restart` frames are suppressed entirely — rules at
`$UP/packages/normalization-core/src/agent-run-terminal-outcome.ts:91-129`, suppression at
`$UP/src/gateway/server-chat.ts:435-452`,
`server-chat.agent-events.test.ts:1537`).

`errorKind` is a closed enum `refusal | timeout | rate_limit | context_length
| state_contention | unknown` (wire mirror `ChatEventErrorKindSchema`,
`$UP/packages/gateway-protocol/src/schema/logs-chat.ts:401-408`). It is
populated from a structured kind on the lifecycle event, then from the
`FailoverReason` (`server-chat.ts:128-165`), then from a timeout probe; in
practice the fallback never yields `"unknown"`, and a generic 5xx is
deliberately left unbadged.

**Changed since 2026.7.1** (re-verified at v2026.9.1, no impact on what the
bridge reads):

- **`message` is no longer emitted on `state:"error"`** (since 2026.8.1):
  `emitChatTerminal` omits it and the upstream tests assert its absence
  (`server-chat.agent-events.test.ts:2249`). The `"Error: …"` prefix is now
  built by the Control UI (`chat-gateway.ts:83-98`). Atrium reads
  `errorMessage` first, so nothing changed for it — but the `message` fallback
  in its coverage manifest is dead code against a ≥2026.8.1 gateway.
- **`detectErrorKind` is gone from the core** (deprecated shim in
  `plugin-sdk/infra-runtime.ts:133-176` at v2026.9.36, gone at the reference tag); the derivation above replaced it. The
  enum and its five values are unchanged.
- **NEW `errorDetail` on `state:"error"`** (2026.9.1,
  `logs-chat.ts:439-493`): a bounded, redacted record — `provider`, `model`,
  `failoverReason`, `providerRuntimeFailureKind`, `providerErrorType`,
  `httpStatus`, `providerErrorMessagePreview`. Purely additive: `errorMessage`
  is still emitted. The Control UI reads exactly one thing from it
  (`providerRuntimeFailureKind === "auth_refresh"`, `chat-gateway.ts:62-74,117-123`).
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
`server-broadcast.ts:456-490`) — fewer `chat:delta` frames with longer
`deltaText` and a non-contiguous `payload.seq`; the envelope `seq` stays
contiguous and a terminal always drains the queue first, and Atrium reads the
cumulative `message` snapshot before any delta (`normalizer.ts`); (b) a
replaceable provisional assistant item (`replace:true, replaceable:true`) now
clears the prefix on the cumulative text, so the `final` and the assistant
stream agree; (c) a retryable HTTP 5xx or a reset is no longer promoted to
`stopReason:"timeout"` — only a recorded timeout is (`run-termination.ts:134-146,187-190`),
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
  (`$UP/src/gateway/server-methods/chat-aborted-partial.ts:240,264-265`). The bridge's
  finalize is first-terminal-wins, so the turn stays `aborted`.
- **`SessionRow.status` gains `"interrupted"`**
  (`$UP/packages/gateway-protocol/src/schema/sessions-row.ts:38-46`), no longer folded
  into `failed` by the projection (`session-utils-display.ts:137`). Atrium does not
  read `SessionRow.status`.

**Changed since 2026.9.36** (v2026.10.33; no capability negotiates any of it):

- **Live text is retired when its transcript row is committed.** Each transcript update
  first passes through `retireTranscript`
  (`$UP/src/gateway/server-runtime-subscriptions.ts:643-660`): the occurrences of an
  assistant message that now has a row are marked committed, and a chat flush is forced. What
  a socket then receives is a `chat` delta with `replace:true` whose `message` is the
  UNCOMMITTED TAIL of the run's text — empty when everything is committed — numbered with
  the seq of the run's last `agent` event, not a new one
  (`$UP/src/gateway/server-chat-transcript-publication.ts:228`). A replacement is also sent
  whenever nothing is pending for the socket, even when the new text extends the old
  (`$UP/src/gateway/server-chat-state.ts:350-374`), and deltas and terminals are held while a
  transcript publication is pending for the run
  (`$UP/src/gateway/server-chat-transcript-publication.ts:51-73`). `chat.history`'s
  `inFlightRun.text` is that tail too. The Control UI replaces its stream with the delta's
  `message`, whatever its length; the gateway now does the cutting the client used to do. On
  2026.9.36 a run's buffer stays cumulative from its first delta to its terminal.
  **Atrium** shows a live bubble from ONE carrier, its live text: its rows make its text only
  once its runs are over (§7). Written as it arrives, the emptied tail therefore blanked the
  answer on screen from that delta to the terminal (measured below: 22 to 732 ms, at the end
  of every turn). The bridge reads the frame against the transcript instead, as the Control
  UI's two carriers do (`$UP/ui/src/pages/chat/chat-gateway.ts:446-457`, "ignoring it would keep
  already-saved text visible beside its durable row"):
  - a VISIBLE assistant row of the same run was recorded (`session.message`, handed over by
    the reconciler in the frames' order): the text changed carrier. Nothing is written, the
    bubble keeps it, and the stream's later text is shown after it with the gateway's own
    item boundary (`$UP/src/gateway/agent-event-assistant-text.ts`, `boundaryNewlines`) —
    what the terminal's complete `content` then states. The row and the delta travel on two
    sockets: measured, the row first in 168 of 190 emptyings and up to 2 ms after the delta
    in the others, so a row settles the emptying already read or the next one;
  - no such row is known (a text really taken back; a bridge that does not hear the
    transcript): the emptying is held as before, and written with what replaces the text
    shown — the run's next text or the terminal — never on its own.
  A row is this emptying's only until the run's stream states another text: a `message`-tool
  send is recorded as a visible row and withdraws nothing. A replacement to a NON-empty
  shorter tail (one message recorded while the next is already streaming) is still read as
  the declared rewrite it is: the bubble is cut to the tail until the terminal. Measured on
  the bench (revision note above): the frame arrives once per run, after the last text, with
  an empty tail, 22 to 732 ms before the terminal. A reply that commits one message and then
  writes another — the retirement in the middle of the answer — is not in the catalogue: that
  path is covered on hand-built frames in upstream's wire-test shape only.
- **The terminal carries `openclawDisplayContent` beside `content`** when part of the text
  was retired: the tail's text blocks and the canvas blocks, while `content` stays the
  COMPLETE text (`$UP/src/gateway/server-chat.ts:842-866`). The Control UI swaps `content`
  for the display field before it reads anything
  (`$UP/ui/src/pages/chat/chat-gateway.ts:102-110`), which is how it avoids showing the
  committed rows twice. **Atrium** does not read the field: it takes the complete text, as on
  2026.9.36, and its transcript projection already withholds a text its rows carry (§7).
  Measured: an empty list on 189 finals, the widget's canvas block on 2, no duplicated answer.
- **An admission stands in front of the event handler.** On 2026.9.36 the gateway's handler
  receives each agent event from the bus and works it synchronously. Now the function
  registered on the bus is an admission (`createAgentEventAdmission`) that hands the event on
  UNCHANGED but can drop it or delay it. Dropped: an event that arrives after the handler was
  disposed or that belongs to a run this handler does not own
  (`$UP/src/gateway/server-chat-event-admission.ts:79-84`); an event held for a read that no
  longer resolves to the same chat link, session key or agent
  (`$UP/src/gateway/server-chat-event-admission.ts:109-116`), or whose session's stored source
  changed while it waited (`$UP/src/gateway/server-chat-event-admission.ts:59-62`). Delayed: a
  lifecycle `start`, and a terminal cancelled for a restart, wait for an asynchronous read of
  the session entry (`$UP/src/gateway/server-chat-event-admission.ts:90-93`), and every later
  event of the SAME run is queued behind it, in order
  (`$UP/src/gateway/server-chat-event-admission.ts:97-120`); an event with nothing to wait for
  is handed on at once (`$UP/src/gateway/server-chat-event-admission.ts:104-106`). The handler
  receives the same event with the read's verdict beside it
  (`$UP/src/gateway/server-chat-event-admission.ts:117-118`). A terminal `chat` frame can be
  held the same way by the transcript publication, which later publishes the frame that was
  built (`$UP/src/gateway/server-chat.ts:739-748`). The frames of one run keep their order;
  the queue is per run, so two runs of one session, or a run and a broadcast that does not go
  through the handler (`sessions.changed`, a question, an approval), may interleave
  differently. Measured: no hole and no step back in any connection's envelope seq, and every
  run's `agent` events in increasing seq.
- **A `chat:error` waits for the durable write of its terminal.** The session's terminal
  write starts before the emission, and the error frame is published once that write has
  settled, if the event is still current (`$UP/src/gateway/server-chat.ts:440-455`); `final`
  and `aborted` stay synchronous. Its `errorMessage` passes through a fixed copy for four
  internal messages of the Codex app server (`$UP/src/gateway/server-chat.ts:899-910`). Same
  frame, later by one write; Atrium closes a turn on a final lifecycle error without waiting
  for it, as before.
- **A draining gateway ends a turn `aborted`, `stopReason:"restart"`.** A `chat.send` whose
  dispatch fails during a drain is broadcast as that terminal
  (`$UP/src/gateway/server-methods/chat-send-dispatch-errors.ts:216-247`) where 2026.9.36
  broadcasts a `chat:error`, and the Control UI records the session `interrupted` rather than
  `killed` for it (`$UP/ui/src/pages/chat/chat-gateway.ts:280-289`). Atrium ends such a turn
  as interrupted and decides nothing on the value; what tells the reader that the gateway cut
  the turn is §12. Not exercised by the catalogue.
- **The `chat:error` that follows a `chat:aborted`** (above) now names itself:
  `stopReason:"aborted-partial-persistence-failed"`
  (`$UP/src/gateway/server-methods/chat-aborted-partial.ts:239-248`). First terminal wins, as
  before; the value is known to the trace's stop-reason buckets.

### Control UI interpretation

The Control UI's reducer discriminates on `state` — `final` → done, `aborted` →
interrupted/killed, `error` → interrupted/failed + raw `errorMessage` banner — but
it is NOT blind to the classification fields, and was not at v2026.9.6 either:
every terminal is first folded into the shared session projection, which maps
`errorKind === "timeout"` to a `timeout` run and a `final` with `stopReason ===
"error"` to `error` (`$UP/packages/gateway-client/src/session-projection-run-event.ts:46-73`).
Since 2026.9.5 it rewrites `aborted` + `stopReason "auth-revoked"`; from v2026.10.33 it also
reads `stopReason` `restart` on an aborted terminal and `aborted-partial-persistence-failed`
on an error (above). Since
2026.9.7 it branches on `errorKind === "state_contention"`
(`$UP/ui/src/pages/chat/chat-gateway.ts:84-86,116-120`): the raw text without the
"Error:" prefix, a warning-toned banner and a "Check status" action. Readers of
`stopReason` on persisted history records remain
(`ui/src/pages/chat/chat-thread-grouping.ts:438`, `ui/src/pages/chat/chat-assistant-reply.ts:53`). On
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

> **A queued send keeps its identity**: no empty `chat final` at queue admission, the reply
> and its terminal under the client run's own id, a replayed key answered `accepted`, and a
> `:pause` segment in the requester-settle run id. On 2026.9.36 the client run is closed at
> once by an empty `chat final` and the answer comes back under a follow-up run id of its
> own; "Wire visibility" and the verdict below say which statement holds on which line.

### Upstream policy — steer by default, interrupt when the mode says so

The DEFAULT queue policy does not kill either side of the announce×send
race; an EFFECTIVE `interrupt` mode does. On 2026.8.1+ no mechanism by which an
announce kills a LIVE turn was found on the production paths read (below —
sources, with a consistent live observation). Re-verified at
v2026.9.4 — this heading used to read "there is no kill policy". Contention is
resolved by:

- **Steering**: a `chat.send` arriving while a run is active on the session
  defaults to queue mode `"steer"` — the message is **injected into the
  active run** (`$UP/src/auto-reply/reply/queue/settings.ts:18-23`,
  `reply-run-registry.message-injection.ts`). Refused steering degrades to a
  FIFO **followup queue** drained after the active run ends. When the
  EFFECTIVE mode is `"interrupt"` the active run is aborted before the new
  one runs (`$UP/src/auto-reply/reply/get-reply-run-queue.ts:17`, through
  `interruptReplyRunTarget` → `abortByUser`, a generic user abort). That
  mode resolves send field → message directive (`/queue interrupt`,
  `get-reply-directives-apply.ts:520`, persisted to the session by a
  directive-only message) → session → channel → config → `steer`.
- **Announce delivery**: a sub-agent announce steers into the requester's
  active turn (`subagent-announce-direct-delivery.ts:339,381`,
  `steeringMode:"all"`, path `steered`) or, when the requester is idle,
  runs as a separate in-process `agent` run whose `idempotencyKey`/runId is
  `announce:v1:<childSessionKey>:<childRunId>`
  (`$UP/src/agents/announce-idempotency.ts:6-13`) — the exact shape
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
  field, `$UP/src/gateway/server-methods/chat-send-admission.ts:318,570`, and
  `sessions.steer` forces it, `sessions-messaging.ts:112`), a session
  reset/delete (`session-reset-service.ts:452`), a session archive/delete
  drain (`sessions-lifecycle-drain.ts`, `stopReason` = the action), an
  operator's authority revoked (`operator-run-cancellation.ts:149-153`, new at
  v2026.9.6 — a compaction checkpoint restore was on this list until checkpoints
  were retired), a worker placement move (`server-worker-placement-move-barrier.ts:90`), a sub-agent kill (on the CHILD
  session, `subagent-control-kill-runtime.ts:431-436`), a reply session rollover
  (`$UP/src/auto-reply/reply/session.ts:263`, turned into `abortForRestart`
  by the active turn, `reply-turn-admission.ts:272-274` — `stopReason:"restart"`).
  Atrium's bridge
  sets `queueMode` on a `chat.send` only when the run policy applies
  (`explicitQueueMode`, `bridge/src/providers/openclaw/follow-up-mode.ts`,
  capability `followUpModes`) and sends none otherwise; a send without one is
  NOT kept out of the `interrupt` path: a directive in the user's
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
  (`$UP/src/agents/embedded-agent-runner/run/session-bootstrap.ts:546-602`) does
  supersede a previous writer — emitting for it a lifecycle
  `{phase:"end", aborted:true, status:"superseded", stopReason:"superseded"}` —
  but only through `supersedeEmbeddedAgentRunByRunId`, which refuses a stopped
  handle (`runs.ts` `isEmbeddedRunHandleSupersedable`), and a finished run's
  handle is stopped (`attempt-prompt-phase.ts` `stopAcceptingSteerMessages` in
  a `finally`);
- for an ACTIVE requester the delivery first attempts an active wake that
  injects the completion into its live run
  (`subagent-announce-direct-delivery.ts:363-405`). When that wake is not
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
(`$UP/src/config/sessions/session-transcript-writer-claim-error.ts:46`), and a starting run
can find its turn already claimed (`ActiveTurnClaimError`,
`$UP/src/gateway/worker-environments/placement-turn-claims.ts:49`).
(Corrected 2026-09-14: this paragraph said the race kill happens at writer
ownership on 2026.8.1+ — earlier still, "emergent, not policy".)

The upstream terminals DIFFER by cause, but no single `stopReason` proves the
race. `superseded` is NOT exclusive to the writer takeover: every run ended
by `createAgentRunSupersededAbortError` carries it, and that error is created
at several sites (one under an import alias, which a search on the canonical
name misses) — among them a CLI turn whose session incarnation or lifecycle
revision moved before it executed
(`$UP/src/agents/embedded-agent-runner/run-entry-cli.ts:70`; also
`auto-reply/reply/reply-run-registry.operation.ts:555` (`supersede`, imported
as `createSupersededError`),
`embedded-agent-runner/run/deferred-lifecycle-owner.ts:184`,
`embedded-agent-runner/run/attempt-stream-prepare.ts:423`,
`gateway/worker-environments/worker-turn-run-owner.ts:127`), mapped to
`superseded` by `src/agents/agent-run-terminal-outcome.ts:499-506`. The other kills found
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
is still `steer` (`queue/settings.ts:23`), no `status:"queued"` ack exists on
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

- Followup admission publishes **nothing**
  (`$UP/src/gateway/server-methods/chat-send-agent-dispatch.ts:540-542`), and there is **no
  `status:"queued"` ack**. When the follow-up run starts, the gateway binds it to the client
  run, so its `agent` and `chat` events carry the CLIENT run id
  (`$UP/src/gateway/server-methods/chat-send-turn-adoption.ts:295-301`); an input the queue
  drops ends in an error terminal under its own id, `Queued input was dropped (<reason>).`
  (`$UP/src/gateway/server-methods/chat-send-turn-adoption.ts:303-308`). On 2026.9.36 the
  admission shows as an early empty `chat` final (`{status:"ok"}` dedupe entry) that closes
  the client run, and the answer arrives later under the follow-up run's own id.
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
  the queue (`$UP/src/auto-reply/reply/get-reply-run-admission.ts:562-571`): a newer
  message is parked as a steer candidate and injected into the ACTIVE run; only a
  refused injection falls back to a followup at its place
  (`agent-runner-steer-adoption.ts:125-162`). On the wire the client run looks the
  same either way (ack `started`, one bare `chat` final); only the reply's carrier
  changes. Atrium does not send while it sees activity, so its nominal path is
  untouched; the leaking cases are the "send while busy" bench family's.
- **The gateway queue is readable and cancellable.** `chat.history` marks a pending
  receipt `queued:true` while its run is a live queued turn, `cancelled:true` once
  withdrawn (`$UP/src/gateway/server-methods/chat-history-handler.ts:214-233`), and
  `pendingInputs` gains `items[].queued` and `queuedCount`
  (`$UP/src/gateway/server-methods/chat-pending-inputs.ts:72-113`);
  `chat.abort {runId, discardPendingInput:true}` withdraws a queued input (exact
  `runId` required, `chat-abort-handler.ts:67-74`). Not read by Atrium yet.
- **A run cancelled before execution started** carries `executionStarted:false,
  providerStarted:false` on its lifecycle end and no longer ends the session status
  (`$UP/src/gateway/chat-abort.ts:558-567`). Atrium decides on `state`.

**Changed since 2026.9.36** (v2026.10.33; still no preemption policy and no
`status:"queued"` ack):

- **A repeated key on a queued turn reads `accepted`.** The queue admission stores
  `{runId, status: "accepted"}` as the key's replayable response
  (`$UP/src/gateway/server-methods/chat-send-turn-adoption.ts:234-240`), and a cached response
  is replayed before the `in_flight` answer is reached
  (`$UP/src/gateway/server-methods/chat-send-pre-admission.ts:279-282,306-309`); 2026.9.36
  answers `in_flight`. The Control UI reads every ACK status but `in_flight`, `ok`, `timeout`
  and `error` as `started` (`$UP/ui/src/pages/chat/chat-send-ack.ts:42-46`).
- **A queued follow-up waits for the direct command in front of it** to finish its durable
  cleanup — an order, not a preemption
  (`$UP/src/agents/agent-command-recovery-owner.ts:270-279`,
  `$UP/src/auto-reply/reply/reply-turn-admission.ts:399-401`).
- **The `interrupt` branch moved without changing**: one call in the admission
  (`$UP/src/gateway/server-methods/chat-send-admission.ts:573`) to `interruptChatSendWork`
  (`$UP/src/gateway/server-methods/chat-send-work-admission.ts:233`); the reply queue's own
  test is a ternary (`$UP/src/auto-reply/reply/get-reply-run-queue.ts:17-19`); the session lane
  still holds one run (`$UP/src/agents/embedded-agent-runner/run-orchestrator.ts:753`).
- **The requester-settle run id gains a segment**: the batch key is the ids, then `yield-N`,
  then `pause` (`$UP/src/agents/subagents/registry/subagent-requester-settle-identity.ts:25-31`),
  and `:retry-K` follows it, now also on a pause notice
  (`$UP/src/agents/subagents/registry/subagent-requester-settle-identity.ts:34-39`). A pause
  notice wakes the requester while the child has NOT finished: "A child is paused awaiting a
  continuation; this is not a completion."
  (`$UP/src/agents/subagents/announce/subagent-announce.requester-settle-message.ts:33`).
  Atrium's `parseRequesterSettleRun` (`convex/lib/deliveryRuns.ts`) reads the segment: a pause
  run settles no child and continues no yielded turn — its own bubble, no merge, no child
  read as finished — and carries its own delivery identity, per paused batch and rearm
  generation; the 2026.9.36 forms parse to the same value as before. Not exercised by the
  catalogue: no scenario makes a sub-agent yield while it owes a report.
- **An announce that carries context fragments** writes a fixed user line instead of the
  event text, "Continue the OpenClaw runtime event."
  (`$UP/src/agents/internal-runtime-context.ts:34`). Atrium reads such rows by provenance,
  never by text; the line did not appear in the bench run.
- **An exec approval granted while a session is created is still refused afterwards**: the
  requester's authority is re-checked after the decision
  (`$UP/src/gateway/server-methods/approval-request-authority.ts:197-199`). Atrium's
  mitigation (§10) stays necessary. When it happens anyway, an exec that waited in place
  ends refused and the run says so on its `approval` stream — `phase: "resolved"`,
  `kind: "exec"`, `status: "failed"`, naming the tool call
  (`$UP/src/agents/embedded-agent-subscribe.handlers.tools.completion.ts`
  `handleToolExecutionEnd`; the same frame at 2026.9.36). `failed` is written for
  `approval-request-failed` alone — any failure of the wait for the decision but an aborted
  run (`$UP/src/agents/bash-tools.exec-host-shared.ts` `resolveExecApprovalWaitOutcome`) —
  and every other refusal says `denied`. Atrium joins the frame to the card by the tool call
  its request named and, when the card was allowed, shows it as allowed but not run
  (`bridge/src/core/agent-requests.ts` `readOpenClawApprovalRequestFailed`). The frame does
  not say why the wait failed. An exec that returned instead of waiting reports the same
  failure as a follow-up message, not as a tool result
  (`$UP/src/agents/bash-tools.exec-host-gateway.ts` `sendApprovalRequestFailedFollowup`):
  no such frame is written for it, and the card stays as it was.

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
  modeled by Atrium. Where the bridge sets no `queueMode`, a `chat.send`
  landing while a separate `announce:*` run is live IS admitted into the
  gateway followup queue on 2026.8.1+ under the default `steer` mode (an
  effective `interrupt` mode from the session, channel or config aborts the
  announce instead, above) (measured live 2026-09-14 on 2026.9.4: the client
  run gets an empty `chat final` with no lifecycle, and the reply comes back
  later under a followup run id — a UUID with no wire link to the client run —
  which Atrium refused as a foreign run and then retried, so the model answered
  twice). From v2026.10.33 the reply runs under the client run itself (above): the bridge
  follows it as the held input's own run, and reads the run the gateway executes it under
  and the client run as one run (`run-manager.ts`) — measured on the bench, one answer,
  once. On 2026.9.36 nothing on the wire can repair it afterwards: the `chat.send` ack
  (`status:"started"`) is sent before the queue decision
  (`chat-send-input-dispatch.ts:596-610`), and nothing on the wire links the client run to
  the followup run: the gateway holds both identities only in its own state
  (`chat-send-turn-adoption.ts:21-30`), and names them together in a log line
  only when the late reply is DROPPED (`chat-send-late-followup.ts:47-56`) —
  a delivered followup writes no such line. So the bridge narrows
  it (defect 18) — preventing it only when the delivery run is visible to the
  bridge and the release check succeeds within its budget: it holds a send
  while a delivery run it can see is live
  (spontaneous turn open or still finalizing, or announce frames stashed). A
  run ENDING is not the gateway releasing it: the run's lifecycle `end` and
  `chat final` are broadcast before `clearActiveEmbeddedRun`
  (`post-run.ts:675-681`, behind an awaited trajectory flush,
  `embedded-agent-runner/run/attempt-session-settle.ts:153`; trajectory capture is on by default),
  while admission reads that registry (`embedded-agent-runner/runs.ts:1052`,
  `get-reply-run-admission.ts:520-521`). So after a delivery the bridge also asks
  `chat.history` for `sessionInfo.hasActiveRun` — true across that window for
  a run that ended normally (`chat-history-handler.ts:366-376`,
  `embedded-agent-runner/runs.ts:1080-1107`) — and waits while it is true. That check only NARROWS
  the window. The signal is not the admission predicate: it also counts
  terminal persistence and projected or queued states
  (`session-active-runs.ts:229-246`), and misses an aborted handle still
  registered or a recovery owner. And it fails open: an absent field, a failed
  call, or a run still counted once a bounded wait is spent (30 s per send,
  shared by its checks, RPC time included — a policy bound, not an upstream
  fact) lets the send go as before. Also not covered: a
  delivery run whose first frame has not reached the bridge when the send goes
  out. Live proof of the hold: bench scenario `announce-reverse-hold` (the send
  held ~41 s, the reply ran under the client run itself, once); the release
  window itself was not caught live.
- **Custody of a queued send (v2026.10.33).** The first ACK is still `started`, and no ACK
  says `queued`. The bridge reads `accepted` as custody, like `started` and `in_flight`
  (`chatSendAckHoldsInput`, `bridge/src/providers/openclaw/chat-send-ack.ts`): the held input
  is kept under the run the ACK names instead of being forgotten. Measured on the bench
  (`announce-reverse-hold`): the queued send is acknowledged `started`, no empty `chat final`
  closes it, and its frames — a `seq gap` report first, then the reply — carry the client run
  id; its `chat final` is numbered `seq` 1 after deltas numbered up to 13, which the bridge
  reads as the terminal it is. Not exercised by the catalogue: a repeated key (the `accepted`
  answer), a dropped queued input, the terminal of each entry in `collect` mode.

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
  `$UP/src/config/sessions/session-transcript-writer-claim-error.ts:46`, identical
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
  `failover-error.ts:751-754`; `model-fallback-runner.ts:598-599` rethrows it) but,
  unlike the 2026.7.x lock, the announce delivery's own retry loop **may retry
  it**: `isTransientAnnounceDeliveryError`
  (`subagent-announce-delivery-retry.ts:97-132`, used at `subagent-announce-delivery-retry.ts:189`) returns no
  retry on send evidence, then defers to a typed retryability when one exists,
  then refuses a permanent non-writer error, and only then retries a writer
  rebound. When a direct delivery has failed, its disposition is `ambiguous`
  on send evidence, otherwise `retryable` for this rebound unless a
  typed retryability decides otherwise
  (`subagent-announce-direct-delivery.ts:590-601`,
  `isPermanentAnnounceDeliveryError` at `subagent-announce-delivery-retry.ts:135-141`, which
  no longer counts a writer rebound as permanent). On 2026.9.36 the same failure is
  `permanent_failure`: the rebound is part of that predicate there
  (`subagent-announce-delivery-retry.ts:173-179` at v2026.9.36). Neither reaches the wire:
  the bridge's contract for the rebound (`session_write_conflict`) is the same on both. The regex at
  `subagent-announce-delivery-retry.ts:55-56` is only
  the shared definition. The retry file is byte-identical 2026.9.2 → 2026.9.4;
  the direct-delivery classification block is unchanged in meaning
  (`subagent-announce-direct-delivery.ts:689-700` at v2026.9.2). Refusal codes are redacted (`session-rebound`,
  `session-entry-missing`) — no filesystem path reaches the message.
  **Since 2026.9.3 (absent from the v2026.9.1 and v2026.9.2 sources; read at
  v2026.9.4), when it ends a generating run the wire does not carry this
  sentence.** The gateway maps it to the storage failure
  `transcript_writer_fenced` (`$UP/src/infra/sqlite-error-diagnostics.ts:11`)
  and renders it as the user-facing copy "This conversation changed while OpenClaw was
  working. Check its latest messages before continuing."
  (`failover/assistant-request-failure-copy.ts:57-58,108`), which becomes the
  lifecycle `error` (`embedded-agent-subscribe.handlers.lifecycle.ts:185-201,254`)
  and the chat error's `errorMessage` (`server-chat.ts:506,899`). On 2026.9.36 the copy reads
  "⚠️ Agent run failed: the transcript writer no longer owned this session. Retry in the
  current session; if it repeats, check Gateway logs."
  (`failover/assistant-request-failure-copy.ts:48-49,76` at v2026.9.36).
  Atrium classifies the raw sentence and both copies as `session_write_conflict`; the older
  copy's "Retry" does not make it retryable.
  A failed run also leaves its partial text in the
  transcript as an assistant entry with `stopReason: "error"`
  (`assistant-error-transcript.ts:58-104,141-149` at v2026.9.36; that module was rewritten since and this point was not re-read at the reference tag), returned by
  `sessions.get` with its `content` and `stopReason` intact: the bridge's
  transcript recovery never takes such an entry as the reply. Another valid
  reply or message-tool delivery of the same turn still comes back; with none,
  the recovery keeps polling and settles with its honest cause.
- **`Session <id> already has an active turn claim`** (`ActiveTurnClaimError`,
  `$UP/src/gateway/worker-environments/placement-turn-claims.ts:49`): joins the
  coordination family at 2026.9.1 (`failover-error.ts:59-65`), so a busy
  session no longer cycles the whole provider fallback chain.
- The init conflict's OCC now also reads the **parent/main** session rows
  (`relatedSessionKeys`, `auto-reply/reply/session.ts:375-387`): same message, but a write on a
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
(`$UP/src/agents/sessions/agent-session-types.ts:44,61`).

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
the manual path (`$UP/ui/src/pages/chat/tool-stream-status.ts:204,236-257`).

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
- A non-completed `end` marks the session saturated only when upstream itself
  calls it a failure. `handleCompactionEnd` carries `outcome` and classifies
  it (`$UP/src/agents/embedded-agent-subscribe.handlers.compaction.ts:197-202`):
  benign when `aborted`, or `skipped` for a reason in the classes
  `no_compactable_entries`, `below_threshold`, `already_compacted`
  (`$UP/src/agents/embedded-agent-runner/compact-reasons.ts:17-20`). Atrium
  transcribes that rule (`compactionFailedForGood`): `failed`, and a skip for
  any other reason, raise the verdict and the failed marker; `aborted` raises
  nothing and clears nothing. The Codex harness's end has no `outcome`
  (`$UP/extensions/codex/src/app-server/event-projector-events.ts:174-186`)
  and its `completed:false` only says the projection closed with the item
  open: no verdict either. The Control UI reads neither key — a non-completed
  end just removes its indicator.
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

**Changed since 2026.9.8** (re-verified at v2026.9.9): `sessions.compact` on a key with
no stored session no longer answers `{ok:true, compacted:false, reason:"no sessionId"}`. It
REFUSES: `INVALID_REQUEST`, `Session <key> not found. Run openclaw sessions list --json to
choose a valid key.` (`$UP/src/gateway/server-methods/sessions-compact.ts:110-119`, pinned
upstream by `server.sessions.compaction-read-errors.test.ts:166-186`, with and without
`maxLines`). The fact is the same one — a conversation whose first turn has not been sent
yet — so the bridge reads that answer back as the `no sessionId` refusal
(`compactRefusalFromAnswer`, `bridge/src/core/compaction-verdict.ts`), in both of its
callers: the manual `/compact` route answers `200 {compacted:false, reasonClass:"no
sessionId"}` as it did on 2026.9.8, and the pre-send guard records `refused` and decides
exactly as before. Only an ANSWERED refusal qualifies, and only when its message starts
with the code and names the key the bridge itself sent: a timeout, a plain error carrying
the same words, or another session's key keep their old meaning. The dispatch classifier
also stops reading that key as a missing agent (the key starts `agent:`; the gateway's real
missing-agent refusals quote the id).

**Changed since 2026.9.6** (re-verified at v2026.9.7): the compaction emitters are
unchanged. NEW, and not a compaction: when a run that must reply ends with visible
text while its saved plan has unfinished steps, the runner queues a hidden
`openclaw.plan-completion-check` follow-up and continues the SAME run
(`$UP/src/agents/embedded-agent-runner/run/attempt-stream-prepare.ts:313-328`) — no
lifecycle terminal, then a new `lifecycle start` on the same run id. The normalizer
reads that start as a run start and must never infer a compaction from it.

**Changed since 2026.9.36** (v2026.10.33): the session row and the context budget. The row
gains `usageReport`, `{state: "available" | "unavailable"}`
(`$UP/packages/gateway-protocol/src/schema/sessions-row.ts:276-278`); with `available`, a
`totalTokens` of 0 is a count the row keeps
(`$UP/src/gateway/session-utils-projection.ts:191-199`). The row no longer looks the model's
context window up in the discovered cache (`$UP/src/gateway/session-utils-row.ts:180-188`),
and the budget assessment is projected only when it agrees with the row's `contextTokens`. The
compaction `end` event gains `qualityDegraded`. **Atrium.** The fields the bridge reads keep
their names and types. `usageReport` and the other new row fields are declared, not read
(`bridge/protocol/openclaw/coverage/2026.10.33.json`; the seven the gateway flattens on the
session snapshot are known to the drift sensor), and the degraded-compaction mark is a
recorded gap. A fresh `totalTokens` of 0 reads as an empty context, which is what it says.
Measured on the bench for the two models in use: every session row answered carries
`contextTokens`, and wherever `contextBudgetStatus` is present its budget equals it (revision
note above). A model whose window came from the discovered cache alone would lose both, and
the pre-send guard with them; none is on the bench. The duration of a pre-send compaction
on this version is not measured.

## 5. `chat.send` idempotency

### Upstream derivation and dedupe window

- **Control UI derivation**: `idempotencyKey` **is** the client-generated
  run UUID (`crypto.randomUUID`), assigned once at enqueue time and **reused
  verbatim on every retry** (`$UP/ui/src/pages/chat/chat-send-queue-state.ts:101`,
  `chat-send-delivery.ts:211,258`, `ui/src/pages/chat/chat-send-request.ts:53` at v2026.9.2).
  No content hash, no timestamp on the client side.
- **Gateway validation**: `NonEmptyString`, opaque, no normalization — the
  key *becomes* the run's `runId`
  (`$UP/src/gateway/server-methods/chat-send-session.ts:219`).
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
  `chat-abort-authorization.ts:115-121`); pending/active →
  `{runId, status:"in_flight"}`; a turn waiting in the follow-up queue →
  `{runId, status:"accepted"}` (§2; `in_flight` on 2026.9.36). A duplicate can also meet a
  retryable `UNAVAILABLE`, "session transcript is rebuilding; retry shortly"
  (`$UP/src/gateway/server-methods/chat-send-pre-admission.ts:102-112`).
- **Since 2026.9.2 the key is bound to its content.** The gateway stores a
  request identity with the key at admission — a keyed digest of the request
  (`$UP/src/gateway/server-methods/chat-send-request.ts:320-322`), absent for a stop command
  and when the gateway cannot read its device identity; a plain `sha256` of the message and
  its mentions on 2026.9.36 — and a reuse of the key with DIFFERENT input is refused:
  `INVALID_REQUEST` with `details.reason: "chat-request-conflict"` and the message "This
  message ID was already used for different input…" (`chat-send-pre-admission.ts:159-166`),
  while the original run keeps running. The identity is persisted with the user turn as
  `chatRequestIdentity` (`$UP/src/gateway/server-methods/chat-user-turn-recorder.ts:216`), and
  a retry past the RAM window is compared with the stored value
  (`$UP/src/gateway/server-methods/chat-send-retry-comparison.ts:64-67`): a key reused with
  another TEXT is refused there too, where 2026.9.36 compares mentions and work context
  only. "Always an ack" therefore holds for a faithful duplicate only.
- **The Control UI bounds its wait for the ACK**
  (`$UP/ui/src/pages/chat/chat-send-request.ts:95-100`) and keeps a send it could not confirm
  as `unconfirmed`, never resent on its own
  (`$UP/ui/src/pages/chat/chat-send-queue-state.ts:356-378`).
- The announce idempotency family (`announce:v1:<childKey>:<runId>`) is a
  **separate, persisted delivery identity** — unrelated to the chat.send
  dedupe map.

### Atrium behavior and verdict

- Bridge derivation: `webchat-<sha256(sessionKey|clientMessageId)>`
  (`bridge/src/providers/openclaw/openclaw-client.ts:1640-1651`), stable across Convex's at-least-once
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
- With the identity persisted (v2026.10.33), a re-POST whose composed text differs is
  refused for longer than on 2026.9.36 — as long as the gateway knows the key, up to the
  abort marker's sixty minutes. The bridge resends a key once after the gateway reports the
  input absent; the contract allows it, and it is a deliberate difference from the Control UI
  (§7). Not exercised by the catalogue: the same key with another text after the window, and
  the `rebuilding` refusal. The admission reads asynchronously on this version; the bridge
  waits twenty seconds for the ACK, and the bench run's log holds no acknowledgement timeout
  over its 44 sends — the latency itself is not in the capture, which records no request.
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

## 7. Deliberate deviations of the transcript projection (0.101.x)

Where Atrium's transcript projection (every OpenClaw conversation since 0.102.0) departs from
the Control UI on purpose. Each is a choice, not a
gap to close; the 0.101.x audit of 2026-10-19 (`audit-conformite-9.33-lots-0.101.md`, kept
outside the repository) lists them against the upstream code.

- **No visible duplicate (R4).** Upstream keeps two durable answers of one run even when their
  text is identical (`packages/gateway-client/src/session-projection.ts:235`). Atrium
  shows one: a repeated text or file in a bubble is withheld, the bubble saying nothing about
  it. Atrium's chats are documents read later, where a repeat reads as a defect.
- **Files copied at once, with a `gone` state.** The Control UI fetches a transcript file
  when it is displayed. Atrium copies it into its own storage as soon as the row is read, so
  the conversation stays complete after the gateway prunes the file; a file the gateway no
  longer serves is shown as gone, with its name, rather than as a broken link.
- **A waiting line while a delegated child runs.** After `sessions_yield` the Control UI
  clears the run and shows nothing until the resume
  (`ui/src/pages/chat/chat-gateway.ts:270-279`). Atrium shows one quiet line under the
  hand-off while the child runs or the gateway reports an active run; a user message sent
  after the work started, or the resume naming the child, ends it.
- **Stricter masking.** A tool card rebuilt from the transcript masks its input as the
  Control UI masks history, and Atrium applies the same masking to the card's header preview
  too; an input or output over 8 KiB is omitted with its size rather than cut at 8,000
  characters.
- **Automatic resend after a send timeout.** The Control UI parks a send it is unsure of and
  waits for the reader: only an explicit retry continues to the same idempotency key
  (`ui/src/pages/chat/chat-outbox-drain.ts:179-187`). Atrium asks for the send's receipt the
  same way, and when the gateway reports it absent, resends it ONCE with the same key and
  attachments — the gateway answers a repeated key with the run it already holds, so the input
  never runs twice. A received send is followed, never resent; an unprovable one stays failed
  for the reader.
- **A child the reader stopped reads "stopped" (0.101.4, every projection mode).** A
  sub-agent's status is otherwise its gateway session row, shown with the Control UI's badge
  rule (`ui/src/pages/sessions/session-status.tsx:17-39`; `convex/lib/sessionRowStatus.ts`).
  The Control UI has no notion of Atrium's Stop: an aborted sub-agent run is recorded `done`
  (`resolveSubagentSessionStatus`,
  `src/agents/subagents/registry/subagent-session-metrics.ts:46-79` — an aborted outcome is
  neither `error` nor `timeout`), so its row would show Done. Atrium shows "stopped" for a
  child the reader stopped, until the row speaks for another run (an "Interagir" turn), and a
  row read while the stop is still travelling does not bring the "working" state back.

## 8. When a run is over: the gateway says so, never a client clock (0.102.1)

### Upstream contract

- **A run ends client-side only on the gateway's terminal.** The Control UI's chat reducer
  ends the run it holds (`chatRunId`) when a `final` / `error` / `aborted` event of that run
  arrives (`ui/src/pages/chat/chat-gateway.ts:161-233`).
- **Otherwise the gateway's state decides, read from `chat.history`.** The handler states
  `sessionInfo.hasActiveRun` from its own run registry, and keeps it true until the terminal
  row is queryable (`src/gateway/server-methods/chat-history-handler.ts:362-379`). A hydration
  — opening the pane, a reconnect — applies it with `isSessionRunActive`
  (`src/shared/session-run-state.ts:8-16`: status `queued`/`running`, or `hasActiveRun`) and
  adopts `inFlightRun` (`ui/src/pages/chat/chat-history-hydration.ts:210-258`). A run is
  settled from history only on a terminal status AND `hasActiveRun !== true`
  (`ui/src/pages/chat/chat-history-stream.ts:137-165`).
- **No client timer abandons a run.** The timers of the chat pages are interface ones
  (drafts, typing, request retries); none ends a run. `tick` (every 30 s,
  `src/gateway/server-maintenance.ts:235-239`) is a SOCKET liveness: the client reconnects
  after two silent ticks (`ui/src/api/gateway.ts:447`, `ui/src/api/gateway-heartbeat-policy.ts:16`), and says nothing about a run.
- **The deadlines live in the gateway.** The model-call idle timeout
  (`src/agents/embedded-agent-runner/run/llm-idle-timeout.ts:28`, 120 s between events) and
  the code mode's own (`src/agents/code-mode-node.ts:188`, none) decide when a run is cut or
  retried; nothing in between reaches a client. A model call that streams the arguments of a
  tool call emits no agent/chat event until the call is complete — prod 2026-10-25, one such
  call ran 17 min 20 s, was cut by the gateway and retried under the same run id, which
  answered.

### Atrium behavior and verdict

**Conformant since 0.102.1** for a projected (OpenClaw) conversation:

- the stuck-stream watchdog (`convex/stuckStreams.ts` `reconcileStuckStreams`) leaves a
  projected bubble alone, whatever its silence; the run's terminal, or a read that finds it
  over, settles it through the projection. The bubble is known projected from its opening:
  the bridge that runs the turn says so (`messages.projectedTurn`), so no transcript read
  needs to have succeeded first;
- a RECONCILIATION CYCLE, driven by state, not by events: every successful agent
  discovery of the instance (Convex's existing periodic poll) asks the gateway about each
  projected bubble still streaming that no live socket of the bridge already follows (the
  Control UI's tab re-reads the gateway at every reconnection,
  `ui/src/pages/chat/chat-history-hydration.ts:210-258`, whatever it held before); the
  bridge restarting and any close of a conversation's socket ask at once, as a shortcut — (`/resume`, the reconnect hydration): still running, the turn is picked up on the
  bubble; no longer running, one transcript read settles it from the run's rows, and only what
  that read left streaming is closed; no answer (bridge or gateway unreachable, unreadable
  state) leaves it streaming — the conversation shows the instance unavailable and Stop stays
  offered — and the question is asked again;
- the run is closed only on the gateway's proof APPLIED: a transcript read that was read
  and accepted by Convex settles the bubble; a read that failed leaves it streaming for the
  next cycle. A bubble whose conversation's socket moved to another session (a per-turn
  routed conversation) is read through a connection of its own, never through or by moving
  that socket;
- "no longer running" needs a PROOF: an idle session (`hasActiveRun: false`), or an exact
  active set that does not name the run. The gateway withholds that set while its run
  identities are incomplete — a terminal still being persisted, an embedded or projected run
  (`src/gateway/server-methods/session-active-runs.ts:246-256`) — so an active session with no
  set proves nothing about this run, and the bubble is left streaming;
- an early, lost or refused question (`busy`: a send holds the chat) is not terminal: the
  next cycle looks at the bubble again;
- the question goes where the bubble's turn was sent — the instance and agent of its send
  (its routed fields, else its outbox row) under the bubble's own session key, as the
  Control UI asks the session its tab holds. Being unable to ask — no resolvable route, a
  route to another instance, no bridge — is never taken for an end: the bubble stays
  streaming for the next cycle. A bridge older than 0.102.1 refuses without a reason, for a
  stale session as for a busy chat: that is no proof either, and is read as `unknown` — no
  projected bubble is closed without the gateway's proof applied, whatever the bridge;
- the read that settles a resumed bubble starts where the store's reads of the bubble's OWN
  session stopped, as the Control UI's hydration resumes at its cursor; on `reset` it
  takes the newest page and applies it with the gateway's run state, as upstream does
  (`ui/src/pages/chat/chat-history-hydration.ts:181-206`: the cursor cleared, one request
  without it, no catch-up of the rows in between; older rows come only with paging). The
  run's final answer is in that page: the bubble is recomposed from the rows the store
  holds when its run ends, even with a coverage hole in between — the hole stays recorded
  on the session's cursor (`gaps`), and no bubble is born from such a run;
- a bubble Atrium closed itself — the watchdog's `stream_orphaned` before 0.102.1, or a
  sweep's `connection_lost`, never finalized — is not a terminal: the end of the same run — its live terminal, or the settle of its rows — reopens
  and settles it; another run's terminal does not, and a user Stop or a gateway error, which
  are terminals, stay.

**Deliberate deviation, kept:** a Hermes conversation is not projected, and the watchdog
remains its net (12 min without a write closes the bubble `stream_orphaned`).

## 9. The model's reasoning, the agent's work notes, the answer (0.103.0)

### Upstream contract

- **Reasoning visibility is a session setting.** `reasoningLevel` is `off` | `on` |
  `stream`, set per session by `sessions.patch` (`src/gateway/sessions-patch.ts:476-481`,
  admin-scoped) and defaulting to the agent's `reasoningDefault`. With `on`, the system
  prompt tells the model so (`src/agents/system-prompt.ts:947`) and the run's reply items
  gain a reasoning payload (`src/agents/embedded-agent-runner/run/payloads.ts:284`) that
  channels may deliver; the webchat drops it (`src/gateway/server-methods/chat-assistant-content.ts:147-150`).
- **The Control UI shows reasoning after the fact only.** A row's `thinking` blocks are
  extracted (`ui/src/lib/chat/message-extract.ts:87`) and shown above the row's content when
  the session's `reasoningLevel` is `on` and the reader asked for it
  (`ui/src/pages/chat/chat-reasoning.ts:128-129`,
  `ui/src/pages/chat/components/chat-message-bubble-presentation.ts:161`). The live `agent` stream
  `thinking` is emitted whatever the level
  (`src/agents/embedded-agent-subscribe.handlers.messages.update.ts:128`) and no Control UI code
  renders it.
- **Work notes are shown as the run goes.** A completed `item` preamble becomes a live
  segment (`ui/src/pages/chat/tool-stream-preamble.ts:39`, `ui/src/pages/chat/tool-stream.ts:530`),
  retired once the keyed row that persists it is in the history; that row is commentary for
  presentation (`ui/src/pages/chat/chat-assistant-reply.ts:23`).
- **A reasoning item's commit is receipted (v2026.10.33).** When the transcript row that
  holds a reasoning item is committed, the gateway emits a `thinking` frame of phase
  `persisted` with `itemId`, `messageId` and `messageRunId`
  (`$UP/src/gateway/server-chat-transcript-publication.ts:114-124`), and the live `thinking`
  delta carries its `itemId`. 2026.9.36 emits neither.
- **Hermes (0.21.7)** sends `reasoning.delta` while `show_reasoning` holds (default true) and
  `message.complete.reasoning` always (tui_gateway/prompt_turn.py:950-951 at 71d34bad). Its
  only setter, `config.set {key:"reasoning", value:"show"|"hide"}`, also rewrites the global
  `display.show_reasoning` of config.yaml (tui_gateway/methods_config_set.py:20-31, 317-326).

### Atrium behavior and verdict

**Conformant, with two deliberate choices:**

- *Show reasoning* is a per-conversation setting with a per-agent default. The default is
  an ATRIUM setting (`agents.showReasoningDefault`), not the gateway's `reasoningDefault`:
  that one applies to every channel of the agent, and Hermes has none. For OpenClaw the
  bridge applies the decision as the session's `reasoningLevel` before each turn (`on`; `off`
  only when the conversation chose it, or the session is known to show it) — the Control
  UI's own condition for showing reasoning.
- Hermes: Atrium writes NOTHING to the gateway for reasoning, because the setter is global.
  It keeps or drops what the gateway sends. Stated limit: an operator who set
  `display.show_reasoning: false` gets no live reasoning (0.104.0), only the final one.
- A row's reasoning reaches the store only while the conversation shows it, beside the row
  (never in its text, nor as a block: a block would move the index that identifies a file),
  and is shown above its row: the bubble's layout marks the row, and the text is read from
  the row when the reader opens the block — one row at a time, never with the
  conversation's window (whose reads Convex bounds at 16 MiB). It is stored apart from the
  row's text, so no reader of texts loads it. A reasoning `chat.history` capped at 8 000
  characters marks the message like a capped text (`__openclaw.truncated`,
  `src/gateway/chat-display-projection.sanitize.ts:228-242,591-601`):
  the row is completed by `chat.message.get` as a capped text is — even when it carries
  only reasoning and tool calls — and, when that fails, the block says it is cut. An empty `thinking` block (a
  model whose reasoning is encrypted) shows nothing. Hermes' reasoning, which no row
  carries, is a part of its message, bounded per message (16 KiB) and marked when cut.
- Work notes: a completed preamble is a live note at its place among the tool cards; a
  commentary row is shown as a note once settled. Hermes' `message.interim` is the same
  nature.
- The `persisted` receipt of v2026.10.33 is not read (a recorded gap in the emission
  registry): the reasoning shown comes from the row, as on 2026.9.36. Measured on the bench:
  20 such frames, each with its three ids.
- Exclusions: no export, fork, feedback report, metadata API, search, notification or
  spoken reply carries a reasoning (the answer text never contains it).

## 10. Approvals: addressed to a lineage, shown to the raising session (0.103.5)

### Upstream contract

- **An approval is addressed to the raising session and every ancestor.** When an approval
  registers, the gateway walks up from the raising session — the sub-agent registry's
  controller and requester of the latest run, else the stored parent
  (`src/gateway/approval-session-audience.ts:21-76`) — and stores the result with the
  approval as its audience (`src/gateway/exec-approval-registration.ts:107-112`). That
  audience is fixed then: a later change of the sub-agent's owner does not move an approval
  already raised.
- **The audience is served on the session-scoped stream only.** The `session.approval`
  events of `sessions.messages.subscribe` with `includeApprovals`
  (`src/gateway/server-methods/sessions-subscriptions.ts:111`) go to the sessions of the
  stored audience (`src/gateway/operator-approval-session-events.ts:149`). The operator
  broadcast `*.approval.requested` carries the request itself, which names the raising
  session alone (`src/gateway/server-methods/approval-shared.ts:126-141`); neither
  `approval.get` nor the three pending lists (`exec|plugin|openclaw.approval.list`) carry
  the audience.
- **The Control UI shows a descendant's approval in its ancestor's pane**, marked with the
  raising session (`ui/src/pages/chat/session-approval-projection.ts:31-48`,
  `ui/src/components/exec-approval-card-solid.tsx:424`).
- **An approval id names one request.** The gateway mints it at random for each request
  (`src/agents/bash-tools.exec-host-shared.ts:198`, `src/agents/bash-tools.exec-host-node.ts:304`,
  `src/gateway/node-invoke-plugin-approval.ts:168`); an explicit id from the caller of
  `exec.approval.request` is refused while a record under it exists
  (`src/gateway/server-methods/exec-approval.ts:142,234-241`), and the durable registry refuses a
  second record under an existing id (`src/gateway/operator-approval-store.kernel.worker.ts:155`). Every
  record carries its creation time, `createdAtMs`, on its broadcast, its pending-list entry and
  its snapshot. The resolution broadcast carries the id, the decision and the request, not the
  creation time (`src/gateway/server-methods/approval-shared.ts:62-68`).

### Atrium behavior and verdict

**Narrower than the Control UI, deliberately.** A conversation socket opens no
`sessions.messages.subscribe` (a subscription on that socket has cost frames the turn
depends on), so it reads the broadcasts and, at each (re)connection, the three pending
lists. A conversation shows and answers the approvals of its own session only: a
sub-agent's approval is neither shown in the parent conversation nor answerable from it,
and the sub-agent waits for an answer given elsewhere (the Control UI, another client) or
for the approval's own timeout. Atrium does not rebuild the stored audience from the
broadcasts and the sessions' rows: a lineage read when the request is seen approximates it,
but no client-side rule reproduces it exactly — a later read proves the sub-agent's current
owner, not the audience the gateway fixed — and an inexact rule lets one conversation see
or answer another's request. Showing those approvals in the parent means consuming
`session.approval` itself.

**Three frames can describe one wait.** A run that waits in place says so on its own
lifecycle, `waiting-approval` then `approval-resolved`, around the wait
(`$UP/src/agents/bash-tools.exec-host-gateway.ts:1234-1245`). `stream:"approval"` is a
different statement, written when the exec tool completes
(`$UP/src/agents/embedded-agent-subscribe.handlers.tools.completion.ts:481-511,542-559`):
`requested` when the exec returned instead of waiting — `status:"pending"` with the
approval's id, or `status:"unavailable"` when nobody can be asked — and `resolved`
(`denied` / `failed`) when the exec's result is an approval refusal, which is also how an
in-place wait that ends refused finishes. The Control UI reads the lifecycle pair only.
Atrium holds a turn on `waiting-approval` and on a `pending` `requested`, as one request
under both of its names (the approval id, the tool call); an `unavailable` `requested`
holds nothing; a `resolved` releases the request it names when it is still held, and after
an in-place wait it arrives once the run's `approval-resolved` has already released it.
Measured on the bench at v2026.10.33: the 14 `waiting-approval` and the 9 `approval-resolved`
frames of the run each carry `approvalId` and `toolCallId`, and no `stream:"approval"` frame
was emitted — every exec approval waited in place. The emission inventory of that tag lists
emitters of `requested` that no longer write `approvalId`; whether a `pending` `requested`
still names its approval there is not observed.

**An approval is keyed by its id and its creation time**, everywhere: the bridge's memories
of a decided approval (the observer, the turn's hold), the Convex card and the verdict Convex
keeps for a card not recorded yet. With ids unique per request upstream, the creation time
adds nothing to which request an id names; it dates a verdict that reaches Convex before its
card, and an `approval.get` snapshot is used only when it is the announced request's — the same
creation time, and the conversation's own session when the snapshot names one. A write of a
request already recorded is that card, whatever order the writes arrive in. A resolution is
attached to the creation time announced for its id.

## 11. What a run reports beside its answer

### Tool phases that end nothing

**Upstream.** `stream:"tool"` carries two phases that are neither a start, nor output,
nor a result. `input_delta` is written while the model is still streaming the arguments
of a file-mutation call (`$UP/src/agents/embedded-agent-subscribe.handlers.messages.update.ts:69-78`):
a diff counter, no `args`, and it precedes the call's `start`. `review` is written when an
approval reviewer starts on, or rules on, a call — by the gateway's exec host with
`name:"exec"` (`$UP/src/agents/bash-tools.exec-host-gateway.ts:119-157`) and by the Codex
harness with no `name` at all
(`$UP/extensions/codex/src/app-server/event-projector-events.ts:253-265`). The gateway
counts both as tool progress (`$UP/src/gateway/server-chat-progress-snapshot.ts:14-20`), and
the Control UI closes a card on `result` only (`$UP/ui/src/pages/chat/tool-stream.ts:670`).

**Atrium.** Both are read as reports on a call (`isToolObservationPhase`): they close no
card, count no tool, and leave the buffered arguments for the result. They open no card
either — a call whose arguments are being written may never start, and a card opened
for it would be closed as completed at the turn's terminal. Any other phase the bridge
does not know still closes the card, so a renamed terminal cannot leave one spinning.
Narrower than the Control UI: the live `+added −removed` stat of a running edit and the
reviewer's line ("Guardian reviewing / approved / denied") are not shown.

### The gateway's `seq gap` report

**Upstream.** The gateway's agent-event handler remembers the last seq it handled for
each run; when the next event's seq is not that plus one it broadcasts
`{stream:"error", data:{reason:"seq gap", expected, received}}` to the session
(`$UP/src/gateway/server-chat.ts:1222-1257`). That seq is the runtime's per-run emission
counter (`$UP/src/infra/agent-events.ts:454-455`), which also numbers emissions the
handler never receives, such as audit-only events
(`$UP/src/infra/agent-events.ts:671-682`). Both counters are inside the gateway:
`received < expected` is a seq the handler had already passed, `received > expected`
emissions it did not handle. A frame the gateway drops for one client leaves a hole in a
different counter, the per-connection envelope `seq`, which advances even for a dropped
frame (`$UP/src/gateway/server-broadcast.ts:445-449`). The Control UI reads no part of the
report.

**Atrium.** The report is observed under its own name and fails nothing: an
`openclaw.gateway_seq_report` trace per report (the two counters, their direction, the run
the frame names) and a `gatewaySeqReports` count on the turn's pressure trace. It is not a
frame loss: `openclaw.frame_gap` records holes in the envelope seq of the bridge's own
sockets and nothing else, at connection level, and no turn carries a `framesLost` counter
— the envelope seq names neither session nor run, so a hole is not charged to the reply in
flight.

### Model fallback

**Upstream.** When its failover chain answers with another model than the selected one,
the gateway emits `lifecycle` `phase:"fallback"` with the selected and active
provider/model and the reasons (`$UP/src/auto-reply/reply/agent-runner-result-payloads.ts:391-407`),
and `phase:"fallback_cleared"` once the session is back on its selected model
(`$UP/src/auto-reply/reply/agent-runner-result-payloads.ts:412-424`). Both are emitted
while the reply payloads are built, after the run's work: on the wire they follow the
run's `lifecycle end` and `chat final`, with the run's seq back at 1. The Codex harness
emits `stream:"fallback"` with `fromModel` / `toModel` when the provider reroutes a
request (`$UP/extensions/codex/src/app-server/event-projector-events.ts:292-311`). The
Control UI shows "Fallback active: {active model}" or "Fallback cleared: {selected
model}" for eight seconds, ignores a fallback whose two names are equal, and does not
read `fallback_step` (`$UP/ui/src/pages/chat/tool-stream-status.ts:292-338`). The gateway
also adds its own notice text to the reply, as a status notice.

**Atrium.** The frame is read as a fact about a run, apart from the turn's state
(`model-fallback.ts`): it is never content of a turn and never opens, reopens or ends
one. It becomes a marker on the bubble of the run it names — the live turn's bubble
when the run is still that turn's, otherwise the bubble the run left, found by its run
when the bridge does not hold it. What the gateway states about a run — a fallback, its clearing, a status notice — has
one path: it is read when the frame arrives, queued per run in arrival order, and written
on the run's bubble oldest first, at once when the bubble exists and as soon as it does
otherwise (the answer and its fallback may both race the `chat.send` ACK). Nothing is
written ahead of a fact still queued for its run, so the last one received is the one
that stands. A frame is read once, when it arrives: a stash that hands it back later
does not have it read again. A write has three outcomes — written; Convex answers that
the run has no bubble, which is final once the run's turn has ended; or the write
failed, which says nothing about the bubble: the fact keeps its place and is tried
again on a later frame of the connection, a bounded number of times. A run that showed
nothing gets no marker. The marker
is kept on the bubble rather than shown for a few seconds, and prints the Control UI's
two sentences, localized. Only model names are carried: the reasons and attempts are
the provider's own text and are neither stored nor shown.

### Status notices beside the answer

**Upstream.** A reply payload can be a status notice rather than answer content — the
fallback notice, a compaction notice, a usage line, a diagnostic, a command's reply. From
2026.9.6 the gateway marks its text block `openclawStatusNotice`
(`$UP/src/gateway/server-methods/chat-assistant-content.ts:189-197`). Notices produced
with a run's reply are sent in a `chat` final of their own, after the answer's final; the
fallback notice is the first of them, being prepended to the run's payloads
(`$UP/src/auto-reply/reply/agent-runner-result-payloads.ts:477-500`). It is broadcast, not
written to the transcript. The Control UI shows it as an assistant message of its own and
keeps it out of what identifies the run's terminal reply
(`$UP/packages/gateway-client/src/session-projection-message-content.ts:38-50`).

**Atrium.** A final that carries nothing but marked notices, once its run's final has
been seen or its run is settled, is neither a late piece of the answer nor an answer: it
never joins the bubble's text and never opens a bubble. It takes the same path as a
fallback, in arrival order with it. Each notice becomes a notice line under the reply of its run, as plain text —
except the first one after a fallback the gateway stated for that run, which the
fallback marker already says. A run that left no bubble shows none. A final that mixes
answer text and a notice, a notice that is a turn's only reply (a command's answer), and
any final of a gateway that does not mark notices are read as before.

### Provider retries

**Upstream.** Every transient retry is emitted on the agent stream as `run_status`
`phase:"retrying"` — by the embedded runner with its counters and reason
(`$UP/src/agents/embedded-agent-runner/run/attempt-recovery.ts:463-479`), by the Codex
harness with a sentence only
(`$UP/extensions/codex/src/app-server/event-projector-events.ts:375-386`). The projection
onto `chat` rewrites it to `starting_model` and names it a retry for five reasons —
`rate_limit`, `overloaded`, `server_error`, `timeout` and `output_limit`, the last of which
is not a wait — copying `retryAt`, the time of the next attempt, when the event carries it
(`$UP/src/gateway/server-chat.ts:1288-1305`; schema
`$UP/packages/gateway-protocol/src/schema/logs-chat.ts:432-439`). On 2026.9.36 the status
names a retry only when the reason is `rate_limit`, and carries no time:
(`$UP/src/gateway/server-chat.ts:1480-1510` at v2026.9.36).
A startup phase is re-emitted
only when it changes (`$UP/src/auto-reply/reply/agent-runner-execution.ts:292-296`), so
none follows a retry that resumes on the same phase: in the Control UI too the retry
label stands until the run shows activity.

**Atrium.** `run_status` `retrying` publishes the same back-off phase as the `chat`
retry status, with the counter when the frame carries a valid one (integers, 1..10) and
without it otherwise; the gateway's sentence is not shown. It ends on the same resume
signals (assistant text, tool progress, a preamble). A retry whose reason is
`output_limit` — the run continuing a reply cut at its output limit — publishes nothing.
The startup phases of the stream are not shown. The `chat` retry status is read the same
way on both lines: any of the four waiting reasons publishes the back-off, with the reason
and — from v2026.10.33 — the time of the next attempt; `output_limit` and a status whose
reason is outside the contract publish nothing. No turn backed off during the bench run, so
the four reasons are covered by deterministic tests on the upstream shapes only.

### Emissions added at v2026.10.33

**Upstream.** Read from the two emission inventories (`bridge/scripts/diff-agent-emissions.mjs`),
by what the emitting code writes. New: the `thinking` `persisted` receipt (§9); a Codex
harness stream, `codex_app_server.diagnostic` (phases `notification`, `native_item`,
`no_answer`), and a phaseless `codex_app_server.item`. New keys on known frames: `notice`
`warning` gains `kind` and `permissionMissing` (a node permission the run needed);
`run_status` `retrying` gains `retryAt`; `usage` gains `usageReport`; `compaction` `end`
gains `qualityDegraded`; `lifecycle` `error` gains `executionStarted`; the live `thinking`
delta gains `itemId`; `assistant` gains `occurrenceId` (Codex harness). Gone: the
`run_status` phase `naming_worktree`, and the `item` emitter whose phase was computed.

**Atrium.** Each is classified in `bridge/protocol/openclaw/emissions/2026.10.33.json`. The
time of the next retry is read (above). The reasoning receipt, the permission notice, the
degraded-compaction mark and the unavailable-usage mark are recorded as gaps with what each
costs; the Codex diagnostics are not read, as the Control UI does not read them either. The
drift sensor knows all of them, so none is reported as an unknown emission.

### Agent questions

**Upstream.** A question carries up to 64 options
(`$UP/packages/gateway-protocol/src/schema/questions.ts:74`), more than four only with
`presentation: "form"` (`$UP/src/gateway/question-validation.ts:28-33`); on 2026.9.36 the
bound is four. An option may declare a `value`
(`$UP/packages/gateway-protocol/src/schema/questions.ts:50`); the recorded answer is
`value ?? label`, an answer being read as a value first, then as a label
(`$UP/src/gateway/question-manager.ts:118-129`).

**Atrium.** Every option is kept and shown — more than four as a scrolling column — and a
list past the contract's bound is not recorded rather than shown short. A picked option is
answered with its value when it declares one, as the Control UI does, and the answers the
gateway records are read back into labels, so the stored answer and the marked option stay
what the person saw (`bridge/src/core/agent-requests.ts`). Not read: `answerFormat: "lines"`
(the free-text field is one line, sent as one value), `resource` (no file picker), `allowEmpty`
(an empty answer is refused; the question can be skipped), `defaultAnswers` (nothing is
preselected), thumbnails and previews. The bench run asks one question — two options, no
`value` — answered from Atrium; an option with a value and a form of more than four options
are covered by deterministic tests only.

## 12. A turn the gateway cut, and its own recovery

### Upstream contract

A gateway restart aborts the runs it interrupts; once it is back — after a restart, or a
stop followed by a start — it resumes each interrupted main-session turn by itself
(`$UP/src/gateway/server-startup-post-attach.ts:867-870`; no setting turns it off). It
appends a `user` entry whose text begins `[System] Your previous turn was interrupted`
(`$UP/src/agents/restart-recovery-prompt.ts:2`), marked
`provenance: {kind: "internal_system", sourceTool: "main_session_restart_recovery"}`
(`$UP/src/agents/main-session-recovery/main-session-restart-dispatch.ts:465`,
`$UP/src/sessions/input-provenance.ts:24`), and starts a NEW run that answers: a fresh
uuid, also the entry's idempotency key
(`$UP/src/agents/main-session-recovery/main-session-restart-dispatch.ts:265,452`). Which
run it resumes is kept in the gateway's session store only
(`$UP/src/agents/main-session-recovery/main-session-restart-dispatch.ts:404`): nothing in
the entry, its provenance or the recovery run's frames names it. The provenance exists on
every validated version; the sentence changed at v2026.9.36 (it no longer says "by a
gateway restart").

The Control UI shows that entry as a notice with a fixed text, between the interrupted
work and the recovery's answer (`$UP/ui/src/pages/chat/system-notice-kinds.ts:30`); the
notice starts a turn (`$UP/ui/src/pages/chat/chat-system-notice.ts:101`), so the two are
never one group. A tool call the interrupted run left with no result has no outcome there
— neither running nor failed (`$UP/ui/src/lib/chat/tool-cards.ts:162`).

### Atrium behavior and verdict

Same facts, one deliberate difference. The entry itself is not shown as a message; the
bubble of the run it follows — the run of the row right before it in the transcript, the
only link the transcript states — says that the gateway cut the turn and that the agent
resumed it, naming a restart or a stop when the bridge saw the gateway announce one on
the turn's socket. A call left with no result is shown as interrupted. The difference:
the recovery's answer is grouped with the interrupted bubble (one display group), where
the Control UI shows two turns — Atrium reads it as the continuation of the turn the
reader asked for. With no recovery entry, the bubble states the interruption only when a
shutdown was announced on its socket and its transcript stops before an answer.

## Conformance summary

| Zone | Verdict |
|---|---|
| stopReason/errorKind refusal | **Conformant** — the Control UI reads neither; `state` carries the gateway's pre-rendered decision |
| Announce×send kill | **Inverse recovery retired (2026-09-14)** — on 2026.8.1+ no announce-kill mechanism was found on the production paths read (under the default `steer` mode the send is queued as a followup instead: defect 18, narrowed by the bridge holding the send while a delivery run it can see is live or finalizing, then while the gateway still counts a run — a fail-open, bounded check — §2); on 2026.7.x the measured incident is attributed to the prompt-lock takeover by timing only, no frame proves it, so `gatewayPreempted` is no longer minted or relayed and the zero-content aborted turn keeps its honest card; `reparkIfBusy` (the other direction) stands |
| Embedded-lock downgrade | **Sound via the `hasRealContent()` gate** (the homologue of upstream "send evidence"), not via the "post-generation" argument, which mid-turn takeovers disprove |
| Init-conflict retry | **Conformant** with upstream channel-side retry treatment |
| Compaction | **Explicit signals consumed** — `{stream:"compaction"}` is the primary mid-turn signal (marker + widened budget, no buffer reset); the `abandoned` heuristic survives as the multi-version/Hermes fallback and stands down when explicit signals are present; `session.operation`/`sessions.changed` remain unconsumed (rotation detection covers the manual path) |
| chat.send idempotency | **Conformant** for a faithful duplicate; since 2026.9.2 a key reused with other content is refused (`chat-request-conflict`), classified as its own downstream rejection, never retried; the preempt `dispatchKey` alias WAS necessary to the retired inverse repark (abort markers poison the original key for ~60 min) and stays only for a recovery row created before 2026-09-14 (held, flipped `queued`, or promoted again), until the outbox fields are migrated out |
| End of a run (no client clock) | **Conformant (0.102.1)** for OpenClaw — no projected bubble is closed on Atrium's clock; the gateway's terminal or state decides, re-read at every reconnection (§8); Hermes keeps the 12-min watchdog |
| Projection `on` deviations | **Deliberate** (§7) — no visible duplicate, files copied at once with a `gone` state, a waiting line while a child runs, stricter masking, one automatic resend of a send the gateway reports absent |
| Reasoning and work notes | **Conformant (0.103.0)** — shown after the fact above its row when the conversation shows reasoning (per-conversation choice, per-agent Atrium default); work notes live from completed preambles; Hermes is read, never written (its setter is global) (§9) |
| Approvals of sub-agents | **Deliberately narrower (0.103.5)** — a conversation shows and answers its own session's approvals only; upstream addresses an approval to the raising session's whole lineage, stores that audience when it registers it, and serves it on `session.approval`, which Atrium does not consume (§10) |
| Tool phases `input_delta` / `review` | **Conformant on the card's state** — neither closes a card, counts a tool or drops its arguments; the live diff stat and the reviewer's line are not shown (§11) |
| `seq gap` report | **Conformant** — the gateway's own numbering, observed under its own name and never counted as a lost frame; only a hole in the envelope seq is a loss (§11) |
| Model fallback | **Conformant on what is said, kept longer** — the Control UI's two sentences as a marker on the run's bubble, also when the frame follows the run's terminal; the reasons, the attempts and the previous model are not shown (§11) |
| Status notices | **Shown apart from the answer** — a notice-only final after the answer is a notice line on the run's bubble, never the answer's text nor a bubble; the fallback's own notice is the fallback marker (§11) |
| Provider retries | **Conformant** for the retry itself — read from the agent stream whatever the reason and from the `chat` status for its four waiting reasons, with Atrium's own wording and, from v2026.10.33, the time of the next attempt; the run's startup phases and the provider notices are not shown (§11) |
| Retired live text (v2026.10.33) | **Conformant** — a text the gateway withdraws from the stream because the transcript holds it stays in the live bubble (the recorded row is the proof, as the durable row is the Control UI's), and an emptying with no such row is written with what replaces the text shown; a non-empty shorter tail still cuts the bubble until the terminal; `openclawDisplayContent` is not read, the complete `content` is (§1) |
| Queued send identity (v2026.10.33) | **Conformant** — no empty final is expected at queue admission, the client run and the run that executes it are one run, a replayed `accepted` ACK is custody, and the `:pause` settle run has its own identity and settles no child (§2) |
| Agent questions | **Narrower on forms** — every option is kept and answered by its value; `answerFormat`, `resource`, `allowEmpty`, `defaultAnswers`, thumbnails and previews are not read (§11) |
| Config changes / model roster | **Handled** — `config.changed` (broadcast-only, never announced) invalidates the per-connection roster and triggers a refresh pushed to Convex under the roster's own observation stamp; a frame gap invalidates in the transport and the next publish re-asks and reports the newer answer; the scope-guard table is vendored beside the announced catalogue, and a family in neither vocabulary is named on receipt |

Fixtures built from upstream sources at the tag the fixture names (`upstream_tag`) — copied from upstream unit tests, or
composed: the fixture's `_about` lists every composed part, and only the three scenarios composed
throughout say `COMPOSED` in their own description — are vendored in
`bridge/test/fixtures/openclaw_upstream_frames.json` and replayed by
`bridge/test/upstream-frames.test.ts`; their citations are checked by
`bridge/test/upstream-citations.test.ts`.
