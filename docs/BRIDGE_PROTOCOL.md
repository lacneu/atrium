# Bridge Protocol

The bridge sits between Convex and an OpenClaw gateway. It has two seams:

- **Convex → bridge** — Convex `POST`s outbound operations (send a turn, patch
  session settings, reset, query) to the bridge's authenticated HTTP server.
- **Bridge → Convex** — the bridge `POST`s normalized inbound events (assistant
  deltas, snapshots, parts, media, finalize, session metadata) to Convex's
  ingest HTTP action.

The bridge ↔ gateway seam itself is a persistent WebSocket; the bridge owns the
version-specific frame handling there and exposes only the stable shapes below.
This document is the contract a maintainer or a third-party integrator depends
on, not the raw gateway frames.

## Versioning

The protocol is `0.x`. Shapes can still evolve before `1.0`; breaking changes
are recorded here and covered by regression tests. The bridge reports the served
gateway version and its capabilities through `GET /capabilities`.

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

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Unauthenticated liveness probe. |
| `/capabilities` | GET | Served gateway version + capability flags (e.g. Agent Files, Chat Defaults). |
| `/agents` | GET | Discovered agents for an instance (`?instanceName=`). |
| `/send` | POST | Dispatch a user turn to the gateway. |
| `/patch` | POST | Apply per-chat session settings (reasoning level / model) via `sessions.patch`. |
| `/reset` | POST | Reset the gateway session for a chat (after a message delete) so the next turn re-hydrates. |
| `/compact` | POST | Trigger compaction for a chat's session. |
| `/agent-files` | POST | Agent Files operations for the served instance. |
| `/config-defaults` | POST | Chat Defaults operations for the served instance. |
| `/query` | POST | Forward an operator query to the gateway (backs `/api/v1/openclaw/query`). |

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
`instanceName` to a gateway token and device identity from its own environment.
Inbound attachments are inlined as base64 (bounded by the gateway WebSocket
payload limit). The bridge builds an idempotency key from `clientMessageId`, so
an at-least-once delivery is safe. On a gateway refusal the bridge responds with
a `502` carrying a curated, non-secret error `code`; Convex surfaces that to the
user as a failed turn without leaking the gateway's raw message.

`/patch` and `/reset` take the same routing fields (`chatId`, `openclawChatId`,
`instanceName`, `agentId`, `canonical`).

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
| `getRehydrationContext` | Read a bounded block of prior turns so the bridge can re-hydrate a fresh gateway session. |

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

## OpenClaw version compatibility

OpenClaw evolves quickly and each release can change event shapes. The rule is:
**all version-specific frame parsing lives in the bridge normalizer; everything
downstream (Convex, the front end) sees only the stable operations above.** When
a new gateway version changes a shape, add a fixture, extend the normalizer, and
nothing downstream changes. The per-version replay process is documented in
[OPENCLAW_VERSION_COMPAT.md](OPENCLAW_VERSION_COMPAT.md).

## Observability and privacy

Every ingest and dispatch records a metadata-only trace event in Convex
(operation, ids, lengths, counts — never message text, filenames, or gateway
tokens). The read side of this data is exposed through the key-authed `/api/v1`
surface; see [/api/v1 controls](../compliance/API_CONTROLS.md).
