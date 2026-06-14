# Changelog

All notable, user-facing changes are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow the lockstep repo
version shared by the frontend and bridge images.

> **Release-only.** This file is updated when cutting a release, not on every PR.
> Per-change detail belongs in the PR description / commit messages; a release
> aggregates them here.

## [0.1.0] — Initial public release

First public, self-hostable release of Atrium: a multi-user web chat UI for AI
agent gateways. OpenClaw is the first supported provider (Hermes is next).

- React + Vite frontend (assistant-ui) backed by a self-hosted Convex deployment.
- Node/TypeScript bridge: operator WebSocket to an OpenClaw gateway, version-aware
  frame normalization into a stable streaming contract, validated against OpenClaw
  2026.5.19 / 2026.6.1 / 2026.6.5.
- Google / Microsoft Entra sign-in (`@convex-dev/auth`), email-domain gated;
  first sign-in from an allowed domain becomes admin.
- Multi-user / multi-agent / multi-instance routing.
- Bidirectional file exchange (inbound attachments, outbound generated media via
  Convex storage — no server paths exposed).
- Metadata-only observability: key-authed `/api/v1` + an MCP server (traces, KPIs,
  anomalies, diagnostics), never chat content.
- Full internationalization (French default, English) via Paraglide JS.
- Deployment: Docker Compose and Helm, fully environment-driven (`deploy/`).
