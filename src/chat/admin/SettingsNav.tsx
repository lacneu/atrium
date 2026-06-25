import { useEffect, useMemo, useState } from "react";
import { APP_HOST } from "@/lib/appHost";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { api } from "../convexApi";
import {
  PARAMLESS_TABS,
  TABS,
  TAB_LABELS,
  pathForTab,
  tabFromPathname,
  visibleTabs,
  type ParamlessTab,
  type Tab,
} from "../AdminSettings";
import {
  SETTINGS_GROUPS,
  firstTabOfGroup,
  groupOfTab,
  type SettingsGroup,
} from "./settingsGroups";
import { BridgeStatusBadge } from "./BridgeStatusBadge";
import { m } from "@/paraglide/messages.js";

// i18n overrides for tab nav labels, applied as they get internationalized
// (the rest still fall back to the FR TAB_LABELS until the full migration).
const TAB_I18N: Partial<Record<Tab, () => string>> = {
  users: () => m.settings_tab_users(),
  groups: () => m.settings_tab_groups(),
  instances: () => m.settings_tab_instances(),
  bridge: () => m.settings_tab_bridge(),
  injections: () => m.settings_tab_injections(),
  serviceAccounts: () => m.settings_tab_serviceaccounts(),
  roles: () => m.settings_tab_roles(),
  traces: () => m.settings_tab_traces(),
  kpi: () => m.settings_tab_kpi(),
  anomalies: () => m.settings_tab_anomalies(),
  files: () => m.files_tab_label(),
  agentFiles: () => m.afiles_tab_label(),
  preferences: () => m.settings_tab_preferences(),
  chatDefaults: () => m.cdefaults_tab_label(),
  access: () => m.settings_tab_access(),
  integrations: () => m.settings_tab_integrations(),
  theme: () => m.appearance_tab_label(),
  audit: () => m.settings_tab_audit(),
  feedbacks: () => m.settings_tab_feedbacks(),
};

// Two-level settings navigation (layer-cake, docs/CONF_RESEARCH.md):
// - SettingsNav (left column) lists the 4 GROUPS; the active group derives
//   from the current /settings/<tab> pathname (no new URL — deep links work).
// - SettingsTabBar (top of the right panel) lists the active group's allowed
//   tabs and carries the per-user drag-and-drop order (#91): a drag reorders
//   tabs WITHIN their group and persists the spliced FULL order, so the saved
//   me.settingsTabOrder shape is unchanged and hidden/other-group tabs keep
//   their positions.

type FilteredTabPath =
  | "/settings/users"
  | "/settings/serviceAccounts"
  | "/settings/traces"
  | "/settings/kpi"
  | "/settings/anomalies"
  | "/settings/audit";

// Merge a saved order with the code TABS: keep saved (valid, de-duped) keys
// first, then append any tab not in the saved list (newly added tabs). Unknown/
// stale saved keys are dropped. Pure → safe to memoize + unit-test.
export function mergeOrder(saved: string[] | null | undefined): Tab[] {
  const valid = new Set<string>(TABS);
  const seen = new Set<string>();
  const out: Tab[] = [];
  for (const k of saved ?? []) {
    if (valid.has(k) && !seen.has(k)) {
      out.push(k as Tab);
      seen.add(k);
    }
  }
  for (const t of TABS) if (!seen.has(t)) out.push(t);
  return out;
}

// Splice a reordered SUBSET back into the full order: every position held by a
// member of `reordered` is refilled with the new arrangement in sequence; all
// other tabs (other groups, hidden tabs) keep their exact positions. Pure →
// unit-tested (settingsNav.test.ts).
export function applyGroupReorder(
  fullOrder: readonly Tab[],
  reordered: readonly Tab[],
): Tab[] {
  const members = new Set(reordered);
  const queue = [...reordered];
  return fullOrder.map((t) => (members.has(t) ? (queue.shift() as Tab) : t));
}

function TabLink({ tab, active }: { tab: Tab; active: boolean }) {
  const label = TAB_I18N[tab]?.() ?? TAB_LABELS[tab] ?? tab;
  const className = "oc-settings-tabs__tab" + (active ? " is-active" : "");
  const content = (
    <>
      <span className="oc-settings-tabs__label">{label}</span>
      {tab === "bridge" ? <BridgeStatusBadge /> : null}
    </>
  );
  if (PARAMLESS_TABS.includes(tab as ParamlessTab)) {
    return (
      <Link
        to="/settings/$tab"
        params={{ tab: tab as ParamlessTab }}
        className={className}
        role="tab"
        aria-selected={active}
      >
        {content}
      </Link>
    );
  }
  return (
    <Link
      to={`/settings/${tab}` as FilteredTabPath}
      className={className}
      role="tab"
      aria-selected={active}
    >
      {content}
    </Link>
  );
}

function SortableTab({ tab, active }: { tab: Tab; active: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tab });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="oc-settings-tabs__item"
      role="presentation"
    >
      <button
        type="button"
        className="oc-settings-tabs__grip"
        aria-label={m.settingsnav_reorder()}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} aria-hidden />
      </button>
      <TabLink tab={tab} active={active} />
    </div>
  );
}

// Horizontal tab bar at the top of the Settings right panel: the ACTIVE
// group's tabs this user may open, in their custom order. Mounted by the
// settings-layout route (router.tsx) above the tab content.
export function SettingsTabBar() {
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const saveOrder = useMutation(api.me.setSettingsTabOrder);
  const pathname = useLocation({ select: (l) => l.pathname });
  const activeTab = tabFromPathname(pathname);
  const group = activeTab !== undefined ? groupOfTab(activeTab) : undefined;

  const serverOrder = useMemo(
    () => mergeOrder(me?.settingsTabOrder ?? null),
    [me?.settingsTabOrder],
  );
  // Optimistic local order: apply a drag instantly, then persist; re-sync if the
  // server value changes (e.g. another device).
  const [order, setOrder] = useState<Tab[]>(serverOrder);
  useEffect(() => setOrder(serverOrder), [serverOrder]);

  // Per-tab RBAC: only the tabs this user may open (admins see all). The drag
  // list operates on this VISIBLE in-group subset, so a non-admin never
  // reorders into a tab they can't see.
  const visibleSet = useMemo(
    () => new Set(visibleTabs(me?.permissions ?? [])),
    [me?.permissions],
  );
  const groupTabs = useMemo(
    () =>
      group === undefined
        ? []
        : order.filter((t) => visibleSet.has(t) && groupOfTab(t) === group),
    [order, visibleSet, group],
  );

  // Pointer (distance constraint so a grip click doesn't start a spurious drag)
  // + KEYBOARD: the grip announces space/arrow reordering, so it must actually
  // work for keyboard users (a11y).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (group === undefined || groupTabs.length === 0) return null;
  const groupDef = SETTINGS_GROUPS.find((g) => g.id === group);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = groupTabs.indexOf(active.id as Tab);
    const to = groupTabs.indexOf(over.id as Tab);
    if (from < 0 || to < 0) return;
    // Reorder within the group, then splice back into the FULL per-user order
    // (other groups + hidden tabs keep their positions) and persist it.
    const next = applyGroupReorder(order, arrayMove(groupTabs, from, to));
    setOrder(next); // optimistic
    void saveOrder({ order: next });
  }

  return (
    <div
      className="oc-settings-tabs"
      role="tablist"
      aria-label={groupDef?.label()}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={groupTabs} strategy={horizontalListSortingStrategy}>
          {groupTabs.map((t) => (
            <SortableTab key={t} tab={t} active={t === activeTab} />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

// Vertical settings navigation (left column — replaces the chat list while in
// Settings): the 4 groups, each visible only when it contains >=1 allowed tab.
// Clicking a group opens its first allowed tab (in the user's custom order).
export function SettingsNav() {
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const activeTab = tabFromPathname(pathname);
  const activeGroup = activeTab !== undefined ? groupOfTab(activeTab) : undefined;

  const visibleSet = useMemo(
    () => new Set(visibleTabs(me?.permissions ?? [])),
    [me?.permissions],
  );
  const visibleOrder = useMemo(
    () => mergeOrder(me?.settingsTabOrder ?? null).filter((t) => visibleSet.has(t)),
    [me?.settingsTabOrder, visibleSet],
  );
  const groups = SETTINGS_GROUPS.filter((g) =>
    g.tabs.some((t) => visibleSet.has(t)),
  );

  function openGroup(g: SettingsGroup) {
    const first = firstTabOfGroup(visibleOrder, g.id);
    // pathForTab returns a valid /settings/<tab> path; cast to satisfy the typed
    // navigate `to` (runtime resolves the string against the route tree).
    if (first) void navigate({ to: pathForTab(first) as "/settings/users" });
  }

  return (
    <nav className="oc-settings-nav" aria-label={m.settingsnav_aria()}>
      <Link to="/" className="oc-settings-nav__back">
        {m.settingsnav_back()}
      </Link>
      <div className="oc-settings-nav__title">{m.settingsnav_title()}</div>
      <div className="oc-settings-nav__list">
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            className={
              "oc-settings-nav__group" + (g.id === activeGroup ? " is-active" : "")
            }
            aria-current={g.id === activeGroup ? "true" : undefined}
            onClick={() => openGroup(g)}
          >
            {g.label()}
          </button>
        ))}
      </div>
    </nav>
  );
}
