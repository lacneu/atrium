# Security Policy

## Supported Versions

This project is currently pre-`1.0`. Security fixes are accepted on the default
branch (`main`).

## Security Model

The system is designed around a few load-bearing boundaries:

- **Gateway credentials stay in the bridge.** Gateway tokens and device
  identities (OpenClaw today; Hermes planned) are read from the bridge process
  environment only — never stored in a Convex table, never sent to the browser.
- **Server-to-server secrets are environment-scoped.** The bridge ↔ Convex
  ingest secret and the Convex ↔ bridge shared secret live in the bridge env and
  the Convex deployment env respectively, and are constant-time compared.
- **Authentication is centralized.** Browser access goes through
  `@convex-dev/auth` (Google / Microsoft Entra OAuth), gated by an allowed
  email-domain list enforced server-side in Convex.
- **No server paths to the browser.** Outbound media is streamed into Convex
  storage and served from there; gateway filesystem paths are never exposed.
- **The diagnostic API never returns chat content.** The key-authed `/api/v1`
  surface and the MCP server expose metadata only (structure, lifecycle,
  counts), gated by service-account permissions; raw content is a distinct,
  admin-only permission never on the routine path. See the
  [compliance Trust Center](compliance/) for the control mapping.

## Trust Model & Scope

- **One deployment = one trusted tenant.** Each Convex deployment is a single
  organization's, with its own auth gate and secrets. Multi-tenant isolation
  *within* one deployment is not a goal — run a deployment per tenant.
- **The model is untrusted; the operator and host are trusted.** Security
  boundaries come from auth, RBAC, the metadata-only API projection, and where
  secrets live — not from prompt resilience. Admins are trusted by definition.
- **Usually NOT a vulnerability here:** prompt injection on its own; an authorized
  user seeing data of the deployment they belong to; an admin action; a setup that
  expects isolation between users of the *same* single-tenant deployment; secrets a
  deploying operator chose to expose. Cross-deployment data exposure, gateway
  credential/path leakage to the browser, or chat content reaching the metadata-only
  API ARE in scope.

## Sensitive Data — never commit

- OpenClaw gateway tokens.
- OpenClaw device identity private keys.
- Convex instance secrets, auth keys (`JWT_PRIVATE_KEY` / `JWKS`), or OAuth
  client secrets.
- The bridge ↔ Convex ingest / shared secrets.
- `.env` files of any kind.
- Frame captures or traces containing real prompts, answers, or media paths.

## Reporting a Vulnerability

Please do **not** open a public issue for vulnerabilities that involve
credentials, path disclosure, or cross-session data exposure.

Report privately to the project's security contact (set a `SECURITY_CONTACT` in
your fork, or use the repository's private vulnerability reporting / advisory
feature). Include:

- the affected version or commit;
- the deployment mode (Docker Compose, Helm, …);
- reproduction steps;
- expected impact;
- a suggested mitigation if you have one.

We aim to acknowledge reports promptly and to coordinate a fix and disclosure
timeline with the reporter.

## Hardening Checklist

- Set `AUTH_ALLOWED_EMAIL_DOMAINS` **before** anyone signs in (the first
  sign-in from an allowed domain becomes admin).
- Keep the Convex instance secret and auth keys private and backed up.
- Generate strong, unique bridge secrets (`openssl rand -hex 32`).
- Mount the gateway media directory **read-only** into the bridge.
- Do not expose the Convex dashboard publicly (bind it to localhost or a
  LAN-only proxy).
- Terminate TLS upstream (reverse proxy / ingress) and ensure WebSocket upgrade
  support for the bridge ↔ gateway connection.
- Scope service-account API keys to the least permission they need, and rotate
  any secret that may have leaked into logs.
