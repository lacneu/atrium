import { useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { EntitySheet } from "./EntitySheet";
import { roleDescription } from "./roleDescriptions";
import { FilterBar } from "./filters/FilterBar";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/ui/toast";
import { formatDate, formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// "Comptes de service" tab — service accounts + their API keys.
//
// D3/D4 reminders this UI honors:
//  - Mint is an ACTION (api.apiKeys.mintApiKey). It returns the plaintext exactly
//    ONCE; we stash it in local state to feed a centered Dialog with a copy
//    button and a "you won't see this again" warning. The reactive listKeys query
//    never carries the plaintext (only prefix/lastFour).
//  - There is no enable/disable mutation for service accounts (only mint/revoke
//    keys), so `disabled` is rendered as a status badge — no toggle action.

type ServiceAccountRow = {
  _id: Id<"serviceAccounts">;
  name: string;
  roleKey: string;
  disabled: boolean;
  description: string | null;
  createdByUserId: Id<"users">;
  createdAt: number;
};

type ApiKeyRow = {
  _id: Id<"apiKeys">;
  serviceAccountId: Id<"serviceAccounts">;
  prefix: string;
  lastFour: string;
  disabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
};

type MintedKey = {
  accountName: string;
  plaintext: string;
  prefix: string;
  lastFour: string;
};

// Expiry presets for the mint trigger. mintApiKey only accepts an optional
// `expiresAt` (no key name field exists on the apiKeys doc), so the pre-mint
// affordance is expiry-only.
const EXPIRY_OPTIONS = [
  { value: "never", label: () => m.serviceaccounts_expiry_never(), days: null },
  { value: "30", label: () => m.serviceaccounts_expiry_30d(), days: 30 },
  { value: "90", label: () => m.serviceaccounts_expiry_90d(), days: 90 },
] as const;
type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]["value"];

const STALE_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days

// "Select all" sentinel for the quick <Select>s (radix has no empty value).
const ALL = "__all__";

type AccountForm = { name: string; roleKey: string; description: string };
const EMPTY_ACCOUNT: AccountForm = { name: "", roleKey: "", description: "" };

export function ServiceAccountsTab() {
  const search = useSearch({ from: "/settings/serviceAccounts" });
  const navigate = useNavigate({ from: "/settings/serviceAccounts" });
  const q = search.q ?? "";
  const statusFilter = search.status ?? ALL;
  // `roleFilter` is NOT in the URL contract (§3.4 table lists only q + status)
  // — kept as a client-only ephemeral. Still passed to the query.
  const [roleFilter, setRoleFilter] = useState<string>(ALL);

  const setQ = (v: string) =>
    void navigate({ search: (p) => ({ ...p, q: v || undefined }), replace: true });
  const setStatusFilter = (v: string) =>
    void navigate({
      search: (p) => ({ ...p, status: v === ALL ? undefined : (v as "active" | "disabled") }),
    });

  const accounts = useQuery(api.apiKeys.listServiceAccounts, {
    filter: {
      q: q || undefined,
      // The service-account role filter key is `role` (-> roleKey server-side).
      role: roleFilter === ALL ? undefined : roleFilter,
      // Status maps to the `disabled` bool (active = false, disabled = true).
      disabled: statusFilter === ALL ? undefined : statusFilter === "disabled",
    },
  }) as ServiceAccountRow[] | undefined;
  const allKeys = useQuery(api.apiKeys.listKeys, {}) as
    | ApiKeyRow[]
    | undefined;
  const roles = useQuery(api.apiKeys.listRoles, {});

  const createServiceAccount = useMutation(api.apiKeys.createServiceAccount);
  const updateServiceAccount = useMutation(api.apiKeys.updateServiceAccount);
  const deleteServiceAccount = useMutation(api.apiKeys.deleteServiceAccount);
  const mintApiKey = useAction(api.apiKeys.mintApiKey);
  const revokeApiKey = useMutation(api.apiKeys.revokeApiKey);
  const confirm = useConfirm();
  const toast = useToast();

  const filtersActive = q !== "" || roleFilter !== ALL || statusFilter !== ALL;
  function resetFilters() {
    setRoleFilter(ALL);
    void navigate({ search: {}, replace: true });
  }

  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<AccountForm>(EMPTY_ACCOUNT);
  // The account being edited (null = create mode). The EntitySheet is shared.
  const [editing, setEditing] = useState<Id<"serviceAccounts"> | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [minting, setMinting] = useState<Id<"serviceAccounts"> | null>(null);
  // L5: synchronous guard against a double-click minting two keys. React state
  // (`minting`) only updates on the next render, so two near-simultaneous clicks
  // can both pass a state check; a ref flips synchronously before the await.
  const mintingRef = useRef(false);
  // L7: keyIds with an in-flight revoke — the per-key revoke button is
  // disabled while its mutation runs (mirrors the mint guard).
  const [revoking, setRevoking] = useState<Set<string>>(new Set());
  const [expiryByAccount, setExpiryByAccount] = useState<
    Record<string, ExpiryValue>
  >({});
  const [minted, setMinted] = useState<MintedKey | null>(null);

  // Group keys under their owning account once (no per-row useQuery — that would
  // be a conditional/looped hook).
  const keysByAccount = useMemo(() => {
    const map = new Map<string, ApiKeyRow[]>();
    for (const k of allKeys ?? []) {
      const list = map.get(k.serviceAccountId) ?? [];
      list.push(k);
      map.set(k.serviceAccountId, list);
    }
    return map;
  }, [allKeys]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function submitAccount() {
    try {
      if (editing) {
        await updateServiceAccount({
          serviceAccountId: editing,
          name: form.name,
          roleKey: form.roleKey,
          description: form.description,
        });
        toast.success(m.serviceaccounts_toast_update_done());
      } else {
        await createServiceAccount({
          name: form.name,
          roleKey: form.roleKey,
          description: form.description || undefined,
        });
      }
      setForm(EMPTY_ACCOUNT);
      setEditing(null);
      setSheetOpen(false);
    } catch (err) {
      // M5: surface duplicate-key / validation rejection instead of swallowing.
      toast.error(
        editing
          ? m.serviceaccounts_toast_update_error()
          : m.serviceaccounts_toast_create_error(),
        err,
      );
    }
  }

  function openEdit(account: ServiceAccountRow) {
    setForm({
      name: account.name,
      roleKey: account.roleKey,
      description: account.description ?? "",
    });
    setEditing(account._id);
    setSheetOpen(true);
  }

  async function mint(account: ServiceAccountRow) {
    // L5: synchronous double-click guard. The ref flips BEFORE the await, so a
    // second click during the in-flight mint is rejected immediately — it can
    // never mint an orphan key whose plaintext is discarded.
    if (mintingRef.current) return;
    mintingRef.current = true;
    const choice = expiryByAccount[account._id] ?? "never";
    const days = EXPIRY_OPTIONS.find((o) => o.value === choice)?.days ?? null;
    const expiresAt = days ? Date.now() + days * 24 * 60 * 60 * 1000 : undefined;
    setMinting(account._id);
    try {
      const res = await mintApiKey({
        serviceAccountId: account._id,
        expiresAt,
      });
      // The ONLY moment the plaintext exists client-side. Stash it in local
      // state (NOT the query) so the show-once Dialog can surface it.
      setMinted({
        accountName: account.name,
        plaintext: res.plaintext,
        prefix: res.prefix,
        lastFour: res.lastFour,
      });
    } catch (err) {
      // M5: surface mint failures (the plaintext is lost on error anyway).
      toast.error(m.serviceaccounts_toast_mint_error(), err);
    } finally {
      mintingRef.current = false;
      setMinting(null);
    }
  }

  async function deleteAccount(account: ServiceAccountRow) {
    // Irreversible cascade (the account + every key it owns). Type-to-confirm
    // on the account name guards against an accidental destructive click.
    const ok = await confirm({
      title: m.serviceaccounts_delete_title(),
      description: (
        <>
          {m.serviceaccounts_delete_desc_before()}{" "}
          <span className="font-mono">{account.name}</span>{" "}
          {m.serviceaccounts_delete_desc_and()}{" "}
          <strong>{m.serviceaccounts_delete_desc_all_keys()}</strong>{" "}
          {m.serviceaccounts_delete_desc_after()}
        </>
      ),
      confirmWord: account.name,
      confirmLabel: m.serviceaccounts_confirm_delete(),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteServiceAccount({ serviceAccountId: account._id });
      toast.success(m.serviceaccounts_toast_delete_success(), account.name);
    } catch (err) {
      toast.error(m.serviceaccounts_toast_delete_error(), err);
    }
  }

  async function revoke(key: ApiKeyRow) {
    const ok = await confirm({
      title: m.serviceaccounts_revoke_title(),
      description: (
        <>
          {m.serviceaccounts_revoke_desc_before()}{" "}
          <span className="font-mono">
            {key.prefix}…{key.lastFour}
          </span>{" "}
          {m.serviceaccounts_revoke_desc_after()}
        </>
      ),
      confirmLabel: m.serviceaccounts_confirm_revoke(),
      destructive: true,
    });
    if (!ok) return;
    // L7: track in-flight revoke so the button is disabled while it runs.
    if (revoking.has(key._id)) return;
    setRevoking((prev) => new Set(prev).add(key._id));
    try {
      await revokeApiKey({ keyId: key._id });
    } catch (err) {
      // M5: surface revoke failures.
      toast.error(m.serviceaccounts_toast_revoke_error(), err);
    } finally {
      setRevoking((prev) => {
        const next = new Set(prev);
        next.delete(key._id);
        return next;
      });
    }
  }

  return (
    <>
      <p className="oc-admin__hint">{m.serviceaccounts_hint()}</p>

      <FilterBar
        q={q}
        onQChange={setQ}
        searchPlaceholder={m.serviceaccounts_search_placeholder()}
        onReset={resetFilters}
        canReset={filtersActive}
      >
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder={m.serviceaccounts_role()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.serviceaccounts_all_roles()}</SelectItem>
            {(roles ?? []).map((r) => (
              <SelectItem key={r._id} value={r.key}>
                {r.key}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.serviceaccounts_all_statuses()}</SelectItem>
            <SelectItem value="active">{m.serviceaccounts_status_active()}</SelectItem>
            <SelectItem value="disabled">{m.serviceaccounts_status_disabled()}</SelectItem>
          </SelectContent>
        </Select>
      </FilterBar>

      <DataTableShell
        title={m.serviceaccounts_title()}
        rows={accounts}
        addLabel={m.serviceaccounts_add()}
        onAdd={() => {
          setForm(EMPTY_ACCOUNT);
          setEditing(null);
          setSheetOpen(true);
        }}
        emptyHint={m.serviceaccounts_empty()}
        isExpanded={(a) => expanded.has(a._id)}
        renderExpanded={(a) => (
          <AccountKeys
            account={a}
            keys={keysByAccount.get(a._id) ?? []}
            onRevoke={revoke}
            revoking={revoking}
          />
        )}
        rowActions={(a) => [
          {
            label: m.serviceaccounts_action_edit(),
            onSelect: () => openEdit(a),
          },
          {
            label: m.serviceaccounts_action_mint(),
            onSelect: () => void mint(a),
          },
          {
            label: expanded.has(a._id)
              ? m.serviceaccounts_action_hide_keys()
              : m.serviceaccounts_action_show_keys(),
            onSelect: () => toggleExpanded(a._id),
          },
          {
            label: m.serviceaccounts_action_delete(),
            variant: "destructive",
            onSelect: () => void deleteAccount(a),
          },
        ]}
        columns={[
          {
            header: "",
            className: "w-8",
            cell: (a) => (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  expanded.has(a._id)
                    ? m.serviceaccounts_collapse()
                    : m.serviceaccounts_expand()
                }
                onClick={() => toggleExpanded(a._id)}
              >
                {expanded.has(a._id) ? <ChevronDown /> : <ChevronRight />}
              </Button>
            ),
          },
          {
            header: m.serviceaccounts_col_name(),
            sort: (a) => a.name,
            cell: (a) => (
              <div className="flex flex-col">
                <span>{a.name}</span>
                {a.description ? (
                  <span className="text-muted-foreground text-xs">
                    {a.description}
                  </span>
                ) : null}
              </div>
            ),
          },
          {
            header: m.serviceaccounts_col_role(),
            sort: (a) => a.roleKey,
            cell: (a) => <Badge variant="secondary">{a.roleKey}</Badge>,
          },
          {
            header: m.serviceaccounts_col_status(),
            sort: (a) => (a.disabled ? 1 : 0),
            cell: (a) =>
              a.disabled ? (
                <Badge variant="destructive">{m.serviceaccounts_status_disabled()}</Badge>
              ) : (
                <Badge variant="outline">{m.serviceaccounts_status_active()}</Badge>
              ),
          },
          {
            header: m.serviceaccounts_col_next_key_expiry(),
            cell: (a) => (
              <Select
                value={expiryByAccount[a._id] ?? "never"}
                onValueChange={(v) =>
                  setExpiryByAccount((prev) => ({
                    ...prev,
                    [a._id]: v as ExpiryValue,
                  }))
                }
              >
                <SelectTrigger size="sm" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ),
          },
          {
            header: m.serviceaccounts_col_keys(),
            sort: (a) => (keysByAccount.get(a._id) ?? []).filter((k) => !k.disabled).length,
            cell: (a) => {
              const keys = keysByAccount.get(a._id) ?? [];
              const active = keys.filter((k) => !k.disabled).length;
              return (
                <span className="oc-sa__keycount">
                  {minting === a._id
                    ? m.serviceaccounts_minting()
                    : m.serviceaccounts_active_count({ count: active })}
                </span>
              );
            },
          },
        ]}
      />

      <EntitySheet
        open={sheetOpen}
        onOpenChange={(o) => {
          setSheetOpen(o);
          if (!o) setEditing(null); // back to create mode when closed
        }}
        title={
          editing
            ? m.serviceaccounts_edit_title()
            : m.serviceaccounts_sheet_title()
        }
        description={
          editing
            ? m.serviceaccounts_edit_description()
            : m.serviceaccounts_sheet_description()
        }
        canSubmit={Boolean(form.name && form.roleKey)}
        onSubmit={submitAccount}
        submitLabel={
          editing ? m.serviceaccounts_edit_submit() : m.serviceaccounts_submit()
        }
      >
        <div className="oc-form">
          <label className="oc-field">
            <span className="oc-field__label">{m.serviceaccounts_field_name()}</span>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="oc-field">
            <span className="oc-field__label">{m.serviceaccounts_field_role()}</span>
            <Select
              value={form.roleKey || undefined}
              onValueChange={(v) => setForm({ ...form, roleKey: v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={m.serviceaccounts_choose_role()} />
              </SelectTrigger>
              <SelectContent>
                {(roles ?? []).map((r) => (
                  <SelectItem key={r._id} value={r.key}>
                    {r.name} ({r.key})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(() => {
              // Show the chosen role's description right under the picker so the
              // observer-vs-agent difference is clear at the moment of choosing.
              const chosen = (roles ?? []).find((r) => r.key === form.roleKey);
              const desc = chosen ? roleDescription(chosen) : null;
              return desc ? (
                <span className="text-muted-foreground text-xs">{desc}</span>
              ) : null;
            })()}
          </label>
          <label className="oc-field">
            <span className="oc-field__label">{m.serviceaccounts_field_description()}</span>
            <Input
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
        </div>
      </EntitySheet>

      <MintedKeyDialog minted={minted} onClose={() => setMinted(null)} />
    </>
  );
}

// Per-account expanded key list. Plain table (not DataTableShell — no bulk
// select needed here, and we want it visually nested under the account).
function AccountKeys({
  account,
  keys,
  onRevoke,
  revoking,
}: {
  account: ServiceAccountRow;
  keys: ApiKeyRow[];
  onRevoke: (key: ApiKeyRow) => void;
  revoking: Set<string>;
}) {
  return (
    <div className="oc-sa__keys">
      <div className="oc-sa__keys-head">
        {m.serviceaccounts_keys_of()}{" "}
        <span className="font-medium">{account.name}</span>
      </div>
      {keys.length === 0 ? (
        <p className="oc-admin__hint">{m.serviceaccounts_keys_empty()}</p>
      ) : (
        <table className="oc-sa__keytable">
          <thead>
            <tr>
              <th>{m.serviceaccounts_keycol_key()}</th>
              <th>{m.serviceaccounts_keycol_role()}</th>
              <th>{m.serviceaccounts_keycol_created()}</th>
              <th>{m.serviceaccounts_keycol_last_used()}</th>
              <th>{m.serviceaccounts_keycol_expiry()}</th>
              <th>{m.serviceaccounts_keycol_status()}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k._id}>
                <td>
                  <code className="oc-sa__keyid">
                    {k.prefix}…{k.lastFour}
                  </code>
                </td>
                <td>
                  <Badge variant="secondary">{account.roleKey}</Badge>
                </td>
                {/* Creation shows date + TIME (Image #15): a key's creation
                    instant is more useful with the time, and mirrors the
                    datetime format used elsewhere (lastUsed, audit). */}
                <td>{formatDateTime(k.createdAt)}</td>
                <td className={isStale(k.lastUsedAt) ? "oc-sa__stale" : ""}>
                  {formatLastUsed(k.lastUsedAt)}
                </td>
                <td>{formatExpiry(k.expiresAt)}</td>
                <td>{statusBadge(k)}</td>
                <td className="text-right">
                  {!k.disabled ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={revoking.has(k._id)}
                      onClick={() => onRevoke(k)}
                    >
                      {revoking.has(k._id)
                        ? m.serviceaccounts_revoking()
                        : m.serviceaccounts_revoke()}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Centered show-once Dialog (D3): plaintext appears here exactly once with a
// copy button + an unmistakable warning. On close, only prefix/lastFour remain
// (in the reactive listKeys query); the plaintext local state is cleared.
function MintedKeyDialog({
  minted,
  onClose,
}: {
  minted: MintedKey | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.plaintext);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); the read-only box still
      // lets the admin select + copy manually.
    }
  }

  return (
    <Dialog
      open={minted !== null}
      onOpenChange={(o) => {
        if (!o) {
          setCopied(false);
          onClose();
        }
      }}
    >
      {minted ? (
        <DialogContent
          className="max-w-lg"
          // Irreversible secret shown exactly once: block accidental dismissal
          // (overlay click / Escape / X). The ONLY close path is the explicit
          // "I copied the key" button — research §"Mint modal" item 5.
          showCloseButton={false}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{m.serviceaccounts_minted_title()}</DialogTitle>
            <DialogDescription>
              {m.serviceaccounts_minted_description({
                name: minted.accountName,
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="oc-sa__minted-warning">
            {m.serviceaccounts_minted_warning()}
          </div>

          <div className="oc-sa__minted-box">
            <code className="oc-sa__minted-plain">{minted.plaintext}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copy()}
              aria-label={m.serviceaccounts_copy_key()}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? m.serviceaccounts_copied() : m.serviceaccounts_copy()}
            </Button>
          </div>

          <DialogFooter>
            <Button
              onClick={() => {
                setCopied(false);
                onClose();
              }}
            >
              {m.serviceaccounts_minted_done()}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function isStale(lastUsedAt: number | null): boolean {
  if (lastUsedAt === null) return false;
  return Date.now() - lastUsedAt > STALE_MS;
}

function formatLastUsed(lastUsedAt: number | null): string {
  if (lastUsedAt === null) return m.serviceaccounts_never();
  return formatDateTime(lastUsedAt);
}

function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "—";
  return formatDate(expiresAt);
}

function statusBadge(k: ApiKeyRow) {
  if (k.disabled)
    return <Badge variant="destructive">{m.serviceaccounts_key_revoked()}</Badge>;
  if (k.expiresAt !== null && k.expiresAt < Date.now())
    return <Badge variant="outline">{m.serviceaccounts_key_expired()}</Badge>;
  return <Badge variant="outline">{m.serviceaccounts_key_active()}</Badge>;
}
