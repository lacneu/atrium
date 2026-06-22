import { useMemo, useState } from "react";
import { APP_HOST } from "@/lib/appHost";
import { useAction, useMutation, useQuery } from "convex/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { AGENT_TYPE_CODES } from "../../convex/lib/agentTypes";
import { UserAccessSheet } from "./admin/UserAccessSheet";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { DataTableShell } from "./admin/DataTableShell";
import { InstanceConfigDialog, type Instance } from "./admin/BridgeTab";
import { EntitySheet } from "./admin/EntitySheet";
import { useToast } from "@/components/ui/toast";
import { useConfirm, usePrompt } from "@/components/ConfirmDialog";
import { FilterBar } from "./admin/filters/FilterBar";
import { AdvancedFilter } from "./admin/filters/AdvancedFilter";
import { useResolvedRange } from "./admin/filters/TimeRangePicker";
import type { Predicate, TimeRange } from "./admin/filters/types";
import {
  decodeRange,
  encodeRange,
  encodeAdv,
  parseAdv,
  DEFAULT_FROM,
  DEFAULT_TO,
} from "@/lib/routing/searchSchemas";

// Default relative window for the time-ranged admin tabs (audit). Wide (30d) so
// older/seeded rows surface on load — audit previously had NO time filter, so a
// narrow default would hide rows older than it within the bounded window.
// Re-resolves to NOW via useResolvedRange so the subscription stays current.
const DEFAULT_RANGE: TimeRange = { kind: "relative", from: DEFAULT_FROM, to: DEFAULT_TO };

// A "select all" sentinel for the quick <Select>s (radix Select has no empty
// value), mapped back to `undefined` (no filter) when building the query arg.
const ALL = "__all__";

// Admin-only settings surface (rendered only when me.role === "admin"; every
// underlying Convex function also enforces requireAdmin server-side, so this UI
// is a convenience, not the security boundary). The shell (header + tab nav +
// admin guard + ToastProvider) lives in the router's settings-layout route
// (src/router.tsx); each tab below is mounted by its own route. `TABS` is the
// single source of truth the router and the nav both read.

// Tab order = nav order. The router declares one STATIC route per FILTERED tab
// (its own typed search schema) and one shared `$tab` route for the paramless
// tabs (roles/integrations/instances/theme) — but the user-facing URL is always
// `/settings/<tab>`, and this tuple is what both sides validate against.
export const TABS = [
  "users",
  "groups",
  "instances",
  "bridge",
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
] as const;
export type Tab = (typeof TABS)[number];

// The paramless tabs — they ride the shared `/settings/$tab` route in the router.
export const PARAMLESS_TABS = [
  "groups",
  "access",
  "roles",
  "integrations",
  "instances",
  "bridge",
  "theme",
  "feedbacks",
  "files",
  "agentFiles",
  "preferences",
  "chatDefaults",
] as const;
export type ParamlessTab = (typeof PARAMLESS_TABS)[number];

// FR labels for tabs whose raw key isn't a clean capitalized word. Tabs absent
// from this map fall back to the CSS text-transform: capitalize on the raw key.
export const TAB_LABELS: Partial<Record<Tab, string>> = {
  groups: "Groupes", // FR fallback; the nav renders m.settings_tab_groups
  access: "Accès", // FR fallback; the nav renders m.settings_tab_access
  serviceAccounts: "Comptes de service",
  roles: "Rôles",
  traces: "Traces",
  kpi: "KPI",
  anomalies: "Anomalies",
  integrations: "Intégrations",
  feedbacks: "Feedbacks",
  bridge: "Bridge",
  files: "Fichiers", // FR fallback; the nav renders the i18n label (m.files_tab_label)
  agentFiles: "Fichiers d'agent", // FR fallback; nav renders m.afiles_tab_label
  theme: "Apparence", // FR fallback; nav renders m.appearance_tab_label
  preferences: "Préférences", // FR fallback; nav renders m.settings_tab_preferences
  // chatDefaults has NO ASCII-safe FR fallback; the nav renders
  // m.cdefaults_tab_label and the tab is admin-only (never in the grant editor).
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
  // The admin "Préférences UI" governance tab merged into Preferences (per-row
  // governance controls behind the admin-only "manage defaults & locks" mode).
  uiprefs: "preferences",
} as const satisfies Record<string, Tab>;

// Per-row editor for the observability tabs an admin grants to a non-admin user.
// A dropdown of checkboxes (the GRANTABLE_TABS); toggling persists immediately
// via admin.setUserPermissions (which re-validates against the server whitelist).
// onSelect is preventDefault'd so the menu stays open while toggling several.
function SettingsAccessCell({
  granted,
  onToggle,
}: {
  granted: string[];
  onToggle: (perm: string) => void;
}) {
  const current = new Set(granted);
  const count = GRANTABLE_TABS.filter((t) =>
    current.has(TAB_PERMISSION[t]),
  ).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-36 justify-start font-normal"
        >
          {count === 0
            ? m.settings_tabs_none()
            : m.settings_tabs_count({ count })}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>{m.settings_allowed_tabs_label()}</DropdownMenuLabel>
        {GRANTABLE_TABS.map((t) => {
          const perm = TAB_PERMISSION[t];
          return (
            <DropdownMenuItem
              key={t}
              className="gap-2"
              onSelect={(e) => {
                e.preventDefault();
                onToggle(perm);
              }}
            >
              <Checkbox
                checked={current.has(perm)}
                aria-hidden
                tabIndex={-1}
                className="pointer-events-none"
              />
              <span>{TAB_LABELS[t] ?? t}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UsersTab() {
  const search = useSearch({ from: "/settings/users" });
  const navigate = useNavigate({ from: "/settings/users" });
  const q = search.q ?? "";
  const role = search.role ?? ALL;
  // `q` is debounced by FilterBar then committed here with replace (no history
  // spam while typing); quick selects push (Back restores the prior filter).
  const setQ = (v: string) =>
    void navigate({ search: (p) => ({ ...p, q: v || undefined }), replace: true });
  const setRoleFilter = (v: string) =>
    void navigate({ search: (p) => ({ ...p, role: v === ALL ? undefined : v }) });

  const users = useQuery(api.admin.listUsers, {
    filter: {
      q: q || undefined,
      role: role === ALL ? undefined : role,
    },
  });
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const setRole = useMutation(api.admin.setRole);
  const setPerms = useMutation(api.admin.setUserPermissions);
  const startImpersonation = useMutation(api.admin.startImpersonation);
  const deleteUser = useMutation(api.admin.deleteUser);
  const setUserName = useMutation(api.admin.setUserName);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  // The user whose Access editor (instance+agent assignment) is open. Replaces
  // the legacy free-text override/group columns (H4).
  const [accessFor, setAccessFor] = useState<{
    profileId: Id<"profiles">;
    label: string;
  } | null>(null);

  // Role options: the three built-ins plus any custom role already present on a
  // user row (forward-compatible if a deployment adds more).
  const roleOptions = useMemo(() => {
    const set = new Set<string>(["pending", "user", "admin"]);
    for (const u of users ?? []) set.add(u.role);
    return [...set];
  }, [users]);

  const active = q !== "" || role !== ALL;
  function reset() {
    void navigate({ search: {}, replace: true });
  }

  // M5: setRole can be REFUSED server-side (e.g. "cannot demote the last
  // admin"). Without surfacing, the controlled <Select> just snaps back on the
  // next reactive tick with no explanation. Wrap it and toast the server error.
  async function changeRole(args: Parameters<typeof setRole>[0]) {
    try {
      await setRole(args);
    } catch (err) {
      toast.error(m.settings_role_change_refused(), err);
    }
  }

  async function changePerms(args: Parameters<typeof setPerms>[0]) {
    try {
      await setPerms(args);
    } catch (err) {
      // Server rejects any non-grantable permission (whitelist) — surface it.
      toast.error(m.settings_perms_update_refused(), err);
    }
  }

  // Hard-delete a user (profile + all owned data). Irreversible, so it goes
  // behind the type-to-confirm guard; the server re-checks the same invariants
  // (never yourself, never the last admin) and surfaces a refusal as a toast.
  async function onDeleteUser(u: NonNullable<typeof users>[number]) {
    const label = u.email || u.name || u.canonical || u.userId.slice(0, 8);
    const ok = await confirm({
      title: m.settings_delete_user_title(),
      description: m.settings_delete_user_desc({ user: label }),
      confirmWord: m.settings_delete_user_confirm_word(),
      confirmLabel: m.settings_delete_user_action(),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteUser({ profileId: u._id });
      toast.success(m.settings_delete_user_done({ user: label }));
    } catch (err) {
      toast.error(m.settings_delete_user_refused(), err);
    }
  }

  // Admin sets a user's display name (the same user-owned field a user edits in
  // their own preferences). Available on every row, including the admin's own.
  async function onRenameUser(u: NonNullable<typeof users>[number]) {
    const label = u.email || u.name || u.userId.slice(0, 8);
    const next = await prompt({
      title: m.settings_rename_user_title(),
      label: m.settings_rename_user_label({ user: label }),
      placeholder: m.settings_rename_user_placeholder(),
      defaultValue: u.name ?? "",
      confirmLabel: m.settings_save(),
    });
    if (next === null) return;
    try {
      await setUserName({ profileId: u._id, name: next });
      toast.success(m.settings_rename_user_done());
    } catch (err) {
      toast.error(m.settings_rename_user_refused(), err);
    }
  }

  return (
    <>
    <FilterBar
      q={q}
      onQChange={setQ}
      searchPlaceholder={m.settings_users_search_placeholder()}
      onReset={reset}
      canReset={active}
    >
      <Select value={role} onValueChange={setRoleFilter}>
        <SelectTrigger size="sm" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{m.settings_all_roles()}</SelectItem>
          {roleOptions.map((r) => (
            <SelectItem key={r} value={r}>
              {r}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterBar>
    <DataTableShell
      title={m.settings_users_title()}
      rows={users}
      emptyHint={m.settings_users_empty()}
      rowActions={(u) => {
        // Rename is allowed on EVERY row (incl. the admin's own — harmless).
        const actions: {
          label: string;
          onSelect: () => void;
          variant?: "default" | "destructive";
        }[] = [
          {
            label: m.settings_rename_user(),
            onSelect: () => void onRenameUser(u),
          },
        ];
        // Impersonation + delete are hidden on the admin's own row (the server
        // also rejects self-impersonation and self-delete).
        if (u.userId !== me?.userId) {
          actions.push(
            {
              label: m.settings_view_as_user(),
              onSelect: () => void startImpersonation({ profileId: u._id }),
            },
            {
              label: m.settings_delete_user(),
              variant: "destructive" as const,
              onSelect: () => void onDeleteUser(u),
            },
          );
        }
        return actions;
      }}
      columns={[
        {
          header: m.settings_col_user(),
          // Email is the stable identifier (what we key/dedupe on), so it leads.
          // The persisted display name (from primo-auth, often hidden behind the
          // email by the old `||` coalesce) rides underneath as a muted subline
          // when present and distinct — never an empty line for name-less rows.
          cell: (u) => {
            const primary =
              u.email || u.name || u.canonical || u.userId.slice(0, 8);
            const subline =
              u.email && u.name && u.name !== u.email ? u.name : null;
            return (
              <div className="flex flex-col">
                <span>{primary}</span>
                {subline ? (
                  <span className="text-muted-foreground text-xs">
                    {subline}
                  </span>
                ) : null}
              </div>
            );
          },
          sort: (u) => u.email || u.name || u.canonical || u.userId,
        },
        {
          header: m.settings_col_role(),
          // rank: pending (0) < user (1) < admin (2)
          sort: (u) => (u.role === "admin" ? 2 : u.role === "user" ? 1 : 0),
          cell: (u) => (
            <Select
              value={u.role}
              onValueChange={(v) =>
                void changeRole({
                  profileId: u._id,
                  role: v as "pending" | "user" | "admin",
                })
              }
            >
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">pending</SelectItem>
                <SelectItem value="user">user</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          ),
        },
        {
          header: m.settings_col_settings_access(),
          // admins hold all access (rank high), else by count of granted tabs.
          sort: (u) =>
            u.role === "admin" ? 9999 : (u.extraPermissions?.length ?? 0),
          cell: (u) =>
            u.role === "admin" ? (
              <span className="text-muted-foreground text-xs">{m.settings_all_admin()}</span>
            ) : (
              <SettingsAccessCell
                granted={u.extraPermissions ?? []}
                onToggle={(perm) => {
                  const cur = new Set(u.extraPermissions ?? []);
                  if (cur.has(perm)) cur.delete(perm);
                  else cur.add(perm);
                  void changePerms({ profileId: u._id, permissions: [...cur] });
                }}
              />
            ),
        },
        {
          // Agents are assignable to EVERY user, admins included: an admin is
          // also a chat user and needs >=1 agent to start a conversation (there
          // is NO server-side "admin uses all agents" bypass — Codex P2).
          header: m.settings_col_agents(),
          cell: (u) => (
            <Button
              variant="outline"
              size="sm"
              className="h-8 font-normal"
              onClick={() =>
                setAccessFor({
                  profileId: u._id,
                  label:
                    u.email || u.name || u.canonical || u.userId.slice(0, 8),
                })
              }
            >
              {m.settings_manage_agents()}
            </Button>
          ),
        },
      ]}
    />
    <UserAccessSheet
      profileId={accessFor?.profileId ?? null}
      userLabel={accessFor?.label ?? ""}
      open={accessFor !== null}
      onOpenChange={(o) => {
        if (!o) setAccessFor(null);
      }}
    />
    </>
  );
}


type InstanceKind = "openclaw" | "hermes";
type InstanceForm = {
  name: string;
  gatewayUrl: string;
  bridgeUrl: string;
  displayName: string;
  kind: InstanceKind;
  gatewayVersion: string;
  gatewayHttpUrl: string;
};
const EMPTY_INSTANCE: InstanceForm = {
  name: "",
  gatewayUrl: "",
  bridgeUrl: "",
  displayName: "",
  kind: "openclaw",
  gatewayVersion: "",
  gatewayHttpUrl: "",
};

// Which encrypted credential fields apply per provider kind (UI guidance; the
// backend does not enforce kind/field matching). OpenClaw authenticates with an
// operator token + an Ed25519 device identity; Hermes with a single API key.
const SECRET_FIELDS_BY_KIND: Record<
  InstanceKind,
  Array<"token" | "deviceIdentity" | "apiKey">
> = {
  openclaw: ["token", "deviceIdentity"],
  hermes: ["apiKey"],
};

/** Seed the form from an existing instance row (for the edit flow). */
function formFromInstance(i: Instance): InstanceForm {
  return {
    name: i.name,
    gatewayUrl: i.gatewayUrl,
    bridgeUrl: i.bridgeUrl ?? "",
    displayName: i.displayName ?? "",
    kind: (i.kind ?? "openclaw") as InstanceKind,
    gatewayVersion: i.gatewayVersion ?? "",
    gatewayHttpUrl: i.gatewayHttpUrl ?? "",
  };
}

export function InstancesTab() {
  const instances = useQuery(api.admin.listInstances, {});
  // All discovered agents grouped by instance name — drives the "Agents" column
  // so the associated agents are visible at a glance (one read for the table).
  const agentsByInstance = useQuery(api.agents.listAllInstanceAgents, {});
  const upsert = useMutation(api.admin.upsertInstance);
  const del = useMutation(api.admin.deleteInstance);
  const toast = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<InstanceForm>(EMPTY_INSTANCE);
  // The instance whose discovered-agents dialog is open.
  const [agentsFor, setAgentsFor] = useState<string | null>(null);
  // The instance whose bridge-config modal is open (the SAME modal the Bridge tab
  // opens from a compat-row kebab — one config UI, reached from two places).
  const [configInstance, setConfigInstance] = useState<Instance | null>(null);
  // The instance whose encrypted-credentials modal is open.
  const [secretsInstance, setSecretsInstance] = useState<Instance | null>(null);
  // The instance being EDITED in the sheet (null → the sheet creates a new one).
  const [editId, setEditId] = useState<Id<"instances"> | null>(null);

  async function submit() {
    try {
      await upsert({
        instanceId: editId ?? undefined,
        name: form.name,
        gatewayUrl: form.gatewayUrl,
        bridgeUrl: form.bridgeUrl || undefined,
        displayName: form.displayName || undefined,
        kind: form.kind,
        gatewayVersion: form.gatewayVersion || undefined,
        gatewayHttpUrl: form.gatewayHttpUrl || undefined,
      });
      setForm(EMPTY_INSTANCE);
      setEditId(null);
      setSheetOpen(false);
    } catch (err) {
      // M5: surface server-side rejection instead of swallowing.
      toast.error(m.settings_instance_save_failed(), err);
    }
  }

  return (
    <>
      <p className="oc-admin__hint">
        {m.settings_instances_hint_before()}<strong>{m.settings_instances_hint_strong()}</strong>{m.settings_instances_hint_after()}
      </p>
      <DataTableShell
        title={m.settings_instances_title()}
        rows={instances}
        addLabel={m.settings_add_instance()}
        onAdd={() => {
          setEditId(null);
          setForm(EMPTY_INSTANCE);
          setSheetOpen(true);
        }}
        emptyHint={m.settings_instances_empty()}
        columns={[
          { header: m.settings_col_name(), cell: (i) => i.name, sort: (i) => i.name },
          {
            header: m.settings_col_bridge(),
            cell: (i) => (
              <Badge variant="outline">{i.kind ?? "openclaw"}</Badge>
            ),
            sort: (i) => i.kind ?? "openclaw",
          },
          {
            header: m.settings_col_gateway_url(),
            cell: (i) => i.gatewayUrl,
            sort: (i) => i.gatewayUrl,
          },
          {
            header: m.settings_col_display(),
            cell: (i) => i.displayName ?? "—",
            sort: (i) => i.displayName ?? null,
          },
          {
            header: m.settings_col_agents(),
            cell: (i) => {
              // Show ONLY the agents SELECTED (enabled) for this instance — the
              // curated set. Disabled/absent agents are managed in the agents
              // dialog, not surfaced in this column.
              const list = (agentsByInstance?.[i.name] ?? []).filter(
                (a) => a.presentInLastOk !== false && a.enabled,
              );
              if (list.length === 0) {
                return <span className="text-muted-foreground">—</span>;
              }
              // Admin default first + filled badge. So a single read of the row
              // shows the enabled agents + which is default.
              const isDefault = (agentId: string) => i.defaultAgentId === agentId;
              const ordered = [...list].sort(
                (a, b) =>
                  Number(isDefault(b.agentId)) - Number(isDefault(a.agentId)),
              );
              return (
                <div className="flex flex-wrap gap-1">
                  {ordered.map((a) => (
                    <Badge
                      key={a.agentId}
                      variant={isDefault(a.agentId) ? "default" : "outline"}
                      title={
                        isDefault(a.agentId)
                          ? m.settings_badge_default()
                          : undefined
                      }
                    >
                      {a.emoji ? `${a.emoji} ` : ""}
                      {a.displayName ?? a.agentId}
                    </Badge>
                  ))}
                </div>
              );
            },
          },
        ]}
        rowActions={(i) => [
          {
            label: m.settings_edit(),
            onSelect: () => {
              setEditId(i._id);
              setForm(formFromInstance(i));
              setSheetOpen(true);
            },
          },
          {
            label: m.settings_manage_agents(),
            onSelect: () => setAgentsFor(i.name),
          },
          {
            label: m.settings_credentials(),
            onSelect: () => setSecretsInstance(i),
          },
          {
            label: m.settings_configure_bridge(),
            onSelect: () => setConfigInstance(i),
          },
          {
            label: m.settings_delete(),
            variant: "destructive",
            onSelect: () => void del({ instanceId: i._id }),
          },
        ]}
        bulkActions={[
          {
            label: m.settings_delete(),
            variant: "destructive",
            onSelect: (ids) =>
              ids.forEach((id) => void del({ instanceId: id as never })),
          },
        ]}
      />
      <EntitySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={
          editId
            ? m.settings_edit_instance_title()
            : m.settings_new_instance_title()
        }
        description={m.settings_new_instance_desc()}
        canSubmit={Boolean(form.name && form.gatewayUrl)}
        onSubmit={submit}
        submitLabel={m.settings_save()}
      >
        <div className="oc-form">
          <Field label={m.settings_field_instance_name()}>
            <Input
              value={form.name}
              // The name is the routing key (agents/userAgents reference it by
              // value); renaming would orphan them, so it is fixed after create.
              disabled={editId !== null}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            {editId ? (
              <span className="text-xs text-muted-foreground">
                {m.settings_name_locked_hint()}
              </span>
            ) : null}
          </Field>
          <Field label={m.settings_field_technology()}>
            <Select
              value={form.kind}
              onValueChange={(v) =>
                setForm({ ...form, kind: v as InstanceKind })
              }
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openclaw">OpenClaw</SelectItem>
                <SelectItem value="hermes">Hermes</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={m.settings_field_gateway_url()}>
            <Input
              value={form.gatewayUrl}
              onChange={(e) => setForm({ ...form, gatewayUrl: e.target.value })}
            />
          </Field>
          <Field label={m.settings_field_bridge_url()}>
            <Input
              value={form.bridgeUrl}
              placeholder={m.settings_field_bridge_url_ph()}
              onChange={(e) => setForm({ ...form, bridgeUrl: e.target.value })}
            />
          </Field>
          <Field label={m.settings_field_display_name()}>
            <Input
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </Field>
          <Field label={m.settings_field_gateway_version()}>
            <Input
              value={form.gatewayVersion}
              placeholder={m.settings_field_gateway_version_ph()}
              onChange={(e) =>
                setForm({ ...form, gatewayVersion: e.target.value })
              }
            />
          </Field>
          <Field label={m.settings_field_gateway_http_url()}>
            <Input
              value={form.gatewayHttpUrl}
              placeholder={m.settings_field_gateway_http_url_ph()}
              onChange={(e) =>
                setForm({ ...form, gatewayHttpUrl: e.target.value })
              }
            />
          </Field>
        </div>
      </EntitySheet>
      <InstanceAgentsDialog
        instanceName={agentsFor}
        open={agentsFor !== null}
        onOpenChange={(o) => {
          if (!o) setAgentsFor(null);
        }}
      />
      {/* Keyed by instance id so the config form seeds fresh per instance. */}
      {configInstance ? (
        <InstanceConfigDialog
          key={configInstance._id}
          instance={configInstance}
          onClose={() => setConfigInstance(null)}
        />
      ) : null}
      {secretsInstance ? (
        <InstanceSecretsDialog
          key={secretsInstance._id}
          instance={secretsInstance}
          onClose={() => setSecretsInstance(null)}
        />
      ) : null}
    </>
  );
}

// Per-instance ENCRYPTED CREDENTIALS editor (admin-only). Secrets are write-only:
// the value is sent to the setInstanceSecret ACTION (which encrypts it AAD-bound
// and persists the envelope), and is NEVER read back to the browser — the dialog
// only knows WHICH fields are set (listInstanceSecretStatus). Mirrors a password
// field: status + "Set/Replace" + "Clear". Requires ATRIUM_SECRET_KEY on the
// Convex deployment (a clear error surfaces via the toast if unset).
function InstanceSecretsDialog({
  instance,
  onClose,
}: {
  instance: Instance;
  onClose: () => void;
}) {
  const status = useQuery(api.instanceSecrets.listInstanceSecretStatus, {});
  const kind = (instance.kind ?? "openclaw") as InstanceKind;
  const fields = SECRET_FIELDS_BY_KIND[kind];
  // field -> updatedAt for THIS instance (presence only; never the ciphertext).
  const setAt = useMemo(() => {
    const map: Partial<Record<string, number>> = {};
    for (const s of status ?? []) {
      if (s.instanceId === instance._id) map[s.field] = s.updatedAt;
    }
    return map;
  }, [status, instance._id]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            {m.settings_credentials_title({
              instance: instance.displayName ?? instance.name,
            })}
          </DialogTitle>
          <DialogDescription>{m.settings_credentials_hint()}</DialogDescription>
        </DialogHeader>
        <div className="oc-form">
          {fields.map((f) => (
            <SecretRow
              key={f}
              instanceId={instance._id}
              field={f}
              updatedAt={setAt[f] ?? null}
            />
          ))}
        </div>
        {/* Per-bridge auth secret (bridge -> Convex). Separate from the gateway
            credentials above: it identifies THIS bridge as this instance so it can
            (in 3b) fetch ONLY this gateway's secrets. Kind-agnostic. */}
        <div className="oc-bridgesecret">
          <BridgeSecretRow instance={instance} />
        </div>
        <InstanceSyncButton instance={instance} />
      </DialogContent>
    </Dialog>
  );
}

// "Sync now" for one instance: pokes the bridge to take just-saved credentials into
// account immediately (resolve + connect -> pairing) and pulls the gateway's agents into
// Convex at once — so an admin finishes setup right after approving the pairing instead
// of waiting for the discovery cron (~2 min). Mirrors the credentials are set already.
function InstanceSyncButton({ instance }: { instance: Instance }) {
  const forceSync = useAction(api.instanceSync.forceInstanceSync);
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);

  async function doSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await forceSync({ instanceId: instance._id });
      // Honest 3-state feedback (the action does NOT throw on a non-success): only claim
      // "Synced" when agents were actually applied; "no_agents" = the bridge answered but
      // nothing came back (pair the device OR check the instance config); "unreachable" =
      // no serving bridge.
      if (res.status === "synced") toast.success(m.settings_sync_done());
      else if (res.status === "no_agents")
        toast.success(m.settings_sync_no_agents());
      else toast.error(m.settings_sync_failed());
    } catch (err) {
      toast.error(m.settings_sync_failed(), err);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="oc-form">
      <p className="oc-admin__hint">{m.settings_sync_hint()}</p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void doSync()}
          disabled={syncing}
        >
          {syncing ? m.settings_sync_running() : m.settings_sync_now()}
        </Button>
      </div>
    </div>
  );
}

// Per-bridge secret management for one instance: status (configured + prefix…last4)
// + Generate / Rotate / Revoke. Mint returns the plaintext ONCE — revealed inline
// (no nested modal) with a copy + a clear "shown once" warning, then discarded from
// state. Only the hash is ever stored server-side.
function BridgeSecretRow({ instance }: { instance: Instance }) {
  const status = useQuery(api.bridgeAuth.listBridgeAuthStatus, {});
  const mint = useAction(api.bridgeAuth.mintBridgeSecret);
  const revoke = useMutation(api.bridgeAuth.revokeBridgeSecret);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const row = (status ?? []).find((s) => s.instanceId === instance._id);
  const isSet = row !== undefined;

  async function doMint() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await mint({ instanceId: instance._id });
      setMinted(res.plaintext);
      setCopied(false);
    } catch (err) {
      toast.error(m.settings_bridge_secret_mint_failed(), err);
    } finally {
      setBusy(false);
    }
  }
  async function doRevoke() {
    if (busy) return;
    setBusy(true);
    try {
      await revoke({ instanceId: instance._id });
      setMinted(null);
      toast.success(m.settings_bridge_secret_revoked());
    } catch (err) {
      toast.error(m.settings_bridge_secret_mint_failed(), err);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted);
      setCopied(true);
    } catch {
      // best-effort; the value stays visible to copy manually
    }
  }

  return (
    <Field label={m.settings_bridge_secret_label()}>
      <p className="oc-admin__hint">{m.settings_bridge_secret_hint()}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={isSet ? "outline" : "secondary"}>
          {isSet
            ? `${m.settings_secret_configured()} · ${row!.prefix}…${row!.lastFour}`
            : m.settings_secret_unset()}
        </Badge>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void doMint()} disabled={busy}>
            {isSet
              ? m.settings_bridge_secret_rotate()
              : m.settings_bridge_secret_generate()}
          </Button>
          {isSet ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void doRevoke()}
              disabled={busy}
            >
              {m.settings_bridge_secret_revoke()}
            </Button>
          ) : null}
        </div>
      </div>
      {minted ? (
        <div className="oc-bridgesecret__reveal">
          <p className="oc-sa__minted-warning">
            {m.settings_bridge_secret_reveal_warn()}
          </p>
          <div className="oc-sa__minted-box">
            <code className="oc-sa__minted-plain">{minted}</code>
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? m.serviceaccounts_copied() : m.serviceaccounts_copy()}
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMinted(null);
              setCopied(false);
            }}
          >
            {m.settings_bridge_secret_reveal_done()}
          </Button>
        </div>
      ) : null}
    </Field>
  );
}

// One credential row: a write-only input + Set + (if set) Clear, plus a status
// badge. The plaintext only ever travels to the action; it is cleared from local
// state right after a successful set and is never displayed.
function SecretRow({
  instanceId,
  field,
  updatedAt,
}: {
  instanceId: Id<"instances">;
  field: "token" | "deviceIdentity" | "apiKey";
  updatedAt: number | null;
}) {
  const setSecret = useAction(api.instanceSecrets.setInstanceSecret);
  const clear = useMutation(api.instanceSecrets.clearInstanceSecret);
  const generateDevice = useAction(api.deviceIdentity.generateDeviceIdentity);
  const toast = useToast();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  // Non-secret pairing info revealed after a server-side generate (id + publicKey). The
  // private key is minted + stored encrypted server-side and NEVER returned to the browser.
  const [generated, setGenerated] = useState<{
    id: string;
    publicKey: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const isSet = updatedAt !== null;
  const canGenerate = field === "deviceIdentity";
  const label =
    field === "token"
      ? m.settings_secret_token()
      : field === "deviceIdentity"
        ? m.settings_secret_device()
        : m.settings_secret_apikey();

  async function save() {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await setSecret({ instanceId, field, plaintext: value });
      setValue(""); // never keep the plaintext around
      // A manual replace supersedes any just-generated identity: drop its stale pairing
      // command so the admin never approves a device that is no longer stored.
      setGenerated(null);
      setCopied(false);
      toast.success(m.settings_secret_saved());
    } catch (err) {
      toast.error(m.settings_secret_save_failed(), err);
    } finally {
      setBusy(false);
    }
  }

  async function doClear() {
    if (busy) return;
    setBusy(true);
    try {
      await clear({ instanceId, field });
      // The stored identity is gone -> a previously shown pairing command is now stale.
      setGenerated(null);
      setCopied(false);
      toast.success(m.settings_secret_cleared());
    } catch (err) {
      toast.error(m.settings_secret_save_failed(), err);
    } finally {
      setBusy(false);
    }
  }

  async function doGenerate() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await generateDevice({ instanceId });
      setGenerated(res); // only id + publicKey come back (private key stays server-side)
      setCopied(false);
      toast.success(m.settings_secret_generated_title());
    } catch (err) {
      toast.error(m.settings_secret_generate_failed(), err);
    } finally {
      setBusy(false);
    }
  }

  // The pairing command for the freshly-generated device (the id is non-secret).
  const pairCmd = generated ? `openclaw devices approve ${generated.id}` : "";
  async function copyPair() {
    if (!pairCmd) return;
    try {
      await navigator.clipboard.writeText(pairCmd);
      setCopied(true);
    } catch {
      // best-effort; the command stays visible to copy manually
    }
  }

  return (
    <Field label={label}>
      {canGenerate ? (
        <p className="oc-admin__hint">{m.settings_secret_generate_hint()}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={isSet ? "outline" : "secondary"}>
          {isSet ? m.settings_secret_configured() : m.settings_secret_unset()}
        </Badge>
        <Input
          type="password"
          autoComplete="off"
          className="flex-1 min-w-32"
          value={value}
          placeholder={
            isSet
              ? m.settings_secret_replace_ph()
              : m.settings_secret_enter_ph()
          }
          onChange={(e) => setValue(e.target.value)}
        />
        {/* Keep the action buttons together: as ONE flex item they wrap to the next
            line as a block (mobile) instead of a single button dropping alone. */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={busy || value.trim().length === 0}
          >
            {m.settings_secret_set()}
          </Button>
          {canGenerate ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void doGenerate()}
              disabled={busy}
            >
              {m.settings_secret_generate()}
            </Button>
          ) : null}
          {isSet ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void doClear()}
              disabled={busy}
            >
              {m.settings_secret_clear()}
            </Button>
          ) : null}
        </div>
      </div>
      {generated ? (
        <div className="oc-bridgesecret__reveal">
          <p className="text-sm font-medium">
            {m.settings_secret_generated_title()}
          </p>
          <p className="oc-admin__hint">{m.settings_secret_pair_hint()}</p>
          <div className="oc-sa__minted-box">
            <code className="oc-sa__minted-plain">{pairCmd}</code>
            <Button variant="outline" size="sm" onClick={() => void copyPair()}>
              {copied ? m.serviceaccounts_copied() : m.serviceaccounts_copy()}
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setGenerated(null);
              setCopied(false);
            }}
          >
            {m.settings_bridge_secret_reveal_done()}
          </Button>
        </div>
      ) : null}
    </Field>
  );
}

// Read-only view of the agents DISCOVERED on an instance (the bridge is the
// source of truth) + the poll outcome. Manual entry is intentionally absent —
// agents come from `agents.list`, never from a text field (the prod-bug fix).
// Per-instance agent CURATION (admin). Agents are DISCOVERED (read-only list); the
// admin picks which are ENABLED downstream (assignable to groups/users) and which
// is the instance DEFAULT. Phase 1: these writes are stored but not yet enforced
// (Phase 2/3). A disabled agent stays listed (greyed); the default can only be an
// enabled, present agent.
// Internationalised LABELS + DESCRIPTIONS for the code-defined agent-type catalogue
// (the CODES come from convex/lib/agentTypes — the single source; only the per-locale
// strings live here, keyed by the stable code). A code with no mapping falls back to
// the code / empty description.
const AGENT_TYPE_LABEL: Record<string, () => string> = {
  conversational: m.agent_type_conversational,
  documentary: m.agent_type_documentary,
};
const AGENT_TYPE_DESC: Record<string, () => string> = {
  conversational: m.agent_type_conversational_desc,
  documentary: m.agent_type_documentary_desc,
};
const agentTypeLabel = (code: string): string =>
  (AGENT_TYPE_LABEL[code] ?? (() => code))();
const agentTypeDesc = (code: string): string =>
  (AGENT_TYPE_DESC[code] ?? (() => ""))();

// Per-agent TYPE editor. SCALES to many types: the agent row shows only the SELECTED
// types as chips + a "Manage" trigger; the full catalogue (with a DESCRIPTION per
// type, so an admin understands each one) lives in a scrollable Popover where types
// are toggled as MULTI-select checkboxes (the popover stays open across toggles).
function AgentTypesEditor({
  agentId,
  types,
  onToggle,
}: {
  agentId: string;
  types: string[];
  onToggle: (code: string) => void;
}) {
  return (
    <div className="oc-agentcard__types">
      <span className="oc-agentcard__types-label">
        {m.settings_agent_types_label()}
      </span>
      {types.map((code) => (
        <Badge
          key={code}
          variant="secondary"
          className="oc-agenttype__chip"
          title={agentTypeDesc(code)}
        >
          {agentTypeLabel(code)}
        </Badge>
      ))}
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-7">
            {m.settings_agent_types_manage()}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="oc-agenttypes-pop">
          <p className="oc-agenttypes-pop__title">
            {m.settings_agent_types_pop_title()}
          </p>
          <p className="oc-agenttypes-pop__hint">
            {m.settings_agent_types_pop_hint()}
          </p>
          <div className="oc-agenttypes-pop__list">
            {AGENT_TYPE_CODES.map((code) => {
              const id = `agtype-${agentId}-${code}`;
              return (
                <div key={code} className="oc-agenttypes-pop__item">
                  <Checkbox
                    id={id}
                    checked={types.includes(code)}
                    onCheckedChange={() => onToggle(code)}
                  />
                  <label htmlFor={id} className="oc-agenttypes-pop__text">
                    <span className="oc-agenttypes-pop__name">
                      {agentTypeLabel(code)}
                    </span>
                    <span className="oc-agenttypes-pop__desc">
                      {agentTypeDesc(code)}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function InstanceAgentsDialog({
  instanceName,
  open,
  onOpenChange,
}: {
  instanceName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const data = useQuery(
    api.agents.listAgentsForInstance,
    open && instanceName ? { instanceName } : "skip",
  );
  const setEnabled = useMutation(api.agents.setAgentEnabled);
  const setDefault = useMutation(api.agents.setInstanceDefaultAgent);
  const setTypes = useMutation(api.agents.setAgentTypes);
  const removeAgent = useMutation(api.agents.removeInstanceAgent);
  const confirm = useConfirm();
  const toast = useToast();

  async function toggle(agentId: string, enabled: boolean) {
    if (!instanceName) return;
    try {
      await setEnabled({ instanceName, agentId, enabled });
    } catch (err) {
      toast.error(m.settings_manage_agents_failed(), err);
    }
  }
  async function makeDefault(agentId: string) {
    if (!instanceName) return;
    try {
      await setDefault({ instanceName, agentId });
    } catch (err) {
      toast.error(m.settings_manage_agents_failed(), err);
    }
  }
  // Toggle one TYPE on/off for an agent (MULTI-select — types are NOT exclusive; an
  // agent may hold several). Sends the full new set. Clearing every type is allowed:
  // the server reads an empty set back as the default (conversational), so an agent
  // always has at least one EFFECTIVE type.
  async function toggleType(
    agentId: string,
    code: string,
    current: readonly string[],
  ) {
    if (!instanceName) return;
    const next = current.includes(code)
      ? current.filter((c) => c !== code)
      : [...current, code];
    try {
      await setTypes({ instanceName, agentId, types: next });
    } catch (err) {
      toast.error(m.settings_manage_agents_failed(), err);
    }
  }
  // Permanently purge a gateway-absent agent — DESTRUCTIVE (cascades to group/user
  // selections), so confirm first (the usual deletion-validation gate).
  async function remove(agentId: string, label: string) {
    if (!instanceName) return;
    const ok = await confirm({
      title: m.settings_remove_agent_title({ name: label }),
      description: m.settings_remove_agent_desc(),
      confirmLabel: m.settings_remove_agent_action(),
      destructive: true,
    });
    if (!ok) return;
    try {
      await removeAgent({ instanceName, agentId });
      toast.success(m.settings_remove_agent_done());
    } catch (err) {
      toast.error(m.settings_manage_agents_failed(), err);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="oc-access">
        <DialogHeader>
          <DialogTitle>{m.settings_manage_agents_title({ name: instanceName ?? "" })}</DialogTitle>
          <DialogDescription>{m.settings_manage_agents_hint()}</DialogDescription>
        </DialogHeader>
        {data === undefined ? (
          <p className="oc-access__hint">{m.settings_loading()}</p>
        ) : (
          <>
            <div className="oc-access__poll">
              {data.discovery === null
                ? m.settings_never_polled()
                : data.discovery.lastPollOk
                  ? m.settings_discovery_ok()
                  : m.settings_discovery_offline({ error: data.discovery.error ?? "?" })}
            </div>
            {data.agents.length === 0 ? (
              <p className="oc-access__hint">{m.settings_no_agents_discovered()}</p>
            ) : (
              <div className="oc-access__list">
                {data.agents.map((a) => {
                  const absent = a.presentInLastOk === false;
                  const isDefault = data.defaultAgentId === a.agentId;
                  const label = a.displayName ?? a.agentId;
                  const types = a.types ?? [];
                  return (
                    <div
                      key={a.agentId}
                      className={
                        "oc-agentcard" + (a.enabled ? "" : " oc-agentcard--off")
                      }
                    >
                      <div className="oc-agentcard__head">
                        <Checkbox
                          checked={a.enabled}
                          disabled={absent}
                          aria-label={label}
                          onCheckedChange={(v) =>
                            void toggle(a.agentId, v === true)
                          }
                        />
                        <span className="oc-agentcard__name" title={label}>
                          {a.emoji ? `${a.emoji} ` : ""}
                          {label}
                        </span>
                        {a.model ? (
                          <span className="oc-access__model">{a.model}</span>
                        ) : null}
                        {absent ? (
                          <>
                            <Badge variant="outline" className="oc-access__gone">
                              {m.settings_badge_removed()}
                            </Badge>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-destructive"
                              onClick={() => void remove(a.agentId, label)}
                            >
                              {m.settings_remove_agent()}
                            </Button>
                          </>
                        ) : isDefault ? (
                          <Badge variant="default">
                            {m.settings_badge_default()}
                          </Badge>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7"
                            disabled={!a.enabled}
                            onClick={() => void makeDefault(a.agentId)}
                          >
                            {m.settings_make_default()}
                          </Button>
                        )}
                      </div>
                      {/* TYPE management (enabled agents only): MULTI-select; the row
                          shows selected types, the full catalogue + descriptions live
                          in the editor's popover (scales to many types). */}
                      {a.enabled ? (
                        <AgentTypesEditor
                          agentId={a.agentId}
                          types={types}
                          onToggle={(code) =>
                            void toggleType(a.agentId, code, types)
                          }
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="oc-field">
      <span className="oc-field__label">{label}</span>
      {children}
    </label>
  );
}

// Audit trail of impersonated actions: WHO really acted and AS WHOM. Read-only.
// Message content is never recorded server-side (PHI), so only the action verb
// and the touched resource kind/id are shown.
// Field list for the audit advanced builder (view fields the backend exposes).
const AUDIT_ADV_FIELDS = [
  { value: "action", label: "action" },
  { value: "realLabel", label: "acteur réel" },
  { value: "targetLabel", label: "au nom de" },
  { value: "impersonated", label: "usurpation" },
  { value: "resource", label: "ressource" },
  { value: "resourceId", label: "id ressource" },
];

export function AuditTab() {
  const search = useSearch({ from: "/settings/audit" });
  const navigate = useNavigate({ from: "/settings/audit" });

  const q = search.q ?? "";
  const action = search.action ?? ALL;
  const impersonated = search.impersonated ?? ALL; // "yes" | "no" | ALL
  const resource = search.resource ?? ALL;
  // URL stores time-range TOKENS; resolve to live epoch ms at component level.
  const range = decodeRange(search.from, search.to);
  const advanced = useMemo(() => parseAdv(search.adv), [search.adv]);
  const { from, to } = useResolvedRange(range);

  const setQ = (v: string) =>
    void navigate({ search: (p) => ({ ...p, q: v || undefined }), replace: true });
  const setAction = (v: string) =>
    void navigate({ search: (p) => ({ ...p, action: v === ALL ? undefined : v }) });
  const setImpersonated = (v: string) =>
    void navigate({
      search: (p) => ({ ...p, impersonated: v === ALL ? undefined : (v as "yes" | "no") }),
    });
  const setResource = (v: string) =>
    void navigate({ search: (p) => ({ ...p, resource: v === ALL ? undefined : v }) });
  const setRange = (r: TimeRange) =>
    void navigate({ search: (p) => ({ ...p, ...encodeRange(r) }) });
  // AdvancedFilter emits on EVERY keystroke → replace (no per-keystroke history
  // / subscription spam). It does not emit on mount, so a loaded URL `adv` is
  // not clobbered.
  const setAdvanced = (preds: Predicate[]) =>
    void navigate({ search: (p) => ({ ...p, adv: encodeAdv(preds) }), replace: true });

  const rows = useQuery(api.admin.listAudit, {
    filter: {
      q: q || undefined,
      from,
      to,
      action: action === ALL ? undefined : action,
      resource: resource === ALL ? undefined : resource,
      impersonated: impersonated === ALL ? undefined : impersonated === "yes",
      advanced: advanced.length > 0 ? advanced : undefined,
    },
  });

  // Dynamic option lists derived from the loaded window.
  const actionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) set.add(r.action);
    return [...set].sort();
  }, [rows]);
  const resourceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) if (r.resource) set.add(r.resource);
    return [...set].sort();
  }, [rows]);

  const active =
    q !== "" ||
    action !== ALL ||
    impersonated !== ALL ||
    resource !== ALL ||
    advanced.length > 0 ||
    range.kind !== "relative" ||
    range.from !== DEFAULT_RANGE.from;
  function reset() {
    void navigate({ search: {}, replace: true });
  }

  return (
    <>
      <p className="oc-admin__hint">
        {m.settings_audit_hint()}{" "}
        <span className="oc-filter__window">
          {m.settings_audit_window_hint()}
        </span>
      </p>
      <FilterBar
        q={q}
        onQChange={setQ}
        searchPlaceholder={m.settings_audit_search_placeholder()}
        timeRange={range}
        onTimeRangeChange={setRange}
        onReset={reset}
        canReset={active}
      >
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder={m.settings_action()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.settings_all_actions()}</SelectItem>
            {actionOptions.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={impersonated} onValueChange={setImpersonated}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.settings_impersonation_all()}</SelectItem>
            <SelectItem value="yes">{m.settings_impersonation_yes()}</SelectItem>
            <SelectItem value="no">{m.settings_impersonation_no()}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={resource} onValueChange={setResource}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder={m.settings_resource()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.settings_all_resources()}</SelectItem>
            {resourceOptions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>
      <AdvancedFilter
        fields={AUDIT_ADV_FIELDS}
        seed={advanced}
        onChange={setAdvanced}
      />
      <DataTableShell
        title={m.settings_audit_title()}
        rows={rows}
        emptyHint={m.settings_audit_empty()}
        columns={[
          {
            header: m.settings_col_when(),
            cell: (r) => new Date(r.at).toLocaleString("fr-FR"),
            sort: (r) => r.at,
          },
          { header: m.settings_action(), cell: (r) => r.action, sort: (r) => r.action },
          {
            header: m.settings_col_real_actor(),
            cell: (r) => r.realLabel,
            sort: (r) => r.realLabel,
          },
          {
            header: m.settings_col_on_behalf_of(),
            cell: (r) => r.targetLabel ?? "—",
            sort: (r) => r.targetLabel ?? null,
          },
          {
            header: m.settings_resource(),
            cell: (r) =>
              r.resource
                ? r.resource +
                  (r.resourceId ? ` · ${r.resourceId.slice(0, 8)}` : "")
                : "—",
            sort: (r) => r.resource ?? null,
          },
        ]}
      />
    </>
  );
}
