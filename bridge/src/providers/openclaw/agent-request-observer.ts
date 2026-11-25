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
// One frame of the RUN is read here too, because only this observer can join it to a
// card: the `agent` event `approval` / `resolved` / `failed` — the gateway's word that an
// exec approval's request failed and its command did not run, whatever was decided
// (onApprovalRequestFailed).
//
// No `sessions.messages.subscribe` here, although it would deliver sanitized
// approvals per session: a subscription on the conversation socket has already
// cost the live bench frames the turn depends on (session.ts, "NO sessions.subscribe
// on THIS connection"). The broadcasts arrive on this socket regardless; what the
// card SHOWS comes from `approval.get`, the gateway's reviewer-safe projection.
//
// An approval raised by a SUB-AGENT is not shown here. Upstream addresses an approval to
// the raising session and every ancestor (src/gateway/approval-session-audience.ts:52-107
// at v2026.9.36), computed once when it registers it, and serves that audience only on the
// session-scoped stream (`session.approval`) this socket does not subscribe to; the
// broadcast names the raising session alone. Reconstructing that audience from the
// broadcasts is not done: only the conversation's own session is.
//
// A broadcast is sent ONCE, `dropIfSlow` (server-methods/approval-shared.ts:340-368): a
// socket that was down, or slow, never gets it again. So at every (re)connection the
// pending ones are LISTED — `exec.approval.list`, `plugin.approval.list`,
// `openclaw.approval.list`, exactly what the Control UI asks at each connection
// (ui/src/app/exec-approval.ts:419-473, called from ui/src/app/overlays.ts:209-219) — and
// each one of this conversation's own session goes through the same path as its broadcast.

import {
  OPENCLAW_APPROVAL_REQUESTED_EVENTS,
  OPENCLAW_APPROVAL_RESOLVED_EVENTS,
  OPENCLAW_QUESTION_EVENTS,
  readOpenClawApprovalPresentation,
  readOpenClawApprovalRequested,
  readOpenClawApprovalRequestFailed,
  readOpenClawApprovalResolved,
  readOpenClawApprovalSnapshotOrigin,
  readOpenClawApprovalTerminal,
  readOpenClawApprovalTerminalStatus,
  openClawAnswerLabels,
  readOpenClawQuestionRequested,
  readOpenClawQuestionResolved,
  questionShape,
  type AgentRequestGatewayFailure,
  type AgentRequestRecord,
  type AgentRequestSettle,
  type OpenClawOptionValues,
} from "../../core/agent-requests.js";
import { SIGHTING_EPOCH, nextSightingSeq } from "../../core/sighting-order.js";
import {
  ApprovalGenerations,
  ApprovalIdentitySet,
  approvalIdentity,
  type ApprovalGeneration,
} from "./approval-identity.js";
import { payloadOf, type GatewayRpc } from "../../agent-request-rpc.js";
import { errForLog } from "../../core/log-safe-error.js";

export interface AgentRequestObserverDeps {
  chatId: string;
  sessionKey: string;
  agentId: string;
  /** This chat's gateway socket. Called with LITERAL method names only, so the RPC
   *  scope ratchet (test/rpc-scope.test.ts) sees every method this observer sends. */
  gateway: GatewayRpc;
  upsert: ((record: AgentRequestRecord) => Promise<unknown>) | undefined;
  /** Resolves with what Convex did (`{ outcome }`, convex-writer.ts), or nothing. */
  settle: ((settle: AgentRequestSettle) => Promise<unknown>) | undefined;
  /** The gateway said an exec approval's request FAILED (its command did not run). Resolves
   *  with what Convex did (`{ outcome }`, convex-writer.ts), or nothing. */
  gatewayFailed?: (failure: AgentRequestGatewayFailure) => Promise<unknown>;
  /** Whether two run ids name ONE run (a queued input's execution has two from OpenClaw
   *  2026.10.33 — run-manager `sameRun`). Absent: only an id is itself. */
  sameRun?: (a: string, b: string) => boolean;
  /** The active turn's bubble, when this chat is driving one. */
  currentMessageId: () => string | null;
  noteQuestion: (id: string, expiresInSec: number | null) => Promise<boolean>;
  noteQuestionSettled: (id: string) => Promise<void>;
  /** An approval of THIS session was decided: its IDENTITY, the id and its generation
   *  when known (approval-identity.ts) — only that request is released and marked. */
  noteApprovalSettled: (id: string, generation: ApprovalGeneration) => Promise<void>;
  /** An approval request of THIS session (Normalizer.noteApprovalRequested): its own
   *  deadline (time left, seconds) bounds the turn's wait, and an exec one naming the
   *  turn's run holds it. `generation`: with the id, the request's identity. */
  noteApprovalRequested?: (
    id: string,
    facts: {
      kind: "exec" | "plugin" | "system-agent";
      runId: string | null;
      toolCallId: string | null;
      expiresInSec: number | null;
      hold?: boolean;
      generation: ApprovalGeneration;
    },
  ) => Promise<void>;
  /** Wake the consume loop: deadlines were armed off-loop. */
  wake: () => void;
  /** Epoch ms (the gateway's deadlines are epoch). */
  nowMs: () => number;
}

/** The three pending-approval lists and the broadcast each one stands in for — the
 *  same three the Control UI asks (ui/src/app/exec-approval.ts:437-441). Each answers an
 *  array of `{id, request, createdAtMs, expiresAtMs}` (+ `approvalKind`), the very shape of
 *  the `*.approval.requested` broadcast (server-methods/approval-record-lookup.ts:121-155,
 *  exec-approval.ts:142-153, plugin-approval.ts:58-69, system-agent.ts:126-139). */
type ApprovalListEvent =
  | "exec.approval.requested"
  | "plugin.approval.requested"
  | "openclaw.approval.requested";

/** Why a pending-approval list could not be read — a closed vocabulary, never the
 *  gateway's prose (it may quote the request). */
function listFailureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/scope/i.test(msg)) return "scope_missing";
  if (/unknown method|method not found|not supported|unsupported/i.test(msg)) return "method_unknown";
  if (/timed out|timeout/i.test(msg)) return "timeout";
  if (/closed|ECONN|socket|not connected/i.test(msg)) return "connection";
  return "error";
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
/** Waits before writing an approval's verdict to Convex again when it could not take it
 *  (the writer's own retries spent). Bounded: past the last, an open card is left to
 *  Convex's expiry sweep. */
const SETTLE_RETRY_MS = [2_000, 10_000, 30_000, 120_000];
/** A failure heard before its request is announced here (`earlyFailures`): how many are
 *  kept, and for how long — the reads of one connection's pending lists, generously. */
const MAX_EARLY_FAILURES = 32;
const EARLY_FAILURE_TTL_MS = 120_000;
/** What an approval's write ends in when its `approval.get` answered a TERMINAL snapshot:
 *  the request was settled from it (recordApproval), and its resolution has nothing left
 *  to settle. */
const SETTLED_FROM_SNAPSHOT = Symbol("settled-from-snapshot");

type Kind = "question" | "approval";

/** A resolution broadcast, read (readOpenClawApprovalResolved). */
type ResolvedApproval = NonNullable<ReturnType<typeof readOpenClawApprovalResolved>>;

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
        OPENCLAW_APPROVAL_RESOLVED_EVENTS.has(event) ||
        (event === "agent" && readOpenClawApprovalRequestFailed(frame) !== null))
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
        await this.onApproval(event, payload);
      } else if (OPENCLAW_APPROVAL_RESOLVED_EVENTS.has(event)) {
        await this.onApprovalResolved(event, payload);
      } else if (event === "agent") {
        this.onApprovalRequestFailed(frame);
      }
    } catch (err) {
      console.error(
        `[agent-request] ${event} handling failed chat=${this.deps.chatId}:`,
        errForLog(err),
      );
    }
  }

  /**
   * Re-read what is still pending after a (re)connect: a request raised while this
   * socket was down — or whose one broadcast it missed — is otherwise invisible until it
   * expires. The lists are filtered by the gateway to what this client may see; we keep
   * this conversation's own session's.
   */
  async replayPending(): Promise<void> {
    await this.replayQuestions();
    await this.replayApprovals();
  }

  /** `question.list`: the questions still pending, for THIS session only. */
  private async replayQuestions(): Promise<void> {
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
        `[agent-request] question replay skipped chat=${this.deps.chatId}: ${errForLog(err)}`,
      );
    }
  }

  /**
   * The approvals still pending, from the three lists the Control UI reads at every
   * connection. Each entry is the broadcast's own shape, so it takes the broadcast's path
   * (`onApproval`): this session's only, `approval.get` for what the card shows and to
   * confirm it still waits — an approval decided since the list was read is not raised
   * again, its card is settled — and the write, idempotent per id. A list the gateway
   * refuses (an older one without it, or
   * a socket without `operator.approvals`) is skipped and said so, by method and reason
   * only; the live broadcasts still work.
   */
  private async replayApprovals(): Promise<void> {
    // The resolutions that arrive from now on came AFTER these lists were asked: an entry
    // may still name the request one of them decided (see onApproval).
    const listedBefore = this.resolutionOrder;
    const lists: Array<[string, ApprovalListEvent, Promise<unknown>]> = [
      [
        "exec.approval.list",
        "exec.approval.requested",
        this.deps.gateway.request("exec.approval.list", {}, OBSERVER_RPC_TIMEOUT_MS),
      ],
      [
        "plugin.approval.list",
        "plugin.approval.requested",
        this.deps.gateway.request("plugin.approval.list", {}, OBSERVER_RPC_TIMEOUT_MS),
      ],
      [
        "openclaw.approval.list",
        "openclaw.approval.requested",
        this.deps.gateway.request("openclaw.approval.list", {}, OBSERVER_RPC_TIMEOUT_MS),
      ],
    ];
    const settled = await Promise.allSettled(lists.map(([, , call]) => call));
    let listed = 0;
    let ours = 0;
    for (let i = 0; i < lists.length; i += 1) {
      const [method, event] = lists[i]!;
      const result = settled[i]!;
      if (result.status === "rejected") {
        console.log(
          `[agent-request] approval replay skipped method=${method} chat=${this.deps.chatId} reason=${listFailureReason(result.reason)}`,
        );
        continue;
      }
      const entries = payloadOf(result.value);
      if (!Array.isArray(entries)) {
        console.log(
          `[agent-request] approval replay skipped method=${method} chat=${this.deps.chatId} reason=unreadable`,
        );
        continue;
      }
      for (const entry of entries) {
        listed += 1;
        if (await this.onApproval(event, entry, listedBefore)) ours += 1;
      }
    }
    if (listed > 0) {
      console.log(
        `[agent-request] approval replay chat=${this.deps.chatId}: ${listed} pending listed, ${ours} for this conversation`,
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
    this.noteContent(qKey(q.id), content, seenSeq, q.optionValues);
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
          errForLog(err),
        );
      }),
    );
  }

  /** Did THIS socket route this approval — this id AND generation, the card's — to this
   *  conversation, i.e. did the gateway's broadcast (or its pending list) name this chat's
   *  exact session? The answer path's proof when the approval itself names no agent to
   *  check. Another generation of the id is another request: no proof for it. */
  routedApproval(id: string, generation?: number): boolean {
    return this.routedApprovals.has(id, generation ?? null);
  }

  private replayScheduled = false;
  /** One deferred `question.list` replay at a time (it records only what still waits). */
  private scheduleReplay(): void {
    if (this.replayScheduled) return;
    this.replayScheduled = true;
    const timer = setTimeout(() => {
      this.replayScheduled = false;
      void this.replayQuestions();
    }, QUESTION_REPLAY_LATER_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  // APPROVALS ARE KEPT BY IDENTITY — the id and the generation its announcement names
  // (approval-identity.ts): an id names one request upstream, and the generation dates a
  // verdict that reaches Convex before its card; nothing below marks, waits on or settles a
  // request in another generation's name.
  /** The generations announced for each id — read off the announcement before any network
   *  read, and kept when a write fails — each marked once seen decided: a resolution, which
   *  names none, is about the one still waiting, else the only one known (`attach`). */
  private readonly approvalGenerations = new ApprovalGenerations(MAX_KNOWN);
  /** Identities this socket routed here: the answer path's proof (routedApproval). */
  private readonly routedApprovals = new ApprovalIdentitySet(MAX_KNOWN);
  /** Identities whose card this socket is writing or wrote: another sighting of the same
   *  request writes nothing again. Forgotten when the write fails, so it is tried again. */
  private readonly recordedApprovals = new ApprovalIdentitySet(MAX_KNOWN);
  /** Identities already given their one deferred retry. */
  private readonly retriedApprovals = new ApprovalIdentitySet(MAX_KNOWN);
  /** Identities whose verdict Convex HOLDS from this socket (settleDurably: the card
   *  closed, or the verdict kept for it): a later write of it — a retry of that settle, the
   *  deferred retry of a card write that failed, the resolution after the snapshot — is
   *  saved. An economy only: Convex's settle is idempotent. */
  private readonly settledApprovals = new ApprovalIdentitySet(MAX_KNOWN);
  /** Resolutions that came while no generation of their id was announced here, in their
   *  order: a pending list asked BEFORE one of them may still name the request it decided
   *  (the list was read before the decision), and that entry then IS the decided request —
   *  its generation found, never a wait. Bounded. */
  private readonly unattachedResolutions = new Map<string, { order: number; resolution: ResolvedApproval }>();
  private resolutionOrder = 0;
  private noteUnattached(id: string, resolution: ResolvedApproval): void {
    this.resolutionOrder += 1;
    this.unattachedResolutions.delete(id);
    this.unattachedResolutions.set(id, { order: this.resolutionOrder, resolution });
    while (this.unattachedResolutions.size > MAX_KNOWN) {
      const oldest = this.unattachedResolutions.keys().next().value;
      if (oldest === undefined) break;
      this.unattachedResolutions.delete(oldest);
    }
  }

  /** Each request's creation, so its settle is posted AFTER it: an unordered settle
   *  finds no row, and the late creation then stands `pending` for a request that is
   *  already over (codex P1). Bounded like `known`. */
  private readonly writes = new Map<string, Promise<unknown>>();
  /** The generation each recorded QUESTION was created with, for its settle (approvals
   *  keep theirs by identity: `approvalGenerations`). */
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
  private readonly contents = new Map<
    string,
    { shape: string; seq: number; optionValues: OpenClawOptionValues }
  >();
  private noteContent(id: string, shape: string, seq: number, optionValues: OpenClawOptionValues): void {
    this.contents.delete(id);
    this.contents.set(id, { shape, seq, optionValues });
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
          // The gateway records canonical answers (an option's `value` when it has
          // one); the card, its stored answer and the "ours or theirs" comparison are in
          // labels — translated back with the options this request was asked with.
          ...this.withoutSecrets(
            secret,
            r.answers === undefined ? undefined : openClawAnswerLabels(r.answers, seen?.optionValues),
          ),
        }),
      )
      .catch((err) =>
        console.error(
          `[agent-request] question settle failed chat=${this.deps.chatId}:`,
          errForLog(err),
        ),
      );
  }

  /**
   * One approval request — its broadcast, or an entry of a pending list (same shape).
   * Resolves whether it was recorded here: this conversation's own session's only (see
   * the header — a sub-agent's request is not shown here).
   */
  private async onApproval(event: string, payload: unknown, listedBefore?: number): Promise<boolean> {
    const a = readOpenClawApprovalRequested(event, payload);
    if (a === null || !this.ours(a.sessionKey)) return false;
    const recorded = await this.admitApproval(event, payload, a, listedBefore);
    // The gateway's word that THIS request failed, heard before the request was known
    // here: joined now that its card's write and its verdict's are in flight.
    if (a.kind === "exec" && a.toolCallId !== null && this.takeEarlyFailure(a.toolCallId, a.runId)) {
      this.markAfterWrites(a.id, a.createdAtMs);
    }
    return recorded;
  }

  private async admitApproval(
    event: string,
    payload: unknown,
    a: NonNullable<ReturnType<typeof readOpenClawApprovalRequested>>,
    listedBefore?: number,
  ): Promise<boolean> {
    const generation = a.createdAtMs;
    this.remember(aKey(a.id), "approval");
    this.routedApprovals.add(a.id, generation);
    if (a.kind === "exec" && a.toolCallId !== null) this.noteToolCall(a.toolCallId, a.id, generation);
    // A list asked BEFORE a resolution of this id came, and read before the decision: the
    // entry is the request that resolution decided — now with its generation — not a wait.
    const early = this.unattachedResolutions.get(a.id);
    if (listedBefore !== undefined && generation !== null && early !== undefined && early.order > listedBefore) {
      this.unattachedResolutions.delete(a.id);
      await this.settleResolution(a.id, generation, early.resolution);
      return true;
    }
    this.approvalGenerations.announce(a.id, generation);
    if (this.recordedApprovals.has(a.id, generation)) return true;
    await this.recordApproval(event, payload, a);
    return true;
  }

  private async recordApproval(
    event: string,
    payload: unknown,
    a: NonNullable<ReturnType<typeof readOpenClawApprovalRequested>>,
  ): Promise<void> {
    const generation = a.createdAtMs;
    const key = aKey(approvalIdentity(a.id, generation));
    this.recordedApprovals.add(a.id, generation);
    const sighting = this.newSighting(key);
    const seenSeq = nextSightingSeq();
    // Captured NOW: by the time `approval.get` answers, the turn may have moved on.
    const messageId = this.deps.currentMessageId();
    // THIS session's approval bounds THIS turn's wait by its own deadline (the run's
    // `waiting-approval` carries none).
    const noteRequested = async (expiresAtMs: number | null, hold: boolean): Promise<void> => {
      if (this.deps.noteApprovalRequested === undefined) return;
      await this.deps.noteApprovalRequested(a.id, {
        kind: a.kind,
        runId: a.runId,
        toolCallId: a.toolCallId,
        expiresInSec:
          expiresAtMs === null ? null : Math.max(0, (expiresAtMs - this.deps.nowMs()) / 1000),
        hold,
        generation,
      });
      this.deps.wake();
    };
    // Awaited: the run's `waiting-approval` frame follows the broadcast on this socket,
    // and must find the deadline already noted.
    await noteRequested(a.expiresAtMs, true);
    const write = (async () => {
      // The broadcast is not repeated: a read that fails once would lose the card until
      // the next (re)connection's list (codex P2). Retried, then forgotten — a later
      // sighting of the same id may try again.
      let got: unknown;
      for (let attempt = 0; ; attempt += 1) {
        try {
          got = payloadOf(
            await this.deps.gateway.request("approval.get", { id: a.id }, OBSERVER_RPC_TIMEOUT_MS),
          );
          break;
        } catch (err) {
          if (attempt >= APPROVAL_READ_RETRY_MS.length) {
            if (this.ownsSighting(key, sighting)) this.recordedApprovals.delete(a.id, generation);
            throw err;
          }
          await new Promise((r) => setTimeout(r, APPROVAL_READ_RETRY_MS[attempt]));
        }
      }
      // The snapshot is used only when it is about the request its announcement named — the
      // same generation when the announcement gave one, and this conversation's own session
      // when the snapshot names one. Ids are unique per request upstream
      // (approval-identity.ts): this refuses no snapshot of ours, and any other creates no
      // card, settles nothing and holds nothing.
      const refusal = this.snapshotRefusal(got, generation);
      if (refusal !== null) {
        if (this.ownsSighting(key, sighting)) this.recordedApprovals.delete(a.id, generation);
        console.log(
          `[agent-request] approval snapshot ignored chat=${this.deps.chatId} reason=${refusal}`,
        );
        return;
      }
      const presented = readOpenClawApprovalPresentation(got);
      if (presented === null) {
        // Already decided: its one resolution broadcast may never have reached this socket
        // (sent once, `dropIfSlow`; a replay lists what was pending a moment ago), and the
        // card an earlier socket recorded would then stand `pending`. Settled from the
        // gateway's own record, as that resolution would have settled it. A snapshot still
        // pending (one we cannot show) or unreadable settles nothing. The verdict read is
        // written durably (settleDurably): again on its own back-off if Convex cannot take
        // it now, never by reading the gateway again. The marker says only that Convex holds
        // it; otherwise the resolution that may still come writes it too (idempotent).
        const terminal = readOpenClawApprovalTerminal(got);
        if (terminal === null) return;
        const decided = terminal.createdAtMs ?? generation;
        this.approvalGenerations.resolve(a.id, decided);
        await this.deps.noteApprovalSettled(a.id, decided);
        this.deps.wake();
        const landed = await this.settleDurably({
          chatId: this.deps.chatId,
          providerRequestId: a.id,
          family: "approval",
          ...(decided !== null ? { providerCreatedAt: decided } : {}),
          status: terminal.status,
          ...(terminal.decision !== undefined ? { decision: terminal.decision } : {}),
        });
        return landed ? SETTLED_FROM_SNAPSHOT : undefined;
      }
      const expiresAt = presented.expiresAtMs ?? a.expiresAtMs;
      // The snapshot's own creation time, as the announcement's otherwise.
      const created = presented.createdAtMs ?? generation;
      // The snapshot's deadline is the record's own; the broadcast's was a copy of it.
      if (presented.expiresAtMs !== null && presented.expiresAtMs !== a.expiresAtMs) {
        await noteRequested(presented.expiresAtMs, false);
      }
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
        ...(created !== null ? { providerCreatedAt: created } : {}),
        providerSeenSeq: seenSeq,
        providerSeenEpoch: SIGHTING_EPOCH,
        approval: presented.approval,
      });
      throwIfNotRecorded(written);
    })().catch((err) => {
      // Not recorded: forgotten, and tried ONCE more later — its broadcast is not
      // repeated, and the pending lists are read only at the next (re)connection (codex
      // P2). Only while this sighting is still the identity's (see `newSighting`). Its
      // generation is kept: a resolution that comes now still names the request.
      if (this.ownsSighting(key, sighting)) this.recordedApprovals.delete(a.id, generation);
      if (!this.retriedApprovals.has(a.id, generation)) {
        this.retriedApprovals.add(a.id, generation);
        const timer = setTimeout(() => {
          // Its resolution settled it in the meantime: nothing left to write.
          if (this.settledApprovals.has(a.id, generation)) return;
          void this.onApproval(event, payload).catch(() => undefined);
        }, APPROVAL_RETRY_LATER_MS);
        (timer as { unref?: () => void }).unref?.();
      }
      console.error(
        `[agent-request] approval read failed chat=${this.deps.chatId}:`,
        errForLog(err),
      );
    });
    this.noteWrite(key, write);
  }

  /**
   * Was that `deny` a person's, or an approval that simply ran out? The broadcast says
   * `deny` for both (see readOpenClawApprovalResolved); the terminal snapshot says
   * which. Unreadable: a timeout resolves with NO resolver, a person with one.
   */
  private async confirmDeny(
    id: string,
    resolvedBy: string | null,
    generation: ApprovalGeneration,
  ): Promise<"denied" | "expired" | "cancelled"> {
    try {
      const got = payloadOf(
        await this.deps.gateway.request("approval.get", { id }, OBSERVER_RPC_TIMEOUT_MS),
      );
      // Only a snapshot of THIS request says which (see snapshotRefusal).
      const refusal = this.snapshotRefusal(got, generation);
      if (refusal !== null) {
        console.log(
          `[agent-request] approval snapshot ignored chat=${this.deps.chatId} reason=${refusal}`,
        );
      } else {
        const status = readOpenClawApprovalTerminalStatus(got);
        if (status === "expired" || status === "cancelled" || status === "denied") return status;
      }
    } catch {
      /* fall through to the resolver rule */
    }
    return resolvedBy === null ? "expired" : "denied";
  }

  /**
   * Why an `approval.get` snapshot is NOT about the request its announcement named, or null
   * when it is: it names another session than this conversation's (`session`), or another
   * generation than the announced one, when that is known (`generation`). A closed
   * vocabulary: what is logged names neither the session nor the request.
   */
  private snapshotRefusal(got: unknown, generation: ApprovalGeneration): "session" | "generation" | null {
    const origin = readOpenClawApprovalSnapshotOrigin(got);
    if (origin === null) return null;
    if (origin.sessionKey !== null && !this.ours(origin.sessionKey)) return "session";
    if (generation !== null && origin.createdAtMs !== generation) return "generation";
    return null;
  }

  private async onApprovalResolved(event: string, payload: unknown): Promise<void> {
    const r = readOpenClawApprovalResolved(event, payload);
    if (r === null) return;
    const requestSession = sessionKeyOfRequest(payload);
    if (this.known.get(aKey(r.id)) !== "approval" && !this.ours(requestSession)) return;
    // The broadcast names no generation: it is about the one announced here and still
    // waiting, else the only one known — or, none announced yet, about an entry a list asked
    // before it may still name.
    const generation = this.approvalGenerations.attach(r.id);
    if (generation === null) this.noteUnattached(r.id, r);
    await this.settleResolution(r.id, generation, r);
  }

  /** A resolution of THIS identity: its turn released and the request marked decided at
   *  once, then its verdict written durably, after the card's own write. */
  private async settleResolution(
    id: string,
    generation: ApprovalGeneration,
    r: ResolvedApproval,
  ): Promise<void> {
    this.approvalGenerations.resolve(id, generation);
    await this.deps.noteApprovalSettled(id, generation);
    this.deps.wake();
    const key = aKey(approvalIdentity(id, generation));
    const verdict = this.afterWrite(key)
      .then(async (written) => {
        // Its verdict already LANDED (the terminal snapshot's settle, or an earlier write):
        // a write saved — Convex's settle is idempotent either way.
        if (written === SETTLED_FROM_SNAPSHOT || this.settledApprovals.has(id, generation)) return;
        const verdict = r.denyUnconfirmed
          ? await this.confirmDeny(id, r.resolvedBy ?? null, generation)
          : null;
        const status = verdict ?? r.status;
        await this.settleDurably({
          chatId: this.deps.chatId,
          providerRequestId: id,
          family: "approval",
          ...(generation !== null ? { providerCreatedAt: generation } : {}),
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
          errForLog(err),
        ),
      );
    this.noteVerdictWrite(key, verdict);
  }

  /** The exec request each tool call waits on (`request.toolCallId` of its announcement):
   *  the run's `approval` stream names the tool call only. Bounded like `known`. */
  private readonly approvalsByToolCall = new Map<string, { id: string; generation: ApprovalGeneration }>();
  private noteToolCall(toolCallId: string, id: string, generation: ApprovalGeneration): void {
    this.approvalsByToolCall.delete(toolCallId);
    this.approvalsByToolCall.set(toolCallId, { id, generation });
    while (this.approvalsByToolCall.size > MAX_KNOWN) {
      const oldest = this.approvalsByToolCall.keys().next().value;
      if (oldest === undefined) break;
      this.approvalsByToolCall.delete(oldest);
    }
  }
  /** Each identity's verdict write in flight (settleResolution), so the gateway's later
   *  word about the same request reaches Convex after it. Bounded like `writes`. */
  private readonly verdictWrites = new Map<string, Promise<unknown>>();
  private noteVerdictWrite(key: string, write: Promise<unknown>): void {
    this.verdictWrites.set(key, write);
    if (this.verdictWrites.size > 512) {
      const oldest = this.verdictWrites.keys().next().value;
      if (oldest !== undefined) this.verdictWrites.delete(oldest);
    }
  }

  /**
   * The run's `approval` / `resolved` / `failed` (readOpenClawApprovalRequestFailed): the
   * gateway refused the exec because the approval REQUEST failed — its command did not run,
   * even when a person had just allowed it (upstream openclaw/openclaw#170994: the gateway
   * accepts the decision, then revokes the requester it was waiting for). Joined to the
   * card by the tool call its announcement named; a frame naming a tool call this socket
   * announced no exec request for marks nothing — the card stays what it is. The frame is
   * the only thing read: no error text decides anything here.
   */
  private onApprovalRequestFailed(frame: unknown): void {
    const failed = readOpenClawApprovalRequestFailed(frame);
    if (failed === null) return;
    if (failed.sessionKey !== null && !this.ours(failed.sessionKey)) return;
    const request = this.approvalsByToolCall.get(failed.toolCallId);
    if (request === undefined) {
      const kept = this.keepEarlyFailure(failed);
      console.log(
        `[agent-request] approval request failed on the gateway chat=${this.deps.chatId}: ${
          kept ? "its request is not announced here yet (kept for it)" : "no card to mark (tool call not announced here)"
        }`,
      );
      return;
    }
    this.markAfterWrites(request.id, request.generation);
  }

  /** After the card's own write and its verdict's: the mark is about a card Convex holds. */
  private markAfterWrites(id: string, generation: ApprovalGeneration): void {
    const key = aKey(approvalIdentity(id, generation));
    void Promise.allSettled([this.writes.get(key), this.verdictWrites.get(key)]).then(() =>
      this.markGatewayFailed({
        chatId: this.deps.chatId,
        providerRequestId: id,
        ...(generation !== null ? { providerCreatedAt: generation } : {}),
      }),
    );
  }

  /**
   * Failures heard BEFORE their request was announced on this socket, by tool call. A
   * request is learnt from its broadcast or from the pending lists read at connection
   * (`replayApprovals`, three lists awaited together): while a list is slow, a request
   * another one already returned can be allowed and then fail, and dropping that word
   * left the card saying "allowed". Kept only with what ties it to one request: THIS
   * session, stated by the frame (a frame naming none could be anyone's), the tool call,
   * and the run — a request that names another run is not the one that failed. Bounded
   * in number and in time (the bridge's own clock at both ends).
   */
  private readonly earlyFailures = new Map<string, { runId: string | null; atMs: number }>();
  private keepEarlyFailure(failed: { toolCallId: string; sessionKey: string | null; runId: string | null }): boolean {
    if (!this.ours(failed.sessionKey)) return false;
    this.earlyFailures.delete(failed.toolCallId);
    this.earlyFailures.set(failed.toolCallId, { runId: failed.runId, atMs: this.deps.nowMs() });
    while (this.earlyFailures.size > MAX_EARLY_FAILURES) {
      const oldest = this.earlyFailures.keys().next().value;
      if (oldest === undefined) break;
      this.earlyFailures.delete(oldest);
    }
    return true;
  }
  /** The failure kept for the exec request just announced for `toolCallId`, consumed:
   *  whether there is one, still fresh, of the request's own run. */
  private takeEarlyFailure(toolCallId: string, requestRunId: string | null): boolean {
    const kept = this.earlyFailures.get(toolCallId);
    if (kept === undefined) return false;
    this.earlyFailures.delete(toolCallId);
    if (this.deps.nowMs() - kept.atMs > EARLY_FAILURE_TTL_MS) return false;
    if (kept.runId === null || requestRunId === null || kept.runId === requestRunId) return true;
    return this.deps.sameRun?.(kept.runId, requestRunId) === true;
  }

  /** Write the mark, again on the settle's back-off while Convex cannot take it or holds no
   *  card yet (a card write retried later). Bounded; idempotent in Convex. */
  private async markGatewayFailed(failure: AgentRequestGatewayFailure, attempt = 0): Promise<void> {
    if (this.deps.gatewayFailed === undefined) return;
    let outcome: unknown;
    try {
      outcome = ((await this.deps.gatewayFailed(failure)) as { outcome?: unknown } | undefined)?.outcome;
    } catch (err) {
      console.error(
        `[agent-request] approval gateway-failure write failed chat=${this.deps.chatId} attempt=${attempt + 1}:`,
        errForLog(err),
      );
    }
    console.log(
      `[agent-request] approval request failed on the gateway chat=${this.deps.chatId}: card ${outcome === "marked" ? "marked" : "not marked"} attempt=${attempt + 1}`,
    );
    if (outcome === "marked") return;
    const wait = SETTLE_RETRY_MS[attempt];
    if (wait === undefined) return;
    const timer = setTimeout(() => void this.markGatewayFailed(failure, attempt + 1), wait);
    (timer as { unref?: () => void }).unref?.();
  }

  /**
   * Write an approval's verdict to Convex: once now, then — if Convex cannot take it — on
   * a bounded back-off (SETTLE_RETRY_MS), with the verdict already read: never a gateway
   * read, whatever becomes of this socket. Convex's settle is idempotent (a verdict that
   * lands twice changes nothing; one that finds no card yet is kept for it), so the memory
   * of a held verdict (`settledApprovals`) only saves writes. Resolves whether Convex now
   * HOLDS it, as it says (convex/agentRequests.ts settleFromBridge): the card closed
   * (`settled`) or the verdict kept for a card not recorded yet (`kept`). Its `none` — a card
   * already closed, or no card and a verdict without the generation that would let it be
   * kept — is not taken as held: a later sighting writes it again, at no cost.
   */
  private async settleDurably(settle: AgentRequestSettle, attempt = 0): Promise<boolean> {
    if (this.deps.settle === undefined) return false;
    let res: unknown;
    try {
      res = await this.deps.settle(settle);
    } catch (err) {
      const wait = SETTLE_RETRY_MS[attempt];
      if (wait !== undefined) {
        const timer = setTimeout(() => {
          if (this.settledApprovals.has(settle.providerRequestId, settle.providerCreatedAt ?? null)) return;
          void this.settleDurably(settle, attempt + 1);
        }, wait);
        (timer as { unref?: () => void }).unref?.();
      }
      console.error(
        `[agent-request] approval settle failed chat=${this.deps.chatId} attempt=${attempt + 1}:`,
        errForLog(err),
      );
      return false;
    }
    const outcome = (res as { outcome?: unknown } | undefined)?.outcome;
    if (outcome !== "settled" && outcome !== "kept") return false;
    if (outcome === "kept") {
      console.log(
        `[agent-request] approval settle chat=${this.deps.chatId}: kept for a card not recorded yet`,
      );
    }
    this.settledApprovals.add(settle.providerRequestId, settle.providerCreatedAt ?? null);
    return true;
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
