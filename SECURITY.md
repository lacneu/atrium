# Security Policy

## Supported Versions

Atrium is pre-`1.0`. Security fixes land on the default branch (`main`).

## Reporting a Vulnerability

Please do **not** open a public issue for vulnerabilities involving credentials,
path disclosure, or cross-session data exposure. Report privately through the
repository's private vulnerability reporting / security advisory (or a
`SECURITY_CONTACT` set in your fork). Include:

- the affected version or commit;
- the deployment mode (Docker Compose, Helm, …);
- reproduction steps and expected impact;
- a suggested mitigation, if you have one.

We aim to acknowledge reports promptly and to coordinate a fix and disclosure
timeline with the reporter.

## Scope

One Convex deployment = one trusted tenant; the operator and host are trusted, the
model is not.

- **In scope:** cross-deployment data exposure; gateway credential or filesystem
  path leakage to the browser; conversation content reaching the metadata-only
  diagnostic API.
- **Usually not:** prompt injection on its own; an authorized user seeing their own
  deployment's data; an admin action; secrets an operator chose to expose.

## Security model (summary)

- **Conversations are confidential.** A user's messages, attachments, and retrieved
  sources are owner-scoped; every diagnostic and tracing tool (`/api/v1`, the MCP
  server, traces, anomalies) carries metadata only — never content. This is the
  SOC2 Confidentiality (C1) boundary.
- **Gateway credentials never reach the browser** — held in the bridge environment,
  or AES-256-GCM-encrypted at rest in Convex and fetched by the bridge over an
  authenticated, per-bridge channel.
- **Authentication is centralized** (OAuth + a server-side allowed-domain gate);
  server-to-server and API-key secrets are environment-scoped and hashed at rest.
- **No server paths to the browser** — outbound media is streamed via Convex storage.

The full control mapping (SOC2 Trust Services Criteria), the encryption design, and
the shared-responsibility split are in the **[compliance Trust Center](compliance/)**.

## Sensitive data — never commit

Gateway tokens and device-identity keys; `ATRIUM_SECRET_KEY` (the secret-encryption
master key); Convex auth keys (`JWT_PRIVATE_KEY` / `JWKS`) and instance secrets;
OAuth client secrets; the bridge ingest / shared / per-bridge secrets; any `.env`
file; and frame captures or traces containing real prompts, answers, or media paths.

## Hardening

Deployment hardening — domain gate, secret generation and backup, read-only media
mount, TLS termination, dashboard exposure, and API-key scoping/rotation — is in the
**[deployment guide's Hardening checklist](deploy/README.md#hardening)**.
