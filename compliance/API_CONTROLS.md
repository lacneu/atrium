# `/api/v1` — security & privacy controls

The key-authed observability/diagnostic API (`convex/http.ts`) and the MCP server
expose **metadata only — never chat content**. Product chat content can contain
personal data / PHI; every control below reinforces that boundary. Audience:
Deploying Organizations building a SOC 2 control matrix, and auditors reviewing
the product layer. The Trust Services Criteria most engaged: **Confidentiality**,
**Privacy**, and the **Common Criteria** access controls (CC6.x, CC7.x).

## 1. Authentication (CC6.1)

- Every authenticated route resolves an `Authorization: Bearer <key>` header
  through `authenticateApiKey` (`convex/lib/apiAuth.ts`). The plaintext key is
  hashed (SHA-256) and looked up by hash; the plaintext is never stored or
  logged. Disabled / expired keys and disabled service accounts are rejected
  (401). The unauthenticated liveness probe `GET /api/v1/health` is the only
  exception (no data, no key required).

## 2. Authorization — least privilege (CC6.1, CC6.3)

- A key carries a **service-account RBAC role**; each route requires a specific
  permission (`principalHasPermission`). Built-in service roles:
  - `observer` — read-only: `traces.read`, `kpi.read`, `anomalies.read`,
    `bridge.read`.
  - `agent` — the observer set **plus** `openclaw.query` + `anomalies.report`.
- Raw chat **content** is gated by a distinct, admin-only permission
  (`traces.read.content`) that is **NOT** granted to `observer`/`agent`. No
  routine diagnostic surface exposes it.

## 3. No content leaves the API — metadata-only projection (Confidentiality / Privacy)

- The diagnostic `GET /api/v1/chat-state` (the richest read) is a **positive
  allowlist serializer** (`convex/messages.ts: chatStateInternal`), not a filter
  over a content-bearing object. It consumes the **same** read core the client
  renders from (`loadChatView`) and the **same** shared derivation
  (`convex/lib/chatRenderState.ts`) — so it reproduces the client's view for
  debugging — then emits **structure + lifecycle only**:
  - **Emitted (safe):** message id, role, status, runId, age, `runStatusKind`,
    `stuckStreaming`, `partCount`, per-part `kind`/`order`/tool base
    `name`/`phase`/`hasInput`/`hasOutput`/`mimeType` (base)/`hasFilename`/
    `hasStorageUrl`; chat `instanceName` (the technical slug, never the
    admin-settable `displayName`), `agentId`, counts.
  - **Never emitted:** message text, filenames, signed storage URLs, tool
    input/output, reasoning text, provenance source/items.
  - **Neutralized at the boundary:** the free-form `messages.error` is mapped to
    a stable code (`normalizeMessageErrorCode`; unknown raw text → `unknown`);
    exact `textLen` → a coarse bucket (`textLenBucket`); `mimeType` → its base
    type (the `name=` filename parameter is stripped, `mimeTypeBase`).
- **Auditable proof:** `convex/chatState.test.ts` seeds a unique sentinel in
  EVERY content slot and asserts none appear in the serialized response.

## 4. Access logging / audit trail (CC6.1, CC7.2)

- Every authenticated call records an `api.call` trace event (principal id, role
  key, route, status, latency), `redacted: true` by construction (metadata only).
  `chat-state` additionally records `{ chatId, messageCount, stuckCount }` —
  non-content counts that let an operator detect a key scanning many chats.
- **Durable access log:** because `traceEvents` purge at 14 days, every
  `api.call` is ALSO dual-written to a dedicated **`accessLog`** table retained
  `ACCESS_LOG_RETENTION_DAYS` (default **90**) — long enough to span a Type II
  audit period. Metadata only. Reviewable via `observability.listAccessLog`
  (gated `traces.read`). Append-only (§7).

## 5. Rate limiting (CC6.6)

- **Authenticated:** per-key fixed-window limit (`convex/apiRateLimit.ts`),
  enforced inside `authenticateApiKey` so it covers **every** authenticated route;
  over-limit returns **429**. Expired counters purge hourly. Compensating control
  (with §4) against a valid key enumerating `chatId`s to fingerprint activity.
- **Unauthenticated (pre-resolution):** a throttle runs **before** the key DB
  lookup, **sharded** by the presented-key hash across `UNAUTH_SHARDS` (16) fixed
  buckets — neither one hot row nor bloatable by random keys. Over-budget returns
  **429** before any DB read.

## 6. IDOR / cross-resource access — documented decision (CC9.1)

- **Decision:** a service-account key (`observer`/`agent`) may read the
  diagnostic state of **any** chat by id (service accounts have no ownership).
  Intentional: a service principal is a legitimate operational-supervision actor,
  and the projection exposes **no content** (§3), so cross-chat reads disclose no
  personal data.
- **Compensating controls:** the no-content projection (§3), the per-call access
  trace incl. `chatId` (§4), the rate limit (§5), and an **active detector**
  (`ANOMALY_KINDS.ACCESS_SCAN`) that, every 5 min, flags any key reading > 25
  distinct chats and notifies admins.
- Human (UI) access remains strictly owner-scoped (`listByChat` enforces
  `chat.userId === userId`); only the **content-free** service path is global.

## 7. Audit trail — append-only (CC7.3)

- The `auditLog` table (cross-identity / impersonation attribution) is
  **append-only**: `lib/audit.recordAudit` only INSERTs; no mutation patches or
  deletes a row. It is **not** retention-purged, so the trail spans the full audit
  period. The `api.call` access trace (§4) lives in `traceEvents`, inserted only
  and removed only by the bounded retention purge — never patched.

## 8. Response headers (CC6.7)

- Every `/api/v1` response (`apiJson`) carries `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`. CSP/X-Frame-Options are intentionally omitted
  (not applicable to a pure JSON API).

## 9. Data retention — conversations / PHI (Confidentiality / Privacy, C1 / P4)

- Conversation content (chats, messages, parts, files) is **retained until
  explicit deletion** by the user (message/chat delete) or an admin (`deleteUser`,
  `cascadeDeleteChat`) — there is intentionally **no automatic time-based purge**
  (a conscious, documented policy decision). If a deployment's privacy notice
  commits a maximum duration, add a bounded purge cron keyed on `updatedAt`.
- **Right to erasure:** honored via the admin `deleteUser` (full owned-data
  cascade) and per-chat/message deletion.
- Operational logs differ from content: `traceEvents` purge at 14 days, the
  durable `accessLog` at 90 days (§4), the impersonation `auditLog` is never
  purged (§7). None contain conversation content.
