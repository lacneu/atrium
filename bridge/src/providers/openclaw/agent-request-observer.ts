// OpenClaw AGENT REQUESTS, observed on a conversation's socket.
//
// Questions (`question.requested` / `question.resolved`) and approvals
// (`{exec,plugin,openclaw}.approval.{requested,resolved}`) are BROADCASTS: every
// operator socket with the scope receives them for every session on the gateway. So
// this observer's first job is isolation — a request is recorded for THIS chat only
// when it names THIS chat's session key — and its second is to turn what it keeps
// into three effects:
//
//   1. the Convex row the person sees and answers (writer.upsertAgentRequest);
//   2. the provider's verdict on it (writer.settleAgentRequest);
//   3. the TURN's knowledge that a human holds it, so the silence clock and the
//      finishing grace stop treating the wait as a dead run (RunManager).
//
// No `sessions.messages.subscribe` here, although it would deliver sanitized
// approvals per session: a subscription on the conversation socket has already
// cost the live bench frames the turn depends on (session.ts, "NO sessions.subscribe
// on THIS connection"). The broadcasts arrive on this socket regardless; what the
// card SHOWS comes from `approval.get`, the gateway's reviewer-safe projection.

import {
  OPENCLAW_APPROVAL_REQUESTED_EVENTS,
  OPENCLAW_APPROVAL_RESOLVED_EVENTS,
  OPENCLAW_QUESTION_EVENTS,
  readOpenClawApprovalPresentation,
  readOpenClawApprovalRequested,
  readOpenClawApprovalResolved,
  readOpenClawApprovalTerminalStatus,
  readOpenClawQuestionRequested,
  readOpenClawQuestionResolved,
  questionShape,
  type AgentRequestRecord,
  type AgentRequestSettle,
} from "../../core/agent-requests.js";
import { SIGHTING_EPOCH, nextSightingSeq } from "../../core/sighting-order.js";
import { payloadOf, type GatewayRpc } from "../../agent-request-rpc.js";

export interface AgentRequestObserverDeps {
  chatId: string;
  sessionKey: string;
  agentId: string;
  /** This chat's gateway socket. Called with LITERAL method names only, so the RPC
   *  scope ratchet (test/rpc-scope.test.ts) sees every method this observer sends. */
  gateway: GatewayRpc;
  upsert: ((record: AgentRequestRecord) => Promise<unknown>) | undefined;
  settle: ((settle: AgentRequestSettle) => Promise<void>) | undefined;
  /** The active turn's bubble, when this chat is driving one. */
  currentMessageId: () => string | null;
  noteQuestion: (id: string, expiresInSec: number | null) => Promise<boolean>;
  noteQuestionSettled: (id: string) => Promise<void>;
  noteApprovalSettled: (id: string) => Promise<void>;
  /** Wake the consume loop: deadlines were armed off-loop. */
  wake: () => void;
  /** Epoch ms (the gateway's deadlines are epoch). */
  nowMs: () => number;
}

/** A gateway RPC timeout for the reads this observer makes. Short: they are local
 *  lookups on the gateway, and a slow one only delays a card. */
const OBSERVER_RPC_TIMEOUT_MS = 10_000;
/** Bounded memory of the requests this session has seen (resolved broadcasts of
 *  questions carry no session key — the id is the only link). */
const MAX_KNOWN = 256;
/** Keys of this observer's per-request memory. A question and an approval may carry
 *  the SAME id (each family takes caller-chosen ones): they are never confused (codex P2). */
const qKey = (id: string): string => `q:${id}`;
const aKey = (id: string): string => `a:${id}`;

/** Waits before re-reading an approval whose `approval.get` failed. */
const APPROVAL_READ_RETRY_MS = [1_000, 3_000];
/** Wait before the one deferred retry of an approval whose card could not be recorded. */
const APPROVAL_RETRY_LATER_MS = 15_000;
/** Wait before re-reading pending questions after a card could not be recorded. */
const QUESTION_REPLAY_LATER_MS = 15_000;

type Kind = "question" | "approval";

/** A write Convex answered and REFUSED (`recorded: false`: no card exists) is a failed
 *  write — forgotten and tried again later like any other, never taken as recorded while
 *  the turn waits on a card nobody can see (codex P2). */
function throwIfNotRecorded(written: unknown): void {
  if (
    typeof written === "object" &&
    written !== null &&
    (written as { recorded?: unknown }).recorded === false
  ) {
    throw new Error("the agent request was not recorded");
  }
}

export class OpenClawAgentRequestObserver {
  private readonly known = new Map<string, Kind>();

  constructor(private readonly deps: AgentRequestObserverDeps) {}

  /** Does this frame name OUR session? Exact, with a case-insensitive fallback: the
   *  gateway canonicalizes stored keys, and a key that differs only in case is the
   *  same session on its side. The chat id is a segment of the key either way, so
   *  this never admits another conversation. */
  private ours(sessionKey: string | null): boolean {
    if (sessionKey === null) return false;
    return (
      sessionKey === this.deps.sessionKey ||
      sessionKey.toLowerCase() === this.deps.sessionKey.toLowerCase()
    );
  }

  private remember(id: string, kind: Kind): void {
    this.known.delete(id);
    this.known.set(id, kind);
    while (this.known.size > MAX_KNOWN) {
      const oldest = this.known.keys().next().value;
      if (oldest === undefined) break;
      this.known.delete(oldest);
    }
  }

  /** Whether a frame is one this observer handles (cheap, synchronous). */
  static handles(frame: unknown): boolean {
    const event = eventName(frame);
    return (
      event !== null &&
      (OPENCLAW_QUESTION_EVENTS.has(event) ||
        OPENCLAW_APPROVAL_REQUESTED_EVENTS.has(event) ||
        OPENCLAW_APPROVAL_RESOLVED_EVENTS.has(event))
    );
  }

  /**
   * Observe one frame. Never throws and never blocks the consume loop on the network:
   * the Convex writes and the `approval.get` read run detached with their own catch.
   * The TURN hold is awaited — it is local and it decides the next deadline.
   */
  async observe(frame: unknown): Promise<void> {
    const event = eventName(frame);
    if (event === null) return;
    const payload = (frame as { payload?: unknown }).payload;
    try {
      if (event === "question.requested") {
        await this.onQuestion(payload);
      } else if (event === "question.resolved") {
        await this.onQuestionResolved(payload);
      } else if (OPENCLAW_APPROVAL_REQUESTED_EVENTS.has(event)) {
        this.onApproval(event, payload);
      } else if (OPENCLAW_APPROVAL_RESOLVED_EVENTS.has(event)) {
        await this.onApprovalResolved(event, payload);
      }
    } catch (err) {
      console.error(
        `[agent-request] ${event} handling failed chat=${this.deps.chatId}:`,
        (err as Error)?.message ?? err,
      );
    }
  }

  /**
   * Re-read what is still pending after a (re)connect: a question asked while this
   * socket was down is otherwise invisible until it expires. `question.list` is
   * filtered by the gateway to what this client may see; we keep our session only.
   */
  async replayPending(): Promise<void> {
    try {
      const res = payloadOf(
        await this.deps.gateway.request("question.list", {}, OBSERVER_RPC_TIMEOUT_MS),
      );
      const list = (res as { questions?: unknown } | null)?.questions;
      if (!Array.isArray(list)) return;
      for (const record of list) {
        await this.onQuestion(record);
      }
    } catch (err) {
      // An older gateway without the method, or a transient failure: the live
      // broadcasts still work — this only closes the reconnect window.
      console.log(
        `[agent-request] question replay skipped chat=${this.deps.chatId}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async onQuestion(payload: unknown): Promise<void> {
    const q = readOpenClawQuestionRequested(payload);
    if (q === null || !this.ours(q.sessionKey)) return;
    // A known id with a DIFFERENT creation time is a new question under a reused id
    // (the gateway forgets a settled one in 15 s) whose `resolved` we may have missed:
    // recorded afresh, with ITS secret questions (codex P1).
    const knownGeneration = this.generations.get(qKey(q.id));
    // …and a known id carrying ANOTHER question — the same creation time under a clock that
    // stood still — is a new question too: taken for a replay, its secrets would be
    // masked by the OLD question's (none) and stored in clear (codex P1).
    // The shape carries everything the card shows, texts included.
    const content = questionShape(q.questions);
    const firstSighting =
      !this.known.has(qKey(q.id)) ||
      (q.createdAtMs !== null && knownGeneration !== undefined && knownGeneration !== q.createdAtMs) ||
      (this.contents.has(qKey(q.id)) && this.contents.get(qKey(q.id))?.shape !== content);
    this.remember(qKey(q.id), "question");
    const expiresInSec =
      q.expiresAtMs !== null ? Math.max(0, (q.expiresAtMs - this.deps.nowMs()) / 1000) : null;
    if (await this.deps.noteQuestion(q.id, expiresInSec)) this.deps.wake();
    if (!firstSighting) return;
    const seenSeq = nextSightingSeq();
    const record: AgentRequestRecord = {
      chatId: this.deps.chatId,
      messageId: this.deps.currentMessageId(),
      agentId: q.agentId ?? this.deps.agentId,
      source: q.secret ? "openclaw.secret" : "openclaw.ask_user",
      providerRequestId: q.id,
      sessionKey: q.sessionKey ?? this.deps.sessionKey,
      ...(q.runId !== null ? { runId: q.runId } : {}),
      ...(q.expiresAtMs !== null ? { expiresAt: q.expiresAtMs } : {}),
      ...(q.createdAtMs !== null ? { providerCreatedAt: q.createdAtMs } : {}),
      providerSeenSeq: seenSeq,
      providerSeenEpoch: SIGHTING_EPOCH,
      questions: q.questions,
    };
    this.noteGeneration(qKey(q.id), q.createdAtMs);
    this.noteContent(qKey(q.id), content, seenSeq);
    const sighting = this.newSighting(qKey(q.id));
    const secret = new Set(q.questions.filter((x) => x.secret).map((x) => x.id));
    if (secret.size > 0) this.secretQuestionIds.set(qKey(q.id), secret);
    else this.secretQuestionIds.delete(qKey(q.id));
    this.noteWrite(
      qKey(q.id),
      Promise.resolve(this.deps.upsert?.(record)).then(throwIfNotRecorded).catch((err) => {
        // Not recorded (the writer's own retries are spent): forgotten, so the replay
        // on the next (re)connect — `question.list` — records it (codex P2). Only while
        // this sighting is still the id's: a NEWER generation asked since owns the
        // entries now, and must not lose them to this one's failure (codex P1).
        if (this.ownsSighting(qKey(q.id), sighting)) {
          this.known.delete(qKey(q.id));
          this.generations.delete(qKey(q.id));
        }
        // The broadcast is not repeated while this socket stays up: re-read what is
        // still pending, later, instead of waiting for a reconnect (codex P2).
        this.scheduleReplay();
        console.error(
          `[agent-request] question write failed chat=${this.deps.chatId}:`,
          (err as Error)?.message ?? err,
        );
      }),
    );
  }

  /** Did THIS socket route approval `id` to this conversation — i.e. did the gateway's
   *  broadcast name this chat's exact session? The answer path's proof when the
   *  approval itself names no agent to check. */
  routedApproval(id: string): boolean {
    return this.known.get(aKey(id)) === "approval";
  }

  private replayScheduled = false;
  /** One deferred `question.list` replay at a time (it records only what still waits). */
  private scheduleReplay(): void {
    if (this.replayScheduled) return;
    this.replayScheduled = true;
    const timer = setTimeout(() => {
      this.replayScheduled = false;
      void this.replayPending();
    }, QUESTION_REPLAY_LATER_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  /** Approvals already given their one deferred retry. */
  private readonly retriedApprovals = new Set<string>();

  /** Each request's creation, so its settle is posted AFTER it: an unordered settle
   *  finds no row, and the late creation then stands `pending` for a request that is
   *  already over (codex P1). Bounded like `known`. */
  private readonly writes = new Map<string, Promise<unknown>>();
  /** The generation each recorded request was created with, for its settle. */
  private readonly generations = new Map<string, number>();
  private noteGeneration(id: string, createdAt: number | null): void {
    if (createdAt === null) return;
    this.generations.set(id, createdAt);
    if (this.generations.size > 512) {
      const oldest = this.generations.keys().next().value;
      if (oldest !== undefined) this.generations.delete(oldest);
    }
  }
  /** Each recorded question request's SECRET question ids: their answers never leave
   *  the bridge, not even toward Convex, which would only drop them (codex P2). */
  private readonly secretQuestionIds = new Map<string, Set<string>>();
  /** Take a request's secret ids NOW — synchronously, at its `resolved`. Taken later (after
   *  its creation write), they could be a NEWER generation's under the same id, consumed
   *  here and missing when that one settles with its secret in clear (codex P1). */
  private takeSecrets(id: string): Set<string> | undefined {
    const secret = this.secretQuestionIds.get(id);
    this.secretQuestionIds.delete(id);
    return secret;
  }
  private withoutSecrets(
    secret: Set<string> | undefined,
    answers: Array<{ id: string; values: string[] }> | undefined,
  ): { answers?: Array<{ id: string; values: string[] }> } {
    if (answers === undefined) return {};
    return { answers: answers.map((a) => (secret?.has(a.id) ? { id: a.id, values: [] } : a)) };
  }
  /** What each recorded question request ASKED (`questionShape`) and when this process
   *  SAW it, to tell a reused id carrying another question from a replay of the same one —
   *  and to name, at its settle, WHICH generation settled. Bounded like `known`. */
  private readonly contents = new Map<string, { shape: string; seq: number }>();
  private noteContent(id: string, shape: string, seq: number): void {
    this.contents.delete(id);
    this.contents.set(id, { shape, seq });
    if (this.contents.size > 512) {
      const oldest = this.contents.keys().next().value;
      if (oldest !== undefined) this.contents.delete(oldest);
    }
  }
  /** One token per sighting of an id: a late failure of an OLDER sighting must not clear
   *  what a newer one recorded under the same id (a reused question id, codex P1). */
  private readonly sightings = new Map<string, symbol>();
  private newSighting(id: string): symbol {
    const token = Symbol(id);
    this.sightings.delete(id);
    this.sightings.set(id, token);
    if (this.sightings.size > 512) {
      const oldest = this.sightings.keys().next().value;
      if (oldest !== undefined) this.sightings.delete(oldest);
    }
    return token;
  }
  private ownsSighting(id: string, token: symbol): boolean {
    return this.sightings.get(id) === token;
  }

  private takeGeneration(id: string): { providerCreatedAt?: number } {
    const g = this.generations.get(id);
    this.generations.delete(id);
    return g === undefined ? {} : { providerCreatedAt: g };
  }
  private noteWrite(id: string, write: Promise<unknown>): void {
    this.writes.set(id, write);
    if (this.writes.size > 512) {
      const oldest = this.writes.keys().next().value;
      if (oldest !== undefined) this.writes.delete(oldest);
    }
  }
  private afterWrite(id: string): Promise<unknown> {
    const write = this.writes.get(id) ?? Promise.resolve();
    this.writes.delete(id);
    return write.catch(() => undefined);
  }

  private async onQuestionResolved(payload: unknown): Promise<void> {
    const r = readOpenClawQuestionResolved(payload);
    // The resolved broadcast names no session: only an id we saw asked HERE is ours.
    if (r === null || this.known.get(qKey(r.id)) !== "question") return;
    // Settled: forgotten, so the SAME id asked again later is seen as the new question
    // it is (a caller may choose ids, and the gateway forgets a settled one in 15 s).
    this.known.delete(qKey(r.id));
    const generation = this.takeGeneration(qKey(r.id));
    const seen = this.contents.get(qKey(r.id));
    this.contents.delete(qKey(r.id));
    const secret = this.takeSecrets(qKey(r.id));
    await this.deps.noteQuestionSettled(r.id);
    this.deps.wake();
    void this.afterWrite(qKey(r.id))
      .then(() =>
        this.deps.settle?.({
          chatId: this.deps.chatId,
          providerRequestId: r.id,
          family: "question",
          ...generation,
          ...(seen !== undefined ? { questionShape: seen.shape, providerSeenSeq: seen.seq } : {}),
          status: r.status,
          ...this.withoutSecrets(secret, r.answers),
        }),
      )
      .catch((err) =>
        console.error(
          `[agent-request] question settle failed chat=${this.deps.chatId}:`,
          (err as Error)?.message ?? err,
        ),
      );
  }

  private onApproval(event: string, payload: unknown): void {
    const a = readOpenClawApprovalRequested(event, payload);
    if (a === null || !this.ours(a.sessionKey) || this.known.has(aKey(a.id))) return;
    this.remember(aKey(a.id), "approval");
    const sighting = this.newSighting(aKey(a.id));
    const seenSeq = nextSightingSeq();
    // Captured NOW: by the time `approval.get` answers, the turn may have moved on.
    const messageId = this.deps.currentMessageId();
    const write = (async () => {
      // The broadcast is not repeated and there is no approval replay: a read that
      // fails once would lose the card for good (codex P2). Retried, then forgotten —
      // a later sighting of the same id may try again.
      let got: unknown;
      for (let attempt = 0; ; attempt += 1) {
        try {
          got = payloadOf(
            await this.deps.gateway.request("approval.get", { id: a.id }, OBSERVER_RPC_TIMEOUT_MS),
          );
          break;
        } catch (err) {
          if (attempt >= APPROVAL_READ_RETRY_MS.length) {
            if (this.ownsSighting(aKey(a.id), sighting)) this.known.delete(aKey(a.id));
            throw err;
          }
          await new Promise((r) => setTimeout(r, APPROVAL_READ_RETRY_MS[attempt]));
        }
      }
      const presented = readOpenClawApprovalPresentation(got);
      if (presented === null) return; // already settled, or nothing we can show
      const expiresAt = presented.expiresAtMs ?? a.expiresAtMs;
      const written = await this.deps.upsert?.({
        chatId: this.deps.chatId,
        messageId,
        agentId: a.agentId ?? this.deps.agentId,
        source:
          a.kind === "exec"
            ? "openclaw.exec"
            : a.kind === "plugin"
              ? "openclaw.plugin"
              : "openclaw.system_agent",
        providerRequestId: a.id,
        approvalKind: a.kind,
        sessionKey: a.sessionKey ?? this.deps.sessionKey,
        ...(a.runId !== null ? { runId: a.runId } : {}),
        ...(expiresAt !== null ? { expiresAt } : {}),
        ...(presented.createdAtMs !== null ? { providerCreatedAt: presented.createdAtMs } : {}),
        providerSeenSeq: seenSeq,
        providerSeenEpoch: SIGHTING_EPOCH,
        approval: presented.approval,
      });
      throwIfNotRecorded(written);
      this.noteGeneration(aKey(a.id), presented.createdAtMs);
    })().catch((err) => {
      // Not recorded: forgotten, and tried ONCE more later — an approval has no replay
      // upstream, and its broadcast is not repeated (codex P2). Only while this sighting
      // is still the id's (see `newSighting`).
      if (this.ownsSighting(aKey(a.id), sighting)) {
        this.known.delete(aKey(a.id));
        this.generations.delete(aKey(a.id));
      }
      if (!this.retriedApprovals.has(a.id)) {
        this.retriedApprovals.add(a.id);
        const timer = setTimeout(() => this.onApproval(event, payload), APPROVAL_RETRY_LATER_MS);
        (timer as { unref?: () => void }).unref?.();
      }
      console.error(
        `[agent-request] approval read failed chat=${this.deps.chatId}:`,
        (err as Error)?.message ?? err,
      );
    });
    this.noteWrite(aKey(a.id), write);
  }

  /**
   * Was that `deny` a person's, or an approval that simply ran out? The broadcast says
   * `deny` for both (see readOpenClawApprovalResolved); the terminal snapshot says
   * which. Unreadable: a timeout resolves with NO resolver, a person with one.
   */
  private async confirmDeny(
    id: string,
    resolvedBy: string | null,
  ): Promise<"denied" | "expired" | "cancelled"> {
    try {
      const got = payloadOf(
        await this.deps.gateway.request("approval.get", { id }, OBSERVER_RPC_TIMEOUT_MS),
      );
      const status = readOpenClawApprovalTerminalStatus(got);
      if (status === "expired" || status === "cancelled" || status === "denied") return status;
    } catch {
      /* fall through to the resolver rule */
    }
    return resolvedBy === null ? "expired" : "denied";
  }

  private async onApprovalResolved(event: string, payload: unknown): Promise<void> {
    const r = readOpenClawApprovalResolved(event, payload);
    if (r === null) return;
    const requestSession = sessionKeyOfRequest(payload);
    if (this.known.get(aKey(r.id)) !== "approval" && !this.ours(requestSession)) return;
    await this.deps.noteApprovalSettled(r.id);
    this.deps.wake();
    void this.afterWrite(aKey(r.id))
      .then(async () => {
        const verdict = r.denyUnconfirmed ? await this.confirmDeny(r.id, r.resolvedBy ?? null) : null;
        const status = verdict ?? r.status;
        return this.deps.settle?.({
          chatId: this.deps.chatId,
          providerRequestId: r.id,
          family: "approval",
          ...this.takeGeneration(aKey(r.id)),
          status,
          // The decision the gateway recorded — an allow as much as a deny: Convex
          // compares it with ours to tell whose verdict it is (codex P2). Not on an
          // expiry or a cancel, which decided nothing.
          ...((status === "denied" || status === "allowed") && r.decision !== undefined
            ? { decision: r.decision }
            : {}),
        });
      })
      .catch((err) =>
        console.error(
          `[agent-request] approval settle failed chat=${this.deps.chatId}:`,
          (err as Error)?.message ?? err,
        ),
      );
  }
}

function eventName(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as { type?: unknown; event?: unknown };
  if (f.type !== undefined && f.type !== "event") return null;
  return typeof f.event === "string" ? f.event : null;
}

function sessionKeyOfRequest(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const request = (payload as { request?: unknown }).request;
  if (typeof request !== "object" || request === null) return null;
  const key = (request as { sessionKey?: unknown }).sessionKey;
  return typeof key === "string" && key !== "" ? key : null;
}
