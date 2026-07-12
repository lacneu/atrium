import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import {
  History,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  Zap,
} from "lucide-react";
import { api } from "../convexApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";
import { cronExprFromSchedule, describeCronExpr } from "../cronDescribe";
import { getLocale } from "@/paraglide/runtime.js";

// Settings › Scheduled — the user's scheduled gateway jobs (crons), read
// on-demand through the bridge (api.scheduled.listMyCrons) and now MANAGED
// here too: run-now / pause-resume / delete / edit (schedule + repetition +
// message) per the provider's real surface (OpenClaw = full management;
// Hermes = pause/resume + delete only). Owner-scoped: a user manages only the
// jobs of the agents they are entitled to — the server re-checks ownership on
// every action (api.scheduled.*). Jobs are still CREATED by asking the agent
// in chat (the reply shows a dedicated "Crons" section).

type CronJob = {
  id: string | null;
  name: string | null;
  enabled: boolean | null;
  schedule: string | null;
  nextRunAtMs: number | null;
  lastRunStatus: string | null;
  agentId: string;
};
type CronGroup = {
  instanceName: string;
  kind: "openclaw" | "hermes";
  supported: boolean;
  manageSupported: boolean;
  error: string | null;
  jobs: CronJob[];
};
type RunEntry = {
  ts: number | null;
  runAtMs: number | null;
  status: string | null;
  summary: string | null;
  error: string | null;
  durationMs: number | null;
  model: string | null;
};

type EditState = {
  instanceName: string;
  jobId: string;
  loading: boolean;
  name: string;
  scheduleKind: "cron" | "every" | "at";
  cronExpr: string;
  tz: string;
  everyValue: string;
  everyUnit: "minutes" | "hours" | "days";
  at: string; // datetime-local value
  message: string;
  hasMessage: boolean;
  /** Only a USER edit of the frequency fields arms this — saving a name/
   *  message-only change must not resend a schedule (an every-90s cadence
   *  would silently round to full minutes through the editor's units). */
  scheduleDirty: boolean;
  /** Same for the prompt: the editor holds a CAPPED copy (bridge MESSAGE_CAP)
   *  — resending it untouched would truncate a long prompt for good. */
  messageDirty: boolean;
  /** And the name (capped at 200 by the bridge detail): untouched -> unsent. */
  nameDirty: boolean;
};

const EVERY_UNIT_MS: Record<EditState["everyUnit"], number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

function errCode(err: unknown): string {
  return (err as { data?: { code?: string } })?.data?.code ?? "unknown";
}

export function ScheduledTab() {
  const listMyCrons = useAction(api.scheduled.listMyCrons);
  const getDetail = useAction(api.scheduled.getCronDetail);
  const listRuns = useAction(api.scheduled.listCronRuns);
  const updateCron = useAction(api.scheduled.updateCron);
  const removeCron = useAction(api.scheduled.removeCron);
  const runNow = useAction(api.scheduled.runCronNow);
  const toastApi = useToast();

  const [groups, setGroups] = useState<CronGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    instanceName: string;
    jobId: string;
    name: string;
  } | null>(null);
  const [history, setHistory] = useState<{
    name: string;
    entries: RunEntry[] | null; // null = loading
  } | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setGroups(await listMyCrons({}));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [listMyCrons]);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep-link highlight: /settings/scheduled?job=<id> (the chat's cron panel
  // links here). Scroll the row into view once the list lands.
  const highlightJob = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("job");
  }, []);
  const highlightRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (groups !== null && highlightRef.current !== null) {
      highlightRef.current.scrollIntoView({ block: "center" });
    }
  }, [groups]);

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(getLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [],
  );

  const act = async (
    jobKey: string,
    fn: () => Promise<unknown>,
    doneMsg: string,
  ) => {
    setBusyJob(jobKey);
    try {
      await fn();
      toastApi.success(doneMsg);
      await load();
    } catch (err) {
      toastApi.toast({
        variant: "error",
        title: m.cron_action_failed({ code: errCode(err) }),
      });
    } finally {
      setBusyJob(null);
    }
  };

  // Staleness guards: closing a loading dialog and opening another must not
  // let the FIRST request's completion overwrite (or close) the second.
  const historyGen = useRef(0);
  const editGen = useRef(0);
  const openHistory = async (instanceName: string, job: CronJob) => {
    if (job.id === null) return;
    const gen = ++historyGen.current;
    setHistory({ name: job.name ?? job.id, entries: null });
    try {
      const entries = (await listRuns({
        instanceName,
        jobId: job.id,
        limit: 20,
      })) as RunEntry[];
      if (gen !== historyGen.current) return;
      setHistory({ name: job.name ?? job.id, entries });
    } catch (err) {
      if (gen !== historyGen.current) return;
      setHistory(null);
      toastApi.toast({
        variant: "error",
        title: m.cron_action_failed({ code: errCode(err) }),
      });
    }
  };

  const openEdit = async (instanceName: string, job: CronJob) => {
    if (job.id === null) return;
    const gen = ++editGen.current;
    setEdit({
      instanceName,
      jobId: job.id,
      loading: true,
      name: job.name ?? "",
      scheduleKind: "cron",
      cronExpr: "",
      tz: "",
      everyValue: "1",
      everyUnit: "hours",
      at: "",
      message: "",
      hasMessage: false,
      scheduleDirty: false,
      messageDirty: false,
      nameDirty: false,
    });
    try {
      const res = (await getDetail({ instanceName, jobId: job.id })) as {
        job: {
          name: string | null;
          scheduleKind: string | null;
          scheduleExpr: string | null;
          tz: string | null;
          message: string | null;
          messageTruncated: boolean;
        };
      };
      const d = res.job;
      const kind =
        d.scheduleKind === "every" || d.scheduleKind === "at"
          ? d.scheduleKind
          : "cron";
      // Prefill the one-shot date (datetime-local wants local yyyy-MM-ddTHH:mm).
      let atLocal = "";
      if (kind === "at" && d.scheduleExpr !== null) {
        const ms = Date.parse(d.scheduleExpr);
        if (Number.isFinite(ms)) {
          const dt = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
          atLocal = dt.toISOString().slice(0, 16);
        }
      }
      let everyValue = "1";
      let everyUnit: EditState["everyUnit"] = "hours";
      if (kind === "every" && d.scheduleExpr !== null) {
        const ms = Number(d.scheduleExpr);
        if (Number.isFinite(ms) && ms > 0) {
          if (ms % EVERY_UNIT_MS.days === 0) {
            everyValue = String(ms / EVERY_UNIT_MS.days);
            everyUnit = "days";
          } else if (ms % EVERY_UNIT_MS.hours === 0) {
            everyValue = String(ms / EVERY_UNIT_MS.hours);
            everyUnit = "hours";
          } else {
            everyValue = String(Math.max(1, Math.round(ms / EVERY_UNIT_MS.minutes)));
            everyUnit = "minutes";
          }
        }
      }
      if (gen !== editGen.current) return;
      setEdit((cur) =>
        cur === null || cur.jobId !== job.id
          ? cur
          : {
              ...cur,
              loading: false,
              name: d.name ?? cur.name,
              scheduleKind: kind,
              cronExpr: kind === "cron" ? (d.scheduleExpr ?? "") : "",
              tz: d.tz ?? "",
              everyValue,
              everyUnit,
              at: atLocal,
              message: d.message ?? "",
              // A truncated prompt must not be editable here: saving the
              // capped copy would amputate it. The agent edits it in chat.
              hasMessage: d.message !== null && !d.messageTruncated,
            },
      );
    } catch (err) {
      if (gen !== editGen.current) return; // another editor took over
      setEdit(null);
      toastApi.toast({
        variant: "error",
        title: m.cron_action_failed({ code: errCode(err) }),
      });
    }
  };

  const saveEdit = async () => {
    if (edit === null) return;
    const patch: Record<string, unknown> = {};
    // A deliberately EMPTIED field is a validation error, not a silent skip —
    // the gateway requires non-empty values and "saved" without the change
    // would lie.
    if (
      (edit.nameDirty && edit.name.trim() === "") ||
      (edit.messageDirty && edit.hasMessage && edit.message.trim() === "")
    ) {
      toastApi.toast({
        variant: "error",
        title: m.cron_edit_empty_field(),
      });
      return;
    }
    if (edit.nameDirty && edit.name.trim() !== "") patch.name = edit.name.trim();
    if (!edit.scheduleDirty) {
      // untouched frequency -> never resend it (lossy unit round-trip)
    } else if (edit.scheduleKind === "cron" && edit.cronExpr.trim() !== "") {
      patch.schedule = {
        kind: "cron",
        expr: edit.cronExpr.trim(),
        ...(edit.tz.trim() !== "" ? { tz: edit.tz.trim() } : {}),
      };
    } else if (edit.scheduleKind === "every") {
      const n = Number(edit.everyValue);
      if (Number.isFinite(n) && n >= 1) {
        // Round the RESULT, not the quantity — "1.5 hours" must schedule
        // 90 minutes, not 2 hours.
        patch.schedule = {
          kind: "every",
          everyMs: Math.round(n * EVERY_UNIT_MS[edit.everyUnit]),
        };
      }
    } else if (edit.scheduleKind === "at" && edit.at !== "") {
      const ms = Date.parse(edit.at);
      if (Number.isFinite(ms)) {
        patch.schedule = { kind: "at", at: new Date(ms).toISOString() };
      }
    }
    if (edit.scheduleDirty && patch.schedule === undefined) {
      // The user touched the frequency but it does not form a valid schedule
      // (e.g. switched to "at" without picking a date) — refuse loudly rather
      // than silently saving everything BUT the schedule.
      toastApi.toast({
        variant: "error",
        title: m.cron_edit_invalid_schedule(),
      });
      return;
    }
    if (edit.messageDirty && edit.hasMessage && edit.message.trim() !== "") {
      patch.message = edit.message.trim();
    }
    if (Object.keys(patch).length === 0) {
      setEdit(null);
      return;
    }
    // A save continuation must only touch the dialog it was started from —
    // closing during the request and opening ANOTHER editor bumps the gen.
    const gen = editGen.current;
    setEditSaving(true);
    try {
      await updateCron({
        instanceName: edit.instanceName,
        jobId: edit.jobId,
        patch: patch as never,
      });
      toastApi.success(m.cron_updated_toast());
      if (gen === editGen.current) setEdit(null);
      await load();
    } catch (err) {
      toastApi.toast({
        variant: "error",
        title: m.cron_action_failed({ code: errCode(err) }),
      });
    } finally {
      setEditSaving(false);
    }
  };

  const totalJobs = groups?.reduce((n, g) => n + g.jobs.length, 0) ?? 0;

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <p className="oc-admin__hint" style={{ flex: 1, margin: 0 }}>
          {m.scheduled_description()}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <RotateCcw size={14} aria-hidden />
          {m.scheduled_refresh()}
        </Button>
      </div>

      {groups === null ? (
        <p className="oc-admin__hint" aria-busy={loading}>
          {failed ? m.scheduled_load_error() : m.common_loading()}
        </p>
      ) : (
        <>
          {failed ? (
            <p className="oc-admin__hint">{m.scheduled_load_error()}</p>
          ) : null}
          {groups.length === 0 ? (
            <p className="oc-admin__hint">{m.scheduled_empty()}</p>
          ) : null}
          {groups.map((g) => (
            <section key={g.instanceName} style={{ marginBottom: 20 }}>
              {groups.length > 1 || g.error || !g.supported ? (
                <h3
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    margin: "0 0 6px",
                  }}
                >
                  {g.instanceName}
                  <Badge variant="outline">{g.kind}</Badge>
                </h3>
              ) : null}
              {!g.supported ? (
                <p className="oc-admin__hint">{m.scheduled_unsupported()}</p>
              ) : g.error ? (
                <p className="oc-admin__hint">
                  {m.scheduled_instance_error({ code: g.error })}
                </p>
              ) : g.jobs.length === 0 ? (
                <p className="oc-admin__hint">{m.scheduled_none_here()}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{m.scheduled_col_name()}</TableHead>
                      <TableHead>{m.scheduled_col_agent()}</TableHead>
                      <TableHead>{m.scheduled_col_schedule()}</TableHead>
                      <TableHead>{m.scheduled_col_next_run()}</TableHead>
                      <TableHead>{m.scheduled_col_status()}</TableHead>
                      <TableHead>{m.scheduled_col_actions()}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.jobs.map((j, i) => {
                      const jobKey = `${g.instanceName}:${j.id ?? i}`;
                      const busy = busyJob === jobKey;
                      const canManage = g.manageSupported;
                      const full = g.kind === "openclaw" && canManage;
                      return (
                      <TableRow
                        key={j.id ?? `${g.instanceName}-${i}`}
                        ref={j.id !== null && j.id === highlightJob ? highlightRef : undefined}
                        data-state={
                          j.id !== null && j.id === highlightJob
                            ? "selected"
                            : undefined
                        }
                      >
                        <TableCell
                          className="font-medium"
                          style={{
                            maxWidth: 280,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={j.name ?? undefined}
                        >
                          {j.name ?? m.scheduled_unnamed()}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{j.agentId}</Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                            {j.schedule ?? "—"}
                          </span>
                          {(() => {
                            const expr = cronExprFromSchedule(j.schedule);
                            const plain =
                              expr !== null ? describeCronExpr(expr) : null;
                            return plain !== null ? (
                              <span
                                className="text-muted-foreground"
                                style={{ display: "block", fontSize: "0.78rem" }}
                              >
                                {plain}
                              </span>
                            ) : null;
                          })()}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {j.nextRunAtMs !== null
                            ? dateFmt.format(j.nextRunAtMs)
                            : "—"}
                        </TableCell>
                        <TableCell>
                          {j.enabled === true ? (
                            <Badge variant="secondary">
                              {m.scheduled_active()}
                            </Badge>
                          ) : j.enabled === false ? (
                            <Badge variant="outline">
                              {m.scheduled_paused()}
                            </Badge>
                          ) : (
                            // Contract drift: state unknown — never claim Active.
                            <span className="text-muted-foreground">—</span>
                          )}
                          {j.lastRunStatus ? (
                            <span
                              className="text-muted-foreground"
                              style={{ marginLeft: 8, fontSize: "0.8rem" }}
                            >
                              {j.lastRunStatus}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {j.id === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : busy ? (
                            <LoaderCircle
                              size={14}
                              className="oc-actrow__spin"
                              aria-hidden
                            />
                          ) : (
                            <span style={{ display: "inline-flex", gap: 2 }}>
                              {full ? (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  title={m.cron_action_run_now()}
                                  aria-label={m.cron_action_run_now()}
                                  disabled={busyJob !== null}
                                  onClick={() =>
                                    void act(
                                      jobKey,
                                      async () => {
                                        const r = (await runNow({
                                          instanceName: g.instanceName,
                                          jobId: j.id as string,
                                        })) as {
                                          ran: boolean | null;
                                          runId: string | null;
                                          reason: string | null;
                                        };
                                        // Same contract as the panel: explicit
                                        // ran:true or a concrete runId; else
                                        // fail closed (no false success).
                                        if (r.ran !== true && r.runId === null) {
                                          throw {
                                            data: { code: r.reason ?? "run_not_started" },
                                          };
                                        }
                                      },
                                      m.cron_run_started(),
                                    )
                                  }
                                >
                                  <Zap size={14} aria-hidden />
                                </Button>
                              ) : null}
                              {canManage && j.enabled !== null ? (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  title={
                                    j.enabled
                                      ? m.cron_action_pause()
                                      : m.cron_action_resume()
                                  }
                                  aria-label={
                                    j.enabled
                                      ? m.cron_action_pause()
                                      : m.cron_action_resume()
                                  }
                                  disabled={busyJob !== null}
                                  onClick={() =>
                                    void act(
                                      jobKey,
                                      () =>
                                        updateCron({
                                          instanceName: g.instanceName,
                                          jobId: j.id as string,
                                          patch: { enabled: !j.enabled },
                                        }),
                                      j.enabled
                                        ? m.cron_paused_toast()
                                        : m.cron_resumed_toast(),
                                    )
                                  }
                                >
                                  {j.enabled ? (
                                    <Pause size={14} aria-hidden />
                                  ) : (
                                    <Play size={14} aria-hidden />
                                  )}
                                </Button>
                              ) : null}
                              {full ? (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  title={m.cron_action_edit()}
                                  aria-label={m.cron_action_edit()}
                                  disabled={busyJob !== null}
                                  onClick={() => void openEdit(g.instanceName, j)}
                                >
                                  <Pencil size={14} aria-hidden />
                                </Button>
                              ) : null}
                              {full ? (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  title={m.cron_action_history()}
                                  aria-label={m.cron_action_history()}
                                  disabled={busyJob !== null}
                                  onClick={() =>
                                    void openHistory(g.instanceName, j)
                                  }
                                >
                                  <History size={14} aria-hidden />
                                </Button>
                              ) : null}
                              {canManage ? (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                title={m.cron_action_delete()}
                                aria-label={m.cron_action_delete()}
                                disabled={busyJob !== null}
                                onClick={() =>
                                  setConfirmDelete({
                                    instanceName: g.instanceName,
                                    jobId: j.id as string,
                                    name: j.name ?? (j.id as string),
                                  })
                                }
                              >
                                <Trash2 size={14} aria-hidden />
                              </Button>
                              ) : null}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </section>
          ))}
          {totalJobs > 0 ? (
            <p className="oc-admin__hint" style={{ marginTop: 4 }}>
              {m.scheduled_hint_manage()}
            </p>
          ) : null}
        </>
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.cron_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.cron_delete_desc({ name: confirmDelete?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.cron_delete_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (target === null) return;
                void act(
                  `${target.instanceName}:${target.jobId}`,
                  () =>
                    removeCron({
                      instanceName: target.instanceName,
                      jobId: target.jobId,
                    }),
                  m.cron_deleted_toast(),
                );
              }}
            >
              {m.cron_delete_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Run history */}
      <Dialog
        open={history !== null}
        onOpenChange={(o) => {
          if (!o) {
            // Also invalidate the in-flight load: its completion must not
            // reopen the dialog the user just closed.
            historyGen.current++;
            setHistory(null);
          }
        }}
      >
        <DialogContent style={{ maxWidth: 640 }}>
          <DialogHeader>
            <DialogTitle>
              {m.cron_history_title({ name: history?.name ?? "" })}
            </DialogTitle>
          </DialogHeader>
          {history?.entries === null ? (
            <p className="oc-admin__hint">{m.common_loading()}</p>
          ) : history !== null && history.entries.length === 0 ? (
            <p className="oc-admin__hint">{m.cron_history_empty()}</p>
          ) : history !== null ? (
            <div className="oc-cronpanel__runs" style={{ maxHeight: 420, overflowY: "auto" }}>
              {history.entries.map((r, i) => (
                <div key={i} className="oc-cronpanel__run">
                  <div className="oc-cronpanel__run-head">
                    {r.status === "ok" ? (
                      <Badge variant="secondary">{m.cron_run_ok()}</Badge>
                    ) : r.status === "error" ? (
                      <Badge variant="destructive">{m.cron_run_error()}</Badge>
                    ) : (
                      <Badge variant="outline">{r.status ?? "—"}</Badge>
                    )}
                    <span>
                      {typeof (r.runAtMs ?? r.ts) === "number"
                        ? dateFmt.format((r.runAtMs ?? r.ts) as number)
                        : "—"}
                    </span>
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
        </DialogContent>
      </Dialog>

      {/* Edit (schedule / repetition / message) */}
      <Dialog
        open={edit !== null}
        onOpenChange={(o) => {
          if (!o) {
            editGen.current++;
            setEdit(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.cron_edit_title()}</DialogTitle>
            <DialogDescription>{m.cron_edit_desc()}</DialogDescription>
          </DialogHeader>
          {edit === null ? null : edit.loading ? (
            <p className="oc-admin__hint">{m.common_loading()}</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="oc-admin__hint" style={{ margin: 0 }}>
                  {m.scheduled_col_name()}
                </span>
                <Input
                  value={edit.name}
                  maxLength={200}
                  onChange={(e) =>
                    setEdit({ ...edit, name: e.target.value, nameDirty: true })
                  }
                />
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="oc-admin__hint" style={{ margin: 0 }}>
                  {m.cron_edit_frequency()}
                </span>
                <Select
                  value={edit.scheduleKind}
                  onValueChange={(v) =>
                    setEdit({
                      ...edit,
                      scheduleKind: v as EditState["scheduleKind"],
                      scheduleDirty: true,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cron">{m.cron_kind_cron()}</SelectItem>
                    <SelectItem value="every">{m.cron_kind_every()}</SelectItem>
                    <SelectItem value="at">{m.cron_kind_at()}</SelectItem>
                  </SelectContent>
                </Select>
                {edit.scheduleKind === "cron" ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <Input
                      value={edit.cronExpr}
                      onChange={(e) =>
                        setEdit({ ...edit, cronExpr: e.target.value, scheduleDirty: true })
                      }
                      placeholder="30 9 * * *"
                      style={{ fontFamily: "var(--font-mono, monospace)" }}
                    />
                    <Input
                      value={edit.tz}
                      onChange={(e) =>
                        setEdit({ ...edit, tz: e.target.value, scheduleDirty: true })
                      }
                      placeholder="America/Toronto"
                      style={{ maxWidth: 180 }}
                    />
                  </div>
                ) : edit.scheduleKind === "every" ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <Input
                      type="number"
                      min={1}
                      value={edit.everyValue}
                      onChange={(e) =>
                        setEdit({ ...edit, everyValue: e.target.value, scheduleDirty: true })
                      }
                      style={{ maxWidth: 120 }}
                    />
                    <Select
                      value={edit.everyUnit}
                      onValueChange={(v) =>
                        setEdit({
                          ...edit,
                          everyUnit: v as EditState["everyUnit"],
                          scheduleDirty: true,
                        })
                      }
                    >
                      <SelectTrigger style={{ maxWidth: 160 }}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minutes">{m.cron_unit_minutes()}</SelectItem>
                        <SelectItem value="hours">{m.cron_unit_hours()}</SelectItem>
                        <SelectItem value="days">{m.cron_unit_days()}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <Input
                    type="datetime-local"
                    value={edit.at}
                    onChange={(e) =>
                      setEdit({ ...edit, at: e.target.value, scheduleDirty: true })
                    }
                  />
                )}
              </div>
              {edit.hasMessage ? (
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="oc-admin__hint" style={{ margin: 0 }}>
                    {m.cron_field_message()}
                  </span>
                  <textarea
                    className="oc-cronedit__textarea"
                    rows={4}
                    value={edit.message}
                    onChange={(e) =>
                      setEdit({ ...edit, message: e.target.value, messageDirty: true })
                    }
                  />
                </label>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              {m.cron_delete_cancel()}
            </Button>
            <Button
              onClick={() => void saveEdit()}
              disabled={edit === null || edit.loading || editSaving}
            >
              {editSaving ? (
                <LoaderCircle size={14} className="oc-actrow__spin" aria-hidden />
              ) : null}
              {m.cron_edit_save()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
