# SOC 2 Control Mapping — Atrium

This table maps SOC 2 Trust Services Criteria (2017) to the controls implemented
in the software product. It is intended for Deploying Organizations building
their SOC 2 control matrix and for auditors reviewing the product layer.

**Status legend:**
- `PRODUCT` — control is implemented in the software; evidence pointer provided
- `OPERATOR` — control is the Deploying Organization's responsibility
- `PARTIAL` — partially in the product; operator must complete
- `GAP` — not implemented; see `README.md` gaps section

---

## Common Criteria — Security

### CC1 — Control Environment

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| CC1.1 | Commitment to integrity and ethical values | No formal policy in the product | — | Maintain a written security policy and code of conduct | OPERATOR |
| CC1.2 | Board / management oversight | Not provided | — | Establish governance structure and review cadence | OPERATOR |
| CC1.3 | Organizational structure | Admin role enforces accountability within the system | `convex/lib/access.ts` | Maintain org chart and role accountability | PARTIAL |
| CC1.4 | Competent personnel | Not provided | — | Define competence requirements and training program | OPERATOR |
| CC1.5 | Accountability | Admin actions audited; impersonation attributed | `convex/lib/audit.ts` | Implement HR accountability framework | PARTIAL |

### CC2 — Communication and Information

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| CC2.1 | Quality information for internal control | Technical documentation in `docs/` | `API_CONTROLS.md` | Formal information classification policy | PARTIAL |
| CC2.2 | Internal communication of responsibilities | Docs committed to repo | `docs/` | Periodic security communications program | PARTIAL |
| CC2.3 | External communication | Public Trust Center (`compliance/`) | This document | Privacy notice; incident notification SLA | PARTIAL |

### CC3 — Risk Assessment

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| CC3.1 | Objectives specified | Architecture documentation | `docs/ARCHITECTURE.md` | Formal risk-objective statement | PARTIAL |
| CC3.2 | Risk identification and analysis | Not provided | — | Maintain a formal risk register | OPERATOR |
| CC3.3 | Fraud risk | Not provided | — | Conduct fraud risk assessment | OPERATOR |
| CC3.4 | Changes that impact risk | CI gates detect contract drift | `.github/workflows/ci.yml` | Formal re-assessment trigger on significant changes | PARTIAL |

### CC4 — Monitoring Activities

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| CC4.1 | Ongoing evaluation | Anomaly cron (5 min), access log, admin notifications | `convex/anomalies.ts` | Formal management review cadence; periodic control testing | PARTIAL |
| CC4.2 | Remediation of deficiencies | Anomaly notifications reach admins | `convex/anomalies.ts`, `convex/notifications.ts` | Formal deficiency tracking and remediation process | PARTIAL |

### CC5 — Control Activities

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| CC5.1 | Risk-mitigating controls | Per-route permission gating; rate limiting; positive-allowlist API serializer | `convex/http.ts`, `convex/lib/apiAuth.ts`, `convex/lib/chatRenderState.ts` | Document the selected controls in the risk register | PRODUCT |
| CC5.2 | Technology general controls | CI gates; committed `convex/_generated`; lockstep-versioned images | `.github/workflows/` | Assess controls periodically | PRODUCT |
| CC5.3 | Policy-based controls | Technical controls are code-enforced; formal written procedures for operator tasks are gap | — | Create and maintain written procedures | PARTIAL |

### CC6 — Logical and Physical Access Controls

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| CC6.1 — Authentication | OAuth-based authentication | `@convex-dev/auth`; Google + Microsoft Entra | `convex/auth.ts` | Configure OAuth apps; enable MFA at IdP | PRODUCT |
| CC6.1 — Domain restriction | Allowed-domain gate | `AUTH_ALLOWED_EMAIL_DOMAINS`; authoritative in `ensureProfile` | `convex/lib/access.ts` | Set env var before first deployment | PRODUCT |
| CC6.1 — Pending gate | New users blocked by default | `requireActive` throws for `pending` role | `convex/lib/access.ts` | Timely review of pending accounts | PRODUCT |
| CC6.1 — API key auth | Bearer token; hash at rest | SHA-256; disabled/expired rejected | `convex/lib/apiAuth.ts`, `convex/apiKeys.ts` | Secure plaintext delivery; rotation on personnel change | PRODUCT |
| CC6.1 — Secrets in env | Auth keys, gateway tokens never in DB | Bootstrap script pushes to Convex deployment env | `deploy/compose/bootstrap-env.sh`, `deploy/helm/templates/bootstrap-job.yaml` | Use a secrets manager; rotate secrets | PRODUCT / OPERATOR |
| CC6.1 — MFA | Delegated to OAuth provider | No product enforcement | — | Mandate MFA at IdP level | OPERATOR |
| CC6.2 — Credential issuance | Service account creation and key minting audited | `requireAdmin`; audit on every action | `convex/apiKeys.ts` | Formal provisioning workflow | PRODUCT |
| CC6.3 — Least privilege | Built-in roles; closed permission set | `BUILTIN_ROLES`, `PERMISSIONS`, `assertValidPermissions` | `convex/lib/rbac.ts` | Periodic access reviews | PRODUCT |
| CC6.3 — Service account role guard | Human-only roles blocked for service accounts | `HUMAN_ONLY_ROLE_KEYS` | `convex/apiKeys.ts` | — | PRODUCT |
| CC6.3 — Content gated separately | `traces.read.content` not in built-in service roles | `BUILTIN_ROLES` `observer` / `agent` | `convex/lib/rbac.ts` | Do not grant content permission to service accounts | PRODUCT |
| CC6.4 — Physical access | Not provided by product | — | Data center / cloud provider physical controls | OPERATOR |
| CC6.5 — De-provisioning | Role to pending (immediate); full delete cascade | `requireActive`, `admin.deleteUser` | `convex/lib/access.ts` | Formal offboarding checklist; HR trigger | PRODUCT |
| CC6.5 — Key revocation | `revokeApiKey` disables; audit retained | `convex/apiKeys.ts:revokeApiKey` | — | Rotate keys on personnel change | PRODUCT |
| CC6.6 — Rate limiting | Per-key + unauthenticated sharded limiter | `checkApiRateLimit`; 120/min authenticated; 16-shard pre-auth | `convex/apiRateLimit.ts` | — | PRODUCT |
| CC6.6 — Access scan anomaly | Flags excessive cross-chat reads | `ANOMALY_KINDS.ACCESS_SCAN` (> 25 chats/key/15 min) | `convex/anomalies.ts` | Monitor notifications; respond to anomalies | PRODUCT |
| CC6.6 — Network controls | Not provided | — | Firewall, WAF, VPN | OPERATOR |
| CC6.7 — TLS | Operator reverse proxy / ingress | Not terminated by product | `deploy/README.md` | Configure TLS; manage certificates | OPERATOR |
| CC6.7 — Security headers | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` | Applied in `apiJson` | `convex/http.ts` | — | PRODUCT |
| CC6.7 — No PHI in API | Positive-allowlist serializer + sentinel test | `chatStateInternal`; `chatRenderState.ts` | `convex/messages.ts`, `convex/chatState.test.ts` | — | PRODUCT |
| CC6.8 — Malware protection | Not provided | — | SCA scanning; container security | OPERATOR / GAP |

### CC7 — System Operations

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| CC7.1 — Detection | Anomaly detector cron; admin notifications | `detectAnomalies` every 5 min | `convex/anomalies.ts` | Monitor notifications; optional log shipping to Opik/Langfuse | PRODUCT |
| CC7.1 — Stuck stream | `reconcileStuckStreams` cron | Recovers orphaned messages | Convex crons | — | PRODUCT |
| CC7.2 — Access trail | `accessLog`: 90-day metadata-only log for all authenticated API calls | `recordEvent` + `accessLog` table | `convex/observability.ts` | — | PRODUCT |
| CC7.2 — Audit trail | `auditLog`: privileged actions; no purge | `recordAudit` | `convex/lib/audit.ts` | — | PRODUCT |
| CC7.3 — Trail protection | `auditLog` append-only (insert-only) | `recordAudit` only INSERTs | `convex/lib/audit.ts` | Export logs to immutable store if tamper-evidence required | PRODUCT |
| CC7.4 — Incident detection | Technical: anomaly alerts | `convex/anomalies.ts` | Formal IR plan and runbook | PARTIAL |
| CC7.4 — Incident response | Not provided as a process | — | Create and maintain IR plan; train personnel | OPERATOR |
| CC7.5 — Recovery | Key/account disable is immediate; data restore via `convex export` | `revokeApiKey`, `requireActive` | — | Automate backups; test restore; define RTO/RPO | PARTIAL |

### CC8 — Change Management

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| CC8.1 — CI gates | Typecheck + build + tests required before image push | Full suite gate | `.github/workflows/build-and-push.yml` | — | PRODUCT |
| CC8.1 — Contract enforcement | Committed `convex/_generated`; typecheck fails on mismatch | Typecheck step | `.github/workflows/ci.yml` | — | PRODUCT |
| CC8.1 — Lockstep versioning | App + bridge images versioned together on `v*` tags | `build-and-push.yml` tag strategy | — | Deploy images from the same release tag | PRODUCT |
| CC8.1 — Formal CAB | Not provided | — | Implement CAB or PR review policy | OPERATOR |
| CC8.1 — Environment separation | Not enforced by product | — | Operate separate Convex deployments for dev/staging/prod | OPERATOR |

### CC9 — Risk Mitigation

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| CC9.1 — Risk mitigation | IDOR compensating controls documented | No-PHI projection + rate limit + access-scan anomaly | `API_CONTROLS.md §6` | Formal risk register | PRODUCT |
| CC9.2 — Vendor assessment | Not provided | — | Assess all sub-processors; obtain DPAs; maintain inventory | OPERATOR |

---

## A1 — Availability

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| A1.1 — Capacity monitoring | KPI dashboard, `/api/v1/kpi`, bridge health tab | Convex functions | — | Set alerting thresholds | PRODUCT |
| A1.2 — Infrastructure protection | Not provided | — | Host/network/physical protections | OPERATOR |
| A1.3 — Recovery | Restart policies, healthchecks, stuck-stream watchdog | `deploy/compose/docker-compose.yml`, `deploy/helm/templates/` | Test backup restore; define RTO/RPO | PARTIAL |
| A1.3 — BC/DR runbook | Not provided | — | Create and test BC/DR runbook | OPERATOR |

---

## C1 — Confidentiality

| TSC | Control Objective | Product Control | Source | Adopter Responsibility | Status |
|---|---|---|---|---|---|
| C1.1 — Identify confidential info | Data classification documented | `compliance/README.md`, `API_CONTROLS.md` | Formal data classification policy | PRODUCT |
| C1.2 — Disposal | `deleteUser` cascade; per-chat/message delete | `admin.deleteUser`, `cascadeDeleteChat` | Define retention periods in privacy notice | PRODUCT |
| C1.2 — Retention policy | 90-day access log; 14-day traces; conversations retained until explicit deletion (documented policy decision) | `API_CONTROLS.md §9` | Define and publish retention policy | PRODUCT |
| C1.2 — API response PHI boundary | Positive-allowlist serializer; sentinel test | `convex/messages.ts`, `convex/chatState.test.ts` | — | PRODUCT |
