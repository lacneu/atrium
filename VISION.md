# Vision

Atrium is a self-hostable, multi-user **web chat front end for AI agent
gateways** — a community project, not affiliated with any gateway vendor.
[OpenClaw](https://github.com/openclaw/openclaw) is the first supported provider;
Hermes is next. The goal: give a team a clean, reliable chat UI on top of one or
more agent gateways, without ever exposing gateway credentials to the browser or
chat content to the diagnostic surface.

It is `0.x`: functional and documented, but breaking changes can still happen
before `1.0`. This document is a direction guardrail — priorities and boundaries,
not a contract.

## Principles

- **Embrace the agent-gateway event model.** A single user turn can produce
  multiple runs, intermediate replies, tool output, generated media,
  auto-compaction restarts, and frames that land after a reconnect. The UI is
  built to absorb that — not to assume one prompt → one reply.
- **Survive version drift.** The bridge normalizes each provider/version's frames
  into one stable contract; the frontend is **capability-driven**, so a feature a
  given gateway version lacks degrades gracefully instead of breaking the app.
- **Privacy by construction.** Chat content can be personal data. The key-authed
  `/api/v1` and MCP surfaces emit **metadata only** (structure, lifecycle, counts)
  — never message text, filenames, or storage URLs. Content access is a separate,
  admin-only permission that is never on a routine diagnostic path.
- **Credentials stay where they belong.** Gateway tokens and device identities
  live only in the bridge process. Convex and the browser never see them.
- **Environment-driven, forkable.** No hard-coded hosts; everything is env/config.
  An enterprise fills in env vars and deploys; a hobbyist runs Docker Compose.

## Current priorities

Reliability and continuity first: deterministic test coverage of the streaming /
recovery / compatibility paths, and a high-confidence process for supporting a new
gateway version (OpenClaw today, Hermes next). Then: deployment ergonomics,
observability, and UX polish.

## Non-goals (for now)

- **Not a gateway or agent runtime.** Atrium never runs the model — you bring your
  own agent gateway. Provider specifics stay inside the bridge normalizer.
- **Not adversarial multi-tenant isolation inside one deployment.** Each tenant gets
  its own Convex deployment (clean auth/secret isolation), not many tenants behind
  one shared backend.
- **Not a general-purpose chat platform.** The product is a focused chat surface
  for AI agent gateways, not a generic messaging app.

## What we will not merge (for now)

This is a roadmap guardrail, not a law of physics — but absent a strong case:

- Anything that lets chat **content** reach the diagnostic API / MCP surface.
- Coupling the **frontend** to raw vendor frames (it must read Convex only).
- Collapsing the **compat trust boundary** (the Convex normalizer must keep
  defending against an older/divergent bridge body).
- Baking provider-specific behavior **outside** the bridge normalizer.
- Committing operator secrets, generated artifacts, or work-tracking docs.
