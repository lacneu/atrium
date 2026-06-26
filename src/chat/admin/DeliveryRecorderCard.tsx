import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { APP_HOST } from "@/lib/appHost";
import { api } from "../convexApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";

// Settings▸Traces card driving the delivery-latency recorder (convex/deliveryTiming.ts):
// admins start/stop a recording; anyone with traces.read sees the skew-corrected
// per-segment report (A=bridge→Convex, B=Convex exec, C=Convex→frontend). Content-free.

type SegStat = {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
};
type Report = {
  sessionId: string | null;
  count: number;
  segments: { A: SegStat; B: SegStat; C: SegStat } | null;
};
type Status = {
  recording: boolean;
  sessionId: string | null;
  startedAt: number | null;
  autoStopAt: number | null;
};

const fmt = (n: number | null): string =>
  n === null ? "—" : String(Math.round(n));

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
  const report = useQuery(
    api.deliveryTiming.getDeliveryReport,
    showReport ? {} : "skip",
  ) as Report | undefined;
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
                time: new Date(status.startedAt).toLocaleTimeString("fr-FR"),
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
          {showReport ? m.delivery_hide_report() : m.delivery_show_report()}
        </Button>
      </div>

      {showReport ? <ReportView report={report} /> : null}
    </section>
  );
}

function ReportView({ report }: { report: Report | undefined }) {
  if (!report) return null;
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
    <>
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
          {row(m.delivery_seg_a(), seg.A)}
          {row(m.delivery_seg_b(), seg.B)}
          {row(m.delivery_seg_c(), seg.C)}
        </tbody>
      </table>
      <p className="oc-admin__hint">{m.delivery_report_note()}</p>
    </>
  );
}
