// Users admin tab (+ its SettingsAccessCell helper). Extracted from AdminSettings.tsx
// (the eager barrel) into its own module so the router can lazy-load it — its
// table/dropdown deps are part of the ~217 KB admin code chat users never need before
// first paint. See router.tsx.
import { useMemo, useState } from "react";
import { APP_HOST } from "@/lib/appHost";
import { useMutation, useQuery } from "convex/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { m } from "@/paraglide/messages.js";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { UserAccessSheet } from "./UserAccessSheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Server } from "lucide-react";
import { DataTableShell } from "./DataTableShell";
import { DetailChips } from "./DetailChips";
import { FilterBar } from "./filters/FilterBar";
import { useToast } from "@/components/ui/toast";
import { useConfirm, usePrompt } from "@/components/ConfirmDialog";
// Light shared metadata (tab list + RBAC maps) — stays in the eager AdminSettings barrel.
import { GRANTABLE_TABS, TAB_PERMISSION, TAB_I18N } from "../AdminSettings";

// "Select all" sentinel for the quick <Select>s (radix Select has no empty value),
// mapped back to `undefined` (no filter) when building the query arg.
const ALL = "__all__";

// Localized display label for a role. The stored VALUES stay technical
// ("pending"/"user"/"admin"); a custom role from a deployment shows raw.
function roleLabel(role: string): string {
  switch (role) {
    case "pending":
      return m.role_pending();
    case "user":
      return m.role_user();
    case "admin":
      return m.role_admin();
    default:
      return role;
  }
}

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
              <span>{TAB_I18N[t]()}</span>
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
    // This is the users MANAGEMENT list -> request the per-user Agents column data.
    withAgents: true,
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
              {roleLabel(r)}
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
        // Agent assignment + rename are allowed on EVERY row (incl. the admin's
        // own): an admin is also a chat user and needs >=1 agent to start a
        // conversation (there is NO server-side "admin uses all agents" bypass).
        // The manage-agents action is the primary one (first), mirroring the
        // groups list's "Manage" -- the Agents column itself is a read-only preview.
        const actions: {
          label: string;
          onSelect: () => void;
          variant?: "default" | "destructive";
        }[] = [
          {
            label: m.settings_manage_agents(),
            onSelect: () =>
              setAccessFor({
                profileId: u._id,
                label:
                  u.email || u.name || u.canonical || u.userId.slice(0, 8),
              }),
          },
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
                <SelectItem value="pending">{roleLabel("pending")}</SelectItem>
                <SelectItem value="user">{roleLabel("user")}</SelectItem>
                <SelectItem value="admin">{roleLabel("admin")}</SelectItem>
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
          // The EFFECTIVE agents available to this user (cascade-resolved server
          // side: group pool / all-pool / direct restriction). A read-only chip
          // preview + total, like the groups list's #agents column; assignment
          // moved to the kebab's manage-agents action.
          header: m.settings_col_agents(),
          cell: (u) => (
            <DetailChips
              icon={<Server size={12} aria-hidden />}
              total={u.agentCount ?? 0}
              items={u.agents.map((a) => ({ label: a }))}
            />
          ),
          sort: (u) => u.agentCount ?? 0,
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


