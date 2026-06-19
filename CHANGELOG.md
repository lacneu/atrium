# Changelog

All notable, user-facing changes are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow the lockstep repo
version shared by the frontend and bridge images.

> **Release-only.** This file is updated when cutting a release, not on every PR.
> Per-change detail belongs in the PR description / commit messages; a release
> aggregates them here.

## [0.4.0] — Sortable & filterable admin tables, a real Connexions table, and withdrawable feedback

Feature release. No breaking changes; no data migration. Everything here is additive
and builds on 0.3.x's multi-instance / shared-fs foundation — mostly workflow and
readability improvements across Settings, plus a user-facing feedback control.

- **Sort any admin table by its columns.** The shared admin tables (Users, Instances,
  Traces, Anomalies, Integrations, Service accounts, Groups, Feedbacks…) now have
  click-to-sort headers: click to sort ascending, again for descending, a third time to
  clear. Sorting is type-aware — numbers compare numerically, versions compare as
  versions (so `2026.6.10` sorts after `2026.6.5`, not before), and empty values always
  fall to the bottom in both directions.
- **The bridge "Connexions" list is now a real table you can sort and filter.** Each
  connection is a row with sortable columns (target, state, instance, gateway host,
  gateway version, stats, last OK), a free-text filter over target/host, quick filters by
  state / instance / gateway version, and a one-click reset. The error detail of a failing
  connection is preserved as a sub-row, and each connection now shows **its own gateway
  version** (the bridge reports it per instance). The section is collapsed by default.
- **Reach a bridge instance's configuration from where you manage it.** In **Settings ›
  Agents › Bridge** the compatibility list shows one row per instance with a `⋮` menu that
  opens that instance's non-secret config in a modal; the **Settings › Agents › Instances**
  tab gained a matching "Configure bridge" row action that opens the same modal — so you
  configure an instance's media modes, caps and rehydration from either place. (Bridge
  secrets remain environment-only, never editable in the UI.)
- **Withdraw a feedback report you filed.** From the notification bell you can now close
  one of your own reports, with an optional reason — it disappears from your "My reports"
  list and stops badging the bell, and a later admin reply won't bring it back. The report
  is kept for the admin, who sees it tagged "Closed by user" with your reason. The bell now
  also shows the reported message and can jump straight to it in the conversation.
- **Deployment.** Changes the frontend (all of the above) and the Convex backend (the new
  feedback fields + the "close my report" mutation, and the per-instance gateway version on
  bridge health) — redeploy the frontend and run `npx convex deploy`. The bridge image is
  functionally unchanged; only its `.env.example` and the Compose/Helm docs were tidied —
  the per-instance media knobs introduced in 0.3.0 now live solely in Settings, so they
  were dropped from the example bridge environment (an env value still works as a fallback).

## [0.3.1] — Safer shared-fs setup: verify before save, clearer media mounts

Fix and operability release. No breaking changes; no data migration. Follows up on
0.3.0's shared-fs media with a safer Bridge config flow and much clearer deployment
docs (a single mount misconfiguration was easy to hit).

- **Verify shared-fs paths BEFORE saving.** The Bridge config editor's "verify paths"
  button now checks the media modes you've selected **in the form** — not the
  last-saved config — so you confirm the bridge can actually reach its shared
  directories before committing the change. Previously the check only ran against the
  saved config, so you had to save first and could persist a non-functional setup.
- **Clearer shared-fs media deployment (the most common misconfig).** A bridge's
  `OPENCLAW_MEDIA_OUTBOUND_DIR` is the **bridge's OWN** mount of the shared volume, not
  the gateway container's path — the two run in separate containers. Pointing it at the
  gateway path makes the bridge report `ENOENT` and silently drop every generated file.
  The `.env.example`, Compose, and Helm now spell this out, add
  `OPENCLAW_MEDIA_OUTBOUND_AGENT_MOUNT` (the agent's *write* view of the same volume)
  and the inbound shared-fs mount, and a new troubleshooting section walks through the
  `ENOENT` fix and the "not applicable (not shared-fs)" result.
- **Deployment.** Changes the Convex backend and the frontend (the verify-paths fix) —
  redeploy both and run `npx convex deploy`; the bridge image is functionally unchanged.
  Shared-fs media gains an optional `OPENCLAW_MEDIA_OUTBOUND_AGENT_MOUNT` (defaults to
  the gateway path); see the updated `deploy/` docs for the inbound/outbound mounts.

## [0.3.0] — Multi-instance gateways, large media over a shared filesystem, and reliable file delivery

Feature release. No breaking changes; no data migration. The single-gateway setup
keeps working unchanged — multi-instance, shared-fs media, and the new bridge
environment are all additive and opt-in (see Deployment).

- **Run several gateways, each on its own bridge.** Atrium can now route each chat to
  its instance's own bridge endpoint (Model M: one bridge per gateway), so adding a
  second OpenClaw — or an OpenClaw and a Hermes — no longer means one shared bridge.
  Each instance carries its own non-secret configuration (media mode, size caps,
  history rehydration, shared-fs paths) editable from **Settings › Agents › Bridge**
  and applied on the next turn **without restarting the bridge**. Bridge health is now
  reported per instance — one gateway being down no longer hides the others — and the
  Bridge tab is organized by provider. (A bridge's secrets — tokens, device identity,
  shared secrets — remain environment-only and are never editable in the UI.)
- **Send and receive large media (video, audio, big documents) over a shared
  filesystem.** In `shared-fs` mode the bridge streams a file by *reference* instead of
  inlining it, so attachments are no longer bounded by the ~25–32 MiB websocket/body
  limits: an inbound file is streamed to a mounted directory and its path is handed to
  the agent to read, and a file the agent produces is streamed back to storage. Vision
  images still ride inline (model-native). The default transport is unchanged.
- **Generated files reliably become a download.** When an agent produces a file, in
  `shared-fs` mode the bridge hosts it at the end of the turn from the shared outbound
  directory **whether or not the model emitted a `MEDIA:` line** — removing the most
  common reason a deliverable failed to appear. In `gateway-http` mode the `MEDIA:`
  directive now handles filenames **with spaces**, and an agent that writes a Markdown
  link to a local path no longer renders a link that opens the app home — non-URL
  references render as plain text. A misconfigured outbound directory now surfaces a
  warning instead of silently dropping every file.
- **Attachment size limits are enforced honestly.** The inbound attachment cap is
  derived from the gateway's actual frame limit and enforced consistently at the
  composer, in Convex, and at the bridge: a too-large file gets a clear "too large"
  message instead of being silently dropped or killing the gateway connection.
- **Per-chart brand logo.** The active chart now drives the top-bar logo and label, so
  a custom chart can show its own mark instead of the bundled Atrium one (uploaded
  logos are served as images only — no path or markup is exposed).
- **Path checks and field help for shared-fs.** The Bridge config editor gained a
  "verify paths" action that round-trips the bridge's own read/write access to the
  shared directories, plus a help tooltip on every field.
- **Multi-instance correctness hardening (review pass).** A per-instance config with
  unset fields no longer overrides a bridge's own environment defaults on every send;
  the env `BRIDGE_URL` fallback is scoped so a chat is never posted to a different
  instance's gateway; and a per-chat policy lookup is owner-scoped (no cross-user
  information).
- **Deployment.** Changes the Convex backend, the frontend, and the bridge image —
  redeploy all three together and run `npx convex deploy`. A new admin-only permission
  `bridge.config.write` gates the per-instance config editor. Multi-instance routing is
  opt-in: set `bridgeUrl` per instance (otherwise the single `BRIDGE_URL` env is used as
  before). Shared-fs media is opt-in: mount a shared directory into both the bridge and
  the gateway and set the bridge's inbound/outbound directory + agent-mount environment
  (`OPENCLAW_INBOUND_DIR`, `OPENCLAW_INBOUND_AGENT_MOUNT`,
  `OPENCLAW_MEDIA_OUTBOUND_AGENT_MOUNT`, `OPENCLAW_INBOUND_TTL_MS`) — point
  `OPENCLAW_MEDIA_OUTBOUND_DIR` at the bridge's OWN mount of the shared volume, not the
  gateway's container path. No data migration.

## [0.2.0] — Trace enrichment, a self-correction loop, and group management

Feature + reliability release. No breaking changes; no data migration. Trace
enrichment adds optional environment for the Opik/Langfuse integrations (see
Deployment).

- **See what an agent actually did — trace enrichment from Opik & Langfuse.** Atrium
  can now pull the *structure* of a turn's trace (span names, types, lifecycle,
  timing, the parent tree) back from a configured Opik or Langfuse and show it
  alongside its own traces — so an operator, or an agent debugging a report, sees the
  real message structure behind an anomaly. It is SOC2-safe by construction: it
  requests structure-only field groups and projects to an explicit allowlist, so no
  message text, input/output, or metadata is ever fetched. The new `get_integrations`
  reports which vendors are configured (never the keys), and `get_trace_enrichment`
  returns the structure for a turn.
- **A self-correction loop for stuck conversations.** A new `diagnose_chat` classifies
  a chat (healthy / stuck stream / dispatch error / attachment problem / bridge
  unavailable) with a suggested action, and `reconcile_chat` is the bounded
  corrective: it flips a hung "streaming" message to an error while preserving its
  text, releasing a UI that was stuck "thinking". Reconcile is gated behind a new,
  service-account-only `selfheal` permission (grantable in Settings › Roles) and is
  audited.
- **Generated-but-undelivered media is now visible.** When an agent generates an image
  natively but doesn't deliver it (no `MEDIA:`/`mediaUrls` directive), the turn used
  to finish with the image silently missing. Atrium now records a content-free
  diagnostic so the gap — the agent's missing delivery directive — is detectable
  instead of invisible. Delivering a file the documented way (write to the outbound
  dir, emit `MEDIA:`) is unchanged and works.
- **Clearer attachment and dispatch errors.** A failed send now carries a stable error
  code, and an attachment the gateway refuses for size or content shows a specific
  "file too large" / "attachment rejected" message with a hint, instead of a generic
  "an error occurred".
- **Group management — assign members and agents in bulk.** The Groups admin gained a
  Manage dialog to add or remove members and agents in bulk, with search, pagination,
  and select-all.
- **Bridge reliability hardening.** Building on 0.1.6's self-heal: one agent's error no
  longer makes *every* chat read-only (availability degrades rather than blocks, and
  recovers on its own); idle gateway sockets are reaped so a long-lived bridge can't
  exhaust file descriptors; each message's writes are isolated so one slow write can't
  wedge the others; every Convex write is bounded by a timeout; and streaming buffers
  are capped so a backpressured turn can't run the bridge out of memory.
- **Perceived performance.** The composer shows an immediate "sending…" state and a
  "this is taking longer than usual" hint on a slow turn.
- **Deployment.** Changes the Convex backend, the frontend, and the bridge image —
  redeploy all three together and run `npx convex deploy`. Trace enrichment is opt-in:
  set the vendor keys in the Convex environment (`LANGFUSE_PUBLIC_KEY` /
  `LANGFUSE_SECRET_KEY`, `OPIK_API_KEY` / `OPIK_WORKSPACE`) and, to read OpenClaw's own
  traces, `OPIK_OPENCLAW_PROJECT`; the compose env-push script now carries them. No
  data migration.

## [0.1.6] — Per-domain branding and a self-healing bridge

Feature + reliability release. No breaking changes; no data migration.

- **Brand each hostname with its own chart — sign-in screen included.** An admin can
  now map a domain (an exact `chat.acme.com` or a wildcard `*.acme.com`) to any public
  chart from Settings › Appearance. Atrium then applies that chart as the default on
  that host *before* sign-in, so a multi-domain self-host shows the right palette and
  logo on the login screen, not just after authentication. A signed-in user's own
  chart — and any chart shared through their groups — still takes precedence over the
  domain default.
- **Per-chart logo and name in the top bar.** The active chart now drives the top-bar
  brand: the bundled Atrium mark by default, or a custom name and uploaded logo
  (separate light/dark variants) for a custom chart. Logos are uploaded from
  Settings › Appearance › My charts; the server validates the image and stores it
  itself (PNG or WebP), then serves it as a plain image URL — the browser never hands
  the server a storage handle to delete.
- **The bridge survives a single error — no restart needed.** A process-level safety
  net stops one unhandled error from taking the whole bridge down, and the streaming
  loop now self-heals: if its connection machinery throws, the bridge closes and
  reconnects on the next message and finalizes any in-flight turn as aborted, instead
  of leaving that message stuck "thinking" forever. It also fails fast on boot if it
  cannot bind its port, rather than coming up half-started.
- **Deployment.** This release changes the Convex backend, the frontend, and the
  bridge image; redeploy all three together — the per-domain default couples the
  Convex backend and the frontend. No new environment variables and no data
  migration: domain mappings simply start empty.

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
