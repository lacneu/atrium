import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Bell,
  Check,
  X,
  TriangleAlert,
  CircleCheck,
  MessageSquare,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { useToast } from "@/components/ui/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

// Per-user notification zone (the bell) — the SINGLE source of truth for the
// unread badge (convex/notifications). Surfaces ANOMALIES (admin) + feedback
// replies as non-PHI pointers, with per-item mark-read / clear + bulk actions.
// A SECONDARY "Mes signalements" section keeps the feedback exchange threads
// readable (the reply TEXT lives there, never in a notification). All writes
// NO-OP under impersonation server-side.

const CATEGORY_LABELS: Record<string, () => string> = {
  altered_words: () => m.notif_cat_altered_words(),
  incorrect: () => m.notif_cat_incorrect(),
  incoherence: () => m.notif_cat_incoherence(),
  formatting: () => m.notif_cat_formatting(),
  latency: () => m.notif_cat_latency(),
  api_error: () => m.notif_cat_api_error(),
  other: () => m.notif_cat_other(),
};
const cat = (id: string) => CATEGORY_LABELS[id]?.() ?? id;

type NotifKind =
  | "anomaly_open"
  | "anomaly_resolved"
  | "feedback_reply"
  | "feedback_resolved";
type Notif = {
  _id: Id<"notifications">;
  kind: NotifKind;
  title: string;
  body: string;
  href: string | null;
  createdAt: number;
  unread: boolean;
};

const KIND_ICON: Record<NotifKind, typeof Bell> = {
  anomaly_open: TriangleAlert,
  anomaly_resolved: CircleCheck,
  feedback_reply: MessageSquare,
  feedback_resolved: MessageSquare,
};

// Render the notification text. `feedback_reply` is fully static → rendered from
// its `kind` code (i18n, no server change). Anomaly notifications carry a
// server-generated detail (the anomaly kind + message) in the stored title/body,
// kept as-is for now — full {code,params} i18n of anomaly content is a follow-up.
function notifText(n: Notif): { title: string; body: string } {
  if (n.kind === "feedback_reply") {
    return {
      title: m.notif_feedback_reply_title(),
      body: m.notif_feedback_reply_body(),
    };
  }
  if (n.kind === "feedback_resolved") {
    return {
      title: m.notif_feedback_resolved_title(),
      body: m.notif_feedback_resolved_body(),
    };
  }
  return { title: n.title, body: n.body };
}

type ThreadMsg = {
  authorRole: "admin" | "user" | "agent";
  authorLabel?: string;
  text: string;
  at: number;
};
type FeedbackItem = {
  _id: string;
  at: number;
  category: string;
  comment: string | null;
  messageRole: string;
  messageText: string;
  chatId: string;
  messageId: string;
  thread: ThreadMsg[];
  answered: boolean;
  resolvedAt?: number | null;
  unread: boolean;
};

export function NotificationBell() {
  const unread = useQuery(api.notifications.myUnreadCount) ?? 0;
  const items = useQuery(api.notifications.myNotifications) as
    | Notif[]
    | undefined;
  const feedback = useQuery(api.feedback.myFeedback) as
    | FeedbackItem[]
    | undefined;
  const markRead = useMutation(api.notifications.markRead);
  const markAllRead = useMutation(api.notifications.markAllRead);
  const clearOne = useMutation(api.notifications.clearOne);
  const clearAll = useMutation(api.notifications.clearAll);
  const closeMyFeedback = useMutation(api.feedback.closeMyFeedback);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const openItem = (n: Notif) => {
    if (n.unread) void markRead({ notificationId: n._id });
    if (!n.href) return;
    setOpen(false);
    // hrefs are produced server-side (controlled set). Two shapes:
    //   /chat/<chatId>                       → a reported conversation (feedback)
    //   /settings/anomalies[?status=resolved] → a filtered anomalies view
    if (n.href.startsWith("/chat/")) {
      void navigate({
        to: "/chat/$chatId",
        params: { chatId: n.href.slice("/chat/".length) },
      });
      return;
    }
    // Split the optional query so the deep-link lands on the right FILTERED view
    // (the tab defaults to open, which would hide a resolved anomaly). zod
    // re-validates the search on navigation.
    const [path, query] = n.href.split("?");
    void navigate({
      to: path as "/settings/anomalies",
      search: Object.fromEntries(new URLSearchParams(query ?? "")) as {
        status?: "open" | "acknowledged" | "resolved" | "all";
      },
    });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="oc-bell"
          aria-label={
            unread > 0 ? m.notif_aria_unread({ count: unread }) : m.notif_aria()
          }
        >
          <Bell size={18} aria-hidden />
          {unread > 0 ? (
            <span className="oc-bell__badge" aria-hidden>
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="oc-notif">
        <div className="oc-notif__head">
          <span>{m.notif_header()}</span>
          {items && items.length > 0 ? (
            <span className="oc-notif__bulk">
              <button
                type="button"
                className="oc-notif__act"
                disabled={unread === 0}
                onClick={() => void markAllRead({})}
              >
                {m.notif_mark_all_read()}
              </button>
              <button
                type="button"
                className="oc-notif__act"
                onClick={() => void clearAll({})}
              >
                {m.notif_clear_all()}
              </button>
            </span>
          ) : null}
        </div>

        {items === undefined ? (
          <div className="oc-notif__empty">{m.common_loading()}</div>
        ) : items.length === 0 ? (
          <div className="oc-notif__empty">{m.notif_empty()}</div>
        ) : (
          <div className="oc-notif__list">
            {items.map((n) => {
              const Icon = KIND_ICON[n.kind] ?? Bell;
              const { title, body } = notifText(n);
              return (
                <div
                  key={n._id}
                  className={`oc-notif__item${n.unread ? " is-unread" : ""}${
                    n.href ? " is-link" : ""
                  }`}
                  role={n.href ? "button" : undefined}
                  tabIndex={n.href ? 0 : undefined}
                  onClick={n.href ? () => openItem(n) : undefined}
                >
                  <div className="oc-notif__item-head">
                    <Icon
                      size={14}
                      className={`oc-notif__kind oc-notif__kind--${n.kind}`}
                      aria-hidden
                    />
                    <span className="oc-notif__title">{title}</span>
                    <span className="oc-notif__row-actions">
                      {n.unread ? (
                        <button
                          type="button"
                          title={m.notif_mark_read()}
                          aria-label={m.notif_mark_read()}
                          onClick={(e) => {
                            e.stopPropagation();
                            void markRead({ notificationId: n._id });
                          }}
                        >
                          <Check size={13} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title={m.notif_clear_one()}
                        aria-label={m.notif_clear_one()}
                        onClick={(e) => {
                          e.stopPropagation();
                          void clearOne({ notificationId: n._id });
                        }}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  </div>
                  <p className="oc-notif__body">{body}</p>
                  <div className="oc-notif__when">
                    {new Date(n.createdAt).toLocaleString(getLocale())}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Secondary: feedback exchange threads (read the admin's reply text). */}
        {feedback && feedback.length > 0 ? (
          <>
            <div className="oc-notif__head oc-notif__head--sub">
              {m.notif_feedback_section()}
            </div>
            <div className="oc-notif__list">
              {feedback.map((it) => (
                <ReportItem
                  key={it._id}
                  it={it}
                  onClose={(reason) =>
                    closeMyFeedback({
                      feedbackId: it._id as Id<"feedback">,
                      reason,
                    })
                  }
                  onNavigate={() => setOpen(false)}
                />
              ))}
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// One "Mes signalements" row: status + admin/user thread + the REPORTED message
// (from the frozen snapshot, collapsible) + a link to the conversation + a
// withdraw action (owner closes their own report with an optional reason; the
// row then drops out of myFeedback and unmounts).
function ReportItem({
  it,
  onClose,
  onNavigate,
}: {
  it: FeedbackItem;
  onClose: (reason?: string) => Promise<unknown>;
  onNavigate: () => void;
}) {
  const toast = useToast();
  const [showMsg, setShowMsg] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirmClose() {
    setBusy(true);
    try {
      await onClose(reason.trim() || undefined);
      // On success the report leaves myFeedback → this item unmounts.
    } catch (err) {
      toast.error(m.notif_close_report(), err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="oc-notif__item">
      <div className="oc-notif__item-head">
        <span className="oc-notif__title">{cat(it.category)}</span>
        <span
          className={`oc-notif__status${
            it.answered || it.resolvedAt ? " is-answered" : ""
          }`}
        >
          {it.resolvedAt
            ? m.notif_resolved()
            : it.answered
              ? m.notif_answered()
              : m.notif_pending()}
        </span>
      </div>
      {/* When the report was submitted (its frozen snapshot timestamp), mirroring
          the `oc-notif__when` line on the notifications above. */}
      <div className="oc-notif__when">
        {new Date(it.at).toLocaleString(getLocale())}
      </div>
      {it.thread.length > 0 ? (
        <div className="oc-notif__thread">
          {it.thread.map((msg, i) => (
            <div
              key={i}
              className={`oc-notif__msg oc-notif__msg--${msg.authorRole}`}
            >
              <span className="oc-notif__msg-who">
                {msg.authorRole === "admin"
                  ? m.notif_author_admin()
                  : msg.authorRole === "agent"
                    ? m.notif_author_agent()
                    : m.notif_author_you()}
              </span>
              <span className="oc-notif__msg-text">{msg.text}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* The reported message itself, from the frozen snapshot (robust even if
          the live message was regenerated/deleted), collapsible. */}
      {it.messageText ? (
        <>
          <button
            type="button"
            className="oc-notif__report-toggle"
            aria-expanded={showMsg}
            onClick={() => setShowMsg((s) => !s)}
          >
            {showMsg ? (
              <ChevronDown size={13} aria-hidden />
            ) : (
              <ChevronRight size={13} aria-hidden />
            )}
            {m.notif_reported_message()}
          </button>
          {showMsg ? (
            <div className="oc-notif__report-msg">{it.messageText}</div>
          ) : null}
        </>
      ) : null}

      <div className="oc-notif__report-actions">
        <Link
          to="/chat/$chatId"
          params={{ chatId: it.chatId }}
          search={{ m: it.messageId }}
          className="oc-notif__link"
          onClick={onNavigate}
        >
          {m.notif_view_conversation()}
        </Link>
        {!closing ? (
          <button
            type="button"
            className="oc-notif__link oc-notif__link--muted"
            onClick={() => setClosing(true)}
          >
            {m.notif_close_report()}
          </button>
        ) : null}
      </div>

      {closing ? (
        <div className="oc-notif__close-form">
          <textarea
            className="oc-notif__close-input"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={m.notif_close_reason_placeholder()}
          />
          <div className="oc-notif__close-actions">
            <button
              type="button"
              className="oc-notif__close-confirm"
              disabled={busy}
              onClick={() => void confirmClose()}
            >
              {m.notif_close_confirm()}
            </button>
            <button
              type="button"
              className="oc-notif__close-cancel"
              onClick={() => {
                setClosing(false);
                setReason("");
              }}
            >
              {m.notif_close_cancel()}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
