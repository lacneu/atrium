// Instances admin tab (+ all its dialogs/secret-row/agent-type helpers). Extracted from
// AdminSettings.tsx (the eager barrel) into its own module so the router can lazy-load
// it — by far the largest admin tab; its code + deps were the bulk of the ~217 KB admin
// payload chat users never need before first paint. Extracting it also DE-COUPLES the
// barrel from BridgeTab (it imported InstanceConfigDialog), letting BridgeTab lazy too.
// See router.tsx.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { m } from "@/paraglide/messages.js";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { AGENT_TYPE_CODES, resolveAgentTypes } from "../../../convex/lib/agentTypes";
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
import { DataTableShell } from "./DataTableShell";
import { InstanceConfigDialog, type Instance } from "./BridgeTab";
import { EntitySheet } from "./EntitySheet";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  STREAM_TRANSPORTS,
  DEFAULT_STREAM_TRANSPORT,
  type StreamTransport,
} from "../../../convex/lib/instanceConfig";

type InstanceKind = "openclaw" | "hermes";
type InstanceForm = {
  name: string;
  gatewayUrl: string;
  bridgeUrl: string;
  displayName: string;
  kind: InstanceKind;
  // Hermes transport (ws = JSON-RPC WebSocket, default; rest = OpenAI API server).
  transport: "ws" | "rest";
  gatewayVersion: string;
  gatewayHttpUrl: string;
  // FRONTEND live-stream transport (reactive | sse) — an instance property, NOT bridge config.
  streamTransport: StreamTransport;
};
const EMPTY_INSTANCE: InstanceForm = {
  name: "",
  gatewayUrl: "",
  bridgeUrl: "",
  displayName: "",
  kind: "openclaw",
  transport: "ws",
  gatewayVersion: "",
  gatewayHttpUrl: "",
  streamTransport: DEFAULT_STREAM_TRANSPORT,
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
    transport: (i.transport ?? "ws") as "ws" | "rest",
    gatewayVersion: i.gatewayVersion ?? "",
    gatewayHttpUrl: i.gatewayHttpUrl ?? "",
    streamTransport: i.streamTransport ?? DEFAULT_STREAM_TRANSPORT,
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
        transport: form.kind === "hermes" ? form.transport : undefined,
        gatewayVersion: form.gatewayVersion || undefined,
        gatewayHttpUrl: form.gatewayHttpUrl || undefined,
        streamTransport: form.streamTransport,
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
          {form.kind === "hermes" ? (
            <Field label={m.settings_field_transport()}>
              <Select
                value={form.transport}
                onValueChange={(v) =>
                  setForm({ ...form, transport: v as "ws" | "rest" })
                }
              >
                <SelectTrigger size="sm" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ws">
                    {m.settings_transport_ws()}
                  </SelectItem>
                  <SelectItem value="rest">
                    {m.settings_transport_rest()}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
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
          <Field label={m.instance_transport()}>
            <Select
              value={form.streamTransport}
              onValueChange={(v) =>
                setForm({ ...form, streamTransport: v as StreamTransport })
              }
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STREAM_TRANSPORTS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              {m.instance_transport_hint()}
            </span>
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
      // SPECIFIC, actionable feedback per failure cause (the action does NOT throw on a
      // non-success) — never a bare "sync failed" the admin can't act on.
      switch (res.status) {
        case "synced":
          toast.success(m.settings_sync_done());
          break;
        case "no_agents":
          toast.success(m.settings_sync_no_agents());
          break;
        case "no_bridge_url":
          toast.error(m.settings_sync_err_no_bridge_url());
          break;
        case "deploy_misconfigured":
          toast.error(m.settings_sync_err_deploy());
          break;
        case "unauthorized":
          toast.error(m.settings_sync_err_unauthorized());
          break;
        case "not_served":
          toast.error(m.settings_sync_err_not_served());
          break;
        default: // "unreachable"
          toast.error(m.settings_sync_err_unreachable());
          break;
      }
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
  summarizer: m.agent_type_summarizer,
  curator: m.agent_type_curator,
};
const AGENT_TYPE_DESC: Record<string, () => string> = {
  conversational: m.agent_type_conversational_desc,
  documentary: m.agent_type_documentary_desc,
  summarizer: m.agent_type_summarizer_desc,
  curator: m.agent_type_curator_desc,
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
  // Optimistic updates: a checkbox/type/default toggle reflects INSTANTLY in the
  // open dialog (the user clicks several rapidly) instead of waiting a full
  // mutation + reactive-refetch round-trip. Each patches THIS dialog's own query
  // (listAgentsForInstance, keyed by instanceName) and the server reconciles on
  // return. We project ONLY the directly-toggled field — never the server's
  // ">=1-enabled => 1-default" reassignment (the default badge reconciles a beat
  // later; replicating that invariant client-side would be fragile duplication).
  const setEnabled = useMutation(
    api.agents.setAgentEnabled,
  ).withOptimisticUpdate((store, { instanceName, agentId, enabled }) => {
    const cur = store.getQuery(api.agents.listAgentsForInstance, {
      instanceName,
    });
    if (!cur) return;
    store.setQuery(
      api.agents.listAgentsForInstance,
      { instanceName },
      {
        ...cur,
        agents: cur.agents.map((a) =>
          a.agentId === agentId ? { ...a, enabled } : a,
        ),
      },
    );
  });
  const setDefault = useMutation(
    api.agents.setInstanceDefaultAgent,
  ).withOptimisticUpdate((store, { instanceName, agentId }) => {
    const cur = store.getQuery(api.agents.listAgentsForInstance, {
      instanceName,
    });
    if (!cur) return;
    store.setQuery(
      api.agents.listAgentsForInstance,
      { instanceName },
      { ...cur, defaultAgentId: agentId },
    );
  });
  const setTypes = useMutation(api.agents.setAgentTypes).withOptimisticUpdate(
    (store, { instanceName, agentId, types }) => {
      const cur = store.getQuery(api.agents.listAgentsForInstance, {
        instanceName,
      });
      if (!cur) return;
      // The query returns EFFECTIVE types (resolveAgentTypes: empty -> default),
      // so project the SAME derivation or the type chips flicker on reconcile.
      const effective = resolveAgentTypes(types);
      store.setQuery(
        api.agents.listAgentsForInstance,
        { instanceName },
        {
          ...cur,
          agents: cur.agents.map((a) =>
            a.agentId === agentId ? { ...a, types: effective } : a,
          ),
        },
      );
    },
  );
  const setDescription = useMutation(
    api.agents.setAgentDescription,
  ).withOptimisticUpdate((store, { instanceName, agentId, description }) => {
    const cur = store.getQuery(api.agents.listAgentsForInstance, {
      instanceName,
    });
    if (!cur) return;
    const trimmed = description.trim();
    store.setQuery(
      api.agents.listAgentsForInstance,
      { instanceName },
      {
        ...cur,
        agents: cur.agents.map((a) =>
          a.agentId === agentId
            ? { ...a, description: trimmed.length === 0 ? null : trimmed }
            : a,
        ),
      },
    );
  });
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
                      {/* SPECIALTY blurb (enabled agents only): the 1-2 sentence
                          description users see under the agent in the pickers.
                          Saved on blur. */}
                      {a.enabled ? (
                        <AgentDescriptionEditor
                          value={a.description ?? ""}
                          onSave={async (next) => {
                            if (!instanceName) return;
                            try {
                              await setDescription({
                                instanceName,
                                agentId: a.agentId,
                                description: next,
                              });
                            } catch (err) {
                              toast.error(
                                m.settings_manage_agents_failed(),
                                err,
                              );
                            }
                          }}
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

/** Inline editor for the agent's SPECIALTY blurb (saved on blur, Enter also
 *  commits). Local draft state so typing never fights the reactive query. */
function AgentDescriptionEditor({
  value,
  onSave,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft.trim() !== value.trim()) void onSave(draft);
  };
  return (
    <Input
      className="oc-agentcard__desc"
      value={draft}
      maxLength={280}
      placeholder={m.settings_agent_description_placeholder()}
      aria-label={m.settings_agent_description_aria()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="oc-field">
      <span className="oc-field__label">{label}</span>
      {children}
    </label>
  );
}
