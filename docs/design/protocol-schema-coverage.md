# OpenClaw Gateway Protocol — Schema Coverage of the Atrium Bridge

Factual gap/coverage analysis of the Atrium bridge against the official OpenClaw
gateway-protocol TypeBox schemas (`chat` event union, `AgentEvent`,
`AgentInternalEvent`, `ChatSendParams`). Every claim is traceable to a bridge
`file:line` or a schema field. No recommendations — the architecture proposal is
handled elsewhere.

Schema sources: `chat` union + `chat.send`/`abort`/`inject`/`history` params
(logs-chat schema); `AgentEventSchema` / `AgentInternalEventSchema` /
`AgentParamsSchema` (agent schema).

Bridge consumers analyzed: `bridge/src/providers/openclaw/normalizer.ts`,
`run-manager.ts`, `sub-agent-observer.ts`, `sub-agent-frames.ts`,
`openclaw-client.ts`, `bridge/src/server.ts`, `bridge/src/session.ts`,
`bridge/src/compat.ts`.

---

## 1. Schema surface inventory

### Chat event union (`ChatEventSchema`) — the assistant stream

Shared base (`ChatEventBaseSchema`): every event carries these.

| Field | Type | On states |
|---|---|---|
| `runId` | NonEmptyString | delta/final/aborted/error |
| `sessionKey` | NonEmptyString | all |
| `agentId` | optional | all |
| `spawnedBy` | optional | all |
| `seq` | Integer ≥ 0 | all |

Per-state fields:

| Field | Type | delta | final | aborted | error |
|---|---|---|---|---|---|
| `state` | literal | `"delta"` | `"final"` | `"aborted"` | `"error"` |
| `message` | Unknown (opaque) | opt | opt | opt | opt |
| `deltaText` | String | ✓ (req) | — | — | — |
| `replace` | Boolean | opt | — | — | — |
| `usage` | Unknown (opaque) | opt | opt | — | opt |
| `stopReason` | String | — | opt | opt | opt |
| `errorMessage` | String | — | — | — | opt |
| `errorKind` | enum `refusal\|timeout\|rate_limit\|context_length\|unknown` | — | — | — | opt |

### Agent event (`AgentEventSchema`) — tool/lifecycle/assistant/item streams

| Field | Type | Meaning |
|---|---|---|
| `runId` | NonEmptyString | run correlation |
| `seq` | Integer ≥ 0 | per-run sequence |
| `stream` | NonEmptyString (**open**, not an enum) | `assistant`/`tool`/`lifecycle`/`item`/`<plugin>.provenance`/… |
| `ts` | Integer ≥ 0 | gateway timestamp (ms) |
| `spawnedBy` | optional | parent sessionKey (child runs) |
| `isHeartbeat` | optional Boolean | keep-alive marker |
| `data` | Record<string,Unknown> | stream-specific payload |

### `chat.send` params (`ChatSendParamsSchema`) — what the bridge may send

`sessionKey`, `agentId?`, `sessionId?`, `message`, `thinking?`,
`fastMode?` (`bool|"auto"`), `fastAutoOnSeconds?`, `deliver?`,
`originatingChannel?`, `originatingTo?`, `originatingAccountId?`,
`originatingThreadId?`, `attachments?`, `timeoutMs?`, `systemInputProvenance?`,
`systemProvenanceReceipt?`, `suppressCommandInterpretation?`, `idempotencyKey`
(required).

### `AgentInternalEventSchema` — the formal announce contract (INPUT, not stream)

**Important:** these are elements of `AgentParamsSchema.internalEvents[]` — i.e.
fields of an **agent-run request** (`agents.run`-class INPUT), NOT fields on any
event the bridge receives. Fields: `type` (`"task_completion"`), `source`
(`subagent|cron|image_generation|video_generation|music_generation`),
`childSessionKey`, `childSessionId?`, `announceType`, `taskLabel`,
`status` (`ok|timeout|error|unknown`), `statusLabel`, `result`, `attachments[]?`,
`mediaUrls[]?`, `statsLine?`, `replyInstruction`.

---

## 2. Coverage matrix

Legend: **H** = handled, **D** = ignored deliberately, **G** = not handled (gap).

### Chat event base fields

| Field | Verdict | Evidence |
|---|---|---|
| `runId` | H | Seeded into `ownRunIds` from the ack (`noteRunStarted`, normalizer.ts:418-426); frame-level runId drives foreign-run isolation (normalizer.ts:527-540) and tags emitted events as `currentRunId`. |
| `sessionKey` | H | The single isolation decision — foreign/sessionless frames dropped (normalizer.ts:524). Also the sub-agent admission key (`spawnedBy === sessionKey`, normalizer.ts:511-521). |
| `agentId` (on events) | D | Never read off events; agent routing is carried by the sessionKey segment (epoch + agentId baked in). No consumer. |
| `spawnedBy` | H | Routes a child frame to `handleSubAgent` for observation-only activity (normalizer.ts:511-521); child-lane admission in the observer (sub-agent-observer.ts:239). |
| `seq` | G (partial) | Read ONLY as a component of the re-broadcast dedup key (normalizer.ts:663-670). No ordering check, no gap detection. |

### ChatDelta

| Field | Verdict | Evidence |
|---|---|---|
| `state: "delta"` | H | Non-`"final"` ⇒ `isFinal=false` (normalizer.ts:656); text applied but turn not closed. |
| `deltaText` | H | Appended verbatim: `applyVisible(deltaText, isSnapshot=false, …)` → `this.text += candidate` (normalizer.ts:681, 949). |
| `message` (on delta) | H | Checked BEFORE `deltaText` (normalizer.ts:676) — a delta carrying a `message` snapshot goes through the snapshot/replace path instead of appending. |
| **`replace`** | **G** | Never referenced anywhere in the bridge. A `deltaText` delta is unconditionally appended; a non-prefix replacement is honored ONLY incidentally when the frame also carries a `message` (snapshot path replaces). See §4. |
| `usage` (on delta) | G | Never referenced. No token/cost read on the main lane. |

### ChatFinal

| Field | Verdict | Evidence |
|---|---|---|
| `state: "final"` | H | `isFinal=true` (normalizer.ts:656); a final with text finalizes, a final with none arms the empty-final grace (normalizer.ts:687-693). |
| `message` | H | `textFromMessage` extracts `.content`/`.text` (normalizer.ts:143-152, 676). |
| `usage` | G | Never referenced. Main-lane assistant turn has NO tokens/cost telemetry. |
| `stopReason` | G | Never referenced. |

### ChatAborted / ChatError (main lane)

| Field | Verdict | Evidence |
|---|---|---|
| `state: "aborted"` | G | `handleChat` recognizes ONLY `"final"` as terminal (normalizer.ts:656); `"aborted"` is not a terminalizer. Any `message` text renders as a non-final snapshot; no finalize. Main-lane termination relies on the `lifecycle` stream / recv timeout (see §4). |
| `state: "error"` | G | Same: `"error"` is not special-cased in `handleChat`. Main-lane error termination comes from `lifecycle` phase `"error"` → `finalize(status="error")` (normalizer.ts:864-870), NOT from the chat error event. |
| `errorMessage` (chat) | G (main) / H (child) | Not read on the main lane (main-lane error text comes from `extractLifecycleError(data.error)`, normalizer.ts:867). Read on the CHILD lane (normalizer.ts:621-624; sub-agent-observer.ts:313, 345). |
| **`errorKind`** | **G** | Never referenced. The `context_length` category is not consumed anywhere. Compaction is detected by other means (session-id rotation + `livenessState:"abandoned"`), see §4. |
| `stopReason` (aborted/error) | G | Never referenced. |
| `usage` (error) | G | Never referenced. |

### Agent event fields

| Field | Verdict | Evidence |
|---|---|---|
| `runId` | H | Same isolation/attribution path as chat events (normalizer.ts:527-540). |
| `seq` | D | Not read on agent frames (dedup keying is chat-only). |
| `stream` | H | Dispatch switch: `assistant`/`tool`/`lifecycle`/`item`/`<plugin>.provenance` (normalizer.ts:709-755). Open-string nature respected (`endsWith("lifecycle")`, `isProvenanceStream`). |
| `ts` | D | Never read; all timing uses the injected `now` clock, never `frame.ts` (normalizer design header, normalizer.ts:13-18). |
| `spawnedBy` | H | Child-lane routing (as above). |
| `isHeartbeat` | D | Not explicitly consumed. A heartbeat carries no text so it becomes a keep-alive; and every own frame refreshes the recv budget via `armRecv` (normalizer.ts:544), so heartbeats keep the turn alive incidentally — the intended effect. |
| `data` | H | Read structurally per stream (`text`/`delta`/`mediaUrls`/`name`/`phase`/`toolCallId`/`args`/`result`/`type`/`session`, normalizer.ts:698-756, sub-agent-observer.ts). |
| `message` (opaque Unknown, both unions) | H (with coupling) | The schema declares `message` opaque; the bridge reaches into `.content`/`.text` (normalizer.ts:143-152). A structural dependency on a non-contractual internal shape. |

### `chat.send` params — what the bridge SENDS

The bridge builds exactly `{ sessionKey, message, idempotencyKey, attachments? }`
(server.ts:951-981). Everything else is unused:

| Param | Verdict | Evidence |
|---|---|---|
| `sessionKey` | H sent | server.ts:952. |
| `message` | H sent | server.ts:953 (may carry rehydration prefix + injected blocks). |
| `idempotencyKey` | H sent | server.ts:954 (`sha256(sessionKey\|clientMessageId)`, openclaw-client.ts:522-533). |
| `attachments` | H sent (conditional) | Only when inline attachments present; frame-guarded against `maxPayload` (server.ts:956-981). |
| `agentId` | D | Routing lives in the sessionKey segment; never sent per-send. |
| `sessionId` | D | Not sent (sessionKey is the addressing unit). |
| `thinking`, `fastMode`, `fastAutoOnSeconds` | D | Reasoning/model/speed knobs applied OUT-OF-BAND via `sessions.patch` (server.ts:635-736, applyKnobs), NOT via chat.send fields. |
| `deliver` | D | Not sent. |
| `originatingChannel/To/AccountId/ThreadId` | D | Not sent (webchat has no external originating channel). |
| `timeoutMs` | D | Not sent; turn timing is bridge-side (recv/grace deadlines). |
| `systemInputProvenance`, `systemProvenanceReceipt` | G | Not sent. The bridge consumes provenance from a plugin stream (`<plugin>.provenance`) but never sets the send-side provenance fields. |
| `suppressCommandInterpretation` | G | Not sent. User text starting with a gateway command prefix is interpreted by the gateway; the bridge has no opt-out. |

### `chat.abort` / `chat.inject` / `chat.history`

| RPC | Verdict | Evidence |
|---|---|---|
| `chat.abort` | G (not used) | `abort` capability declared `false` (server.ts:1312); abort is synthesized locally by finalizing the turn (`endTurn`, normalizer.ts:428-431). No `chat.abort` request is issued. |
| `chat.inject` | G (not used) | No caller. |
| `chat.history` | G (not used) | `history` capability declared `false` (server.ts:1313). Delivered-reply recovery uses `sessions.get { key }` instead (session.ts:453-478), not `chat.history`. |

### `AgentInternalEvent` (announce INPUT contract)

| Field | Verdict | Evidence |
|---|---|---|
| all (`source`/`status`/`taskLabel`/`statusLabel`/`result`/`replyInstruction`/`attachments`/`mediaUrls`/`statsLine`/…) | G by construction | These are INPUT params of an agent-run request. The bridge sends via `chat.send` (never `agents.run` with `internalEvents`), and these fields appear on NO received event. The bridge reconstructs the announce from the gateway-rendered run's ordinary chat/assistant frames instead (see §3). |

---

## 3. Sub-agent / announce contract vs implementation

**`spawnedBy` convention.** Every child frame carries `spawnedBy = parent
sessionKey`. Two consumers use it: the normalizer admits a child frame for
observation-only activity when `spawnedBy === this.sessionKey && sessionKey !==
this.sessionKey` (normalizer.ts:511-521), and the persistent `SubAgentObserver`
admits by the same `spawnedBy` match plus the `sessions_spawn` result on the
parent lane (sub-agent-observer.ts:229-247). Because the parent sessionKey embeds
the chatId, this is contamination-proof across chats on a shared agent id.

**Announce runId convention.** A post-turn child result is delivered as a
gateway-initiated run on our own session with `runId` prefixed
`announce:` (today `announce:v1:<childSessionKey>:<childRunId>`); the version
segment is treated as opaque (run-manager.ts:599-610). The bridge opens a
SPONTANEOUS turn for it and streams it like a normal reply. A `NO_REPLY` sentinel
run is dropped without ever creating a message (run-manager.ts:615-641,
deferred-open probe). **The bridge never reads the `AgentInternalEvent` fields** —
it recovers the text from the rendered run's chat/assistant frames.

**Status vocabularies are parallel, not a mapping.** The observer derives child
status from the child's own `chat.state` via the shared classifier
(sub-agent-frames.ts:23-48): `final→done`, `error→error`, `aborted→aborted`,
`delta/other→running` (keep-alive); lifecycle `end→done`, `error→error`,
else `running`. It NEVER reads `AgentInternalEvent.status`
(`ok|timeout|error|unknown`). So:

| `AgentInternalEvent.status` | Observer `SubAgentStatus` | Relationship |
|---|---|---|
| `ok` | `done` | different source (chat.state), not derived from this field |
| `error` | `error` | same word, independent derivation |
| `timeout` | — | no distinct status; a hung child is synthesized to `error` + a "timed out" message at TTL sweep (sub-agent-observer.ts:687-719) |
| `unknown` | — | no mapping |
| — | `aborted` | observer-only (from `chat.state:"aborted"`); absent from the internal-event enum |

**Terminal handling.** `chat:final/error/aborted` on the child lane is the
authoritative terminal (sub-agent-observer.ts:273-351). A subtlety pinned in
code: `chat:error` is NOT reap-terminal for a child, because the gateway's
mid-turn overflow recovery emits `chat:error`, truncates tool results, then
resumes and can finish clean — the observation is kept alive and a later
`done` overwrites the provisional error row (sub-agent-observer.ts:283-296).
A child that emits a `lifecycle:end/error` but never its `chat:final` is
backstopped by the TTL watchdog, never terminalized on lifecycle alone
(sub-agent-observer.ts:362-373).

**Sub-agent telemetry does NOT use `usage`.** The child's runtime/tokens/cost are
read from `payload.session.{runtimeMs,totalTokens,estimatedCostUsd,startedAt}`
(sub-agent-observer.ts:651-664), NOT from the chat event's opaque `usage` field.
So `usage` is unconsumed on the child lane too.

---

## 4. Risks ranked

Grep proves "referenced or not"; a gap is only a risk when NO other path covers
the same ground. Classified on that axis.

### Non-mitigated (real loss)

> **Update (same day):** item 1 below and the main-lane `chat:error`/`chat:aborted`
> terminalization (item 6) are now HANDLED — `handleChat` terminalizes both states,
> allowlists `errorKind` against the schema enum, persists it as the message's
> `errorCode` (localized actionable headline in the error card) and flags
> `context_length` on the `chat.gateway_pressure` trace. The coverage manifest
> (`bridge/protocol/openclaw/coverage.json`) is the live source of truth.

1. **`errorKind` / `context_length` never consumed.** The bridge DOES surface a
   "context was optimized" marker, but via a DIFFERENT mechanism — session-id
   rotation (normalizer.ts:553-565, preflight) and `livenessState:"abandoned"`
   (normalizer.ts:876-892, midturn) — so silent gateway-managed compaction is
   observable. What is lost is the EXPLICIT classification when a gateway reports
   a HARD, un-recovered overflow as `chat:error{errorKind:"context_length"}`:
   that frame is not terminalized by `handleChat` at all, and even where a
   lifecycle error terminalizes the turn, the failure surfaces as a generic
   error, never tagged `context_length`. Given Atrium's context-overflow
   observability initiative, this is the highest-value gap: distinguish
   "compaction handled silently" (covered) from "context_length error degraded to
   a generic error" (not covered).

2. **`usage` unconsumed on BOTH lanes.** No token/cost telemetry for the main
   assistant turn (main lane: never referenced). Child-lane telemetry exists but
   is sourced from `payload.session.*`, not `usage` (sub-agent-observer.ts:651-664)
   — so if the gateway ever moves numbers to `usage`-only on some version, child
   telemetry silently empties. User-visible impact today: main-turn cost/tokens
   absent from the trace.

3. **`stopReason` unconsumed (low impact).** Informational only; no branch
   depends on why a turn stopped. Loss is cosmetic/diagnostic.

4. **`seq` gap-detection absent (low impact).** No ordering/gap check
   (normalizer.ts:663-670 uses `seq` only for exact-rebroadcast dedup). Real-world
   impact low because the transport is an ordered WS/TCP stream; a dropped/reordered
   frame would not be detected, but the gateway does not reorder on one socket.

### Conditionally mitigated (does not outrank the above)

5. **`replace=true` ignored on a bare `deltaText`.** `handleChat` tests `message`
   BEFORE `deltaText` (normalizer.ts:676→681); a replacement delta that carries a
   `message` snapshot goes through the snapshot path, which REPLACES
   (`this.text = candidate`, normalizer.ts:943) — so `replace` is honored
   incidentally there. The bug bites ONLY a `deltaText`-only replacement delta:
   `applyVisible(delta, isSnapshot=false)` appends (`this.text += candidate`,
   normalizer.ts:949), corrupting the streamed text. Whether this fires depends on
   whether any gateway version emits `replace:true` with a bare `deltaText` and no
   `message`. Not observed in the current fixtures.

6. **Main-lane `chat:error`/`chat:aborted` not terminalized by `handleChat`.** The
   strongest structural finding, but it does not automatically mean a hang.
   Main-lane termination comes from the `lifecycle` stream (phase `error` →
   finalize; phase `end` → grace/finalize). Whether a `chat:error`/`aborted` is
   always paired with a lifecycle terminal on the MAIN lane is **not verifiable
   from the available fixtures**: the only `chat:error` fixture is child-lane
   (`subagent_frames_error.jsonl`), where `lifecycle:error` (line 19) precedes
   `chat:error` (line 21). If a main-lane `chat:error` ever arrives WITHOUT a
   paired lifecycle terminal, the turn would hang until the 180s recv timeout
   (`BASE_RECV_TIMEOUT`, normalizer.ts:73) finalizes it as a blank/best-effort
   turn. Stated honestly: lifecycle-paired termination is observed on the child
   lane; main-lane pairing is unproven; the recv timeout is the backstop.

### Not a risk (documented to pre-empt re-flagging)

- **`isHeartbeat` not explicitly consumed** is intended: heartbeats carry no text
  (keep-alive) and every own frame refreshes the recv budget via `armRecv`
  (normalizer.ts:544), which is the desired effect. No gap.

---

## 5. What Hermes changes

This bridge is multi-provider by design: the normalized event vocabulary in
`core/events.ts` is the provider boundary, and only `providers/openclaw/*`
parses vendor frames. **Everything in §1–§4 is OpenClaw-specific** — the schemas
analyzed are OpenClaw's, and the field-level verdicts describe the OpenClaw
normalizer/observer/client. When the Hermes adapter lands
(`compat.ts:108-112`, structural placeholder with zero capabilities), it will
have its OWN frame schema and its own coverage matrix; it must emit the SAME
normalized events (`message.delta/snapshot/final`, `run.status`, `tool.status`,
`media`, `agent.activity`, `context.compaction`) for the provider-agnostic
`TurnSink` to consume unchanged. The gaps above (e.g. `errorKind`/`usage`) are
about the OpenClaw→normalized translation; Hermes may or may not expose
equivalent signals, and the shared `context.compaction` / `run.status` event
shapes are the contract any provider must satisfy — not the OpenClaw field names.
