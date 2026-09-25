// Agent requests — the PURE half of the UI (what the agent asked, how it reads, what
// the person may do). The components (AgentRequests.tsx) render; every decision a test
// can pin lives here.
//
// The answer rules MIRROR convex/lib/agentRequests.ts#validateAnswers (which mirrors
// the gateway's own): the card refuses an answer before the round trip, in the
// reader's language, instead of letting the server say no.

export type AgentRequestKind = "question" | "approval" | "credential";
export type AgentRequestStatus =
  | "pending"
  | "submitting"
  | "answered"
  | "allowed"
  | "denied"
  | "expired"
  | "cancelled"
  | "failed";
export type ApprovalDecision = "allow-once" | "allow-session" | "allow-always" | "deny";

export interface AgentRequestQuestionView {
  id: string;
  header?: string;
  text: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  allowOther: boolean;
  secret: boolean;
  url?: string;
  store?: { name: string; allowedHosts?: string[]; reason?: string; replacesSinceMs?: number };
}

export interface AgentRequestApprovalView {
  title?: string;
  description?: string;
  detail?: string;
  command?: string;
  /** Too long to show whole: only `deny` is offered. */
  clipped?: boolean;
  warning?: string;
  host?: string;
  nodeId?: string;
  severity?: "info" | "warning" | "critical";
  toolName?: string;
  pluginId?: string;
  scope?: {
    kind: "message-send" | "payment" | "external-post" | "standing-grant";
    summary: string;
    external?: boolean;
    grantDays?: number;
  };
  decisions: ApprovalDecision[];
}

/** One row of `agentRequests.listForChat`. */
export interface AgentRequestView {
  _id: string;
  messageId: string | null;
  source: string;
  kind: AgentRequestKind;
  agentId: string | null;
  status: AgentRequestStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  resolvedElsewhere: boolean;
  answeredByMe: boolean;
  seq: number | null;
  /** The Hermes queue this request waits in (instance + session), or null. */
  queueKey: string | null;
  /** Answered by its own id (a Hermes server→client request): no queue order applies. */
  answerById: boolean;
  questions: AgentRequestQuestionView[] | null;
  approval: AgentRequestApprovalView | null;
  credential: {
    prompt?: string;
    envVar?: string;
    command?: string;
    clipped?: boolean;
    commandMissing?: boolean;
    mode: "secret" | "password";
  } | null;
  answers: Array<{ id: string; values: string[] }> | null;
  decision: ApprovalDecision | null;
  failureCode: string | null;
  canAnswer: boolean;
}

/** The visual family: the three kinds, and a critical approval stands apart. */
export type AgentRequestTone = "question" | "approval" | "critical" | "credential";

export function requestTone(r: Pick<AgentRequestView, "kind" | "approval" | "questions">): AgentRequestTone {
  if (r.kind === "credential") return "credential";
  if (r.kind === "question") {
    // A secret QUESTION is a credential to the eye, whatever channel carried it.
    return r.questions?.some((q) => q.secret) ? "credential" : "question";
  }
  return r.approval?.severity === "critical" ? "critical" : "approval";
}

export function isOpen(status: AgentRequestStatus): boolean {
  return status === "pending" || status === "submitting";
}

/** Open AND still inside its deadline — what the dock and the badge count. */
export function isWaiting(r: Pick<AgentRequestView, "status" | "expiresAt">, now: number): boolean {
  return isOpen(r.status) && r.expiresAt > now;
}

/** Whether the card may show a countdown. A Hermes approval's deadline is the
 *  operator's setting (`approvals.timeout`), carried by no payload: the card closes when
 *  the agent moves again, and a countdown would be one Atrium made up. */
export function deadlineShown(r: Pick<AgentRequestView, "source"> & { answerById?: boolean }): boolean {
  // A Hermes server→client request carries no deadline — its timeout is the gateway's
  // config, and Hermes withdraws it itself (`request.cancel`): the stored one is only
  // Atrium's ceiling, and a countdown to it would be invented.
  return r.source !== "hermes.approval" && r.answerById !== true;
}

/** Time left, in the coarsest unit that still reads honestly. */
export function remaining(
  expiresAt: number,
  now: number,
): { unit: "expired" | "seconds" | "minutes" | "hours"; value: number; urgent: boolean } {
  const ms = expiresAt - now;
  if (ms <= 0) return { unit: "expired", value: 0, urgent: true };
  const s = Math.ceil(ms / 1000);
  if (s < 60) return { unit: "seconds", value: s, urgent: true };
  const min = Math.ceil(s / 60);
  if (min < 60) return { unit: "minutes", value: min, urgent: min <= 2 };
  return { unit: "hours", value: Math.round(min / 60), urgent: false };
}

/** The one line that stands for a request when it is folded (dock, panel, summary). */
export function oneLiner(r: Pick<AgentRequestView, "kind" | "questions" | "approval" | "credential">): string {
  if (r.kind === "question" || (r.kind === "credential" && r.questions)) {
    const first = r.questions?.[0];
    return first?.text ?? "";
  }
  if (r.kind === "approval") {
    const a = r.approval;
    return a?.title ?? a?.command ?? a?.description ?? "";
  }
  return r.credential?.prompt ?? r.credential?.envVar ?? "";
}

// ── Drafts ─────────────────────────────────────────────────────────────────────

/** What the person has typed or picked, per question. */
export interface QuestionDraft {
  selected: string[];
  other: string;
}

export type DraftProblem =
  | { code: "missing"; questionId: string }
  | { code: "too_long"; questionId: string };

export const MAX_ANSWER_CHARS = 8000;

export function emptyDraft(): QuestionDraft {
  return { selected: [], other: "" };
}

/** Toggle an option. A single-choice question REPLACES; a multi-choice one adds. Picking
 *  an option on a single-choice question clears a typed "other" (one answer only). */
export function toggleOption(
  q: Pick<AgentRequestQuestionView, "multiSelect">,
  draft: QuestionDraft,
  label: string,
): QuestionDraft {
  const has = draft.selected.includes(label);
  if (q.multiSelect) {
    return { ...draft, selected: has ? draft.selected.filter((l) => l !== label) : [...draft.selected, label] };
  }
  return { selected: has ? [] : [label], other: has ? draft.other : "" };
}

/** Typing an "other" answer on a single-choice question deselects the options. */
export function setOther(
  q: Pick<AgentRequestQuestionView, "multiSelect">,
  draft: QuestionDraft,
  text: string,
): QuestionDraft {
  return q.multiSelect ? { ...draft, other: text } : { selected: text.trim() === "" ? draft.selected : [], other: text };
}

/**
 * The answers the card would send, or the first problem. Same rules as the server:
 * every question answered, no empty value, a single-choice question gets one value.
 */
export function answersFromDrafts(
  questions: ReadonlyArray<AgentRequestQuestionView>,
  drafts: Readonly<Record<string, QuestionDraft>>,
):
  | { ok: true; answers: Array<{ id: string; values: string[] }> }
  | { ok: false; problem: DraftProblem } {
  const answers: Array<{ id: string; values: string[] }> = [];
  for (const q of questions) {
    const d = drafts[q.id] ?? emptyDraft();
    const other = q.secret ? d.other : d.other.trim();
    const values = [...d.selected];
    if ((q.allowOther || q.options.length === 0) && other !== "") values.push(other);
    const single = q.multiSelect ? values : values.slice(-1);
    if (single.length === 0) return { ok: false, problem: { code: "missing", questionId: q.id } };
    if (single.some((v) => v.length > MAX_ANSWER_CHARS)) {
      return { ok: false, problem: { code: "too_long", questionId: q.id } };
    }
    answers.push({ id: q.id, values: single });
  }
  return { ok: true, answers };
}

// ── Lists ──────────────────────────────────────────────────────────────────────

/** The dock's order: the request that expires soonest first. */
export function dockOrder(rows: ReadonlyArray<AgentRequestView>, now: number): AgentRequestView[] {
  return rows.filter((r) => isWaiting(r, now)).sort((a, b) => a.expiresAt - b.expiresAt);
}

/**
 * Hermes answers approvals by SESSION, oldest first: a later one cannot be decided
 * while an earlier one of the same session waits (Convex refuses it too). Returns
 * the request that must be answered first, or null.
 */
export function blockedBy(
  r: Pick<AgentRequestView, "_id" | "source" | "queueKey" | "seq" | "createdAt" | "answerById">,
  rows: ReadonlyArray<AgentRequestView>,
): AgentRequestView | null {
  // Addressed by its own id, a request decides exactly itself — no order binds it.
  if (r.source !== "hermes.approval" || r.answerById) return null;
  const mine = r.seq ?? r.createdAt;
  const earlier = rows
    .filter(
      (o) =>
        o._id !== r._id &&
        o.source === "hermes.approval" &&
      !o.answerById &&
        !o.answerById &&
        o.queueKey === r.queueKey &&
        // An earlier answer still on the wire blocks too: POSTs are not ordered.
        // Past its deadline but not yet swept, it still heads the queue for Convex:
        // the card agrees instead of offering an answer the server will refuse.
        (o.status === "pending" || o.status === "submitting") &&
        (o.seq ?? o.createdAt) < mine,
    )
    .sort((a, b) => (a.seq ?? a.createdAt) - (b.seq ?? b.createdAt));
  return earlier[0] ?? null;
}

/**
 * Several Hermes approvals of one session waiting at once: none can be decided from
 * here. Hermes decides the head of its queue by SESSION, not by id, and another client
 * can take one off that queue without Atrium hearing of it — the bridge refuses
 * (`approval_ambiguous`), so the card says it up front instead of after a click.
 */
export function severalHermesApprovals(
  r: Pick<AgentRequestView, "_id" | "source" | "queueKey" | "answerById">,
  rows: ReadonlyArray<AgentRequestView>,
): boolean {
  if (r.source !== "hermes.approval" || r.answerById) return false;
  return rows.some(
    (o) =>
      o._id !== r._id &&
      o.source === "hermes.approval" &&
      // One addressed by its own id is not in the session queue this rule is about.
      !o.answerById &&
      o.queueKey === r.queueKey &&
      (o.status === "pending" || o.status === "submitting"),
  );
}

/** Group a conversation's requests for the panel: waiting first, then the rest. */
export function panelSections(
  rows: ReadonlyArray<AgentRequestView>,
  now: number,
): { waiting: AgentRequestView[]; history: AgentRequestView[] } {
  const waiting = dockOrder(rows, now);
  const waitingIds = new Set(waiting.map((r) => r._id));
  const history = rows
    .filter((r) => !waitingIds.has(r._id))
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt));
  return { waiting, history };
}

/** The outcome word of a settled request, as a key the component localizes. */
export type OutcomeKey =
  | "answered"
  | "answered_elsewhere"
  | "skipped"
  | "allowed_once"
  | "allowed_session"
  | "allowed_always"
  | "allowed_elsewhere"
  | "denied"
  | "denied_elsewhere"
  | "expired"
  | "cancelled"
  | "failed";

export function outcomeOf(
  r: Pick<AgentRequestView, "status" | "decision" | "resolvedElsewhere" | "answeredByMe" | "expiresAt">,
  now: number,
): OutcomeKey | null {
  // Past its deadline, an open request is expired whatever the row still says: the
  // sweep that writes it runs once a minute, the reader's clock every second.
  if (isOpen(r.status) && r.expiresAt <= now) return "expired";
  switch (r.status) {
    case "answered":
      return r.resolvedElsewhere ? "answered_elsewhere" : "answered";
    case "allowed":
      if (r.resolvedElsewhere) return "allowed_elsewhere";
      return r.decision === "allow-always"
        ? "allowed_always"
        : r.decision === "allow-session"
          ? "allowed_session"
          : "allowed_once";
    case "denied":
      return r.resolvedElsewhere ? "denied_elsewhere" : "denied";
    case "expired":
      return "expired";
    case "cancelled":
      // Our own "skip" is a cancel the person chose; anything else ended the wait.
      return r.answeredByMe ? "skipped" : "cancelled";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** A failure code worth telling the person, and whether retrying can help. */
export function failureKind(code: string | null): "none" | "retry" | "config" {
  if (code === null) return "none";
  if (code === "not_configured" || code === "instance_not_served" || code === "provider_mismatch") {
    return "config";
  }
  return "retry";
}
