// Admin-only settings surface (rendered only when me.role === "admin"; every
// underlying Convex function also enforces requireAdmin server-side, so this UI
// is a convenience, not the security boundary). The shell (header + tab nav +
// admin guard + ToastProvider) lives in the router's settings-layout route
// (src/router.tsx); each tab below is mounted by its own route. `TABS` is the
// single source of truth the router and the nav both read.

import { m } from "@/paraglide/messages.js";

// Tab order = nav order. The router declares one STATIC route per FILTERED tab
// (its own typed search schema) and one shared `$tab` route for the paramless
// tabs (roles/integrations/instances/theme) — but the user-facing URL is always
// `/settings/<tab>`, and this tuple is what both sides validate against.
export const TABS = [
  "users",
  "groups",
  "instances",
  "bridge",
  "injections",
  "serviceAccounts",
  "roles",
  "access",
  "traces",
  "kpi",
  "anomalies",
  "files",
  "agentFiles",
  "preferences",
  "integrations",
  "theme",
  "chatDefaults",
  "audit",
  "feedbacks",
  "subagentReports",
  "voice",
] as const;
export type Tab = (typeof TABS)[number];

// The paramless tabs — they ride the shared `/settings/$tab` route in the router.
export const PARAMLESS_TABS = [
  "groups",
  "access",
  "roles",
  "integrations",
  "instances",
  "injections",
  "theme",
  "feedbacks",
  "subagentReports",
  "files",
  "agentFiles",
  "preferences",
  "chatDefaults",
] as const;
export type ParamlessTab = (typeof PARAMLESS_TABS)[number];

// i18n labels for the Settings tabs, shared by every consumer (nav tab bar,
// grant editor…). Thunks — NOT resolved strings — so each render reads the
// ACTIVE locale (a module-level m.*() call would freeze the boot locale).
// Total over TABS (Record<Tab, ...> enforces it): adding a tab without its
// label is a compile error, so no FR fallback map is needed anymore.
export const TAB_I18N: Record<Tab, () => string> = {
  users: () => m.settings_tab_users(),
  groups: () => m.settings_tab_groups(),
  instances: () => m.settings_tab_instances(),
  bridge: () => m.settings_tab_bridge(),
  injections: () => m.settings_tab_injections(),
  serviceAccounts: () => m.settings_tab_serviceaccounts(),
  roles: () => m.settings_tab_roles(),
  access: () => m.settings_tab_access(),
  traces: () => m.settings_tab_traces(),
  kpi: () => m.settings_tab_kpi(),
  anomalies: () => m.settings_tab_anomalies(),
  files: () => m.files_tab_label(),
  agentFiles: () => m.afiles_tab_label(),
  preferences: () => m.settings_tab_preferences(),
  integrations: () => m.settings_tab_integrations(),
  theme: () => m.appearance_tab_label(),
  chatDefaults: () => m.cdefaults_tab_label(),
  audit: () => m.settings_tab_audit(),
  feedbacks: () => m.settings_tab_feedbacks(),
  subagentReports: () => m.settings_tab_subagentreports(),
  voice: () => m.voice_tab_label(),
};

// --- Per-tab RBAC ----------------------------------------------------------
// Which permission gates each Settings tab. Admins hold EVERY permission (the
// "*" wildcard expands to all), so they see every tab; a non-admin sees only the
// tabs whose permission was explicitly granted (profile.extraPermissions). This
// is UI convenience ONLY — every tab's Convex queries enforce the SAME
// permission server-side (requirePermission / requireAdmin), which is the real
// boundary. Keep this map total over TABS (Record<Tab,...> enforces that).
export const TAB_PERMISSION: Record<Tab, string> = {
  users: "admin.manage",
  groups: "groups.manage",
  instances: "admin.manage",
  bridge: "bridge.read",
  // Prompt injections are bridge config (write) — admin-only, like Instances/Integrations.
  injections: "admin.manage",
  serviceAccounts: "admin.manage",
  roles: "admin.manage",
  // Introspection ("who has access to what") reads ANOTHER user's access map, so
  // it is admin-only (the query re-checks admin.manage on the REAL identity).
  access: "admin.manage",
  traces: "traces.read",
  kpi: "kpi.read",
  anomalies: "anomalies.read",
  // Files is owner-scoped (each user sees only their own), so it's gated on the
  // base `chats.read` permission every approved user already holds (admins via
  // the wildcard) → visible to ALL users by default, NOT a grantable admin tab.
  files: "chats.read",
  // Agent workspace files (CONF-4c). Grantable read permission; the server
  // additionally restricts non-admins to the RULE files (A3) and writes to
  // admin.manage — this gate only controls tab visibility.
  agentFiles: "agents.files.read",
  // Personal preferences (language + UI toggles) — owner-scoped, gated on the
  // base `chats.read` every approved user holds → visible to ALL, not grantable.
  preferences: "chats.read",
  integrations: "admin.manage",
  // Apparence: the per-user "charte graphique" picker is owner-scoped, gated on
  // the base `chats.read` every approved user holds -> visible to ALL. The admin
  // controls (global default chart, per-builtin availability, default theme-mode
  // / language) are gated INSIDE the component on me.role==="admin", and the
  // server independently gates each admin mutation on CHARTS_MANAGE / admin.
  theme: "chats.read",
  // Global chat defaults (CONF-4d) write the gateway's openclaw.json — strictly
  // admin (the agentFiles actions re-check admin.manage server-side).
  chatDefaults: "admin.manage",
  audit: "admin.manage",
  feedbacks: "admin.manage",
  subagentReports: "admin.manage",
  // Voice settings write the instance config (browser read-aloud knobs) —
  // admin-only, like Instances/ChatDefaults.
  voice: "admin.manage",
};

// The Settings tabs an admin may grant to a NON-admin. Mirrors the server-side
// GRANTABLE_USER_PERMISSIONS whitelist in convex/lib/rbac.ts — a consistency
// test (tabAccess.test.ts) keeps the two in lockstep so the grant editor can
// never offer a permission the server would reject.
export const GRANTABLE_TABS: readonly Tab[] = [
  "traces",
  "kpi",
  "anomalies",
  "bridge",
  "agentFiles",
  // Delegated group management (gated groups.manage; scoped to managed groups +
  // admin-only structural actions inside). Lockstep with GRANTABLE_USER_PERMISSIONS.
  "groups",
];

// The tabs a holder of `perms` may see, in canonical TABS (nav) order.
export function visibleTabs(perms: readonly string[]): Tab[] {
  const set = new Set(perms);
  return TABS.filter((t) => set.has(TAB_PERMISSION[t]));
}

// URL for a tab. The user-facing form is always `/settings/<tab>` (filtered and
// paramless tabs share the same surface). Used for programmatic navigation.
export function pathForTab(tab: Tab): string {
  return `/settings/${tab}`;
}

// The tab key embedded in a `/settings/<tab>` pathname, validated to the closed
// TABS set (undefined for `/settings` itself or an unknown segment).
export function tabFromPathname(pathname: string): Tab | undefined {
  const seg = pathname.split("/")[2];
  return (TABS as readonly string[]).includes(seg) ? (seg as Tab) : undefined;
}

// RETIRED tab keys -> the live tab that absorbed them. The router mounts one
// static redirect route per entry so old bookmarks (/settings/uiprefs) keep
// working instead of 404ing. Sources must NOT be in TABS; targets must be
// (tabAccess.test.ts pins both).
export const SETTINGS_TAB_REDIRECTS = {
  // The admin "UI preferences" governance tab merged into Preferences (per-row
  // governance controls behind the admin-only "manage defaults & locks" mode).
  uiprefs: "preferences",
} as const satisfies Record<string, Tab>;

