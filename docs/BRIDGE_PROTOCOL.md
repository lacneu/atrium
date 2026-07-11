# Bridge Protocol

The bridge sits between Convex and an agent gateway (OpenClaw or Hermes). It has
two seams:

- **Convex → bridge** — Convex `POST`s outbound operations (send a turn, patch
  session settings, reset, query) to the bridge's authenticated HTTP server.
- **Bridge → Convex** — the bridge `POST`s normalized inbound events (assistant
  deltas, snapshots, parts, media, finalize, session metadata) to Convex's
  ingest HTTP action.

The bridge ↔ gateway seam itself is provider-specific: a persistent WebSocket for
OpenClaw and for Hermes' default transport, or an OpenAI-compatible REST/SSE
exchange for Hermes' alternate transport. A per-provider adapter owns the
version- and transport-specific frame handling there and exposes only the stable
shapes below. This document is the Convex ↔ bridge contract a maintainer or a
third-party integrator depends on, not the raw gateway frames.

## Providers, transports, and capabilities

The two seams above are identical regardless of provider — that is the point. What
differs is the *set of operations a given gateway can serve*, which each provider
(and, for Hermes, each transport) declares as a capability manifest reported
through `GET /capabilities`. Convex and the front end read this manifest and gate
their behavior on it: an endpoint or feature a gateway does not advertise is never
invoked. OpenClaw advertises the full surface; Hermes advertises a smaller one, and
its REST transport a smaller one still (a per-turn run with a server-side stop and
single-agent discovery). See [ARCHITECTURE.md](ARCHITECTURE.md#providers-and-capabilities).

## Versioning

The protocol is `0.x`. Shapes can still evolve before `1.0`; breaking changes
are recorded here and covered by regression tests. The bridge reports the served
gateway version, provider, transport, and capability flags through
`GET /capabilities`.

## Authentication

Both seams use environment-scoped shared secrets — never tokens in tables or the
browser.

- **Convex → bridge**: requests carry the `BRIDGE_SHARED_SECRET` as the **raw**
  `Authorization` header value (no `Bearer ` prefix). The bridge rejects any
  request whose secret does not match.
- **Bridge → Convex**: ingest requests carry `Authorization: Bearer
  <BRIDGE_INGEST_SECRET>`; Convex constant-time compares it.

Both secrets are configured identically on each side (bridge container env and
Convex deployment env). See [CONFIGURATION.md](CONFIGURATION.md).

## Convex → bridge: HTTP endpoints

The bridge runs a small HTTP server (default port `8787`).

Every capability-specific route is only invoked when the served gateway advertises
the matching capability; against a provider that lacks it, the route is never
called (and answers with a non-secret refusal if it is).

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Unauthenticated liveness probe. |
| `/capabilities` | GET | Served gateway version, provider, transport + capability flags (e.g. Agent Files, Chat Defaults, sub-agent monitoring, gateway TTS). |
| `/agents` | GET | Discovered agents for an instance (`?instanceName=`). |
| `/send` | POST | Dispatch a user turn to the gateway. |
| `/patch` | POST | Apply per-chat session settings (reasoning level / model). OpenClaw only. |
| `/reset` | POST | Reset the gateway session for a chat (after a message delete) so the next turn re-hydrates. |
| `/compact` | POST | Trigger compaction for a chat's session. OpenClaw only. |
| `/agent-files` | POST | Agent workspace-file operations (list / get / set) for the served instance. |
| `/config-defaults` | POST | Chat Defaults operations for the served instance. OpenClaw only. |
| `/subagent-send` | POST | Dispatch a user message to a running sub-agent session. |
| `/tts` | POST | Gateway text-to-speech: synthesize text and return the audio (backs the gateway read-aloud engine). OpenClaw only. |
| `/query` | POST | Forward an operator query to the gateway (backs `/api/v1/openclaw/query`). OpenClaw only. |

### `POST /send`

Convex's dispatch action (`convex/bridge.ts`) sends a JSON body with non-secret
routing names and the turn payload:

```json
{
  "chatId": "<convex chat id>",
  "openclawChatId": "<gateway conversation id, or null to start fresh>",
  "instanceName": "primary",
  "agentId": "<routed agent>",
  "canonical": "<per-user canonical key>",
  "text": "Convert this file to PDF",
  "clientMessageId": "<client-generated id, used as the idempotency key>",
  "messageId": "<this turn's user message id>",
  "sessionSettings": { "thinkingLevel": "…", "model": "…" },
  "attachments": [
    { "type": "file", "mimeType": "image/png", "fileName": "x.png", "content": "<base64>" }
  ]
}
```

Only instance and agent **names** cross this boundary; the bridge maps
`instanceName` to a gateway token and device identity from the encrypted
per-instance credentials it fetches from Convex (the recommended UI-managed
model) or, as the single-instance fallback, from its own environment.
Inbound attachments are inlined as base64 (bounded by the gateway WebSocket
payload limit). The bridge builds an idempotency key from `clientMessageId`, so
an at-least-once delivery is safe. On a gateway refusal the bridge responds with
a `502` carrying a curated, non-secret error `code`; Convex surfaces that to the
user as a failed turn without leaking the gateway's raw message.

`/patch` and `/reset` take the same routing fields (`chatId`, `openclawChatId`,
`instanceName`, `agentId`, `canonical`). Convex also drives `/reset` itself for
the bounded auto-retry of transient gateway session-init conflicts: a turn that
dies with zero content on that error class is deleted and regenerated
automatically (at most twice, with backoff) before the user sees a failure.

## Bridge → Convex: ingest

The bridge `POST`s one normalized operation per JSON body to Convex's
`POST /bridge/ingest` HTTP action (served at the Convex `.site` origin). Each op
runs the matching internal Convex mutation; the front end then sees the change
reactively. The op union (the canonical shape lives in
`bridge/src/convex-writer.ts`):

| `op` | Effect |
| --- | --- |
| `startAssistant` | Create the in-progress assistant message for a run; returns its `messageId`. |
| `appendDelta` | Append streamed `text` to the message. |
| `setSnapshot` | Replace the message text with an authoritative snapshot. |
| `addPart` | Add a structural part (tool / reasoning) to the message. |
| `getUploadUrl` | Get a short-lived Convex storage upload URL for outbound media. |
| `addMediaPart` | Persist an already-uploaded media blob (`storageId`) as a media part. |
| `finalize` | Commit the turn with a terminal status (`complete` / `error` / `aborted`). |
| `setSessionMeta` | Mirror the gateway's session metadata (model, reasoning, context usage). |
| `setPhase` | Update the in-flight turn's live processing phase (thinking-placeholder detail). |
| `heartbeat` | Keep-alive for a long silent turn so the stuck-stream watchdog doesn't reap it. |
| `updateRunId` | Stamp the provider run id onto an already-created streaming message (late-learned ids). |
| `getRehydrationContext` | Read the stored conversation (rolling summary + a bounded block of verbatim prior turns — the hybrid re-grounding, used on both providers) so the bridge can re-hydrate a fresh gateway session. |
| `bindProviderChat` / `clearProviderChat` | Persist / clear the provider-side conversation id on the chat (session continuity across turns; the bind is refused when it raced a `/reset`). |
| `upsertSubAgent` / `upsertSubAgentToolPart` | Observe a spawned sub-agent's lifecycle, result and tool activity (the sub-agent monitor). |
| `recordSubAgentInteractionReply` | Attach a sub-agent's reply to a user's follow-up interaction with it. |
| `gatewayPressure` / `mediaTrace` / `rehydrateTrace` / `calibrate` | Content-free observability writes (context pressure, media delivery decisions, rehydration decisions, clock calibration). |

The table matches the current union; when in doubt, the canonical shape in
`bridge/src/convex-writer.ts` wins.

### Outbound media (no base64, no size ceiling)

Generated files do not flow through the JSON ingest endpoint. Instead the bridge:

1. calls `getUploadUrl` to obtain a short-lived Convex storage URL;
2. streams the raw file bytes straight to that URL (a direct binary `POST`);
3. calls `addMediaPart` with the returned `storageId`, filename, and MIME type.

The gateway filesystem path is never sent to Convex. The browser later downloads
the file from Convex storage, so server paths are never exposed.

## Normalized streaming model

A turn is rendered from the operations above: `startAssistant` opens the
message, `appendDelta`/`setSnapshot` build its text, `addPart`/`addMediaPart`
attach tool, reasoning, and media parts, and `finalize` commits it with a
terminal status. Once a snapshot is authoritative for a turn, later deltas for
that turn are ignored. Auto-compaction, empty/duplicate finals, follow-on runs,
and private acknowledgements are absorbed by the bridge normalizer so the Convex
state — and therefore the UI — stays consistent.

## Provider and version compatibility

Gateways evolve quickly and each release can change event shapes; two providers
diverge further still. The rule is the same in every case: **all version- and
provider-specific frame parsing lives in the bridge's per-provider normalizer;
everything downstream (Convex, the front end) sees only the stable operations
above.** When a new gateway version changes a shape, add a fixture, extend the
normalizer, and nothing downstream changes. The per-version replay process is
documented in [OPENCLAW_VERSION_COMPAT.md](OPENCLAW_VERSION_COMPAT.md); the same
capture-to-fixture discipline applies to Hermes.

## Observability and privacy

Every ingest and dispatch records a metadata-only trace event in Convex
(operation, ids, lengths, counts — never message text, filenames, or gateway
tokens). The read side of this data is exposed through the key-authed `/api/v1`
surface; see [/api/v1 controls](../compliance/API_CONTROLS.md).
