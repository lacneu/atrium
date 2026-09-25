// Agent requests — what an agent ASKS the person while it works, and where they answer.
//
// One query per conversation (agentRequests.listForChat) feeds four surfaces:
//   - the CARD under the bubble of the turn that asked (always visible — this is
//     conversation, not tool telemetry);
//   - the DOCK above the composer: what is still waiting, soonest deadline first,
//     answerable in place even when the asking bubble has scrolled far away;
//   - the PANEL (header button): every request of the conversation, waiting and
//     settled, with a jump back to where each was asked;
//   - the sidebar badge and the bell live elsewhere (ChatSidebar, NotificationBell).
//
// Visual families (the tone): question, approval, critical approval, credential —
// each with its own icon and accent, so what is being asked reads before the words.
// A settled request folds to one line; a waiting one can be folded by the reader and
// stays folded (per-viewer, browser storage — a convenience, never state).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAction, useQuery } from "convex/react";
import { useMessage } from "@assistant-ui/react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  Inbox,
  KeyRound,
  LocateFixed,
  MessageCircleQuestion,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  Timer,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import {
  answersFromDrafts,
  blockedBy,
  deadlineShown,
  severalHermesApprovals,
  dockOrder,
  emptyDraft,
  failureKind,
  isOpen,
  isWaiting,
  oneLiner,
  outcomeOf,
  panelSections,
  remaining,
  requestTone,
  setOther,
  toggleOption,
  type AgentRequestQuestionView,
  type AgentRequestTone,
  type AgentRequestView,
  type ApprovalDecision,
  type OutcomeKey,
  type QuestionDraft,
} from "./agentRequestsView";

// ── Context ────────────────────────────────────────────────────────────────────

type AnswerArgs = {
  answers?: Array<{ id: string; values: string[] }>;
  decision?: ApprovalDecision;
  secret?: string;
  skip?: boolean;
};
type AnswerResult = { ok: true } | { ok: false; reason: string };

interface AgentRequestsApi {
  rows: AgentRequestView[];
  now: number;
  byMessage: Map<string, AgentRequestView[]>;
  waiting: AgentRequestView[];
  answer: (requestId: string, args: AnswerArgs) => Promise<AnswerResult>;
  openPanel: () => void;
  jumpTo: (request: AgentRequestView) => void;
}

const AgentRequestsContext = createContext<AgentRequestsApi | null>(null);

export function useAgentRequests(): AgentRequestsApi | null {
  return useContext(AgentRequestsContext);
}

/** The clock the countdowns read: every second while something waits, otherwise
 *  every half minute (only settled cards, whose labels do not move). */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => window.clearInterval(id);
  }, [fast]);
  return now;
}

/** Bring a request's card into view (thread viewport only) and flash it. */
function scrollToRequest(request: AgentRequestView): void {
  const card = document.querySelector<HTMLElement>(
    `.oc-thread__viewport [data-agent-request-id="${CSS.escape(request._id)}"]`,
  );
  const target =
    card ??
    (request.messageId !== null
      ? document.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(request.messageId)}"]`,
        )
      : null);
  if (!target) return;
  const viewport = target.closest<HTMLElement>(".oc-thread__viewport");
  if (viewport) {
    const delta = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.scrollTo({
      top: viewport.scrollTop + delta - Math.max(24, viewport.clientHeight * 0.25),
      behavior: "smooth",
    });
  } else {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  target.classList.remove("oc-areq--flash");
  void target.offsetWidth; // restart the keyframes
  target.classList.add("oc-areq--flash");
  window.setTimeout(() => target.classList.remove("oc-areq--flash"), 2200);
}

export function AgentRequestsProvider({
  chatId,
  children,
}: {
  chatId: string;
  children: ReactNode;
}) {
  const data = useQuery(api.agentRequests.listForChat, {
    chatId: chatId as Id<"chats">,
  }) as AgentRequestView[] | undefined;
  const rows = useMemo(() => data ?? [], [data]);
  const anyOpen = rows.some((r) => isOpen(r.status));
  const now = useNow(anyOpen);
  const answerAction = useAction(api.agentRequests.answer);
  const [panelOpen, setPanelOpen] = useState(false);

  const answer = useCallback(
    async (requestId: string, args: AnswerArgs): Promise<AnswerResult> => {
      try {
        const res = (await answerAction({
          requestId: requestId as Id<"agentRequests">,
          ...args,
        })) as { ok: true } | { ok: false; reason: string };
        return res.ok ? { ok: true } : { ok: false, reason: res.reason };
      } catch {
        return { ok: false, reason: "unreachable" };
      }
    },
    [answerAction],
  );

  const byMessage = useMemo(() => {
    const map = new Map<string, AgentRequestView[]>();
    for (const r of [...rows].sort((a, b) => a.createdAt - b.createdAt)) {
      if (r.messageId === null) continue;
      const list = map.get(r.messageId) ?? [];
      list.push(r);
      map.set(r.messageId, list);
    }
    return map;
  }, [rows]);
  const waiting = useMemo(() => dockOrder(rows, now), [rows, now]);

  const value = useMemo<AgentRequestsApi>(
    () => ({
      rows,
      now,
      byMessage,
      waiting,
      answer,
      openPanel: () => setPanelOpen(true),
      jumpTo: (request) => {
        setPanelOpen(false);
        // After the sheet's close animation frees the viewport.
        window.setTimeout(() => scrollToRequest(request), 120);
      },
    }),
    [rows, now, byMessage, waiting, answer],
  );

  return (
    <AgentRequestsContext.Provider value={value}>
      {children}
      <AgentRequestsPanel open={panelOpen} onOpenChange={setPanelOpen} />
    </AgentRequestsContext.Provider>
  );
}

// ── Folding (per viewer) ───────────────────────────────────────────────────────

const FOLD_KEY = "atrium.agentRequests.folded";

function readFolded(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FOLD_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeFolded(ids: Set<string>): void {
  try {
    // Bounded: only the most recent folds matter.
    window.localStorage.setItem(FOLD_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    /* private window / blocked storage: folding still works for this view */
  }
}

/** A waiting card is open unless the reader folded it; a settled one is folded
 *  unless the reader opened it. */
function useFold(id: string, open: boolean): [boolean, (next: boolean) => void] {
  const [override, setOverride] = useState<boolean | null>(() =>
    open && readFolded().has(id) ? false : null,
  );
  const expanded = override ?? open;
  const set = useCallback(
    (next: boolean) => {
      setOverride(next);
      if (!open) return;
      const folded = readFolded();
      if (next) folded.delete(id);
      else folded.add(id);
      writeFolded(folded);
    },
    [id, open],
  );
  return [expanded, set];
}

// ── Labels ─────────────────────────────────────────────────────────────────────

const TONE_ICON: Record<AgentRequestTone, typeof Inbox> = {
  question: MessageCircleQuestion,
  approval: ShieldCheck,
  critical: ShieldAlert,
  credential: KeyRound,
};

function toneLabel(tone: AgentRequestTone): string {
  switch (tone) {
    case "question":
      return m.areq_kind_question();
    case "approval":
      return m.areq_kind_approval();
    case "critical":
      return m.areq_kind_critical();
    case "credential":
      return m.areq_kind_credential();
  }
}

function remainingLabel(expiresAt: number, now: number): { text: string; urgent: boolean } {
  const r = remaining(expiresAt, now);
  switch (r.unit) {
    case "expired":
      return { text: m.areq_expired(), urgent: true };
    case "seconds":
      return { text: m.areq_expires_seconds({ value: String(r.value) }), urgent: true };
    case "minutes":
      return { text: m.areq_expires_minutes({ value: String(r.value) }), urgent: r.urgent };
    case "hours":
      return { text: m.areq_expires_hours({ value: String(r.value) }), urgent: false };
  }
}

const OUTCOME_LABEL: Record<OutcomeKey, () => string> = {
  answered: () => m.areq_outcome_answered(),
  answered_elsewhere: () => m.areq_outcome_answered_elsewhere(),
  skipped: () => m.areq_outcome_skipped(),
  allowed_once: () => m.areq_outcome_allowed_once(),
  allowed_session: () => m.areq_outcome_allowed_session(),
  allowed_always: () => m.areq_outcome_allowed_always(),
  allowed_elsewhere: () => m.areq_outcome_allowed_elsewhere(),
  denied: () => m.areq_outcome_denied(),
  denied_elsewhere: () => m.areq_outcome_denied_elsewhere(),
  expired: () => m.areq_outcome_expired(),
  cancelled: () => m.areq_outcome_cancelled(),
  failed: () => m.areq_outcome_failed(),
};

const DECISION_LABEL: Record<ApprovalDecision, () => string> = {
  "allow-once": () => m.areq_decision_allow_once(),
  "allow-session": () => m.areq_decision_allow_session(),
  "allow-always": () => m.areq_decision_allow_always(),
  deny: () => m.areq_decision_deny(),
};

const SCOPE_LABEL: Record<string, () => string> = {
  "message-send": () => m.areq_scope_message_send(),
  payment: () => m.areq_scope_payment(),
  "external-post": () => m.areq_scope_external_post(),
  "standing-grant": () => m.areq_scope_standing_grant(),
};

/** A refusal from the action, in the reader's words. */
function reasonText(reason: string): string {
  if (reason.startsWith("AGENT_REQUEST_INVALID_ANSWER")) return m.areq_err_rejected();
  switch (reason) {
    case "AGENT_REQUEST_EXPIRED":
      return m.areq_err_expired();
    case "request_gone":
    case "AGENT_REQUEST_NOT_PENDING":
      return m.areq_err_gone();
    case "AGENT_REQUEST_OWNER_ONLY":
      return m.areq_owner_only();
    case "AGENT_REQUEST_IMPERSONATING":
      return m.areq_err_impersonating();
    case "AGENT_REQUEST_ANSWER_OLDEST_FIRST":
      return m.areq_blocked_oldest();
    case "AGENT_REQUEST_DECISION_NOT_OFFERED":
      return m.areq_err_not_offered();
    case "session_mismatch":
      return m.areq_err_session();
    case "approval_order_unknown":
      return m.areq_err_order_unknown();
    case "approval_ambiguous":
      return m.areq_err_hermes_several();
    case "AGENT_REQUEST_CLIPPED":
      return m.areq_credential_clipped();
    case "invalid_answer":
      return m.areq_err_rejected();
    default:
      return failureKind(reason) === "config" ? m.areq_err_config() : m.areq_err_unreachable();
  }
}

/** What a settled request's folded line says after the outcome. */
function settledDetail(r: AgentRequestView): string | null {
  if (r.status !== "answered" || r.answers === null) return null;
  if (r.kind === "credential" || r.questions?.some((q) => q.secret)) {
    return m.areq_outcome_provided();
  }
  const values = r.answers.flatMap((a) => a.values).filter((v) => v !== "");
  return values.length > 0 ? values.join(" · ") : null;
}

// ── The card ───────────────────────────────────────────────────────────────────

type CardMode = "inline" | "dock" | "panel";

export function AgentRequestCard({
  request,
  mode,
  open,
  onToggle,
}: {
  request: AgentRequestView;
  mode: CardMode;
  /** Controlled folding (the dock's accordion). Absent = the card folds itself:
   *  open while it waits, folded once settled, the reader's choice remembered. */
  open?: boolean;
  onToggle?: (next: boolean) => void;
}) {
  const ctx = useAgentRequests();
  const now = ctx?.now ?? Date.now();
  const tone = requestTone(request);
  const Icon = TONE_ICON[tone];
  const waiting = isWaiting(request, now);
  const [selfExpanded, setSelfExpanded] = useFold(request._id, waiting);
  const expanded = open ?? selfExpanded;
  const setExpanded = onToggle ?? setSelfExpanded;
  const bodyId = useId();
  const outcome = outcomeOf(request, now);
  const countdown = waiting && deadlineShown(request) ? remainingLabel(request.expiresAt, now) : null;
  const blocker = ctx && waiting ? blockedBy(request, ctx.rows) : null;
  const summary = oneLiner(request);
  const detail = settledDetail(request);

  return (
    <section
      className={[
        "oc-areq",
        `oc-areq--${tone}`,
        `oc-areq--${mode}`,
        waiting ? "oc-areq--waiting" : "oc-areq--settled",
        expanded ? "oc-areq--open" : "",
      ].join(" ")}
      data-agent-request-id={request._id}
      aria-label={`${toneLabel(tone)} — ${summary}`}
    >
      <header className="oc-areq__head">
        <span className="oc-areq__icon" aria-hidden>
          <Icon size={15} />
        </span>
        <button
          type="button"
          className="oc-areq__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          title={expanded ? m.areq_collapse() : m.areq_expand()}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="oc-areq__kind">{toneLabel(tone)}</span>
          {!expanded || !waiting ? (
            <span className="oc-areq__summary">{summary}</span>
          ) : null}
        </button>
        {outcome !== null ? (
          <span className={`oc-areq__outcome oc-areq__outcome--${outcome}`}>
            {outcome.startsWith("allowed") || outcome === "answered" ? (
              <Check size={12} aria-hidden />
            ) : outcome.startsWith("denied") ? (
              <X size={12} aria-hidden />
            ) : null}
            {OUTCOME_LABEL[outcome]()}
            {detail !== null && !expanded ? (
              <span className="oc-areq__outcome-detail">{detail}</span>
            ) : null}
          </span>
        ) : null}
        {request.status === "submitting" ? (
          <span className="oc-areq__outcome oc-areq__outcome--sending">{m.areq_sending()}</span>
        ) : null}
        {countdown !== null && request.status === "pending" ? (
          <span
            className={`oc-areq__timer${countdown.urgent ? " oc-areq__timer--urgent" : ""}`}
            title={new Date(request.expiresAt).toLocaleTimeString()}
          >
            <Timer size={12} aria-hidden />
            {countdown.text}
          </span>
        ) : null}
        {mode !== "inline" && ctx ? (
          <button
            type="button"
            className="oc-areq__iconbtn"
            title={m.areq_view_in_thread()}
            aria-label={m.areq_view_in_thread()}
            onClick={() => ctx.jumpTo(request)}
          >
            <LocateFixed size={14} />
          </button>
        ) : null}
        <button
          type="button"
          className="oc-areq__iconbtn"
          aria-hidden
          tabIndex={-1}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </header>
      {expanded ? (
        <div className="oc-areq__body" id={bodyId}>
          <RequestBody request={request} waiting={waiting} blocker={blocker} />
        </div>
      ) : null}
    </section>
  );
}

function RequestBody({
  request,
  waiting,
  blocker,
}: {
  request: AgentRequestView;
  waiting: boolean;
  blocker: AgentRequestView | null;
}) {
  const ctx = useAgentRequests();
  const several = ctx !== null && severalHermesApprovals(request, ctx.rows);
  const answerable =
    waiting && request.status === "pending" && request.canAnswer && blocker === null && !several;
  const note = !waiting
    ? null
    : !request.canAnswer
      ? m.areq_owner_only()
      : several
        ? m.areq_err_hermes_several()
        : blocker !== null
          ? m.areq_blocked_oldest()
          : null;
  return (
    <>
      {request.kind === "approval" && request.approval ? (
        <ApprovalBody request={request} answerable={answerable} />
      ) : request.questions !== null ? (
        <QuestionsBody request={request} answerable={answerable} />
      ) : (
        <CredentialBody request={request} answerable={answerable} />
      )}
      {note !== null ? <p className="oc-areq__note">{note}</p> : null}
    </>
  );
}

function useSubmit(request: AgentRequestView) {
  const ctx = useAgentRequests();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(
    async (args: AnswerArgs) => {
      if (!ctx) return false;
      setBusy(true);
      setError(null);
      const res = await ctx.answer(request._id, args);
      setBusy(false);
      if (!res.ok) setError(reasonText(res.reason));
      return res.ok;
    },
    [ctx, request._id],
  );
  // A failed send is recorded on the row (a reload, another tab): it reads like the
  // one this card just got — once, never both.
  const recorded =
    request.status === "pending" && failureKind(request.failureCode) !== "none"
      ? reasonText(request.failureCode!)
      : null;
  return {
    busy: busy || request.status === "submitting",
    /** THIS card is the one sending (the same request may be shown in the thread, the
     *  dock and the panel at once). */
    sending: busy,
    error: error ?? recorded,
    setError,
    submit,
  };
}

// ── Questions ──────────────────────────────────────────────────────────────────

function QuestionsBody({
  request,
  answerable,
}: {
  request: AgentRequestView;
  answerable: boolean;
}) {
  const questions = request.questions ?? [];
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const { busy, sending, error, setError, submit } = useSubmit(request);
  const settledAnswers = request.answers;
  // Once nobody can answer any more (answered elsewhere, settled, or past its deadline
  // before the sweep), what was typed goes — a secret most of all (codex P3 ×2).
  const open = isOpen(request.status);
  // Kept only by the card that SENT it: another copy of this request (thread, dock,
  // panel) drops what was typed there as soon as the request is taken (codex P3).
  const stale = !open || (!answerable && !sending);
  useEffect(() => {
    if (stale) setDrafts({});
  }, [stale]);

  const send = async () => {
    const built = answersFromDrafts(questions, drafts);
    if (!built.ok) {
      setError(built.problem.code === "missing" ? m.areq_err_missing() : m.areq_err_too_long());
      return;
    }
    if (await submit({ answers: built.answers })) setDrafts({});
  };

  return (
    <form
      className="oc-areq__form"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        }
      }}
    >
      {questions.map((q) => (
        <QuestionBlock
          key={q.id}
          question={q}
          draft={drafts[q.id] ?? emptyDraft()}
          disabled={!answerable || busy}
          closed={!open}
          settled={settledAnswers?.find((a) => a.id === q.id)?.values ?? null}
          onChange={(d) => {
            setError(null);
            setDrafts((prev) => ({ ...prev, [q.id]: d }));
          }}
        />
      ))}
      {error !== null ? (
        <p className="oc-areq__error" role="alert">
          {error}
        </p>
      ) : null}
      {answerable ? (
        <div className="oc-areq__actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            title={m.areq_skip_hint()}
            onClick={() => {
              setDrafts({});
              void submit({ skip: true });
            }}
          >
            {m.areq_skip()}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? m.areq_sending() : m.areq_submit()}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function QuestionBlock({
  question,
  draft,
  disabled,
  closed,
  settled,
  onChange,
}: {
  question: AgentRequestQuestionView;
  draft: QuestionDraft;
  disabled: boolean;
  /** Nobody can answer any more: nothing to type into. */
  closed: boolean;
  settled: string[] | null;
  onChange: (d: QuestionDraft) => void;
}) {
  const labelId = useId();
  const freeText = question.options.length === 0;
  const [reveal, setReveal] = useState(false);
  const chosen = settled ?? draft.selected;
  return (
    <fieldset className="oc-areq__q" aria-labelledby={labelId} disabled={disabled}>
      <div className="oc-areq__qhead" id={labelId}>
        {question.header ? <span className="oc-areq__qchip">{question.header}</span> : null}
        <span className="oc-areq__qtext">{question.text}</span>
      </div>
      {question.store ? <SecretStoreFacts store={question.store} /> : null}
      {question.url ? (
        <a
          className="oc-areq__link"
          href={question.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink size={13} aria-hidden />
          {m.areq_open_link()}
        </a>
      ) : null}
      {question.options.length > 0 ? (
        <div
          className="oc-areq__options"
          role={question.multiSelect ? "group" : "radiogroup"}
          aria-labelledby={labelId}
        >
          {question.options.map((o) => {
            const on = chosen.includes(o.label);
            return (
              <button
                key={o.label}
                type="button"
                className={`oc-areq__option${on ? " oc-areq__option--on" : ""}`}
                role={question.multiSelect ? "checkbox" : "radio"}
                aria-checked={on}
                disabled={disabled || settled !== null}
                onClick={() => onChange(toggleOption(question, draft, o.label))}
              >
                <span className="oc-areq__option-mark" aria-hidden>
                  {on ? <Check size={11} /> : null}
                </span>
                <span className="oc-areq__option-text">
                  <span className="oc-areq__option-label" title={o.label.length > 120 ? o.label : undefined}>
                    {o.label}
                  </span>
                  {o.description ? (
                    <span className="oc-areq__option-desc">{o.description}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
          {question.multiSelect ? (
            <span className="oc-areq__hint">{m.areq_multi_hint()}</span>
          ) : null}
        </div>
      ) : null}
      {!closed && settled === null && (question.allowOther || freeText) ? (
        question.secret ? (
          <div className="oc-areq__secret">
            <input
              className="oc-areq__input"
              type={reveal ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder={m.areq_credential_placeholder_secret()}
              value={draft.other}
              onChange={(e) => onChange(setOther(question, draft, e.target.value))}
            />
            <button
              type="button"
              className="oc-areq__iconbtn"
              title={reveal ? m.areq_credential_hide() : m.areq_credential_show()}
              aria-label={reveal ? m.areq_credential_hide() : m.areq_credential_show()}
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        ) : freeText ? (
          <textarea
            className="oc-areq__input oc-areq__input--area"
            rows={2}
            placeholder={m.areq_free_placeholder()}
            value={draft.other}
            onChange={(e) => onChange(setOther(question, draft, e.target.value))}
          />
        ) : (
          <input
            className="oc-areq__input"
            type="text"
            placeholder={m.areq_other_placeholder()}
            value={draft.other}
            onChange={(e) => onChange(setOther(question, draft, e.target.value))}
          />
        )
      ) : null}
      {settled !== null && settled.length > 0 && question.options.length === 0 && !question.secret ? (
        <p className="oc-areq__given">{settled.join(" · ")}</p>
      ) : null}
      {question.secret ? (
        <p className="oc-areq__hint">
          {question.store ? m.areq_store_notice() : m.areq_credential_notice()}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Where the gateway will keep the secret, and where it may go — before anyone types. */
function SecretStoreFacts({
  store,
}: {
  store: NonNullable<AgentRequestQuestionView["store"]>;
}) {
  return (
    <div className="oc-areq__facts">
      <span className="oc-areq__fact oc-areq__fact--mono">{m.areq_store_name({ name: store.name })}</span>
      {store.allowedHosts ? (
        <span className="oc-areq__fact">
          {m.areq_store_hosts({ hosts: store.allowedHosts.join(", ") })}
        </span>
      ) : null}
      {store.replacesSinceMs !== undefined ? (
        <span className="oc-areq__fact oc-areq__fact--warning">
          {m.areq_store_replaces({ date: new Date(store.replacesSinceMs).toLocaleDateString() })}
        </span>
      ) : null}
      {store.reason ? <span className="oc-areq__fact">{store.reason}</span> : null}
    </div>
  );
}

// ── Approvals ──────────────────────────────────────────────────────────────────

function ApprovalBody({
  request,
  answerable,
}: {
  request: AgentRequestView;
  answerable: boolean;
}) {
  const a = request.approval!;
  const { busy, error, submit } = useSubmit(request);
  const [confirmAlways, setConfirmAlways] = useState(false);
  const allows = a.decisions.filter((d) => d !== "deny");
  return (
    <div className="oc-areq__approval">
      {a.title ? <p className="oc-areq__title">{a.title}</p> : null}
      {a.description ? <p className="oc-areq__desc">{a.description}</p> : null}
      {a.command ? (
        <pre className="oc-areq__command" aria-label={m.areq_command_label()}>
          <SquareTerminal size={13} aria-hidden className="oc-areq__command-icon" />
          <code>{a.command}</code>
        </pre>
      ) : null}
      {a.warning ? (
        <p className="oc-areq__warning">
          <ShieldAlert size={13} aria-hidden />
          {a.warning}
        </p>
      ) : null}
      {a.clipped ? (
        <p className="oc-areq__warning" role="note">
          <ShieldAlert size={13} aria-hidden />
          {m.areq_approval_clipped()}
        </p>
      ) : null}
      {a.detail ? <details className="oc-areq__detail"><summary>{m.areq_details()}</summary><pre>{a.detail}</pre></details> : null}
      <div className="oc-areq__facts">
        {a.severity && a.severity !== "info" ? (
          <span className={`oc-areq__fact oc-areq__fact--${a.severity}`}>
            {a.severity === "critical" ? m.areq_severity_critical() : m.areq_severity_warning()}
          </span>
        ) : null}
        {a.scope ? (
          <span className="oc-areq__fact">
            {(SCOPE_LABEL[a.scope.kind] ?? (() => a.scope!.kind))()} · {a.scope.summary}
          </span>
        ) : null}
        {a.scope?.external ? (
          <span className="oc-areq__fact oc-areq__fact--warning">{m.areq_scope_external_audience()}</span>
        ) : null}
        {a.scope?.grantDays !== undefined ? (
          <span className="oc-areq__fact">{m.areq_scope_grant_days({ days: String(a.scope.grantDays) })}</span>
        ) : null}
        {a.host ? <span className="oc-areq__fact">{m.areq_host({ host: a.host })}</span> : null}
        {a.nodeId ? <span className="oc-areq__fact">{m.areq_node({ node: a.nodeId })}</span> : null}
        {a.pluginId ? <span className="oc-areq__fact">{m.areq_plugin({ plugin: a.pluginId })}</span> : null}
        {a.toolName ? <span className="oc-areq__fact oc-areq__fact--mono">{a.toolName}</span> : null}
      </div>
      {error !== null ? (
        <p className="oc-areq__error" role="alert">
          {error}
        </p>
      ) : null}
      {answerable ? (
        confirmAlways ? (
          <div className="oc-areq__confirm" role="group" aria-label={m.areq_always_confirm()}>
            <p>
              {a.scope?.grantDays !== undefined
                ? m.areq_always_hint_days({ days: String(a.scope.grantDays) })
                : m.areq_always_hint()}
            </p>
            <div className="oc-areq__actions">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmAlways(false)}>
                {m.areq_cancel()}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void submit({ decision: "allow-always" })}
              >
                {m.areq_always_confirm()}
              </Button>
            </div>
          </div>
        ) : (
          <div className="oc-areq__actions">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void submit({ decision: "deny" })}
            >
              {DECISION_LABEL.deny()}
            </Button>
            <span className="oc-areq__spacer" />
            {allows
              .filter((d) => d !== "allow-once")
              .map((d) => (
                <Button
                  key={d}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    d === "allow-always" ? setConfirmAlways(true) : void submit({ decision: d })
                  }
                >
                  {DECISION_LABEL[d]()}
                </Button>
              ))}
            {allows.includes("allow-once") ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void submit({ decision: "allow-once" })}
              >
                {busy ? m.areq_sending() : DECISION_LABEL["allow-once"]()}
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

// ── Credentials (Hermes secret / sudo) ─────────────────────────────────────────

function CredentialBody({
  request,
  answerable,
}: {
  request: AgentRequestView;
  answerable: boolean;
}) {
  const c = request.credential;
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const { busy, sending, error, setError, submit } = useSubmit(request);
  const password = c?.mode === "password";
  // A typed credential never outlives the chance to send it (codex P3 ×2).
  const open = isOpen(request.status);
  // Kept only by the card that SENT it: another copy of this request (thread, dock,
  // panel) drops what was typed there as soon as the request is taken (codex P3).
  const stale = !open || (!answerable && !sending);
  useEffect(() => {
    if (stale) setValue("");
  }, [stale]);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <form
      className="oc-areq__form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.length === 0) {
          setError(m.areq_err_missing());
          return;
        }
        void submit({ secret: value }).then((ok) => {
          if (ok) setValue("");
        });
      }}
    >
      <p className="oc-areq__desc">{c?.prompt ?? (password ? m.areq_credential_sudo() : m.areq_credential_generic())}</p>
      {c?.command ? (
        <pre className="oc-areq__command" aria-label={m.areq_command_label()}>
          <SquareTerminal size={13} aria-hidden className="oc-areq__command-icon" />
          <code>{c.command}</code>
        </pre>
      ) : null}
      {c?.envVar ? (
        <span className="oc-areq__fact oc-areq__fact--mono">{m.areq_credential_var({ name: c.envVar })}</span>
      ) : null}
      {c?.clipped || c?.commandMissing ? (
        <p className="oc-areq__warning" role="note">
          <ShieldAlert size={13} aria-hidden />
          {c.clipped ? m.areq_credential_clipped() : m.areq_credential_command_missing()}
        </p>
      ) : null}
      {answerable && !c?.clipped && !c?.commandMissing ? (
        <div className="oc-areq__secret">
          <input
            ref={inputRef}
            className="oc-areq__input"
            type={reveal ? "text" : "password"}
            autoComplete={password ? "current-password" : "off"}
            spellCheck={false}
            placeholder={
              password ? m.areq_credential_placeholder_password() : m.areq_credential_placeholder_secret()
            }
            value={value}
            onChange={(e) => {
              setError(null);
              setValue(e.target.value);
            }}
          />
          <button
            type="button"
            className="oc-areq__iconbtn"
            title={reveal ? m.areq_credential_hide() : m.areq_credential_show()}
            aria-label={reveal ? m.areq_credential_hide() : m.areq_credential_show()}
            onClick={() => {
              setReveal((v) => !v);
              inputRef.current?.focus();
            }}
          >
            {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      ) : null}
      <p className="oc-areq__hint">{m.areq_credential_notice()}</p>
      {error !== null ? (
        <p className="oc-areq__error" role="alert">
          {error}
        </p>
      ) : null}
      {answerable ? (
        <div className="oc-areq__actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setValue("");
              void submit({ skip: true });
            }}
          >
            {m.areq_credential_skip()}
          </Button>
          {c?.clipped || c?.commandMissing ? null : (
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? m.areq_sending() : m.areq_credential_submit()}
            </Button>
          )}
        </div>
      ) : null}
    </form>
  );
}

// ── Surfaces ───────────────────────────────────────────────────────────────────

/** The cards of the requests a turn raised, under its bubble. */
export function MessageAgentRequests() {
  const ctx = useAgentRequests();
  const messageId = useMessage((msg) => msg.id);
  const list = ctx?.byMessage.get(messageId);
  if (!list || list.length === 0) return null;
  return (
    <div className="oc-areq-inline">
      {list.map((r) => (
        <AgentRequestCard key={r._id} request={r} mode="inline" />
      ))}
    </div>
  );
}

/**
 * What still waits, right above the composer — answerable in place, never in the way.
 *
 * Folded by default to ONE line: the request that expires soonest. Unfolded, every
 * waiting request is a one-line row, and only one opens at a time (an accordion) —
 * the thread stays readable while the agent waits.
 */
export function AgentRequestDock() {
  const ctx = useAgentRequests();
  const [listOpen, setListOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const waiting = ctx?.waiting ?? [];
  // A row that stopped waiting (answered, expired) must not stay "the open one".
  useEffect(() => {
    if (openId !== null && !waiting.some((r) => r._id === openId)) setOpenId(null);
  }, [openId, waiting]);
  if (!ctx || waiting.length === 0) return null;
  const first = waiting[0]!;
  const tone = requestTone(first);
  const Icon = TONE_ICON[tone];
  const shown = listOpen ? waiting : [first];
  const more = waiting.length - 1;
  return (
    <div className={`oc-areq-dock oc-areq-dock--${tone}`} role="region" aria-label={m.areq_dock_title()}>
      <div className="oc-areq-dock__bar">
        <span className="oc-areq-dock__pulse" aria-hidden>
          <Icon size={14} />
        </span>
        <span className="oc-areq-dock__title">{m.areq_dock_title()}</span>
        {more > 0 ? (
          <button
            type="button"
            className="oc-areq-dock__count"
            aria-expanded={listOpen}
            title={listOpen ? m.areq_collapse() : m.areq_expand()}
            onClick={() => setListOpen((v) => !v)}
          >
            {m.areq_dock_count({ count: String(waiting.length) })}
            {listOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronUp size={12} aria-hidden />}
          </button>
        ) : null}
        <span className="oc-areq__spacer" />
        <button
          type="button"
          className="oc-areq__iconbtn"
          title={m.areq_panel_title()}
          aria-label={m.areq_panel_title()}
          onClick={ctx.openPanel}
        >
          <Inbox size={14} />
        </button>
      </div>
      <div className="oc-areq-dock__list">
        {shown.map((r) => (
          <AgentRequestCard
            key={r._id}
            request={r}
            mode="dock"
            open={openId === r._id}
            onToggle={(next) => setOpenId(next ? r._id : null)}
          />
        ))}
      </div>
    </div>
  );
}

/** Every request of the conversation — the one place to find them again. */
function AgentRequestsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ctx = useAgentRequests();
  const [filter, setFilter] = useState<AgentRequestTone | "all">("all");
  const sections = useMemo(
    () => (ctx ? panelSections(ctx.rows, ctx.now) : { waiting: [], history: [] }),
    [ctx],
  );
  const keep = (r: AgentRequestView) => {
    if (filter === "all") return true;
    const t = requestTone(r);
    return filter === "approval" ? t === "approval" || t === "critical" : t === filter;
  };
  const waiting = sections.waiting.filter(keep);
  const history = sections.history.filter(keep);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="oc-areq-panel">
        <SheetHeader>
          <SheetTitle>{m.areq_panel_title()}</SheetTitle>
          <SheetDescription>{m.areq_panel_description()}</SheetDescription>
        </SheetHeader>
        <div className="oc-areq-panel__filters" role="tablist" aria-label={m.areq_panel_filter()}>
          {(["all", "question", "approval", "credential"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`oc-areq-panel__filter${filter === f ? " oc-areq-panel__filter--on" : ""}${f !== "all" ? ` oc-areq-panel__filter--${f}` : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? m.areq_filter_all() : toneLabel(f)}
            </button>
          ))}
        </div>
        <div className="oc-areq-panel__body">
          {waiting.length === 0 && history.length === 0 ? (
            <p className="oc-areq-panel__empty">{m.areq_panel_empty()}</p>
          ) : null}
          {waiting.length > 0 ? (
            <>
              <h3 className="oc-areq-panel__section">
                {m.areq_panel_waiting()} <span className="oc-areq-panel__n">{waiting.length}</span>
              </h3>
              {waiting.map((r) => (
                <AgentRequestCard key={r._id} request={r} mode="panel" />
              ))}
            </>
          ) : null}
          {history.length > 0 ? (
            <>
              <h3 className="oc-areq-panel__section">{m.areq_panel_history()}</h3>
              {history.map((r) => (
                <AgentRequestCard key={r._id} request={r} mode="panel" />
              ))}
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The header entry to the panel. Hidden in a conversation that never had a request,
 *  accented while one waits. `ghost` = the width measurer's inert stand-in. */
export function AgentRequestsHeaderButton({
  compact = false,
  ghost = false,
}: {
  compact?: boolean;
  ghost?: boolean;
}) {
  const ctx = useAgentRequests();
  if (!ctx || ctx.rows.length === 0) return null;
  const n = ctx.waiting.length;
  const inner = (
    <>
      <Inbox size={13} aria-hidden />
      {!compact ? <span className="oc-chip__label">{m.areq_header_button()}</span> : null}
      {n > 0 ? <span className="oc-areq-headbadge">{n}</span> : null}
    </>
  );
  const cls = `oc-chip oc-chip--btn${n > 0 ? " oc-chip--areq" : ""}`;
  if (ghost) return <span className={cls}>{inner}</span>;
  return (
    <button
      type="button"
      className={cls}
      title={n > 0 ? m.areq_header_title({ count: String(n) }) : m.areq_panel_title()}
      onClick={ctx.openPanel}
    >
      {inner}
    </button>
  );
}
