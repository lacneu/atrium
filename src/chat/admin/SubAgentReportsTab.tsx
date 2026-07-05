import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "./DataTableShell";
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages.js";

// Admin administration of USER reports on sub-agent failures (Settings ›
// Rapports sous-agents). SPLIT BY SENSITIVITY, identical to FeedbacksTab:
//   - the table shows METADATA only (category, who, when, counts) → unaudited.
//   - opening a row's DETAIL calls `readReport`, a MUTATION gated by
//     `traces.read.content` that AUDITS the cross-user content access — so every
//     time an admin views a frozen snapshot (the raw sub-agent error text), it is
//     traced. The CONTENT-FREE counterpart of each report is in the Anomalies tab
//     (source:"user", kind:"subagent.failure").

type Row = {
  _id: string;
  at: number;
  category: string | null;
  hasComment: boolean;
  totalCount: number;
  failedCount: number;
  impersonated: boolean;
  answered: boolean;
  reporterEmail: string | null;
  reporterName: string | null;
  realOperatorEmail: string | null;
  chatId: string;
  subAgentId: string;
  correlationId: string | null;
  anomalyId: string | null;
};

type ThreadMsg = { authorRole: "admin" | "user"; text: string; at: number };

type Child = {
  childSessionKey: string;
  taskName?: string;
  status: string;
  errorMessage?: string;
  resultText?: string;
  phase?: string;
  createdAt: number;
  updatedAt: number;
};

type Detail = {
  _id: string;
  at: number;
  category: string | null;
  comment: string | null;
  chatId: string;
  correlationId: string | null;
  thread: ThreadMsg[];
  snapshot: {
    flaggedChildSessionKey: string;
    totalCount: number;
    failedCount: number;
    children: Child[];
    childrenTruncated?: boolean;
    textTruncated?: boolean;
    parentMessageRole?: string;
    parentText?: string;
    parentRunId?: string;
    parentStatus?: string;
    parentErrorCode?: string;
    openclawModel?: string;
    openclawProvider?: string;
    openclawRuntime?: string;
  };
};

const CATEGORY_LABELS: Record<string, () => string> = {
  hung: () => m.sareports_cat_hung(),
  wrong_result: () => m.sareports_cat_wrong_result(),
  error: () => m.sareports_cat_error(),
  other: () => m.sareports_cat_other(),
};
const cat = (id: string | null) =>
  (id && CATEGORY_LABELS[id]?.()) ?? id ?? "—";

function shortKey(key: string): string {
  const seg = key.slice(key.lastIndexOf(":") + 1) || key;
  return seg.length > 12 ? `${seg.slice(0, 12)}…` : seg;
}

function DetailView({ data }: { data: Detail }) {
  const s = data.snapshot;
  const respond = useMutation(api.subAgentReports.respondToReport);
  const [thread, setThread] = useState<ThreadMsg[]>(data.thread);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await respond({ reportId: data._id as Id<"subAgentReports">, text });
      setThread((t) => [...t, { authorRole: "admin", text, at: Date.now() }]);
      setReply("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="oc-fbadmin__detail">
      {/* No "open conversation" link (mirrors FeedbacksTab): the chat is
          owner-scoped and would error for a report by ANOTHER user. The admin
          debugs via the AUDITED frozen snapshot below — the SOC2-correct surface,
          not the live owner-only chat. */}
      <div className="oc-fbadmin__row">
        <span className="oc-fbadmin__meta">
          {cat(data.category)} · {m.sareports_failed_of({
            failed: s.failedCount,
            total: s.totalCount,
          })}
          {s.openclawModel ? ` · ${s.openclawModel}` : ""}
          {s.openclawRuntime ? ` (${s.openclawRuntime})` : ""}
        </span>
      </div>

      {data.comment ? (
        <section>
          <h4 className="oc-fbadmin__h">{m.sareports_reporter_comment()}</h4>
          <p className="oc-fbadmin__comment">{data.comment}</p>
        </section>
      ) : null}

      <section>
        <h4 className="oc-fbadmin__h">{m.sareports_exchange_title()}</h4>
        {thread.length > 0 ? (
          <div className="oc-fbadmin__thread">
            {thread.map((msg, i) => (
              <div
                key={i}
                className={`oc-notif__msg oc-notif__msg--${msg.authorRole}`}
              >
                <span className="oc-notif__msg-who">
                  {msg.authorRole === "admin"
                    ? m.sareports_role_admin()
                    : m.sareports_role_user()}
                </span>
                <span className="oc-notif__msg-text">{msg.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="oc-fbadmin__meta">{m.sareports_no_reply_sent()}</p>
        )}
        <textarea
          className="oc-feedback__textarea"
          placeholder={m.sareports_reply_placeholder()}
          value={reply}
          maxLength={2000}
          rows={3}
          onChange={(e) => setReply(e.target.value.slice(0, 2000))}
        />
        <div className="oc-fbadmin__row" style={{ justifyContent: "flex-end" }}>
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={!reply.trim() || sending}
          >
            {sending ? m.sareports_sending() : m.sareports_reply_action()}
          </Button>
        </div>
      </section>

      <section>
        <h4 className="oc-fbadmin__h">
          {m.sareports_children_title({ count: s.children.length })}
          {s.childrenTruncated ? ` ${m.sareports_children_truncated()}` : ""}
          {s.textTruncated ? ` ${m.sareports_text_truncated()}` : ""}
        </h4>
        <div className="oc-fbadmin__ctx">
          {s.children.map((c, i) => (
            <div key={i} className="oc-fbadmin__ctx-turn">
              <span className="oc-fbadmin__ctx-role">
                {(c.taskName?.trim() || shortKey(c.childSessionKey)) +
                  ` · ${c.status}`}
                {c.phase ? ` · ${c.phase}` : ""}
                {c.childSessionKey === s.flaggedChildSessionKey
                  ? ` · ${m.sareports_flagged()}`
                  : ""}
              </span>
              {c.errorMessage ? (
                <pre className="oc-msg__source-pre">{c.errorMessage}</pre>
              ) : null}
              {c.resultText ? (
                <pre className="oc-msg__source-pre">{c.resultText}</pre>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {s.parentText ? (
        <section>
          <h4 className="oc-fbadmin__h">{m.sareports_spawning_turn_title()}</h4>
          <pre className="oc-msg__source-pre">{s.parentText}</pre>
        </section>
      ) : null}

      <section>
        <h4 className="oc-fbadmin__h">{m.sareports_context_title()}</h4>
        <p className="oc-fbadmin__env">
          {[
            s.parentStatus ? `status: ${s.parentStatus}` : null,
            s.parentErrorCode ? `code: ${s.parentErrorCode}` : null,
            s.parentRunId ? `run ${s.parentRunId.slice(0, 12)}…` : null,
            data.correlationId ? `corr ${data.correlationId.slice(0, 16)}…` : null,
            s.openclawProvider,
          ]
            .filter(Boolean)
            .join(" · ") || "—"}
        </p>
      </section>
    </div>
  );
}

export function SubAgentReportsTab() {
  const rows = useQuery(api.subAgentReports.listForAdmin, {}) as
    | Row[]
    | undefined;
  const readReport = useMutation(api.subAgentReports.readReport);
  const remove = useMutation(api.subAgentReports.deleteReport);
  const confirm = useConfirm();

  const [openId, setOpenId] = useState<string | null>(null);
  const [byId, setById] = useState<Record<string, Detail>>({});

  async function toggle(row: Row) {
    if (openId === row._id) {
      setOpenId(null);
      return;
    }
    if (!byId[row._id]) {
      // AUDITED content read (gated traces.read.content).
      const data = (await readReport({
        reportId: row._id as Id<"subAgentReports">,
      })) as Detail;
      setById((m) => ({ ...m, [row._id]: data }));
    }
    setOpenId(row._id);
  }

  async function onDelete(row: Row) {
    const ok = await confirm({
      title: m.sareports_delete_confirm_title(),
      description: m.sareports_delete_confirm_description(),
      confirmLabel: m.sareports_delete_confirm_label(),
      destructive: true,
    });
    if (!ok) return;
    await remove({ reportId: row._id as Id<"subAgentReports"> });
    if (openId === row._id) setOpenId(null);
  }

  return (
    <>
      <p className="oc-admin__hint">
        {m.sareports_hint_prefix()}{" "}
        <strong>{m.sareports_hint_audit_strong()}</strong>{" "}
        {m.sareports_hint_suffix()}
      </p>
      <DataTableShell<Row>
        title={m.sareports_table_title()}
        rows={rows}
        emptyHint={m.sareports_empty_hint()}
        isExpanded={(r) => openId === r._id && !!byId[r._id]}
        renderExpanded={(r) =>
          byId[r._id] ? <DetailView data={byId[r._id]} /> : null
        }
        columns={[
          {
            header: m.sareports_col_when(),
            cell: (r) => formatDateTime(r.at),
            sort: (r) => r.at,
          },
          {
            header: m.sareports_col_category(),
            cell: (r) => cat(r.category),
            sort: (r) => cat(r.category),
          },
          {
            header: m.sareports_col_failed(),
            cell: (r) => `${r.failedCount}/${r.totalCount}`,
            sort: (r) => r.failedCount,
          },
          {
            header: m.sareports_col_reporter(),
            cell: (r) =>
              (r.reporterEmail || r.reporterName || "—") +
              (r.impersonated && r.realOperatorEmail
                ? ` ${m.sareports_via({ operator: r.realOperatorEmail })}`
                : ""),
            sort: (r) => r.reporterEmail || r.reporterName || null,
          },
          {
            header: m.sareports_col_note(),
            cell: (r) => (r.hasComment ? "✎" : "—"),
            sort: (r) => (r.hasComment ? 1 : 0),
          },
          {
            header: m.sareports_col_status(),
            cell: (r) =>
              r.answered ? (
                <span className="oc-fbadmin__pill is-ok">
                  {m.sareports_status_answered()}
                </span>
              ) : (
                <span className="oc-fbadmin__pill">
                  {m.sareports_status_pending()}
                </span>
              ),
            sort: (r) => (r.answered ? 1 : 0),
          },
        ]}
        rowActions={(r) => [
          {
            label:
              openId === r._id
                ? m.sareports_action_hide()
                : m.sareports_action_view(),
            onSelect: () => void toggle(r),
          },
          {
            label: m.sareports_action_delete(),
            onSelect: () => void onDelete(r),
            variant: "destructive",
          },
        ]}
      />
    </>
  );
}
