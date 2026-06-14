// Current-user surface: the FIRST thing the authenticated client calls.
//
// `bootstrap` is the ONLY public mutation a "pending" user is allowed to call:
// it provisions the profile (via the single role-writer `ensureProfile`, which
// also runs first-admin bootstrap) so the user appears in the admin's approval
// list. Every other public function requires an ACTIVE role and would reject a
// pending user — without this entry point a pending user would be invisible to
// admins and could never be approved.
//
// `getMe` is a reactive read the UI subscribes to: it drives BOTH the surface
// choice (pending / chat / admin) AND the resolved theme. Theme preference is
// identity-level (a pending user still controls it), so `setThemeMode` is gated
// on requireUserId, not requireActive.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  effectiveUserPermissions,
  ensureProfile,
  getActor,
  getProfile,
  requireRealUserId,
  requireUserId,
  roleOf,
} from "./lib/access";
import { auditImpersonated } from "./lib/audit";
import {
  isUiPrefKey,
  prefGateKey,
  resolveUiPrefs,
  type FeaturesEnabled,
  type UiPrefsObject,
} from "./lib/uiPrefs";
import { resolveChart } from "./lib/charts";
import { isChartAvailableToUser, resolveChartTokens } from "./charts";

const APP_META_KEY = "singleton";

type ThemeMode = "light" | "dark" | "system";
type Locale = "fr" | "en";

// Mirror project.inlang/settings.json baseLocale. The UI language resolves to
// this when neither the user nor the admin has set a preference.
const BASE_LOCALE: Locale = "fr";

async function readAppMeta(ctx: QueryCtx | MutationCtx) {
  return await ctx.db
    .query("appMeta")
    .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
    .unique();
}

// Resolve the effective theme mode: user pref -> admin default -> "system".
// (Mode-only fallback chain; there is no "system" palette equivalent.)
function resolveThemeMode(
  userMode: ThemeMode | undefined,
  adminDefault: ThemeMode | undefined,
): ThemeMode {
  return userMode ?? adminDefault ?? "system";
}

// Resolve the effective UI language: user pref -> admin default -> baseLocale.
function resolveLocale(
  userLocale: Locale | undefined,
  adminDefault: Locale | undefined,
): Locale {
  return userLocale ?? adminDefault ?? BASE_LOCALE;
}

export const bootstrap = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await ensureProfile(ctx);
    const profile = await getProfile(ctx, userId);
    return { role: roleOf(profile) };
  },
});

// Public (PRE-AUTH) — which sign-in providers this deployment has enabled, so the
// sign-in screen renders the right buttons. Booleans ONLY: no client-id, issuer,
// or secret ever crosses this boundary. Microsoft requires BOTH creds AND a
// tenant issuer (mirrors auth.ts's refuse-without-issuer rule).
export const authProviders = query({
  args: {},
  handler: async () => ({
    google: !!process.env.AUTH_GOOGLE_ID,
    microsoft:
      !!process.env.AUTH_MICROSOFT_ENTRA_ID_ID &&
      !!process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
    anonymous: process.env.OPENCLAW_ENABLE_ANON_AUTH === "1",
  }),
});

export const getMe = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const profile = await getProfile(ctx, userId);
    const meta = await readAppMeta(ctx);
    const adminDefaultMode = meta?.defaultThemeMode as ThemeMode | undefined;
    const userMode = profile?.themeMode as ThemeMode | undefined;
    const adminDefaultLocale = meta?.defaultLocale as Locale | undefined;
    const userLocale = profile?.locale as Locale | undefined;
    // Chart (charte graphique): resolve the user's pick against availability, then
    // against the admin global default. BOUNDED hot path: only the user's OWN pick
    // needs an availability check (resolveChart applies the admin default WITHOUT
    // one), so we probe THAT single key (isChartAvailableToUser) instead of
    // enumerating every chart — getMe must not subscribe to all common customs
    // (an unrelated chart edit would otherwise invalidate every session). The KEY
    // is resolved to its TOKENS server-side below (resolvedChartTokens).
    const userChartKey = profile?.themeName ?? null;
    const adminDefaultChart = meta?.defaultThemeName ?? null;
    const availableChartKeys = new Set<string>();
    if (
      userChartKey !== null &&
      (await isChartAvailableToUser(ctx, userId, userChartKey))
    ) {
      availableChartKeys.add(userChartKey);
    }
    const resolvedChart = resolveChart(
      userChartKey,
      adminDefaultChart,
      availableChartKeys,
    );
    // P4: resolve the chart KEY to its TOKENS server-side (builtin from the code
    // registry, custom from the `charts` table) so the client applies tokens
    // directly (no client-side key->tokens map, no builtin/custom branching in
    // the browser). null for the native index.css look.
    const resolvedChartTokens = await resolveChartTokens(
      ctx,
      resolvedChart.chartKey,
    );
    return {
      userId,
      role: roleOf(profile),
      email: profile?.email ?? null,
      name: profile?.name ?? null,
      hasProfile: profile !== null,
      // Theme: the user's own pref (or null) + the resolved effective value the
      // client should apply + the admin default (so the Theme tab can show it).
      themeMode: userMode ?? null,
      resolvedThemeMode: resolveThemeMode(userMode, adminDefaultMode),
      defaultThemeMode: adminDefaultMode ?? null,
      // Chart (charte graphique): the user's own pick (or null) + the resolved
      // effective key + its source ("user" | "common/admin" | "code") + the
      // admin global default (so the Apparence tab can show it). The resolved
      // TOKENS are returned too (resolvedChartTokens, below) -- the client
      // applies them directly, no key->tokens map.
      chartKey: userChartKey,
      resolvedChartKey: resolvedChart.chartKey,
      chartSource: resolvedChart.source,
      defaultChartKey: adminDefaultChart,
      // P4: the resolved chart's TOKENS (builtin from the registry OR custom from
      // the DB, resolved server-side). null = native look. The client applies
      // these directly via applyChartTokens (no client-side resolution).
      resolvedChartTokens,
      // UI language (mirror of theme): the user's own pref (or null) + the
      // resolved effective locale the client applies via Paraglide + the admin
      // default. The client's useApplyLocale reconciles localStorage to this.
      locale: userLocale ?? null,
      resolvedLocale: resolveLocale(userLocale, adminDefaultLocale),
      defaultLocale: adminDefaultLocale ?? null,
      // Unified UI preferences (the interface-config module): the resolved
      // effective values the chat renders by, plus the user's own overrides, the
      // admin defaults, and which features are system-enabled (so the Préférences
      // panel can grey locked toggles). Resolution + the system gate live in
      // convex/lib/uiPrefs (single source of truth).
      ui: resolveUiPrefs(
        profile?.uiPrefs as UiPrefsObject | undefined,
        meta?.uiPrefDefaults as UiPrefsObject | undefined,
        meta?.featuresEnabled as FeaturesEnabled | undefined,
      ),
      // Per-user Settings tab order (drag-and-drop). null = default code order;
      // the client merges saved keys first, then any new/unknown tabs after.
      settingsTabOrder: profile?.settingsTabOrder ?? null,
      // EFFECTIVE permissions (role ∪ extraPermissions; admins = full superset).
      // The client uses this to gate which Settings tabs are visible/landable.
      // This is convenience for the UI — the SERVER guard on each query is the
      // real boundary.
      permissions: [...(await effectiveUserPermissions(ctx, userId))],
    };
  },
});

// Single write path for the UI preferences module. `value: null` clears the
// override (re-inherit the default). The SERVER-SIDE gate is the real
// enforcement (greying is cosmetic): a system-gated feature cannot be turned ON
// until an admin has enabled the underlying system in appMeta.featuresEnabled.
export const setUiPref = mutation({
  args: { key: v.string(), value: v.union(v.boolean(), v.null()) },
  handler: async (ctx, { key, value }) => {
    const userId = await requireUserId(ctx);
    const profile = await getProfile(ctx, userId);
    if (profile === null) return; // pre-bootstrap
    if (!isUiPrefKey(key)) throw new Error(`Unknown UI preference: ${key}`);

    const gate = prefGateKey(key);
    if (gate && value === true) {
      const meta = await readAppMeta(ctx);
      const enabled =
        (meta?.featuresEnabled as FeaturesEnabled | undefined)?.[gate] === true;
      if (!enabled) {
        throw new Error(`Feature not enabled: ${key}`);
      }
    }

    const cur = (profile.uiPrefs ?? {}) as UiPrefsObject;
    // IDEMPOTENT: a write here invalidates getMe, which cascades a re-run of EVERY
    // profile-reading query (the whole chat page). So skip a no-op (same value).
    const curVal = cur[key];
    const nextVal = value === null ? undefined : value;
    if (curVal === nextVal) return;
    const next: UiPrefsObject = { ...cur };
    if (value === null) delete next[key];
    else next[key] = value;
    await ctx.db.patch(profile._id, { uiPrefs: next });
  },
});

// Persist the calling user's Settings tab ORDER (drag-and-drop in SettingsNav).
// Identity-level (requireUserId): a user's own nav layout, not a privileged
// action. We store the raw key list as-is; the client is the source of which keys
// are valid and merges unknown/new tabs on read, so a stale key here is harmless.
export const setSettingsTabOrder = mutation({
  args: { order: v.array(v.string()) },
  handler: async (ctx, { order }) => {
    const userId = await requireUserId(ctx);
    const profile = await getProfile(ctx, userId);
    if (profile === null) return; // pre-bootstrap
    await ctx.db.patch(profile._id, { settingsTabOrder: order });
  },
});

// NOTE: the former setShowTools / setVoiceInput mutations were removed — the UI
// preferences module (`setUiPref`) is now the single write path for those toggles
// (showTools/voiceInput), with the legacy profile fields kept read-only for
// existing rows (see convex/lib/uiPrefs.ts + getMe).

// Set the calling user's theme preference. Identity-level: requireUserId (NOT
// requireActive) so a pending user on the waiting screen can still theme the UI.
// Passing null clears the pref (revert to the admin default).
export const setThemeMode = mutation({
  args: {
    mode: v.union(
      v.literal("light"),
      v.literal("dark"),
      v.literal("system"),
      v.null(),
    ),
  },
  handler: async (ctx, { mode }) => {
    // Effective identity: while impersonating, this acts on the TARGET's theme
    // (full "act as the user" scope) and is audited.
    const actor = await getActor(ctx);
    const userId = actor.effectiveUserId;
    const profile = await getProfile(ctx, userId);
    if (profile === null) {
      // No profile yet (pre-bootstrap, real user only — a target always has one).
      // Create a minimal pending profile carrying just the theme pref.
      await ctx.db.insert("profiles", {
        userId,
        role: "pending",
        themeMode: mode ?? undefined,
      });
      return;
    }
    // IDEMPOTENT: skip a no-op (selecting the already-active mode) — it would
    // invalidate getMe and cascade a full re-query of the chat page for nothing.
    const nextMode = mode ?? undefined;
    if (profile.themeMode === nextMode) return;
    await ctx.db.patch(profile._id, { themeMode: nextMode });
    await auditImpersonated(ctx, actor, "theme.set", {
      resource: "profile",
      resourceId: userId,
    });
  },
});

// Set the calling user's UI language preference. Identity-level (requireUserId
// via getActor, NOT requireActive) so a pending user can localize the waiting
// screen too. Passing null clears the pref (revert to the admin default / base
// locale). Mirror of setThemeMode; the client applies it through Paraglide's
// setLocale (which writes localStorage + reloads ONCE on a real change).
export const setLocale = mutation({
  args: {
    locale: v.union(v.literal("fr"), v.literal("en"), v.null()),
  },
  handler: async (ctx, { locale }) => {
    // Effective identity: while impersonating, this acts on the TARGET's locale
    // (full "act as the user" scope) and is audited.
    const actor = await getActor(ctx);
    const userId = actor.effectiveUserId;
    const profile = await getProfile(ctx, userId);
    if (profile === null) {
      // No profile yet (pre-bootstrap, real user only). Create a minimal pending
      // profile carrying just the locale pref.
      await ctx.db.insert("profiles", {
        userId,
        role: "pending",
        locale: locale ?? undefined,
      });
      return;
    }
    await ctx.db.patch(profile._id, { locale: locale ?? undefined });
    await auditImpersonated(ctx, actor, "locale.set", {
      resource: "profile",
      resourceId: userId,
    });
  },
});

// Set the calling user's OWN display name (shown in the user list + account
// menu). Identity-level (effective user, like setLocale) so it works while
// impersonating too. The display name is USER-OWNED: ensureProfile only SEEDS it
// from the IdP and never overwrites a set value, so this edit sticks across
// sign-ins (e.g. a newly married last name). Blank clears it (the list then
// falls back to the email). Bounded so it can never become an unbounded blob.
export const setMyName = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const trimmed = name.trim().slice(0, 120);
    const next = trimmed.length > 0 ? trimmed : undefined;
    const actor = await getActor(ctx);
    const userId = actor.effectiveUserId;
    const profile = await getProfile(ctx, userId);
    if (profile === null) {
      // Pre-bootstrap (real user only): a minimal pending profile carrying the
      // name, mirroring setLocale's pre-bootstrap path.
      await ctx.db.insert("profiles", { userId, role: "pending", name: next });
      return;
    }
    await ctx.db.patch(profile._id, { name: next });
    await auditImpersonated(ctx, actor, "name.set", {
      resource: "profile",
      resourceId: userId,
    });
  },
});

// Whether the caller is CURRENTLY impersonating, for the warning banner. Keyed
// off the REAL identity (requireRealUserId) so it never resolves through the
// impersonation it is reporting on. Returns false for non-admins (no leak).
export const getImpersonation = query({
  args: {},
  handler: async (ctx) => {
    const realUserId = await requireRealUserId(ctx);
    const realProfile = await getProfile(ctx, realUserId);
    const targetId = realProfile?.impersonatingUserId;
    if (roleOf(realProfile) !== "admin" || !targetId) {
      return { impersonating: false as const };
    }
    const target = await getProfile(ctx, targetId);
    if (target === null) return { impersonating: false as const };
    return {
      impersonating: true as const,
      targetLabel:
        target.email ?? target.name ?? target.canonical ?? "utilisateur",
      targetRole: roleOf(target),
      realLabel: realProfile.email ?? realProfile.name ?? "admin",
    };
  },
});
