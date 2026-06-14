# Trust Center — Atrium

This directory documents the security and compliance posture of the OpenClaw
Webchat software product. It is aimed at organizations evaluating the product as
a platform for deploying conversational AI, and at SOC 2 auditors reviewing the
Deploying Organization's controls.

> **Important distinction:** This document describes *product capabilities* — the
> controls built into the software. Achieving a SOC 2 report is the
> **Deploying Organization's** responsibility. See `SHARED_RESPONSIBILITY.md` for
> the boundary.

---

## What SOC 2 Trust Services Criteria Does the Product Address?

Atrium is scoped to three Trust Services Criteria:

| Criterion | Product support |
|---|---|
| **Security (Common Criteria CC1–CC9)** | Strong technical controls: authentication, RBAC, API key management, rate limiting, audit logging, anomaly detection, change management. Organizational controls (CC1–CC3) are the Deploying Organization's responsibility. |
| **Availability (A1)** | Healthchecks, restart policies, and a stuck-stream watchdog are built in. Backup/restore and BC/DR are the operator's responsibility. |
| **Confidentiality (C1)** | Conversation content is never exposed via the observability API. Access log and trace data are metadata only. Right-to-erasure is implemented. |

Processing Integrity (PI) and Privacy (P) criteria are applicable depending on
how the Deploying Organization uses the platform; the product provides the
mechanics (deletion, PHI boundary), but the policies are the operator's.

---

## Implemented Controls — Summary

### Identity and Authentication (CC6.1)

- **OAuth-only sign-in** via Google and/or Microsoft Entra (`@convex-dev/auth`).
  Password-based auth is not supported by the product.
- **Email-domain restriction** — the operator sets `AUTH_ALLOWED_EMAIL_DOMAINS`
  to allow only authorized email domains. The gate is authoritative server-side
  in `convex/lib/access.ts:ensureProfile`.
- **Pending-by-default** — every new user starts blocked until an admin approves.
  The bootstrap serializes the first admin via OCC on the `appMeta` singleton.
- **Service account API keys** — Bearer tokens; SHA-256 hash stored at rest;
  plaintext shown exactly once at minting; disabled/expired keys rejected with
  401. Source: `convex/apiKeys.ts`, `convex/lib/apiAuth.ts`.

### Role-Based Access Control (CC6.3)

- **Closed permission set** — defined in `convex/lib/rbac.ts:PERMISSIONS`; every
  check is type-checked against the union.
- **Built-in roles:**
  - `pending` — no access
  - `user` — chat access (`chats.read`)
  - `admin` — full access (wildcard, protected server-side)
  - `observer` (service account) — read-only observability
  - `agent` (service account) — observer + anomaly reporting
- **Service accounts cannot hold human-only roles** — `pending`, `user`, and
  `admin` role keys are blocked for service accounts. Source: `convex/apiKeys.ts`.
- **Content separately gated** — raw conversation content requires
  `traces.read.content`, which is not granted to any built-in service account
  role.

### API Security — No PHI in Observability Responses (Confidentiality)

The `/api/v1` observability API is a **positive-allowlist serializer**: it emits
structure and lifecycle metadata only — never message text, filenames, storage
URLs, reasoning output, or provenance sources.

Neutralizations at the boundary:
- `messages.error` → stable code via `normalizeMessageErrorCode`
- `textLen` → coarse bucket via `textLenBucket`
- `mimeType` → base type via `mimeTypeBase` (filename stripped)

A sentinel test (`convex/chatState.test.ts`) seeds unique values in every content
field and asserts none appear in the serialized response. Source: `convex/messages.ts`,
`convex/lib/chatRenderState.ts`.

Full design rationale: `API_CONTROLS.md`.

### Rate Limiting (CC6.6)

- **Authenticated:** per-key fixed window (default 120 req/min), enforced inside
  `authenticateApiKey` covering every route uniformly.
- **Unauthenticated:** 16-shard pre-auth limiter before the hash lookup, bounding
  OCC contention and cardinality on credential-flood attacks. Source:
  `convex/apiRateLimit.ts`.

### Audit and Access Logging (CC7.2, CC7.3)

- **`auditLog`** — append-only (insert-only, no deletes, never purged) — records:
  user.delete, role changes, impersonation start/stop, service account create/
  update/delete, API key mint/revoke, role create/update.
- **`accessLog`** — 90-day retention — records every authenticated API call:
  principal, role, route, status, latency, chatId; no content.
- Both are Convex-internal (not user-deletable). Source: `convex/lib/audit.ts`,
  `convex/observability.ts`.

### Anomaly Detection (CC7.1)

A cron runs every 5 minutes and raises admin notifications on:
- API error ratio above threshold (with minimum call floor)
- OpenClaw dispatch failures
- Access scan: any key reading > 25 distinct chats in the window
- Stream error rate (stuck streaming messages)

Source: `convex/anomalies.ts`.

### Response Security Headers (CC6.7)

Every `/api/v1` response carries `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. Source: `convex/http.ts:apiJson`.

### Change Management (CC8)

The CI pipeline (`.github/workflows/ci.yml`, `.github/workflows/build-and-push.yml`)
enforces before any image is pushed:
- TypeScript typecheck (enforces front↔backend contract via committed `convex/_generated`)
- Application build
- App test suite (Vitest, includes i18n parity + SOC2 no-content sentinel)
- Bridge test suite (Vitest)

Images are lockstep-versioned: app and bridge share a version tag on release.

### Availability Controls (A1)

- Docker Compose: `restart: unless-stopped` on all services; Docker `healthcheck`
  on Convex and bridge containers.
- Helm: `readinessProbe` + `livenessProbe` on the Convex StatefulSet and
  frontend Deployment.
- Stuck-stream reconcile cron: messages stuck in `streaming` for > 12 minutes
  are transitioned to a recoverable error state.

---

## Honest Gaps — What the Product Does NOT Provide

The following are not implemented in the current software. Deploying Organizations
that require these must implement them as operator controls:

- **Formal penetration test** — not conducted; operator must commission.
- **Automated SCA / dependency vulnerability scanning** — not in the CI pipeline.
- **Human session invalidation endpoint** — revoking a human's active WebSocket
  sessions requires restarting Convex or waiting for session expiry; the product
  does not expose a `POST /logout-all` equivalent.
- **Backup automation** — `convex export` exists; scheduling and testing are
  the operator's responsibility.
- **BC/DR runbook** — no tested runbook; operator must create and test one.
- **Vendor assessment tooling** — no sub-processor inventory or DPA template.
- **Organizational controls (CC1–CC4)** — governance, risk register, HR program,
  training, formal communications — all operator responsibility.

---

## Further Reading

- `CONTROL_MAPPING.md` — detailed criterion-to-control mapping table
- `SHARED_RESPONSIBILITY.md` — what the software provides vs. what the operator must do
- `API_CONTROLS.md` — deep technical rationale for the `/api/v1` controls
