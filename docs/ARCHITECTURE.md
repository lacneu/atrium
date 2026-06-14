# Architecture

Atrium is a web chat UI for **AI agent gateways** (OpenClaw today, Hermes
planned). It is built so that a single user turn — which an agent gateway can fan
out into multiple runs, intermediate replies, tool output, generated media,
auto-compaction restarts, and messages that arrive after a browser reconnect — is
handled naturally, and so that the UI stays stable even as a provider's event
shapes change between versions.

## Components

```text
┌──────────┐   queries/mutations   ┌───────────────────────┐
│ Browser  │ ◀───── reactive ────▶ │ Convex (self-hosted)  │
│ React +  │                       │  schema, chats,       │
│ assistant│                       │  messages, routing,   │
│   -ui    │                       │  auth, observability  │
└──────────┘                       └───────────┬───────────┘
                                                │ schedules an
                                                │ outbound turn
                                                ▼
                                       ┌──────────────────┐   WebSocket   ┌──────────────┐
                                       │ Bridge (Node/TS) │ ◀───────────▶ │ OpenClaw     │
                                       │ operator socket, │               │ gateway      │
                                       │ normalizer       │               │ (runs agents)│
                                       └────────┬─────────┘               └──────────────┘
                                                │ ingests normalized
                                                │ events back into Convex
                                                ▼
                                          (Convex storage + tables)
```

- **Front end (`src/`)** — React + Vite + assistant-ui, in TypeScript. It is
  built to a static bundle and packaged as an
  origin-agnostic Docker image: the Convex URL is **not** baked at build time but
  injected at runtime via `/config.json` (see `src/lib/runtimeConfig.ts`), so the
  same image serves any deployment. The front end subscribes to Convex and never
  parses raw gateway frames.

- **Backend (`convex/`)** — a self-hosted [Convex](https://convex.dev)
  deployment (TypeScript functions + a reactive database). It is the single
  source of truth for chats, messages, message parts, per-user agent routing,
  authentication, and observability data. `convex/_generated/` is committed so
  the front end type-checks and builds without a live backend.

- **Bridge (`bridge/`)** — a Node/TypeScript worker that holds a persistent
  operator WebSocket to an agent gateway (OpenClaw today; a Hermes adapter is
  planned). A per-provider adapter normalizes the gateway's version-specific
  frames into a small stable vocabulary and relays turns to and from Convex over
  HTTP. It imports nothing from the Convex app — it is coupled only through the
  documented ingest and dispatch endpoints, so it versions and deploys
  independently.

- **Agent gateway** — external to this project (OpenClaw today, Hermes planned).
  It runs the agents. Atrium never runs a model itself; you bring your own
  gateway.

- **MCP server (`mcp/`)** — exposes the read-only observability surface over the
  Model Context Protocol so an agent or operator can query traces, KPIs, and
  anomalies. It calls the same `/api/v1` routes.

## Data flow

### Sending a turn (browser → gateway)

1. The browser calls a Convex mutation to send a message. Convex inserts the user
   message and an `outbox` row, then schedules an internal dispatch action.
2. The dispatch action (`convex/bridge.ts`) resolves routing for the chat — which
   OpenClaw instance and agent this user is bound to — and `POST`s the turn to the
   bridge's authenticated `/send` endpoint. Only non-secret instance/agent
   **names** cross this boundary; the bridge maps names to gateway tokens from its
   own environment.
3. The bridge applies any per-chat session settings, then sends the turn to the
   gateway over its operator WebSocket. Inbound attachments are resolved from
   Convex storage and inlined for the gateway.

### Receiving a reply (gateway → browser)

1. The gateway streams events back over the WebSocket. The bridge's normalizer
   turns the version-specific frames into a small set of operations:
   `startAssistant`, `appendDelta`, `setSnapshot`, `addPart`, `addMediaPart`,
   `finalize`, plus session metadata.
2. The bridge `POST`s each operation to Convex's `/bridge/ingest` HTTP action,
   which runs the corresponding internal mutation. Outbound media bytes are
   streamed straight to a Convex upload URL (no base64, no size ceiling through
   the JSON endpoint); only the resulting storage id is persisted.
3. Convex updates the message and its parts. Because the front end subscribes to
   Convex, the reply streams into the UI reactively — no direct browser↔bridge
   connection is involved.

This indirection is the point: the browser only ever sees Convex state, so it is
insulated from gateway frame churn. The bridge absorbs the version-specific
quirks (see [OPENCLAW_VERSION_COMPAT.md](OPENCLAW_VERSION_COMPAT.md)), and the
bridge↔Convex contract is documented in [BRIDGE_PROTOCOL.md](BRIDGE_PROTOCOL.md).

## Authentication

Sign-in uses `@convex-dev/auth` with Google and Microsoft Entra OAuth providers.
The authoritative access gate is server-side in Convex: a sign-in is accepted
only if the email's domain is in `AUTH_ALLOWED_EMAIL_DOMAINS`. The **first**
sign-in from an allowed domain is promoted to admin; subsequent users start as
regular users until an admin grants them more. OAuth callback routes are
registered on the Convex HTTP router (`convex/http.ts`).

## Routing (multi-user / multi-agent / multi-instance)

A deployment can serve many users, each routed to the OpenClaw agent assigned to
them, on a named OpenClaw instance. A chat is bound to a target (instance +
agent); the dispatch path resolves and persists that binding, and re-binds
cleanly if the bound agent was removed on the gateway. A bridge serves one named
instance, declared three ways consistently (the bridge's `OPENCLAW_INSTANCE_NAME`,
the Convex `instances` row, and the Convex `BRIDGE_INSTANCE_NAME`) so a routing
misconfiguration fails loudly instead of answering from the wrong gateway.

## Observability

Convex records metadata-only trace events for every inbound ingest, outbound
dispatch, and authenticated API call, and rolls them up into KPIs and anomaly
detectors. These are exposed through the key-authed `/api/v1` HTTP surface
(`convex/http.ts`) and the MCP server, gated by service-account permissions.
None of these surfaces return chat content — see
[/api/v1 controls](../compliance/API_CONTROLS.md) for the full control set.

## Internationalization

UI strings go through Paraglide JS (type-safe, compile-time messages), with
French as the default locale and English available. Two CI gates protect the catalog: a parity check (every base-locale
key exists in every other locale) and a ratchet that resists new hard-coded
strings. See [DEVELOPMENT.md](DEVELOPMENT.md).
