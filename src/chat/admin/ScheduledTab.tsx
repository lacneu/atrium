import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction } from "convex/react";
import { RotateCcw } from "lucide-react";
import { api } from "../convexApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

// Settings › Scheduled — the user's scheduled gateway jobs (crons), read
// on-demand through the bridge (api.scheduled.listMyCrons). Owner-scoped: a
// user sees the jobs of the agents they are entitled to; a job without an
// explicit agent resolves to the instance's default agent. READ-ONLY — jobs
// are created/managed by asking the agent in chat (the cron tool call is
// visible in the reply), this tab only lists them.

type CronGroup = {
  instanceName: string;
  kind: "openclaw" | "hermes";
  supported: boolean;
  error: string | null;
  jobs: {
    id: string | null;
    name: string | null;
    enabled: boolean | null;
    schedule: string | null;
    nextRunAtMs: number | null;
    lastRunStatus: string | null;
    agentId: string;
  }[];
};

export function ScheduledTab() {
  const listMyCrons = useAction(api.scheduled.listMyCrons);
  const [groups, setGroups] = useState<CronGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

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

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(getLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [],
  );

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
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.jobs.map((j, i) => (
                      <TableRow key={j.id ?? `${g.instanceName}-${i}`}>
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
                        <TableCell
                          className="whitespace-nowrap"
                          style={{ fontFamily: "var(--font-mono, monospace)" }}
                        >
                          {j.schedule ?? "—"}
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
                      </TableRow>
                    ))}
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
    </>
  );
}
