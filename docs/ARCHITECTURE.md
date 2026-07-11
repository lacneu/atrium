# Architecture

Atrium is a web chat UI for **AI agent gateways** (OpenClaw and Hermes). It is
built so that a single user turn — which an agent gateway can fan out into
multiple runs, intermediate replies, tool output, generated media,
auto-compaction restarts, and messages that arrive after a browser reconnect — is
handled naturally, and so that the UI stays stable even as a provider's event
shapes change between versions, and even across two providers with very different
surfaces.

![A calm, light-filled hall where users chat with their agents. The gateway's raw event churn — tangled cables, shifting version numbers — stays behind the threshold in the machine room, smoothed into one clean stream by the bridge before it ever reaches the hall.](assets/atrium-overview.png)

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
                                       ┌──────────────────┐  WS or REST   ┌──────────────┐
                                       │ Bridge (Node/TS) │ ◀───────────▶ │ Agent gateway│
                                       │ provider adapter,│               │ (OpenClaw or │
                                       │ normalizer       │               │  Hermes)     │
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
  connection to an agent gateway. A **per-provider adapter**
  (`bridge/src/providers/`) normalizes the gateway's version-specific frames into
  a small stable vocabulary and relays turns to and from Convex over HTTP. It
  imports nothing from the Convex app — it is coupled only through the documented
  ingest and dispatch endpoints, so it versions and deploys independently. Which
  provider and (for Hermes) which transport a bridge serves is resolved per
  instance from Convex config, not baked into the image.

- **Agent gateway** — external to this project (OpenClaw or Hermes). It runs the
  agents. Atrium never runs a model itself; you bring your own gateway.

- **MCP server (`mcp/`)** — exposes the read-only observability surface over the
  Model Context Protocol so an agent or operator can query traces, KPIs, and
  anomalies. It calls the same `/api/v1` routes.

## Data flow

### Sending a turn (browser → gateway)

1. The browser calls a Convex mutation to send a message. Convex inserts the user
   message and an `outbox` row, then schedules an internal dispatch action.
2. The dispatch action (`convex/bridge.ts`) resolves routing for the chat — which
   gateway instance and agent this turn is addressed to (the chat's binding, or
   the per-turn routed agent in a multi-agent conversation) — and `POST`s the
   turn to the bridge's authenticated `/send` endpoint. Only non-secret
   instance/agent **names** cross this boundary; the bridge maps names to the
   encrypted per-instance gateway credentials it fetches from Convex (or, as the
   single-instance fallback, from its own environment).
3. The bridge applies any per-chat session settings, then sends the turn to the
   gateway over that provider's transport — OpenClaw's operator WebSocket, or
   Hermes over its JSON-RPC WebSocket / REST+SSE surface. Inbound attachments are
   resolved from Convex storage and inlined for the gateway.

### Receiving a reply (gateway → browser)

1. The gateway streams events back over the same transport. The provider's
   normalizer in the bridge turns the version-specific frames into a small set
   of operations:
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

![The bridge as a membrane: erratic, version-specific raw frames from the gateway enter on the left; one clean, steady signal — the stable shape the UI and observability consume — comes out on the right.](assets/atrium-normalization.png)

## Providers and capabilities

Atrium supports two gateway providers — **OpenClaw** and **Hermes** — behind the
same bridge/normalizer seam. They do not have the same feature surface, and the
design does not pretend they do. Instead, each provider (and, for Hermes, each
transport) publishes a **capability manifest**: the exact set of features the
bridge actually implements against it, each with the minimum gateway version that
supports it. The bridge reports this through `GET /capabilities`; the front end is
**capability-driven** and renders only what a chat's instance advertises. A
control a gateway cannot back is simply *absent* — never a button that fails.

- **OpenClaw** exposes the full surface: per-chat knobs (reasoning level, model,
  fast mode), session reset and compaction, agent workspace files, chat defaults,
  general inbound attachments, sub-agent monitoring, and gateway-side
  text-to-speech.
- **Hermes** exposes a deliberately smaller surface and offers two transports.
  The **WebSocket** transport (the default) carries structured delegation and
  **Mixture-of-Agents** activity — surfaced in the sub-agent monitor — plus inline
  attachments and agent workspace files. The **REST** (OpenAI-compatible)
  transport carries only a per-turn run with a real server-side stop and
  single-agent discovery. Hermes has no per-chat knobs (they are gateway-side
  config) and no chat-defaults write, so those controls stay hidden on a Hermes
  instance.

Because the UI is driven by the manifest rather than by per-provider branches,
adding or evolving a provider is a bridge-and-manifest change; the front end
adapts on its own. The manifest is mirrored and re-validated in Convex
(`convex/lib/compat.ts`) so an older or divergent bridge cannot unlock a feature
the deployment should not show.

## Authentication

Sign-in uses `@convex-dev/auth` with Google and Microsoft Entra OAuth providers.
The authoritative access gate is server-side in Convex: a sign-in is accepted
only if the email's domain is in `AUTH_ALLOWED_EMAIL_DOMAINS`. The **first**
sign-in from an allowed domain is promoted to admin; subsequent users start as
regular users until an admin grants them more. OAuth callback routes are
registered on the Convex HTTP router (`convex/http.ts`).

## Routing (multi-user / multi-agent / multi-instance)

A deployment can serve many users, each routed to the agent assigned to them, on a
named gateway instance (which may be OpenClaw or Hermes). A chat is bound to a
target (instance + agent); the dispatch path resolves and persists that binding,
and re-binds cleanly if the bound agent was removed on the gateway. Within one
conversation, each turn can also be routed to a DIFFERENT assigned agent (a
per-turn selector in the composer; every reply is attributed to the agent that
produced it), with the full thread re-grounded into the newly routed agent's
session. A bridge serves one named instance, declared consistently on both sides
(the bridge's instance name and the Convex `instances` row /
`BRIDGE_INSTANCE_NAME`) so a routing misconfiguration fails loudly instead of
answering from the wrong gateway.

Two admission gates sit in front of routing. Discovered agents are **disabled by
default**: an admin enables each agent (Settings → Platform) before it can be
assigned or answer anyone — a freshly synced gateway never silently exposes its
agents. And each instance carries a live **availability gate**: while its bridge
poll fails, chats bound to it grey their composer with an explanatory banner
instead of accepting sends that would fail, and recover automatically when the
poll succeeds again.

## Conversation continuity (rehydration and branching)

Gateway sessions are ephemeral (daily resets, pruning, restarts) while Atrium
displays the full thread. When a turn lands on a fresh or reset gateway
session, the bridge asks Convex for the stored conversation and prepends it to
the prompt — a **hybrid** re-grounding: a rolling summary of the older turns
plus a bounded block of recent verbatim ones. This works on both providers
(including a brand-new Hermes server session), and it is also what powers
per-turn agent switches and branching.

Any assistant reply can be **branched into a new conversation** (the reply's
contextual menu): the new chat carries the visible history up to that point —
messages, attachments (no blob duplication), per-message agent attribution and
finished sub-agent result cards — and opens on a fresh gateway session that the
rehydration re-grounds on the first send. The user stays in the original
conversation; the new row pulses in the sidebar. A branch never contains
anything said after its branch point (the rolling summary only rides when its
coverage stops at or before it). See `docs/design/` for the deeper mechanics.

## Document viewer and renditions

Delivered and uploaded files preview in a right-hand panel next to the
conversation: PDFs render in-app (pdf.js, thumbnail rail + zoom), images,
video, audio and text show natively, and markdown renders interpreted (with a
raw toggle). Office documents (PPTX/DOCX/…) are converted to PDF **by an
agent**, not by embedded infrastructure: each instance designates a converter
agent (`converterAgentId`), and the first preview request dispatches a hidden
conversion turn to it; the returned PDF is cached per source file
(`fileRenditions`) so later viewers open instantly. No conversion service ships
with Atrium — the agent's own tools do the work, which keeps the app deployable
anywhere and works with either provider.

## Voice

Read-aloud and dictation run in the browser through the Web Speech API by
default — no API key, no gateway dependency — so they work identically for
either provider. Each
instance chooses its read-aloud engine: the browser's built-in system voices, or,
on providers that expose a text-to-speech RPC (OpenClaw), the gateway's own
configured voices — synthesized on demand through the bridge and played in the
browser. Dictation transcribes the microphone into the composer; both are opt-in
per user.

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
