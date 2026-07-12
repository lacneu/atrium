// Right-column DETAIL of one scheduled job (opened from a message's "Crons"
// section). Fetches the LIVE job from its gateway (api.scheduled.getCronDetail)
// so the user sees the job's current truth — not the turn-time snapshot — and
// can act immediately: run now, pause/resume, delete, and jump to Settings >
// Scheduled for full editing (schedule/repetition/message). A REMOVED job (or
// one deleted since) renders the message-time snapshot with an honest notice.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { Link } from "@tanstack/react-router";
import {
  CalendarClock,
  ExternalLink,
  LoaderCircle,
  Pause,
  Play,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import { m } from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/toast";
import { getLocale } from "@/paraglide/runtime.js";
import type { CronPartView } from "./convexTypes";
import { cronExprFromSchedule, describeCronExpr } from "./cronDescribe";
import { opLabel } from "./CronActivity";

interface CronJobDetailView {
  id: string | null;
  name: string | null;
  enabled: boolean | null;
  schedule: string | null;
  message: string | null;
  deliveryMode: string | null;
  agentId: string | null;
  nextRunAtMs: number | null;
  lastRunStatus: string | null;
  updatedAtMs: number | null;
}
interface CronRunEntryView {
  ts: number | null;
  runAtMs: number | null;
  status: string | null;
  summary: string | null;
  error: string | null;
  durationMs: number | null;
  model: string | null;
}
interface CronCaps {
  canEdit: boolean;
  canRunNow: boolean;
  canHistory: boolean;
  canToggle: boolean;
  canDelete: boolean;
}

function fmtDate(ms: number | null | undefined): string {
  if (typeof ms !== "number") return "—";
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(ms);
}

function runStatusBadge(status: string | null) {
  if (status === "ok")
    return <Badge variant="secondary">{m.cron_run_ok()}</Badge>;
  if (status === "error")
    return <Badge variant="destructive">{m.cron_run_error()}</Badge>;
  if (status === "skipped")
    return <Badge variant="outline">{m.cron_run_skipped()}</Badge>;
  return <Badge variant="outline">{status ?? "—"}</Badge>;
}

export function CronDetailContent({
  instanceName,
  part,
  onClose,
  onChanged,
}: {
  instanceName: string;
  part: CronPartView;
  onClose: () => void;
  /** Called after a mutation (toggle/delete/run) so list views can refresh. */
  onChanged?: () => void;
}) {
  const getDetail = useAction(api.scheduled.getCronDetail);
  const listRuns = useAction(api.scheduled.listCronRuns);
  const updateCron = useAction(api.scheduled.updateCron);
  const removeCron = useAction(api.scheduled.removeCron);
  const runNow = useAction(api.scheduled.runCronNow);
  const toastApi = useToast();

  const jobId = part.jobId ?? null;
  const [detail, setDetail] = useState<CronJobDetailView | null>(null);
  const [caps, setCaps] = useState<CronCaps | null>(null);
  const [runs, setRuns] = useState<CronRunEntryView[] | null>(null);
  const [loadState, setLoadState] = useState<
    "loading" | "ready" | "gone" | "error"
  >("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Generation guard: switching quickly between crons leaves the previous
  // target's fetch in flight — a late response must never overwrite the new
  // target's state (its actions read `shown.enabled` and would flip the WRONG
  // job). Every refresh stamps a generation; stale completions are dropped,
  // and each new target starts from a CLEAN slate (no leftover detail/runs).
  const genRef = useRef(0);
  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    setDetail(null);
    setCaps(null);
    setRuns(null);
    if (jobId === null || part.op === "removed") {
      setLoadState(part.op === "removed" ? "gone" : "error");
      return;
    }
    setLoadState("loading");
    try {
      const res = (await getDetail({ instanceName, jobId })) as {
        job: CronJobDetailView;
        capabilities: CronCaps;
      };
      if (gen !== genRef.current) return; // a newer target took over
      setDetail(res.job);
      setCaps(res.capabilities);
      setLoadState("ready");
      if (res.capabilities.canHistory) {
        try {
          const entries = (await listRuns({
            instanceName,
            jobId,
            limit: 5,
          })) as CronRunEntryView[];
          if (gen !== genRef.current) return;
          setRuns(entries);
        } catch {
          if (gen === genRef.current) setRuns(null); // history is optional
        }
      }
    } catch (err) {
      if (gen !== genRef.current) return;
      const code = (err as { data?: { code?: string } })?.data?.code;
      setLoadState(code === "not_found" ? "gone" : "error");
    }
  }, [getDetail, listRuns, instanceName, jobId, part.op]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A continuation from an action started on a PREVIOUS target must not
  // refresh (its closure would fetch the old job and overwrite the new
  // panel's state through the shared generation counter).
  const targetKeyRef = useRef("");
  useEffect(() => {
    targetKeyRef.current = `${instanceName}:${jobId ?? ""}`;
    // A busy flag armed by the PREVIOUS target would keep the new target's
    // buttons disabled forever (its own finally refuses to clear it).
    setBusy(null);
  }, [instanceName, jobId]);
  const act = async (
    label: string,
    fn: () => Promise<unknown>,
    doneMsg: string,
  ) => {
    const startedFor = `${instanceName}:${jobId ?? ""}`;
    setBusy(label);
    try {
      await fn();
      if (targetKeyRef.current !== startedFor) return; // panel moved on
      toastApi.success(doneMsg);
      onChanged?.();
      await refresh();
    } catch (err) {
      const code =
        (err as { data?: { code?: string } })?.data?.code ?? "unknown";
      toastApi.toast({
        variant: "error",
        title: m.cron_action_failed({ code }),
      });
    } finally {
      // Only the action that ARMED the busy state may clear it — a stale
      // continuation from a previous target must not re-enable the new
      // target's buttons mid-mutation (double-run/mutate hazard).
      if (targetKeyRef.current === startedFor) {
        setBusy((cur) => (cur === label ? null : cur));
      }
    }
  };

  const shown = detail ?? {
    id: jobId,
    name: part.name ?? null,
    enabled: part.enabled ?? null,
    schedule: part.schedule ?? null,
    message: part.message ?? null,
    deliveryMode: part.deliveryMode ?? null,
    agentId: part.agentId ?? null,
    nextRunAtMs: part.nextRunAtMs ?? null,
    lastRunStatus: null,
    updatedAtMs: null,
  };

  return (
    <div className="oc-cronpanel">
      <div className="oc-cronpanel__head">
        <CalendarClock size={16} aria-hidden />
        <span className="oc-cronpanel__title" title={shown.name ?? undefined}>
          {shown.name ?? m.cron_unnamed()}
        </span>
        <Badge variant="outline">{opLabel(part.op)}</Badge>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={m.cron_panel_close()}
        >
          <X aria-hidden />
        </Button>
      </div>

      {loadState === "loading" ? (
        <div className="oc-cronpanel__loading">
          <LoaderCircle size={16} className="oc-actrow__spin" aria-hidden />
          {m.cron_panel_loading()}
        </div>
      ) : null}
      {loadState === "gone" ? (
        <div className="oc-cronpanel__notice">{m.cron_panel_gone()}</div>
      ) : null}
      {loadState === "error" ? (
        <div className="oc-cronpanel__notice">{m.cron_panel_load_error()}</div>
      ) : null}

      <dl className="oc-cronpanel__facts">
        <dt>{m.cron_field_status()}</dt>
        <dd>
          {shown.enabled === true ? (
            <Badge variant="secondary">{m.scheduled_active()}</Badge>
          ) : shown.enabled === false ? (
            <Badge variant="outline">{m.scheduled_paused()}</Badge>
          ) : (
            "—"
          )}
        </dd>
        <dt>{m.cron_field_schedule()}</dt>
        <dd>
          <span className="oc-cronpanel__mono">{shown.schedule ?? "—"}</span>
          {(() => {
            // Plain-language translation of the cron syntax (fail-soft: only
            // the covered common shapes; the raw expression always stays).
            const expr = cronExprFromSchedule(shown.schedule);
            const plain = expr !== null ? describeCronExpr(expr) : null;
            return plain !== null ? (
              <span className="oc-cronpanel__plain">{plain}</span>
            ) : null;
          })()}
        </dd>
        <dt>{m.cron_field_next_run()}</dt>
        <dd>{fmtDate(shown.nextRunAtMs)}</dd>
        <dt>{m.cron_field_agent()}</dt>
        <dd>{shown.agentId ?? "—"}</dd>
        {shown.deliveryMode !== null ? (
          <>
            <dt>{m.cron_field_delivery()}</dt>
            <dd>{shown.deliveryMode}</dd>
          </>
        ) : null}
      </dl>

      {shown.message !== null ? (
        <div className="oc-cronpanel__message">
          <div className="oc-cronpanel__message-label">
            {m.cron_field_message()}
          </div>
          <div className="oc-cronpanel__message-body">{shown.message}</div>
        </div>
      ) : null}

      {loadState === "ready" && caps !== null && jobId !== null ? (
        <div className="oc-cronpanel__actions">
          {caps.canRunNow ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act(
                  "run",
                  async () => {
                    const r = (await runNow({ instanceName, jobId })) as {
                      ran: boolean | null;
                      runId: string | null;
                      reason: string | null;
                    };
                    // Success = an explicit ran:true OR a concrete runId (the
                    // live 2026.7.1 gateway acks a forced run with runId and
                    // NO ran flag). Anything else fails closed — never toast
                    // a false "started" on a partial/drifted response.
                    if (r.ran !== true && r.runId === null) {
                      throw { data: { code: r.reason ?? "run_not_started" } };
                    }
                  },
                  m.cron_run_started(),
                )
              }
            >
              {busy === "run" ? (
                <LoaderCircle size={14} className="oc-actrow__spin" aria-hidden />
              ) : (
                <Zap size={14} aria-hidden />
              )}
              {m.cron_action_run_now()}
            </Button>
          ) : null}
          {caps.canToggle && shown.enabled !== null ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act(
                  "toggle",
                  () =>
                    updateCron({
                      instanceName,
                      jobId,
                      patch: { enabled: !(shown.enabled ?? false) },
                    }),
                  shown.enabled === true
                    ? m.cron_paused_toast()
                    : m.cron_resumed_toast(),
                )
              }
            >
              {shown.enabled === true ? (
                <Pause size={14} aria-hidden />
              ) : (
                <Play size={14} aria-hidden />
              )}
              {shown.enabled === true
                ? m.cron_action_pause()
                : m.cron_action_resume()}
            </Button>
          ) : null}
          {caps.canDelete ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={14} aria-hidden />
              {m.cron_action_delete()}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" asChild>
            <Link
              to="/settings/$tab"
              params={{ tab: "scheduled" }}
              search={jobId !== null ? { job: jobId } : undefined}
            >
              <ExternalLink size={14} aria-hidden />
              {m.cron_action_manage()}
            </Link>
          </Button>
        </div>
      ) : null}

      {runs !== null && runs.length > 0 ? (
        <div className="oc-cronpanel__runs">
          <div className="oc-cronpanel__runs-label">{m.cron_runs_recent()}</div>
          {runs.map((r, i) => (
            <div key={i} className="oc-cronpanel__run">
              <div className="oc-cronpanel__run-head">
                {runStatusBadge(r.status)}
                <span>{fmtDate(r.runAtMs ?? r.ts)}</span>
                {typeof r.durationMs === "number" ? (
                  <span className="oc-cronpanel__run-dur">
                    {Math.round(r.durationMs / 1000)}s
                  </span>
                ) : null}
              </div>
              {r.summary !== null ? (
                <div className="oc-cronpanel__run-summary">{r.summary}</div>
              ) : null}
              {r.error !== null ? (
                <div className="oc-cronpanel__run-error">{r.error}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.cron_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.cron_delete_desc({ name: shown.name ?? jobId ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.cron_delete_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (jobId === null) return;
                void act(
                  "delete",
                  () => removeCron({ instanceName, jobId }),
                  m.cron_deleted_toast(),
                );
              }}
            >
              {m.cron_delete_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
