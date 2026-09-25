// AGENT REQUESTS — what an agent asks a person while it works, read from each
// provider's own frames into ONE neutral shape (the one Convex stores; see
// convex/lib/agentRequests.ts for the storage side and its bounds).
//
// Pure: no I/O, no clock. Every reader returns `null` for a frame it cannot read
// rather than guessing — a request the person answers must be exactly the one the
// agent asked.
//
// Upstream references (pinned sources):
//   OpenClaw v2026.9.5
//     questions  — packages/gateway-protocol/src/schema/questions.ts
//                  (QuestionRecord, QuestionResolvedEvent)
//     approvals  — packages/gateway-protocol/src/schema/approvals.ts
//                  (ApprovalSnapshot.presentation: exec | plugin | system-agent)
//                  src/gateway/server-methods/approval-shared.ts:55 (RequestedApprovalEvent
//                  {id, request, createdAtMs, expiresAtMs}), approval-publication.ts:69
//                  (resolved {id, decision, request, terminalStatus?})
//   Hermes 0.19.0 (v2026.7.20)
//     tui_gateway/server.py:1388 `_emit_approval_request` (command, description,
//     choices once|session|always|deny), :4367 clarify {question, choices},
//     :4467 secret {prompt, env_var, metadata?}, :4460 sudo {}, :2346 `_block`
//     (request_id), tools/approval.py:2493 approval timeout (60 s default).

export type AgentRequestSource =
  | "openclaw.ask_user"
  | "openclaw.exec"
  | "openclaw.plugin"
  | "openclaw.system_agent"
  | "openclaw.secret"
  | "hermes.clarify"
  | "hermes.approval"
  | "hermes.secret"
  | "hermes.sudo";

export type ApprovalDecision =
  | "allow-once"
  | "allow-session"
  | "allow-always"
  | "deny";

export interface AgentRequestQuestion {
  id: string;
  header?: string;
  text: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  allowOther: boolean;
  secret: boolean;
  url?: string;
  /** Where the gateway keeps a secret answer (OpenClaw `secretStore`): the NAME it is
   *  stored under and the hosts it may be sent to — what a person must see before
   *  handing a credential over. Never a value. */
  store?: AgentRequestSecretStore;
}

export interface AgentRequestSecretStore {
  name: string;
  allowedHosts?: string[];
  reason?: string;
  /** A value already stored under this name, and when (`secretStoreExisting`). */
  replacesSinceMs?: number;
}

export interface AgentRequestApproval {
  title?: string;
  description?: string;
  detail?: string;
  command?: string;
  warning?: string;
  host?: string;
  /** The node an exec runs on (`host: "node"`). */
  nodeId?: string;
  severity?: "info" | "warning" | "critical";
  toolName?: string;
  pluginId?: string;
  scope?: {
    kind: "message-send" | "payment" | "external-post" | "standing-grant";
    summary: string;
    /** A message going OUTSIDE the organisation — the riskier send. */
    external?: boolean;
    /** How long an allow-always standing grant lasts (absent = until revoked). */
    grantDays?: number;
  };
  decisions: ApprovalDecision[];
}

export interface AgentRequestCredential {
  prompt?: string;
  envVar?: string;
  /** The command a sudo password unlocks — redacted by Hermes before it is sent
   *  (tui_gateway/contracts/server_requests.py `SudoRequestParams`, 0.21.3+). */
  command?: string;
}

/** A request, as the bridge hands it to Convex. */
export interface AgentRequestRecord {
  chatId: string;
  /** The assistant bubble of the turn that asked, when this bridge drives it. */
  messageId?: string | null;
  agentId?: string;
  source: AgentRequestSource;
  providerRequestId: string;
  approvalKind?: "exec" | "plugin" | "system-agent";
  sessionKey?: string;
  runId?: string;
  seq?: number;
  /** Epoch ms. */
  expiresAt?: number;
  /** When the PROVIDER created the request (epoch ms). An id may come back: OpenClaw
   *  accepts a caller-chosen one and forgets a settled question after 15 s
   *  (question-manager.ts QUESTION_RESOLVED_ENTRY_GRACE_MS) — this tells the new one
   *  from a replay of the old. */
  providerCreatedAt?: number;
  /** Hermes approvals only: every approval of this chat's session ordered BEFORE this
   *  seq belongs to a run Hermes has ended — the turn asking was ACKed `streaming`, and
   *  Hermes acknowledges that only on an idle session, whose approval queue is empty
   *  (tools/approval.py `_await_gateway_decision` queues only while a run waits;
   *  tui_gateway/server.py `_handle_busy_submit` answers `queued`/`steered` otherwise).
   *  Convex closes those rows in the same write that records this one. */
  supersedesBeforeSeq?: number;
  /** Answered by its OWN id (a Hermes server→client request, `request.answer`), not by
   *  session order: no oldest-first rule applies, and several may be answered in any order. */
  answerById?: boolean;
  /** When THIS bridge saw the request, in its own strictly increasing order
   *  (`nextSightingSeq`) — the tie-break for a reused id whose provider creation time does
   *  not advance (a gateway clock that stood still or stepped back). */
  providerSeenSeq?: number;
  /** The bridge PROCESS that saw it (`SIGHTING_EPOCH`): seqs only compare within one. */
  providerSeenEpoch?: string;
  questions?: AgentRequestQuestion[];
  approval?: AgentRequestApproval;
  credential?: AgentRequestCredential;
}

export type AgentRequestTerminal =
  | "answered"
  | "allowed"
  | "denied"
  | "expired"
  | "cancelled";

/** A provider's verdict on one request. */
/** What an answer Hermes TOOK settles the card as — the status Convex records for it
 *  (convex/agentRequests.ts `prepareAnswer`: a skip cancels, a decision allows or denies). */
export type HermesAnsweredVerdict = "answered" | "allowed" | "denied" | "cancelled";

export interface AgentRequestSettle {
  chatId: string;
  providerRequestId: string;
  /** The generation settled (see AgentRequestRecord.providerCreatedAt): a late settle
   *  of an older request must never close a newer one under the same id. */
  providerCreatedAt?: number;
  /** Which family the id belongs to: a question and an approval may share an id. */
  family?: "question" | "approval";
  /** The question set settled (`questionShape`): two generations of a reused id may share
   *  one creation time, and a late settle must close the one it is about. */
  questionShape?: string;
  /** When the settled request was SEEN (`providerSeenSeq`): among generations alike in
   *  creation time and shape, the settle is about the newest one seen by then. */
  providerSeenSeq?: number;
  status: AgentRequestTerminal;
  answers?: Array<{ id: string; values: string[] }>;
  decision?: ApprovalDecision;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** A provider's own ADDRESS for a request — used verbatim, never trimmed or cut: the
 *  gateway matches it byte for byte, and " q" and "q" are two requests there (codex
 *  P1). Bounded, refused beyond: an id we could not store whole could not be answered. */
export const MAX_PROVIDER_ID_CHARS = 512;
function providerId(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" && v.length <= MAX_PROVIDER_ID_CHARS ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

const QUESTION_ID_RE = /^[a-z][a-z0-9_]*$/;

// ── OpenClaw: questions ────────────────────────────────────────────────────────

export const OPENCLAW_QUESTION_EVENTS = new Set(["question.requested", "question.resolved"]);

export interface OpenClawQuestion {
  id: string;
  sessionKey: string | null;
  agentId: string | null;
  runId: string | null;
  expiresAtMs: number | null;
  createdAtMs: number | null;
  /** A secret question is SHOWN as a credential (masked, never stored). */
  secret: boolean;
  questions: AgentRequestQuestion[];
}

/**
 * A `question.requested` payload (the QuestionRecord). Only `pending` records are
 * requests; a record the gateway already settled is not something to show.
 */
export function readOpenClawQuestionRequested(payload: unknown): OpenClawQuestion | null {
  const p = obj(payload);
  if (p === null) return null;
  const id = providerId(p.id);
  if (id === undefined || !Array.isArray(p.questions)) return null;
  if (p.status !== undefined && p.status !== "pending") return null;
  const questions: AgentRequestQuestion[] = [];
  for (const raw of p.questions.slice(0, 3)) {
    const q = obj(raw);
    if (q === null) continue;
    const qid = typeof q.questionId === "string" && QUESTION_ID_RE.test(q.questionId) ? q.questionId : null;
    const text = str(q.question);
    if (qid === null || text === undefined) continue;
    const options: AgentRequestQuestion["options"] = [];
    const rawOptionCount = Array.isArray(q.options) ? q.options.length : 0;
    if (Array.isArray(q.options)) {
      for (const rawOpt of q.options.slice(0, 4)) {
        const o = obj(rawOpt);
        // VERBATIM: the label is also the answer value, and the gateway canonicalizes an
        // answer back to the option's own bytes (question-manager.ts:365-366) — a trimmed
        // copy would be answered, then settled as a different answer (codex P2).
        const label = o === null ? undefined : verbatimLabel(o.label);
        if (label === undefined) continue;
        const description = str(o!.description);
        options.push(description === undefined ? { label } : { label, description });
      }
    }
    const header = str(q.header);
    const url = str(q.url);
    const store = readSecretStore(q.secretStore, q.secretStoreExisting);
    if (store === null) return null;
    questions.push({
      id: qid,
      ...(header !== undefined ? { header } : {}),
      text,
      options,
      multiSelect: q.multiSelect === true,
      // Upstream `isOther`: free text besides the options. No options AT ALL — as asked,
      // not as kept — IS free text (question-manager.ts:367 only checks options when
      // there are some); a closed question with an unreadable option stays closed.
      allowOther: rawOptionCount === 0 || q.isOther === true,
      // A store-bound question is a secret by construction: upstream resolves it by
      // writing the one value to the store (server-methods/question.ts).
      secret: q.isSecret === true || store !== undefined,
      ...(url !== undefined ? { url } : {}),
      ...(store !== undefined ? { store } : {}),
    });
  }
  if (questions.length === 0) return null;
  return {
    id,
    sessionKey: str(p.sessionKey) ?? null,
    agentId: str(p.agentId) ?? null,
    runId: str(p.runId) ?? null,
    expiresAtMs: num(p.expiresAtMs) ?? null,
    createdAtMs: num(p.createdAtMs) ?? null,
    secret: questions.some((q) => q.secret),
    questions,
  };
}

/** A `question.resolved` payload: {id, status: answered|cancelled|expired, answers?}. */
const STORE_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

/** `QuestionSecretStoreBinding` + `QuestionSecretStoreExisting` (schema/questions.ts).
 *  `null` = a binding present but not readable in full: the question cannot be shown
 *  truthfully (where the secret goes, to which hosts), so the request is not recorded. */
function readSecretStore(binding: unknown, existing: unknown): AgentRequestSecretStore | undefined | null {
  if (binding === undefined) return undefined;
  const b = obj(binding);
  if (b === null) return null;
  const name = typeof b.name === "string" && STORE_NAME_RE.test(b.name) ? b.name : null;
  if (name === null) return null;
  let hosts: string[] | undefined;
  if (b.allowedHosts !== undefined) {
    // Every host, exactly: the gateway applies the full list (upstream bound: 128).
    if (!Array.isArray(b.allowedHosts) || b.allowedHosts.length > 128) return null;
    hosts = [];
    for (const h of b.allowedHosts) {
      if (typeof h !== "string" || h === "" || h.length > 253 || h.trim() !== h) return null;
      hosts.push(h);
    }
  }
  const reason = str(b.reason);
  const since = num(obj(existing)?.updatedAtMs);
  return {
    name,
    ...(hosts !== undefined && hosts.length > 0 ? { allowedHosts: hosts } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(since !== undefined ? { replacesSinceMs: since } : {}),
  };
}

export function readOpenClawQuestionResolved(
  payload: unknown,
): { id: string; status: "answered" | "cancelled" | "expired"; answers?: Array<{ id: string; values: string[] }> } | null {
  const p = obj(payload);
  if (p === null) return null;
  const id = providerId(p.id);
  const status = p.status;
  if (id === undefined) return null;
  if (status !== "answered" && status !== "cancelled" && status !== "expired") return null;
  if (status !== "answered") return { id, status };
  // `answered` REQUIRES its answers (QuestionResolvedEvent): without them, readable
  // whole, the event is not read — never an empty answer invented, never a turn
  // released on a resolution we cannot state (codex P2).
  const container = obj(obj(p.answers)?.answers);
  if (container === null) return null;
  const answers: Array<{ id: string; values: string[] }> = [];
  for (const [qid, values] of Object.entries(container)) {
    if (!QUESTION_ID_RE.test(qid) || !Array.isArray(values)) return null;
    if (!values.every((v): v is string => typeof v === "string")) return null;
    answers.push({ id: qid, values: [...values] });
  }
  return { id, status, answers };
}

// ── OpenClaw: approvals ────────────────────────────────────────────────────────

export const OPENCLAW_APPROVAL_REQUESTED_EVENTS: ReadonlyMap<string, "exec" | "plugin" | "system-agent"> =
  new Map([
    ["exec.approval.requested", "exec"],
    ["plugin.approval.requested", "plugin"],
    ["openclaw.approval.requested", "system-agent"],
  ]);

export const OPENCLAW_APPROVAL_RESOLVED_EVENTS: ReadonlyMap<string, "exec" | "plugin" | "system-agent"> =
  new Map([
    ["exec.approval.resolved", "exec"],
    ["plugin.approval.resolved", "plugin"],
    ["openclaw.approval.resolved", "system-agent"],
  ]);

export interface OpenClawApprovalAnnounce {
  id: string;
  kind: "exec" | "plugin" | "system-agent";
  sessionKey: string | null;
  agentId: string | null;
  runId: string | null;
  expiresAtMs: number | null;
}

/**
 * The broadcast `{id, request, createdAtMs, expiresAtMs}`. Read ONLY for routing —
 * which session asked, and until when. What the card shows comes from
 * `approval.get`'s reviewer-safe presentation, never from this raw request (whose
 * exec branch carries cwd, env binding and the unredacted plan).
 */
export function readOpenClawApprovalRequested(
  event: string,
  payload: unknown,
): OpenClawApprovalAnnounce | null {
  const kind = OPENCLAW_APPROVAL_REQUESTED_EVENTS.get(event);
  if (kind === undefined) return null;
  const p = obj(payload);
  if (p === null) return null;
  const id = providerId(p.id);
  if (id === undefined) return null;
  const request = obj(p.request);
  return {
    id,
    kind,
    sessionKey: str(request?.sessionKey) ?? null,
    agentId: str(request?.agentId) ?? null,
    runId: str(request?.runId) ?? null,
    expiresAtMs: num(p.expiresAtMs) ?? null,
  };
}

/**
 * The resolved broadcast: {id, decision, resolvedBy, request?, terminalStatus?}.
 *
 * A `deny` here is AMBIGUOUS for exec and plugin approvals: upstream publishes an
 * EXPIRED approval as `{decision: "deny"}` too (`record.decision ?? "deny"`), and adds
 * `terminalStatus` only for system-agent ones (server-methods/approval-publication.ts).
 * `denyUnconfirmed` says so; the caller confirms with the terminal snapshot.
 */
export function readOpenClawApprovalResolved(
  event: string,
  payload: unknown,
): {
  id: string;
  status: AgentRequestTerminal;
  decision?: ApprovalDecision;
  /** A deny that may be an expiry: confirm before recording "denied". */
  denyUnconfirmed?: true;
  /** Who resolved it on the gateway (null for a timeout). */
  resolvedBy?: string | null;
} | null {
  if (!OPENCLAW_APPROVAL_RESOLVED_EVENTS.has(event)) return null;
  const p = obj(payload);
  if (p === null) return null;
  const id = providerId(p.id);
  if (id === undefined) return null;
  if (p.terminalStatus === "expired") return { id, status: "expired" };
  if (p.terminalStatus === "cancelled") return { id, status: "cancelled" };
  const decision = p.decision;
  if (decision === "allow-once" || decision === "allow-always") {
    return { id, status: "allowed", decision };
  }
  // `deny`, or a decision we cannot read (upstream fails closed on it too).
  return {
    id,
    status: "denied",
    decision: "deny",
    denyUnconfirmed: true,
    resolvedBy: typeof p.resolvedBy === "string" && p.resolvedBy !== "" ? p.resolvedBy : null,
  };
}

/** The terminal status an `approval.get` snapshot records, when it has one. */
export function readOpenClawApprovalTerminalStatus(
  getResult: unknown,
): "allowed" | "denied" | "expired" | "cancelled" | null {
  const status = obj(obj(getResult)?.approval)?.status;
  return status === "allowed" || status === "denied" || status === "expired" || status === "cancelled"
    ? status
    : null;
}

const SCOPE_KINDS = new Set(["message-send", "payment", "external-post", "standing-grant"]);

/** One line naming an owner-declared blast radius, in neutral words the UI localizes
 *  around (the values are the owner's own: a target, an amount, a count). */
function scopeSummary(scope: Obj): string | undefined {
  switch (scope.kind) {
    case "message-send": {
      const target = str(scope.target);
      const count = num(scope.recipientCount);
      const recipients = Array.isArray(scope.recipients)
        ? scope.recipients.filter((r): r is string => typeof r === "string").slice(0, 5)
        : [];
      const who = recipients.length > 0 ? recipients.join(", ") : undefined;
      return [target, count !== undefined ? `×${count}` : undefined, who]
        .filter((x) => x !== undefined)
        .join(" · ") || undefined;
    }
    case "payment": {
      const amount = str(scope.amount);
      const currency = str(scope.currency);
      const target = str(scope.target);
      return [amount && currency ? `${amount} ${currency}` : amount, target]
        .filter((x) => x !== undefined)
        .join(" → ") || undefined;
    }
    case "external-post": {
      const target = str(scope.target);
      const visibility = str(scope.visibility);
      return [target, visibility].filter((x) => x !== undefined).join(" · ") || undefined;
    }
    case "standing-grant": {
      const automation = str(scope.automation);
      const command = str(scope.command);
      return [automation, command].filter((x) => x !== undefined).join(" · ") || undefined;
    }
    default:
      return undefined;
  }
}

function readDecisions(raw: unknown): ApprovalDecision[] {
  const out: ApprovalDecision[] = [];
  if (Array.isArray(raw)) {
    for (const d of raw) {
      if ((d === "allow-once" || d === "allow-always" || d === "deny") && !out.includes(d)) {
        out.push(d);
      }
    }
  }
  if (!out.includes("deny")) out.push("deny");
  return out;
}

/**
 * The reviewer-safe PRESENTATION from an `approval.get` snapshot (unified approvals,
 * v2026.7+). Returns null for a snapshot that is not pending — there is nothing left
 * to ask — or whose presentation we cannot read.
 */
export function readOpenClawApprovalPresentation(
  getResult: unknown,
): { approval: AgentRequestApproval; expiresAtMs: number | null; createdAtMs: number | null } | null {
  const snapshot = obj(obj(getResult)?.approval) ?? obj(getResult);
  if (snapshot === null || snapshot.status !== "pending") return null;
  const pres = obj(snapshot.presentation);
  if (pres === null) return null;
  const expiresAtMs = num(snapshot.expiresAtMs) ?? null;
  const createdAtMs = num(snapshot.createdAtMs) ?? null;
  const decisions = readDecisions(pres.allowedDecisions);
  const scopeObj = obj(pres.scope);
  const summary = scopeObj !== null ? scopeSummary(scopeObj) : undefined;
  const grantDays = scopeObj?.kind === "standing-grant" ? num(scopeObj.expiresInDays) : undefined;
  const scope =
    scopeObj !== null && typeof scopeObj.kind === "string" && SCOPE_KINDS.has(scopeObj.kind) && summary !== undefined
      ? {
          kind: scopeObj.kind as NonNullable<AgentRequestApproval["scope"]>["kind"],
          summary,
          ...(scopeObj.kind === "message-send" && scopeObj.audience === "external" ? { external: true } : {}),
          ...(grantDays !== undefined && grantDays > 0 ? { grantDays } : {}),
        }
      : undefined;
  switch (pres.kind) {
    case "exec": {
      // `commandText` — what the allow authorises. Never `commandPreview`: upstream calls
      // it an optional SHORTER preview (exec-approval-command-display.ts), and a card
      // showing less than the command lets someone approve what they never saw.
      const command = str(pres.commandText);
      if (command === undefined) return null;
      const warning = str(pres.warningText);
      const host = str(pres.host);
      // WHERE it runs: `host: "node"` alone makes a command bound for production and
      // one bound for a test node look the same (codex P1).
      const nodeId = str(pres.nodeId);
      return {
        expiresAtMs,
        createdAtMs,
        approval: {
          command,
          ...(warning !== undefined ? { warning } : {}),
          ...(host !== undefined ? { host } : {}),
          ...(nodeId !== undefined ? { nodeId } : {}),
          ...(scope !== undefined ? { scope } : {}),
          decisions,
        },
      };
    }
    case "plugin": {
      const title = str(pres.title);
      const description = str(pres.description);
      if (title === undefined && description === undefined) return null;
      const detail = str(pres.detail);
      const severity =
        pres.severity === "info" || pres.severity === "warning" || pres.severity === "critical"
          ? pres.severity
          : undefined;
      const toolName = str(pres.toolName);
      const pluginId = str(pres.pluginId);
      return {
        expiresAtMs,
        createdAtMs,
        approval: {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(detail !== undefined ? { detail } : {}),
          ...(severity !== undefined ? { severity } : {}),
          ...(toolName !== undefined ? { toolName } : {}),
          ...(pluginId !== undefined ? { pluginId } : {}),
          ...(scope !== undefined ? { scope } : {}),
          decisions,
        },
      };
    }
    case "system-agent": {
      const title = str(pres.title);
      const description = str(pres.description);
      if (title === undefined && description === undefined) return null;
      return {
        expiresAtMs,
        createdAtMs,
        approval: {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          // Upstream offers exactly allow-once | deny for a system change.
          decisions: decisions.filter((d) => d === "allow-once" || d === "deny"),
        },
      };
    }
    default:
      return null;
  }
}

/** Atrium's decision in the unified resolver's vocabulary (`approval.resolve`). A
 *  session scope does not exist on OpenClaw, so it is never offered there. */
export function openClawDecision(decision: ApprovalDecision): "allow-once" | "allow-always" | "deny" {
  return decision === "allow-session" ? "allow-once" : decision;
}

/** The answer body `question.resolve` takes. */
export function openClawQuestionAnswers(
  answers: ReadonlyArray<{ id: string; values: string[] }>,
): { answers: Record<string, string[]> } {
  const out: Record<string, string[]> = {};
  for (const a of answers) {
    if (QUESTION_ID_RE.test(a.id)) out[a.id] = [...a.values];
  }
  return { answers: out };
}

// ── Hermes ─────────────────────────────────────────────────────────────────────

const HERMES_CHOICE_TO_DECISION: Readonly<Record<string, ApprovalDecision>> = {
  once: "allow-once",
  session: "allow-session",
  always: "allow-always",
  deny: "deny",
};

const HERMES_DECISION_TO_CHOICE: Readonly<Record<ApprovalDecision, string>> = {
  "allow-once": "once",
  "allow-session": "session",
  "allow-always": "always",
  deny: "deny",
};

/** Atrium's decision in Hermes' `approval.respond` vocabulary. */
export function hermesChoice(decision: ApprovalDecision): string {
  return HERMES_DECISION_TO_CHOICE[decision];
}

/**
 * `approval.request`. `choices` is set by the gateway (server.py:1394-1401); absent,
 * the same rules are applied here so the card never offers a scope Hermes would not.
 */
export function readHermesApproval(payload: unknown): AgentRequestApproval | null {
  const p = obj(payload);
  if (p === null) return null;
  const command = str(p.command);
  const description = str(p.description);
  if (command === undefined && description === undefined) return null;
  let choices: string[];
  if (Array.isArray(p.choices)) {
    choices = p.choices.filter((c): c is string => typeof c === "string");
  } else if (p.smart_denied === true) {
    choices = ["once", "deny"];
  } else if (p.allow_permanent === false) {
    choices = ["once", "session", "deny"];
  } else {
    choices = ["once", "session", "always", "deny"];
  }
  const decisions: ApprovalDecision[] = [];
  for (const c of choices) {
    const d = HERMES_CHOICE_TO_DECISION[c];
    if (d !== undefined && !decisions.includes(d)) decisions.push(d);
  }
  if (!decisions.includes("deny")) decisions.push("deny");
  return {
    ...(command !== undefined ? { command } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(p.smart_denied === true ? { severity: "critical" as const } : {}),
    decisions,
  };
}


/** The most questions one Hermes clarify batch carries (tools/clarify_tool.py MAX_QUESTIONS). */
export const HERMES_CLARIFY_MAX_QUESTIONS = 5;

/**
 * What makes a question set THE SAME request for answering: its question ids, which are
 * secret, which take several values, its option labels (verbatim — they are the answer
 * values), WHERE a secret goes (the store's name and hosts — the gateway applies the
 * binding attached at answer time, codex P1) and everything the card SHOWS (header, text,
 * option descriptions, link, store reason — a reused id asking "delete production?" under
 * the words "delete staging?" is another question, codex P1). Shown text enters as the
 * card shows it, through `shownText`, which mirrors Convex's `clip` and is idempotent: a
 * copy Convex already bounded keeps its shape. Mirrors convex/lib/agentRequests.ts
 * `questionShape` exactly (pinned by the same literal in both suites).
 */
export function questionShape(
  questions: ReadonlyArray<
    Pick<
      AgentRequestQuestion,
      "id" | "secret" | "multiSelect" | "options" | "store" | "header" | "text" | "url"
    >
  >,
): string {
  return JSON.stringify(
    questions.map((q) => [
      q.id,
      q.secret === true,
      q.multiSelect === true,
      q.options.map((o) => o.label),
      q.store !== undefined ? [q.store.name, q.store.allowedHosts ?? []] : null,
      [
        shownText(q.header, SHOWN_HEADER) ?? null,
        shownText(q.text, SHOWN_TEXT) ?? null,
        q.options.map((o) => shownText(o.description, SHOWN_DESCRIPTION) ?? null),
        shownUrl(q.url) ?? null,
        shownText(q.store?.reason, SHOWN_STORE_REASON) ?? null,
      ],
    ]),
  );
}

// The bounds Convex shows a question under (convex/lib/agentRequests.ts boundQuestions).
const SHOWN_HEADER = 40;
const SHOWN_TEXT = 4000;
const SHOWN_DESCRIPTION = 600;
const SHOWN_URL = 2048;
const SHOWN_STORE_REASON = 200;

/** Convex's `clip`, byte for byte: what the card shows of a text. */
function shownText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Convex's `safeUrl`: only an http(s) link is shown as one. */
function shownUrl(value: unknown): string | undefined {
  const url = shownText(value, SHOWN_URL);
  if (url === undefined) return undefined;
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : undefined;
}

/** The longest option label kept — the answer bound; mirrors convex/lib/agentRequests.ts
 *  `MAX_OPTION_LABEL`, so both sides keep the same options and compute the same shape. */
const MAX_OPTION_LABEL = 8000;

/** An option label as the provider wrote it — never trimmed (it is also the answer value
 *  sent back), refused when blank or past the answer bound, never cut. */
function verbatimLabel(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" && v.length <= MAX_OPTION_LABEL ? v : undefined;
}

/** The options of one Hermes clarify question (at most four, as upstream renders them). */
function hermesClarifyOptions(choices: unknown): Array<{ label: string }> {
  return Array.isArray(choices)
    ? choices
        .map((c) => (typeof c === "string" ? verbatimLabel(c) : verbatimLabel(obj(c)?.label)))
        .filter((c): c is string => c !== undefined)
        .slice(0, 4)
        .map((label) => ({ label }))
    : [];
}

/**
 * A Hermes clarify — the event `clarify.request {question, choices?}` (≤ 0.19) or the
 * server request `clarify` (0.21.3+), which adds `multi_select` and a BATCH form
 * `questions: [{qid, question, choices?, multi_select}]` (tui_gateway/contracts/
 * server_requests.py). A single question keeps the id `answer`; a batch keeps each `qid`,
 * the key its answers go back under. Hermes accepts any text, so free text stays open.
 */
export function readHermesClarify(payload: unknown): AgentRequestQuestion[] | null {
  const p = obj(payload);
  if (p === null) return null;
  if (Array.isArray(p.questions) && p.questions.length > 0) {
    // Upstream's own bound (tools/clarify_tool.py MAX_QUESTIONS), which Convex applies too:
    // a batch past it would be taken here, refused there, and hang with no card at all.
    if (p.questions.length > HERMES_CLARIFY_MAX_QUESTIONS) return null;
    const out: AgentRequestQuestion[] = [];
    for (const raw of p.questions) {
      const q = obj(raw);
      const qid = providerId(q?.qid);
      const text = str(q?.question);
      // One unreadable entry makes the batch unanswerable as a whole — its answers are
      // keyed by qid, and a set missing one is not the set Hermes asked for.
      if (q === null || qid === undefined || text === undefined) return null;
      const options = hermesClarifyOptions(q.choices);
      out.push({
        id: qid,
        text,
        options,
        multiSelect: q.multi_select === true && options.length > 0,
        allowOther: true,
        secret: false,
      });
    }
    return out;
  }
  const text = str(p.question);
  if (text === undefined) return null;
  const options = hermesClarifyOptions(p.choices);
  return [
    {
      id: "answer",
      text,
      options,
      multiSelect: p.multi_select === true && options.length > 0,
      allowOther: true,
      secret: false,
    },
  ];
}

/**
 * The clarify question ids Hermes itself parses as MULTI-select: `multi_select` with
 * choices (tools/clarify_tool.py — `multi_select and choices is not None` for one question,
 * `bool(multi_select) and bool(choices)` in a batch). Read from what Hermes SENT, not from
 * the options we kept: its answer is split on commas unless it is a JSON array
 * (`_parse_multi_select_response`), whatever the card showed.
 */
export function hermesClarifyMultiIds(payload: unknown): ReadonlySet<string> {
  const p = obj(payload);
  const ids = new Set<string>();
  if (p === null) return ids;
  const multi = (q: Record<string, unknown>): boolean =>
    q.multi_select === true &&
    Array.isArray(q.choices) &&
    q.choices.some((c) => typeof c === "string" && c.trim() !== "");
  if (Array.isArray(p.questions) && p.questions.length > 0) {
    for (const raw of p.questions) {
      const q = obj(raw);
      const qid = providerId(q?.qid);
      if (q !== null && qid !== undefined && multi(q)) ids.add(qid);
    }
    return ids;
  }
  if (multi(p)) ids.add("answer");
  return ids;
}

/** `secret.request {prompt, env_var}` / `sudo.request {}`. */
export function readHermesCredential(type: string, payload: unknown): AgentRequestCredential {
  const p = obj(payload) ?? {};
  if (type === "sudo.request") {
    // The person must SEE what the password unlocks: a card asking for it blind is the
    // approval without its command. The 0.19 event carried none; 0.21 sends it redacted.
    const command = str(p.command);
    return command !== undefined ? { command } : {};
  }
  const prompt = str(p.prompt);
  const envVar = str(p.env_var);
  return {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(envVar !== undefined ? { envVar } : {}),
  };
}

/** The `request_id` `_block` stamps on every prompt it can be answered by. */
export function hermesRequestId(payload: unknown): string | null {
  return providerId(obj(payload)?.request_id) ?? null;
}
