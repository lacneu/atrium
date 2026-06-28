import { useMemo } from "react";
import { useQuery } from "convex/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import {
  TimeRangePicker,
  useResolvedRange,
} from "./filters/TimeRangePicker";
import type { TimeRange } from "./filters/types";
import {
  decodeRange,
  encodeRange,
  KPI_DEFAULT_FROM,
  DEFAULT_TO,
} from "@/lib/routing/searchSchemas";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DeliveryKpiCard } from "./DeliveryKpiCard";
import { m } from "@/paraglide/messages.js";

// "KPI" tab — the observability dashboard (increment 4). Reads
// api.kpi.listKpis, an admin query returning the SMALL, long-lived per-hour
// rollups (newest bucket first). All visualization is hand-rolled SVG/CSS over
// that bounded data — no chart dependency (the hourly buckets are tiny).
//
// Two non-obvious points:
//  - `listKpis`' `limit` counts ROWS, not buckets, and the rollup writes ALL
//    metrics for EVERY bucket. So the selected time range is translated to a row
//    limit = (hours in range) * (metric count). See `rangeToLimits` below.
//  - The flat {bucket, metric, value} rows are pivoted client-side into one
//    ascending-by-bucket series per metric (ISO hour strings sort
//    lexicographically == chronologically, so a string sort is correct).

type KpiRollupView = {
  _id: Id<"kpiRollups">;
  bucket: string;
  metric: string;
  value: number;
  dims: string | null;
};

// Metric → display config. Single source of truth for label, unit hint, group
// and the error-color flag. Drives card order and chart styling; mirrors the
// KPI_METRICS contract in convex/kpi.ts. Any metric the backend returns that is
// absent here is dropped from the dashboard (forward-compatible).
type MetricGroup = "API" | "OpenClaw" | "Chat" | "Assistant";
type MetricConfig = {
  metric: string;
  label: string;
  unit: string;
  group: MetricGroup;
  isError: boolean;
};

const METRIC_CONFIG: MetricConfig[] = [
  { metric: "api.calls", label: m.kpi_metric_api_calls(), unit: "/h", group: "API", isError: false },
  { metric: "api.errors", label: m.kpi_metric_api_errors(), unit: "/h", group: "API", isError: true },
  {
    metric: "api.latency.avg_ms",
    label: m.kpi_metric_api_latency(),
    unit: "ms",
    group: "API",
    isError: false,
  },
  {
    metric: "openclaw.ingest",
    label: m.kpi_metric_openclaw_ingest(),
    unit: "/h",
    group: "OpenClaw",
    isError: false,
  },
  { metric: "chat.send", label: m.kpi_metric_chat_send(), unit: "/h", group: "Chat", isError: false },
  {
    metric: "assistant.stream.errors",
    label: m.kpi_metric_stream_errors(),
    unit: "/h",
    group: "Assistant",
    isError: true,
  },
];

// Number of distinct metrics the rollup writes per bucket. limit (rows) for the
// backend = wanted buckets * this. Kept in sync with METRIC_CONFIG.
const METRIC_COUNT = METRIC_CONFIG.length;

// Group render order.
const GROUP_ORDER: MetricGroup[] = ["API", "OpenClaw", "Chat", "Assistant"];

// Backend row cap (MAX_LIST_LIMIT in convex/kpi.ts). `limit` counts ROWS, not
// buckets, and the rollup writes one row per metric per bucket — so the row
// budget caps how many hour-buckets we can actually pull back.
const MAX_ROW_LIMIT = 1000;
const MS_PER_HOUR = 3_600_000;

// Default window: live "last 24h" (KPI_DEFAULT_FROM in searchSchemas).
// Re-resolves to NOW via useResolvedRange.

// Derive a backend ROW limit + a bucket count from a resolved ms range. The
// number of hour buckets spanned drives the row limit (× metric count); both
// are clamped to the backend cap so a 90-day window stays bounded (the oldest
// buckets come back partial — cosmetic on the chart).
function rangeToLimits(from: number, to: number): {
  rowLimit: number;
  buckets: number;
} {
  const hours = Math.max(1, Math.ceil((to - from) / MS_PER_HOUR));
  const rowLimit = Math.min(hours * METRIC_COUNT, MAX_ROW_LIMIT);
  // How many buckets the row budget can actually represent (used to clip the
  // pivoted series so a partial over/under-fetch never stretches the x-axis).
  const buckets = Math.max(1, Math.floor(rowLimit / METRIC_COUNT));
  return { rowLimit, buckets };
}

type Point = { bucket: string; value: number };

export function KpiTab() {
  const search = useSearch({ from: "/settings/kpi" });
  const navigate = useNavigate({ from: "/settings/kpi" });
  // URL stores time-range TOKENS; resolve to live epoch ms at component level.
  // KPI's default window is the tighter live "last 24h".
  const range = decodeRange(search.from, search.to, KPI_DEFAULT_FROM, DEFAULT_TO);
  const setRange = (r: TimeRange) =>
    void navigate({ search: (p) => ({ ...p, ...encodeRange(r) }) });
  const { from, to } = useResolvedRange(range);
  const { rowLimit, buckets } = rangeToLimits(from, to);

  const rollups = useQuery(api.kpi.listKpis, {
    limit: rowLimit,
    filter: { from, to },
  }) as KpiRollupView[] | undefined;

  // Pivot the flat rows into one ascending-by-bucket series per metric. Sorting
  // bucket strings ascending == chronological (ISO hour strings). The series is
  // also clipped to the wanted bucket count so a small over-fetch (when filtered
  // by row limit) does not stretch the chart x-axis.
  const seriesByMetric = useMemo(() => {
    const map = new Map<string, Point[]>();
    for (const r of rollups ?? []) {
      const list = map.get(r.metric) ?? [];
      list.push({ bucket: r.bucket, value: r.value });
      map.set(r.metric, list);
    }
    for (const [metric, list] of map) {
      list.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
      // Keep only the most recent `buckets` points (the tail after asc sort).
      if (list.length > buckets) map.set(metric, list.slice(list.length - buckets));
    }
    return map;
  }, [rollups, buckets]);

  // Keep the toolbar mounted across loading/empty/data states: Convex returns
  // undefined while args change (e.g. switching the window), so an early return
  // without the toolbar would make the selector flicker away mid-interaction.
  const header = (
    <>
      <p className="oc-admin__hint">
        {m.kpi_header_hint()}{" "}
        <span className="oc-filter__window">
          {m.kpi_header_range_note()}
        </span>
      </p>
      <Toolbar value={range} onChange={setRange} />
    </>
  );

  // The delivery KPI card queries its OWN sessions independently of the general rollups, so
  // render it in every branch — otherwise a loading/empty general KPI would hide a delivery
  // trend that actually has data (codex P2). It self-empties when there is nothing to show.
  if (rollups === undefined) {
    return (
      <>
        {header}
        <DeliveryKpiCard />
        <p className="oc-admin__hint">{m.kpi_loading()}</p>
      </>
    );
  }

  if (rollups.length === 0) {
    return (
      <>
        {header}
        <DeliveryKpiCard />
        <p className="oc-admin__hint">{m.kpi_empty()}</p>
      </>
    );
  }

  return (
    <>
      {header}

      <DeliveryKpiCard />

      {GROUP_ORDER.map((group) => {
        const configs = METRIC_CONFIG.filter((c) => c.group === group);
        // Skip a group entirely if none of its metrics have any data yet.
        const hasAny = configs.some((c) => (seriesByMetric.get(c.metric) ?? []).length > 0);
        if (!hasAny) return null;
        return (
          <section key={group} className="oc-kpi__group">
            <h2 className="oc-kpi__group-title">{group}</h2>
            <div className="oc-kpi__grid">
              {configs.map((cfg) => (
                <MetricCard
                  key={cfg.metric}
                  config={cfg}
                  series={seriesByMetric.get(cfg.metric) ?? []}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function Toolbar({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (v: TimeRange) => void;
}) {
  return (
    <div className="oc-kpi__toolbar">
      <TimeRangePicker value={value} onChange={onChange} />
    </div>
  );
}

function MetricCard({
  config,
  series,
}: {
  config: MetricConfig;
  series: Point[];
}) {
  // Latest bucket value = last point after ascending sort.
  const latest = series.length > 0 ? series[series.length - 1] : null;
  const latestValue = latest ? latest.value : 0;

  return (
    <Card size="sm" className="oc-kpi__card">
      <CardHeader>
        <CardTitle className="oc-kpi__card-title">{config.label}</CardTitle>
        <CardDescription className="oc-kpi__card-metric">
          <code>{config.metric}</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="oc-kpi__card-body">
        <div className="oc-kpi__value-row">
          <span
            className={
              "oc-kpi__value" + (config.isError && latestValue > 0 ? " oc-kpi__value--error" : "")
            }
          >
            {formatValue(latestValue)}
          </span>
          <span className="oc-kpi__unit">{config.unit}</span>
        </div>
        <BarChart series={series} isError={config.isError} unit={config.unit} />
        <div className="oc-kpi__axis">
          {latest ? (
            <span className="oc-kpi__axis-latest">
              {m.kpi_axis_latest({ value: bucketLabel(latest.bucket) })}
            </span>
          ) : (
            <span className="oc-kpi__muted">{m.kpi_no_data()}</span>
          )}
          <span className="oc-kpi__muted">{m.kpi_hours_count({ count: series.length })}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// Hand-rolled SVG bar chart over the recent buckets. x = hour bucket, y = value.
// Fixed viewBox; bars scale to the series max. A <title> on each bar gives a
// native hover tooltip. All-zero / single / empty series are guarded so the
// math never divides by zero or produces NaN heights.
const CHART_W = 240;
const CHART_H = 48;
const BAR_GAP = 1;

function BarChart({
  series,
  isError,
  unit,
}: {
  series: Point[];
  isError: boolean;
  unit: string;
}) {
  if (series.length === 0) {
    return <div className="oc-kpi__chart oc-kpi__chart--empty" aria-hidden />;
  }

  const max = series.reduce((m, p) => (p.value > m ? p.value : m), 0);
  const n = series.length;
  const slot = CHART_W / n;
  const barWidth = Math.max(slot - BAR_GAP, 1);

  return (
    <svg
      className="oc-kpi__chart"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={m.kpi_chart_aria({ max: formatValue(max), unit })}
    >
      {series.map((p, i) => {
        // Guard max === 0 (all-zero series): height stays 0, no NaN.
        const h = max > 0 ? (p.value / max) * (CHART_H - 1) : 0;
        const x = i * slot;
        const y = CHART_H - h;
        return (
          <rect
            key={p.bucket}
            className={
              "oc-kpi__bar" + (isError && p.value > 0 ? " oc-kpi__bar--error" : "")
            }
            x={x}
            y={y}
            width={barWidth}
            height={h}
          >
            <title>
              {bucketLabel(p.bucket)} · {formatValue(p.value)} {unit}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

// Compact numbers for the big card value (1.2k etc.); plain integers stay plain.
function formatValue(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (Math.abs(v) >= 1000) {
    return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + "k";
  }
  return String(v);
}

// "2026-06-02T14" -> "02/06 14h" (UTC). The bucket keys are UTC hour strings, so
// we append a full time + Z to make a valid ISO instant and read it back with
// UTC getters (L6) — local getters would shift the label (e.g. ...T14 -> 16h in
// UTC+2) and could even show the wrong calendar day for a late-night bucket.
function bucketLabel(bucket: string): string {
  const d = new Date(`${bucket}:00:00Z`);
  if (Number.isNaN(d.getTime())) return bucket;
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  return `${day}/${month} ${hour}h`;
}
