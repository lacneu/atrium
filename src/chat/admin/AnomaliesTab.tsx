import { useMemo, useState } from "react";
import { APP_HOST } from "@/lib/appHost";
import { useMutation, useQuery } from "convex/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { FilterBar } from "./filters/FilterBar";
import { useResolvedRange } from "./filters/TimeRangePicker";
import type { TimeRange } from "./filters/types";
import { decodeRange, encodeRange } from "@/lib/routing/searchSchemas";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { dispatchErrorInfo } from "@/lib/dispatchErrorInfo";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages.js";

// "Anomalies" tab (D-3) — detector + agent-reported anomalies. Reads
// api.anomalies.listAnomalies (admin) and offers a per-open-row Resolve /
// Acknowledge action via api.anomalies.resolveAnomaly. All rows are non-PHI
// metadata (kind, severity, message, correlationId); evidence is a JSON string
// the reporter is responsible for keeping PHI-free.
//
// Status filter is a CLIENT control that maps to the backend `status` arg:
// "open" → only open rows; "all" → no status filter (the backend returns
// newest-first across all statuses). Resolve actions are only offered on open
// rows (resolving an already-resolved row is a no-op).

type AnomalyView = {
  _id: Id<"anomalies">;
  at: number;
  kind: string;
  severity: "info" | "warn" | "critical";
  status: "open" | "acknowledged" | "resolved";
  message: string;
  source: "detector" | "agent";
  correlationId: string | null;
  evidence: string | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
};

// "Select all" sentinel for the quick <Select>s (radix has no empty value).
const ALL = "__all__";

// anomalyStatus options (the backend filter key is `anomalyStatus`, NOT the
// top-level `status` arg). Default "open" preserves today's view.
const STATUS_OPTIONS = [
  { value: "open" },
  { value: "acknowledged" },
  { value: "resolved" },
] as const;

// Resolve a STATUS_OPTIONS label at RENDER time (not module scope) so it reacts
// to a reload-free locale switch — module-level m.*() would evaluate once at
// import and go stale.
function statusOptionLabel(value: (typeof STATUS_OPTIONS)[number]["value"]): string {
  if (value === "open") return m.anomalies_status_option_open();
  if (value === "acknowledged") return m.anomalies_status_option_acknowledged();
  return m.anomalies_status_option_resolved();
}

const SEVERITIES = ["info", "warn", "critical"] as const;
// "user" = a user-flagged sub-agent failure (the content-free plane-2 of a
// subAgentReports record). detector = the cron; agent = the key-authed POST.
const SOURCES = ["detector", "agent", "user"] as const;

// Default time window for the anomalies table. Wide (30d) so seeded/older
// anomalies surface on load — anomalies previously had NO time filter, so a
// narrow default would hide rows older than it within the bounded window.
const DEFAULT_RANGE: TimeRange = { kind: "relative", from: "now-30d", to: "now" };

const LIST_LIMIT = 200;

// The URL `status` token "all" displays as the ALL sentinel in the Select and
// maps to NO `anomalyStatus` arg (all statuses). The default token is "open".
const STATUS_ALL = "all";

export function AnomaliesTab() {
  const search = useSearch({ from: "/settings/anomalies" });
  const navigate = useNavigate({ from: "/settings/anomalies" });

  const q = search.q ?? "";
  // URL token "all" → ALL sentinel for the Select; default "open".
  const anomalyStatus = search.status === STATUS_ALL ? ALL : search.status;
  const severity = search.severity ?? ALL;
  const kind = search.kind ?? ALL;
  // `source` is NOT in the URL contract (§3.4 table) — kept as a client-only
  // ephemeral, like serviceAccounts' role filter. Still passed to the query.
  const [source, setSource] = useState<string>(ALL);
  // URL stores time-range TOKENS; resolve to live epoch ms at component level.
  const range = decodeRange(search.from, search.to);
  const { from, to } = useResolvedRange(range);

  const setQ = (v: string) =>
    void navigate({ search: (p) => ({ ...p, q: v || undefined }), replace: true });
  // The Select's ALL sentinel maps to the URL token "all" (explicit, so the
  // default open-only view is preserved and degrades safely).
  const setAnomalyStatus = (v: string) =>
    void navigate({
      search: (p) => ({
        ...p,
        status: v === ALL ? STATUS_ALL : (v as "open" | "acknowledged" | "resolved"),
      }),
    });
  const setSeverity = (v: string) =>
    void navigate({
      search: (p) => ({ ...p, severity: v === ALL ? undefined : (v as "info" | "warn" | "critical") }),
    });
  const setKind = (v: string) =>
    void navigate({ search: (p) => ({ ...p, kind: v === ALL ? undefined : v }) });
  const setRange = (r: TimeRange) =>
    void navigate({ search: (p) => ({ ...p, ...encodeRange(r) }) });

  const confirm = useConfirm();
  const toast = useToast();
  const resolveAnomaly = useMutation(api.anomalies.resolveAnomaly);
  // Resolving/acknowledging is an admin-only WRITE (resolveAnomaly stays
  // requireAdmin). A non-admin granted only `anomalies.read` can VIEW anomalies
  // but must not see actions that would 403 — hide them. (admin.manage is held
  // by admins via the wildcard.)
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const canResolve = (me?.permissions ?? []).includes("admin.manage");

  const rows = useQuery(api.anomalies.listAnomalies, {
    limit: LIST_LIMIT,
    filter: {
      q: q || undefined,
      from,
      to,
      // The backend status filter key for anomalies is `anomalyStatus`. The
      // ALL sentinel (URL token "all") maps to undefined (all statuses).
      anomalyStatus: anomalyStatus === ALL ? undefined : anomalyStatus,
      severity: severity === ALL ? undefined : severity,
      source: source === ALL ? undefined : source,
      kind: kind === ALL ? undefined : kind,
    },
  }) as AnomalyView[] | undefined;

  // Distinct kinds present in the current window (dynamic option list).
  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) set.add(r.kind);
    return [...set].sort();
  }, [rows]);

  const filtersActive =
    q !== "" ||
    anomalyStatus !== "open" ||
    severity !== ALL ||
    source !== ALL ||
    kind !== ALL ||
    range.kind !== "relative" ||
    range.from !== DEFAULT_RANGE.from;
  function resetFilters() {
    // Reset to schema defaults. `status` has a non-optional output type (zod
    // default "open"), so it must be set explicitly; the rest drop to undefined.
    setSource(ALL);
    void navigate({ search: { status: "open" }, replace: true });
  }

  async function resolve(row: AnomalyView) {
    const ok = await confirm({
      title: m.anomalies_resolve_confirm_title(),
      description: (
        <>
          {m.anomalies_resolve_confirm_desc_before()}{" "}
          <span className="font-mono">{row.kind}</span>{" "}
          {m.anomalies_resolve_confirm_desc_marked()}{" "}
          <strong>{m.anomalies_resolve_confirm_desc_resolved()}</strong>.{" "}
          {m.anomalies_resolve_confirm_desc_after()}
        </>
      ),
      confirmLabel: m.anomalies_resolve_confirm_label(),
    });
    if (!ok) return;
    try {
      await resolveAnomaly({ anomalyId: row._id, status: "resolved" });
      toast.success(m.anomalies_toast_resolved(), row.kind);
    } catch (err) {
      toast.error(m.anomalies_toast_resolve_error(), err);
    }
  }

  async function acknowledge(row: AnomalyView) {
    try {
      await resolveAnomaly({ anomalyId: row._id, status: "acknowledged" });
      toast.success(m.anomalies_toast_acknowledged(), row.kind);
    } catch (err) {
      toast.error(m.anomalies_toast_acknowledge_error(), err);
    }
  }

  return (
    <>
      <p className="oc-admin__hint">
        {m.anomalies_hint_intro()}{" "}
        <strong>{m.anomalies_hint_open_label()}</strong>{" "}
        {m.anomalies_hint_open_desc()}{" "}
        <strong>{m.anomalies_hint_muted_label()}</strong>{" "}
        {m.anomalies_hint_muted_desc()}{" "}
        <strong>{m.anomalies_hint_resolved_label()}</strong>{" "}
        {m.anomalies_hint_resolved_desc()}{" "}
        <span className="oc-filter__window">
          {m.anomalies_hint_time_window()}
        </span>
      </p>

      <FilterBar
        q={q}
        onQChange={setQ}
        searchPlaceholder={m.anomalies_search_placeholder()}
        timeRange={range}
        onTimeRangeChange={setRange}
        onReset={resetFilters}
        canReset={filtersActive}
      >
        <Select value={anomalyStatus} onValueChange={setAnomalyStatus}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.anomalies_all_statuses()}</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {statusOptionLabel(s.value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder={m.anomalies_severity()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.anomalies_all_severities()}</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue placeholder={m.anomalies_source()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.anomalies_all_sources()}</SelectItem>
            {SOURCES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder={m.anomalies_type()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.anomalies_all_types()}</SelectItem>
            {kindOptions.map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>

      <DataTableShell
        title={m.anomalies_title()}
        rows={rows}
        emptyHint={
          anomalyStatus === "open"
            ? m.anomalies_empty_open()
            : m.anomalies_empty_all()
        }
        rowActions={(r) =>
          canResolve && r.status === "open"
            ? [
                { label: m.anomalies_action_resolve(), onSelect: () => void resolve(r) },
                {
                  label: m.anomalies_action_acknowledge(),
                  onSelect: () => void acknowledge(r),
                },
              ]
            : []
        }
        columns={[
          {
            header: m.anomalies_col_when(),
            cell: (r) => (
              <span className="oc-traces__time">
                {new Date(r.at).toLocaleString("fr-FR")}
              </span>
            ),
            sort: (r) => r.at,
          },
          {
            header: m.anomalies_type(),
            cell: (r) => <code className="oc-traces__mono">{r.kind}</code>,
            sort: (r) => r.kind,
          },
          {
            header: m.anomalies_severity(),
            cell: (r) => <SeverityBadge severity={r.severity} />,
            // rank: info (0) < warn (1) < critical (2)
            sort: (r) =>
              r.severity === "critical" ? 2 : r.severity === "warn" ? 1 : 0,
          },
          {
            header: m.anomalies_col_status(),
            cell: (r) => <StatusBadge status={r.status} />,
            // rank: open (0) < acknowledged (1) < resolved (2)
            sort: (r) =>
              r.status === "resolved" ? 2 : r.status === "acknowledged" ? 1 : 0,
          },
          {
            header: m.anomalies_source(),
            cell: (r) => <Badge variant="outline">{r.source}</Badge>,
            sort: (r) => r.source,
          },
          {
            header: m.anomalies_col_message(),
            cell: (r) => <span className="oc-anomaly__msg">{r.message}</span>,
            sort: (r) => r.message,
          },
          {
            header: m.anomalies_col_cause(),
            cell: (r) => <CauseCell row={r} />,
            // derived cell — sort by the underlying evidence string (best-effort).
            sort: (r) => r.evidence ?? null,
          },
          {
            header: m.anomalies_col_correlation(),
            cell: (r) =>
              r.correlationId ? (
                <code className="oc-traces__mono">
                  {shortId(r.correlationId)}
                </code>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
            sort: (r) => r.correlationId,
          },
        ]}
      />
    </>
  );
}

// Parse the dispatch-failure evidence (root cause + drill-down anchor). Only the
// dispatch_failures detector carries this; other kinds return empty -> "—".
function parseDispatchEvidence(r: AnomalyView): {
  dominantCode?: string;
  sampleCorrelationId?: string;
} {
  if (r.kind !== "openclaw.dispatch_failures" || !r.evidence) return {};
  try {
    const e = JSON.parse(r.evidence) as {
      dominantCode?: string;
      sampleCorrelationId?: string;
    };
    return {
      dominantCode: e.dominantCode,
      sampleCorrelationId: e.sampleCorrelationId,
    };
  } catch {
    return {};
  }
}

// Parse the content-free sub-agent failure evidence (a user-flagged report). The
// categories are an allowlist enum (lib/subAgentFailure) — never raw error text.
function parseSubAgentEvidence(r: AnomalyView): {
  failedCount?: number;
  totalCount?: number;
  errorCategories?: string[];
} {
  if (r.kind !== "subagent.failure" || !r.evidence) return {};
  try {
    const e = JSON.parse(r.evidence) as {
      failedCount?: number;
      totalCount?: number;
      errorCategories?: string[];
    };
    return {
      failedCount: e.failedCount,
      totalCount: e.totalCount,
      errorCategories: e.errorCategories,
    };
  } catch {
    return {};
  }
}

// Root cause + actionable fix hint + one-click drill-down into the failing turn's
// traces. This is what turns "N dispatch failures" into something an admin can
// actually fix (the user's explicit ask: "comprendre l'origine pour la fixer").
function CauseCell({ row }: { row: AnomalyView }) {
  const navigate = useNavigate();

  // User-flagged sub-agent failure: show the content-free category breakdown +
  // a drill into the spawning turn's traces (correlationId). The CONTENT lives
  // in Settings › Rapports sous-agents (audited), never here.
  if (row.kind === "subagent.failure") {
    const sa = parseSubAgentEvidence(row);
    const cats = [...new Set(sa.errorCategories ?? [])];
    return (
      <div className="oc-anomaly__cause">
        <div className="oc-anomaly__cause-head">
          {cats.map((c) => (
            <code key={c} className="oc-traces__mono">
              {c}
            </code>
          ))}
        </div>
        {row.correlationId ? (
          <button
            type="button"
            className="oc-anomaly__drill"
            onClick={() =>
              void navigate({
                to: "/settings/traces",
                search: { q: row.correlationId as string, limit: 100 },
              })
            }
          >
            ↗ {m.anomalies_view_trace()}
          </button>
        ) : null}
      </div>
    );
  }

  const ev = parseDispatchEvidence(row);
  if (!ev.dominantCode) return <span className="oc-traces__muted">—</span>;
  const info = dispatchErrorInfo(ev.dominantCode);
  const corr = ev.sampleCorrelationId;
  return (
    <div className="oc-anomaly__cause">
      <div className="oc-anomaly__cause-head">
        <span className="oc-anomaly__cause-label">{info.label}</span>
        <code className="oc-traces__mono">{ev.dominantCode}</code>
      </div>
      <p className="oc-anomaly__cause-hint">{info.hint}</p>
      {corr ? (
        <button
          type="button"
          className="oc-anomaly__drill"
          onClick={() =>
            // Drill into the failing turn's traces. `limit` is required by the
            // traces search schema (100 = its default window).
            void navigate({
              to: "/settings/traces",
              search: { q: corr, limit: 100 },
            })
          }
        >
          ↗ {m.anomalies_view_trace()}
        </button>
      ) : null}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: AnomalyView["severity"] }) {
  // Color via CSS class (hex literals allowed in convexChat.css, mirroring the
  // trace status convention). Critical is the loudest; warn amber; info muted.
  return (
    <span className={`oc-anomaly__sev oc-anomaly__sev--${severity}`}>
      {severity}
    </span>
  );
}

function StatusBadge({ status }: { status: AnomalyView["status"] }) {
  if (status === "open")
    return <Badge variant="destructive">{m.anomalies_status_open()}</Badge>;
  if (status === "acknowledged")
    return <Badge variant="secondary">{m.anomalies_status_acknowledged()}</Badge>;
  return <Badge variant="outline">{m.anomalies_status_resolved()}</Badge>;
}

// First 8 chars is enough to recognize a correlationId at a glance (mirrors
// TracesTab.shortId).
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
