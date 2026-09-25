// ANSWER an agent's request — the bridge half of `/agent-request/respond`.
//
// Convex has already decided WHO may answer and WHETHER the answer is well formed
// (convex/agentRequests.ts). What is left is the provider, and what it says back:
//
//   OpenClaw — a short operator connection, the same as `/abort`: `question.get` /
//              `approval.get` first (is it still pending? is it THIS session's?),
//              then `question.resolve` / `approval.resolve`. Both resolvers are
//              addressed by id and routed by the gateway itself.
//   Hermes   — the instance's WS client: `clarify.respond` / `secret.respond` /
//              `sudo.respond` by `request_id`, `approval.respond` by SESSION (it
//              resolves the head of that session's queue — Convex only sends the
//              oldest one).
//
// The outcome is a small closed vocabulary Convex acts on: `ok`, `request_gone`
// (with the provider's own status when it says one), `invalid_answer`,
// `session_mismatch`, or a transport code. Provider prose never crosses.
//
// A SECRET passes through this file and nowhere else: it is placed in the RPC params
// and dropped. Never logged, never echoed.

import {
  hermesChoice,
  openClawDecision,
  openClawQuestionAnswers,
  questionShape,
  readOpenClawQuestionRequested,
  type AgentRequestSource,
  type ApprovalDecision,
  type HermesAnsweredVerdict,
} from "./core/agent-requests.js";
import { payloadOf, type GatewayRpc } from "./agent-request-rpc.js";

export interface RespondBody {
  chatId: string;
  instanceName: string;
  provider: "openclaw" | "hermes";
  source: AgentRequestSource;
  providerRequestId: string;
  /** The generation answered (the provider's creation time), when known. */
  providerCreatedAt?: number;
  approvalKind?: "exec" | "plugin" | "system-agent";
  sessionKey?: string;
  skip: boolean;
  answers?: Array<{ id: string; values: string[] }>;
  decision?: ApprovalDecision;
  secret?: string;
  /** A Hermes server→client request, answered by its own id (`request.answer`). */
  answerById?: boolean;
  /** The question set the card SHOWS (`questionShape`), checked against the one the
   *  gateway still asks under this id before answering. */
  questionShape?: string;
}

export type RespondOutcome =
  | { ok: true }
  | {
      ok: false;
      httpStatus: number;
      code: string;
      /** The provider's own verdict on a request that no longer waits. */
      status?: "answered" | "allowed" | "denied" | "expired" | "cancelled";
    };

const SOURCES = new Set<AgentRequestSource>([
  "openclaw.ask_user",
  "openclaw.exec",
  "openclaw.plugin",
  "openclaw.system_agent",
  "openclaw.secret",
  "hermes.clarify",
  "hermes.approval",
  "hermes.secret",
  "hermes.sudo",
]);
const DECISIONS = new Set<ApprovalDecision>(["allow-once", "allow-session", "allow-always", "deny"]);
const MAX_VALUE = 8000;
/** A question shape is ids, flags and at most 5 × 4 labels of <= 8000 chars. */
const MAX_SHAPE = 200_000;
/** Mirrors convex/lib/agentRequests.ts MAX_ANSWER_VALUES. */
const MAX_ANSWER_VALUES = 8;

/** Parse and bound the POST body. Null for anything malformed. */
export function parseRespondBody(raw: string): RespondBody | null {
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const chatId = str(o.chatId);
  const instanceName = str(o.instanceName);
  const providerRequestId = str(o.providerRequestId);
  const source = str(o.source) as AgentRequestSource | undefined;
  if (!chatId || !instanceName || !providerRequestId || !source || !SOURCES.has(source)) {
    return null;
  }
  const provider = source.startsWith("openclaw.") ? "openclaw" : "hermes";
  if (o.provider !== undefined && o.provider !== provider) return null;
  let answers: RespondBody["answers"];
  if (Array.isArray(o.answers)) {
    answers = [];
    if (o.answers.length > 5) return null;
    for (const a of o.answers) {
      if (typeof a !== "object" || a === null) return null;
      const id = (a as { id?: unknown }).id;
      const values = (a as { values?: unknown }).values;
      if (typeof id !== "string" || !Array.isArray(values)) return null;
      if (!values.every((v) => typeof v === "string" && v.length <= MAX_VALUE)) return null;
      // REFUSED past the bound, never cut: Convex stores what it sent, and a relayed
      // subset would record an answer the agent never received (codex P3).
      if (values.length > MAX_ANSWER_VALUES) return null;
      answers.push({ id, values: values as string[] });
    }
  }
  const decision =
    typeof o.decision === "string" && DECISIONS.has(o.decision as ApprovalDecision)
      ? (o.decision as ApprovalDecision)
      : undefined;
  const approvalKind =
    o.approvalKind === "exec" || o.approvalKind === "plugin" || o.approvalKind === "system-agent"
      ? o.approvalKind
      : undefined;
  const secret =
    typeof o.secret === "string" && o.secret.length > 0 && o.secret.length <= MAX_VALUE
      ? o.secret
      : undefined;
  return {
    chatId,
    instanceName,
    provider,
    source,
    providerRequestId,
    ...(approvalKind !== undefined ? { approvalKind } : {}),
    ...(str(o.sessionKey) !== undefined ? { sessionKey: str(o.sessionKey)! } : {}),
    ...(typeof o.providerCreatedAt === "number" && Number.isFinite(o.providerCreatedAt)
      ? { providerCreatedAt: o.providerCreatedAt }
      : {}),
    skip: o.skip === true,
    ...(answers !== undefined ? { answers } : {}),
    ...(decision !== undefined ? { decision } : {}),
    ...(secret !== undefined ? { secret } : {}),
    ...(o.answerById === true ? { answerById: true } : {}),
    ...(typeof o.questionShape === "string" && o.questionShape.length <= MAX_SHAPE
      ? { questionShape: o.questionShape }
      : {}),
  };
}

const GONE_WORDS: ReadonlyArray<[RegExp, "answered" | "expired" | "cancelled"]> = [
  [/is already answered/i, "answered"],
  [/is already expired/i, "expired"],
  [/is already cancelled/i, "cancelled"],
  [/was not found/i, "expired"],
  [/no longer active/i, "cancelled"],
];

/** A question.* rejection read into our vocabulary (question-manager.ts:117-392). */
function classifyQuestionError(err: unknown): RespondOutcome {
  const msg = (err as Error)?.message ?? String(err);
  for (const [re, status] of GONE_WORDS) {
    if (re.test(msg)) return { ok: false, httpStatus: 409, code: "request_gone", status };
  }
  if (/requires an answer|empty answer|multiple answers|unknown option|not part of this request|requires exactly one secret/i.test(msg)) {
    return { ok: false, httpStatus: 422, code: "invalid_answer" };
  }
  return transportFailure(msg);
}

function transportFailure(msg: string): RespondOutcome {
  if (/timed out|timeout/i.test(msg)) return { ok: false, httpStatus: 504, code: "gateway_timeout" };
  if (/closed|ECONN|socket|network|not connected/i.test(msg)) {
    return { ok: false, httpStatus: 502, code: "gateway_unreachable" };
  }
  return { ok: false, httpStatus: 502, code: "gateway_error" };
}

/** Is the gateway's record the SAME request the card was raised for? */
function sameGeneration(cardCreatedAt: number | undefined, recordCreatedAt: unknown): boolean {
  if (cardCreatedAt === undefined || typeof recordCreatedAt !== "number") return false;
  return cardCreatedAt === recordCreatedAt;
}

/** The agent a session key names (`agent:<id>:…`), compared with the one an approval
 *  names. */
function sameAgent(sessionKey: string | undefined, agentId: unknown): boolean {
  if (sessionKey === undefined || typeof agentId !== "string" || agentId === "") return false;
  const m = /^agent:([^:]+):/i.exec(sessionKey);
  if (m === null) return false;
  return m[1]!.toLowerCase() === agentId.toLowerCase();
}

// The re-checks below FAIL CLOSED: every field they read is required by the upstream
// schema for the requests Atrium records, so a missing one is a malformed or foreign
// record — never a reason to resolve (codex P2).
function sameSession(a: string | undefined, b: unknown): boolean {
  if (a === undefined || typeof b !== "string") return false;
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** The chat's LIVE session in this bridge process, when there is one. */
export interface OpenClawLiveSession {
  sessionKey: string;
  instanceName: string;
  /** Its socket: a closed one is a husk awaiting the reaper, reading nothing (codex P1,
   *  0.21.5 pass 25). */
  connection: { readonly isClosed: boolean };
}

/** OpenClaw: re-check at the gateway, then resolve — on the operator connection. */
export async function respondOpenClaw(
  body: RespondBody,
  gateway: GatewayRpc,
  /** The chat's live socket routed this approval here (its broadcast named this exact
   *  session). The proof used when the approval names no agent to compare. */
  routedHere: boolean,
  /** The chat's live session here. The resolution goes on a short operator connection
   *  that ingests nothing: what the agent does once released is read by THIS session's
   *  socket. With none on the request's session (a bridge restart), the run would resume
   *  with nobody to show, finalize or stop what follows — refused, as for Hermes (codex
   *  P1, 0.21.5 pass 23). A question comes back once the session is live again (its
   *  `question.list` replay raises what still waits); an approval, which the gateway
   *  offers no replay for, runs out its own timeout there. */
  live: OpenClawLiveSession | undefined,
): Promise<RespondOutcome> {
  if (
    live === undefined ||
    live.connection.isClosed ||
    live.instanceName !== body.instanceName ||
    !sameSession(body.sessionKey, live.sessionKey)
  ) {
    return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
  }
  const isQuestion = body.source === "openclaw.ask_user" || body.source === "openclaw.secret";
  if (isQuestion) {
    let record: Record<string, unknown> | null = null;
    try {
      const got = payloadOf(await gateway.request("question.get", { id: body.providerRequestId })) as {
        question?: unknown;
      } | null;
      record = typeof got?.question === "object" && got.question !== null
        ? (got.question as Record<string, unknown>)
        : null;
    } catch (err) {
      return classifyQuestionError(err);
    }
    if (record === null) return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
    // The id is the gateway's; the chat is ours. They must name the same session, or
    // an answer typed in one conversation would settle another's question.
    if (!sameSession(body.sessionKey, record.sessionKey)) {
      return { ok: false, httpStatus: 403, code: "session_mismatch" };
    }
    // Same id, another request: the gateway forgets a settled question after 15 s and
    // takes caller-chosen ids, so the card's generation must be the one still asked.
    if (!sameGeneration(body.providerCreatedAt, record.createdAtMs)) {
      return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
    }
    if (record.status !== "pending") {
      const s = record.status;
      return {
        ok: false,
        httpStatus: 409,
        code: "request_gone",
        status: s === "answered" || s === "cancelled" || s === "expired" ? s : "expired",
      };
    }
    // …and the same QUESTION: a reused id under a clock that stood still carries the same
    // creation time and another question — the card must not answer it (codex P1).
    if (body.questionShape !== undefined) {
      const asked = readOpenClawQuestionRequested(record);
      if (asked === null || questionShape(asked.questions) !== body.questionShape) {
        return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
      }
    }
    try {
      const res = payloadOf(
        body.skip
          ? await gateway.request("question.resolve", {
              id: body.providerRequestId,
              cancel: true,
              resolvedBy: "atrium",
            })
          : await gateway.request("question.resolve", {
              id: body.providerRequestId,
              answers: openClawQuestionAnswers(body.answers ?? []),
              resolvedBy: "atrium",
            }),
      ) as { status?: unknown } | null;
      // Success is the verdict we asked for (QuestionResolveResult); anything else is a
      // reply we cannot read, not a confirmation.
      if (res?.status !== (body.skip ? "cancelled" : "answered")) {
        return { ok: false, httpStatus: 502, code: "gateway_error" };
      }
      return { ok: true };
    } catch (err) {
      return classifyQuestionError(err);
    }
  }

  // Approvals: exec | plugin | system-agent, all through the unified resolver.
  if (body.decision === undefined || body.approvalKind === undefined) {
    return { ok: false, httpStatus: 400, code: "invalid_answer" };
  }
  try {
    const got = payloadOf(await gateway.request("approval.get", { id: body.providerRequestId })) as {
      approval?: { status?: unknown; createdAtMs?: unknown; presentation?: { agentId?: unknown } };
    } | null;
    if (!sameGeneration(body.providerCreatedAt, got?.approval?.createdAtMs)) {
      return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
    }
    // The id is the gateway's; the chat is ours — the same re-check as for a question.
    // A PENDING snapshot names no session (`sourceSessionKey` is set only on the
    // session-scoped projection; absent from every approval.get captured live on
    // 2026.9.5), but it names the AGENT that asked. An exec or plugin approval whose
    // agent is not this conversation's is never resolved from here. A system-agent
    // approval is raised by the gateway's own system agent, whatever the chat.
    // An exec approval may name NO agent (upstream allows `agentId: null`); it is then
    // answerable only on the proof that this chat's own socket routed it here.
    const presentedAgent = got?.approval?.presentation?.agentId;
    const agentChecked =
      typeof presentedAgent === "string" && presentedAgent !== ""
        ? sameAgent(body.sessionKey, presentedAgent)
        : routedHere;
    if (body.approvalKind !== "system-agent" && !agentChecked) {
      return { ok: false, httpStatus: 403, code: "session_mismatch" };
    }
    const status = got?.approval?.status;
    if (status !== "pending") {
      return {
        ok: false,
        httpStatus: 409,
        code: "request_gone",
        status:
          status === "allowed" || status === "denied" || status === "expired" || status === "cancelled"
            ? status
            : "expired",
      };
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (/not found|unknown approval/i.test(msg)) {
      return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
    }
    return transportFailure(msg);
  }
  try {
    const res = payloadOf(
      await gateway.request("approval.resolve", {
        id: body.providerRequestId,
        kind: body.approvalKind,
        decision: openClawDecision(body.decision),
      }),
    ) as { applied?: unknown; approval?: { status?: unknown } } | null;
    if (res?.applied === false) {
      // First answer wins: someone else decided first. Their verdict is the record.
      const s = res.approval?.status;
      return {
        ok: false,
        httpStatus: 409,
        code: "request_gone",
        status: s === "allowed" || s === "denied" || s === "expired" || s === "cancelled" ? s : "expired",
      };
    }
    // Only `applied: true` confirms OUR decision was recorded; an unreadable reply is
    // not one (a retry then reads the approval's real state first).
    if (res?.applied !== true) return { ok: false, httpStatus: 502, code: "gateway_error" };
    return { ok: true };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (/not found|unknown approval|already/i.test(msg)) {
      return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
    }
    if (/decision.*not allowed|invalid decision/i.test(msg)) {
      return { ok: false, httpStatus: 422, code: "invalid_answer" };
    }
    return transportFailure(msg);
  }
}

type HermesCall = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Hermes: its responders, in their own addressing (server.py:11276-11318). */
/** A Hermes prompt responder's reply (`_respond`, tui_gateway/server.py): `{status:"ok"}`
 *  is the one confirmation, `{status:"expired"}` a prompt already gone; any other shape
 *  confirms nothing (codex P2) — never read as success. */
function promptReply(res: Record<string, unknown>): RespondOutcome {
  if (res.status === "ok") return { ok: true };
  if (res.status === "expired") {
    return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
  }
  return { ok: false, httpStatus: 502, code: "gateway_error" };
}

function answeredVerdict(body: RespondBody): HermesAnsweredVerdict {
  if (body.skip) return "cancelled";
  if (body.decision !== undefined) return body.decision === "deny" ? "denied" : "allowed";
  return "answered";
}

/** The live turn's view of a Hermes session's approval queue (ws-turn.ts). */
export interface HermesApprovalQueue {
  head(): string | null;
  /** Why no head is named while approvals wait. */
  ambiguity(): "order_unknown" | "several" | null;
  /** Hermes took a decision for `id`: it left the head. */
  answered(id: string): void;
  /** A decision's fate is unknown (the call failed: maybe applied, maybe never sent).
   *  The queue's order is then unknown too, and NO decision may be sent until the agent
   *  moves again — any head we would name could be the wrong one. */
  uncertain(): void;
  /** Hermes took the answer to request `id` (as `verdict`, when it was ours): it no longer
   *  holds the turn. */
  served?(id: string, verdict?: HermesAnsweredVerdict): void;
  /** Server→client request `id` as the live turn holds it; null when it holds none. */
  held?(id: string): { multiSelect: ReadonlySet<string> } | null;
  /** Whether the live turn raised request `id` and it is still unsettled. */
  holds?(id: string): boolean;
}

/** One clarify answer as Hermes reads it: a multi-select one ALWAYS as the JSON array its
 *  parser takes first (tools/clarify_tool.py `_parse_multi_select_response` splits any
 *  other string on commas — one choice "New York, NY" would reach the agent as two, codex
 *  P2); any other verbatim. */
function clarifyText(values: ReadonlyArray<string>, multi: boolean): string {
  return multi || values.length > 1 ? JSON.stringify(values) : (values[0] ?? "");
}

/** The `result` a server→client request is answered with (tui_gateway/contracts/
 *  server_requests.py), or null for a body that cannot answer it. */
function serverRequestResult(
  body: RespondBody,
  multiSelect: ReadonlySet<string>,
): Record<string, unknown> | null {
  switch (body.source) {
    case "hermes.approval":
      return body.decision === undefined ? null : { choice: hermesChoice(body.decision) };
    case "hermes.clarify": {
      const answers = body.answers ?? [];
      const batch = answers.some((a) => a.id !== "answer");
      if (body.skip) return batch ? {} : { answer: "" }; // `{}` on a batch is a cancel-all
      if (!batch) return { answer: clarifyText(answers[0]?.values ?? [], multiSelect.has("answer")) };
      return {
        answers: Object.fromEntries(
          answers.map((a) => [a.id, clarifyText(a.values, multiSelect.has(a.id))]),
        ),
      };
    }
    case "hermes.secret":
    case "hermes.sudo":
      // Skipping answers "": upstream reads it as a skip (secret) or a refusal (sudo).
      return { value: body.skip ? "" : (body.secret ?? "") };
    default:
      return null;
  }
}

export async function respondHermes(
  body: RespondBody,
  call: HermesCall,
  /** The chat's LIVE turn, when there is one. Hermes answers approvals by SESSION —
   *  `approval.respond` decides whatever heads the queue — so a decision is sent only
   *  when the card answered IS that head. A card for an approval Hermes has moved past
   *  (timed out, answered elsewhere, already answered by a request whose reply was
   *  lost) would otherwise decide the NEXT one (codex P1 ×2). No live turn: Hermes
   *  cleared its prompts when the run ended, nothing can be pending. */
  queue?: HermesApprovalQueue,
  /** What Hermes already TOOK for a request of this chat, live turn or not. */
  answeredAs?: (id: string) => HermesAnsweredVerdict | null,
): Promise<RespondOutcome> {
  try {
    // Already TAKEN by Hermes in this turn — our earlier reply was lost on the way back,
    // and the card reopened. Said as what it is: the request is over, answered; never
    // "expired", which it was not (codex P2, 0.21.5 pass 26).
    const already = answeredAs?.(body.providerRequestId) ?? null;
    if (already !== null) {
      return { ok: false, httpStatus: 409, code: "request_gone", status: already };
    }
    if (body.answerById === true) {
      // Addressed by its OWN id: exactly the request the card shows, whatever else waits.
      // Only while the chat's LIVE turn holds it: Hermes keeps open requests across
      // reconnects and resolves `request.answer` by id alone, so after a bridge restart an
      // answer would release a run no reader here observes — a command approved, a secret
      // handed over, with nobody to show or stop what follows (codex P1).
      const held = queue?.held?.(body.providerRequestId) ?? null;
      if (held === null) {
        return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
      }
      // `request.answer` says whether it was still open (`ok`) or had already ended.
      const result = serverRequestResult(body, held.multiSelect);
      if (result === null) return { ok: false, httpStatus: 400, code: "invalid_answer" };
      const out = promptReply(
        await call("request.answer", { id: body.providerRequestId, result }),
      );
      if (out.ok) queue?.served?.(body.providerRequestId, answeredVerdict(body));
      else if (out.code === "request_gone") queue?.served?.(body.providerRequestId);
      return out;
    }
    // A ≤ 0.19 prompt is resolved by `request_id` alone (`_respond`, tui_gateway/server.py)
    // and a RUNNING session outlives its socket (`_ws_session_is_orphaned`): after a bridge
    // restart an answer would release a run no reader here observes — a secret handed
    // over, a password given, with nobody to show what follows. Sent only while the chat's
    // live turn holds the prompt (codex P1, 0.21.5 pass 19).
    if (
      (body.source === "hermes.clarify" ||
        body.source === "hermes.secret" ||
        body.source === "hermes.sudo") &&
      queue?.holds?.(body.providerRequestId) !== true
    ) {
      return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
    }
    switch (body.source) {
      case "hermes.approval": {
        if (body.sessionKey === undefined || body.decision === undefined) {
          return { ok: false, httpStatus: 400, code: "invalid_answer" };
        }
        if (queue === undefined) {
          return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
        }
        const head = queue.head();
        if (head === null) {
          // Not gone — not decidable from here: the order is unknown after a failed call,
          // or several approvals wait at once and Hermes decides by session, not by id.
          const why = queue.ambiguity();
          if (why === "order_unknown") {
            return { ok: false, httpStatus: 409, code: "approval_order_unknown" };
          }
          if (why === "several") {
            return { ok: false, httpStatus: 409, code: "approval_ambiguous" };
          }
          return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
        }
        if (head !== body.providerRequestId) {
          return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
        }
        let res: Record<string, unknown>;
        try {
          res = await call("approval.respond", {
            session_id: body.sessionKey,
            choice: hermesChoice(body.decision),
          });
        } catch (err) {
          // Applied or never sent — no way to tell from here. Either guess would let a
          // later click decide the wrong approval (codex P1, both directions).
          queue.uncertain();
          throw err;
        }
        // `{resolved: <count>}` is the ONLY reply that says what happened
        // (tui_gateway/server.py `approval.respond`). Anything else leaves the decision's
        // fate unknown — and so the queue's order (codex P1).
        if (typeof res.resolved !== "number") {
          queue.uncertain();
          return { ok: false, httpStatus: 502, code: "gateway_error" };
        }
        // Decided or found gone: either way it no longer heads Hermes' queue. 0 means
        // the queue was already empty — the approval timed out (Hermes denies on its
        // own at `approvals.timeout`) or was answered elsewhere.
        queue.answered(body.providerRequestId);
        if (res.resolved < 1) {
          return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
        }
        // Taken: a retry after a lost reply is told so, as what it was (0.21.5 pass 27).
        queue.served?.(body.providerRequestId, answeredVerdict(body));
        return { ok: true };
      }
      case "hermes.clarify": {
        // Skipping IS the empty answer: `_block` returns "" and the agent proceeds.
        const answer = body.skip ? "" : (body.answers?.[0]?.values ?? []).join(", ");
        const res = await call("clarify.respond", { request_id: body.providerRequestId, answer });
        const out = promptReply(res);
        if (out.ok) queue?.served?.(body.providerRequestId, answeredVerdict(body));
        return out;
      }
      case "hermes.secret":
      case "hermes.sudo": {
        const key = body.source === "hermes.sudo" ? "password" : "value";
        // Skipping a secret answers "": upstream's secret callback reads it as a
        // graceful skip. A sudo prompt skipped the same way fails the command, which
        // is exactly what "no" means there.
        const value = body.skip ? "" : (body.secret ?? "");
        const res = await call(
          body.source === "hermes.sudo" ? "sudo.respond" : "secret.respond",
          { request_id: body.providerRequestId, [key]: value },
        );
        const out = promptReply(res);
        if (out.ok) queue?.served?.(body.providerRequestId, answeredVerdict(body));
        return out;
      }
      default:
        return { ok: false, httpStatus: 400, code: "invalid_answer" };
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    // `_respond` → 4009 "no pending <key> request" once the prompt is gone.
    if (/no pending/i.test(msg)) {
      return { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
    }
    return transportFailure(msg);
  }
}
