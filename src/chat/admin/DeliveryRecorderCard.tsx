import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, Copy } from "lucide-react";
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
import { m } from "@/paraglide/messages.js";

// Settings▸Traces card driving the delivery-latency recorder (convex/deliveryTiming.ts):
// admins start/stop a recording and delete sessions; anyone with traces.read browses
// the recorded sessions + the skew-corrected per-segment report (A=bridge→Convex,
// B=Convex exec, C=Convex→frontend) and can copy it. Content-free.

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
  const deleteSessions = useMutation(api.deliveryTiming.deleteDeliverySessions);

  const [showReport, setShowReport] = useState(false);
  // null = the active (or most recent) session.
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const sessions = useQuery(
    api.deliveryTiming.listDeliverySessions,
    showReport ? {} : "skip",
  ) as SessionSummary[] | undefined;
  const report = useQuery(
    api.deliveryTiming.getDeliveryReport,
    showReport ? { sessionId: selected ?? undefined } : "skip",
  ) as DeliveryReport | undefined;

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

  const copyReport = () => {
    if (!report) return;
    void navigator.clipboard?.writeText(reportToText(report)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const toggleCheck = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const deleteSelected = async () => {
    const ids = [...checked];
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await deleteSessions({ sessionIds: ids });
      if (selected !== null && checked.has(selected)) setSelected(null);
      setChecked(new Set());
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

      {showReport ? (
        <>
          <SessionList
            sessions={sessions}
            selected={selected}
            checked={checked}
            isAdmin={isAdmin}
            onSelect={setSelected}
            onToggleCheck={toggleCheck}
          />
          {isAdmin && checked.size > 0 ? (
            <div>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void deleteSelected()}
              >
                {m.delivery_delete_selected({ n: checked.size })}
              </Button>
            </div>
          ) : null}
          <ReportView report={report} copied={copied} onCopy={copyReport} />
        </>
      ) : null}
    </section>
  );
}

function SessionList({
  sessions,
  selected,
  checked,
  isAdmin,
  onSelect,
  onToggleCheck,
}: {
  sessions: SessionSummary[] | undefined;
  selected: string | null;
  checked: Set<string>;
  isAdmin: boolean;
  onSelect: (id: string | null) => void;
  onToggleCheck: (id: string) => void;
}) {
  if (!sessions) return null;
  if (sessions.length === 0) {
    return <p className="oc-admin__hint">{m.delivery_no_sessions()}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">
        {m.delivery_sessions_header()}
      </p>
      <ul className="flex flex-col">
        {sessions.map((s) => {
          const isSel = selected === s.sessionId;
          return (
            <li
              key={s.sessionId}
              className="flex items-center gap-2 border-t border-border py-1 text-sm first:border-t-0"
            >
              {isAdmin ? (
                <input
                  type="checkbox"
                  aria-label={m.delivery_select_session()}
                  checked={checked.has(s.sessionId)}
                  onChange={() => onToggleCheck(s.sessionId)}
                />
              ) : null}
              <button
                type="button"
                className={`flex-1 truncate text-left ${isSel ? "font-medium" : "text-muted-foreground"}`}
                onClick={() => onSelect(isSel ? null : s.sessionId)}
              >
                {new Date(s.startedAt).toLocaleString("fr-FR")}
              </button>
              {s.active ? (
                <Badge variant="secondary">{m.delivery_badge_active()}</Badge>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
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
          {row(m.delivery_seg_a(), seg.A)}
          {row(m.delivery_seg_b(), seg.B)}
          {row(m.delivery_seg_c(), seg.C)}
        </tbody>
      </table>
      <p className="oc-admin__hint">{m.delivery_report_note()}</p>
    </>
  );
}
