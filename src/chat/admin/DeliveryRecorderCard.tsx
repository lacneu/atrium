import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { APP_HOST } from "@/lib/appHost";
import { api } from "../convexApi";
import {
  reportToText,
  type DeliveryReport,
  type SegStat,
  type SessionSummary,
} from "../deliveryRecorder";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTableShell } from "./DataTableShell";
import { FilterBar } from "./filters/FilterBar";
import { type TimeRange } from "./filters/types";
import { useResolvedRange } from "./filters/TimeRangePicker";
import { m } from "@/paraglide/messages.js";

// Settings>Traces card driving the delivery-latency recorder (convex/deliveryTiming.ts):
// admins start/stop a recording and delete sessions; anyone with traces.read browses the
// recorded sessions as a sortable/filterable LIST and expands one to see its skew-corrected
// per-segment report (bridge, A=bridge->Convex, C=Convex->frontend). Content-free.

type Status = {
  recording: boolean;
  sessionId: string | null;
  startedAt: number | null;
  autoStopAt: number | null;
};

type SessionRow = SessionSummary & { _id: string };

// "All time" by default (~10y window) so opening the list never hides older records (the
// presets cap at 90d); the user can narrow afterwards. Matches the RELATIVE_PRESETS entry,
// so the picker shows the clean "All time" label.
const DEFAULT_RANGE: TimeRange = { kind: "relative", from: "now-520w", to: "now" };

const fmt = (n: number | null): string =>
  n === null ? "-" : String(Math.round(n));

// "admin:<userId>" -> "Admin"; "agent:<account>" -> "Agent - <account>".
function prettyStartedBy(startedBy: string): string {
  const i = startedBy.indexOf(":");
  if (i < 0) return startedBy;
  const kind = startedBy.slice(0, i);
  const rest = startedBy.slice(i + 1);
  if (kind === "admin") return m.delivery_by_admin();
  if (kind === "agent") return `${m.delivery_by_agent()} - ${rest}`;
  return startedBy;
}

export function DeliveryRecorderCard() {
  const me = useQuery(api.me.getMe, { host: APP_HOST }) as
    | { role?: string }
    | undefined;
  const isAdmin = me?.role === "admin";
  const status = useQuery(api.deliveryTiming.getDeliveryStatus, {}) as
    | Status
    | undefined;
  const startRec = useMutation(api.deliveryTiming.startDeliveryRecord);
  const stopRec = useMutation(api.deliveryTiming.stopDeliveryRecord);

  const [showReport, setShowReport] = useState(false);
  const [busy, setBusy] = useState(false);

  const recording = status?.recording ?? false;
  const toggle = async () => {
    setBusy(true);
    try {
      if (recording) await stopRec({});
      else await startRec({});
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-4 flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">{m.delivery_title()}</h3>
          <p className="oc-admin__hint">{m.delivery_hint()}</p>
        </div>
        {isAdmin ? (
          <Button
            variant={recording ? "destructive" : "default"}
            size="sm"
            // Disabled until status loads: before it resolves `recording` reads false,
            // so a premature click would START a new session instead of stopping the
            // active one (Codex review).
            disabled={busy || status === undefined}
            onClick={() => void toggle()}
          >
            {recording ? m.delivery_stop() : m.delivery_start()}
          </Button>
        ) : null}
      </div>

      {recording ? (
        <p className="flex items-center gap-2 text-sm">
          <Badge variant="secondary">{m.delivery_active()}</Badge>
          {status?.startedAt ? (
            <span className="text-muted-foreground">
              {m.delivery_since({
                time: new Date(status.startedAt).toLocaleTimeString(),
              })}
            </span>
          ) : null}
        </p>
      ) : null}

      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowReport((v) => !v)}
        >
          {showReport ? m.delivery_hide_records() : m.delivery_show_records()}
        </Button>
      </div>

      {showReport ? <DeliverySessionsTable isAdmin={isAdmin} /> : null}
    </section>
  );
}

function DeliverySessionsTable({ isAdmin }: { isAdmin: boolean }) {
  const sessions = useQuery(api.deliveryTiming.listDeliverySessions, {}) as
    | SessionSummary[]
    | undefined;
  const deleteSessions = useMutation(api.deliveryTiming.deleteDeliverySessions);

  // Client-side filters (the list is bounded to the recent SESSION_LIST_CAP, so no
  // server round-trip per filter change).
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "stopped">(
    "all",
  );
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Re-resolves a RELATIVE range's now-* bounds periodically, so a narrow window (e.g.
  // "last 5m") keeps advancing instead of freezing until the next state change (Codex review).
  const { from, to } = useResolvedRange(range);
  // useResolvedRange rounds `to` DOWN to the minute (for dedup), which would hide a session
  // started later in the current minute — notably the just-started active recording. For an
  // open-ended ("to: now") range the upper bound is effectively unbounded (Codex review).
  const upper = range.to === "now" ? Number.POSITIVE_INFINITY : to;

  const filtersActive =
    q.trim() !== "" || statusFilter !== "all" || range !== DEFAULT_RANGE;
  const resetFilters = () => {
    setQ("");
    setStatusFilter("all");
    setRange(DEFAULT_RANGE);
  };

  const rows: SessionRow[] | undefined = useMemo(() => {
    // Keep undefined while the query is in flight so DataTableShell shows its loading state
    // (not the "no sessions" empty hint) on a slow connection / tab reload (Codex review).
    if (sessions === undefined) return undefined;
    const ql = q.trim().toLowerCase();
    return sessions
      .filter(
        (s) =>
          (ql === "" || s.startedBy.toLowerCase().includes(ql)) &&
          (statusFilter === "all" ||
            (statusFilter === "active" ? s.active : !s.active)) &&
          s.startedAt >= from &&
          s.startedAt <= upper,
      )
      .map((s) => ({ ...s, _id: s.sessionId }));
  }, [sessions, q, statusFilter, from, upper]);

  const del = (ids: string[]) => {
    // Only delete rows still VISIBLE under the current filters — a bulk selection made
    // before a filter change must never delete now-hidden sessions (Codex review).
    const visible = new Set((rows ?? []).map((r) => r.sessionId));
    const target = ids.filter((id) => visible.has(id));
    if (target.length === 0) return;
    void deleteSessions({ sessionIds: target });
    if (expandedId !== null && target.includes(expandedId)) setExpandedId(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <DeliveryKpi sessions={sessions ?? []} />
      <FilterBar
        q={q}
        onQChange={setQ}
        searchPlaceholder={m.delivery_search_placeholder()}
        timeRange={range}
        onTimeRangeChange={setRange}
        onReset={resetFilters}
        canReset={filtersActive}
      >
        <Select
          value={statusFilter}
          onValueChange={(v) =>
            setStatusFilter(v as "all" | "active" | "stopped")
          }
        >
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{m.delivery_status_all()}</SelectItem>
            <SelectItem value="active">{m.delivery_status_active()}</SelectItem>
            <SelectItem value="stopped">
              {m.delivery_status_stopped()}
            </SelectItem>
          </SelectContent>
        </Select>
      </FilterBar>

      <DataTableShell
        title={m.delivery_sessions_title()}
        rows={rows}
        emptyHint={m.delivery_no_sessions()}
        columns={[
          {
            // Leading toggle column: an eye that expands/collapses the row's detail report
            // inline (replaces the context-menu "view detail" entry). No header / no sort.
            header: "",
            className: "w-8",
            cell: (r) => (
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  expandedId === r.sessionId
                    ? m.delivery_action_hide_detail()
                    : m.delivery_action_detail()
                }
                onClick={() =>
                  setExpandedId((id) =>
                    id === r.sessionId ? null : r.sessionId,
                  )
                }
              >
                {expandedId === r.sessionId ? (
                  <EyeOff size={15} aria-hidden />
                ) : (
                  <Eye size={15} aria-hidden />
                )}
              </Button>
            ),
          },
          {
            header: m.delivery_col_start(),
            sort: (r) => r.startedAt,
            cell: (r) => (
              <span className="tabular-nums">
                {new Date(r.startedAt).toLocaleString()}
              </span>
            ),
          },
          {
            header: m.delivery_col_end(),
            // Active (no end) sorts LAST in both directions (null-last).
            sort: (r) => r.stoppedAt,
            cell: (r) =>
              r.stoppedAt !== null ? (
                <span className="tabular-nums">
                  {new Date(r.stoppedAt).toLocaleString()}
                </span>
              ) : (
                <span className="text-muted-foreground">-</span>
              ),
          },
          {
            header: m.delivery_col_samples(),
            // null (legacy, uncounted) sorts last; the cell shows "-" via fmt.
            sort: (r) => r.count,
            cell: (r) => <span className="tabular-nums">{fmt(r.count)}</span>,
          },
          {
            header: m.delivery_col_started_by(),
            sort: (r) => r.startedBy,
            cell: (r) => prettyStartedBy(r.startedBy),
          },
          {
            header: m.delivery_col_status(),
            sort: (r) => r.active,
            cell: (r) =>
              r.active ? (
                <Badge variant="secondary">{m.delivery_status_active()}</Badge>
              ) : (
                <span className="text-muted-foreground">
                  {m.delivery_status_stopped()}
                </span>
              ),
          },
        ]}
        // Detail moved to the leading eye column; the context menu now only deletes (admins).
        rowActions={
          isAdmin
            ? (r) => [
                {
                  label: m.delivery_action_delete(),
                  variant: "destructive" as const,
                  onSelect: () => del([r.sessionId]),
                },
              ]
            : undefined
        }
        bulkActions={
          isAdmin
            ? [
                {
                  label: m.delivery_action_delete(),
                  variant: "destructive",
                  onSelect: (ids) => del(ids),
                },
              ]
            : undefined
        }
        isExpanded={(r) => r.sessionId === expandedId}
        renderExpanded={(r) => <SessionReportDetail sessionId={r.sessionId} />}
      />
    </div>
  );
}

// --- Evolution KPI: segment C + A p50 across the recent records ------------------------
// Plots each recent STOPPED record's segment-C/A p50 over time, read straight from the
// per-session `rollup` (computed server-side at stop). So opening the list is ONE cheap query
// (listDeliverySessions), not a per-record report fetch. Bounded to the recent KPI_RECORDS.
const KPI_RECORDS = 15;

type KpiDatum = { startedAt: number; cP50: number; aP50: number };

function DeliveryKpi({ sessions }: { sessions: SessionSummary[] }) {
  // Recent stopped records whose rollup has BOTH p50s (a record missing one — e.g. the tab
  // closed before the t4 flush so segment C never landed — is excluded rather than plotted as
  // a misleading 0). Oldest-first (left-to-right chronological).
  const series = useMemo<KpiDatum[]>(
    () =>
      sessions
        .filter(
          (s) =>
            !s.active &&
            s.rollup !== null &&
            s.rollup.cP50 !== null &&
            s.rollup.aP50 !== null,
        )
        .slice(0, KPI_RECORDS)
        .reverse()
        .map((s) => ({
          startedAt: s.startedAt,
          cP50: s.rollup?.cP50 as number,
          aP50: s.rollup?.aP50 as number,
        })),
    [sessions],
  );

  if (series.length < 2) return null; // need at least 2 rolled-up records for a trend
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-2">
      <p className="text-xs font-medium text-muted-foreground">
        {m.delivery_kpi_title()}
      </p>
      <KpiChart series={series} />
    </div>
  );
}

function KpiChart({ series }: { series: KpiDatum[] }) {
  if (series.length < 2) {
    return <p className="oc-admin__hint">{m.delivery_loading()}</p>;
  }
  const W = 480;
  const H = 72;
  const pad = 6;
  const cVals = series.map((s) => s.cP50);
  const aVals = series.map((s) => s.aP50);
  const max = Math.max(1, ...cVals, ...aVals);
  const x = (i: number) => pad + (i * (W - 2 * pad)) / (series.length - 1);
  const y = (v: number) => H - pad - (v * (H - 2 * pad)) / max;
  const path = (vals: number[]) =>
    vals
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ");
  const last = series[series.length - 1];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-3 text-xs text-muted-foreground">
        <span style={{ color: "var(--primary)" }}>
          {m.delivery_seg_c()} p50 {fmt(last.cP50)} {m.delivery_kpi_unit()}
        </span>
        <span>
          {m.delivery_seg_a()} p50 {fmt(last.aP50)} {m.delivery_kpi_unit()}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-16 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={m.delivery_kpi_title()}
      >
        <path
          d={path(aVals)}
          fill="none"
          style={{ stroke: "var(--muted-foreground)" }}
          strokeWidth={1.5}
        />
        <path
          d={path(cVals)}
          fill="none"
          style={{ stroke: "var(--primary)" }}
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}

// The inline detail for ONE expanded session: fetches that session's report on demand
// (so only the open row queries) and renders the skew-corrected per-segment table.
function SessionReportDetail({ sessionId }: { sessionId: string }) {
  const report = useQuery(api.deliveryTiming.getDeliveryReport, {
    sessionId,
  }) as DeliveryReport | undefined;
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    if (!report) return;
    void navigator.clipboard
      ?.writeText(reportToText(report))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        // Clipboard denied / insecure context: no feedback, no unhandled rejection.
      });
  };
  return <ReportView report={report} copied={copied} onCopy={onCopy} />;
}

function ReportView({
  report,
  copied,
  onCopy,
}: {
  report: DeliveryReport | undefined;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!report) return <p className="oc-admin__hint">{m.delivery_loading()}</p>;
  if (report.count === 0 || report.segments === null) {
    return <p className="oc-admin__hint">{m.delivery_no_samples()}</p>;
  }
  const seg = report.segments;
  const row = (label: string, s: SegStat) => (
    <tr className="border-t border-border">
      <td className="py-1">{label}</td>
      <td className="py-1 text-right tabular-nums">{s.count}</td>
      <td className="py-1 text-right tabular-nums">
        {fmt(s.p50)} / {fmt(s.p95)} / {fmt(s.max)}
      </td>
    </tr>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {report.count} {m.delivery_deltas()}
        </p>
        <Button variant="outline" size="sm" onClick={onCopy}>
          {copied ? (
            <Check size={13} aria-hidden />
          ) : (
            <Copy size={13} aria-hidden />
          )}
          {copied ? m.delivery_copied() : m.delivery_copy()}
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 font-medium">{m.delivery_col_segment()}</th>
            <th className="py-1 text-right font-medium">
              {m.delivery_col_count()}
            </th>
            <th className="py-1 text-right font-medium">
              {m.delivery_col_stats()}
            </th>
          </tr>
        </thead>
        <tbody>
          {row(m.delivery_seg_bridge(), seg.bridge)}
          {row(m.delivery_seg_a(), seg.A)}
          {row(m.delivery_seg_c(), seg.C)}
        </tbody>
      </table>
      <p className="oc-admin__hint">{m.delivery_b_note()}</p>
      {report.truncated ? (
        <p className="oc-admin__hint">{m.delivery_truncated()}</p>
      ) : null}
      <p className="oc-admin__hint">{m.delivery_report_note()}</p>
    </div>
  );
}
