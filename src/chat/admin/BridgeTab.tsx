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
  HelpCircle,
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { dispatchErrorInfo } from "@/lib/dispatchErrorInfo";
import {
  DEFAULT_INSTANCE_CONFIG,
  MEDIA_MODES,
  INBOUND_MEDIA_MODES,
  type InboundMediaMode,
  type MediaMode,
} from "../../../convex/lib/instanceConfig";
import { buildConfigOverride, type ConfigForm } from "./bridgeConfigForm";
import { m } from "@/paraglide/messages.js";
import {
  hasProvider,
  providerSupport,
  targetBadgeLabel,
  targetBadgeState,
  versionLabel,
} from "./compatView";
import {
  bridgeErrorTargets,
  isBridgeHealthy,
  showsBridgeErrorDetail,
  showsDownstreamReject,
} from "./bridgeHealthView";
import { groupBridgeByProvider, providerLabel } from "./bridgeProviderView";

// "Bridge" settings tab. Organized BY PROVIDER (CHAT_UX_DESIGN layer-cake +
// Gestalt common-region): one GLOBAL status card for the bridge process itself
// (reachability + version — there is one bridge), then one self-contained card
// per downstream provider (OpenClaw, later Hermes) bundling that provider's
// connections + compatibility + per-instance config. A provider card appears
// only when that provider is actually present (no dead Hermes UI). Non-secret
// only — tokens / device identity never leave the bridge env.

type Health = NonNullable<ReturnType<typeof useBridgeHealth>>;
function useBridgeHealth() {
  return useQuery(api.bridgeHealth.getBridgeHealth, {});
}
type Compat = NonNullable<FunctionReturnType<typeof api.compat.getBridgeCompat>>;
type Instance = NonNullable<
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
          compatTargets={b.compatTargets}
          instances={b.instances}
          manifest={manifest}
          compatStatus={compatStatus}
          compatReachable={compat?.reachable ?? true}
          isAdmin={isAdmin}
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
  const version =
    compat && compat !== null ? (
      <span className="oc-bridge-card__ver">
        <code className="oc-traces__mono">{versionLabel(compat.bridgeVersion)}</code>
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
  compatTargets,
  instances,
  manifest,
  compatStatus,
  compatReachable,
  isAdmin,
}: {
  providerKey: string;
  connections: Health["targets"];
  compatTargets: Compat["targets"];
  instances: Instance[];
  manifest: Compat["compat"] | null;
  compatStatus: "loading" | "nodata" | "ready";
  compatReachable: boolean;
  isAdmin: boolean;
}) {
  const support = manifest ? providerSupport(manifest, providerKey) : null;
  // Aggregate header verdict: red if any target is beyond support, "supported"
  // when all are, else nothing (legacy / unknown → no badge).
  const states = compatTargets.map((t) => targetBadgeState(t, manifest));
  const verdict = states.includes("beyond")
    ? "beyond"
    : states.length > 0 && states.every((s) => s === "supported")
      ? "supported"
      : null;

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

      {/* Connexions */}
      <h4 className="oc-bridge-provider__sub">
        {m.bridge_connections_section({ count: connections.length })}
      </h4>
      {connections.length === 0 ? (
        <p className="oc-admin__hint">{m.bridge_no_connection_tested()}</p>
      ) : (
        <div className="oc-bridge-targets">
          {connections.map((t) => (
            <ConnectionRow key={t.key} t={t} />
          ))}
        </div>
      )}

      {/* Compatibility */}
      <h4 className="oc-bridge-provider__sub">{m.compat_section()}</h4>
      <ProviderCompat
        support={support}
        compatStatus={compatStatus}
        compatReachable={compatReachable}
        manifest={manifest}
        compatTargets={compatTargets}
      />

      {/* Configuration (admin-only, collapsed by default) */}
      {isAdmin && instances.length > 0 ? (
        <CollapsibleConfig instances={instances} />
      ) : null}
    </section>
  );
}

// One connection row (a canonical/agent target of the bridge → its gateway).
function ConnectionRow({ t }: { t: Health["targets"][number] }) {
  // The red error block is for a CURRENT bridge-domain failure only (see
  // bridgeHealthView): a recovered/connected target keeps lastError as history
  // but must NOT look red once the bridge reaches its gateway.
  const info = showsBridgeErrorDetail(t) ? dispatchErrorInfo(t.lastErrorCode) : null;
  // A downstream rejection (the gateway refused the request) is NOT a bridge
  // fault — shown as a neutral note, attributed to the gateway.
  const downstream = showsDownstreamReject(t)
    ? dispatchErrorInfo(t.lastDownstreamRejectCode)
    : null;
  return (
    <div className={`oc-bridge-target oc-bridge-target--${t.state}`}>
      <div className="oc-bridge-target__head">
        <code className="oc-traces__mono">
          {t.canonical}/{t.agentId}
        </code>
        <TargetStateBadge state={t.state} />
        <span className="oc-bridge-target__host">{t.gatewayHost}</span>
      </div>
      <div className="oc-bridge-target__stats">
        {m.bridge_target_stats({
          ok: t.okCount,
          errors: t.errorCount,
          attempts: t.attempts,
        })}
        {t.lastOkAt
          ? m.bridge_target_last_ok({
              time: new Date(t.lastOkAt).toLocaleTimeString("fr-FR"),
            })
          : ""}
      </div>
      {info ? (
        <div className="oc-bridge-target__error">
          <strong>{info.label}</strong>{" "}
          <code className="oc-traces__mono">{t.lastErrorCode}</code>
          {t.lastErrorAt
            ? ` · ${new Date(t.lastErrorAt).toLocaleTimeString("fr-FR")}`
            : ""}
          <p className="oc-bridge-card__hint">{info.hint}</p>
        </div>
      ) : null}
      {downstream ? (
        <div className="oc-bridge-target__downstream">
          {m.bridge_target_downstream_reject({ label: downstream.label })}{" "}
          <code className="oc-traces__mono">{t.lastDownstreamRejectCode}</code>
          {t.lastDownstreamRejectAt
            ? ` · ${new Date(t.lastDownstreamRejectAt).toLocaleTimeString("fr-FR")}`
            : ""}
        </div>
      ) : null}
    </div>
  );
}

// One provider's compatibility: its support window + validated versions + the
// per-target verdict rows. The GLOBAL bridge/protocol version lives in the status
// card above (one bridge), so it is not repeated here.
function ProviderCompat({
  support,
  compatStatus,
  compatReachable,
  manifest,
  compatTargets,
}: {
  support: ReturnType<typeof providerSupport> | null;
  compatStatus: "loading" | "nodata" | "ready";
  compatReachable: boolean;
  manifest: Compat["compat"] | null;
  compatTargets: Compat["targets"];
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
      {compatTargets.length === 0 ? (
        <p className="oc-admin__hint">{m.compat_no_targets()}</p>
      ) : (
        <div className="oc-compat__targets">
          {compatTargets.map((t) => {
            const state = targetBadgeState(t, manifest);
            return (
              <div key={t.instanceName} className="oc-compat__target">
                <code className="oc-traces__mono">{t.instanceName}</code>
                <span className="oc-compat__provider">{t.provider}</span>
                <code className="oc-traces__mono">
                  {versionLabel(t.gatewayVersion)}
                </code>
                <Badge
                  variant={
                    state === "supported"
                      ? "secondary"
                      : state === "beyond"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {targetBadgeLabel(state)}
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Collapsible wrapper around the per-instance config editor: the densest block,
// admin-only, collapsed by default (Hick / progressive disclosure — the tab is
// read mostly to CHECK health, configured occasionally).
function CollapsibleConfig({ instances }: { instances: Instance[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`oc-bridge-provider__config${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="oc-bridge-provider__config-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown size={14} aria-hidden />
        ) : (
          <ChevronRight size={14} aria-hidden />
        )}
        {m.bridge_config_title()}
      </button>
      {open ? <InstanceConfigEditor instances={instances} /> : null}
    </div>
  );
}

// ConfigForm + buildConfigOverride live in ./bridgeConfigForm (pure, unit-tested):
// "persist ONLY explicit overrides" so a bare Save never shadows the bridge's env.

/** A small `?` help bubble next to a form field label (hover/focus tooltip). */
function FieldHelp({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="oc-field__help"
            aria-label={text}
            onClick={(e) => e.preventDefault()}
          >
            <HelpCircle aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-pretty">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** A field label with its help bubble — keeps every field consistent. */
function FieldLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="oc-field__label">
      {label}
      <FieldHelp text={help} />
    </span>
  );
}

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
// provider's instances (passed in). ADMIN-ONLY (parent gates + the mutation
// re-enforces it server-side). Edits are hot-consumed by that instance's bridge
// on its next dispatch — no restart. Secrets are NEVER here (env-only).
function InstanceConfigEditor({ instances }: { instances: Instance[] }) {
  const save = useMutation(api.admin.upsertInstanceConfig);
  const validate = useAction(api.bridge.validateMediaPaths);
  const toast = useToast();
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [form, setForm] = useState<ConfigForm>({ ...DEFAULT_INSTANCE_CONFIG });
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<
    FunctionReturnType<typeof api.bridge.validateMediaPaths> | null
  >(null);

  const sharedFsInbound = form.inboundMediaMode === "shared-fs";
  const sharedFsOutbound = form.mediaMode === "shared-fs";
  const showsPaths = sharedFsInbound || sharedFsOutbound;

  async function runCheck() {
    if (!instanceId) return;
    const inst = instances.find((i) => i._id === instanceId);
    if (!inst) return;
    setChecking(true);
    setCheck(null);
    try {
      // Validate the CURRENT (possibly unsaved) form modes, not the stored config,
      // so the operator verifies the bridge's shared dirs are reachable BEFORE
      // committing — never persisting a config that turns out non-functional.
      setCheck(
        await validate({
          instanceName: inst.name,
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

  function selectInstance(id: string) {
    setInstanceId(id);
    const inst = instances.find((i) => i._id === id);
    const c = inst?.config ?? {};
    setForm({
      mediaMode: c.mediaMode ?? DEFAULT_INSTANCE_CONFIG.mediaMode,
      inboundMediaMode:
        c.inboundMediaMode ?? DEFAULT_INSTANCE_CONFIG.inboundMediaMode,
      rehydration: c.rehydration ?? DEFAULT_INSTANCE_CONFIG.rehydration,
      mediaMaxMb: c.mediaMaxMb ?? DEFAULT_INSTANCE_CONFIG.mediaMaxMb,
      inboundAgentMount:
        c.inboundAgentMount ?? DEFAULT_INSTANCE_CONFIG.inboundAgentMount,
      outboundAgentMount:
        c.outboundAgentMount ?? DEFAULT_INSTANCE_CONFIG.outboundAgentMount,
    });
    setCheck(null);
  }

  async function submit() {
    if (!instanceId) return;
    setSaving(true);
    try {
      // Persist ONLY explicit overrides — never the defaults-filled form (which
      // would shadow the bridge's own env on every dispatch).
      const stored = (instances.find((i) => i._id === instanceId)?.config ??
        {}) as Partial<ConfigForm>;
      await save({
        instanceId: instanceId as Id<"instances">,
        config: buildConfigOverride(form, stored),
      });
      // Silent-on-success (app convention); only a FAILURE surfaces a toast.
    } catch (err) {
      toast.error(m.bridge_config_save_failed(), err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="oc-bridge-config">
      <p className="oc-admin__hint">{m.bridge_config_hint()}</p>
      <div className="oc-bridge-config__form">
        <label className="oc-field">
          <FieldLabel
            label={m.bridge_config_instance()}
            help={m.bridge_config_instance_help()}
          />
          <Select value={instanceId ?? ""} onValueChange={selectInstance}>
            <SelectTrigger size="sm" className="w-full sm:w-72">
              <SelectValue placeholder={m.bridge_config_pick_instance()} />
            </SelectTrigger>
            <SelectContent>
              {instances.map((i) => (
                <SelectItem key={i._id} value={i._id}>
                  {i.displayName ?? i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {instanceId !== null && (
          <>
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
          </>
        )}
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

function TargetStateBadge({ state }: { state: string }) {
  if (state === "connected")
    return <Badge variant="secondary">{m.bridge_state_connected()}</Badge>;
  if (state === "error")
    return <Badge variant="destructive">{m.bridge_state_error()}</Badge>;
  return <Badge variant="outline">{m.bridge_state_inactive()}</Badge>;
}
