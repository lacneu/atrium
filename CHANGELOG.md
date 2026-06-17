# Changelog

All notable, user-facing changes are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow the lockstep repo
version shared by the frontend and bridge images.

> **Release-only.** This file is updated when cutting a release, not on every PR.
> Per-change detail belongs in the PR description / commit messages; a release
> aggregates them here.

## [0.1.5] — Sending a file no longer fails after a session roll

Corrective release (hotfix). No breaking changes; no migration.

- **Attaching a file no longer breaks the chat after a gateway/session roll.** When
  the OpenClaw session was fresh — e.g. right after a bridge restart or redeploy —
  the bridge re-sent the conversation's prior turns for context; on a turn that ALSO
  carried an attachment, that combination crashed the gateway and surfaced as "the
  chat service is momentarily unavailable (ref. bridge)". The bridge now skips that
  re-hydration on attachment turns, so file conversions and uploads go through.
  Text-only turns are unchanged and still receive the prior context.
- **New `OPENCLAW_REHYDRATION` operator kill-switch.** Set it to `off` (Compose
  `.env` or the Helm chart values) to disable session re-hydration entirely; the
  default keeps it on. Only the bridge image changes in this release — no Convex or
  frontend redeploy needed.

## [0.1.4] — File management and a refreshed sign-in

UX release. No breaking changes; no migration.

- **Outbound file links now open correctly.** A file produced by the agent opens in
  a NEW browser tab and is served with its real content type (PDFs and images render
  inline) instead of replacing the current page — a cross-origin quirk previously
  navigated the whole conversation away to the file.
- **Manage your files from Settings › Files.** Each file row now has an actions menu
  (⋮) to **download** it or **remove** it from your list — a soft delete that leaves
  the conversation where the file was exchanged untouched. A **Reset** button (top
  right of the filters) clears the active filters when any is set.
- **Refreshed sign-in screen.** A branded sign-in card with the Atrium logo and
  clearer Google / Microsoft sign-in buttons.

## [0.1.3] — Outbound files reach the chat without a shared filesystem

Corrective + capability release. Fixes agent-generated files not appearing in the
web chat. No breaking changes for new deployments; co-located shared-filesystem
setups need a one-line opt-in (below).

- **Agent-generated files now reach the chat by default — no shared filesystem.**
  The bridge fetches outbound attachments (PDFs, exports, generated documents) over
  HTTP from the gateway's `assistant-media` endpoint, so Atrium and your OpenClaw
  gateway can run on different hosts. Previously the only path was a read-only mount
  of the gateway's media directory, which silently dropped files whenever the two
  were not co-located — the production symptom this release fixes.
- **Configurable outbound-media transport (`OPENCLAW_MEDIA_MODE`).** Choose
  `gateway-http` (default, no shared disk), `shared-fs` (opt-in mount, for a
  co-located gateway), or `off`. New `OPENCLAW_GATEWAY_HTTP_URL` override (when the
  gateway's HTTP endpoint is on a different host/port) and an
  `OPENCLAW_MEDIA_FETCH_TIMEOUT_MS` connection timeout so an unresponsive gateway can
  never stall a turn. Against a gateway with no media route (pre-6.x), the bridge now
  logs a clear "switch to `shared-fs`" hint instead of failing silently.
- **Outbound-media diagnostics.** A new `openclaw.media` observability trace records
  each attachment's lifecycle — received / stored / dropped, with a structural reason
  — using codes and size buckets only, never a filename, path, or file content, so
  operators can tell *why* a file did not attach without exposing data.
- **Ambient visual effects (prototype, on by default).** Subtle, theme-tinted glows
  behind the conversation, on primary buttons, and on the sign-in screen, recolored
  from the active graphic chart. Turn them off with
  `localStorage.setItem("oc.ambiance", "off")` + reload; a proper per-user toggle
  lands once the look is finalized.
- **Self-hoster migration.** If your gateway shares a filesystem with Atrium and you
  relied on the media mount, set `OPENCLAW_MEDIA_MODE=shared-fs` (Helm:
  `bridge.media.enabled=true` sets it for you) and keep the read-only mount; the
  Compose mount is now opt-in. Everyone else needs no action — `gateway-http` is the
  default. Release notes are now curated from this changelog (see `RELEASE.md`).

## [0.1.2] — Sidebar bound, deployment hardening, automated releases

Reliability and operability release. No breaking changes; no API changes.

- **Sidebar loads reliably on large accounts.** The chat list now reads a bounded
  most-recent window (plus all pinned chats, any age) instead of every chat — fixing
  the "too many system operations" failure observed in production on heavy accounts.
  Archived chats can no longer crowd active chats out of the window.
- **Deployment hardening.** New `deploy/TROUBLESHOOTING.md` (the real first-bring-up
  footguns), a `convex-env-push.sh` helper that pushes the Convex *deployment* env,
  an auth-key generation utility (`generate-auth-keys.mjs`), and a clearer Compose
  `.env.example` / bootstrap.
- **Automated, tag-driven releases.** Pushing a `vX.Y.Z` tag now publishes
  `@lacneu/atrium` to npm (with provenance) + both Docker images, stamps the lockstep
  version across all artifacts, and creates the GitHub Release from this file — see
  `RELEASE.md`. GitHub Actions bumped off the deprecated Node 20 runtime.

## [0.1.1] — npm packaging fix

The `0.1.0` npm publish (a manual bootstrap of a brand-new scope) shipped without
the built `dist/` bundle. This release publishes `@lacneu/atrium` correctly — the
static `dist/` is included — via the automated, OIDC-based pipeline. No
application or Docker image changes: the `ghcr.io/lacneu/atrium` and
`atrium-bridge` images were already correct in `0.1.0`.

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
