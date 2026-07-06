// Admin settings surface. EVERY function here requires the admin role
// (requireAdmin derives identity via ctx.auth — never an arg). Manages users
// (roles/approval), per-tab RBAC grants, and instance metadata. Agent assignment
// lives in convex/agents.ts. NO secrets are read or written (gateway tokens /
// device identities
// live only in the bridge env; these tables hold non-secret names).

import { v } from "convex/values";
import { isSupportedLocale } from "./lib/locales";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { getProfile, requireAdmin, requirePermission, roleOf } from "./lib/access";
import { isGrantableUserPermission, PERMISSIONS } from "./lib/rbac";
import {
  instanceConfigValidator,
  parseInstanceConfig,
} from "./lib/instanceConfig";
import { recordAudit } from "./lib/audit";
import { cascadeDeleteChat } from "./chats";
import { effectiveAgentsForUsers } from "./agents";
import {
  isUiPrefKey,
  UI_PREF_SYSTEM_GATE,
  type UiPrefsObject,
  type FeaturesEnabled,
} from "./lib/uiPrefs";
import {
  applyFilter,
  filterValidator,
  type FilterConfig,
} from "./lib/filters";
import { validateEndpointUrl } from "./integrations/otlpShared";

// --- Per-resource filter configs (docs/FILTERS_SPEC.md) --------------------
// Applied over the VIEW objects each query returns (so q/advanced see computed
// fields like the audit labels, and never a field the view does not expose — D2).

const USERS_FILTER_CFG: FilterConfig = {
  searchFields: ["email", "name", "canonical"],
  structured: { role: { field: "role", kind: "string" } },
  advanced: false,
};

const AUDIT_FILTER_CFG: FilterConfig = {
  searchFields: ["action", "realLabel", "targetLabel", "resourceId"],
  timeField: "at",
  structured: {
    action: { field: "action", kind: "string" },
    impersonated: { field: "impersonated", kind: "bool" },
    resource: { field: "resource", kind: "string" },
  },
  advanced: true,
};

const roleValidator = v.union(
  v.literal("pending"),
  v.literal("user"),
  v.literal("admin"),
);

// --- Users ------------------------------------------------------------------

export const listUsers = query({
  // `withAgents` is OPT-IN: only the users MANAGEMENT list (the Agents column) needs
  // the per-user effective agent set. Other consumers (e.g. a user picker) call
  // listUsers WITHOUT it, so they neither pay the per-user pool reads nor get
  // invalidated by agent changes they do not display (Codex P2).
  args: {
    filter: v.optional(filterValidator),
    withAgents: v.optional(v.boolean()),
  },
  handler: async (ctx, { filter, withAgents }) => {
    await requireAdmin(ctx);
    // Bounded: take the most recent N profiles. (Admin user lists are small;
    // paginate later if a deployment grows large.)
    const profiles = await ctx.db.query("profiles").order("desc").take(500);
    const views = profiles.map((p) => ({
      _id: p._id,
      userId: p.userId,
      role: roleOf(p),
      email: p.email ?? null,
      name: p.name ?? null,
      canonical: p.canonical ?? null,
      // Granted per-tab Settings permissions (for the grant editor; admins hold
      // every permission via the wildcard regardless of this field).
      extraPermissions: p.extraPermissions ?? [],
      // Effective agents available to this user (cascade-resolved). null = NOT
      // requested (withAgents off) so a consumer never mistakes it for "0 agents".
      agentCount: null as number | null,
      agents: [] as string[],
    }));
    // Filter FIRST (q/role do not depend on agents), so the agent computation runs
    // ONLY over the displayed subset -- never the full 500 (Codex P2).
    const filtered = applyFilter(views, filter, USERS_FILTER_CFG);
    // Skip the helper entirely on an empty result set: an unmatched search must not
    // pay the all-pool read (nor stay subscribed to agent changes it shows none of).
    if (withAgents && filtered.length > 0) {
      const agentsByUser = await effectiveAgentsForUsers(
        ctx,
        filtered.map((u) => u.userId),
      );
      for (const u of filtered) {
        const ag = agentsByUser.get(u.userId);
        if (ag) {
          u.agentCount = ag.count;
          u.agents = ag.preview;
        }
      }
    }
    return filtered;
  },
});

// Count current admins (used for last-admin protection).
async function adminCount(ctx: Parameters<typeof requireAdmin>[0]): Promise<number> {
  const admins = await ctx.db
    .query("profiles")
    .withIndex("by_role", (q) => q.eq("role", "admin"))
    .collect();
  return admins.length;
}

type AppRole = "pending" | "user" | "admin";

/**
 * The SINGLE guarded role-change path (M1). Both setRole and approveUser route
 * through here so the last-admin lockout guard and the impersonation-target
 * cleanup can never be bypassed by a sibling mutation. Plain helper (a mutation
 * cannot ctx.runMutation another mutation), mirroring observability's
 * writeTraceEvent single-writer pattern. Preserves D5 invariants.
 *
 * Caller must have already passed requireAdmin.
 */
async function applyRoleChange(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  role: AppRole,
): Promise<void> {
  const target = await ctx.db.get(profileId);
  if (target === null) throw new Error("Not found: profile");
  // Last-admin protection: never demote the only remaining admin (lockout).
  if (roleOf(target) === "admin" && role !== "admin") {
    if ((await adminCount(ctx)) <= 1) {
      throw new Error("Refused: cannot demote the last admin");
    }
  }
  // Security hygiene: a non-admin must not carry an impersonation target.
  // Clearing it on demotion prevents a later re-promotion from silently
  // resuming a stale impersonation (getActor already ignores it while the
  // role is non-admin; this makes the state match the role).
  const patch: { role: AppRole; impersonatingUserId?: undefined } = { role };
  if (role !== "admin") patch.impersonatingUserId = undefined;
  await ctx.db.patch(profileId, patch);
}

export const setRole = mutation({
  args: { profileId: v.id("profiles"), role: roleValidator },
  handler: async (ctx, { profileId, role }) => {
    await requireAdmin(ctx);
    await applyRoleChange(ctx, profileId, role);
  },
});

// Convenience: approve a pending user to "user". Routes through the same guarded
// path as setRole (M1) so it cannot demote the last admin nor leave a stale
// impersonation target if the target happens to be the sole admin.
export const approveUser = mutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    await requireAdmin(ctx);
    await applyRoleChange(ctx, profileId, "user");
  },
});

// Admin: set ANY user's display name (the user list shows it). Mirrors setRole
// (requireAdmin, addressed by profileId). The name is the SAME user-owned field
// a user edits via me.setMyName; an admin can correct it on someone's behalf.
// Blank clears it (the list falls back to the email). Audited.
export const setUserName = mutation({
  args: { profileId: v.id("profiles"), name: v.string() },
  handler: async (ctx, { profileId, name }) => {
    const adminId = await requireAdmin(ctx);
    const target = await ctx.db.get(profileId);
    if (target === null) throw new Error("Not found: profile");
    const trimmed = name.trim().slice(0, 120);
    await ctx.db.patch(profileId, {
      name: trimmed.length > 0 ? trimmed : undefined,
    });
    await recordAudit(
      ctx,
      { realUserId: adminId, effectiveUserId: adminId, impersonating: false },
      "user.setName",
      { resource: "user", resourceId: target.userId },
    );
  },
});

// Hard-delete a user: their profile + ALL owned data (chats and — via the shared
// cascadeDeleteChat helper — each chat's messages/parts/pending outbox/mirrored
// files rows; plus projects, agent grants, group memberships, uploads, feedback,
// notifications). Guards mirror applyRoleChange: never yourself (requireAdmin
// returns the REAL admin id, so an impersonating admin can't self-delete via the
// target), never the last admin (lockout). The deleted user's live session (if
// any) is neutralized at its NEXT request: ensureProfile re-BLOCKS a duplicate
// identity (its email is still owned by the kept profile) or re-provisions a
// fresh "pending" profile for a unique one — hard session invalidation needs an
// action wrapper (invalidateSessions), deferred. Audited. TRANSACTIONAL: a user
// with more data than one mutation's write budget rolls back WHOLE (no partial
// delete); batch in a follow-up if that ever bites (this tool's data is small).
export const deleteUser = mutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const realUserId = await requireAdmin(ctx);
    const target = await ctx.db.get(profileId);
    if (target === null) throw new Error("Not found: profile");
    const userId = target.userId;
    if (userId === realUserId) {
      throw new Error("Refused: cannot delete your own account");
    }
    if (roleOf(target) === "admin" && (await adminCount(ctx)) <= 1) {
      throw new Error("Refused: cannot delete the last admin");
    }

    // Chats first — the shared helper also clears each chat's messages, parts,
    // pending outbox and the mirrored files rows.
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const c of chats) await cascadeDeleteChat(ctx, c._id);

    // Remaining per-user rows, each via its `by_user` index.
    for (const r of await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(r._id);
    }
    for (const r of await ctx.db
      .query("userAgents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(r._id);
    }
    for (const r of await ctx.db
      .query("groupMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(r._id);
    }
    for (const r of await ctx.db
      .query("feedback")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(r._id);
    }
    for (const r of await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(r._id);
    }
    // uploads + any stray (non-chat-mirrored) files use compound by_user* indexes.
    for (const r of await ctx.db
      .query("uploads")
      .withIndex("by_user_storage", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(r._id);
    }
    for (const r of await ctx.db
      .query("files")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(r._id);
    }

    await ctx.db.delete(profileId);
    await recordAudit(
      ctx,
      { realUserId, effectiveUserId: realUserId, impersonating: false },
      "user.delete",
      { resource: "user", resourceId: userId },
    );
  },
});

// --- Impersonation ("view/act as a user") -----------------------------------
//
// Start records the target on the REAL admin's profile; the access layer then
// resolves the effective identity for all user-data functions. requireAdmin
// keys off the REAL identity, so an admin keeps the power to stop even while
// impersonating a non-admin. Both transitions are audited.

export const startImpersonation = mutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const realUserId = await requireAdmin(ctx);
    const target = await ctx.db.get(profileId);
    if (target === null) throw new Error("Not found: profile");
    if (target.userId === realUserId) {
      throw new Error("Refused: cannot impersonate yourself");
    }
    const realProfile = await getProfile(ctx, realUserId);
    if (realProfile === null) throw new Error("Not found: admin profile");
    await ctx.db.patch(realProfile._id, { impersonatingUserId: target.userId });
    await recordAudit(
      ctx,
      { realUserId, effectiveUserId: target.userId, impersonating: true },
      "impersonation.start",
      { resource: "user", resourceId: target.userId },
    );
  },
});

export const stopImpersonation = mutation({
  args: {},
  handler: async (ctx) => {
    const realUserId = await requireAdmin(ctx);
    const realProfile = await getProfile(ctx, realUserId);
    const wasTarget = realProfile?.impersonatingUserId;
    if (realProfile && wasTarget) {
      await ctx.db.patch(realProfile._id, { impersonatingUserId: undefined });
      await recordAudit(
        ctx,
        { realUserId, effectiveUserId: wasTarget, impersonating: true },
        "impersonation.stop",
        { resource: "user", resourceId: wasTarget },
      );
    }
  },
});

// --- Audit trail (read) -----------------------------------------------------

export const listAudit = query({
  args: { filter: v.optional(filterValidator) },
  handler: async (ctx, { filter }) => {
    await requireAdmin(ctx);
    // Most-recent first. Bounded; paginate later if a deployment grows large.
    const rows = await ctx.db.query("auditLog").order("desc").take(200);
    // Resolve userIds -> human labels (small admin dataset).
    const profiles = await ctx.db.query("profiles").take(500);
    const labelOf = (uid: Id<"users">) => {
      const p = profiles.find((x) => x.userId === uid);
      return p?.email ?? p?.name ?? p?.canonical ?? String(uid).slice(0, 8);
    };
    const views = rows.map((r) => ({
      _id: r._id,
      at: r.at,
      action: r.action,
      realLabel: labelOf(r.realUserId),
      targetLabel: r.impersonated ? labelOf(r.effectiveUserId) : null,
      impersonated: r.impersonated,
      resource: r.resource ?? null,
      resourceId: r.resourceId ?? null,
    }));
    // Filter in-memory over the VIEW objects (so q can search the COMPUTED
    // realLabel/targetLabel, which do not exist on the raw auditLog row). NOTE
    // (D1): a `filter.from` older than the bounded 200-row window is partial.
    return applyFilter(views, filter, AUDIT_FILTER_CFG);
  },
});

// --- App-wide default theme (used when a user has no preference) -----------

const APP_META_KEY = "singleton";

export const setDefaultThemeMode = mutation({
  args: {
    mode: v.union(
      v.literal("light"),
      v.literal("dark"),
      v.literal("system"),
      v.null(),
    ),
  },
  handler: async (ctx, { mode }) => {
    await requireAdmin(ctx);
    const meta = await ctx.db
      .query("appMeta")
      .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
      .unique();
    if (meta === null) {
      // appMeta is normally created at first-admin bootstrap; create defensively.
      await ctx.db.insert("appMeta", {
        key: APP_META_KEY,
        adminAssigned: true,
        defaultThemeMode: mode ?? undefined,
      });
      return;
    }
    await ctx.db.patch(meta._id, { defaultThemeMode: mode ?? undefined });
  },
});

// App-wide default UI language (used when a user has no `locale` preference).
// Mirror of setDefaultThemeMode. NOTE: unlike theme (a class swap), a user with
// NO personal locale who inherits this default will RELOAD when it changes
// (Paraglide's setLocale) — the Apparence panel warns the admin about this.
export const setDefaultLocale = mutation({
  args: {
    // Plain string validated against SUPPORTED_LOCALES (single source).
    locale: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { locale }) => {
    await requireAdmin(ctx);
    if (locale !== null && !isSupportedLocale(locale)) {
      throw new Error(`Unsupported locale: ${locale}`);
    }
    const meta = await ctx.db
      .query("appMeta")
      .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
      .unique();
    if (meta === null) {
      await ctx.db.insert("appMeta", {
        key: APP_META_KEY,
        adminAssigned: true,
        defaultLocale: locale ?? undefined,
      });
      return;
    }
    await ctx.db.patch(meta._id, { defaultLocale: locale ?? undefined });
  },
});

// --- UI preferences module (admin side) ------------------------------------

/** Set the admin DEFAULT for a UI pref (inherited by users with no override).
 *  `value: null` clears it (fall back to the code default). */
export const setUiPrefDefault = mutation({
  args: { key: v.string(), value: v.union(v.boolean(), v.null()) },
  handler: async (ctx, { key, value }) => {
    await requireAdmin(ctx);
    if (!isUiPrefKey(key)) throw new Error(`Unknown UI preference: ${key}`);
    const meta = await ctx.db
      .query("appMeta")
      .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
      .unique();
    const defaults: UiPrefsObject = { ...(meta?.uiPrefDefaults ?? {}) };
    if (value === null) delete defaults[key];
    else defaults[key] = value;
    if (meta === null) {
      await ctx.db.insert("appMeta", {
        key: APP_META_KEY,
        adminAssigned: true,
        uiPrefDefaults: defaults,
      });
      return;
    }
    await ctx.db.patch(meta._id, { uiPrefDefaults: defaults });
  },
});

/** Enable/disable a system-gated feature. Until enabled, a gated UI pref stays
 *  locked/greyed and `setUiPref` rejects turning it on. */
export const setFeatureEnabled = mutation({
  args: { key: v.string(), enabled: v.boolean() },
  handler: async (ctx, { key, enabled }) => {
    await requireAdmin(ctx);
    const validGates = new Set(Object.values(UI_PREF_SYSTEM_GATE));
    if (!validGates.has(key)) throw new Error(`Unknown system feature: ${key}`);
    const meta = await ctx.db
      .query("appMeta")
      .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
      .unique();
    const fe: FeaturesEnabled = { ...(meta?.featuresEnabled ?? {}) };
    fe[key] = enabled;
    if (meta === null) {
      await ctx.db.insert("appMeta", {
        key: APP_META_KEY,
        adminAssigned: true,
        featuresEnabled: fe,
      });
      return;
    }
    await ctx.db.patch(meta._id, { featuresEnabled: fe });
  },
});

// --- Integrations: NON-SECRET config (Settings › Intégrations) -------------
// Stores only non-secret knobs (host/baseUrl/workspace/enabled + tts/talk
// settings). API KEYS are NEVER accepted here — they live in deployment env.
// Each provided section is shallow-merged into the singleton so updating one
// field never clears the others; an empty string clears a field (config.ts then
// falls back to env -> default).
const INTEGRATION_CONFIG_KEY = "singleton";

export const setIntegrationConfig = mutation({
  args: {
    langfuse: v.optional(
      v.object({
        host: v.optional(v.string()),
        enabled: v.optional(v.boolean()),
      }),
    ),
    opik: v.optional(
      v.object({
        baseUrl: v.optional(v.string()),
        workspace: v.optional(v.string()),
        enabled: v.optional(v.boolean()),
      }),
    ),
    // OTLP NON-SECRET knobs only. The auth headers (a secret) are set via the
    // setOtlpHeaders ACTION; the merge below preserves the stored headersSecret.
    otlp: v.optional(
      v.object({
        endpoint: v.optional(v.string()),
        enabled: v.optional(v.boolean()),
      }),
    ),
    tts: v.optional(
      v.object({
        auto: v.optional(v.string()),
        provider: v.optional(v.string()),
        model: v.optional(v.string()),
        voice: v.optional(v.string()),
        persona: v.optional(v.string()),
      }),
    ),
    talk: v.optional(
      v.object({
        enabled: v.optional(v.boolean()),
        realtimeProvider: v.optional(v.string()),
        realtimeModel: v.optional(v.string()),
        voice: v.optional(v.string()),
        transport: v.optional(v.string()),
        speechLocale: v.optional(v.string()),
        silenceTimeoutMs: v.optional(v.number()),
        interruptOnSpeech: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    // Vendor URL knobs (OTLP endpoint, Langfuse host, Opik base URL) are NON-secret
    // (exposed via integrations.status + the traces.read-authed /api/v1 route), so
    // none may CARRY a secret: reject a credential-bearing (userinfo) or malformed
    // URL at SET time BEFORE any write (transactional → nothing is stored on reject).
    // Auth belongs in the encrypted headers / secret env, never the URL.
    if (args.otlp?.endpoint !== undefined) {
      validateEndpointUrl(args.otlp.endpoint, "OTLP endpoint");
    }
    if (args.langfuse?.host !== undefined) {
      validateEndpointUrl(args.langfuse.host, "Langfuse host");
    }
    if (args.opik?.baseUrl !== undefined) {
      validateEndpointUrl(args.opik.baseUrl, "Opik base URL");
    }
    const meta = await ctx.db
      .query("integrationConfig")
      .withIndex("by_key", (q) => q.eq("key", INTEGRATION_CONFIG_KEY))
      .unique();
    const merge = <T extends object>(
      existing: T | undefined,
      incoming: T | undefined,
    ): T | undefined => (incoming ? { ...(existing ?? {}), ...incoming } : existing);

    const next = {
      key: INTEGRATION_CONFIG_KEY,
      langfuse: merge(meta?.langfuse, args.langfuse),
      opik: merge(meta?.opik, args.opik),
      // merge preserves the encrypted headersSecret (set via setOtlpHeaders).
      otlp: merge(meta?.otlp, args.otlp),
      tts: merge(meta?.tts, args.tts),
      talk: merge(meta?.talk, args.talk),
    };
    if (meta === null) {
      await ctx.db.insert("integrationConfig", next);
      return;
    }
    await ctx.db.patch(meta._id, next);
  },
});

// --- Per-user routing override ---------------------------------------------

// NOTE: legacy `setUserRouting` (per-user group/override write path) was RETIRED
// with the multi-agent redesign (H4) — routing now comes from `userAgents` (see
// convex/agents.ts). The `groups`/override columns stay only so old rows validate
// and the reconciling migration can read them once.

// --- Per-user Settings tab permissions (per-tab RBAC grants) -----------------

// Grant a user the read-only permissions that open specific Settings tabs to a
// non-admin. The GRANTABLE whitelist is enforced HERE (server-side) — the real
// boundary; UI hiding is cosmetic. admin.manage and any sensitive/write perm are
// rejected, so a non-admin can never gain a sensitive-tab grant, even via a
// malformed or replayed call. `permissions` REPLACES the user's grant set.
export const setUserPermissions = mutation({
  args: { profileId: v.id("profiles"), permissions: v.array(v.string()) },
  handler: async (ctx, { profileId, permissions }) => {
    await requireAdmin(ctx);
    const invalid = permissions.filter((p) => !isGrantableUserPermission(p));
    if (invalid.length > 0) {
      throw new Error(`Permissions not grantable: ${invalid.join(", ")}`);
    }
    const target = await ctx.db.get(profileId);
    if (target === null) throw new Error("Not found: profile");
    await ctx.db.patch(profileId, {
      extraPermissions: [...new Set(permissions)],
    });
  },
});

// --- Instances (non-secret metadata) ---------------------------------------

export const listInstances = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("instances").order("desc").take(200);
  },
});

export const upsertInstance = mutation({
  args: {
    instanceId: v.optional(v.id("instances")),
    name: v.string(),
    gatewayUrl: v.string(),
    displayName: v.optional(v.string()),
    // Per-instance bridge endpoint (Model M). NON-secret; the shared secret stays
    // env. Empty string is normalized to "unset" → dispatch falls back to BRIDGE_URL.
    bridgeUrl: v.optional(v.string()),
    // Which provider technology backs this instance (the bridge adapts by kind).
    kind: v.optional(v.union(v.literal("openclaw"), v.literal("hermes"))),
    // Hermes transport: "ws" (default, richer) or "rest". Ignored for OpenClaw.
    transport: v.optional(v.union(v.literal("ws"), v.literal("rest"))),
    // Non-secret gateway config (the SECRETS go through setInstanceSecret). Empty
    // string → undefined (cleared). gatewayVersion = compat fallback;
    // gatewayHttpUrl = media HTTP override.
    gatewayVersion: v.optional(v.string()),
    gatewayHttpUrl: v.optional(v.string()),
    // FRONTEND live-stream transport (reactive | sse) — a top-level instance property,
    // NOT bridge-dispatch config. See schema instances.streamTransport.
    streamTransport: v.optional(v.union(v.literal("reactive"), v.literal("sse"))),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const trimmedBridgeUrl = args.bridgeUrl?.trim();
    const fields = {
      name: args.name,
      gatewayUrl: args.gatewayUrl,
      displayName: args.displayName,
      // Store undefined (not "") for an unset URL so resolveBridgeUrl falls back.
      bridgeUrl:
        trimmedBridgeUrl && trimmedBridgeUrl.length > 0
          ? trimmedBridgeUrl
          : undefined,
      kind: args.kind ?? "openclaw",
      transport: args.transport,
      gatewayVersion: args.gatewayVersion?.trim() || undefined,
      gatewayHttpUrl: args.gatewayHttpUrl?.trim() || undefined,
      streamTransport: args.streamTransport,
    };
    if (args.instanceId) {
      // The name is the immutable ROUTING KEY: agents, userAgents, chats and
      // instanceDiscovery all reference an instance BY NAME. Renaming would orphan
      // every one of them, so reject a rename server-side — the disabled UI field is
      // a convenience, NOT a trust boundary (a raw API call could still send a new
      // name). With the names equal, the `name` in `fields` patches to itself.
      const existing = await ctx.db.get(args.instanceId);
      if (existing === null) throw new Error("instance_not_found");
      if (existing.name !== args.name) {
        throw new Error("instance_rename_not_supported");
      }
      await ctx.db.patch(args.instanceId, fields);
      return args.instanceId;
    }
    return await ctx.db.insert("instances", fields);
  },
});

// Edit the per-instance NON-SECRET bridge config (mediaMode / inboundMediaMode /
// rehydration / mediaMaxMb), hot-consumed by that instance's bridge on the next
// dispatch. Admin-only via BRIDGE_CONFIG_WRITE (the admin wildcard; never granted
// to a non-admin). The closed validator already rejects unknown keys/bad enums;
// parseInstanceConfig adds the range bound and rejects the WHOLE write on any bad
// field (never a silent drop). Pass an empty object to clear all overrides.
export const upsertInstanceConfig = mutation({
  args: {
    instanceId: v.id("instances"),
    config: instanceConfigValidator,
  },
  handler: async (ctx, { instanceId, config }) => {
    await requirePermission(ctx, PERMISSIONS.BRIDGE_CONFIG_WRITE);
    const parsed = parseInstanceConfig(config);
    if (parsed === "invalid") {
      throw new Error("Invalid instance config");
    }
    const inst = await ctx.db.get(instanceId);
    if (inst === null) throw new Error("Instance not found");
    await ctx.db.patch(instanceId, { config: parsed });
    return instanceId;
  },
});

export const deleteInstance = mutation({
  args: { instanceId: v.id("instances") },
  handler: async (ctx, { instanceId }) => {
    await requireAdmin(ctx);
    const inst = await ctx.db.get(instanceId);
    if (inst === null) return; // idempotent
    const name = inst.name;
    await ctx.db.delete(instanceId);

    // Encrypted credentials are keyed by THIS row's id (not its name), so they go
    // UNCONDITIONALLY with the row — even if a duplicate-name instance remains
    // (the name-keyed cascades below are gated on that; these are not).
    const secretRows = await ctx.db
      .query("instanceSecrets")
      .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
      .collect();
    for (const s of secretRows) await ctx.db.delete(s._id);

    // The per-bridge auth secret is also keyed by THIS row's id — drop it
    // unconditionally with the row (a stale hash must never resolve to a dead instance).
    const bridgeAuthRows = await ctx.db
      .query("bridgeAuth")
      .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
      .collect();
    for (const b of bridgeAuthRows) await ctx.db.delete(b._id);

    // `userAgents` / `agents` / `instanceDiscovery` reference the instance by
    // NAME (value), so deleting the row alone leaves ORPHAN grants the user could
    // still bind/send to (Codex P2). Cascade-clean — but ONLY if no OTHER instance
    // row still serves this name (duplicate-name resilience, like routing.first()).
    const stillServed = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (stillServed !== null) return;

    // Discovery cache for this instance.
    const discRows = await ctx.db
      .query("instanceDiscovery")
      .withIndex("by_instance", (q) => q.eq("instanceName", name))
      .collect();
    for (const d of discRows) await ctx.db.delete(d._id);
    // Subscription-usage snapshot (same by-name reference — an orphan row would
    // show a stale quota for a deleted/recreated instance; codex P2).
    const usageRows = await ctx.db
      .query("instanceUsage")
      .withIndex("by_instance", (q) => q.eq("instanceName", name))
      .collect();
    for (const u of usageRows) await ctx.db.delete(u._id);
    // Discovered/known agents for this instance.
    const agentRows = await ctx.db
      .query("agents")
      .withIndex("by_instance", (q) => q.eq("instanceName", name))
      .collect();
    for (const a of agentRows) await ctx.db.delete(a._id);
    // Group-shared agents on this instance (P2). Same bounded by_instance read as
    // userAgents; no default re-election (groupAgents has no "one default per
    // group" invariant — the read-time precedence simply re-picks).
    const groupAgentRows = await ctx.db
      .query("groupAgents")
      .withIndex("by_instance", (q) => q.eq("instanceName", name))
      .collect();
    for (const ga of groupAgentRows) await ctx.db.delete(ga._id);
    // Orphaned per-user grants — read ONLY this instance's rows via by_instance
    // (never a whole-table scan; Convex doc limits — Codex P2). Track affected
    // users so we can re-elect a default among their remaining grants (never leave
    // "agents but no default" — H2).
    const instUa = await ctx.db
      .query("userAgents")
      .withIndex("by_instance", (q) => q.eq("instanceName", name))
      .collect();
    const affected = new Set<Id<"users">>();
    for (const ua of instUa) {
      affected.add(ua.userId);
      await ctx.db.delete(ua._id);
    }
    for (const userId of affected) {
      const remaining = await ctx.db
        .query("userAgents")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      if (remaining.length > 0 && !remaining.some((r) => r.isDefault)) {
        await ctx.db.patch(remaining[0]._id, { isDefault: true });
      }
    }
    // Chats bound to the deleted instance are intentionally LEFT: on the next send
    // resolveTargetForChat sees the (now-removed) grant and re-binds to the user's
    // default (or fails no_agent) — no orphan dispatch, history preserved.
  },
});
