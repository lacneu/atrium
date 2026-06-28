import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../convexApi";
import { APP_HOST } from "@/lib/appHost";
import type { SessionSummary } from "../deliveryRecorder";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { m } from "@/paraglide/messages.js";

// Evolution KPI for the delivery-latency recorder: segment C + A p50 across the recent
// recordings, read from each recording's stored `rollup`. Lives in the KPI tab (it's a
// dashboard metric, not a recorder control). Self-contained: queries listDeliverySessions
// and plots the trend. See convex/deliveryTiming.ts + the recorder in TracesTab.
const KPI_RECORDS = 15;

type KpiDatum = { startedAt: number; cP50: number; aP50: number };

const fmt = (n: number): string => String(Math.round(n));

export function DeliveryKpiCard() {
  // `listDeliverySessions` requires `traces.read` server-side, but this card lives in the KPI
  // tab (accessible with only `kpi.read`). Gate the query on the effective permission so a
  // `kpi.read`-only user never fires an unauthorized query that would break the KPI tab; the
  // card simply doesn't render for them (sessions stays undefined -> null below).
  const me = useQuery(api.me.getMe, { host: APP_HOST }) as
    | { permissions?: string[] }
    | undefined;
  const canReadTraces = me?.permissions?.includes("traces.read") ?? false;
  const sessions = useQuery(
    api.deliveryTiming.listDeliverySessions,
    canReadTraces ? {} : "skip",
  ) as SessionSummary[] | undefined;

  // Recent stopped recordings whose rollup has BOTH p50s (a record missing one is excluded
  // rather than plotted as a misleading 0). Oldest-first (left-to-right chronological).
  const series = useMemo<KpiDatum[]>(() => {
    if (!sessions) return [];
    return sessions
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
      }));
  }, [sessions]);

  // Don't render an empty card while the query is loading.
  if (sessions === undefined) return null;

  return (
    <section className="oc-kpi__group">
      <h2 className="oc-kpi__group-title">{m.delivery_title()}</h2>
      <Card>
        <CardHeader>
          <CardTitle>{m.delivery_kpi_title()}</CardTitle>
          <CardDescription>{m.delivery_kpi_desc()}</CardDescription>
        </CardHeader>
        <CardContent>
          {series.length < 2 ? (
            <p className="oc-admin__hint">{m.delivery_kpi_empty()}</p>
          ) : (
            <KpiChart series={series} />
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function KpiChart({ series }: { series: KpiDatum[] }) {
  const W = 480;
  const H = 80;
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
        className="h-20 w-full"
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
