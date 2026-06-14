# Contributing

Thanks for considering a contribution. Atrium aims to be a clean, forkable
foundation for chatting with AI agents over the web — OpenClaw today, Hermes next.

## Principles

- Keep gateway credentials in the bridge process only — never in a Convex table
  or the browser.
- The bridge ↔ Convex protocol is a contract: document protocol changes in
  [`docs/BRIDGE_PROTOCOL.md`](docs/BRIDGE_PROTOCOL.md) before relying on them.
- Add a regression test for every provider frame shape that caused a bug.
- The `/api/v1` and MCP surfaces stay **metadata-only** (no chat content).
- Prefer small, focused pull requests.

## Project layout

- `src/` — React + Vite front end (TypeScript, assistant-ui).
- `convex/` — Convex backend: schema, queries, mutations, HTTP routes. The
  committed `convex/_generated/` lets the front end type-check and build without
  a live backend.
- `bridge/` — Node/TypeScript bridge worker (its own `package.json` and tests).
- `mcp/` — MCP server for the observability API.
- `deploy/` — Docker Compose and Helm deployment (env-driven).
- `docs/` — architecture, protocol, configuration, and deployment docs.

## Setup

```bash
npm install
./dev.sh        # starts local Convex + Vite (see docs/DEVELOPMENT.md)
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full local workflow,
including the bridge.

## Local checks

There are **two** test suites — run the one(s) you touched, and both before a
non-trivial PR.

**App (front end + Convex), from the repo root:**

```bash
npm run typecheck   # paraglide compile + tsc --noEmit
npm test            # paraglide compile + i18n gates + vitest run
npm run build       # vite build
```

`npm test` runs the i18n gates automatically:

- **parity** (`scripts/i18n-check-parity.mjs`) — every message key present in
  the base locale must exist in every other locale (hard fail on a gap).
- **literal ratchet** (`scripts/i18n-check-literals.mjs`) — guards against new
  hard-coded accented UI strings that bypass the message catalog; the allowed
  count only ratchets down.

**Bridge, from `bridge/`:**

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run (normalizer, multiplex, media-fetcher, …)
npm run build
```

## Pull request checklist

- [ ] The change is documented where relevant (a `docs/` page, a code comment
      with durable rationale).
- [ ] Bridge protocol changes are reflected in `docs/BRIDGE_PROTOCOL.md`.
- [ ] New or changed UI strings go through the message catalog; the i18n gates
      pass.
- [ ] New provider frame shapes or contract changes are covered by tests.
- [ ] No secrets, no traces with sensitive content, and no server filesystem
      paths are committed.

## Commit style

Use clear, imperative commit messages, e.g.:

```text
Add signed media part support to the ingest endpoint
Document the bridge POST /reset route
Reject inbound attachments over the size cap
```

## Reporting bugs

Open an issue with:

- the gateway provider and version (e.g. OpenClaw 2026.6.5);
- the deployment mode;
- browser console errors, if any;
- a sanitized reproduction if available;
- expected vs. observed behavior.

Security-sensitive reports go through [SECURITY.md](SECURITY.md), not a public
issue.
