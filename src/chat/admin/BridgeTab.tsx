import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2,
  AlertTriangle,
  WifiOff,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { api } from "../convexApi";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { dispatchErrorInfo } from "@/lib/dispatchErrorInfo";
import { m } from "@/paraglide/messages.js";
import {
  hasProvider,
  providerSupport,
  targetBadgeLabel,
  targetBadgeState,
  versionLabel,
} from "./compatView";

// "Bridge" settings tab — the place to see EVERYTHING about the bridge's health:
// reachability, per-connection state, the curated root cause + fix hint of any
// failure, counters and timestamps. Reads the active health poll
// (bridgeHealth.getBridgeHealth, admin). Non-secret only — tokens/device
// identity never leave the bridge env.

type Health = NonNullable<ReturnType<typeof useBridgeHealth>>;
function useBridgeHealth() {
  return useQuery(api.bridgeHealth.getBridgeHealth, {});
}

export function BridgeTab() {
  const health = useBridgeHealth();
  const navigate = useNavigate();
  return (
    <div className="oc-bridge">
      <p className="oc-admin__hint">{m.bridge_health_hint()}</p>
      {health === undefined ? (
        <p className="oc-admin__hint">{m.bridge_loading()}</p>
      ) : health === null ? (
        <div className="oc-bridge-card oc-bridge-card--idle">
          {m.bridge_no_reading_yet()}
        </div>
      ) : (
        <BridgeHealthDetail
          health={health}
          onSeeAnomalies={() =>
            void navigate({ to: "/settings/anomalies", search: { status: "open" } })
          }
        />
      )}
      <CompatSection />
    </div>
  );
}

// "Compatibilite" section (VCOMPAT-C): the bridge's version manifest as polled
// into the bridgeCompat singleton — bridge/protocol versions, the OpenClaw
// support window with its validated versions, and a per-connection verdict
// badge. A failed poll preserves the last-good snapshot, hence the "stale"
// hint when reachable is false.
function CompatSection() {
  const compat = useQuery(api.compat.getBridgeCompat, {});
  return (
    <>
      <h3 className="oc-bridge__section">{m.compat_section()}</h3>
      {compat === undefined ? (
        <p className="oc-admin__hint">{m.bridge_loading()}</p>
      ) : compat === null ? (
        <p className="oc-admin__hint">{m.compat_no_data()}</p>
      ) : (
        <CompatDetail data={compat} />
      )}
    </>
  );
}

function CompatDetail({
  data,
}: {
  data: NonNullable<FunctionReturnType<typeof api.compat.getBridgeCompat>>;
}) {
  const support = providerSupport(data.compat, "openclaw");
  return (
    <div className="oc-compat">
      <div className="oc-compat__meta">
        <span>
          {m.compat_bridge_version_label()}{" "}
          <code className="oc-traces__mono">{versionLabel(data.bridgeVersion)}</code>
        </span>
        <span>
          {m.compat_protocol_label()}{" "}
          <code className="oc-traces__mono">
            {data.protocolVersion !== null
              ? String(data.protocolVersion)
              : m.compat_unknown()}
          </code>
        </span>
        <span>
          {m.bridge_checked_at({
            time: new Date(data.fetchedAt).toLocaleString("fr-FR"),
          })}
        </span>
      </div>
      {!data.reachable ? (
        <p className="oc-admin__hint">{m.compat_stale()}</p>
      ) : null}
      {data.compat === null ? (
        // Legacy bridge: no manifest shipped — name the policy in force.
        <p className="oc-admin__hint">{m.compat_legacy_manifest()}</p>
      ) : (
        <div className="oc-compat__support">
          <span className="oc-compat__label">{m.compat_openclaw_support()}</span>
          {support.range !== null ? (
            <span>
              {m.compat_supported_range({
                min: support.range.min,
                max: support.range.maxValidated,
              })}
            </span>
          ) : (
            <span>{m.compat_unknown()}</span>
          )}
          <ValidatedVersions versions={support.validatedVersions} />
        </div>
      )}
      {data.targets.length === 0 ? (
        <p className="oc-admin__hint">{m.compat_no_targets()}</p>
      ) : (
        <div className="oc-compat__targets">
          {data.targets.map((t) => {
            const state = targetBadgeState(t, data.compat);
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
      {hasProvider(data.compat, "hermes") ? (
        // Rendered ONLY when the manifest announces the provider — no dead UI.
        <p className="oc-admin__hint">{m.compat_hermes_coming()}</p>
      ) : null}
    </div>
  );
}

/**
 * The validated-version list, SUMMARIZED: the support window above already
 * carries the durable information; the full list only matters on demand. Over
 * the app's life this list grows with every bench-validated gateway release —
 * a flat badge row would crowd the panel within months, so it collapses to one
 * count chip opening a BOUNDED, scrollable popover (newest first).
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

function BridgeHealthDetail({
  health,
  onSeeAnomalies,
}: {
  health: Health;
  onSeeAnomalies: () => void;
}) {
  const errorTargets = health.targets.filter((t) => t.state === "error");
  const unreachable = !health.reachable;
  const healthy = health.reachable && errorTargets.length === 0;
  const tone = healthy ? "ok" : "error";
  const checkedAt = new Date(health.checkedAt).toLocaleString("fr-FR");
  const startedAt =
    health.startedAt != null
      ? new Date(health.startedAt).toLocaleString("fr-FR")
      : null;

  return (
    <>
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
              <RefreshCw size={12} aria-hidden /> {m.bridge_checked_at({ time: checkedAt })}
            </span>
            {startedAt ? <span>{m.bridge_started_at({ time: startedAt })}</span> : null}
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

      <h3 className="oc-bridge__section">
        {m.bridge_connections_section({ count: health.targets.length })}
      </h3>
      {health.targets.length === 0 ? (
        <p className="oc-admin__hint">{m.bridge_no_connection_tested()}</p>
      ) : (
        <div className="oc-bridge-targets">
          {health.targets.map((t) => {
            const info = t.lastErrorCode ? dispatchErrorInfo(t.lastErrorCode) : null;
            return (
              <div key={t.key} className={`oc-bridge-target oc-bridge-target--${t.state}`}>
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
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function TargetStateBadge({ state }: { state: string }) {
  if (state === "connected")
    return <Badge variant="secondary">{m.bridge_state_connected()}</Badge>;
  if (state === "error")
    return <Badge variant="destructive">{m.bridge_state_error()}</Badge>;
  return <Badge variant="outline">{m.bridge_state_inactive()}</Badge>;
}
