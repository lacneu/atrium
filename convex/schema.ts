// Convex schema for the Atrium bridge.
//
// Design invariants (load-bearing):
//   - Convex stores ONLY non-secret metadata. Gateway tokens, device
//     identities, Convex deploy/service keys and OpenClaw filesystem paths
//     NEVER live in any table here.
//   - Reactivity is driven entirely by this DB: the bridge writes normalized
//     events into `messages` / `messageParts` and assistant-ui re-renders.
//   - Per-user access control is enforced in functions (queries/mutations),
//     not by the schema; the indexes below exist so those scoped queries are
//     cheap (e.g. `by_user`, `by_chat`).

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

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
        collection: v.optional(v.string()),
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
    // unset => resolver falls back to the admin default, then baseLocale "fr".
    // Mirror of the theme pref so the locale follows the user cross-device. Keep
    // in sync with project.inlang/settings.json locales.
    locale: v.optional(v.union(v.literal("fr"), v.literal("en"))),

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
    // Which provider technology backs this instance. OPTIONAL (additive) →
    // unset legacy rows are treated as "openclaw". The bridge adapts API calls
    // by kind; the app stays standardized.
    kind: v.optional(v.union(v.literal("openclaw"), v.literal("hermes"))),
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
    .index("by_instance_agent", ["instanceName", "agentId"]),

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
    .index("by_instance", ["instanceName"]),

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
  groupCharts: defineTable({
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
    }),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_owner", ["ownerUserId"])
    .index("by_scope", ["scope"]),

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
    // OPTIONAL: unset => resolver falls back to baseLocale "fr". (The admin setter
    // lands with the Theme/Settings refonte; the field exists now so the getMe
    // resolution chain is complete.)
    defaultLocale: v.optional(v.union(v.literal("fr"), v.literal("en"))),
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
    chatId: v.id("chats"),
    userId: v.id("users"), // owner (denormalized for cheap access checks)
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    runId: v.optional(v.string()), // OpenClaw runId for assistant turns
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
    updatedAt: v.number(),
  })
    .index("by_chat", ["chatId"])
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
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("failed"),
    ),
  })
    .index("by_status", ["status"])
    // Idempotency key scoped per user. (userId, clientMessageId) is effectively
    // unique because clientMessageId is a client-generated UUID; scoping by
    // userId keeps one user's id space from colliding with another's.
    .index("by_client_message", ["userId", "clientMessageId"])
    // Reverse lookup message -> outbox row, used by forensic feedback to capture
    // the dispatched payload best-effort (the row is transient, may be gone).
    .index("by_message", ["messageId"]),

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
          authorUserId: v.id("users"),
          authorRole: v.union(v.literal("admin"), v.literal("user")),
          text: v.string(),
          at: v.number(),
        }),
      ),
    ),
    // When the OWNER last read their thread (drives the unread badge). Unread =
    // latest admin message `at` > userReadAt. NOT written under impersonation.
    userReadAt: v.optional(v.number()),
  })
    .index("by_chat", ["chatId"])
    .index("by_message", ["messageId"])
    .index("by_time", ["at"])
    .index("by_real", ["realUserId"])
    // The user's own reports, newest-first, for the notification zone.
    .index("by_user", ["userId"]),

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
    ),
    title: v.string(),
    body: v.string(),
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
    source: v.union(v.literal("detector"), v.literal("agent")),
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
    vendor: v.string(), // "langfuse" | "opik"
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
    protocolVersion: v.union(v.number(), v.null()), // bridge contract version (2)
    // CompatManifest stored VERBATIM (forward-compatible), bounded at write time
    // by lib/compat.boundCompatManifest (plain JSON object, size-capped). null =
    // LEGACY bridge without the additive fields — the frontend's legacy policy.
    compat: v.any(),
    targets: v.array(bridgeCompatTarget), // one per instance (deduped)
    fetchedAt: v.number(), // last poll time (success OR failure)
  }).index("by_key", ["key"]),
});
