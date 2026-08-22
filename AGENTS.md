# AGENTS.md — working on Atrium

Guidance for AI coding agents (and humans) working in this repository. Read this
before making changes; read the per-area notes below before touching an area.

## Ground rules

- **Never commit, push, or amend.** The maintainer owns all git history. Make the
  change in the working tree and stop; do not run `git commit`/`push`/`amend`.
- **Verify, don't assume.** Inspect the actual code/types before claiming a fact;
  run the gates (below) before saying something is done. A passing self-written
  test is not proof a behavior is correct — check what it actually asserts.
- **Smallest change that solves the problem.** Match the surrounding style; don't
  reformat unrelated code. Comments carry durable rationale (edge cases, security,
  perf), not narration.
- **No work-tracking docs in this repo.** `docs/` and `compliance/` are for users
  and contributors. Plans, decision logs, retros, per-lot notes, gap registries,
  dated bench records and "what we built" write-ups belong in the maintainer's
  private notes, never here — whatever their subject and however useful they are
  to the person writing them.

  **One exception, and it is not a document.** `bridge/protocol/contrib/registry.json`
  is the upstream-contribution ledger: every issue/PR Atrium opens against a
  provider (OpenClaw, Hermes), its state, and the frames it is tied to. It stays
  because it is *machine-readable state that code consumes* — validated by a
  bridge test, synchronized via `gh` (see `.claude/skills/upstream-contrib/`) —
  not prose about the work. Public upstream URLs only; never client data, tokens,
  or conversational content.

  A registry kept outside the repo does drift, and that argument once earned the
  1.0.0 gap registry a place here. It was answered the wrong way. The registry
  drifted anyway — the private copy and the in-repo copy diverged for a month
  before anyone compared them — because there were *two*, not because one was
  outside. There is now one, in the private notes. Design and protocol
  specifications that code cites live in `docs/` under their own names
  (`PROTOCOL_CONTRACT.md`, `UPSTREAM_INTERPRETATION.md`, …), where a contributor
  can find them; if a document only makes sense to someone tracking the work, it
  is a work document, and it goes to the notes.

## Map

| Path | What it is |
|------|------------|
| `src/` | React + Vite front end (TypeScript, built on assistant-ui). Never parses raw gateway frames — it subscribes to Convex. |
| `convex/` | Self-hosted Convex backend: schema, queries, mutations, actions, HTTP routes (`/api/v1`, `/bridge/ingest`), auth, crons. `convex/_generated/` is committed on purpose. |
| `bridge/` | Standalone Node/TypeScript package: holds the connection to an agent gateway (OpenClaw, or Hermes over its WebSocket or REST transport), normalizes the version-specific event stream, relays turns to/from Convex. One adapter per provider under `bridge/src/providers/`. Its own `package.json` + tests. |
| `mcp/` | MCP server exposing the metadata-only observability API to agents/CLIs. |
| `deploy/` | The deployment artifacts: `compose/` (Docker Compose + `bootstrap-env.sh`) and `helm/` (the chart). `deploy/README.md` holds what applies to every method — pre-flight, gotchas, hardening, media, image versioning. **The ordered procedures live in `docs/installation/`, one per method.** |
| `docs/` | User/contributor documentation only: install, configuration, architecture, and the protocol/design specifications the code cites by name. No work tracking — see the rule above. |
| `messages/` + `project.inlang/` | i18n source (Paraglide). Compiled to the git-ignored `src/paraglide/`. |
| `.github/` | CI (`build-and-push.yml`, `ci.yml`), issue/PR templates. |
| `.claude/skills/` | Repo-owned, hand-authored process skills (checked in; installable `convex-*` skills stay git-ignored). `frame-discovery` instructs one protocol frame end to end; `upstream-contrib` gates and tracks contributions to the providers; `release-notes` drafts the CHANGELOG entry. Process definitions, not work-tracking docs. |

## Commands

Node 24, npm. From the repo root unless noted.

- `npm run typecheck` — Paraglide compile + `tsc --noEmit`.
- `npm test` — Paraglide compile + **i18n gates** (`i18n:check`) + Vitest (front + convex).
- `npm run build` — `vite build` (the published frontend image).
- Bridge (its own package): `cd bridge && npm test` and `npx tsc --noEmit -p tsconfig.json`.
- Local dev stack: `bash dev.sh` (self-hosted Convex on :3212 + Vite on :5174).

The full gate before declaring done: app `typecheck` + `test`, bridge `tsc` + `test`.

## Architecture invariants

- **Three tiers, one data spine.** Browser → Convex (reactive, owns chats/auth/
  routing/observability) → Bridge (per-provider adapter) → external agent gateway
  (OpenClaw or Hermes). The front end is fed by Convex only; it never sees vendor
  frames.
- **Capability-driven UI, honest manifests.** Each provider (and Hermes transport)
  declares ONLY the capabilities the bridge actually implements
  (`bridge/src/compat.ts`), so a control a gateway lacks is auto-hidden rather than
  broken. Do not add a capability to a manifest the bridge does not back — the
  manifest is a promise the UI trusts. Hermes deliberately exposes a small surface;
  its REST transport carries even less than its WS transport (see below).
- **Compat is a trust boundary, not just data.** `convex/lib/compat.ts` is a
  network-input normalizer (fail-closed) that deliberately MIRRORS the bridge's
  capability table. Do not collapse the two — the Convex side must defend against
  an older/divergent bridge body. Share the pure capability→minVersion *table*, not
  the normalizer.
- **Gateway credentials are secret and encrypted at rest** — entered per instance
  in the admin UI, stored AES-256-GCM-encrypted in Convex (`instanceSecrets`,
  keyed by a master key that lives only in env), fetched by the bridge over its
  per-bridge secret. They are never in a plaintext table and never in the browser.
  The diagnostic `/api/v1` + MCP surfaces are **metadata-only**
  (structure/lifecycle/counts), gated by service-account permissions; chat content
  is a separate admin-only permission never on the routine path.
- **Streaming has a stable contract** (deltas, snapshot, finalize, run.status, tool
  status, media) the bridge normalizer produces from version-specific frames. Keep
  the normalizer the only vendor-coupled layer.

## Code style

- TypeScript strict; prefer discriminated unions + early returns; avoid `any`.
- **No inline imports** — all `import`/`from … import` at the top of the file
  (rare exceptions: circular-dep breaking, optional deps, justified lazy-load).
- **Convex: read `convex/_generated/ai/guidelines.md` FIRST** — its rules override
  general training-data assumptions about Convex APIs/patterns.

## Tests & the live-vs-unit philosophy

- Vitest, colocated (`src/`, `convex/`) or in `bridge/test/`. Assert behavior, not
  implementation; prefer narrow injection over broad mocks.
- **i18n gates (wired into `npm test`, hard-fail):** message-key parity across
  locales + an accented-literal ratchet (catches untranslated hard-coded strings).
- **Live local tests are EXPENSIVE** — they call real agents on a real OpenClaw
  gateway and consume model/Codex tokens. Use them ONLY to: (1) capture an exact
  message/frame FORMAT once, (2) debug a behavior you can't reproduce in a unit
  test, or (3) prepare support for a new OpenClaw/Hermes version. **Once a format is
  observed live, BAKE IT INTO A FIXTURE and assert it with deterministic unit
  tests** (`bridge/test/fixtures/openclaw_frames.json` + the normalizer/run-manager
  suites). Maximize deterministic coverage; minimize live-token spend.
- The bench (`bridge/local-openclaw/`) is the local OpenClaw harness; its
  `test-live-protocol.mjs` is the per-version live regression (operator RPCs only —
  no LLM tokens). Run it to validate a new gateway version, then mock the deltas.

## Versions & compatibility (the reliability bar)

Supporting a new OpenClaw/Hermes version must reach ~99% deterministic confidence
in continuity. The process: capture the new version's frame shapes LIVE → add them
to the fixtures → cover them with unit tests → update the capability manifest
(`bridge/src/compat.ts` `COMPAT_MANIFEST`, mirrored in `convex/lib/compat.ts`).
The frontend is capability-driven, so a missing/older capability degrades the UI
gracefully rather than breaking it.

## Git, security, docs

- Git: never commit/push/amend (the maintainer does). Imperative, concise English
  messages when proposing one.
- Security: never commit secrets/tokens/keys/`.env`; see [SECURITY.md](SECURITY.md).
- Docs: user/contributor docs go in `docs/`; the SOC 2 product story in
  `compliance/`. Work-tracking does NOT belong in this repo (two named
  exceptions — see Ground rules).

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
