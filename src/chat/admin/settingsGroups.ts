import { m } from "@/paraglide/messages.js";
import { visibleTabs, type Tab } from "../AdminSettings";

// Settings navigation GROUPS (layer-cake chunking, docs/CONF_RESEARCH.md): the
// left sidebar lists these 4 groups; the right panel shows a horizontal tab bar
// with the active group's tabs. URLs stay /settings/<tab> — the active group is
// DERIVED from the current tab (groupOfTab), so deep links keep working and no
// new route is needed.
//
// Every tab in TABS must belong to EXACTLY one group (settingsGroups.test.ts
// enforces the lockstep — adding a tab without a group fails CI with a clear
// message). Note: the former `uiprefs` admin tab merged INTO `preferences`
// (per-row governance controls behind the admin-only mode); /settings/uiprefs
// redirects there (SETTINGS_TAB_REDIRECTS).

export type SettingsGroupId =
  | "personal"
  | "agents"
  | "access"
  | "observability";

export type SettingsGroup = {
  id: SettingsGroupId;
  label: () => string;
  tabs: readonly Tab[];
};

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "personal",
    label: () => m.settings_group_personal(),
    tabs: ["preferences", "theme", "files", "scheduled"],
  },
  {
    id: "agents",
    label: () => m.settings_group_agents(),
    tabs: ["instances", "agentFiles", "chatDefaults", "voice", "bridge", "injections"],
  },
  {
    id: "access",
    label: () => m.settings_group_access(),
    tabs: ["users", "groups", "access", "roles", "serviceAccounts"],
  },
  {
    id: "observability",
    label: () => m.settings_group_observability(),
    tabs: [
      "traces",
      "kpi",
      "anomalies",
      "audit",
      "feedbacks",
      "subagentReports",
      "integrations",
    ],
  },
];

// tab → owning group id, built once from SETTINGS_GROUPS (single source).
const GROUP_OF_TAB: ReadonlyMap<Tab, SettingsGroupId> = new Map(
  SETTINGS_GROUPS.flatMap((g) => g.tabs.map((t) => [t, g.id] as const)),
);

export function groupOfTab(tab: Tab): SettingsGroupId {
  const id = GROUP_OF_TAB.get(tab);
  if (!id) throw new Error(`Settings tab "${tab}" belongs to no group`);
  return id;
}

// The groups a holder of `perms` may see (those containing >=1 visible tab),
// in SETTINGS_GROUPS order. Mirrors visibleTabs so the sidebar can never show
// a group whose every tab the RBAC layer hides.
export function visibleGroups(perms: readonly string[]): SettingsGroupId[] {
  const visible = new Set(visibleTabs(perms));
  return SETTINGS_GROUPS.filter((g) => g.tabs.some((t) => visible.has(t))).map(
    (g) => g.id,
  );
}

// First tab of `group` within `orderedTabs` (the user's VISIBLE tabs in their
// custom order) — the destination when clicking a sidebar group. Undefined when
// the group has no visible tab (the sidebar hides such groups).
export function firstTabOfGroup(
  orderedTabs: readonly Tab[],
  group: SettingsGroupId,
): Tab | undefined {
  return orderedTabs.find((t) => groupOfTab(t) === group);
}

// Flat list of every grouped tab (duplicates preserved) — the lockstep test
// checks it against the REAL tab universe (TABS) for totality and uniqueness.
export const ALL_GROUPED_TABS: readonly Tab[] = SETTINGS_GROUPS.flatMap(
  (g) => [...g.tabs],
);
