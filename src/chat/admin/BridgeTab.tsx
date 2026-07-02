import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2,
  AlertTriangle,
  WifiOff,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Loader2,
  Server,
} from "lucide-react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { APP_HOST } from "@/lib/appHost";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
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
import { dispatchErrorInfo } from "@/lib/dispatchErrorInfo";
import {
  DEFAULT_INSTANCE_CONFIG,
  MEDIA_MODES,
  INBOUND_MEDIA_MODES,
  type InboundMediaMode,
  type MediaMode,
} from "../../../convex/lib/instanceConfig";
import {
  buildConfigOverride,
  formFromConfig,
  type ConfigForm,
} from "./bridgeConfigForm";
import { FieldLabel } from "./FieldLabel";
import { m } from "@/paraglide/messages.js";
import {
  badgeStateFromVersion,
  hasProvider,
  providerSupport,
  targetBadgeLabel,
  type TargetBadgeState,
  versionLabel,
} from "./compatView";
import { bridgeErrorTargets, isBridgeHealthy } from "./bridgeHealthView";
import { groupBridgeByProvider, providerLabel } from "./bridgeProviderView";
import { ConnectionsTable } from "./ConnectionsTable";

// "Bridge" settings tab. Organized BY PROVIDER (CHAT_UX_DESIGN layer-cake +
// Gestalt common-region): one GLOBAL status card for the bridge process itself
// (reachability + version — there is one bridge), then one self-contained card
// per downstream provider (OpenClaw, later Hermes) bundling that provider's
// connections + compatibility + per-instance config. A provider card appears
// only when that provider is actually present (no dead Hermes UI). This tab shows
// NON-secret status only; the operator token + device identity are managed (encrypted)
// under Settings -> Agents -> Instances -> Credentials, never displayed here.

type Health = NonNullable<ReturnType<typeof useBridgeHealth>>;
function useBridgeHealth() {
  return useQuery(api.bridgeHealth.getBridgeHealth, {});
}
type Compat = NonNullable<FunctionReturnType<typeof api.compat.getBridgeCompat>>;
// Exported so the Instances tab can pass its own listInstances row to the shared
// InstanceConfigDialog (same query → identical type).
export type Instance = NonNullable<
  FunctionReturnType<typeof api.admin.listInstances>
>[number];

export function BridgeTab() {
  const health = useBridgeHealth();
  const compat = useQuery(api.compat.getBridgeCompat, {});
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const isAdmin = me?.role === "admin";
  // Admin-gated query — skip for non-admins (it would throw). Used both for the
  // config editor and to map connections → provider (instance kind).
  const instances = useQuery(api.admin.listInstances, isAdmin ? {} : "skip");
  const navigate = useNavigate();

  const onSeeAnomalies = () =>
    void navigate({ to: "/settings/anomalies", search: { status: "open" } });

  // Group connections + compat verdicts + instances per provider (pure helper).
  const targets = health ? health.targets : [];
  const compatTargets = compat ? compat.targets : [];
  const buckets = groupBridgeByProvider(targets, compatTargets, instances ?? []);
  const manifest = compat?.compat ?? null;
  // Distinguish the THREE compat states so a provider's compat block never shows
  // "legacy bridge" while compat is merely still loading (independent queries —
  // health/instances can resolve before compat on a cold load).
  const compatStatus =
    compat === undefined ? "loading" : compat === null ? "nodata" : "ready";

  // Hermes announced by the manifest but not yet present as a card → a single
  // forward-looking note (preserves the old "adapter coming" affordance).
  const hermesAnnounced =
    manifest !== null &&
    hasProvider(manifest, "hermes") &&
    !buckets.some((b) => b.key === "hermes");

  return (
    <div className="oc-bridge">
      <BridgeStatusCard
        health={health}
        compat={compat}
        onSeeAnomalies={onSeeAnomalies}
      />
      {/* Trust / capability-transparency note (active polling, non-secret only,
          secrets live in the bridge env) — a caption for the whole tab. */}
      <p className="oc-admin__hint oc-bridge__caption">{m.bridge_health_hint()}</p>
      {buckets.map((b) => (
        <ProviderCard
          key={b.key}
          providerKey={b.key}
          connections={b.connections}
          instances={b.instances}
          manifest={manifest}
          compatStatus={compatStatus}
          compatReachable={compat?.reachable ?? true}
        />
      ))}
      {hermesAnnounced ? (
        <p className="oc-admin__hint">{m.compat_hermes_coming()}</p>
      ) : null}
    </div>
  );
}

// ── Global bridge status (the bridge PROCESS: reachable? which version?) ──────
function BridgeStatusCard({
  health,
  compat,
  onSeeAnomalies,
}: {
  health: Health | null | undefined;
  compat: Compat | null | undefined;
  onSeeAnomalies: () => void;
}) {
  // TWO version truths: bridgeVersion = what the RUNNING CODE reads
  // (package.json) and buildVersion/buildRevision = what CI froze into the image
  // env at build. Agreement -> version + short sha. Divergence -> an explicit
  // warning: the container is NOT the build it claims (stale pull / cache).
  const buildMismatch =
    compat != null &&
    compat.buildVersion != null &&
    compat.bridgeVersion != null &&
    compat.buildVersion !== compat.bridgeVersion;
  const shortRev =
    compat?.buildRevision && compat.buildRevision !== "unknown"
      ? compat.buildRevision.slice(0, 7)
      : null;
  const version =
    compat && compat !== null ? (
      <span className="oc-bridge-card__ver">
        <code className="oc-traces__mono">{versionLabel(compat.bridgeVersion)}</code>
        {shortRev ? (
          <>
            {" "}
            <code
              className="oc-traces__mono"
              title={m.compat_build_revision_hint()}
            >
              ({shortRev})
            </code>
          </>
        ) : null}
        {buildMismatch ? (
          <strong className="oc-bridge-card__mismatch">
            {" "}
            {m.compat_build_mismatch({ build: compat.buildVersion ?? "?" })}
          </strong>
        ) : null}
        {" · "}
        {m.compat_protocol_label()}{" "}
        <code className="oc-traces__mono">
          {compat.protocolVersion !== null
            ? String(compat.protocolVersion)
            : m.compat_unknown()}
        </code>
      </span>
    ) : null;

  if (health === undefined) {
    return <p className="oc-admin__hint">{m.bridge_loading()}</p>;
  }
  if (health === null) {
    return (
      <div className="oc-bridge-card oc-bridge-card--idle">
        {m.bridge_no_reading_yet()}
      </div>
    );
  }

  const errorTargets = bridgeErrorTargets(health.targets);
  const unreachable = !health.reachable;
  const healthy = isBridgeHealthy(health);
  const tone = healthy ? "ok" : "error";
  const checkedAt = new Date(health.checkedAt).toLocaleString("fr-FR");
  const startedAt =
    health.startedAt != null
      ? new Date(health.startedAt).toLocaleString("fr-FR")
      : null;

  return (
    <div className={`oc-bridge-card oc-bridge-card--${tone}`}>
      <div className="oc-bridge-card__icon" aria-hidden>
        {healthy ? (
          <CheckCircle2 size={22} />
        ) : unreachable ? (
          <WifiOff size={22} />
        ) : (
          <AlertTriangle size={22} />
        )}
      </div>
      <div className="oc-bridge-card__body">
        <div className="oc-bridge-card__title">
          {healthy
            ? m.bridge_operational()
            : unreachable
              ? m.bridge_unreachable()
              : m.bridge_targets_in_error({ count: errorTargets.length })}
        </div>
        <div className="oc-bridge-card__meta">
          <span>
            <RefreshCw size={12} aria-hidden />{" "}
            {m.bridge_checked_at({ time: checkedAt })}
          </span>
          {startedAt ? <span>{m.bridge_started_at({ time: startedAt })}</span> : null}
          {version}
        </div>
        {unreachable ? (
          <p className="oc-bridge-card__hint">
            {dispatchErrorInfo(
              health.lastError === "not_configured"
                ? "NOT_CONFIGURED"
                : "BRIDGE_UNREACHABLE",
            ).hint}
          </p>
        ) : null}
      </div>
      <button type="button" className="oc-bridgebar__drill" onClick={onSeeAnomalies}>
        {m.bridge_anomalies_link()}
      </button>
    </div>
  );
}

// ── One provider card: its connections + compatibility + config ──────────────
function ProviderCard({
  providerKey,
  connections,
  instances,
  manifest,
  compatStatus,
  compatReachable,
}: {
  providerKey: string;
  connections: Health["targets"];
  instances: Instance[];
  manifest: Compat["compat"] | null;
  compatStatus: "loading" | "nodata" | "ready";
  compatReachable: boolean;
}) {
  const support = manifest ? providerSupport(manifest, providerKey) : null;
  // Per-instance compatibility from the PER-INSTANCE health targets (each carries
  // its own gateway version), deduped by instance — NOT the singleton compat poller
  // (which only knew the env-BRIDGE_URL instance, so a 2nd instance was missing).
  // Display name from the instances rows (admin-only) → falls back to the raw
  // instance name for non-admins.
  const displayByInstance = new Map<string, string>();
  for (const i of instances) displayByInstance.set(i.name, i.displayName ?? i.name);
  const instanceRows: {
    instanceName: string;
    displayName: string;
    version: string | null;
    state: TargetBadgeState;
  }[] = [];
  const seenInstance = new Set<string>();
  for (const t of connections) {
    if (!t.instanceName || seenInstance.has(t.instanceName)) continue;
    seenInstance.add(t.instanceName);
    const version = t.gatewayVersion ?? null;
    instanceRows.push({
      instanceName: t.instanceName,
      displayName: displayByInstance.get(t.instanceName) ?? t.instanceName,
      version,
      state: badgeStateFromVersion(version, providerKey, manifest),
    });
  }
  // Aggregate header verdict: red if any instance is beyond support, "supported"
  // when all are, else nothing (legacy / unknown → no badge).
  const states = instanceRows.map((r) => r.state);
  const verdict = states.includes("beyond")
    ? "beyond"
    : states.length > 0 && states.every((s) => s === "supported")
      ? "supported"
      : null;

  // Connexions are a diagnostic detail → collapsed by default (the card is read
  // mostly to CHECK compatibility, drilled into connections occasionally).
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  return (
    <section className="oc-bridge-provider">
      <header className="oc-bridge-provider__head">
        <Server size={15} aria-hidden className="oc-bridge-provider__icon" />
        <span className="oc-bridge-provider__name">{providerLabel(providerKey)}</span>
        {verdict ? (
          <Badge variant={verdict === "beyond" ? "destructive" : "secondary"}>
            {targetBadgeLabel(verdict)}
          </Badge>
        ) : null}
      </header>

      {/* Compatibility — the support window first, so a connection's version below
          reads against the known-good range. Each instance row carries a kebab
          (admin-only) opening that instance's config in a modal. */}
      <h4 className="oc-bridge-provider__sub">{m.compat_section()}</h4>
      <ProviderCompat
        support={support}
        compatStatus={compatStatus}
        compatReachable={compatReachable}
        manifest={manifest}
        instanceRows={instanceRows}
      />

      {/* Connexions — collapsed by default, rendered as a list of rows. */}
      <button
        type="button"
        className="oc-bridge-provider__sub oc-bridge-provider__sub--toggle"
        aria-expanded={connectionsOpen}
        onClick={() => setConnectionsOpen((o) => !o)}
      >
        {connectionsOpen ? (
          <ChevronDown size={13} aria-hidden />
        ) : (
          <ChevronRight size={13} aria-hidden />
        )}
        {m.bridge_connections_section({ count: connections.length })}
      </button>
      {connectionsOpen ? (
        <ConnectionsTable
          connections={connections}
          displayByInstance={displayByInstance}
        />
      ) : null}

    </section>
  );
}

// The connection list (sortable/filterable table + error sub-rows) lives in
// ./ConnectionsTable.

// One provider's compatibility: its support window + validated versions + the
// per-target verdict rows. The GLOBAL bridge/protocol version lives in the status
// card above (one bridge), so it is not repeated here.
function ProviderCompat({
  support,
  compatStatus,
  compatReachable,
  manifest,
  instanceRows,
}: {
  support: ReturnType<typeof providerSupport> | null;
  compatStatus: "loading" | "nodata" | "ready";
  compatReachable: boolean;
  manifest: Compat["compat"] | null;
  instanceRows: {
    instanceName: string;
    displayName: string;
    version: string | null;
    state: TargetBadgeState;
  }[];
}) {
  // Loading / no-data come BEFORE the manifest check, so a still-loading compat
  // never flashes the "legacy bridge" message.
  if (compatStatus === "loading") {
    return <p className="oc-admin__hint">{m.bridge_loading()}</p>;
  }
  if (compatStatus === "nodata") {
    return <p className="oc-admin__hint">{m.compat_no_data()}</p>;
  }
  return (
    <div className="oc-compat">
      {!compatReachable ? <p className="oc-admin__hint">{m.compat_stale()}</p> : null}
      {manifest === null ? (
        <p className="oc-admin__hint">{m.compat_legacy_manifest()}</p>
      ) : (
        <div className="oc-compat__support">
          <span className="oc-compat__label">{m.compat_openclaw_support()}</span>
          {support && support.range !== null ? (
            <span>
              {m.compat_supported_range({
                min: support.range.min,
                max: support.range.maxValidated,
              })}
            </span>
          ) : (
            <span>{m.compat_unknown()}</span>
          )}
          {support ? (
            <ValidatedVersions versions={support.validatedVersions} />
          ) : null}
        </div>
      )}
      {instanceRows.length === 0 ? (
        <p className="oc-admin__hint">{m.compat_no_targets()}</p>
      ) : (
        <div className="oc-compat__targets">
          {instanceRows.map((r) => (
            // One row PER INSTANCE (display name, not the raw name). The provider is
            // NOT repeated — the whole card is already this provider. A trailing kebab
            // (admin-only) opens that instance's config in a modal.
            <div key={r.instanceName} className="oc-compat__target">
              <span className="oc-compat__instance">{r.displayName}</span>
              <code className="oc-traces__mono">{versionLabel(r.version)}</code>
              <Badge
                variant={
                  r.state === "supported"
                    ? "secondary"
                    : r.state === "beyond"
                      ? "destructive"
                      : "outline"
                }
              >
                {targetBadgeLabel(r.state)}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Modal wrapper around the per-instance config editor (admin-only). Opened from a
// compatibility row's kebab; scoped to ONE instance and keyed by its id at the call
// site, so the editor mounts fresh per instance (no stale form to clear).
// Exported so the Instances tab can open the SAME per-instance bridge config
// modal from its own row action (one config UI, reached from two places).
export function InstanceConfigDialog({
  instance,
  onClose,
}: {
  instance: Instance;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="oc-bridge-config-dialog"
        // Don't auto-focus the first field's "?" help button on open — it would pop
        // its tooltip over the title. Focus the dialog container instead (a11y-safe:
        // the dialog is still trapped + labelled by its title).
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {m.bridge_config_dialog_title({
              instance: instance.displayName ?? instance.name,
            })}
          </DialogTitle>
          <DialogDescription>{m.bridge_config_hint()}</DialogDescription>
        </DialogHeader>
        <InstanceConfigEditor instance={instance} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

// ConfigForm + buildConfigOverride live in ./bridgeConfigForm (pure, unit-tested):
// "persist ONLY explicit overrides" so a bare Save never shadows the bridge's env.


/** One leg of the shared-fs path-check result (inbound / outbound). */
function CheckRow({
  label,
  result,
}: {
  label: string;
  result?: { checked: boolean; ok: boolean; detail: string };
}) {
  if (!result) return null;
  if (!result.checked) {
    return (
      <p className="oc-bridge-config__check-row oc-bridge-config__check-row--skip">
        {label} — {m.bridge_config_check_skipped()}
      </p>
    );
  }
  return (
    <p
      className={
        "oc-bridge-config__check-row " +
        (result.ok
          ? "oc-bridge-config__check-row--ok"
          : "oc-bridge-config__check-row--err")
      }
    >
      {result.ok ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}
      <span>
        {label} — {result.ok ? m.bridge_config_check_ok() : result.detail}
      </span>
    </p>
  );
}

// Per-instance NON-secret bridge config editor (Model M). Scoped to ONE
// instance (the one whose compat-row kebab opened this), rendered inside a modal.
// ADMIN-ONLY (parent gates + the mutation re-enforces it server-side). Edits are
// hot-consumed by that instance's bridge on its next dispatch — no restart.
// Secrets are NEVER here (env-only).
function InstanceConfigEditor({
  instance,
  onClose,
}: {
  instance: Instance;
  onClose: () => void;
}) {
  const save = useMutation(api.admin.upsertInstanceConfig);
  const validate = useAction(api.bridge.validateMediaPaths);
  const toast = useToast();
  // Form seeded from THIS instance's stored config. The dialog is keyed by
  // instance id, so a fresh editor mounts per instance (no stale state to clear).
  const [form, setForm] = useState<ConfigForm>(() =>
    formFromConfig((instance.config ?? {}) as Partial<ConfigForm>),
  );
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<
    FunctionReturnType<typeof api.bridge.validateMediaPaths> | null
  >(null);

  const sharedFsInbound = form.inboundMediaMode === "shared-fs";
  const sharedFsOutbound = form.mediaMode === "shared-fs";
  const showsPaths = sharedFsInbound || sharedFsOutbound;

  async function runCheck() {
    setChecking(true);
    setCheck(null);
    try {
      // Validate the CURRENT (possibly unsaved) form modes, not the stored config,
      // so the operator verifies the bridge's shared dirs are reachable BEFORE
      // committing — never persisting a config that turns out non-functional.
      setCheck(
        await validate({
          instanceName: instance.name,
          inboundMediaMode: form.inboundMediaMode,
          mediaMode: form.mediaMode,
        }),
      );
    } catch (err) {
      toast.error(m.bridge_config_check_failed(), err);
    } finally {
      setChecking(false);
    }
  }

  async function submit() {
    setSaving(true);
    try {
      // Persist ONLY explicit overrides — never the defaults-filled form (which
      // would shadow the bridge's own env on every dispatch).
      const stored = (instance.config ?? {}) as Partial<ConfigForm>;
      await save({
        instanceId: instance._id as Id<"instances">,
        config: buildConfigOverride(form, stored),
      });
      // Silent-on-success (app convention); only a FAILURE surfaces a toast.
      onClose();
    } catch (err) {
      toast.error(m.bridge_config_save_failed(), err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="oc-bridge-config">
      <div className="oc-bridge-config__form">
        <div className="oc-bridge-config__grid">
          <label className="oc-field">
            <FieldLabel
              label={m.bridge_config_media_mode()}
              help={m.bridge_config_media_mode_help()}
            />
            <Select
              value={form.mediaMode}
              onValueChange={(v) =>
                setForm({ ...form, mediaMode: v as MediaMode })
              }
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEDIA_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {mode}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="oc-field">
            <FieldLabel
              label={m.bridge_config_inbound_mode()}
              help={m.bridge_config_inbound_mode_help()}
            />
            <Select
              value={form.inboundMediaMode}
              onValueChange={(v) =>
                setForm({
                  ...form,
                  inboundMediaMode: v as InboundMediaMode,
                })
              }
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INBOUND_MEDIA_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {mode}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="oc-field">
            <FieldLabel
              label={m.bridge_config_media_max_mb()}
              help={m.bridge_config_media_max_mb_help()}
            />
            <Input
              type="number"
              min={1}
              max={4096}
              className="w-full"
              value={form.mediaMaxMb}
              onChange={(e) =>
                setForm({
                  ...form,
                  mediaMaxMb: Math.trunc(Number(e.target.value) || 0),
                })
              }
            />
          </label>
        </div>

        {/* Shared-fs media PATHS — shown only for the leg(s) in shared-fs. */}
        {showsPaths && (
          <div className="oc-bridge-config__grid">
            {sharedFsInbound && (
              <label className="oc-field">
                <FieldLabel
                  label={m.bridge_config_inbound_path()}
                  help={m.bridge_config_inbound_path_help()}
                />
                <Input
                  className="w-full"
                  spellCheck={false}
                  value={form.inboundAgentMount}
                  onChange={(e) =>
                    setForm({ ...form, inboundAgentMount: e.target.value })
                  }
                />
              </label>
            )}
            {sharedFsOutbound && (
              <label className="oc-field">
                <FieldLabel
                  label={m.bridge_config_outbound_path()}
                  help={m.bridge_config_outbound_path_help()}
                />
                <Input
                  className="w-full"
                  spellCheck={false}
                  value={form.outboundAgentMount}
                  onChange={(e) =>
                    setForm({ ...form, outboundAgentMount: e.target.value })
                  }
                />
              </label>
            )}
          </div>
        )}

        <label className="oc-field--row">
          <Checkbox
            checked={form.rehydration}
            onCheckedChange={(v) =>
              setForm({ ...form, rehydration: v === true })
            }
          />
          <FieldLabel
            label={m.bridge_config_rehydration()}
            help={m.bridge_config_rehydration_help()}
          />
        </label>

        {/* Shared-fs path check result (bridge-side access). */}
        {showsPaths && check !== null && (
          <div className="oc-bridge-config__check">
            {!check.reachable ? (
              <p className="oc-bridge-config__check-row oc-bridge-config__check-row--err">
                <AlertTriangle aria-hidden />
                {m.bridge_config_check_unreachable()}
              </p>
            ) : !check.inbound && !check.outbound ? (
              // Reachable but the bridge returned a non-2xx (old bridge w/o the
              // route, 500, bad secret…): surface the reason instead of rendering
              // empty check rows (both CheckRows null) that look like nothing ran.
              <p className="oc-bridge-config__check-row oc-bridge-config__check-row--err">
                <AlertTriangle aria-hidden />
                {m.bridge_config_check_errored({ reason: check.reason ?? "?" })}
              </p>
            ) : (
              <>
                <CheckRow
                  label={m.bridge_config_check_inbound()}
                  result={check.inbound}
                />
                <CheckRow
                  label={m.bridge_config_check_outbound()}
                  result={check.outbound}
                />
                <p className="oc-admin__hint">{m.bridge_config_check_note()}</p>
              </>
            )}
          </div>
        )}

        <div className="oc-bridge-config__actions">
          {showsPaths && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runCheck()}
              disabled={checking}
            >
              {checking ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              {checking ? m.bridge_config_checking() : m.bridge_config_check()}
            </Button>
          )}
          <Button size="sm" onClick={() => void submit()} disabled={saving}>
            {m.bridge_config_save()}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The validated-version list, SUMMARIZED: the support window already carries the
 * durable information; the full list only matters on demand. It grows with every
 * bench-validated gateway release, so it collapses to one count chip opening a
 * BOUNDED, scrollable popover (newest first).
 */
function ValidatedVersions({ versions }: { versions: string[] }) {
  if (versions.length === 0) return null;
  const newestFirst = [...versions].reverse();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="oc-compat__versions-btn">
          {versions.length === 1
            ? m.compat_versions_count()
            : m.compat_versions_count_plural({ count: versions.length })}
          <ChevronDown size={13} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="oc-compat__versions-pop" align="start">
        <p className="oc-compat__versions-title">{m.compat_versions_pop_title()}</p>
        <div className="oc-compat__versions-list">
          {newestFirst.map((v) => (
            <Badge key={v} variant="secondary">
              {v}
            </Badge>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
