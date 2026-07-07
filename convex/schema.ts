// Convex schema for the Atrium bridge.
//
// Design invariants (load-bearing):
//   - Convex stores non-secret metadata in the clear. Gateway CREDENTIALS
//     (operator token, Ed25519 device identity, Hermes API key) are stored
//     ENCRYPTED at rest (AES-256-GCM, lib/crypto) in the `instanceSecrets`
//     table — NEVER as plaintext, and NEVER returned to the browser (only the
//     bridge fetches the decrypted form server-side). The master key lives in
//     the Convex deployment env (`ATRIUM_SECRET_KEY`), not the DB. The
//     bridge↔Convex shared secret and OpenClaw filesystem paths still never
//     live in any table here.
//   - Reactivity is driven entirely by this DB: the bridge writes normalized
//     events into `messages` / `messageParts` and assistant-ui re-renders.
//   - Per-user access control is enforced in functions (queries/mutations),
//     not by the schema; the indexes below exist so those scoped queries are
//     cheap (e.g. `by_user`, `by_chat`).

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import { instanceConfigValidator } from "./lib/instanceConfig";
import {
  encryptedSecretValidator,
  secretFieldValidator,
} from "./lib/crypto/convexValidator";

// A single normalized message part. assistant-ui's `convertMessage` maps these
// onto ThreadMessageLike content parts:
//   - tool      -> { type: "tool-call", toolName, args, result }
//   - media     -> { type: "file"/"image", mimeType, data: <storage url> }
//   - file      -> { type: "file", mimeType, data: <storage url> }
//   - reasoning -> { type: "reasoning", text }
export const messagePart = v.union(
  v.object({
    kind: v.literal("tool"),
    name: v.string(),
    // Lifecycle phase emitted by the normalizer (e.g. "start", "running",
    // "done"). Free-form string to stay forward-compatible with OpenClaw.
    phase: v.string(),
    input: v.optional(v.any()),
    output: v.optional(v.any()),
  }),
  v.object({
    kind: v.literal("media"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
  }),
  v.object({
    kind: v.literal("file"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
  }),
  v.object({
    kind: v.literal("reasoning"),
    text: v.string(),
  }),
  // The GATEWAY compacted this session's context during the turn (older history
  // summarized to fit the model window). Provider-neutral, content-free: the
  // detection phase ("preflight" = before the model call, detected by session-id
  // rotation; "midturn" = the run was abandoned + replayed for compaction) and
  // the detection timestamp — never the summary text. Rendered as the user-facing
  // "context was optimized" marker on the message (always visible, not a tool
  // detail — it explains why the agent may have lost older conversation detail).
  v.object({
    kind: v.literal("compaction"),
    phase: v.string(),
    at: v.number(),
  }),
  // Provenance report (provenance/v1, docs/PROVENANCE_CONTRACT.md): what a
  // gateway context-injecting plugin (conversational memory / document RAG)
  // fed the LLM for THIS turn. Emitted by the plugin on its gateway-scoped
  // agent-event stream, validated + bounded by the bridge before ingest
  // (bridge core/provenance.ts), re-validated by this union. `pluginId` is
  // stamped by the GATEWAY (authenticated emitter), never plugin-declared.
  v.object({
    kind: v.literal("provenance"),
    v: v.number(),
    pluginId: v.string(),
    source: v.string(),
    group: v.union(v.literal("memory"), v.literal("documents")),
    injected: v.optional(
      v.object({
        chars: v.optional(v.number()),
        position: v.optional(v.string()),
        truncated: v.optional(v.boolean()),
      }),
    ),
    retrieval: v.optional(
      v.object({
        route: v.optional(v.string()),
        bank: v.optional(v.string()),
        collections: v.optional(v.array(v.string())),
        lightragMode: v.optional(v.string()),
      }),
    ),
    items: v.array(
      v.object({
        id: v.optional(v.string()),
        type: v.optional(v.string()),
        date: v.optional(v.string()),
        score: v.optional(v.number()),
        text: v.optional(v.string()),
        file_name: v.optional(v.string()),
        // Human DISPLAY name for a document item (provenance/v1, additive). The UI shows
        // it instead of file_name; file_name stays the stable retrieval/attach key.
        title: v.optional(v.string()),
        collection: v.optional(v.string()),
        // Additive (provenance/v1): a documents-group item declaring itself a
        // synthesized CONTEXT excerpt (no openable source) — see convex/lib/provenance.
        context: v.optional(v.boolean()),
      }),
    ),
  }),
);

// One target's health, flattened from the bridge's /health snapshot. Non-PHI:
// curated state + last error CODE + non-secret host only — never tokens. Shared
// by the `bridgeHealth` table and the poller's upsert args (one source of truth).
export const bridgeHealthTarget = v.object({
  key: v.string(),
  instanceName: v.union(v.string(), v.null()),
  canonical: v.string(),
  agentId: v.string(), // the agent the bridge ACTUALLY uses (env), not a body claim
  gatewayHost: v.string(),
  state: v.string(), // idle | connected | error
  lastOkAt: v.union(v.number(), v.null()),
  lastErrorCode: v.union(v.string(), v.null()),
  lastErrorAt: v.union(v.number(), v.null()),
  attempts: v.number(),
  okCount: v.number(),
  errorCount: v.number(),
  // Last DOWNSTREAM rejection (the gateway received + refused the request): the
  // bridge worked, so it is NOT a bridge-health error — surfaced as a neutral
  // note, never the red `error` state. Optional: a pre-this-release bridge image
  // omits them (the poller defaults them to null/0).
  lastDownstreamRejectCode: v.optional(v.union(v.string(), v.null())),
  lastDownstreamRejectAt: v.optional(v.union(v.number(), v.null())),
  downstreamRejectCount: v.optional(v.number()),
  // Per-instance gateway WS frame limit (Model M): the maxPayload reported by THIS
  // instance's bridge, so the inbound-attachment cap is derived per routed instance
  // (maxPayloadInternal). Optional: a pre-this-release bridge / unreached instance
  // omits it (the dispatch falls back to the doc-level value, then the default).
  maxPayload: v.optional(v.union(v.number(), v.null())),
  // Per-instance gateway VERSION reported by THIS instance's bridge /health, shown
  // on the connection row. Optional: a pre-this-release bridge / unreached instance
  // omits it.
  gatewayVersion: v.optional(v.union(v.string(), v.null())),
});

// One capability target from the bridge /capabilities snapshot, deduped to ONE
// row per instance (lib/compat.dedupeTargetsByInstance). Non-secret: instance/
// provider names, gateway version string, capability booleans. Shared by the
// `bridgeCompat` table and the poller's upsert args (one source of truth, same
// idiom as bridgeHealthTarget).
export const bridgeCompatTarget = v.object({
  instanceName: v.string(),
  provider: v.string(), // "openclaw" | "hermes" | future — free string (fwd-compat)
  gatewayVersion: v.union(v.string(), v.null()),
  capabilities: v.record(v.string(), v.boolean()), // capability -> enabled
  versionBeyondValidated: v.boolean(), // gateway newer than the validated max
  // The SERVING bridge's env-level rehydration default, stamped per target at
  // poll time (multi-bridge: each instance follows ITS OWN bridge's kill-switch,
  // not the first-reachable one). Optional/null = pre-feature.
  rehydrationDefault: v.optional(v.union(v.boolean(), v.null())),
  turnSessionEcho: v.optional(v.union(v.boolean(), v.null())),
});

export default defineSchema({
  // @convex-dev/auth's own tables (authAccounts, authSessions, authRefreshTokens,
  // authVerificationCodes, ... AND its own `users` table). Spreading this is
  // MANDATORY: without it the auth flow has nowhere to persist accounts/sessions.
  // We intentionally do NOT redefine `users` ourselves — authTables owns it, and
  // `getAuthUserId(ctx)` returns an Id<"users"> from this table. Our extra
  // project fields live in `profiles` (1:1 with a users row) so we never collide
  // with the columns @convex-dev/auth writes.
  ...authTables,

  // Project-specific, non-secret profile data for an authenticated user. Keyed
  // 1:1 to the authTables `users` row via `userId` (the value getAuthUserId
  // returns). NO secrets (gateway URL lives in `instances`, tokens in bridge).
  profiles: defineTable({
    userId: v.id("users"), // -> authTables users (getAuthUserId result)

    // RBAC role (Open WebUI style). OPTIONAL so adding this field does not
    // reject pre-existing role-less rows on schema push; the single role-writer
    // (lib/access.ensureProfile) backfills it. Semantics:
    //   - "pending": authenticated but NOT yet approved -> blocked from the app
    //   - "user":    approved, full chat access
    //   - "admin":   approved + can manage users/roles/agents/instances
    // A row with no role is treated as "pending" by the access helpers.
    role: v.optional(
      v.union(v.literal("pending"), v.literal("user"), v.literal("admin")),
    ),
    // Display fields (non-secret) for the admin user list.
    email: v.optional(v.string()),
    name: v.optional(v.string()),

    // Per-user theme preference (identity-level: even a pending user controls
    // it). OPTIONAL: when unset, the resolver falls back to the admin default,
    // then "system".
    themeMode: v.optional(
      v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
    ),
    // The user's SELECTED chart (charte graphique) key (P3). A builtin key from
    // convex/lib/charts.BUILTIN_CHART_KEYS, or unset = the app default (resolved
    // to the admin default, then the native index.css look). Written ONLY via
    // charts.setMyChart, which rejects a key not available to the user.
    themeName: v.optional(v.string()),

    // Per-user UI language preference (identity-level, like themeMode). OPTIONAL:
    // unset => resolver falls back to the admin default, then BASE_LOCALE.
    // Stored as a PLAIN string: membership is validated at the setter against
    // lib/locales.SUPPORTED_LOCALES (single source), so adding a language never
    // needs a schema migration; a stored value that becomes unsupported narrows
    // to the next fallback tier at read (lib/locales.resolveLocale).
    locale: v.optional(v.string()),

    // DEPRECATED — superseded by `uiPrefs.showTools`. No longer READ by the
    // resolver (it shadowed the admin default + mislabeled as "default"); kept as
    // a column only so existing rows validate. Safe to ignore / GC later.
    showTools: v.optional(v.boolean()),

    // DEPRECATED — superseded by `uiPrefs.voiceInput`. No longer READ by the
    // resolver; kept as a column only so existing rows validate. Safe to GC later.
    voiceInput: v.optional(v.boolean()),

    // Unified per-user UI preferences (the interface-config module). Each toggle
    // is OPTIONAL → undefined means "inherit the admin default / code default".
    // The SINGLE write path is `me.setUiPref`; `getMe` resolves via resolveUiPrefs
    // (user override -> legacy field -> admin default -> code default, with a
    // system gate). Keys MUST match convex/lib/uiPrefs.UI_PREF_KEYS.
    uiPrefs: v.optional(
      v.object({
        showSource: v.optional(v.boolean()),
        showReport: v.optional(v.boolean()),
        copyAssistant: v.optional(v.boolean()),
        copyUser: v.optional(v.boolean()),
        showDelete: v.optional(v.boolean()),
        showTools: v.optional(v.boolean()),
        voiceInput: v.optional(v.boolean()),
        showChatAge: v.optional(v.boolean()),
        showChatProvider: v.optional(v.boolean()),
        showUsage: v.optional(v.boolean()),
        autoReadAloud: v.optional(v.boolean()),
      }),
    ),

    // Per-user ordering of the Settings tabs (drag-and-drop in SettingsNav). A
    // list of tab keys; tabs absent from it (e.g. a newly added tab) fall back to
    // their code order AFTER the saved ones. Unknown/stale keys are ignored on
    // read. OPTIONAL → unset means the default code order.
    settingsTabOrder: v.optional(v.array(v.string())),

    // Per-user GRANTED permissions on top of the role (per-tab RBAC). An admin
    // grants read-only observability perms here to open specific Settings tabs to
    // a non-admin. The write path (admin.setUserPermissions) enforces the
    // GRANTABLE_USER_PERMISSIONS whitelist server-side, so admin.manage / sensitive
    // perms can NEVER land here. Effective perms = role ∪ this (see access.ts).
    extraPermissions: v.optional(v.array(v.string())),

    // Stable per-user key used to derive a per-user agent / session namespace
    // (OpenClaw `canonical`). Defaults to a slug of the email when unset.
    canonical: v.optional(v.string()),

    // Admin impersonation target. When an admin starts "view/act as a user",
    // the target's userId is recorded HERE, on the ADMIN's own profile. The
    // access layer resolves the EFFECTIVE user from it (real admin identity +
    // this target); cleared on stop. ONLY honored when this profile's role is
    // "admin" (a non-admin row carrying it would be ignored), so it can never
    // be used to escalate. OPTIONAL (additive on existing rows).
    impersonatingUserId: v.optional(v.id("users")),
  })
    .index("by_user", ["userId"])
    .index("by_role", ["role"])
    // Email-collision lookup at provisioning: ensureProfile refuses to AUTO-create
    // a SECOND profile for a NEW identity (provider+subject) whose email already
    // belongs to an existing profile — cross-provider account linking must be an
    // explicit, signed-in action, never an implicit merge. See lib/access.
    .index("by_email", ["email"]),

  // OpenClaw / Hermes instances the deployment knows about. NO secrets (gateway
  // tokens and device identities are bridge-env only — the bridge maps `name` ->
  // secrets). See docs/MULTI_AGENT_REDESIGN.md.
  instances: defineTable({
    name: v.string(),
    gatewayUrl: v.string(),
    displayName: v.optional(v.string()),
    // Non-secret gateway config moving from the bridge env to the UI (consumed by
    // the bridge in a later step). `gatewayVersion` = the compat fallback
    // (OPENCLAW_GATEWAY_VERSION); `gatewayHttpUrl` = the media HTTP override
    // (OPENCLAW_GATEWAY_HTTP_URL). The SECRET credentials live in `instanceSecrets`.
    gatewayVersion: v.optional(v.string()),
    gatewayHttpUrl: v.optional(v.string()),
    // Per-instance bridge endpoint (Model M: one bridge process per gateway).
    // Convex dispatch POSTs here; UNSET → fall back to the deployment `BRIDGE_URL`
    // env (the single-bridge path). NON-secret URL — the shared secret stays env.
    bridgeUrl: v.optional(v.string()),
    // Per-instance NON-SECRET bridge config, hot-reloaded in-band on dispatch
    // (mediaMode / inboundMediaMode / rehydration / mediaMaxMb). Secrets are NEVER
    // here. Validator shared with admin.upsertInstanceConfig (lib/instanceConfig).
    config: v.optional(instanceConfigValidator),
    // FRONTEND live-stream transport for this instance's chats (reactive push | SSE).
    // A frontend↔Convex DISPLAY choice — deliberately a top-level instance PROPERTY (edited
    // in "Modifier l'instance"), NOT in the bridge `config` blob: it is never dispatched to
    // the bridge. Absent => reactive (the default). See lib/instanceConfig STREAM_TRANSPORTS.
    streamTransport: v.optional(v.union(v.literal("reactive"), v.literal("sse"))),
    // Which provider technology backs this instance. OPTIONAL (additive) →
    // unset legacy rows are treated as "openclaw". The bridge adapts API calls
    // by kind; the app stays standardized.
    kind: v.optional(v.union(v.literal("openclaw"), v.literal("hermes"))),
    // Hermes transport: "ws" (default — the JSON-RPC WebSocket `hermes serve`
    // surface, richer features) or "rest" (the OpenAI-compatible API server).
    // Ignored for OpenClaw instances.
    transport: v.optional(v.union(v.literal("ws"), v.literal("rest"))),
    // Admin-chosen DEFAULT agent for this instance (agentId). Overrides the
    // gateway-discovered `agents.isDefaultOnInstance` in the routing default tier
    // — but ONLY once Phase 2/3 consume it (set-but-INERT in Phase 1). Cleared when
    // that agent is disabled/removed (set-time + resolve-time guard).
    defaultAgentId: v.optional(v.string()),
    // Cached provider capabilities from the bridge `/capabilities` (incl.
    // agentDiscovery). Non-secret. OPTIONAL → unknown until first poll.
    capabilities: v.optional(
      v.object({
        agentDiscovery: v.optional(v.boolean()),
        abort: v.optional(v.boolean()),
        history: v.optional(v.boolean()),
        attachments: v.optional(v.boolean()),
        media: v.optional(v.boolean()),
        streaming: v.optional(v.string()), // "delta" | "snapshot" | "both"
      }),
    ),
  }).index("by_name", ["name"]),

  // Encrypted gateway CREDENTIALS — one row per (instance, field). SEPARATE from
  // `instances` ON PURPOSE (mirrors apiKeys-vs-serviceAccounts): the ciphertext
  // never rides a client-facing `instances` read, and per-field rows avoid the
  // nested-merge clobber. `secret` is the AES-256-GCM envelope (lib/crypto); the
  // plaintext is never stored and never returned to the browser — only the bridge
  // fetches the decrypted form server-side. Encryption binds AAD `<instanceId>:
  // <field>` so a ciphertext can't be relocated to another instance/field.
  instanceSecrets: defineTable({
    instanceId: v.id("instances"),
    field: secretFieldValidator, // "token" | "deviceIdentity" | "apiKey"
    secret: encryptedSecretValidator,
    updatedAt: v.number(),
  })
    .index("by_instance", ["instanceId"]) // status list + cascade delete
    .index("by_instance_field", ["instanceId", "field"]), // upsert one per field

  // PER-BRIDGE authentication secret (bridge -> Convex). Mirrors apiKeys: only the
  // SHA-256 hash is stored, the plaintext is shown ONCE at mint. The point is
  // ISOLATION: a presented secret RESOLVES to exactly ONE instance (by_hash), so a
  // bridge proves WHICH instance it is — the credential-decrypt endpoint (step 3b)
  // can then return ONLY that instance's gateway secrets, instead of trusting a
  // self-asserted instanceName under a single shared BRIDGE_INGEST_SECRET (which
  // would let any bridge decrypt every gateway's private key). One active secret per
  // instance (rotate = replace the row). `by_instance` serves status + the
  // deleteInstance cascade; `by_hash` is the O(1) verification lookup.
  bridgeAuth: defineTable({
    instanceId: v.id("instances"),
    hashedSecret: v.string(), // SHA-256 hex of the plaintext (the only stored form)
    prefix: v.string(), // non-secret leading segment for display
    lastFour: v.string(), // non-secret trailing 4 chars for disambiguation
    createdAt: v.number(),
    createdBy: v.id("users"),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_hash", ["hashedSecret"]) // O(1) verification -> resolves the instance
    .index("by_instance", ["instanceId"]), // status + rotate (one per instance)

  // Per-instance discovery OUTCOME (the truth dispatch keys on). Distinct from
  // the `agents` cache: a single boolean cannot tell "agent absent in a
  // SUCCESSFUL poll" (=> deleted on gateway => re-bind) from "unknown because the
  // poll FAILED" (=> serve last-good, never hard-fail on a blip). Poll outcome
  // lives here; per-agent presence on `agents.presentInLastOk` (red-team B2).
  instanceDiscovery: defineTable({
    instanceName: v.string(), // -> instances.name
    lastPollAt: v.number(),
    lastPollOk: v.boolean(), // last discovery succeeded? (down/error => false)
    lastOkAt: v.optional(v.number()), // last time it succeeded (staleness window)
    error: v.optional(v.string()), // non-secret reason code when !lastPollOk
  }).index("by_instance", ["instanceName"]),

  // Subscription-usage snapshot per instance (gateway `usage.status` via the
  // bridge /agents ride-along): per provider, rate-limit windows {label,
  // usedPercent, resetAt}. Content-free. A DEDICATED table (NOT a field on
  // instanceDiscovery): discovery is deliberately cache-stable — it is read by
  // the per-grant chat queries, and a per-poll usage write there would
  // invalidate every chat query on every poll (the listChats-saturation
  // lesson). Only the usage queries read THIS table, so its churn is cheap.
  instanceUsage: defineTable({
    instanceName: v.string(), // -> instances.name
    usage: v.array(
      v.object({
        provider: v.string(),
        windows: v.array(
          v.object({
            label: v.string(),
            usedPercent: v.number(),
            resetAt: v.union(v.number(), v.null()),
          }),
        ),
      }),
    ),
    updatedAt: v.number(),
  }).index("by_instance", ["instanceName"]),

  // Resilient cache of bridge-discovered agents (last-good, NEVER emptied by a
  // failed poll). Source of truth is the bridge `/agents` (which calls the
  // provider, e.g. OpenClaw `agents.list`). The app binds/assigns ONLY agents
  // present here — this is what makes "Agent X no longer exists" structurally
  // impossible for discovery-capable instances.
  agents: defineTable({
    instanceName: v.string(), // -> instances.name
    agentId: v.string(), // provider-defined id (e.g. "alice")
    displayName: v.optional(v.string()), // identityName
    emoji: v.optional(v.string()),
    model: v.optional(v.string()),
    isDefaultOnInstance: v.optional(v.boolean()),
    // ADMIN curation: is this discovered agent made available downstream (assignable
    // to groups/users, usable in chats)? Admin-managed, PRESERVED across discovery
    // polls (applyDiscovery never writes it). OPTIONAL → unset/false = NOT enabled
    // (opt-in: the admin explicitly enables). ENFORCEMENT lands in Phase 2 — in
    // Phase 1 this is set-but-not-read (inert), so no existing assignment breaks.
    enabled: v.optional(v.boolean()),
    // ADMIN curation: the agent's TYPE(s) — a fixed code-defined catalogue
    // (convex/lib/agentTypes.ts: "conversational" | "documentary"). Tells Atrium HOW
    // the agent may be used (normal chat vs a dedicated documentary-source action).
    // Admin-managed + PRESERVED across discovery polls (applyDiscovery never writes
    // it). OPTIONAL/empty => CONVERSATIONAL by default (resolveAgentTypes). An agent
    // may hold several types.
    types: v.optional(v.array(v.string())),
    // "discovered" = from a real provider enumeration; "manual" = admin fallback
    // when the provider cannot enumerate (agentDiscovery:false) => UNVERIFIED.
    source: v.union(v.literal("discovered"), v.literal("manual")),
    // Was this agent present in the most recent SUCCESSFUL poll? false +
    // instanceDiscovery.lastPollOk === true => deleted on the gateway. A FAILED
    // poll never flips this (serve last-good). Manual rows: always true.
    presentInLastOk: v.boolean(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(), // last successful poll that INCLUDED it
  })
    .index("by_instance", ["instanceName"])
    .index("by_instance_agent", ["instanceName", "agentId"])
    // Bounded scan of the no-group all-pool: only DISCOVERED (assignable) +
    // PRESENT (not gateway-deleted) rows, capped, on the listChats/getChatAgent hot
    // paths (see loadAllAgentsPool) -- so deleted/manual rows never consume the cap.
    .index("by_source_present", ["source", "presentInLastOk"]),

  // The M:N join: which agents a user may use. user↔instance is DERIVED from this
  // (no second grant table). INVARIANT: exactly one isDefault === true WHENEVER
  // the user has >=1 row (enforced in the mutations via a by_user range read —
  // red-team H3). Authorization for chat binding + dispatch checks membership
  // here (red-team B / IDOR).
  userAgents: defineTable({
    userId: v.id("users"),
    instanceName: v.string(),
    agentId: v.string(),
    isDefault: v.boolean(),
    // "manual" = admin-assigned; "auto" = best-effort convention prefill.
    source: v.union(v.literal("manual"), v.literal("auto")),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_instance_agent", ["userId", "instanceName", "agentId"])
    // Targeted read for the instance-deletion cascade (admin.deleteInstance) so it
    // never has to scan the whole table — Convex read/write doc limits (Codex P2).
    .index("by_instance", ["instanceName"])
    // Scale-safe paginated delete of ALL users' grants for one removed agent
    // (admin removeInstanceAgent cascade).
    .index("by_instance_agent", ["instanceName", "agentId"]),

  // ===========================================================================
  // GROUPS (P2). Regroup users + share agents by group. Admin-managed only (no
  // intra-group RBAC, no soft-delete — see docs/GROUPS_CHARTS_P2_SPEC.md). Group
  // agents are NOT materialized into `userAgents`: the user↔agent union is
  // computed at READ time (enrichUserAgents / resolveTargetForChat), so there is
  // no drift and the "exactly one isDefault per user" invariant stays on DIRECT
  // userAgents only.
  // ===========================================================================

  // A named group of users. `key` is a stable slug derived from `name` at
  // creation (collision-safe), used as the provenance token in resolvers
  // (`via: { group: key }`). Renaming never changes the key.
  groups: defineTable({
    key: v.string(), // stable slug, unique
    name: v.string(),
    description: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_key", ["key"]),

  // M:N membership user↔group (multi-membership allowed). `by_user_group` serves
  // both the dedup-on-add check and the per-user membership lookup feeding the
  // agents union; `by_user` powers listMyGroups (and is ready to back a
  // groupMembers purge WHEN a user-deletion path is added — none exists today).
  groupMembers: defineTable({
    groupId: v.id("groups"),
    userId: v.id("users"),
    joinedAt: v.number(),
    // ADMIN-set delegation: a member promoted to MANAGER of THIS group may
    // administer it (membership + agents + charts of this group ONLY) when they
    // also hold the grantable `groups.manage` permission. Admin-only to set
    // (promote/demote); create/delete-group + this promotion stay admin-only.
    // OPTIONAL → unset/false = a plain member (consumes the group, doesn't manage).
    manager: v.optional(v.boolean()),
  })
    .index("by_group", ["groupId"])
    .index("by_user", ["userId"])
    .index("by_user_group", ["userId", "groupId"]),

  // Agents shared with a group (M:N group↔agent). `isDefault` is an OPTIONAL
  // per-group default with NO "exactly one per group" invariant (unlike
  // userAgents) — the read-time precedence simply picks the lowest deterministic
  // one when several are set. `by_instance` serves the deleteInstance cascade.
  groupAgents: defineTable({
    groupId: v.id("groups"),
    instanceName: v.string(),
    agentId: v.string(),
    isDefault: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_group", ["groupId"])
    .index("by_instance", ["instanceName"])
    .index("by_group_instance_agent", ["groupId", "instanceName", "agentId"]),

  // Charts (charte graphique) shared with a group (M:N group<->builtin chart).
  // Parallel to groupAgents. P3 stores ONLY this join (the `charts` custom table
  // arrives in P4). Availability convention (no scope column on builtins): a
  // builtin is COMMON (available to ALL users) UNLESS it has >=1 groupCharts row,
  // in which case it is RESTRICTED to members of those groups. `chartKey` is a
  // builtin key (convex/lib/charts.BUILTIN_CHART_KEYS); the assign mutation
  // rejects an unknown key. `by_group` serves the deleteGroup cascade; `by_chart`
  // powers the availability computation; `by_group_chart` serves the
  // assign/remove unique() dedup (mirrors groupAgents' by_group_instance_agent).
  //
  // 3-TIER charts model: this table is the GROUP MANAGER's SELECTION (Tier 2 —
  // "the group DOES offer this chart to its members"), constrained by the admin
  // POOL (Tier 1, groupChartPool). `isDefault` is the group's default chart
  // (Tier-2 default) — OPTIONAL; the selection/election logic (Phase B step 2)
  // keeps it consistent. ENFORCEMENT (resolveChart group tier) lands in step 3 —
  // until then `isDefault` is set-but-not-read (inert), like the agent curation.
  groupCharts: defineTable({
    groupId: v.id("groups"),
    chartKey: v.string(),
    isDefault: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_group", ["groupId"])
    .index("by_chart", ["chartKey"])
    .index("by_group_chart", ["groupId", "chartKey"]),

  // Tier 1 of the 3-tier charts model: the admin-defined POOL of charts a group
  // MAY offer ("applicable au groupe"). A group MANAGER may then SELECT a subset
  // into groupCharts (Tier 2). Admin-managed ONLY (CHARTS_MANAGE); a manager can
  // never widen their own pool. `chartKey` is a builtin OR custom key (the pool
  // mutation rejects an unknown key). INERT in step 1 (nothing reads it for
  // availability yet — the manager-selection gate that consults it lands in step
  // 2). `by_group` serves the deleteGroup cascade + the pool listing; `by_chart`
  // serves the deleteChart cascade; `by_group_chart` serves the add/remove
  // unique() dedup (mirrors groupCharts' by_group_chart).
  groupChartPool: defineTable({
    groupId: v.id("groups"),
    chartKey: v.string(),
    createdAt: v.number(),
  })
    .index("by_group", ["groupId"])
    .index("by_chart", ["chartKey"])
    .index("by_group_chart", ["groupId", "chartKey"]),

  // Custom charts (charte graphique) IMPORTED by users (P4) -- builtins stay in
  // code (convex/lib/charts.ts). `key` is a server-minted unique slug, DISJOINT
  // from BUILTIN_CHART_KEYS (importChart rejects/retries a collision) so the
  // key -> tokens dispatch in getMe/listMyCharts is unambiguous. `tokens` holds
  // the SERVER-RE-SERIALIZED tokens (validateChartTokens output) -- NEVER the raw
  // client string (the typed-token allowlist closes the injection surface). The
  // color-token map is stored as a free string->string record (the closed set of
  // keys is enforced at WRITE time by the validator, not by the column shape --
  // the schema cannot express "only COLOR_TOKENS keys").
  //   - scope "personal": ownerUserId REQUIRED; available to the owner + members
  //     of the groups it is assigned to (groupCharts).
  //   - scope "common":   ownerUserId ABSENT; available to ALL (promoteChartToCommon
  //     clears ownerUserId). Admin-managed only.
  // groupCharts.chartKey already references a chart key (builtin OR custom); the
  // assign gate (admin OR owner+member) governs which keys a non-admin may join.
  charts: defineTable({
    key: v.string(), // unique slug, disjoint from builtins
    name: v.string(),
    scope: v.union(v.literal("personal"), v.literal("common")),
    ownerUserId: v.optional(v.id("users")), // REQUIRED for personal, absent for common
    tokens: v.object({
      colors: v.object({
        light: v.record(v.string(), v.string()),
        dark: v.record(v.string(), v.string()),
      }),
      radius: v.optional(v.string()),
      fontSans: v.optional(v.string()),
      fontMono: v.optional(v.string()),
      bpm: v.optional(v.number()), // heartbeat ambient pulse (0/absent = static)
    }),
    // Brand logos shown in the top bar when this chart is active (label = chart
    // `name`), one per theme mode. Uploaded images are normalized to WebP and
    // served via <img src> only — never inlined — so they carry no script. Absent
    // => the bundled Atrium mark (default chart) or the other mode's logo / label
    // alone (custom). See convex/charts.ts (setChartLogo / resolveChartView).
    logoLightStorageId: v.optional(v.id("_storage")),
    logoDarkStorageId: v.optional(v.id("_storage")),
    // Whether each uploaded logo is ALPHA-defined (a transparent-background
    // silhouette) vs an opaque rectangle. Computed at upload (processLogoImage).
    // The chat avatar masks an alpha logo in `--primary-foreground` (guaranteed
    // contrast on the `--primary` tile, both modes); an opaque logo can't be
    // silhouetted, so it falls back to a plain <img>. Absent => treated as opaque.
    logoLightHasAlpha: v.optional(v.boolean()),
    logoDarkHasAlpha: v.optional(v.boolean()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_owner", ["ownerUserId"])
    .index("by_scope", ["scope"]),

  // Domain -> chart mapping ("charte par domaine"): when Atrium is accessed at a
  // matching host, that chart becomes the DEFAULT (login + app), subject to the
  // group junction at resolution. `domain` is the canonical pattern from
  // convex/lib/domains.ts (exact host OR "*.base" wildcard, base >= 2 labels).
  // `by_domain` is UNIQUE per domain (enforced at write) so resolution can do a
  // bounded point-read per host candidate — never a scan. Admin-managed.
  chartDomains: defineTable({
    chartKey: v.string(),
    domain: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_domain", ["domain"])
    .index("by_chart", ["chartKey"]),

  // Singleton app metadata. Exactly one row (key === "singleton"). Acts as the
  // serialization point for first-admin bootstrap: the first sign-in that finds
  // `adminAssigned === false` claims admin AND flips the flag in one
  // transaction; concurrent first sign-ins collide on THIS doc (OCC) and the
  // loser retries, sees the flag set, and becomes "pending".
  appMeta: defineTable({
    key: v.string(),
    adminAssigned: v.boolean(),
    // Global toggle reserved for future "require admin approval" policy; the
    // pending->user approval flow is always on for now.
    requireApproval: v.optional(v.boolean()),
    // Admin-defined default theme mode, used when a user has no preference.
    // OPTIONAL: when unset, the resolver falls back to "system".
    defaultThemeMode: v.optional(
      v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
    ),
    // Admin-defined GLOBAL default chart (charte graphique) key (P3). Used when a
    // user has no pick (or their pick is no longer available). A builtin key, or
    // unset = the native index.css look. Written ONLY via charts.setDefaultChart
    // (CHARTS_MANAGE), which rejects a key not in BUILTIN_CHART_KEYS.
    defaultThemeName: v.optional(v.string()),
    // Admin-defined default UI language, used when a user has no `locale` pref.
    // OPTIONAL: unset => resolver falls back to BASE_LOCALE. Plain string like
    // profiles.locale — validated at the setter against SUPPORTED_LOCALES.
    defaultLocale: v.optional(v.string()),
    // Admin-defined DEFAULTS for the UI preferences module (inherited by users
    // who have no override). Same keys as profiles.uiPrefs / UI_PREF_KEYS.
    uiPrefDefaults: v.optional(
      v.object({
        showSource: v.optional(v.boolean()),
        showReport: v.optional(v.boolean()),
        copyAssistant: v.optional(v.boolean()),
        copyUser: v.optional(v.boolean()),
        showDelete: v.optional(v.boolean()),
        showTools: v.optional(v.boolean()),
        voiceInput: v.optional(v.boolean()),
        showChatAge: v.optional(v.boolean()),
        showChatProvider: v.optional(v.boolean()),
        showUsage: v.optional(v.boolean()),
        autoReadAloud: v.optional(v.boolean()),
      }),
    ),
    // System-level feature enablement. A gated UI pref (e.g. voiceInput) stays
    // locked/greyed and cannot be turned on by users until the admin enables the
    // underlying system here. Absent => not enabled.
    featuresEnabled: v.optional(
      v.object({
        voiceInput: v.optional(v.boolean()),
      }),
    ),
  }).index("by_key", ["key"]),

  // Append-only audit trail for cross-identity (impersonation) actions. Records
  // WHO really acted (`realUserId` = the admin) and AS WHOM (`effectiveUserId` =
  // the impersonated target), so every create / delete / send performed "in
  // place of" a user is attributable to the real operator — the traceability
  // requirement for the impersonation module. This is a NEW table (no existing
  // rows) so its fields are required. NEVER stores message content or other PHI:
  // only the action verb + the resource kind/id that was touched.
  //
  // APPEND-ONLY (SOC2 CC7.3): rows are only ever INSERTED (lib/audit.recordAudit
  // — the sole writer). There is intentionally NO mutation anywhere that patches
  // or deletes an auditLog row (enforced by code review + grep, see
  // compliance/API_CONTROLS.md §7). It is NOT retention-purged (unlike traceEvents)
  // so the trail survives the full audit period.
  auditLog: defineTable({
    at: v.number(),
    action: v.string(), // e.g. "chat.create", "chat.delete", "impersonation.start"
    realUserId: v.id("users"), // the actual signed-in operator
    effectiveUserId: v.id("users"), // the identity the action ran as
    impersonated: v.boolean(), // realUserId !== effectiveUserId
    resource: v.optional(v.string()), // resource kind, e.g. "chat", "project", "message"
    resourceId: v.optional(v.string()),
  })
    .index("by_time", ["at"])
    .index("by_real", ["realUserId"]),

  // Full before/after revision log for agent workspace-file writes (CONF-4c,
  // amendment A4: audit with COMPLETE before/after content + rollback source).
  // One row per successful `agentFiles.setAgentFile`; content is bounded by the
  // 64k write cap, so full copies are cheap. Writes are admin-only, so this
  // table stays small. NON-PHI by policy: these are agent RULE files — MEMORY/
  // USER files are admin-only even in read (A3), and their writes land here too,
  // visible only through admin-gated surfaces.
  agentFileRevisions: defineTable({
    instanceName: v.string(), // -> instances.name
    agentId: v.string(), // -> agents.agentId (on instanceName)
    name: v.string(), // workspace file name, e.g. "AGENTS.md"
    before: v.string(), // full content as read by the bridge BEFORE the write
    after: v.string(), // full content written
    byUserId: v.id("users"), // the REAL operator (impersonation-aware audit)
    at: v.number(),
  }).index("by_agent_file", ["instanceName", "agentId", "name"]),

  // Agent-file CURATION jobs (auto-management of over-budget agent files). A
  // specialist rationalizes an over-budget file into a PROPOSED revision an admin
  // reviews + approves — the file is NEVER auto-written (silent semantic data
  // loss is the #1 risk). PII HYGIENE: `beforeContent`/`proposedContent` are
  // copies of file content (MEMORY.md holds other users' data) — they are PURGED
  // when the job resolves (applied/rejected/failed), the durable before/after
  // living only in agentFileRevisions on apply.
  agentFileCurations: defineTable({
    instanceName: v.string(),
    agentId: v.string(),
    name: v.string(), // the agent workspace file, e.g. "MEMORY.md"
    // Lifecycle: dispatched -> proposed (specialist replied) -> applied | rejected
    //            | failed (dispatch/validation/stuck). Only "proposed" holds content.
    status: v.union(
      v.literal("dispatched"),
      v.literal("proposed"),
      // Transient: an approve CLAIMED the proposal (transactional lock) and is
      // mid bridge-write. A reject can no longer touch it (race guard).
      v.literal("applying"),
      v.literal("applied"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    // The file's updatedAtMs when the job READ it — the CAS base for the apply
    // (a concurrent edit since then -> 409, re-curate needed, never a clobber).
    baseUpdatedAtMs: v.union(v.number(), v.null()),
    beforeSize: v.number(), // bytes of the source (for the UI + the never-grow guard)
    // TRANSIENT content (purged on resolve): the source + the specialist proposal.
    beforeContent: v.optional(v.string()),
    proposedContent: v.optional(v.string()),
    proposedSize: v.optional(v.number()),
    budgetChars: v.number(), // the target budget this job curated toward
    requestedByUserId: v.id("users"),
    // "auto" (cron) vs "manual" (admin button) — drives the notification copy.
    trigger: v.union(v.literal("auto"), v.literal("manual")),
    // Admin guidance THIS job was seeded with (the rejection comment of the
    // previous proposal, woven into the curator prompt on a relaunch).
    feedback: v.optional(v.string()),
    // What the admin said when rejecting THIS row (kept for the loop's audit).
    rejectionComment: v.optional(v.string()),
    failureReason: v.optional(v.string()), // stable code on status "failed"
    appliedRevisionAt: v.optional(v.number()), // links to agentFileRevisions on apply
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_target", ["instanceName", "agentId", "name"])
    // For the admin list: newest-first ACROSS files (a fresh proposal for one
    // file must not be masked by many rows of another under a name-first sort).
    .index("by_target_updated", ["instanceName", "agentId", "updatedAt"])
    .index("by_status", ["status", "updatedAt"]),

  // A user's project: a named grouping of chats in the sidebar. Per-user.
  projects: defineTable({
    userId: v.id("users"),
    name: v.string(),
    sortKey: v.optional(v.number()), // fractional order key
    color: v.optional(v.string()), // preset token name
    collapsed: v.optional(v.boolean()),
  }).index("by_user", ["userId"]),

  // A chat thread owned by exactly one user.
  chats: defineTable({
    userId: v.id("users"),
    title: v.optional(v.string()),
    // The OpenClaw-side chat identifier (used to route sends). Non-secret.
    openclawChatId: v.optional(v.string()),
    // The agent this chat is BOUND to (chosen at creation; auto when the user has
    // exactly one agent, else via the picker). WRITE-ONCE after first dispatch
    // (the sessionKey embeds agentId+canonical → a silent swap forks the gateway
    // session AND changes the idempotencyKey → red-team H1). Non-secret names.
    // OPTIONAL + additive: legacy chats (both null) resolve to the user's default
    // agent at dispatch (docs/MULTI_AGENT_REDESIGN.md §3.3).
    instanceName: v.optional(v.string()), // -> instances.name
    agentId: v.optional(v.string()), // -> agents.agentId (on instanceName)
    // MULTI-AGENT per-turn router (additive). A chat starts SINGLE-agent (the binding
    // above). It flips to `perTurnRouting` the first time a turn is routed to an agent
    // other than the primary; thereafter every turn carries an explicit agent. To keep
    // the locked "the called agent sees the FULL thread" guarantee without re-shipping
    // history every turn, the gateway session is re-keyed ONLY on an agent SWITCH
    // (epoch-on-switch): `routingSegment` (= `turn:<turnId>`) is the openclawChatId the
    // bridge keys on; it changes on a switch (so the fresh-session gate rehydrates the
    // newly-routed agent) and stays stable within a same-agent run (warm, no re-ship).
    // `lastRouted*` is the previous turn's agent, used to detect the switch. Distinct
    // from getChatAgent's `multiAgent` (= "the USER has >1 agent available").
    perTurnRouting: v.optional(v.boolean()),
    lastRoutedInstanceName: v.optional(v.string()),
    lastRoutedAgentId: v.optional(v.string()),
    routingSegment: v.optional(v.string()),
    // HIDDEN per-user utility chats (absent = a normal conversational chat):
    //  - "documentary": hosts L2 document-fetch turns (own gateway session so the
    //    conversational chats are never re-keyed);
    //  - "summarizer": hosts hybrid-rehydration rolling-summary turns (same hidden
    //    pattern; see docs/design/hybrid-rehydration.md).
    // Both are excluded from the sidebar/search.
    kind: v.optional(
      v.union(
        v.literal("documentary"),
        v.literal("summarizer"),
        // "curator": hosts agent-file curation turns — a specialist rationalizes
        // an over-budget agent file (MEMORY.md, rules) into a PROPOSED revision an
        // admin reviews + approves. Same hidden per-user pattern.
        v.literal("curator"),
      ),
    ),
    // The in-flight documentary fetch this hidden chat is serving — its CONVERSATIONAL
    // source message. Set at dispatch, read at finalize to correlate returned files to
    // the source's references, then cleared. Only meaningful on a `kind:"documentary"`
    // chat. Fetches serialize (one in flight per hidden chat).
    pendingFetch: v.optional(
      v.object({ sourceMessageId: v.id("messages"), createdAt: v.number() }),
    ),
    // Hybrid rehydration: the in-flight SUMMARIZE job this hidden chat is serving.
    // Set at dispatch, read at finalize to store the reply as the target chat's new
    // rolling summary, then cleared. Only meaningful on a `kind:"summarizer"` chat;
    // jobs serialize (one in flight per hidden chat, i.e. per user).
    pendingSummarize: v.optional(
      v.object({
        targetChatId: v.id("chats"),
        // The effectiveOrder of the LAST message the dispatched chunk covers — the
        // summary watermark to advance to on success.
        watermarkTarget: v.number(),
        coveredCountTarget: v.number(),
        createdAt: v.number(),
      }),
    ),
    // Agent-file curation: the in-flight CURATION job this hidden chat is serving.
    // Set at dispatch, read at finalize to store the specialist's reply as a
    // PROPOSED revision (never written live — an admin approves). Only meaningful
    // on a `kind:"curator"` chat; jobs serialize (one in flight per hidden chat).
    pendingCurate: v.optional(
      v.object({
        curationId: v.id("agentFileCurations"),
        createdAt: v.number(),
      }),
    ),
    archived: v.optional(v.boolean()),
    updatedAt: v.number(),
    // Sidebar organization (all optional — additive on existing rows):
    projectId: v.optional(v.id("projects")), // 0-or-1 project membership
    sortKey: v.optional(v.number()), // fractional manual order (lower = higher)
    pinned: v.optional(v.boolean()), // pinned chats sort above unpinned
    color: v.optional(v.string()), // preset token name, list display only
    // OpenClaw session meta, mirrored from the gateway's self-describing
    // `sessions.describe({ key })` so the chat header can surface the model,
    // reasoning (thinking) level, verbosity, and the context-usage meter without
    // the frontend hardcoding any enum. The bridge refreshes this per turn; it is
    // READ-ONLY here (write-back via a later `sessions.patch` increment). Fully
    // OPTIONAL + every inner field optional → additive on existing rows AND
    // forward-compatible (a new thinking level / model surfaces with no schema
    // change). NEVER holds secrets — model/level names are non-sensitive.
    sessionMeta: v.optional(
      v.object({
        model: v.optional(v.string()), // e.g. "gpt-5.5"
        modelProvider: v.optional(v.string()), // e.g. "openai-codex"
        agentRuntime: v.optional(v.string()), // e.g. "codex"
        thinkingLevel: v.optional(v.string()), // current effective level
        thinkingDefault: v.optional(v.string()), // agent default (inheritance src)
        thinkingLevels: v.optional(
          v.array(v.object({ id: v.string(), label: v.string() })),
        ),
        // Available models for the write-back picker, mirrored once from the
        // gateway's `models.list` (deduped by id). Non-secret labels only.
        availableModels: v.optional(
          v.array(v.object({ id: v.string(), label: v.string() })),
        ),
        verboseLevel: v.optional(v.string()), // e.g. "full"
        totalTokens: v.optional(v.number()), // used context tokens
        contextTokens: v.optional(v.number()), // context window size
        estimatedCostUsd: v.optional(v.number()),
        updatedAt: v.optional(v.number()),
      }),
    ),
    // User-chosen per-chat OpenClaw overrides (write-back via `sessions.patch`).
    // INTENT, distinct from `sessionMeta` (the gateway's confirmed live TRUTH):
    // the bridge applies these immediately when changed AND re-applies them
    // before each turn so they survive a session reset/roll. Optional + additive
    // + every inner field optional → forward-compatible. NEVER holds secrets.
    sessionSettings: v.optional(
      v.object({
        thinkingLevel: v.optional(v.string()), // reasoning level id
        model: v.optional(v.string()), // model id
        fastMode: v.optional(v.boolean()), // CONF-4a "Vitesse" (bench: true/false/null patchable)
        // Field names UNSET by the user (per-line ↺). Persisted IN the intent so
        // an unset survives a bridge outage exactly like a set: the bridge
        // re-applies `{<field>: null}` per turn (idempotent). A field is removed
        // from `clears` when it is set again. (Red-team P2-4.)
        clears: v.optional(v.array(v.string())),
      }),
    ),
  })
    .index("by_user", ["userId"])
    // Hidden-utility-chat lookups (the summarizer engine checks per turn-finalize):
    // point-read instead of scanning all the user's chats (codex P2).
    .index("by_user_kind", ["userId", "kind"])
    // Bounded sidebar read (listChats): most-recent window by updatedAt + the
    // pinned set of ANY age, so a user's chat list can grow without listChats
    // ever doing an unbounded .collect() (which busts Convex's per-function op
    // budget on a heavy account — observed in prod).
    .index("by_user_updated", ["userId", "updatedAt"])
    .index("by_user_pinned", ["userId", "pinned"])
    .index("by_project", ["projectId"]),

  // Individual messages within a chat. Streaming assistant text is patched in
  // place on `text` (reactivity -> assistant-ui re-render).
  messages: defineTable({
    // The gateway session key this ASSISTANT turn ran under (bridge echo via
    // startAssistant; absent on user rows + pre-feature turns). Internal join key
    // (deterministic reply-to-send correlation for the summarize engine); never
    // projected to clients.
    turnSessionKey: v.optional(v.string()),
    chatId: v.id("chats"),
    userId: v.id("users"), // owner (denormalized for cheap access checks)
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    runId: v.optional(v.string()), // OpenClaw runId for assistant turns
    // MULTI-AGENT per-turn routing: which agent THIS turn was routed to — the user
    // message the user addressed to a specialist, and the assistant reply that answered
    // it. One visible thread can route different turns to different agents; these record
    // the per-turn agent so the thread attributes each reply and the composer can default
    // to the last-used agent. ABSENT/undefined = the chat's primary agent (chat.agentId) —
    // backward-compatible with every existing single-agent message.
    routedInstanceName: v.optional(v.string()),
    routedAgentId: v.optional(v.string()),
    // LOGICAL turn-order key (see lib/messageOrder). Set ONLY on a mid-turn QUEUE
    // follow-up: a SENTINEL while parked (sorts last), re-stamped to the real dispatch
    // time on drain. Unset for idle sends + assistant messages (their _creationTime IS
    // their order). Consumers order by `effectiveOrder` (orderTime ?? _creationTime).
    orderTime: v.optional(v.number()),
    status: v.union(
      v.literal("streaming"),
      v.literal("complete"),
      v.literal("error"),
      v.literal("aborted"),
    ),
    text: v.string(),
    // A2 streaming (decision A2): during a turn, token deltas are patched into
    // this UN-INDEXED live field — NOT into `text` — so each ~50ms flush does NOT
    // re-index the search index (the per-flush reindex amplifier). At finalize the
    // authoritative text is written ONCE into the searchable `text` and `liveText`
    // is cleared. `listByChat` returns `liveText` while streaming, `text` when done,
    // so the browser streams token-by-token with no frontend change and `text`
    // stays the single searchable/durable copy. OPTIONAL (additive on existing rows).
    liveText: v.optional(v.string()),
    error: v.optional(v.string()),
    // The STABLE, curated dispatch error CODE (non-PHI: AGENT_NOT_FOUND,
    // ATTACHMENT_TOO_LARGE, …), stored alongside the user-facing `error` text so a
    // diagnosis can read the code without parsing a localized phrase. OPTIONAL.
    errorCode: v.optional(v.string()),
    // L2: count of READY downloadable document attachments fetched for THIS
    // assistant message (denormalized by correlateDocumentaryFetch). Drives the
    // subtle "joints" badge on the Sources chip without a per-message query.
    // OPTIONAL (additive; absent/undefined = none).
    attachedDocCount: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_chat", ["chatId"])
    // (chatId, status): exact "does this chat have a streaming turn?" check for the
    // mid-turn send serialization (lib/outboxQueue.isChatBusy) — .first() on the
    // (chat, "streaming") point range, no per-chat scan.
    .index("by_chat_status", ["chatId", "status"])
    // Bounded scan for the stuck-stream watchdog: a message left `status:
    // "streaming"` whose `updatedAt` is far in the past = the bridge lost the
    // run's WS subscription and never relayed the finalize frame (the UI then
    // shows "Réflexion…" forever AND hides the per-message actions, since a
    // streaming message keeps the runtime `isRunning`). The reconciler ranges
    // exactly the streaming set ordered by updatedAt and flips the stale ones.
    .index("by_status_updated", ["status", "updatedAt"])
    // Full-text search over message bodies for the global conversation search
    // (topbar palette). `userId` is a filter field so a single index serves the
    // owner-scoped query directly: q.search("text", term).eq("userId", userId).
    // This is THE access boundary for message hits — never search without it.
    // Note: `text` is patched in place during streaming, so this index re-indexes
    // on each token patch; acceptable at our scale (metadata-only platform).
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["userId"],
    }),

  // Structured non-text content attached to a message, ordered for rendering.
  messageParts: defineTable({
    messageId: v.id("messages"),
    order: v.number(),
    part: messagePart,
  }).index("by_message", ["messageId"]),

  // SUB-AGENT observation store (increment 1 of the sub-agent monitor). A chat's
  // agent can spawn an isolated child via the gateway `sessions_spawn` tool; the
  // child runs on its OWN lane and OUTLIVES the parent turn (the parent often ends
  // before the child finishes). The bridge OBSERVES those child frames — inbound
  // only, never altering what Atrium sends — and upserts one row per child here so
  // the chat can later surface "a delegation is running / finished" + its result.
  //
  // INVARIANT: at most one row per `childSessionKey` (the upsert key). `status`
  // tracks the child lifecycle (from the child-lane frame, the reliable signal):
  // `running` (spawn observed / lifecycle phase), `done` (child `chat:final`),
  // `error` (child `chat:state==="error"` / lifecycle `phase==="error"` — failed or
  // timed-out — OR the observer's own TTL watchdog firing on a silent hang),
  // `aborted` (child `chat:state==="aborted"` — user /stop / cancel). CONTENT NOTE:
  // `resultText` is the child's own answer and `errorMessage` the failure reason
  // (the user's chat data, owner-scoped like `messages`), server-paths stripped by
  // the bridge before they land here.
  subAgents: defineTable({
    chatId: v.id("chats"),
    // The parent assistant message the spawn happened under. The observer is fed the
    // run's current streaming messageId (session.ts -> runManager.currentMessageId),
    // so a spawn registered DURING the parent turn carries it -> the per-message card
    // correlation + the panel's "jump to the spawning message" use it. Still OPTIONAL:
    // a child lazily registered from its own later frames (spawn result missed) can
    // land without it. by_chat is the load-bearing index.
    parentMessageId: v.optional(v.id("messages")),
    childSessionKey: v.string(), // `agent:<id>:subagent:<uuid>` — the upsert key
    taskName: v.optional(v.string()), // best-effort, parsed from the spawn tool meta
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
      v.literal("aborted"),
    ),
    resultText: v.optional(v.string()), // the child's final answer (server-paths stripped)
    errorMessage: v.optional(v.string()), // failure reason on error (paths stripped)
    phase: v.optional(v.string()), // last observed lifecycle phase (e.g. "startup")
    // The tools the CHILD called — NAME + lifecycle status ONLY (SOC2: never the
    // args/results, which are the child's retrieved/produced CONTENT). Lets a
    // sub-agent surface the SAME tool detail as a main-agent turn. Deduped by
    // toolCallId by the observer; "done" wins over "running" on a reordered merge.
    tools: v.optional(
      v.array(
        v.object({
          name: v.string(),
          status: v.union(v.literal("running"), v.literal("done")),
          toolCallId: v.optional(v.string()),
        }),
      ),
    ),
    // The child's STATIC session config (captured from `payload.session` on the child
    // frames, merged last-known). Drives the panel's session bar (model / reasoning /
    // speed / scope) + the Advanced popover. These are CONFIG, not content -- SOC2-safe,
    // so the obs MCP may surface them too (unlike resultText/tool args). Deliberately
    // NO live telemetry (tokens/cost/runtime) here: those change every frame and would
    // turn this into a write-per-tick. parentSessionKey is NOT stored raw (it embeds
    // the canonical+chatId); the parent AGENT is resolved to a display name in-app.
    sessionMeta: v.optional(
      v.object({
        model: v.optional(v.string()),
        modelProvider: v.optional(v.string()),
        thinkingLevel: v.optional(v.string()),
        fastMode: v.optional(v.boolean()),
        controlScope: v.optional(v.string()),
        subagentRole: v.optional(v.string()),
        spawnDepth: v.optional(v.number()),
        // Spawn-time config (from the sessions_spawn ARGS, correlated by toolCallId).
        // ALL optional + rendered only when present — `context` in particular is
        // usually ABSENT (gateway-defaulted), so never fabricate "isolated". `context:
        // "fork"` branches the parent transcript into the child (a HIGHER-SENSITIVITY
        // signal for the child's captured content — still config, never widens MCP).
        context: v.optional(v.string()), // "isolated" | "fork"
        runtime: v.optional(v.string()), // "subagent" | "acp"
        mode: v.optional(v.string()), // "run" | "session"
        cleanup: v.optional(v.string()), // "delete" | "keep"
        sandbox: v.optional(v.string()), // "inherit" | "require"
        // The SOURCE gateway kind (from session.agentRuntime.id, e.g. "openclaw") — the
        // provider SEAM so a Hermes mapping can slot in later; the field NAMES above are
        // OpenClaw-specific, captured by the OpenClaw observer.
        gatewayKind: v.optional(v.string()),
        // Extended spawn args (label / cwd / target agentId / lightContext) + child
        // session statics (sessionId = the gateway `/subagents log` join key,
        // spawnedWorkspaceDir = the child's effective working directory). Same
        // sensitivity class as taskName (config; sanitized/capped bridge-side).
        label: v.optional(v.string()),
        cwd: v.optional(v.string()),
        agentId: v.optional(v.string()),
        lightContext: v.optional(v.boolean()),
        sessionId: v.optional(v.string()),
        spawnedWorkspaceDir: v.optional(v.string()),
      }),
    ),
    // Run TELEMETRY (runtime / tokens / estimated cost) — content-free numbers. The
    // bridge attaches the last-known values ONLY to upserts it already writes
    // (heartbeat + terminal), so observation never becomes a write-per-tick; once
    // terminal the final numbers stand (no backwards rolls from straggler frames).
    telemetry: v.optional(
      v.object({
        runtimeMs: v.optional(v.number()),
        totalTokens: v.optional(v.number()),
        estimatedCostUsd: v.optional(v.number()),
        startedAt: v.optional(v.number()),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_chat", ["chatId"])
    .index("by_child", ["childSessionKey"])
    // Point-range for the send-hold busy check (lib/outboxQueue.isChatBusy): read ONLY
    // the (chat, "running") slice with .first(), so the hot send/drain path is bounded
    // regardless of how many TERMINATED sub-agents a long-lived chat has accumulated
    // (a by_chat scan + JS status filter would read the whole per-chat history).
    .index("by_chat_status", ["chatId", "status"])
    // (chatId, status, updatedAt): the chat-state diagnostic summary
    // (messages.loadSubAgentSummary) reads each per-chat status slice ORDERED BY
    // updatedAt — the staleness signal the detectors key on — so a capped sample
    // surfaces the right rows: running ASC (stalest-updated first => the stuck child
    // is always in the cap, so the subagent_stuck detector is never blind to it),
    // error/aborted DESC (most-recently-updated first => a recent failure is in the
    // cap). by_chat_status only orders by _creationTime, which can drop exactly the
    // stale running rows the stuck check needs (Codex P2).
    .index("by_chat_status_updated", ["chatId", "status", "updatedAt"])
    // Bounded scan for the stale-sub-agent reaper (subAgents.reapStaleSubAgents):
    // a `running` row is a best-effort observer write, and since a running row gates
    // isChatBusy, a dead observer (dropped terminal / bridge restart / connection-
    // close killing its in-memory TTL watchdog) would hold the chat forever. The
    // reaper ranges the (status="running", updatedAt < cutoff) slice and terminalizes
    // those rows. Mirrors messages.by_status_updated: a live child has a fresh
    // updatedAt → outside the range → never read (no full scan).
    .index("by_status_updated", ["status", "updatedAt"]),

  // In-app DETAIL for a sub-agent's tool calls (args + result), kept OFF the
  // `subAgents` doc on purpose: a 67-tool child would O(n^2)-re-push the whole
  // tools[] array on every per-tool upsert (the same write-amplification reason
  // `streamingText` is its own table). ONE row per (childSessionKey, toolCallId),
  // upserted per tool; the panel fetches them on demand when it opens (the
  // Sources-panel pattern). This is the user's OWN data shown IN-APP, so full
  // args/results are fine here -- the SOC2 content-free floor applies only to the
  // observability surfaces (MCP / KPI / traces), which never read this table.
  // Server PATHS are still stripped by the observer (infra-leakage scrub, orthogonal
  // to the content line). Bounded: <=100 parts/child (the observer's tool cap) and
  // each args/result capped, so a row stays small and the table stays per-child tiny.
  subAgentToolParts: defineTable({
    chatId: v.id("chats"),
    childSessionKey: v.string(),
    toolCallId: v.string(), // the dedupe key within a child (with childSessionKey)
    name: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
    ),
    argsText: v.optional(v.string()), // the call input (stringified, sanitized, capped)
    resultText: v.optional(v.string()), // the call output text (sanitized, capped)
    updatedAt: v.number(),
  })
    // Cascade delete with the chat (cascadeDeleteChat ranges this).
    .index("by_chat", ["chatId"])
    // Panel fetch: all parts for the open sub-agent.
    .index("by_child", ["childSessionKey"])
    // Upsert dedupe: the (child, toolCallId) point key.
    .index("by_child_tool", ["childSessionKey", "toolCallId"]),

  // Phase 2c — the user's DIRECT interaction with a sub-agent ("Interagir"): one row
  // per user message + the child's reply. The user's message is dispatched to the
  // CHILD session key via chat.send (verified live: the gateway routes it + the reply
  // streams back on the child lane); the bridge records the reply here. This is the
  // user's OWN conversation (in-app), so the reply text is stored in full; server
  // PATHS are stripped by the bridge. Keyed by chat (cascade) + child (panel thread).
  subAgentInteractions: defineTable({
    chatId: v.id("chats"),
    childSessionKey: v.string(),
    userText: v.string(), // the message the user sent to the sub-agent
    // Files the user attached to THIS message — METADATA ONLY (name + type), for the
    // thread to show "sent X"; the bytes ride the dispatch (resolved to base64), never
    // stored on the row.
    attachments: v.optional(
      v.array(v.object({ filename: v.string(), mimeType: v.string() })),
    ),
    replyText: v.optional(v.string()), // the sub-agent's answer (paths stripped)
    status: v.union(
      v.literal("pending"),
      v.literal("done"),
      v.literal("error"),
    ),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_chat", ["chatId"]) // cascade delete with the chat
    .index("by_child", ["childSessionKey"]), // the panel's interaction thread

  // LIVE streaming text for an in-flight assistant turn, kept OFF the `messages`
  // doc on purpose. The per-delta append/snapshot writes land here; the heavy
  // `loadChatView` reads the `messages` docs (NOT this table), so it no longer
  // re-runs + re-ships the whole window on every streaming delta — the dominant
  // backend cost when many users stream concurrently (O(streamers × window ×
  // deltas)). A cheap `getStreamingText` query reads this per delta instead.
  //
  // INVARIANT (transactional): a row exists for a message IFF that message is
  // `status:"streaming"`. startAssistant creates it (empty) WITH the message;
  // finalize deletes it WITH the lifecycle flip; the watchdog reap deletes it WITH
  // the error flip — all in one atomic mutation each, so the two tables never
  // desync. `updatedAt` is the streaming HEARTBEAT (the watchdog + chat-state read
  // it here, since the message's own updatedAt no longer moves during a turn).
  streamingText: defineTable({
    messageId: v.id("messages"),
    chatId: v.id("chats"),
    text: v.string(),
    updatedAt: v.number(),
    // Live PROCESSING PHASE of the in-flight turn (processing_history /
    // compacting / querying_gateway / awaiting_subagents) — shown by the
    // thinking placeholder when the user has Tools ON. Values validated at the
    // setPhase ingest op (allowlist); absent on plain turns.
    phase: v.optional(v.string()),
    // Delivery-latency recorder (OFF by default): when a recording session is
    // active, appendDelta/setSnapshot stamp the deliveryTimings row id (the unique
    // correlator) + server commit time of the last write here, so getStreamingText
    // echoes them in-band (~40B) and the frontend can close segment C (Convex->
    // frontend). Absent when not recording -> zero hot-path payload cost. See
    // convex/deliveryTiming.ts.
    recTimingId: v.optional(v.string()),
    recCommittedAt: v.optional(v.number()),
    // SSE transport (wire-streaming): the NEXT per-message chunk seq to assign — the
    // monotonic cursor for streamChunks (Last-Event-ID). Server-side state, so it's
    // restart-safe (unlike a bridge-held counter). See streamChunks below.
    chunkSeq: v.optional(v.number()),
  })
    .index("by_message", ["messageId"])
    .index("by_chat", ["chatId"])
    // The stuck-stream watchdog ranges by heartbeat (updatedAt < cutoff) — every
    // row here is by definition a streaming message, so no status column is needed.
    .index("by_updated", ["updatedAt"]),

  // Append-only per-message log of streamed text chunks, for the SSE / streamable-HTTP
  // transport (openclaw-notes/docs/atrium/convex-http-streaming-transport.md). One row per stream
  // write: appendDelta -> kind "append" (incremental text); setSnapshot -> kind
  // "replace" (full text — a gateway revision the consumer resets to). `seq` is the
  // per-message monotonic cursor (from streamingText.chunkSeq). GC'd at finalize.
  // Holds the message text itself (content), not a trace -> no SOC2 concern.
  streamChunks: defineTable({
    messageId: v.id("messages"),
    chatId: v.id("chats"),
    seq: v.number(),
    kind: v.union(v.literal("append"), v.literal("replace")),
    text: v.string(),
    // Delivery-latency recorder correlator (the deliveryTimings row id), present ONLY on a
    // chunk written during an active recording. It lets the SSE leg close segment C at the
    // ACTUAL displayed receipt (the frontend stamps t4 when this chunk arrives over SSE),
    // mirroring streamingText.recTimingId for the reactive leg. Absent = no recording.
    recTimingId: v.optional(v.string()),
  }).index("by_message_seq", ["messageId", "seq"]),

  // --- Delivery-latency recorder (convex/deliveryTiming.ts) -------------------
  // A controllable, content-free measurement of the bridge -> Convex -> frontend
  // delivery pipeline. OFF by default (zero hot-path cost). Started/stopped from
  // Settings>Traces or via MCP; correlated per delta by `seq`; reported skew-
  // corrected (segments A=bridge->Convex, B=Convex exec, C=Convex->frontend).

  // Singleton switch (key "singleton"). `sessionId` points at the active
  // deliverySessions row; `autoStopAt` is the safety cutoff (treated as OFF past it).
  deliveryRecording: defineTable({
    key: v.string(), // "singleton"
    enabled: v.boolean(),
    sessionId: v.optional(v.string()), // active deliverySessions _id (string), or undefined
    autoStopAt: v.optional(v.number()), // safety auto-stop epoch (now > this => OFF)
  }).index("by_key", ["key"]),

  // One row per record session (its _id is the sessionId stamped on every timing).
  deliverySessions: defineTable({
    startedAt: v.number(),
    startedBy: v.string(), // "admin:<userId>" | "agent:<serviceAccount>"
    autoStopAt: v.number(),
    stoppedAt: v.optional(v.number()),
    // Total recorded deltas (the "samples" column). Incremented per delta in
    // recordDelta so the sessions list reads it cheaply (no per-session row scan).
    count: v.optional(v.number()),
    // Per-session segment p50 summary (ms), computed ONCE shortly after the session stops
    // (computeSessionRollup) so the list + the evolution KPI read it cheaply — no per-session
    // timing scan on every list load. Absent until rolled up (active / legacy session);
    // each p50 is null when that segment had no samples.
    rollup: v.optional(
      v.object({
        bridgeP50: v.union(v.number(), v.null()),
        aP50: v.union(v.number(), v.null()),
        cP50: v.union(v.number(), v.null()),
      }),
    ),
  }),

  // One row per recorded delta. CONTENT-FREE: only timestamps + size. The row's
  // own `_id` IS the end-to-end correlator (echoed in-band as streamingText
  // .recTimingId) — unique by construction, so it survives a bridge restart / many
  // bridge processes where an in-memory counter would collide. Timestamps are raw
  // per-clock epochs; the report applies the skews. t4/clientSkew filled by the
  // frontend (batched, keyed by this _id).
  deliveryTimings: defineTable({
    sessionId: v.string(),
    t0: v.optional(v.number()), // bridge RECEIVED the first delta of this flush (bridge clock)
    chatId: v.id("chats"),
    t1: v.number(), // bridge sent (bridge clock)
    t2: v.number(), // Convex received (server clock)
    // t3 == t2: Convex freezes Date.now() within a mutation, so the exec gap t3-t2 is
    // structurally 0 — Convex exec time comes from Convex's own telemetry, not here.
    // Kept as the C-segment server anchor (= the mutation timestamp).
    t3: v.number(),
    t4: v.optional(v.number()), // frontend received (browser clock)
    bridgeSkew: v.optional(v.number()), // serverClock - bridgeClock offset
    clientSkew: v.optional(v.number()), // serverClock - browserClock offset
    sizeBytes: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),

  // Owner-scoped DENORMALIZATION of every file/media `messagePart`, so a user's
  // files are listable (Settings → Fichiers) WITHOUT iterating chats → messages →
  // parts (`messageParts` is only indexed `by_message`, and `part.kind` can't be
  // indexed inside the union). Same idiom as `messages.userId` / the `uploads`
  // ownership record. INVARIANT: a `files` row exists IFF a file/media part
  // exists for that message — enforced by routing every part insert/delete
  // through the paired helpers in lib/files (recordFileForPart / deleteFilesByMessage).
  //   - direction: "inbound" = user-uploaded (user message), "outbound" = agent-
  //     produced (assistant message). Derived from the message role at creation.
  //   - instanceName: the chat's bound bridge SNAPSHOT at creation (frozen so a
  //     later rebind can't mislabel it); undefined for an unbound chat. Degenerate
  //     today (single provider) — the filter self-hides like the sidebar badge.
  files: defineTable({
    userId: v.id("users"), // owner (denormalized)
    chatId: v.id("chats"),
    messageId: v.id("messages"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    kind: v.union(v.literal("file"), v.literal("media")),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    instanceName: v.optional(v.string()),
    // Coarse mimeType bucket, DENORMALIZED at creation so the listing can filter
    // by category SERVER-SIDE (before the cap) instead of post-cap in memory —
    // otherwise a category present only in files older than the cap window would
    // wrongly show "no results". OPTIONAL: legacy rows fall back to mimeCategory().
    category: v.optional(
      v.union(
        v.literal("image"),
        v.literal("audio"),
        v.literal("video"),
        v.literal("pdf"),
        v.literal("document"),
        v.literal("archive"),
        v.literal("other"),
      ),
    ),
    createdAt: v.number(),
    // Provenance of the file. "pasted" = auto-generated from a large composer
    // paste (the paste-as-file guard) — Settings › Fichiers hides those by
    // default behind a toggle, so the listing shows REAL user/agent files.
    // Absent = a real file. Additive; extensible (future: "dictated", ...).
    origin: v.optional(v.literal("pasted")),
    // SOFT DELETE: owner hides a file from their Settings › Fichiers listing
    // (files.softDelete). The row is KEPT (so the table invariant "a files row
    // exists iff a file/media part exists" still holds — the part is untouched)
    // and listMine + the facet window filter out rows with a `deletedAt`. Absent
    // = visible. Recoverable (clear the field); the storage blob is not GC'd here.
    deletedAt: v.optional(v.number()),
  })
    // `deletedAt` sits BEFORE `createdAt` in every listing index: listMine eq-binds
    // it to `undefined` (a missing optional is indexed as `undefined`, like the
    // notifications `by_user_unread` pattern), so the scan ranges ONLY live rows —
    // soft-deleted tombstones are never read, no matter how many a user accumulates.
    // The trailing `createdAt` still drives the desc ordering inside that prefix.
    // (by_message / by_storage stay tombstone-inclusive: the deleteMessage cascade
    // + the admin user-delete must see ALL rows, deleted or not.)
    .index("by_user_created", ["userId", "deletedAt", "createdAt"]) // unfiltered listing + facets
    .index("by_message", ["messageId"]) // cascade-delete mirror
    .index("by_storage", ["storageId"]) // GC / backfill dedup
    // Filtered listings: each puts the filter dimension in the index prefix so a
    // filter on a rare/old value scans only matching rows (not the whole owner
    // set up to the cap). listMine picks the index of the most-selective active
    // filter, then `.filter()`s any remaining dimensions.
    .index("by_user_chat", ["userId", "chatId", "deletedAt", "createdAt"])
    .index("by_user_category", ["userId", "category", "deletedAt", "createdAt"])
    .index("by_user_direction", ["userId", "direction", "deletedAt", "createdAt"])
    .index("by_user_instance", [
      "userId",
      "instanceName",
      "deletedAt",
      "createdAt",
    ])
    // Two-dimension cover for the ONE multi-filter combination reachable without
    // chatId: category + direction (both low-cardinality, so neither alone bounds
    // the residual scan). chatId-bearing combos stay bounded by the conversation
    // via by_user_chat; the category×instanceName / direction×instanceName combos
    // are only reachable under multi-provider (deferred #97) and get their own
    // composite indexes then. Both prefix columns are eq-constrained by listMine
    // so the trailing createdAt still drives desc ordering.
    .index("by_user_category_direction", [
      "userId",
      "category",
      "direction",
      "deletedAt",
      "createdAt",
    ]),

  // Ownership record for browser-uploaded storage blobs. There is no
  // server-side "upload completed" hook in Convex: `generateUploadUrl` returns
  // the signed URL BEFORE any storageId exists (the storageId only comes back
  // from the client's POST). So ownership is recorded register-at-confirm: the
  // attachment adapter calls `uploads.registerUpload({ storageId })` right
  // after the POST resolves, deriving the user via auth. `send.sendMessage`
  // then enforces IDOR by rejecting any attachment storageId not registered to
  // the calling user. NO secrets — just an opaque storage id keyed to a user.
  uploads: defineTable({
    storageId: v.id("_storage"),
    userId: v.id("users"),
  })
    // Single indexed lookup for the IDOR gate: (userId, storageId).
    .index("by_user_storage", ["userId", "storageId"])
    // Reverse lookup (e.g. GC / audit by blob).
    .index("by_storage", ["storageId"]),

  // Queue of outbound user messages awaiting dispatch to OpenClaw via the
  // bridge. `attachmentIds` reference Convex storage blobs uploaded by the
  // browser. The bridge is the only consumer that resolves these to the
  // gateway; the browser never sees gateway/filesystem details.
  //
  // Idempotency: a retried `sendMessage` (same `clientMessageId` from the same
  // user) MUST NOT double-insert the user message nor double-dispatch. The
  // `by_client_message` index lets `sendMessage` short-circuit on an existing
  // row; `messageId` is stored so the retry can return the original message id.
  outbox: defineTable({
    chatId: v.id("chats"),
    userId: v.id("users"),
    clientMessageId: v.string(),
    // The optimistic user message this outbox row was created for. Stored so a
    // deduped retry can return the original { messageId, outboxId } pair.
    messageId: v.optional(v.id("messages")),
    text: v.string(),
    attachmentIds: v.array(v.id("_storage")),
    // Inbound attachments WITH the browser-supplied filename + mimeType (the
    // dispatch needs both to build OpenClaw's chat.send.attachment shape — the
    // storageId alone loses them). Optional/additive: legacy rows only have
    // `attachmentIds`. The dispatch resolves storageId -> bytes -> base64.
    attachments: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          filename: v.string(),
          mimeType: v.string(),
        }),
      ),
    ),
    // MULTI-AGENT per-turn router: the agent the user addressed THIS turn to (absent =
    // the chat's primary, the unchanged single-agent path). Carried from sendMessage so
    // the dispatch routes the turn + epochs the session on a switch. Validated at the
    // dispatch trust boundary (resolveTargetForTurn), not merely in the composer.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
    status: v.union(
      // QUEUED (mid-turn send, Phase 1): inserted while the chat already has an
      // in-flight turn, held here until that turn ends. The drainer (lib/
      // outboxQueue.drainNextQueued) flips the oldest queued row of a chat to
      // `pending` + schedules dispatch once the chat is idle again — so only ONE
      // turn is ever in flight per chat (the bridge is one-turn-per-session).
      v.literal("queued"),
      v.literal("pending"),
      v.literal("sent"),
      v.literal("failed"),
    ),
  })
    .index("by_status", ["status"])
    // (chatId, status): the busy-check reads (chat, "pending") and the FIFO drain
    // reads (chat, "queued") ordered by _creationTime — both are point ranges, no
    // scan. The single-in-flight-turn serialization is built on this index.
    .index("by_chat_status", ["chatId", "status"])
    // Idempotency key scoped per user. (userId, clientMessageId) is effectively
    // unique because clientMessageId is a client-generated UUID; scoping by
    // userId keeps one user's id space from colliding with another's.
    .index("by_client_message", ["userId", "clientMessageId"])
    // Reverse lookup message -> outbox row, used by forensic feedback to capture
    // the dispatched payload best-effort (the row is transient, may be gone).
    .index("by_message", ["messageId"]),

  // L2 "Joindre les documents": per (source assistant message, document reference)
  // attachment lifecycle. The user asks a DOCUMENTARY agent to fetch the real file
  // behind a LightRAG/pgvector reference; the returned file (via the outbound-media
  // contract) is correlated back here BY FILENAME and surfaced in the source's
  // "Source d'origine" slot. NEW table → required fields are fine.
  documentAttachments: defineTable({
    userId: v.id("users"),
    // The CONVERSATIONAL assistant message whose Sources triggered the fetch.
    sourceMessageId: v.id("messages"),
    // The SELECTED source card's unique identity (SourceEntry.key). The fetch is
    // scoped to the exact cards the user checked, so an unchecked duplicate (same
    // file_name, different card) or a sibling chunk of the same file NEVER lights
    // up — only the checked card does. OPTIONAL for additive migration (pre-entryKey
    // rows are skipped on read); every NEW row always sets it.
    entryKey: v.optional(v.string()),
    // The document reference (file_name) requested — the AGENT fetch + media
    // correlation key (the returned file is matched back to rows by basename).
    reference: v.string(),
    status: v.union(
      v.literal("pending"), // dispatched, awaiting the documentary turn
      v.literal("ready"), // file resolved + stored (storageId set)
      v.literal("not_found"), // the documentary turn returned no matching file
      v.literal("failed"), // the fetch errored
    ),
    storageId: v.optional(v.id("_storage")), // the downloadable blob (when ready)
    filename: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    // Panel read: all attachments for a source message.
    .index("by_source_message", ["sourceMessageId"])
    // Correlation: a source's still-pending references, matched by filename.
    .index("by_source_status", ["sourceMessageId", "status"])
    // Upsert: find the row for a specific selected card.
    .index("by_source_entry", ["sourceMessageId", "entryKey"]),

  // On-demand FORENSIC feedback (OpenRouter-style "Report Feedback"). When a user
  // flags a message (category + comment), we FREEZE a full forensic snapshot at
  // that instant — so a later UI-7 delete/regenerate cannot erase the disputed
  // evidence, and an admin can analyze "did the system alter words?" with the
  // complete context. NEW table -> required fields are fine.
  //
  // Trust model (see convex/feedback.ts):
  //   - Everything under `snapshot` EXCEPT `displayedText`/`clientInfo` is
  //     SERVER-READ from the DB inside the mutation — never accepted from the
  //     client (else the forensic proof would be forgeable).
  //   - `displayedText` is the ONLY client-declared content: it is what the
  //     BROWSER actually rendered (the byte-exact `.oc-msg__source-pre`
  //     textContent / `rawText`), captured solely so the server can compare it to
  //     the stored text (`displayedMatchesStored`) and prove browser fidelity.
  //   - `realUserId`/`impersonated` give accountability when an admin reports
  //     while impersonating. Reading feedback content back is an admin path that
  //     must be audited + gated by `traces.read.content` (increment B).
  feedback: defineTable({
    userId: v.id("users"), // effective reporter
    realUserId: v.id("users"), // who really clicked (impersonation-aware)
    impersonated: v.boolean(),
    chatId: v.id("chats"),
    messageId: v.id("messages"),
    at: v.number(),
    category: v.string(), // incoherence|incorrect|altered_words|formatting|latency|api_error|other
    comment: v.optional(v.string()),
    snapshot: v.object({
      // --- Frozen routing identity (SERVER-READ at submit time): the report is
      // forensic evidence that survives chat rerouting/deletion, so WHERE the
      // reported turn ran is captured here, never read live (codex P2). The
      // routed per-turn identity wins over the chat primary when present.
      instanceName: v.optional(v.string()),
      agentId: v.optional(v.string()),
      // --- The reported message (SERVER-READ, authoritative) ---
      messageRole: v.string(),
      messageText: v.string(),
      messageStatus: v.optional(v.string()),
      messageError: v.optional(v.string()),
      messageUpdatedAt: v.optional(v.number()),
      runId: v.optional(v.string()),
      isRegeneration: v.optional(v.boolean()), // derived from a regen-* outbox key
      partsJson: v.optional(v.string()), // serialized messageParts (tools/reasoning/media)
      partsCount: v.optional(v.number()),
      // --- Generating context (SERVER-READ) ---
      promptMessageId: v.optional(v.id("messages")),
      promptText: v.optional(v.string()), // immediately preceding user turn
      contextJson: v.optional(v.string()), // bounded [{role,text}] window, oldest->newest
      contextCount: v.optional(v.number()),
      contextWindowLimit: v.optional(v.number()), // the bound applied (no silent truncation)
      contextTruncated: v.optional(v.boolean()),
      // --- Session config that produced it (SERVER-READ) ---
      sessionSettings: v.optional(
        v.object({
          thinkingLevel: v.optional(v.string()),
          model: v.optional(v.string()),
        }),
      ),
      sessionMetaJson: v.optional(v.string()), // full sessionMeta at report time
      openclawModel: v.optional(v.string()),
      openclawProvider: v.optional(v.string()),
      openclawRuntime: v.optional(v.string()),
      openclawVersion: v.optional(v.string()), // bridge-side; may be absent in Convex
      // --- What was dispatched (SERVER-READ, best-effort; outbox is transient) ---
      outboxText: v.optional(v.string()),
      outboxStatus: v.optional(v.string()),
      outboxClientMessageId: v.optional(v.string()),
      outboxAttachmentsCount: v.optional(v.number()),
      outboxAvailable: v.optional(v.boolean()),
      // --- L2 "Joindre les documents" state for THIS reply (SERVER-READ). The
      // user's own forensic report, so entryKey/reference/status are included (like
      // partsJson's provenance file_names already are) — but NEVER storageId/url
      // (signed URLs leak + rot). `docFetchPendingAgeSeconds` flags a fetch still
      // stuck in flight at report time (the likely reason the user is reporting). ---
      docAttachmentsJson: v.optional(v.string()),
      docAttachmentsCount: v.optional(v.number()),
      docFetchPendingAgeSeconds: v.optional(v.number()),
      // --- Integrity (optional; snapshot itself is already the frozen proof) ---
      contentHash: v.optional(v.string()),
      // --- CLIENT DECLARATIONS (browser-fidelity comparison ONLY, not trusted) ---
      displayedText: v.optional(v.string()),
      displayedMatchesStored: v.optional(v.boolean()), // server: displayedText === messageText
      clientInfo: v.optional(
        v.object({
          userAgent: v.optional(v.string()),
          language: v.optional(v.string()),
          timezone: v.optional(v.string()),
          appVersion: v.optional(v.string()),
          theme: v.optional(v.string()),
          sourceWasOpen: v.optional(v.boolean()),
          // Browser plugins (navigator.plugins). NOTE: privacy-neutered in modern
          // Chrome (a fixed PDF-viewer list, NOT the real set) and never includes
          // extensions — kept best-effort for completeness, low signal.
          plugins: v.optional(v.array(v.string())),
          // Text-mutating extensions DETECTED via their injected DOM footprint
          // (extensions are not API-enumerable). THIS is the useful signal: it
          // names client-side tools (Grammarly/LanguageTool/…) that could alter
          // typed/displayed text.
          extensionsDetected: v.optional(v.array(v.string())),
        }),
      ),
    }),
    // Increment C — admin↔user exchange about this report. Append-list (a thread,
    // not a single field) so an admin can post follow-ups over time without a
    // migration. `authorRole` distinguishes admin responses from (future) user
    // replies; the user sees this thread in their notification zone.
    thread: v.optional(
      v.array(
        v.object({
          // OPTIONAL since the "agent" author: a service account (the gateway's
          // meta/critic agent replying via the key-authed API) has no users row.
          authorUserId: v.optional(v.id("users")),
          authorRole: v.union(
            v.literal("admin"),
            v.literal("user"),
            // A service-account reply (key-authed API, permission
            // feedback.respond) — e.g. the meta/critic gateway agent.
            v.literal("agent"),
          ),
          // Display label for authorRole "agent" (the service account's name).
          authorLabel: v.optional(v.string()),
          text: v.string(),
          at: v.number(),
        }),
      ),
    ),
    // When the OWNER last read their thread (drives the unread badge). Unread =
    // latest admin message `at` > userReadAt. NOT written under impersonation.
    userReadAt: v.optional(v.number()),
    // The OWNER withdrew/closed their own report (with an optional reason). Once
    // set, the report disappears from the user's "Mes signalements" + bell, and a
    // later admin reply does NOT resurface it (a deliberate withdrawal sticks).
    // The row is KEPT (not deleted) so the admin still sees it + the reason. NOT
    // written under impersonation.
    userClosedAt: v.optional(v.number()),
    // Support-side resolution (admin UI or the key-authed API — e.g. the
    // meta/critic agent closing a handled report). The row is KEPT; the owner
    // still sees their report + thread, with a "resolved" state. Distinct from
    // userClosedAt (the OWNER's withdrawal).
    resolvedAt: v.optional(v.number()),
    // Who resolved it: a service-account/admin display label (never a secret).
    resolvedBy: v.optional(v.string()),
    userCloseReason: v.optional(v.string()),
  })
    .index("by_chat", ["chatId"])
    .index("by_message", ["messageId"])
    .index("by_time", ["at"])
    .index("by_real", ["realUserId"])
    // The user's own reports, newest-first, for the notification zone.
    .index("by_user", ["userId"]),

  // USER-created report on a SUB-AGENT FAILURE (the plane-1, CONTENT-BEARING,
  // owner-scoped record). Mirrors the `feedback` forensic-snapshot architecture:
  // when a user flags a failed sub-agent card, `createSubAgentReport` FREEZES the
  // failing child + its failed siblings + the spawning turn, owner-scoped, so a
  // later `reapStaleSubAgents` (which OVERWRITES errorMessage) / re-spawn cannot
  // erase the real failure. The admin analyzes it via an AUDITED content read
  // (subAgentReports.readReport), the user sees their own reports + the thread.
  //
  // TWO-PLANE BOUNDARY: this table holds the raw `errorMessage`/`resultText`/
  // `taskName` (content). The CONTENT-FREE plane-2 anomaly (source:"user",
  // kind:"subagent.failure") carries only the structure + `reportId`/correlationId
  // pointer (lib/subAgentFailure.toSubAgentFailureStructure). No httpAction /
  // key-authed / MCP route reads THIS table — the reportId is an opaque pointer.
  subAgentReports: defineTable({
    userId: v.id("users"), // effective reporter
    realUserId: v.id("users"), // who really clicked (impersonation-aware)
    impersonated: v.boolean(),
    chatId: v.id("chats"),
    // The flagged sub-agent row. The `by_subagent` index backs the "already
    // reported" UI affordance (myReportedSubAgentIds).
    subAgentId: v.id("subAgents"),
    at: v.number(),
    category: v.optional(v.string()), // optional reporter-picked reason (free list)
    comment: v.optional(v.string()),
    // The emitted plane-2 anomaly (source:"user") — kept so the admin/AnomaliesTab
    // can drill from the content-free anomaly INTO this plane-1 record. The
    // anomaly itself never carries content (see lib/subAgentFailure).
    anomalyId: v.optional(v.id("anomalies")),
    // The parent turn's correlationId (`chatId:runId` when resolvable, else
    // chatId) — the deterministic key into Opik/Langfuse (get_trace_enrichment).
    // Non-PHI (an id), duplicated onto the anomaly's correlationId field.
    correlationId: v.optional(v.string()),
    // --- The FROZEN forensic snapshot (SERVER-READ, owner-scoped CONTENT) -------
    snapshot: v.object({
      flaggedChildSessionKey: v.string(),
      totalCount: v.number(), // children captured in this report's scope
      failedCount: v.number(),
      // The captured children (flagged child + failed siblings), bounded. These
      // carry CONTENT (errorMessage/resultText/taskName) and live ONLY here.
      children: v.array(
        v.object({
          childSessionKey: v.string(),
          taskName: v.optional(v.string()),
          status: v.string(),
          errorMessage: v.optional(v.string()),
          resultText: v.optional(v.string()),
          phase: v.optional(v.string()),
          createdAt: v.number(),
          updatedAt: v.number(),
        }),
      ),
      childrenTruncated: v.optional(v.boolean()), // bound applied (no silent drop)
      // ANY frozen text field (per-child errorMessage/resultText/taskName/phase,
      // parentText, or an oversized sessionMeta) was clipped to keep the document
      // under Convex's ~1MB limit. The audited admin read surfaces this so the
      // operator knows the stored text is an excerpt.
      textTruncated: v.optional(v.boolean()),
      // --- The spawning turn (SERVER-READ, best-effort; parentMessageId is often
      // absent on a subAgents row) ---
      parentMessageId: v.optional(v.id("messages")),
      parentMessageRole: v.optional(v.string()),
      parentText: v.optional(v.string()), // the spawning turn text (content)
      parentRunId: v.optional(v.string()),
      parentStatus: v.optional(v.string()),
      parentErrorCode: v.optional(v.string()), // stable code (non-PHI)
      // --- Session config that produced it (SERVER-READ) ---
      openclawModel: v.optional(v.string()),
      openclawProvider: v.optional(v.string()),
      openclawRuntime: v.optional(v.string()),
      sessionMetaJson: v.optional(v.string()),
    }),
    // Admin↔user exchange about this report (append-list, like feedback.thread).
    // Admin replies are admin-visible notes today; the owner-facing read surface
    // + its notification are a coherent follow-up (see respondToReport).
    thread: v.optional(
      v.array(
        v.object({
          authorUserId: v.id("users"),
          authorRole: v.union(v.literal("admin"), v.literal("user")),
          text: v.string(),
          at: v.number(),
        }),
      ),
    ),
  })
    .index("by_chat", ["chatId"])
    .index("by_subagent", ["subAgentId"]) // "already reported" affordance
    .index("by_time", ["at"]) // admin list, newest-first
    .index("by_real", ["realUserId"])
    .index("by_user", ["userId"]), // the owner's own reports

  // Generic per-user notification feed (the bell). The SINGLE source of truth for
  // the unread badge. Producers: anomaly open/resolved (→ every admin), feedback
  // reply (→ the report's owner). NON-PHI only — title/body are labels (e.g.
  // "Réponse à votre signalement"), NEVER message/feedback text; `href` deep-links
  // to where the detail lives. `readAt` null = unread. Rows are user-clearable.
  notifications: defineTable({
    userId: v.id("users"), // recipient (real identity)
    kind: v.union(
      v.literal("anomaly_open"),
      v.literal("anomaly_resolved"),
      v.literal("feedback_reply"),
      // Support-side resolution of the user's report (distinct rendering).
      v.literal("feedback_resolved"),
      // Agent-file curation proposal ready / failed (admin-facing).
      v.literal("curation"),
    ),
    // LEGACY-RENDER fallback: pre-rendered labels, kept so old rows (and any
    // producer without a key) still display. New producers ALSO store a
    // messageKey + params and the client renders those through Paraglide in the
    // READER's language — a notification is never frozen in the language the
    // recipient had when it was written.
    title: v.string(),
    body: v.string(),
    // i18n message key (e.g. "notif_feedback_reply") + its fill-in parameters.
    // The client maps known keys to localized text; unknown/absent -> title/body.
    messageKey: v.optional(v.string()),
    params: v.optional(v.record(v.string(), v.string())),
    href: v.optional(v.string()), // in-app deep link (e.g. "/settings/anomalies")
    // De-dupe / correlation key so a producer never double-notifies for the same
    // event (e.g. one anomaly_open per (user, anomalyId)).
    dedupeKey: v.optional(v.string()),
    createdAt: v.number(),
    readAt: v.optional(v.number()), // unset = unread
  })
    .index("by_user", ["userId"]) // feed (most-recent page)
    .index("by_user_dedupe", ["userId", "dedupeKey"]) // idempotent producers
    // Unread badge: scan ONLY the unread set (readAt === undefined), never the
    // whole per-user history. A missing optional `readAt` is indexed as
    // `undefined`, so `.eq("readAt", undefined)` ranges exactly the unread rows.
    .index("by_user_unread", ["userId", "readAt"]),

  // ===========================================================================
  // Observability & RBAC spine (increment 1). All NEW tables -> required fields
  // are fine (no pre-existing rows to reject on schema push). See
  // docs/OBSERVABILITY_PLATFORM_PLAN.md "Schema additions".
  // ===========================================================================

  // RBAC roles. Built-in roles (pending|user|admin|observer|agent) are seeded
  // from lib/rbac.BUILTIN_ROLES; custom roles are added via the admin matrix.
  // `permissions` is a bounded list of permission-key strings; the wildcard
  // "*" (admin) means "all permissions" and is expanded by roleHasPermission.
  // This is the role->permission source of truth; lib/access keeps owning the
  // profiles.role validator (pending|user|admin) for THIS increment.
  roles: defineTable({
    key: v.string(), // stable identifier, e.g. "admin", "observer"
    name: v.string(), // human label
    description: v.optional(v.string()),
    builtin: v.boolean(), // seeded by seedBuiltinRoles (not user-deletable)
    permissions: v.array(v.string()), // permission keys, or ["*"] for all
  }).index("by_key", ["key"]),

  // A non-human principal (an OpenClaw agent / external service) that holds one
  // or more API keys. Its `roleKey` resolves to a role -> permission set at
  // auth time. NO secrets here (keys live hashed in `apiKeys`). Created/managed
  // by admin-only Convex functions (D4: never via the /api/v1 HTTP surface).
  serviceAccounts: defineTable({
    name: v.string(),
    roleKey: v.string(), // -> roles.key (e.g. "observer", "agent")
    disabled: v.boolean(),
    description: v.optional(v.string()),
    createdByUserId: v.id("users"), // admin who created it (attribution)
  }).index("by_name", ["name"]),

  // API keys for service accounts. SECRET-SAFE: only the SHA-256 hash of the
  // plaintext key is stored (`hashedKey`); the plaintext (`oc_live_<base62>`)
  // is shown exactly ONCE at mint time and never persisted. `prefix`/`lastFour`
  // are non-secret display affordances for the keys list. Verification hashes
  // the presented Bearer token and looks it up via `by_hash`.
  apiKeys: defineTable({
    serviceAccountId: v.id("serviceAccounts"),
    hashedKey: v.string(), // SHA-256 hex of the plaintext (the only stored form)
    prefix: v.string(), // non-secret leading segment, e.g. "oc_live_AB12"
    lastFour: v.string(), // non-secret trailing 4 chars for disambiguation
    disabled: v.boolean(), // revoked keys are disabled, not deleted (audit)
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_hash", ["hashedKey"]) // O(1) verification lookup
    .index("by_account", ["serviceAccountId"]), // list/revoke a SA's keys

  // Bounded recent trace window (D1). Convex is NOT the log store: a daily cron
  // (observability.purgeOldTraces) deletes rows older than TRACE_RETENTION_DAYS.
  // D2 PHI: metadata only by default (route/method/status/latency/principal) —
  // never raw message text. `redacted` records whether content was stripped.
  // `meta` is a JSON string blob for forward-compatible, non-PHI extras.
  traceEvents: defineTable({
    at: v.number(),
    kind: v.string(), // e.g. "api.call"
    direction: v.optional(
      v.union(
        v.literal("inbound"),
        v.literal("outbound"),
        v.literal("internal"),
      ),
    ),
    principalType: v.union(
      v.literal("user"),
      v.literal("service"),
      v.literal("system"),
    ),
    principalId: v.optional(v.string()),
    roleKey: v.optional(v.string()),
    route: v.optional(v.string()),
    method: v.optional(v.string()),
    status: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    chatId: v.optional(v.string()),
    runId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    redacted: v.boolean(),
    meta: v.optional(v.string()), // JSON-encoded non-PHI extras
  })
    .index("by_at", ["at"]) // retention scan + recent-events listing
    .index("by_correlation", ["correlationId"]) // follow a span chain
    .index("by_principal", ["principalType", "principalId"]),

  // Per-key API rate-limit counters (SOC2 CC6.6). One row per (principal, fixed
  // 1-min window); checkApiRateLimit upserts + counts. A purge cron drops old
  // windows so the table stays small. Anti-scraping control on the /api/v1
  // surface (a valid key enumerating chatIds is the threat — see docs/SOC2).
  apiRateLimits: defineTable({
    principalId: v.string(), // serviceAccount id (string)
    windowStart: v.number(), // epoch ms, floored to the window
    count: v.number(),
  })
    .index("by_principal_window", ["principalId", "windowStart"])
    .index("by_window", ["windowStart"]), // bounded purge of old windows

  // Durable ACCESS LOG (SOC2 CC6.1/CC7.2). A dedicated, long-retention copy of
  // every authenticated `/api/v1` access — WHO (service-account principal+role)
  // touched WHICH route/chat, WHEN, with what status. Dual-written from the
  // `api.call` trace (recordEvent) so the trace viewer is unchanged, but kept for
  // the full audit period (ACCESS_LOG_RETENTION_DAYS, default 90 — vs the 14-day
  // traceEvents purge). METADATA ONLY (no content; mirrors a redacted trace).
  // APPEND-ONLY: inserted by recordEvent, removed ONLY by the retention purge —
  // never patched (see compliance/API_CONTROLS.md §7).
  accessLog: defineTable({
    at: v.number(),
    principalId: v.optional(v.string()), // serviceAccount id (string)
    roleKey: v.optional(v.string()),
    route: v.optional(v.string()),
    method: v.optional(v.string()),
    status: v.optional(v.number()),
    chatId: v.optional(v.string()), // present on chat-state reads
    latencyMs: v.optional(v.number()),
  })
    .index("by_at", ["at"]) // retention purge + recent listing
    .index("by_principal_at", ["principalId", "at"]), // per-key access review

  // Small, aggregated, long-lived KPI rollups (D1). STUB for increment 1 — the
  // cron aggregation bodies land in increment 4. Defined now so the schema/
  // index are stable for downstream agents.
  kpiRollups: defineTable({
    bucket: v.string(), // e.g. "2026-06-02T14" (hour granularity)
    metric: v.string(),
    value: v.number(),
    dims: v.optional(v.string()), // JSON-encoded dimension breakdown
  }).index("by_bucket_metric", ["bucket", "metric"]),

  // Detected / reported anomalies (increment 6). Two sources:
  //   - "detector": rows UPSERTED by the `anomalies.detectAnomalies` cron from
  //     the bounded recent `traceEvents` window (high API error ratio, repeated
  //     dispatch failures, assistant.stream error/aborted bursts, ingest
  //     auth-denied spikes). De-duped to ONE OPEN row per `kind` (the cron
  //     patches the existing open row instead of inserting a duplicate each run).
  //   - "agent": rows inserted via the key-authed `POST /api/v1/anomalies` route
  //     so an OpenClaw agent can report an anomaly OR a self-repair action taken.
  // D2 PHI: METADATA ONLY. `evidence` is a JSON string of NON-PHI signals
  // (counts/ratios/thresholds/window) — never message text, tokens, or paths.
  anomalies: defineTable({
    at: v.number(), // first-seen (insert) / last-seen (patch) timestamp
    kind: v.string(), // stable detector key, e.g. "api.error_ratio"
    severity: v.union(
      v.literal("info"),
      v.literal("warn"),
      v.literal("critical"),
    ),
    status: v.union(
      v.literal("open"),
      v.literal("acknowledged"),
      v.literal("resolved"),
    ),
    message: v.string(), // human-readable, non-PHI summary
    // detector = the cron; agent = the key-authed POST /api/v1/anomalies; user =
    // a USER-flagged sub-agent failure (the content-free plane-2 of a plane-1
    // subAgentReports record — evidence carries the reportId pointer + structure
    // only, never the raw error text). All three remain non-PHI by construction.
    source: v.union(
      v.literal("detector"),
      v.literal("agent"),
      v.literal("user"),
    ),
    correlationId: v.optional(v.string()), // optional link to a span chain
    evidence: v.optional(v.string()), // JSON-encoded non-PHI signals
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.string()), // principal/actor id (non-PHI), free-form
  })
    .index("by_status", ["status"]) // dedupe scan (open rows) + listing filter
    .index("by_at", ["at"]) // recent-first listing
    // (status, kind) — look up THE single open detector row of a kind directly
    // so de-dupe (upsertDetectorAnomaly) + auto-resolve are correct regardless
    // of how large the open set grows (no .take(500) truncation hazard).
    .index("by_status_kind", ["status", "kind"]),

  // Outbound trace-shipping cursors (increment 5). One row per vendor
  // ("langfuse"/"opik"): `lastAt` is the `traceEvents.at` watermark up to and
  // INCLUDING which that vendor has already received events. The periodic flush
  // (integrations.ship.flushToVendors) reads `traceEvents` with the COMPOSITE
  // watermark (at, _id), ships a bounded batch, then advances both ON SUCCESS
  // only. No secrets here — vendor credentials live in deployment env (D3); this
  // table holds only the watermark + secret-free failure bookkeeping.
  integrationCursors: defineTable({
    vendor: v.string(), // "langfuse" | "opik" | "otlp"
    lastAt: v.number(), // last shipped traceEvents.at (watermark)
    // M3: secondary tiebreaker so a same-millisecond batch boundary cannot drop
    // events. Paging is (at > lastAt) OR (at == lastAt AND _id > lastId).
    // OPTIONAL (additive on existing rows); absent => fall back to strict-gt.
    lastId: v.optional(v.string()), // last shipped traceEvents _id (as string)
    // L4: secret-free consecutive-failure bookkeeping for a wedged vendor. Reset
    // to 0 on a successful send; emits an anomaly once at the threshold. NEVER a
    // raw error message — only a reason CODE + optional vendor HTTP status.
    failureCount: v.optional(v.number()),
    lastError: v.optional(v.string()), // reason code (e.g. "send_failed") only
    lastErrorStatus: v.optional(v.number()), // vendor HTTP status when present
  }).index("by_vendor", ["vendor"]),

  // Admin-editable NON-SECRET integration configuration (singleton, key
  // "singleton"). SECRETS (API keys) NEVER live here — they stay in the
  // deployment env (D3); these are only the non-secret knobs an admin sets via
  // Settings › Intégrations. Resolution precedence in integrations/config.ts:
  // Convex value (here) -> env -> built-in default.
  integrationConfig: defineTable({
    key: v.string(), // "singleton"
    // Trace-shipping vendors (REAL consumer = integrations/ship flush).
    langfuse: v.optional(
      v.object({
        host: v.optional(v.string()), // overrides LANGFUSE_HOST
        enabled: v.optional(v.boolean()), // master pause switch (keys stay env)
      }),
    ),
    opik: v.optional(
      v.object({
        baseUrl: v.optional(v.string()), // overrides OPIK_BASE_URL
        workspace: v.optional(v.string()), // overrides OPIK_WORKSPACE
        enabled: v.optional(v.boolean()),
      }),
    ),
    // Generic OTLP / OpenTelemetry exporter (consumer = integrations/ship flush
    // via otlp.ts). UNLIKE langfuse/opik (creds in env), the operator configures
    // it ENTIRELY in the UI: `endpoint` = the full OTLP/HTTP traces URL
    // (non-secret); `headersSecret` = the auth headers as an ENCRYPTED envelope
    // (AES-256-GCM, AAD "integration:otlp:headers" — the ONLY encrypted secret in
    // this table, written via the setOtlpHeaders ACTION, NOT setIntegrationConfig);
    // `enabled` = master pause. `configured` = endpoint present (headers optional,
    // for an auth-less collector).
    otlp: v.optional(
      v.object({
        endpoint: v.optional(v.string()),
        enabled: v.optional(v.boolean()),
        headersSecret: v.optional(encryptedSecretValidator),
      }),
    ),
    // Voice tooling (consumer = the bridge worker — NOT built yet; stored here
    // ready for it). Minimal FLAT shape on purpose: there are no bridge fixtures
    // for these yet, so we do NOT mirror openclaw.json's deep providers/personas
    // tree (would be painful to migrate once the gateway protocol is pinned).
    tts: v.optional(
      v.object({
        auto: v.optional(v.string()), // off|always|inbound|tagged
        provider: v.optional(v.string()), // e.g. openai|elevenlabs|microsoft
        model: v.optional(v.string()),
        voice: v.optional(v.string()),
        persona: v.optional(v.string()),
      }),
    ),
    talk: v.optional(
      v.object({
        enabled: v.optional(v.boolean()),
        realtimeProvider: v.optional(v.string()), // openai|google
        realtimeModel: v.optional(v.string()), // e.g. gpt-realtime-2
        voice: v.optional(v.string()), // e.g. cedar|marin
        transport: v.optional(v.string()), // webrtc|provider-websocket|gateway-relay
        speechLocale: v.optional(v.string()), // BCP-47
        silenceTimeoutMs: v.optional(v.number()),
        interruptOnSpeech: v.optional(v.boolean()),
      }),
    ),
  }).index("by_key", ["key"]),

  // Bridge health snapshot (singleton, key "singleton"). Written by the periodic
  // poller (bridgeHealth.pollBridgeHealth) that GETs the bridge's /health. NON-
  // SECRET: reachability + per-target state + last error CODE + non-secret host.
  // This is the REAL-TIME "is the bridge OK right now" source the Settings health
  // badge and the chat availability gate read — distinct from `anomalies` (the
  // historical incident log built by the trace-scan cron).
  bridgeHealth: defineTable({
    key: v.string(), // "singleton"
    reachable: v.boolean(), // could Convex reach the bridge /health this poll?
    status: v.optional(v.string()), // bridge process status when reachable ("ok")
    startedAt: v.optional(v.number()), // bridge process start (for uptime)
    checkedAt: v.number(), // last poll time (staleness = now - checkedAt)
    lastError: v.optional(v.string()), // poll-level reason code when unreachable
    // Gateway WS frame limit (policy.maxPayload) reported by the bridge — the ONE
    // source for the inbound-attachment cap (composer + dispatch derive from it,
    // no hardcoded size). Optional: a pre-this-release bridge omits it.
    maxPayload: v.optional(v.union(v.number(), v.null())),
    targets: v.array(bridgeHealthTarget),
  }).index("by_key", ["key"]),

  // Bridge version & compatibility snapshot (singleton, key "singleton").
  // Written by the compat poller (compat.pollBridgeCompat) that GETs the
  // bridge's unauthenticated /capabilities. A SEPARATE table from
  // `bridgeHealth` on purpose: the health singleton is fully rewritten every
  // minute (explicit-set upsert clears stale fields), while compat is
  // slow-moving metadata polled at its own cadence and PRESERVED last-good
  // across failed polls (serve last-good, like agent discovery). NON-SECRET:
  // versions, provider names, capability booleans — never tokens/paths.
  bridgeCompat: defineTable({
    key: v.string(), // "singleton"
    reachable: v.boolean(), // could Convex reach the bridge /capabilities this poll?
    lastError: v.optional(v.string()), // poll-level reason code when unreachable
    bridgeVersion: v.union(v.string(), v.null()), // bridge package.json version
    // Build-time truths (image env): the CI-stamped version + exact git sha.
    // Optional (absent on pre-0.19.3 bridges). A buildVersion differing from
    // bridgeVersion = the container is not the build it claims (banner warning).
    buildVersion: v.optional(v.union(v.string(), v.null())),
    buildRevision: v.optional(v.union(v.string(), v.null())),
    // The bridge's env-level rehydration default (OPENCLAW_REHYDRATION kill-switch;
    // null = pre-feature bridge, assumed enabled). Aligns the summarize engine.
    rehydrationDefault: v.optional(v.union(v.boolean(), v.null())),
    // The bridge echoes turn session keys (deterministic summarize correlation);
    // null = pre-feature bridge (the engine refuses to dispatch against it).
    turnSessionEcho: v.optional(v.union(v.boolean(), v.null())),
    protocolVersion: v.union(v.number(), v.null()), // bridge contract version (2)
    // CompatManifest stored VERBATIM (forward-compatible), bounded at write time
    // by lib/compat.boundCompatManifest (plain JSON object, size-capped). null =
    // LEGACY bridge without the additive fields — the frontend's legacy policy.
    compat: v.any(),
    // Protocol-contract section (vendored schema version + coverage matrix +
    // runtime drift), bounded by lib/compat.boundProtocolInfo. null = pre-0.23.
    protocol: v.optional(v.any()),
    targets: v.array(bridgeCompatTarget), // one per instance (deduped)
    fetchedAt: v.number(), // last poll time (success OR failure)
  }).index("by_key", ["key"]),

  // Hybrid rehydration (docs/design/hybrid-rehydration.md): ONE rolling summary per
  // conversational chat, maintained asynchronously by convex/chatSummaries.ts and
  // consumed by internal.stream.rehydrationContext. The summary is USER CHAT CONTENT
  // (same sensitivity class as messages — it never leaves the chat's own agent);
  // observability traces about it stay content-free.
  chatSummaries: defineTable({
    chatId: v.id("chats"),
    // The rolling summary text (clamped to lib/rehydration.SUMMARY_MAX_CHARS).
    // Empty string = row reset (invalidated) — treated as "no summary".
    summary: v.string(),
    // Messages with effectiveOrder <= watermark are covered by the summary; the
    // rehydration verbatim tail starts strictly after it. 0 = nothing covered.
    watermarkOrderTime: v.number(),
    coveredCount: v.number(),
    updatedAt: v.number(),
    // Failure backoff for the summarize engine (dispatch/correlate failures).
    failureCount: v.number(),
    nextEligibleAt: v.number(),
    // Which agent produced the CURRENT summary (stamped at correlate; the panel's
    // "générée par" line). Optional — absent before the first success.
    lastAgentId: v.optional(v.string()),
    lastInstanceName: v.optional(v.string()),
    // Persisted paging cursor: every message with _creationTime <= this floor is
    // KNOWN fully covered/ignorable — chunk scans start here instead of re-reading
    // a dense covered region wider than one attempt's page budget (which would
    // stall the engine forever). Monotonic; reset with the watermark.
    scanFloorCreationTime: v.optional(v.number()),
  }).index("by_chat", ["chatId"]),
});
