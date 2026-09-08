// Admin settings surface. EVERY function here requires the admin role
// (requireAdmin derives identity via ctx.auth — never an arg). Manages users
// (roles/approval), per-tab RBAC grants, and instance metadata. Agent assignment
// lives in convex/agents.ts. NO secrets are read or written (gateway tokens /
// device identities
// live only in the bridge env; these tables hold non-secret names).

import { v } from "convex/values";
import { isSupportedLocale } from "./lib/locales";
import {
  internalMutation,
  mutation,
  query,
  MutationCtx,
} from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { getProfile, requireAdmin, requirePermission, roleOf } from "./lib/access";
import { normalizeEmail } from "./lib/authDomains";
import { isGrantableUserPermission, PERMISSIONS } from "./lib/rbac";
import {
  instanceConfigValidator,
  parseInstanceConfig,
} from "./lib/instanceConfig";
import { internal } from "./_generated/api";
import {
  assertNameNotSweeping,
  deleteInstanceCascade,
  openCascadeJob,
} from "./lib/instanceCascade";
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

    // GROUP-CHAT memberships. Without this the deleted account keeps a seat in
    // every conversation it was invited to: the roster renders a nameless ghost, the
    // seat still counts against the chat's participant limit, and — the reason this
    // is not cosmetic — a re-provisioned profile for the same person would walk
    // straight back into every one of those conversations.
    for (const r of await ctx.db
      .query("chatParticipants")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect())
      await ctx.db.delete(r._id);
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

/**
 * ONE-TIME: give every profile its lowercased address.
 *
 * The duplicate-account guard reads `by_email_lower`, and rows written before that
 * field existed do not have it. `ensureProfile` heals each one on its owner's own
 * next sign-in — but a deployment adopting a SECOND provider needs them healed
 * BEFORE anybody arrives through the new door, or the first person to do so is
 * neither linked nor refused: they are silently given a second account.
 *
 * Run it after upgrading, from the dashboard or `npx convex run`, passing the
 * returned `cursor` back until `isDone`. Idempotent, and it never touches `email` —
 * only the derived key the guard reads.
 *
 * A CURSOR, not a repeated first page. Rows this cannot heal — a profile with no
 * address at all, which the dev anonymous provider creates by design — stay in the
 * `emailLower === undefined` range forever, so they permanently occupy its head.
 * Re-reading the head therefore returns the same unhealable rows on every call and
 * answers `{updated: 0, remaining: 0}` while real rows sit further along: the
 * operator reads "nothing left", opens the second provider, and those people
 * silently get duplicate accounts. `remaining` is gone with it — a number counted
 * over one page was the thing that lied. `isDone` is the whole answer.
 */
/**
 * One page of the backfill. Shared by both entry points below so the walk itself
 * exists once — the two differ only in WHO may start it.
 */
async function backfillEmailLowerPage(
  ctx: MutationCtx,
  cursor: string | null | undefined,
): Promise<{ updated: number; isDone: boolean; cursor: string | null }> {
  {
    const page = await ctx.db
      .query("profiles")
      .withIndex("by_email_lower", (q) => q.eq("emailLower", undefined))
      .paginate({ numItems: 500, cursor: cursor ?? null });
    let updated = 0;
    for (const p of page.page) {
      // Same normalization as everywhere else, `normalizeEmail` and not a bare
      // `.toLowerCase()`: a stored address with surrounding whitespace would
      // otherwise get an `emailLower` no normalized lookup can ever match. An
      // address that normalizes to nothing has no key to derive — the cursor walks
      // past it rather than the call stalling on it.
      const lower = normalizeEmail(p.email);
      if (lower === undefined) continue;
      await ctx.db.patch(p._id, { emailLower: lower });
      updated += 1;
    }
    return {
      updated,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  }
}

/**
 * The upgrade step, for an OPERATOR at a terminal.
 *
 * `internal` on purpose, and not a convenience: `npx convex run` establishes no app
 * user, so the admin-gated mutation below answers "Unauthorized: authentication
 * required" — which made the one step 0.83.0 calls mandatory impossible to perform
 * by following its own instructions. The Convex CLI carries the deployment's own
 * key, which is what authorizes an internal function, so this is the entry point a
 * deployment operator actually has.
 */
export const backfillProfileEmailLowerCli = internalMutation({
  args: {
    /** From the previous call. Omit on the first one. */
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (
    ctx,
    { cursor },
  ): Promise<{ updated: number; isDone: boolean; cursor: string | null }> =>
    await backfillEmailLowerPage(ctx, cursor),
});

/** The same step for a signed-in administrator (an in-app caller). */
export const backfillProfileEmailLower = mutation({
  args: {
    /** From the previous call. Omit on the first one. */
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (
    ctx,
    { cursor },
  ): Promise<{ updated: number; isDone: boolean; cursor: string | null }> => {
    await requireAdmin(ctx);
    return await backfillEmailLowerPage(ctx, cursor);
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
    // How the bridge authenticates to this gateway. "token" (default) is the
    // shared operator credential every deployment has used so far; "trusted-proxy"
    // makes the bridge name the person behind each socket, so the gateway keeps a
    // profile per Atrium user. The GATEWAY must be configured for the same mode —
    // upstream refuses to hold a token in trusted-proxy mode — which is why this
    // is set per instance and never deployment-wide.
    authMode: v.optional(v.union(v.literal("token"), v.literal("trusted-proxy"))),
    // Scopes a conversation's socket carries under "trusted-proxy". Absent ⇒
    // "capped", which is what every instance did before this existed. See the
    // schema comment for what the ceiling costs and when it buys anything.
    personScopes: v.optional(v.union(v.literal("capped"), v.literal("full"))),
    // WHICH STRING names a person to this gateway under "trusted-proxy". Absent ⇒
    // "canonical", Atrium's own stable key and what every instance sent before this
    // existed. "email" makes Atrium agree with an identity proxy that names people
    // by their address in front of the SAME gateway. Never a session-key segment.
    identitySource: v.optional(
      v.union(v.literal("canonical"), v.literal("email")),
    ),
    systemIdentity: v.optional(v.string()),
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
      // Absent ⇒ the field is cleared to "token" semantics at the bridge, which is
      // the behaviour of every instance written before this existed.
      authMode: args.authMode,
      personScopes: args.personScopes,
      systemIdentity: args.systemIdentity?.trim() || undefined,
      streamTransport: args.streamTransport,
      // `identitySource` is deliberately NOT here — see the patch path below.
    };
    // Refuse a name whose deletion sweep is still owed — same guard the
    // provisioner endpoint applies. Creation only: patching an EXISTING row cannot
    // collide with a sweep, since a sweep only ever runs for a name no instance
    // serves.
    if (!args.instanceId) {
      await assertNameNotSweeping(ctx, args.name);
    }
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
      await ctx.db.patch(args.instanceId, {
        ...fields,
        // OMISSION PRESERVES, for this field only. Convex DELETES a field patched
        // with `undefined`, so a caller that does not know this argument — an older
        // client, a provisioning script written before it existed — would reset the
        // instance to naming people by the Atrium key and hand each of them the
        // second gateway profile the setting exists to merge, silently. `"canonical"`
        // remains the explicit way to ask for that.
        //
        // The neighbours above deliberately keep clearing: an omitted `authMode` or
        // `personScopes` falls back to the SAFE side (a shared token, a capped
        // socket). An omitted naming would fall back to the BROKEN side, which is
        // why it is the exception rather than a style inconsistency.
        identitySource: args.identitySource ?? existing.identitySource,
      });
      return args.instanceId;
    }
    return await ctx.db.insert("instances", {
      ...fields,
      // A new instance with nothing stated names people by the Atrium key, which is
      // what "absent" means everywhere else in this feature.
      identitySource: args.identitySource,
    });
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
    const { sweepName } = await deleteInstanceCascade(ctx, instanceId);
    // The name-bound rows are swept in bounded, rescheduled batches — see
    // lib/instanceCascade. The admin path uses the SAME chain as the provisioner
    // endpoint so neither can drift into leaving grants behind.
    if (sweepName !== null) {
      await openCascadeJob(ctx, sweepName);
      await ctx.scheduler.runAfter(
        0,
        internal.instanceCascade.sweepInstanceCascade,
        { name: sweepName },
      );
    }
  },
});
