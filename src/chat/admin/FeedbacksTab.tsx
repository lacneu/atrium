import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "./DataTableShell";
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages.js";

// Increment B — admin administration of recorded feedback (Settings › Feedbacks).
//
// SPLIT BY SENSITIVITY (product rule): the table shows METADATA only (no
// message content), so listing is unaudited like the audit/trace logs. Opening a
// row's DETAIL calls `readSnapshot` — a MUTATION that is gated by
// `traces.read.content` and AUDITS the cross-user content access — so every time
// an admin actually views another user's message content, it is traced.

type Row = {
  _id: string;
  at: number;
  reference: string;
  category: string;
  hasComment: boolean;
  messageRole: string;
  displayedMatchesStored?: boolean;
  sourceWasOpen: boolean;
  impersonated: boolean;
  answered: boolean;
  reporterEmail: string | null;
  reporterName: string | null;
  realOperatorEmail: string | null;
  chatId: string;
  messageId: string;
  userClosedAt: number | null;
  resolvedAt?: number | null;
  resolvedBy?: string | null;
  userCloseReason: string | null;
};

type ThreadMsg = {
  authorRole: "admin" | "user" | "agent";
  authorLabel?: string;
  text: string;
  at: number;
};

type Snapshot = {
  _id: string;
  category: string;
  comment: string | null;
  at: number;
  thread: ThreadMsg[];
  snapshot: {
    messageRole: string;
    messageText: string;
    runId?: string;
    isRegeneration?: boolean;
    promptText?: string;
    contextJson?: string;
    contextCount?: number;
    contextTruncated?: boolean;
    openclawModel?: string;
    openclawProvider?: string;
    openclawRuntime?: string;
    sessionSettings?: { thinkingLevel?: string; model?: string };
    outboxText?: string;
    outboxStatus?: string;
    outboxAvailable?: boolean;
    displayedText?: string;
    displayedMatchesStored?: boolean;
    clientInfo?: {
      userAgent?: string;
      language?: string;
      timezone?: string;
      theme?: string;
      sourceWasOpen?: boolean;
      plugins?: string[];
      extensionsDetected?: string[];
    };
  };
};

const CATEGORY_LABELS: Record<string, () => string> = {
  altered_words: () => m.feedbacks_cat_altered_words(),
  incorrect: () => m.feedbacks_cat_incorrect(),
  incoherence: () => m.feedbacks_cat_incoherence(),
  formatting: () => m.feedbacks_cat_formatting(),
  latency: () => m.feedbacks_cat_latency(),
  api_error: () => m.feedbacks_cat_api_error(),
  other: () => m.feedbacks_cat_other(),
};
const cat = (id: string) => CATEGORY_LABELS[id]?.() ?? id;

function FidelityBadge({
  matches,
  sourceWasOpen,
}: {
  matches?: boolean;
  sourceWasOpen: boolean;
}) {
  // Honest: the strong "display" claim only holds when the source view was open.
  if (!sourceWasOpen)
    return <span className="oc-fbadmin__pill">{m.feedbacks_fidelity_received_stored()}</span>;
  if (matches === true)
    return <span className="oc-fbadmin__pill is-ok">{m.feedbacks_fidelity_faithful()}</span>;
  if (matches === false)
    return <span className="oc-fbadmin__pill is-warn">{m.feedbacks_fidelity_mismatch()}</span>;
  return <span className="oc-fbadmin__pill">—</span>;
}

function Detail({
  data,
  reference,
  closeReason,
}: {
  data: Snapshot;
  reference?: string;
  closeReason?: string | null;
}) {
  const s = data.snapshot;
  const respond = useMutation(api.feedback.respondToFeedback);
  // Local thread (optimistic): the admin just authored the reply, so append it
  // without re-reading (readSnapshot is one-shot + audited).
  const [thread, setThread] = useState<ThreadMsg[]>(data.thread);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await respond({ feedbackId: data._id as Id<"feedback">, text });
      setThread((t) => [...t, { authorRole: "admin", text, at: Date.now() }]);
      setReply("");
    } finally {
      setSending(false);
    }
  }

  let context: { role: string; text: string }[] = [];
  try {
    context = s.contextJson ? JSON.parse(s.contextJson) : [];
  } catch {
    context = [];
  }
  return (
    <div className="oc-fbadmin__detail">
      <div className="oc-fbadmin__row">
        <FidelityBadge
          matches={s.displayedMatchesStored}
          sourceWasOpen={s.clientInfo?.sourceWasOpen ?? false}
        />
        <span className="oc-fbadmin__meta">
          {cat(data.category)} · {s.messageRole}
          {s.isRegeneration ? ` · ${m.feedbacks_regeneration()}` : ""}
          {s.openclawModel ? ` · ${s.openclawModel}` : ""}
          {s.openclawRuntime ? ` (${s.openclawRuntime})` : ""}
        </span>
        {reference ? (
          // The shareable reference (what the support API takes): SELECTABLE
          // code so the admin can hand the report to an agent/support key.
          <code
            className="oc-fbadmin__ref"
            style={{ userSelect: "all", marginLeft: "auto" }}
            title={m.feedbacks_reference_title()}
          >
            {reference}
          </code>
        ) : null}
      </div>

      {data.comment ? (
        <section>
          <h4 className="oc-fbadmin__h">{m.feedbacks_reporter_comment()}</h4>
          <p className="oc-fbadmin__comment">{data.comment}</p>
        </section>
      ) : null}

      {/* The user withdrew this report — surface why (their words). */}
      {closeReason ? (
        <section>
          <h4 className="oc-fbadmin__h">{m.feedbacks_close_reason()}</h4>
          <p className="oc-fbadmin__comment">{closeReason}</p>
        </section>
      ) : null}

      <section>
        <h4 className="oc-fbadmin__h">{m.feedbacks_exchange_title()}</h4>
        {thread.length > 0 ? (
          <div className="oc-fbadmin__thread">
            {thread.map((msg, i) => (
              <div
                key={i}
                className={`oc-notif__msg oc-notif__msg--${msg.authorRole}`}
              >
                <span className="oc-notif__msg-who">
                  {msg.authorRole === "admin"
                    ? m.feedbacks_role_admin()
                    : msg.authorRole === "agent"
                      ? (msg.authorLabel ?? m.feedbacks_role_agent())
                      : m.feedbacks_role_user()}
                </span>
                <span className="oc-notif__msg-text">{msg.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="oc-fbadmin__meta">{m.feedbacks_no_reply_sent()}</p>
        )}
        <textarea
          className="oc-feedback__textarea"
          placeholder={m.feedbacks_reply_placeholder()}
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
            {sending ? m.feedbacks_sending() : m.feedbacks_reply_action()}
          </Button>
        </div>
      </section>

      <section>
        <h4 className="oc-fbadmin__h">{m.feedbacks_stored_text_title()}</h4>
        <pre className="oc-msg__source-pre">{s.messageText || m.feedbacks_empty_value()}</pre>
      </section>

      {s.clientInfo?.sourceWasOpen && s.displayedText !== undefined ? (
        <section>
          <h4 className="oc-fbadmin__h">
            {m.feedbacks_displayed_text_title()}
          </h4>
          <pre className="oc-msg__source-pre">{s.displayedText || m.feedbacks_empty_value()}</pre>
        </section>
      ) : null}

      {s.promptText ? (
        <section>
          <h4 className="oc-fbadmin__h">{m.feedbacks_generator_prompt_title()}</h4>
          <pre className="oc-msg__source-pre">{s.promptText}</pre>
        </section>
      ) : null}

      {context.length > 0 ? (
        <section>
          <h4 className="oc-fbadmin__h">
            {m.feedbacks_frozen_context_title({
              count: s.contextCount ?? context.length,
              truncated: s.contextTruncated
                ? m.feedbacks_context_truncated_suffix()
                : "",
            })}
          </h4>
          <div className="oc-fbadmin__ctx">
            {context.map((m, i) => (
              <div key={i} className="oc-fbadmin__ctx-turn">
                <span className="oc-fbadmin__ctx-role">{m.role}</span>
                <span className="oc-fbadmin__ctx-text">{m.text}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {s.outboxAvailable ? (
        <section>
          <h4 className="oc-fbadmin__h">{m.feedbacks_outbox_title()}</h4>
          <pre className="oc-msg__source-pre">
            {s.outboxText ?? ""}
            {s.outboxStatus ? `\n[status: ${s.outboxStatus}]` : ""}
          </pre>
        </section>
      ) : null}

      {s.clientInfo?.extensionsDetected &&
      s.clientInfo.extensionsDetected.length > 0 ? (
        <section>
          <h4 className="oc-fbadmin__h">
            {m.feedbacks_extensions_detected_title()}
          </h4>
          <div className="oc-fbadmin__row">
            {s.clientInfo.extensionsDetected.map((e) => (
              <span key={e} className="oc-fbadmin__pill is-warn">
                {e}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h4 className="oc-fbadmin__h">{m.feedbacks_client_env_title()}</h4>
        <p className="oc-fbadmin__env">
          {[
            s.clientInfo?.language,
            s.clientInfo?.timezone,
            s.clientInfo?.theme
              ? m.feedbacks_env_theme({ theme: s.clientInfo.theme })
              : null,
            s.runId ? `run ${s.runId.slice(0, 12)}…` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "—"}
          {s.clientInfo?.plugins && s.clientInfo.plugins.length > 0 ? (
            <span className="oc-fbadmin__plugins">
              {m.feedbacks_plugins_label()} {s.clientInfo.plugins.join(", ")}
              <span className="oc-fbadmin__note">
                {" "}
                {m.feedbacks_plugins_note()}
              </span>
            </span>
          ) : null}
          {s.clientInfo?.userAgent ? (
            <span className="oc-fbadmin__ua">{s.clientInfo.userAgent}</span>
          ) : null}
        </p>
      </section>
    </div>
  );
}

export function FeedbacksTab() {
  const rows = useQuery(api.feedback.listForAdmin, {}) as Row[] | undefined;
  const readSnapshot = useMutation(api.feedback.readSnapshot);
  const remove = useMutation(api.feedback.deleteFeedback);
  const confirm = useConfirm();

  const [openId, setOpenId] = useState<string | null>(null);
  const [byId, setById] = useState<Record<string, Snapshot>>({});

  async function toggle(row: Row) {
    if (openId === row._id) {
      setOpenId(null);
      return;
    }
    if (!byId[row._id]) {
      // AUDITED content read (gated traces.read.content).
      const data = (await readSnapshot({
        feedbackId: row._id as Id<"feedback">,
      })) as Snapshot;
      setById((m) => ({ ...m, [row._id]: data }));
    }
    setOpenId(row._id);
  }

  async function onDelete(row: Row) {
    const ok = await confirm({
      title: m.feedbacks_delete_confirm_title(),
      description: m.feedbacks_delete_confirm_description(),
      confirmLabel: m.feedbacks_delete_confirm_label(),
      destructive: true,
    });
    if (!ok) return;
    await remove({ feedbackId: row._id as Id<"feedback"> });
    if (openId === row._id) setOpenId(null);
  }

  return (
    <>
      <p className="oc-admin__hint">
        {m.feedbacks_hint_prefix()}{" "}
        <strong>{m.feedbacks_hint_audit_strong()}</strong>{" "}
        {m.feedbacks_hint_suffix()}
      </p>
      <DataTableShell<Row>
        title={m.feedbacks_table_title()}
        rows={rows}
        emptyHint={m.feedbacks_empty_hint()}
        isExpanded={(r) => openId === r._id && !!byId[r._id]}
        renderExpanded={(r) =>
          byId[r._id] ? (
            <Detail
              data={byId[r._id]}
              reference={r.reference}
              closeReason={r.userCloseReason}
            />
          ) : null
        }
        columns={[
          {
            header: m.feedbacks_col_when(),
            cell: (r) => formatDateTime(r.at),
            sort: (r) => r.at, // sort by the timestamp, not the formatted string
          },
          {
            header: m.feedbacks_col_category(),
            cell: (r) => cat(r.category),
            sort: (r) => cat(r.category),
          },
          {
            header: m.feedbacks_col_type(),
            cell: (r) => (r.messageRole === "user" ? m.feedbacks_type_user() : m.feedbacks_type_ai()),
            sort: (r) => r.messageRole,
          },
          {
            header: m.feedbacks_col_reporter(),
            cell: (r) =>
              (r.reporterEmail || r.reporterName || "—") +
              (r.impersonated && r.realOperatorEmail
                ? ` ${m.feedbacks_via({ operator: r.realOperatorEmail })}`
                : ""),
            sort: (r) => r.reporterEmail || r.reporterName || null,
          },
          {
            header: m.feedbacks_col_fidelity(),
            cell: (r) => (
              <FidelityBadge
                matches={r.displayedMatchesStored}
                sourceWasOpen={r.sourceWasOpen}
              />
            ),
            // rank: mismatch (0) < faithful (1) < not-applicable (2)
            sort: (r) =>
              r.displayedMatchesStored === false
                ? 0
                : r.displayedMatchesStored === true
                  ? 1
                  : 2,
          },
          {
            header: m.feedbacks_col_note(),
            cell: (r) => (r.hasComment ? "✎" : "—"),
            sort: (r) => (r.hasComment ? 1 : 0),
          },
          {
            header: m.feedbacks_col_status(),
            cell: (r) =>
              r.userClosedAt != null ? (
                <span className="oc-fbadmin__pill is-closed">
                  {m.feedbacks_status_closed_by_user()}
                </span>
              ) : r.resolvedAt != null ? (
                <span
                  className="oc-fbadmin__pill is-ok"
                  title={r.resolvedBy ?? undefined}
                >
                  {m.feedbacks_status_resolved()}
                </span>
              ) : r.answered ? (
                <span className="oc-fbadmin__pill is-ok">{m.feedbacks_status_answered()}</span>
              ) : (
                <span className="oc-fbadmin__pill">{m.feedbacks_status_pending()}</span>
              ),
            // rank: pending (0) < answered (1) < resolved (2) < closed-by-user (3)
            sort: (r) =>
              r.userClosedAt != null ? 3 : r.resolvedAt != null ? 2 : r.answered ? 1 : 0,
          },
        ]}
        rowActions={(r) => [
          {
            label: openId === r._id ? m.feedbacks_action_hide() : m.feedbacks_action_view(),
            onSelect: () => void toggle(r),
          },
          {
            label: m.feedbacks_action_delete(),
            onSelect: () => void onDelete(r),
            variant: "destructive",
          },
        ]}
      />
    </>
  );
}
