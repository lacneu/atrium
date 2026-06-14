# Shared Responsibility Model — Atrium

Atrium is **self-hosted software**. The security of a deployment
therefore depends on two distinct layers:

1. **The software product** — controls built into the application code, verified
   by the CI pipeline and test suite.
2. **The Deploying Organization** — controls that must be implemented by the
   organization running the product in their infrastructure.

A SOC 2 report covers the **Deploying Organization's system**, which includes
both layers. The product controls are evidence; the organizational controls are
the Deploying Organization's work.

---

## What the Software Provides

| Domain | What is built in |
|---|---|
| **Authentication** | OAuth-only sign-in (Google + Microsoft Entra) via `@convex-dev/auth`; email-domain restriction (authoritative server-side gate); pending-by-default for new users; first-admin OCC bootstrap |
| **API key management** | SHA-256 hash at rest; plaintext exposed once; disabled/expired keys rejected; admin-gated minting and revocation; audit on every lifecycle event |
| **RBAC** | Closed permission set; built-in roles (`pending`/`user`/`admin` for humans; `observer`/`agent` for service accounts); service accounts cannot hold human-only roles; admin wildcard protected |
| **API PHI boundary** | Positive-allowlist serializer: no message text, filenames, URLs, or reasoning in any `/api/v1` response; sentinel test proves it |
| **Rate limiting** | Per-key (120 req/min) + unauthenticated 16-shard pre-auth limiter |
| **Audit logging** | Append-only `auditLog` (indefinite retention) for privileged actions; 90-day `accessLog` for every authenticated API call |
| **Anomaly detection** | 5-minute cron: API error ratio, dispatch failures, cross-chat access scan, stream errors (stuck messages), ingest denied; admin notifications |
| **Response security headers** | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` on every `/api/v1` response |
| **Change management** | CI gates (typecheck + build + tests) before any image push; lockstep-versioned images; committed `convex/_generated` enforces front↔backend contract |
| **Availability** | Docker `healthcheck` on all containers (Compose); `readinessProbe` + `livenessProbe` (Helm); restart policies; stuck-stream watchdog cron |
| **Data deletion** | `deleteUser` cascade, per-chat/message deletion, right-to-erasure on demand |
| **Confidentiality of secrets** | Auth keys and gateway tokens stored in Convex deployment environment only; never in a database table or source code |

---

## What the Deploying Organization Must Provide

### Before first production deployment

- [ ] Set `AUTH_ALLOWED_EMAIL_DOMAINS` to restrict sign-in to authorized users.
- [ ] Enable MFA at the OAuth identity provider (Google Workspace, Azure AD) for
  all user accounts, especially admin accounts.
- [ ] Store and manage secrets (auth keys, gateway device identity, ingest secret)
  in a secrets manager; never in version control.
- [ ] Configure TLS termination at the reverse proxy or Kubernetes ingress. Do not
  expose Convex directly to the internet.
- [ ] Assess the OpenClaw gateway provider: obtain a DPA and review their SOC 2
  report (or equivalent) — the gateway processes full conversation content.

### Ongoing operational controls

- [ ] **Backups:** automate `convex export` on a schedule; test restore at least
  quarterly; define and document RTO/RPO.
- [ ] **Access reviews:** review active user and service account lists quarterly;
  revoke accounts / keys that cannot be attributed to a current need.
- [ ] **Offboarding:** revoke access (role to `pending`, key revocation, gateway
  credential rotation) immediately on personnel departure.
- [ ] **Incident response:** maintain and test an incident response plan; define
  breach notification timelines.
- [ ] **BC/DR:** maintain and test a business continuity and disaster recovery
  runbook.
- [ ] **Vendor management:** maintain a sub-processor inventory with DPAs; review
  vendors annually.

### Organizational controls (required for SOC 2)

- [ ] **Risk assessment:** maintain a risk register; conduct annual risk
  assessments; reassess after significant changes.
- [ ] **Governance:** establish management oversight of security controls and a
  periodic review cadence.
- [ ] **Security training:** implement a security awareness training program for
  all personnel with access to the system.
- [ ] **Written policies:** maintain an information security policy, access control
  policy, incident response policy, and data retention policy.
- [ ] **Penetration testing:** commission a third-party penetration test before
  handling sensitive production data; repeat annually or after major changes.

### Infrastructure controls

- [ ] Network perimeter (firewall, WAF, DDoS protection) — not provided by the
  product.
- [ ] Physical data center controls — not provided by the product.
- [ ] Container host OS hardening and patch management — operator's responsibility.
- [ ] SCA / dependency vulnerability scanning — not in the product CI pipeline;
  operator must run scans and act on findings.

---

## Sub-processors

The product interacts with two categories of sub-processors that the Deploying
Organization must assess:

| Sub-processor | What it handles | Your responsibility |
|---|---|---|
| OpenClaw gateway provider | Full conversation content (sent to the AI for processing) | DPA; SOC 2 / ISO 27001 review; data residency confirmation |
| OAuth identity provider (Google / Microsoft Entra) | Email address and name (for profile bootstrap) | IdP configuration; MFA enforcement; IdP access reviews |
| Optional: Opik / Langfuse | Trace metadata only (no conversation content) | Configure only if needed; review provider's sub-processor terms |

---

## What a SOC 2 Auditor Will Expect

The product's technical controls provide **evidence** for:
- CC6.1–CC6.7 (access controls, API security)
- CC7.2–CC7.3 (audit and access logging)
- CC7.1 (anomaly monitoring)
- CC8.1 (change management / CI)
- A1 (availability — deployment configuration)
- C1 (confidentiality — PHI boundary, deletion)

The auditor will also require from the **Deploying Organization**:
- A system description (SOC 2 §3.25)
- Evidence of the organizational controls above (policies, training records,
  access review logs, penetration test report, backup logs, vendor assessments)
- A 12-month evidence period for Type II

The product provides no substitute for these organizational controls.
