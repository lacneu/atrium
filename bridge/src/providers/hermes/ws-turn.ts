// One Hermes turn over the JSON-RPC/WebSocket transport (`hermes serve`
// /api/ws). Richer than the REST/SSE path: the ACK is explicit
// (prompt.submit → {status:"streaming"}), the terminal carries full usage +
// context pressure, and session.info exposes the model/provider/reasoning
// knobs — all fed into the SAME TurnSink + reportSessionMeta channels the
// OpenClaw path uses, so the usage gauge and pressure trace fill natively.
//
// Live-captured contract (fixture test/fixtures/hermes/ws-capture.jsonl):
//   session.create → {session_id, stored_session_id}   (or session.resume)
//   prompt.submit {session_id, text} → {status:"streaming"}      ← ACCEPTANCE
//   events (by session_id):
//     message.delta {text}                → streaming reply text
//     thinking.delta {text}               → reasoning noise (NOT reply text)
//     status.update {kind, text}          → lifecycle notes (compaction…)
//     session.info {model, provider, reasoning_effort, …} → session meta
//     message.complete {text, usage{total, context_used, context_max…},
//                       status}           → the turn's terminal
//   abort: session.interrupt {session_id}

import { randomUUID } from "node:crypto";
import { TurnSink } from "../../core/turn-sink.js";
import {
  assertBeforeSendDeadline,
  RECV_SILENCE_MS,
} from "../../core/dispatch-deadline.js";
import {
  EVENT_CONTEXT_COMPACTION,
  EVENT_MESSAGE_DELTA,
  EVENT_MESSAGE_FINAL,
  EVENT_RUN_STATUS,
  EVENT_REASONING,
  EVENT_TOOL_STATUS,
  type BridgeEvent,
} from "../../core/events.js";
import {
  classifyProviderInternal,
  isHermesHistoryDesyncWarning,
  isHermesRuntimeFailureText,
  isHermesSyntheticErrorText,
} from "./normalizer.js";
import type {
  ConvexWriter,
  SessionMetaReport,
  SubAgentRecord,
} from "../../convex-writer.js";
import { HERMES_SERVER_REQUEST_EVENT, refuseOpenRequests } from "./ws-client.js";
import type { HermesWsClient } from "./ws-client.js";
import type { SyntheticOrigin } from "./ws-client.js";
import type { HermesFilesFetcher } from "./files-fetcher.js";
import { protocolDrift } from "../openclaw/protocol-drift.js";
import {
  hermesRequestId,
  readHermesApproval,
  readHermesClarify,
  hermesClarifyMultiIds,
  readHermesCredential,
  type AgentRequestRecord,
} from "../../core/agent-requests.js";
import { isHermesVersionScheme } from "../../compat.js";

/**
 * Read a gateway version Hermes reported, or `null` when it is not one we can read.
 *
 * ONE rule, used at EVERY door: the `session.info` event on the WS transport and
 * `/health` on the REST one. The rule lived only in the WS reader for one review pass, and
 * the REST discovery branch — which returns `health.version` straight through — could
 * publish the very calendar tag the WS side refuses (raised in review). A rule enforced at
 * one of two doors is not a rule.
 *
 * A refusal is OBSERVED rather than swallowed: the operator has to be able to tell "no
 * version seen" from "a version in a scheme this build does not read".
 */
export function readHermesGatewayVersion(
  raw: unknown,
  site: string,
): string | null {
  const value = typeof raw === "string" ? raw : "";
  if (!value) return null;
  if (isHermesVersionScheme(value)) return value;
  protocolDrift.observeException(
    { type: site, payload: { version: value } },
    new TypeError(
      `${site} carried a version in an unrecognized scheme — not published`,
    ),
    "hermes-ws-event",
  );
  return null;
}

/** The delivery folder (workspace-relative) the prompt directive names. */
export const HERMES_DELIVERY_DIR = "atrium-out";

/** The standing delivery instruction spliced after the user text (mirrors the
 *  OpenClaw MEDIA:/outbound directive — tells the agent HOW to hand a file to
 *  the user; the post-turn scan picks it up). */

const DELIVERY_DIRECTIVE = `[Consigne de livraison : pour remettre un fichier genere a l'utilisateur, ecris-le dans le dossier ${HERMES_DELIVERY_DIR}/ (relatif a ton repertoire de travail). Ne colle pas le contenu du fichier dans ta reponse.]`;

export interface HermesWsTurnOptions {
  client: HermesWsClient;
  writer: ConvexWriter;
  chatId: string;
  sessionKey: string;
  /** The chat's stored Hermes WS session id (stored_session_id), or null. */
  providerChatId: string | null;
  /** The OUTBOX row this turn was dispatched from (correlation for outbox
   *  reconciliation; null on a gateway-initiated turn). */
  dispatchOutboxId?: string | null;
  /** When the /send HTTP handler received the request — the pre-send deadline is
   *  measured from there, not from this turn's own start. */
  sendReceivedMs?: number;
  /** How long the dispatch had already been pending when Convex sent the POST —
   *  added to the local elapsed time by the pre-send deadline. */
  dispatchAgeMs?: number;
  text: string;
  /** Re-request the prompt WITH the rehydration history: called when the turn
   *  expected a warm session (providerChatId set) but had to MINT a fresh one
   *  (resume degraded/failed) — the brand-new session must receive the history
   *  the warm prompt deliberately omitted, or the agent starts cold. */
  freshText?: () => Promise<string>;
  /** Inline base64 attachments to stage BEFORE the prompt (Atrium send shape).
   *  Images go through image.attach_bytes (vision tiles); everything else
   *  through file.attach (workspace artifact + @file: ref). */
  attachments?: Array<{ mimeType: string; fileName: string; content: string }>;
  /** Outbound files seam: when set, the turn (1) splices the delivery
   *  directive into the prompt and (2) scans <cwd>/atrium-out after the
   *  terminal for files newer than the turn start → EVENT_MEDIA (the sink
   *  hosts them via this same fetcher). */
  filesFetcher?: HermesFilesFetcher | null;
  /** Persist a NEWLY minted stored_session_id (turn 1 / after reset). */
  onBoundSession?: (storedSessionId: string) => Promise<void>;
  /** Forget this chat's session in the bridge's IN-MEMORY cache.
   *
   *  The durable clear rides the finalize, and that is what survives a restart — but it
   *  empties the Convex slot only. Within THIS process the registry still holds the id,
   *  and the continuity selector falls back to it precisely when the durable field is
   *  null: the next send would resume the very session the finalize just declared
   *  untrusted (raised in review). No retry, no quarantine, no lift — one synchronous
   *  forget of a cache entry, which is why it does not bring the old machinery back. */
  onSessionForgotten?: () => void;
  /** Health-stats hook (TurnSink.onTurnError): a turn finalizing in error AFTER
   *  acceptance counts as a downstream failure on its target. */
  onTurnError?: (code: string) => void;
  /** The gateway VERSION, learned from `session.info`.
   *
   *  This is the only place the WS transport can learn it: upstream fills
   *  `info["version"] = __version__` in the `session.info` payload builder and exposes it
   *  nowhere else on the RPC surface — `hermes serve` has no `/health`. Without this the
   *  default transport reported an unknown version forever, so the compat manifest, the
   *  beyond-validated banner and the version ratchet were all inert on it (G-55).
   *
   *  `null` means OBSERVED BUT UNREADABLE — a version in a scheme this build does not
   *  recognize. It is reported, not dropped: it must retire whatever was believed before,
   *  or an upgrade to an unvalidated major would keep the old version's capabilities. */
  onGatewayVersion?: (version: string | null) => void;
}

export interface HermesWsTurnRun {
  /** Resolves when prompt.submit is ACKed (or rejects: dispatch failure). */
  accepted: Promise<void>;
  /** Resolves when the turn fully finalized. */
  done: Promise<void>;
  /** The RUNTIME session id — session.interrupt's target. */
  runtimeSessionId(): string | null;
  /** The stored session id CONVEX IS KNOWN TO HOLD for this chat — the id this turn
   *  resumed, or the last one it successfully wrote. NOT simply what the turn believes:
   *  a drop is matched by id, so naming a rotation whose write was dropped would match
   *  nothing and clear nothing (raised in review). */
  storedSessionId(): string | null;
  /** Declare this turn's session unusable, so no binding it has queued is ever written.
   *  An ABORT calls it: a turn being force-settled must not persist a session decided in
   *  its dying moments, because nobody will verify that session again. */
  markSessionUntrusted(): void;
  /** Resolves once every binding write this turn had QUEUED has settled. An abort awaits
   *  it (bounded) so `storedSessionId()` is read after the last write, not during it. */
  settledBindings(): Promise<void>;
  /** Settle the turn. `writeAborted=false` (user Stop): NO terminal — Convex
   *  already finalized the message `aborted`. `writeAborted=true` (/reset):
   *  write the aborted terminal pair FIRST — dispatchReset does NOT finalize
   *  optimistically, so the bridge must, or the row stays streaming. */
  forceSettle(writeAborted?: boolean): void;
  /** The approval Hermes would decide NOW with `approval.respond` — the head of this
   *  session's queue as the turn has seen it. `null` = nothing Atrium may answer: no
   *  approval open, or the head is one it could not show. The answer route sends a
   *  decision only for this id (Hermes answers by session, not by id). */
  approvalHead(): string | null;
  /** Why no head is named while approvals wait: a failed call left the order unknown,
   *  or several wait at once (see `approvalHead`). */
  approvalAmbiguity(): "order_unknown" | "several" | null;
  /** Hermes accepted a decision for `id`: it has left the queue's head. */
  noteApprovalAnswered(id: string): void;
  /** A decision's fate is unknown: no head until the agent moves again. */
  noteApprovalOrderUnknown(): void;
  /** Hermes took Atrium's answer to server→client request `id` (`request.answer` →
   *  `ok`): it no longer holds the turn. */
  noteServerRequestAnswered(id: string): void;
  /** Server→client request `id` as THIS turn holds it, or null when it holds no such
   *  request — none was raised here, or it was answered, withdrawn or dropped since. */
  heldServerRequest(id: string): HermesHeldServerRequest | null;
  /** Whether THIS turn raised request `id` (any form) and it is still unsettled. */
  holdsRequest(id: string): boolean;
}

/** What a held server→client request needs to be answered as Hermes reads it. */
export interface HermesHeldServerRequest {
  /** Clarify question ids Hermes parses as multi-select (`answer` for a single one). */
  multiSelect: ReadonlySet<string>;
}

const NOT_A_CLARIFY: HermesHeldServerRequest = { multiSelect: new Set() };

/** What a turn hands the registry when it subscribes to its session's lane.
 *
 *  `onTransportLost` is a CALLBACK and not an injected `error` event on purpose: losing
 *  the bridge→Hermes socket is not something Hermes said. Routing it through the event
 *  lane would mean a wire frame could impersonate it, and would put a bridge-internal
 *  name into the terminal vocabulary the reader's switch defines. */
export interface HermesWsSessionHandlers {
  onEvent: (
    type: string,
    payload: Record<string, unknown>,
    /** Set only when the ROUTER made this event up (a terminal whose payload would
     *  not decode). Beside the payload, never inside it: the payload is the
     *  provider's, and a fact about OUR decoding cannot be one it can forge. */
    synthetic?: SyntheticOrigin,
  ) => void;
  /** THIS instance's socket died while the turn was waiting. */
  onTransportLost: (reason: string) => void;
  /** Is this monitoring event (`subagent.*`, `moa.*`) about work THIS turn started?
   *  How a lane routes a late child to its own parent (dispatch.ts routeLaneEvent). */
  ownsMonitoring?: (type: string, payload: Record<string, unknown>) => boolean;
}

/**
 * The gateway's BLOCKING prompts, and the one rule that governs them.
 *
 * Upstream `_block(event, sid, payload, timeout)` emits a request carrying a
 * `request_id` and then STOPS THE TURN until a matching `*.respond` arrives or the
 * timeout expires. Atrium handled none of them: four fell through the reader's default
 * case and the turn simply hung — 300 s for `clarify`/`secret`, 120 s for `sudo`, 30 s
 * for `terminal.read` — which since the recv deadline means the turn dies at 240 s with a
 * wrong cause and, since lot 31, drops a healthy session on the way out.
 *
 * THE RULE: never leave the gateway blocking on something this chat cannot answer.
 *
 * WITH ONE DELIBERATE EXCEPTION, and it is not an oversight — `secret.request` and
 * `sudo.request` ask for a CREDENTIAL. Atrium answering "" would be a refusal *it*
 * invented on the user's behalf, and it would suppress the `secret.expire` / `sudo.expire`
 * the gateway emits when the prompt lapses (its own fail-closed, designed for exactly
 * this). Those two are surfaced and left to expire; upstream's secret callback already
 * treats an empty answer as a graceful skip.
 *
 * `approval.respond` is addressed by SESSION and resolves the oldest pending approval
 * (FIFO); the other responders are addressed by `request_id`. Two call shapes in one
 * family — written here because the asymmetry is upstream's, not a slip.
 */
const HERMES_PROMPT_RESPONDERS: Record<string, { method: string; key: string }> = {
  // The only prompt still answered by the bridge itself: a desktop-GUI buffer read,
  // which no person can answer. Clarifications, approvals and credentials are now
  // AGENT REQUESTS the person answers (convex/agentRequests.ts).
  "terminal.read.request": { method: "terminal.read.respond", key: "text" },
};

/** How long the gateway holds each prompt before giving up on it — the `timeout=` of its
 *  own `_block` call, read from upstream and not guessed.
 *
 *  This exists because a turn waiting on a prompt is BLOCKED, not SILENT, and the recv
 *  deadline cannot tell those apart on its own. `secret.request` is held for 300 s while
 *  our deadline is 240 s, so the very design of "let the credential prompt expire" was
 *  defeated by our own clock: the turn died a minute early, as a `response_timeout`, and
 *  dropped a healthy session — the exact regression this lot claims to fix (raised in
 *  review). The same applies whenever we could not answer at all: upstream WILL unblock
 *  at its timeout and the agent carries on, so ending the turn first would be wrong. */
const HERMES_PROMPT_TIMEOUT_MS: Record<string, number> = {
  // NOT the approval prompt: its timeout is the operator's (`approvals.timeout`,
  // tools/approval.py `_get_approval_timeout`, 60 s only by default) and travels in no
  // payload — see HERMES_APPROVAL_HOLD_CEILING_MS.
  "clarify.request": 300_000,
  "secret.request": 300_000,
  "sudo.request": 120_000,
  "terminal.read.request": 30_000,
};

/**
 * An APPROVAL holds the turn until the agent MOVES AGAIN, not for a guessed time.
 *
 * Hermes blocks the agent's thread on the approval until an answer or its own timeout —
 * a setting (`approvals.timeout`) Atrium cannot read from any payload — and says nothing
 * when it gives up or when the approval is answered elsewhere. What it does say is the
 * agent's next step: an approval-gated tool (terminal, execute_code) is a SEQUENTIAL
 * barrier in Hermes' batch planner (run_agent.py `_execute_tool_calls`), so the next
 * `tool.complete` or message on this turn means the approvals it waited on are over.
 * The ceiling (a day, the longest a request lives in Convex) only bounds a Hermes that
 * went silent for good while its socket stayed up; `approvals.timeout` itself has no
 * upper bound upstream (tools/approval.py `_get_approval_timeout`).
 *
 * ALL of them, not the oldest: several approvals wait at once only inside ONE
 * execute_code call (its RPC handler threads — tools/approval.py, the queue's own
 * comment), and that call's `tool.complete` is emitted once, for the whole call, after
 * its function returned (agent/tool_executor.py, `tool_complete_callback`) — i.e.
 * after every one of them is over. Sub-agents never reach this queue (delegate_tool.py
 * `_get_subagent_approval_callback`: auto-approve or auto-deny) and their mirrored
 * tool events are emitted on the CHILD's session, not this one (tui_gateway/server.py,
 * `subagent.tool`).
 */
const HERMES_APPROVAL_HOLD_CEILING_MS = 24 * 60 * 60_000;
/**
 * The order of Hermes approvals, across EVERY turn of this process: strictly
 * increasing, never below the wall clock (×1000). Per turn, it restarted — two turns
 * under a clock that stood still or stepped back ordered (and named) their approvals
 * alike, so a new request replayed onto an old card (codex P1).
 */
let lastHermesApprovalSeq = 0;
function nextHermesApprovalSeq(): number {
  lastHermesApprovalSeq = Math.max(lastHermesApprovalSeq + 1, Date.now() * 1000);
  return lastHermesApprovalSeq;
}
/** Wait before re-trying a request's creation or close that failed past the writer's retries. */
const HERMES_WRITE_RETRY_LATER_MS = 5_000;
/** A human is being asked: the bubble's liveness is refreshed on this cadence, or the
 *  Convex stuck-stream watchdog (12 min) would end a turn that is only waiting. */
const HUMAN_WAIT_BEAT_MS = 60_000;
/** The events that prove a blocked agent resumed (see above). */
const HERMES_APPROVAL_RESUME_EVENTS = new Set([
  "tool.complete",
  "message.delta",
  "message.interim",
  "message.complete",
]);

/** Margin over the gateway's own timeout, so the deadline never fires in the same
 *  instant the gateway is giving up — we want its `*.expire`, not our guess. */
const PROMPT_GRACE_MARGIN_MS = 30_000;

/** A finite non-negative number, or undefined. Used wherever a gateway COUNT reaches
 *  storage: a string or a NaN must be dropped, not coerced into a figure someone reads. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** The words `delegate_tool` can settle a child on, besides `completed`. An ENUM because
 *  this value reaches storage: keeping the gateway's own word is worth doing, keeping an
 *  arbitrary gateway-supplied string is not. */
const CHILD_TERMINAL_WORDS = new Set(["interrupted", "failed", "timeout"]);

/** A stored (persistent) Hermes WS session id: `YYYYMMDD_HHMMSS_hex`. Distinct
 *  from the REST session shape (`api_<ts>_<hex>`) — a chat that switches
 *  transport must NOT feed one transport's id to the other. */
export function isHermesWsStoredSessionId(v: string | null): v is string {
  return typeof v === "string" && /^[0-9]{8}_[0-9]{6}_[0-9a-f]+$/i.test(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Run one WS turn. The client's event stream is fanned to this turn by
 * RUNTIME session id; events for other sessions are ignored (multiplex-safe).
 */
export function runHermesWsTurn(
  opts: HermesWsTurnOptions,
  registerSession: (
    runtimeSessionId: string,
    handlers: HermesWsSessionHandlers,
  ) => (() => void) & { linger?: () => void },
): HermesWsTurnRun {
  // The /send handler's OWN entry when given (time lost before this turn started
  // counts too — codex P1); this turn's start otherwise.
  const turnStartedMs = opts.sendReceivedMs ?? Date.now();
  let runtimeSid: string | null = null;
  /** Agent requests this turn raised and nobody has settled yet (by provider id). */
  const openRequests = new Set<string>();
  /** Server→client requests (Hermes 0.21.3+) this turn still waits on, by `srq-…` id. Each
   *  holds the turn — the agent is blocked on a person — until Hermes withdraws it
   *  (`request.cancel`), Atrium's answer is taken, or the turn ends. Each keeps what
   *  answering it needs: the clarify questions Hermes reads as MULTI-select. */
  const serverRequestsOpen = new Map<string, HermesHeldServerRequest>();
  let releaseServerRequestRef: (id: string) => void = () => {};
  /** Whether the turn has finalized (its inner flag, read from outside). */
  let finalizedRef: () => boolean = () => false;
  /** Approvals the agent is BLOCKED on, oldest first (shown or not): Hermes resolves
   *  them by session FIFO, so the queue is ours to keep in step with its own. An entry
   *  Hermes already took a decision for stays until the agent resumes (it still holds
   *  the turn) but is no longer the head. */
  const blockedApprovals: Array<{ id: string | null; answered: boolean }> = [];
  /** A decision's fate is unknown (see `HermesApprovalQueue.uncertain`): no head is
   *  named until the agent moves again. */
  let approvalOrderUnknown = false;
  /**
   * The ONE approval a decision may be sent for — or null.
   *
   * Only when exactly one waits: `approval.respond` decides the head of Hermes' queue,
   * addressed by session, and another client (Hermes' own dashboard or TUI) can take an
   * approval off that queue WITHOUT any event reaching us (tools/approval.py
   * `resolve_gateway_approval`). With two or more waiting, our copy of the order can
   * be wrong and a click would decide another command (codex P1). With one, a queue
   * emptied elsewhere answers `resolved: 0` and the card closes. Several at once only
   * happen inside one execute_code call; those are answered in Hermes.
   */
  const approvalHead = (): string | null => {
    if (approvalOrderUnknown) return null;
    const waiting = blockedApprovals.filter((a) => !a.answered);
    return waiting.length === 1 ? waiting[0]!.id : null;
  };
  /** Why no head is named while approvals wait (null = a head exists, or none waits). */
  const approvalAmbiguity = (): "order_unknown" | "several" | null => {
    if (blockedApprovals.every((a) => a.answered)) return null;
    if (approvalOrderUnknown) return "order_unknown";
    return blockedApprovals.filter((a) => !a.answered).length > 1 ? "several" : null;
  };
  /** Each request's first write, so its settle is never posted before it: an unordered
   *  settle finds no row, and the late insert then stands `pending` for an approval
   *  Hermes has already moved past (codex P1). */
  const writes = new Map<string, Promise<unknown>>();
  const settleRequest = (
    providerRequestId: string,
    status: "expired" | "cancelled",
  ): void => {
    if (!openRequests.delete(providerRequestId)) return;
    const after = writes.get(providerRequestId) ?? Promise.resolve();
    writes.delete(providerRequestId);
    const attempt = () =>
      Promise.resolve(
        opts.writer.settleAgentRequest?.({ chatId: opts.chatId, providerRequestId, status }),
      );
    // A close lost past the writer's retries leaves the card open on a request Hermes
    // has dropped: tried once more, later, like a creation (codex P2). What still gets
    // lost is closed by the session's next approval (supersedesBeforeSeq).
    void after
      .catch(() => undefined)
      .then(attempt)
      .catch(async () => {
        await new Promise((r) => {
          const t = setTimeout(r, HERMES_WRITE_RETRY_LATER_MS);
          (t as { unref?: () => void }).unref?.();
        });
        await attempt();
      })
      .catch((e) =>
        console.error(
          "[hermes-ws-turn] agent request settle failed:",
          (e as Error)?.message ?? e,
        ),
      );
  };
  /** The stored id this turn is bound to — what it resumed, or minted, or has since been
   *  told it ROTATED to. The comparison reference for a rotation, written explicitly
   *  rather than inferred: `session.info` also fires at turn start with the current
   *  value, and binding on "any difference" would write for nothing.
   *
   *  At TURN scope because the ABORT reads it from outside the drain: `session.interrupt`
   *  targets the RUNTIME id, but the chat's binding holds the STORED one, so an abort
   *  reporting the runtime id would name a session Convex has never heard of and the
   *  drop would silently do nothing. */
  let boundStoredSid: string | null = null;
  /** The stored id CONVEX HOLDS: what this turn resumed, then whatever it has actually
   *  managed to WRITE. Distinct from `boundStoredSid`, which is what the turn believes —
   *  the two diverge whenever a rotation's write is dropped, and only this one can be
   *  matched against the chat's slot. */
  let convexBoundSid: string | null = opts.providerChatId ?? null;
  let forceSettleRef: ((writeAborted?: boolean) => void) | null = null;
  /** Set once the recv clock exists (it lives with the reader, below the events). */
  let releaseApprovalsRef: () => void = () => {};
  /** The bubble the human-wait beat keeps alive (set once the sink exists). */
  let beatMessageIdRef: () => string | null = () => null;
  let humanBeat: ReturnType<typeof setInterval> | null = null;
  const stopHumanBeat = (): void => {
    if (humanBeat !== null) clearInterval(humanBeat);
    humanBeat = null;
  };
  /** While a person is being asked, refresh the bubble's liveness (see
   *  HUMAN_WAIT_BEAT_MS). Stops by itself once nothing is open any more. */
  const startHumanBeat = (): void => {
    if (humanBeat !== null) return;
    humanBeat = setInterval(() => {
      if (openRequests.size === 0 && blockedApprovals.length === 0) {
        stopHumanBeat();
        return;
      }
      const mid = beatMessageIdRef();
      if (mid) void opts.writer.heartbeat?.(mid);
    }, HUMAN_WAIT_BEAT_MS);
    (humanBeat as { unref?: () => void }).unref?.();
  };
  let markUntrustedRef: (() => void) | null = null;
  let settledBindingsRef: (() => Promise<void>) | null = null;
  let resolveAccepted!: () => void;
  let rejectAccepted!: (e: unknown) => void;
  const accepted = new Promise<void>((res, rej) => {
    resolveAccepted = res;
    rejectAccepted = rej;
  });

  const done = (async () => {
    // 1) Session: resume the stored one, else create a new one. A minted
    // session id is persisted only AFTER prompt.submit is ACKed (pendingBind):
    // binding earlier would make a failed first send look WARM on retry (a
    // resume of a session that never received the history-carrying prompt).
    let storedSid: string | null = null;
    /** This turn declared its session unusable (silence, dead socket, lost correlation),
     *  so the terminal cleared it. Nothing may bind afterwards. */
    let sessionUntrusted = false;
    markUntrustedRef = () => {
      sessionUntrusted = true;
    };
    /** Persistence of this turn's session bindings, SERIALIZED.
     *
     *  Two binds can be in flight at once — the freshly minted id, then a rotation
     *  announced by an auto-compaction in the same turn — and both were fire-and-forget.
     *  Nothing made the wire order match the decision order, so the mint could land AFTER
     *  the rotation and durably restore the parent session the gateway had just closed
     *  (raised in review). The chain makes the last decision the last write.
     *
     *  The untrusted check lives INSIDE the chain, so it is read at write time: a bind
     *  still queued when the turn gives up is dropped rather than resurrecting a session
     *  the terminal is clearing. One already on the network is covered by the reset epoch,
     *  which the clear bumps and `bindProviderChat` compares atomically. */
    let bindChain: Promise<void> = Promise.resolve();
    settledBindingsRef = () => bindChain;
    const persistBinding = (sid: string): void => {
      bindChain = bindChain
        .then(async () => {
          if (sessionUntrusted) return;
          await opts.onBoundSession?.(sid);
          // Record what CONVEX now holds, separately from what the turn believes: a
          // rotation whose write was dropped leaves Convex on the previous id, and an
          // abort naming the undropped one would match nothing and clear nothing.
          convexBoundSid = sid;
        })
        .catch((e) =>
          console.error(
            "[hermes-ws-turn] session bind failed (continuity miss):",
            (e as Error)?.message ?? e,
          ),
        );
    };
    let sessionCwd: string | null = null;
    /** Resolver for a scan that is waiting on the cwd, or null when nobody waits. */
    let resolveCwdWait: (() => void) | null = null;
    /** Wait, BOUNDED, for a `session.info` that carries the working directory.
     *
     *  The gateway emits `session.info` twice: once at turn start and once in the turn's
     *  TAIL, after `message.complete`. The terminal enqueues the outbound scan immediately,
     *  so on the very path G-48 is about — a resume whose reply carried no info block — the
     *  scan used to run while the cwd was still unknown and return empty, losing the file
     *  even though the answer was arriving one frame later (raised in review). On 0.18.2
     *  the turn-start `session.info` does not carry `cwd` at all (live capture), which
     *  makes the tail one the only source there.
     *
     *  A short wait, not a long one: this delays the turn's own terminal, so the bound is
     *  what keeps a gateway that never sends a cwd from holding every such turn open. When
     *  it lapses the scan is skipped and SAYS so. */
    const CWD_WAIT_MS = 2_000;
    const awaitSessionCwd = async (): Promise<void> => {
      if (sessionCwd) return;
      await new Promise<void>((resolve) => {
        resolveCwdWait = resolve;
        const t = setTimeout(() => {
          resolveCwdWait = null;
          resolve();
        }, CWD_WAIT_MS);
        (t as { unref?: () => void }).unref?.();
      });
    };
    let pendingBind: string | null = null;
    let effectiveText = opts.text;
    const noteCwd = (r: Record<string, unknown>) => {
      const info = r.info as { cwd?: unknown } | undefined;
      if (info && typeof info.cwd === "string" && info.cwd) sessionCwd = info.cwd;
    };
    // The REAL session is brand new despite a stored id (resume degraded or
    // threw) — the prompt must carry the rehydration history the warm prompt
    // deliberately omitted (freshText is best-effort inside: a context-fetch
    // failure returns the bare text).
    const recoverText = async (): Promise<void> => {
      if (opts.providerChatId && opts.freshText) {
        effectiveText = await opts.freshText();
      }
    };
    try {
      if (opts.providerChatId && isHermesWsStoredSessionId(opts.providerChatId)) {
        const r = await opts.client.call("session.resume", {
          session_id: opts.providerChatId,
        });
        noteCwd(r);
        // Server→client requests still waiting on this session (Hermes 0.21.3+) belong to a
        // run whose turn was lost; see `refuseOpenRequests` for why they are refused, not
        // replayed (codex, 0.21.5 passes 1 and 6).
        refuseOpenRequests(opts.client, r);
        runtimeSid = str(r.session_id) || null;
        storedSid = str(r.stored_session_id) || opts.providerChatId;
        boundStoredSid = storedSid;
      }
      if (!runtimeSid) {
        const r = await opts.client.call("session.create", {});
        noteCwd(r);
        runtimeSid = str(r.session_id) || null;
        storedSid = str(r.stored_session_id) || null;
        boundStoredSid = storedSid;
        if (!runtimeSid) {
          throw new Error("Hermes WS session.create returned no session_id");
        }
        if (storedSid) pendingBind = storedSid;
        await recoverText();
      }
    } catch (err) {
      // A stale stored session that fails to resume → recover with a fresh one
      // ONCE (same auto-recovery contract as the REST 404 path).
      if (opts.providerChatId && !runtimeSid) {
        try {
          const r = await opts.client.call("session.create", {});
          noteCwd(r);
          runtimeSid = str(r.session_id) || null;
          storedSid = str(r.stored_session_id) || null;
          boundStoredSid = storedSid;
          if (runtimeSid && storedSid) pendingBind = storedSid;
          if (runtimeSid) await recoverText();
        } catch {
          /* fall through to the reject below */
        }
      }
      if (!runtimeSid) {
        rejectAccepted(err);
        return;
      }
    }

    // 2) Subscribe THIS turn to the session's event lane, buffering events that
    // race ahead of beginTurn (the sink serializes via the apply chain).
    const sink = new TurnSink(
      opts.chatId,
      opts.writer,
      undefined,
      opts.sessionKey,
      opts.onTurnError,
    );
    beatMessageIdRef = () => sink.currentMessageId ?? null;
    const turnStartMs = Date.now();
    let lastThinkingBeatMs = 0;
    let moaAggregatorKey: string | null = null;
    // Tools whose start was seen but no complete yet — settled turns flush
    // them to "completed" so a lost completion event can never leave an
    // eternal spinner in the UI. Synthetic per-name FIFO ids (same contract as
    // HermesNormalizer) so a start and its complete carry the SAME toolCallId
    // — Convex's addPart upsert collapses the pair into ONE card (codex P2:
    // this transport bypasses the normalizer and was still stacking pairs).
    const openTools = new Map<string, string[]>();
    let toolSeq = 0;
    // Live WS frames carry a NATIVE tool_id on both tool.generating and
    // tool.complete (ws-tools capture): use it as the stable pair key —
    // concurrent same-name calls completing out of start order still pair
    // correctly (codex P2). The per-name FIFO is the fallback for frames
    // without one (and feeds the settled-turn flush).
    const openToolId = (name: string, nativeId?: string): string => {
      const id = nativeId ? `hws:${nativeId}` : `hws:${name}:${toolSeq++}`;
      const queue = openTools.get(name) ?? [];
      queue.push(id);
      openTools.set(name, queue);
      return id;
    };
    const closeToolId = (name: string, nativeId?: string): string | undefined => {
      const queue = openTools.get(name);
      let id: string | undefined;
      if (nativeId) {
        const want = `hws:${nativeId}`;
        const i = queue?.indexOf(want) ?? -1;
        // Even an UNSEEN native id (lost start) pairs stably — the upsert
        // just inserts a single completed card under that id.
        id = i >= 0 ? queue!.splice(i, 1)[0] : want;
      } else {
        id = queue?.shift();
      }
      if (queue !== undefined && queue.length === 0) openTools.delete(name);
      return id;
    };
    const closeOpenTools = (): void => {
      for (const [name, ids] of openTools) {
        for (const id of ids) {
          apply([
            {
              type: EVENT_TOOL_STATUS,
              name,
              phase: "completed",
              toolCallId: id,
              runId: runtimeSid,
            },
          ]);
        }
      }
      openTools.clear();
    };
    // Close the MoA aggregator card on ANY terminal path (success, error,
    // approval, abort/socket) — a card left "running" wedges the composer's
    // hold-the-send until the 20-min reaper (codex P1).
    const closeMoaAggregator = (status: "done" | "error" | "aborted"): void => {
      if (!moaAggregatorKey) return;
      const key = moaAggregatorKey;
      moaAggregatorKey = null;
      void opts.writer
        .upsertSubAgent?.({
          chatId: opts.chatId,
          parentMessageId: sink.currentMessageId,
          childSessionKey: key,
          status,
        })
        ?.catch(() => {});
    };
    let chain: Promise<void> = Promise.resolve();
    let finalized = false;
    finalizedRef = () => finalized;
    let replyText = "";
    const apply = (events: BridgeEvent[]): void => {
      if (events.length === 0) return;
      chain = chain.then(() => sink.apply(events));
    };
    let settle!: () => void;
    const turnDone = new Promise<void>((res) => {
      settle = res;
    });
    forceSettleRef = (writeAborted?: boolean) => {
      if (finalized) return;
      finalized = true;
      disarmRecv();
      closeOpenTools();
      closeMoaAggregator("aborted");
      if (writeAborted) {
        apply([
          {
            type: EVENT_MESSAGE_FINAL,
            text: replyText,
            // OURS, not the provider's: this terminal is written for a `/reset`,
            // before the interrupt call even goes out. Filed as `gateway_abort` it
            // was indistinguishable from an abort Hermes actually reported — the
            // stored verdict claiming the provider did something it never did.
            diagnosticFinalizeCause: "session_reset",
          },
          { type: EVENT_RUN_STATUS, status: "aborted", runId: runtimeSid },
        ]);
      }
      settle();
    };

    // Open Hermes sub-agents of THIS turn: the parent phase must stay
    // awaiting_subagents until the LAST child settles (codex P2 — Hermes emits
    // a per-child complete, and clearing on the first would drop the chip
    // while siblings still run).
    const openChildren = new Set<string>();
    // setPhase is fire-and-forget on the writer (doPost, OUTSIDE the per-message
    // op chain): two quick calls could reorder on the wire and apply the
    // clearing "generating" BEFORE the "awaiting_subagents" it must erase,
    // wedging the chip (codex P2). Serialize them through a local chain.
    let phaseChain: Promise<unknown> = Promise.resolve();
    const setPhaseOrdered = (mid: string, phase: string): void => {
      // setPhase RETURNS its HTTP promise (writer contract) — awaiting it in
      // the chain is what actually orders the wire writes.
      const call = () => Promise.resolve(opts.writer.setPhase?.(mid, phase));
      phaseChain = phaseChain.then(call, call);
    };
    /** C4 (W9) on the DEFAULT Hermes transport. `providers/hermes/turn.ts` is the REST
     *  path; this one is what `performHermesSend` picks unless told otherwise, so a
     *  sensor covering only the other file is a sensor covering almost nothing — and a
     *  test asserting "both providers are instrumented" by reading that file was green
     *  for exactly that wrong reason. Reports and RETHROWS: whatever the dispatcher does
     *  with a throwing handler today, it keeps doing. */
    const onEvent = (
      type: string,
      payload: Record<string, unknown>,
      /** Set only when the ROUTER made this event up — beside the payload, never
       *  inside it (see HermesWsSessionHandlers). */
      synthetic?: SyntheticOrigin,
    ): void => {
      try {
        applyEvent(type, payload, synthetic);
      } catch (err) {
        protocolDrift.observeException({ type, payload }, err, "hermes-ws-event");
        throw err;
      }
    };
    /** Record what the agent asked as an AGENT REQUEST: the card the person answers.
     *  Detached — a slow write must never stall the reader. */
    const raiseRequest = (
      record: Omit<AgentRequestRecord, "chatId" | "messageId">,
    ): void => {
      openRequests.add(record.providerRequestId);
      const full = { chatId: opts.chatId, messageId: sink.currentMessageId ?? null, ...record };
      // A write Convex REFUSED (`id: null`) is a write that failed: no card exists, and the
      // failure path below must see it (codex P2).
      const attempt = () =>
        Promise.resolve(opts.writer.upsertAgentRequest?.(full)).then((r) => {
          if (r && r.recorded === false) throw new Error("the agent request was not recorded");
        });
      // Hermes emits a prompt ONCE and has no list to replay it from: a creation that
      // fails past the writer's own retries is tried once more, later, while the prompt
      // still waits (codex P2). The settle waits for this whole chain.
      const write = attempt()
        .catch(async () => {
          await new Promise((r) => {
            const t = setTimeout(r, HERMES_WRITE_RETRY_LATER_MS);
            (t as { unref?: () => void }).unref?.();
          });
          if (!openRequests.has(record.providerRequestId)) return;
          await attempt();
        })
        .catch((e) => {
          console.error(
            "[hermes-ws-turn] agent request write failed:",
            (e as Error)?.message ?? e,
          );
          // No card will ever show it. A server→client request is ADDRESSABLE: refuse it,
          // so Hermes withdraws it instead of waiting — without limit when its clarify
          // timeout is <= 0 (server.py `_clarify_timeout_seconds`) — and stop holding the
          // turn for it.
          if (record.answerById === true && openRequests.delete(record.providerRequestId)) {
            releaseServerRequestRef(record.providerRequestId);
            opts.client.rejectServerRequest?.(
              record.providerRequestId,
              "Atrium could not record this request",
            );
          }
        });
      writes.set(record.providerRequestId, write);
      startHumanBeat();
    };
    /** Show a blocking prompt in the thread, as a tool card. The user must SEE what the
     *  agent asked — a prompt answered (or left to expire) with nothing visible would
     *  look like the agent went quiet for no reason. */
    const surfacePrompt = (
      name: string,
      payload: Record<string, unknown>,
      phase: "result" | "expired" = "result",
    ): void => {
      const detail =
        str(payload.question) ||
        str(payload.prompt) ||
        str(payload.command) ||
        str(payload.env_var) ||
        "";
      apply([
        {
          type: EVENT_TOOL_STATUS,
          name,
          phase: "result",
          runId: runtimeSid,
          toolCallId: `${name}:${str(payload.request_id) || "na"}`,
          ...(detail ? { output: detail } : {}),
          ...(phase === "expired" ? { input: "expired" } : {}),
        },
      ]);
    };
    /** Answer the gateway so the turn stops being held. Addressed by `request_id`, which
     *  `_block` puts in the payload and is the ONLY address a responder accepts: without
     *  a readable one there is nothing to answer, and saying so beats hanging. */
    const respondToPrompt = (
      type: string,
      payload: Record<string, unknown>,
    ): void => {
      const responder = HERMES_PROMPT_RESPONDERS[type];
      if (!responder) return;
      const requestId = str(payload.request_id);
      if (!requestId) {
        // Named and bounded rather than ignored: the turn now rides its recv deadline
        // instead of the provider's, and the operator learns which build could not
        // answer which prompt.
        protocolDrift.observeException(
          { type, payload },
          new TypeError(`${type} carried no request_id — cannot answer`),
          "hermes-ws-event",
        );
        // Unanswerable, so the gateway holds the turn for its full timeout and THEN
        // carries on (`_block` returns "" and the agent proceeds). Ending the turn here
        // would kill one that is about to resume; the deadline stretches instead.
        holdForPrompt(type);
        return;
      }
      void opts.client
        .call(responder.method, { request_id: requestId, [responder.key]: "" })
        .catch((e) => {
          console.error(
            `[hermes-ws-turn] ${responder.method} failed (best effort):`,
            (e as Error)?.message ?? e,
          );
          // The answer never landed: the gateway is still blocked, same as if we had no
          // address at all. Same treatment — outlast its timeout rather than pre-empt it.
          holdForPrompt(type);
        });
    };
    /**
     * A SERVER→CLIENT request (Hermes 0.21.3+ — tui_gateway/server_requests.py): the
     * question arrives as a JSON-RPC request addressed by its own `srq-…` id and is answered
     * by that id (`request.answer`), so what the person answers is exactly what was asked —
     * no queue, no order to infer. The card is ANSWERED BY ID (`answerById`); Hermes
     * withdraws it with `request.cancel`, and it holds the turn until then.
     */
    const onServerRequest = (
      id: string,
      method: string,
      params: Record<string, unknown>,
    ): void => {
      if (!id) return;
      const refuse = (why: string): void => {
        // Nothing Atrium can show: said at once (`-32601`), so Hermes withdraws the request
        // (an approval as "withdrawn", never as a denial) instead of waiting out its deadline.
        protocolDrift.observeException(
          { type: method, payload: params },
          new TypeError(`${method} server request: ${why}`),
          "hermes-ws-event",
        );
        opts.client.rejectServerRequest?.(id, why);
      };
      const now = Date.now();
      switch (method) {
        case "terminal.read": {
          // A desktop-GUI buffer read — not something a person answers. Answered empty, as
          // the event form always was, and shown so the silence has a name.
          surfacePrompt("hermes.terminal_read", params);
          void opts.client
            .call("request.answer", { id, result: { value: "" } })
            .catch((e) =>
              console.error(
                "[hermes-ws-turn] terminal.read answer failed (best effort):",
                (e as Error)?.message ?? e,
              ),
            );
          return;
        }
        case "approval": {
          const approval = readHermesApproval(params);
          if (approval === null || runtimeSid === null) {
            refuse("no command or description to show");
            return;
          }
          raiseRequest({
            source: "hermes.approval",
            providerRequestId: id,
            answerById: true,
            sessionKey: runtimeSid,
            seq: nextHermesApprovalSeq(),
            ...(streamingAckSeq !== null ? { supersedesBeforeSeq: streamingAckSeq } : {}),
            expiresAt: now + HERMES_APPROVAL_HOLD_CEILING_MS,
            approval,
          });
          const mid = sink.currentMessageId;
          if (mid) void opts.writer.setPhase?.(mid, "awaiting_approval");
          holdServerRequest(id);
          return;
        }
        case "clarify": {
          const questions = readHermesClarify(params);
          if (questions === null) {
            refuse("no question to show");
            return;
          }
          raiseRequest({
            source: "hermes.clarify",
            providerRequestId: id,
            answerById: true,
            ...(runtimeSid !== null ? { sessionKey: runtimeSid } : {}),
            expiresAt: now + HERMES_APPROVAL_HOLD_CEILING_MS,
            questions,
          });
          const mid = sink.currentMessageId;
          if (mid) void opts.writer.setPhase?.(mid, "awaiting_input");
          holdServerRequest(id, { multiSelect: hermesClarifyMultiIds(params) });
          return;
        }
        case "sudo":
        case "secret": {
          raiseRequest({
            source: method === "secret" ? "hermes.secret" : "hermes.sudo",
            providerRequestId: id,
            answerById: true,
            ...(runtimeSid !== null ? { sessionKey: runtimeSid } : {}),
            expiresAt: now + HERMES_APPROVAL_HOLD_CEILING_MS,
            credential: readHermesCredential(
              method === "secret" ? "secret.request" : "sudo.request",
              params,
            ),
          });
          const mid = sink.currentMessageId;
          if (mid) void opts.writer.setPhase?.(mid, "awaiting_input");
          holdServerRequest(id);
          return;
        }
        default:
          refuse("not a request Atrium answers");
      }
    };
    /** A server→client request no card of this turn will show: refused `-32601`, so
     *  Hermes withdraws it at once instead of holding the agent for its whole deadline
     *  with no prompt anywhere (server_requests.py, #112548) — never swallowed after the
     *  registry told the client it was taken. */
    const refuseUnshown = (events: ReadonlyArray<readonly [string, Record<string, unknown>, unknown?]>): void => {
      for (const [t, p] of events) {
        if (t !== HERMES_SERVER_REQUEST_EVENT) continue;
        const id = str(p.id);
        if (id) opts.client.rejectServerRequest?.(id, "not a request this turn can show");
      }
    };
    /**
     * The agent moved: ask Hermes which of our open requests it still waits on. One
     * answered by ANOTHER client (`request.answer`, a response frame) leaves with no
     * `request.cancel` (server_requests.py `resolve_response`), so without asking, its card
     * stayed actionable and the turn held for nothing. Movement alone decides nothing:
     * tools run CONCURRENTLY (agent/tool_executor.py), so a neighbour's `tool.complete` says
     * nothing about a question still waiting. `session.events.since` past the latest seq
     * replays nothing and lists the requests still open (methods_session.py).
     */
    let reconcileInFlight = false;
    let reconcileAgain = false;
    const reconcileServerRequests = (): void => {
      if (reconcileInFlight) {
        reconcileAgain = true;
        return;
      }
      if (runtimeSid === null) return;
      reconcileInFlight = true;
      // Only what was open when the probe LEFT: a request raised while it was on the wire
      // is absent from its snapshot without being over (codex P2, 0.21.5 pass 22).
      const probed = [...serverRequestsOpen.keys()];
      void opts.client
        .call("session.events.since", {
          session_id: runtimeSid,
          last_seen: Number.MAX_SAFE_INTEGER,
        })
        .then((r) => {
          // No list, no verdict: an answer we cannot read closes nothing.
          if (!Array.isArray(r.open_requests)) return;
          const stillOpen = new Set(
            r.open_requests
              .map((q) => (typeof q === "object" && q !== null ? str((q as { id?: unknown }).id) : ""))
              .filter((id) => id !== ""),
          );
          for (const id of probed) {
            if (stillOpen.has(id) || !serverRequestsOpen.has(id)) continue;
            releaseServerRequestRef(id);
            settleRequest(id, "cancelled");
          }
        })
        .catch(() => {
          /* the probe failed: nothing learned, nothing closed */
        })
        .finally(() => {
          reconcileInFlight = false;
          const again = reconcileAgain;
          reconcileAgain = false;
          if (again && serverRequestsOpen.size > 0) reconcileServerRequests();
        });
    };
    const applyEvent = (
      type: string,
      payload: Record<string, unknown>,
      /** Set only when the ROUTER made this event up — beside the payload, never
       *  inside it: the payload is the provider's, and a fact about OUR decoding
       *  cannot be one it can forge. */
      synthetic?: SyntheticOrigin,
    ): void => {
      // A question for a run that is not ours yet (QUEUED, before our `message.start`) or
      // any more (finalized): nobody here will show it.
      if (type === HERMES_SERVER_REQUEST_EVENT && (awaitingOurTurn || finalized)) {
        refuseUnshown([[type, payload]]);
        return;
      }
      // The QUEUED gate. Everything before our run's `message.start` belongs to the turn
      // this prompt interrupted — its deltas, its tools, and above all its TERMINAL,
      // which used to close this bubble with someone else's reply.
      if (awaitingOurTurn) {
        if (type !== "message.start") return;
        awaitingOurTurn = false;
        return;
      }
      // Monitoring events (delegation / MoA) OUTLIVE the parent turn: a child
      // often completes AFTER the parent's message.complete (live-observed
      // order), and its terminal MUST still reach the monitor or the card
      // stays "running" and the composer's hold-the-send never releases.
      const isMonitoring =
        type.startsWith("subagent.") || type.startsWith("moa.");
      // `session.info` OUTLIVES the turn too, and it has to: the gateway emits it in the
      // turn's tail, AFTER `message.complete`, and that is the only announcement of a
      // session id ROTATED by an auto-compaction. Dropping it here is why the rotation was
      // never learned — the next turn then resumed a session the gateway had ENDED, so the
      // agent restarted from the pre-compaction transcript. It carries session-scoped
      // facts, never turn content, so admitting it late changes nothing about the reply.
      if (finalized && !isMonitoring && type !== "session.info") return;
      if (blockedApprovals.length > 0 && HERMES_APPROVAL_RESUME_EVENTS.has(type)) {
        releaseApprovalsRef();
      }
      if (serverRequestsOpen.size > 0 && HERMES_APPROVAL_RESUME_EVENTS.has(type)) {
        reconcileServerRequests();
      }
      switch (type) {
        case "message.delta": {
          const text = str(payload.text);
          if (!text) return;
          replyText += text;
          apply([{ type: EVENT_MESSAGE_DELTA, text, runId: runtimeSid }]);
          return;
        }
        case "thinking.delta":
        case "reasoning.delta": {
          // Reasoning stream — NEVER reply text (would duplicate/pollute). It IS
          // a "working" signal though: during a long pure-reasoning stretch the
          // row shows an honest activity pill instead of a frozen bubble.
          // Throttled to once a minute; uses `querying_gateway` (the accepted
          // phase for "the agent is busy on the gateway"). NOTE: like every
          // gateway (OpenClaw included), a genuinely SILENT turn is still capped
          // by the 12-min stuck-stream watchdog — real agentic turns interleave
          // deltas/tool parts, which DO refresh it.
          const nowMs = Date.now();
          if (nowMs - lastThinkingBeatMs >= 60_000) {
            lastThinkingBeatMs = nowMs;
            const mid = sink.currentMessageId;
            if (mid) {
              // Real gateway-frame liveness: bump the watchdog (heartbeat) AND
              // show an honest "working" pill.
              void opts.writer.heartbeat?.(mid);
              opts.writer.setPhase?.(mid, "querying_gateway");
            }
          }
          return;
        }
        case "status.update": {
          // Hermes re-tags a mid-turn auto-compaction to kind:"compacting"
          // (tui_gateway._status_update) precisely so drivers can show it —
          // map it to Atrium's context.compaction (phase pill + in-thread
          // marker, the same surface OpenClaw compactions use). Other kinds
          // (lifecycle notes) carry no user-facing signal here.
          if (str(payload.kind) === "compacting") {
            apply([
              {
                type: EVENT_CONTEXT_COMPACTION,
                phase: "inflight",
                runId: runtimeSid,
              },
            ]);
          }
          return;
        }
        case "approval.request": {
          // AN AGENT REQUEST the person answers — no longer a refusal Atrium invents
          // on their behalf. Hermes addresses approvals by SESSION (oldest first), so
          // the id is ours; `seq` keeps the order `approval.respond` resolves them in.
          const approval = readHermesApproval(payload);
          if (approval === null || runtimeSid === null) {
            // Nothing we can show or address: Hermes denies on its own at its
            // deadline, and the turn outlasts that deadline rather than dying first.
            holdForApproval(null);
            return;
          }
          const seq = nextHermesApprovalSeq();
          // OURS, and unique: Hermes gives an approval no id, and one that could recur
          // (clock + per-turn counter) would be recognised as an older card's replay —
          // the old card then answering the new command (codex P1).
          const providerRequestId = `hermes-approval:${runtimeSid}:${randomUUID()}`;
          const nowMs = Date.now();
          raiseRequest({
            source: "hermes.approval",
            providerRequestId,
            sessionKey: runtimeSid,
            seq,
            ...(streamingAckSeq !== null ? { supersedesBeforeSeq: streamingAckSeq } : {}),
            // No deadline of ours: the card closes when the agent moves again
            // (HERMES_APPROVAL_HOLD_CEILING_MS), whatever the operator configured.
            expiresAt: nowMs + HERMES_APPROVAL_HOLD_CEILING_MS,
            approval,
          });
          const mid = sink.currentMessageId;
          if (mid) void opts.writer.setPhase?.(mid, "awaiting_approval");
          holdForApproval(providerRequestId);
          return;
        }
        case "clarify.request": {
          // A QUESTION the person answers in the card — never answered by Atrium in
          // their place (not even empty any more: an empty answer is what "skip" sends,
          // and only the person chooses it).
          const requestId = hermesRequestId(payload);
          const questions = readHermesClarify(payload);
          if (requestId === null || questions === null) {
            protocolDrift.observeException(
              { type, payload },
              new TypeError(`${type} carried no request_id or question — cannot answer`),
              "hermes-ws-event",
            );
            holdForPrompt(type);
            return;
          }
          raiseRequest({
            source: "hermes.clarify",
            providerRequestId: requestId,
            ...(runtimeSid !== null ? { sessionKey: runtimeSid } : {}),
            expiresAt: Date.now() + (HERMES_PROMPT_TIMEOUT_MS[type] ?? 300_000),
            questions,
          });
          const mid = sink.currentMessageId;
          if (mid) void opts.writer.setPhase?.(mid, "awaiting_input");
          holdForPrompt(type);
          return;
        }
        case "terminal.read.request": {
          // A desktop-GUI buffer read — not something a person answers. Answered
          // empty, as before, and shown so the silence has a name.
          surfacePrompt("hermes.terminal_read", payload);
          respondToPrompt(type, payload);
          return;
        }
        case "secret.request":
        case "sudo.request": {
          // A CREDENTIAL the person may type (masked; it transits to Hermes and is
          // never stored). Still never invented by Atrium: left unanswered, the
          // gateway's own expiry is the fail-closed and its `*.expire` settles the card.
          const requestId = hermesRequestId(payload);
          if (requestId === null) {
            protocolDrift.observeException(
              { type, payload },
              new TypeError(`${type} carried no request_id — cannot answer`),
              "hermes-ws-event",
            );
            holdForPrompt(type);
            return;
          }
          raiseRequest({
            source: type === "secret.request" ? "hermes.secret" : "hermes.sudo",
            providerRequestId: requestId,
            ...(runtimeSid !== null ? { sessionKey: runtimeSid } : {}),
            expiresAt: Date.now() + (HERMES_PROMPT_TIMEOUT_MS[type] ?? 120_000),
            credential: readHermesCredential(type, payload),
          });
          const mid = sink.currentMessageId;
          if (mid) void opts.writer.setPhase?.(mid, "awaiting_input");
          holdForPrompt(type);
          return;
        }
        case HERMES_SERVER_REQUEST_EVENT: {
          onServerRequest(
            str(payload.id),
            str(payload.method),
            typeof payload.params === "object" && payload.params !== null && !Array.isArray(payload.params)
              ? (payload.params as Record<string, unknown>)
              : {},
          );
          return;
        }
        case "connection.request": {
          // `manage_connections` (Hermes 0.21) opened a connection card and the tool BLOCKS
          // until it settles or its deadline passes (tools/connectors/operation.py, 300 s by
          // default). Atrium has no surface to act on it; it shows the step so the wait has a
          // name, and the turn outlasts the SERVER's own deadline instead of dying first as a
          // silence.
          surfacePrompt("hermes.connection", payload);
          const t = typeof payload.timeout_seconds === "number" ? payload.timeout_seconds : 300;
          const budgetMs = Math.min(Math.max(t, 0), 3600) * 1000;
          promptGraceUntil = Math.max(
            promptGraceUntil,
            Date.now() + budgetMs + PROMPT_GRACE_MARGIN_MS,
          );
          armRecv();
          return;
        }
        case "request.cancel": {
          // Hermes WITHDREW one open request (tui_gateway/contracts/server_requests.py):
          // its deadline passed, the run was interrupted, the session closed, or another
          // surface answered it. The card closes — expired for a deadline, no longer awaited
          // otherwise — and it no longer holds the turn.
          const id = str(payload.id);
          if (!id || !serverRequestsOpen.has(id)) return;
          releaseServerRequestRef(id);
          settleRequest(id, str(payload.reason) === "timeout" ? "expired" : "cancelled");
          return;
        }
        case "secret.expire":
        case "sudo.expire": {
          const requestId = hermesRequestId(payload);
          if (requestId !== null) settleRequest(requestId, "expired");
          return;
        }
        case "subagent.start":
        case "subagent.thinking":
        case "subagent.tool":
        case "subagent.progress":
        case "subagent.complete": {
          // Hermes delegation → the EXISTING sub-agent monitor (subAgents table
          // + the "N sous-agents" panel). Live-captured payloads carry
          // {goal, subagent_id, child_session_id, depth, model, toolsets,
          //  tool_name?, text/summary/status/duration on complete}. Only names/
          // config/result cross — tool args/previews stay gateway-side.
          const child = str(payload.child_session_id) || str(payload.subagent_id);
          if (!child) return;
          const mid = sink.currentMessageId;
          const record: SubAgentRecord = {
            chatId: opts.chatId,
            parentMessageId: mid,
            childSessionKey: `hermes:${child}`,
            status: "running",
          };
          if (type === "subagent.start") {
            record.taskName = str(payload.goal) || undefined;
            record.sessionMeta = {
              model: str(payload.model) || undefined,
              spawnDepth:
                typeof payload.depth === "number" ? payload.depth : undefined,
              gatewayKind: "hermes",
              runtime: "subagent",
            };
          } else if (type === "subagent.tool") {
            const toolName = str(payload.tool_name);
            if (toolName) {
              record.tools = [{ name: toolName, status: "done" }];
            }
          } else if (type === "subagent.complete") {
            // THREE outcomes upstream, not two. `delegate_tool` settles a child as
            // `completed`, `interrupted` or `failed` (plus `timeout` on its own path), and
            // Atrium mapped everything that was not `completed` onto `error` — so a child
            // the user STOPPED was reported as one that broke, and a timeout was
            // indistinguishable from a genuine failure.
            const childStatus = str(payload.status);
            record.status =
              childStatus === "completed"
                ? "done"
                : childStatus === "interrupted"
                  ? "aborted"
                  : "error";
            // …and the gateway's own word is kept when the four-state enum cannot hold the
            // distinction. ENUM-CHECKED, not free text: this reaches storage.
            if (
              childStatus !== "" &&
              childStatus !== "completed" &&
              CHILD_TERMINAL_WORDS.has(childStatus)
            ) {
              record.providerStatus = childStatus;
            }
            const result = str(payload.summary) || str(payload.text);
            if (result) record.resultText = result;
            if (record.status === "error") {
              record.errorMessage = str(payload.text) || "Sub-agent failed.";
            }
            // PER-BRANCH ROLLUPS: what the child cost and how long it took. Numbers only,
            // and that is a decision — the same payload carries `files_read`/`files_written`
            // (server PATHS) and `output_tail` (fragments of the child's output). Those are
            // content by any reading, and the child's answer already reaches the thread
            // through `resultText`, so taking them here would copy content into a row that
            // exists to hold measurements.
            const rollup = {
              ...(num(payload.input_tokens) !== undefined
                ? { inputTokens: num(payload.input_tokens) }
                : {}),
              ...(num(payload.output_tokens) !== undefined
                ? { outputTokens: num(payload.output_tokens) }
                : {}),
              ...(num(payload.reasoning_tokens) !== undefined
                ? { reasoningTokens: num(payload.reasoning_tokens) }
                : {}),
              ...(num(payload.api_calls) !== undefined
                ? { apiCalls: num(payload.api_calls) }
                : {}),
              ...(num(payload.duration_seconds) !== undefined
                ? { durationSeconds: num(payload.duration_seconds) }
                : {}),
            };
            if (Object.keys(rollup).length > 0) record.rollup = rollup;
          }
          void opts.writer
            .upsertSubAgent?.(record)
            ?.catch(() => {/* monitor is best-effort */});
          // Parent phase: awaiting while ANY child works; the resume signal
          // ("generating" — Convex clears the stored phase) only when the LAST
          // open child settles.
          if (type === "subagent.complete") openChildren.delete(child);
          else openChildren.add(child);
          if (mid) {
            setPhaseOrdered(
              mid,
              openChildren.size === 0 ? "generating" : "awaiting_subagents",
            );
          }
          return;
        }
        case "moa.reference": {
          // Mixture-of-Agents: each reference model's private answer, surfaced
          // as a STRUCTURED agent card (label + index/count + its text) so the
          // MoA execution is visible — a Hermes capability OpenClaw lacks.
          const mid = sink.currentMessageId;
          const idx = typeof payload.index === "number" ? payload.index : 0;
          const count = typeof payload.count === "number" ? payload.count : 0;
          const label = str(payload.label) || `reference ${idx}`;
          void opts.writer
            .upsertSubAgent?.({
              chatId: opts.chatId,
              parentMessageId: mid,
              childSessionKey: `hermes-moa:${mid ?? runtimeSid}:ref${idx}`,
              taskName: count
                ? `MoA ${idx}/${count} — ${label}`
                : `MoA — ${label}`,
              status: "done",
              resultText: str(payload.text) || undefined,
              sessionMeta: {
                model: label,
                gatewayKind: "hermes",
                subagentRole: "moa_reference",
              },
            })
            ?.catch(() => {});
          return;
        }
        case "moa.aggregating": {
          const mid = sink.currentMessageId;
          const aggregator = str(payload.aggregator) || "aggregator";
          moaAggregatorKey = `hermes-moa:${mid ?? runtimeSid}:aggregate`;
          // A visible "mixture_of_agents" tool marker: it (1) shows the MoA
          // step in the tools list and (2) is the cheap NAME gate that unlocks
          // the sub-agent panel on this message (same pattern as
          // sessions_spawn/delegate_task).
          apply([
            {
              type: EVENT_TOOL_STATUS,
              name: "mixture_of_agents",
              phase: "start",
              toolCallId: openToolId("mixture_of_agents"),
              runId: runtimeSid,
            },
          ]);
          void opts.writer
            .upsertSubAgent?.({
              chatId: opts.chatId,
              parentMessageId: mid,
              childSessionKey: moaAggregatorKey,
              taskName: `MoA agrégation — ${aggregator}`,
              status: "running",
              sessionMeta: {
                model: aggregator,
                gatewayKind: "hermes",
                subagentRole: "moa_aggregator",
              },
            })
            ?.catch(() => {});
          return;
        }
        case "tool.start":
        case "tool.generating": {
          // Live-captured: {tool_id, name, context}. NAME ONLY crosses (the
          // args/result stay gateway-side — same content-hygiene rule as the
          // OpenClaw tool feed).
          const name = str(payload.name) || "tool";
          apply([
            {
              type: EVENT_TOOL_STATUS,
              name,
              phase: "start",
              toolCallId: openToolId(name, str(payload.tool_id) || undefined),
              runId: runtimeSid,
            },
          ]);
          return;
        }
        case "tool.complete": {
          const name = str(payload.name) || "tool";
          const id = closeToolId(name, str(payload.tool_id) || undefined);
          apply([
            {
              type: EVENT_TOOL_STATUS,
              name,
              phase: "completed",
              ...(id !== undefined ? { toolCallId: id } : {}),
              runId: runtimeSid,
            },
          ]);
          return;
        }
        case "session.info": {
          // A ROTATED session id (auto-compaction ends the current session and continues
          // in a new one — upstream `_sync_session_key_after_compress`). Learn it, or the
          // next turn resumes a session that no longer exists and the agent starts from
          // the transcript as it was BEFORE the compaction: the "it forgot what we just
          // said" report, in its Hermes form.
          // THE WORKING DIRECTORY, from the channel that actually carries it. The
          // outbound scan needs it, and its old fallback asked `session.status` — which
          // returns ONLY `{output: "<human-readable lines>"}`, no `cwd`, in 0.18.2 and
          // 0.19.0 alike. So the recovery was dead code and delivered files were silently
          // lost whenever the resume reply carried no info block (G-48). `_session_info`
          // does carry `cwd`, and this event fires at turn START — before the scan.
          // THE GATEWAY VERSION. Same frame, and the ONLY one that carries it on this
          // transport (`onGatewayVersion`). Guarded by SCHEME, not by first character: the
          // field is present-but-EMPTY whenever the version import fails upstream
          // (`info["version"] = ""` is the literal default), and — the case that matters —
          // Hermes also publishes a CALENDAR tag (`v2026.7.20`) for the very same build,
          // which parses as a valid semver and compares as beyond everything ever
          // validated. `isHermesVersionScheme` is where that rule lives, next to the range
          // it is a rule about (raised in review).
          // WHICH BUILDER SENT IT, not whether the field happens to be there — and the
          // marker comes from the source rather than from taste.
          //
          // `session.info` has two upstream builders. `_session_info` is the full one and
          // ALWAYS carries `version` (empty string when its version import fails, which is
          // an answer: we no longer know). The LEAN ones — a session with no agent yet —
          // send `{cwd, branch, project, lazy: true}` and say nothing about the version;
          // `_session_info` never sets `lazy`, so the flag tells them apart exactly.
          //
          // Both directions are load-bearing. Retiring on a lean frame would drop a good
          // observation several times per session; NOT retiring on a full frame that has
          // stopped carrying the field would keep publishing a version the gateway no
          // longer confirms — with its capability set, its banner and its gates (both
          // raised in review, two passes apart).
          if (payload.lazy !== true) {
            opts.onGatewayVersion?.(
              readHermesGatewayVersion(payload.version, "session.info"),
            );
          }
          const infoCwd = str(payload.cwd);
          if (infoCwd) {
            sessionCwd = infoCwd;
            // Release a scan that is waiting for exactly this — see `awaitSessionCwd`.
            resolveCwdWait?.();
            resolveCwdWait = null;
          }
          const rotated = str(payload.stored_session_id);
          if (
            rotated &&
            rotated !== boundStoredSid &&
            isHermesWsStoredSessionId(rotated) &&
            // A turn that declared its session untrusted (silence, dead socket, lost
            // correlation) has just had it CLEARED. Binding here would write a session
            // straight back into the slot that clearing exists to empty.
            !sessionUntrusted
          ) {
            boundStoredSid = rotated;
            persistBinding(rotated);
          }
          // Model/provider/knobs — the same meta channel OpenClaw feeds.
          const meta: SessionMetaReport = {};
          if (str(payload.model)) meta.model = str(payload.model);
          if (str(payload.provider)) meta.modelProvider = str(payload.provider);
          if (str(payload.reasoning_effort)) {
            meta.thinkingLevel = str(payload.reasoning_effort);
          }
          if (Object.keys(meta).length > 0) {
            // BEST-EFFORT, off the ordered chain: a slow/failing meta write
            // must never block or reject the reply/finalize path (codex P2).
            void opts.writer
              .reportSessionMeta(opts.chatId, meta)
              .catch((e) =>
                console.error(
                  "[hermes-ws-turn] session meta failed:",
                  (e as Error)?.message ?? e,
                ),
              );
          }
          return;
        }
        case "tool.output_risk": {
          // THE GATEWAY SCANNED A TOOL'S OUTPUT and reached a verdict — a risk level, the
          // pattern ids it matched, and whether it REDACTED something before the model saw
          // it. Atrium dropped the whole event, so a redaction the gateway performed on the
          // user's behalf was invisible and a high-risk result looked like any other.
          //
          // Carried on the SAME part as the call it judges: `toolCallId` is the upsert key,
          // so the verdict lands on that card instead of opening a second one. Content-free
          // by construction (a finding is a pattern identifier, never the matched text) —
          // verified in the scanner, not assumed.
          const nativeRiskId = str(payload.tool_id);
          const riskName = str(payload.name);
          if (!nativeRiskId || !riskName) return;
          // THE SAME KEY the lifecycle uses. `tool.start`/`tool.complete` normalize the
          // native id to `hws:<id>`, and Convex's upsert compares keys EXACTLY — so
          // sending the raw id opened a SECOND completed card beside the one it judged
          // (raised in review). My test could not see it: its fake writer collects parts
          // instead of upserting them, which is precisely the "green for the wrong reason"
          // this programme keeps paying for.
          const riskToolId = `hws:${nativeRiskId}`;
          apply([
            {
              type: EVENT_TOOL_STATUS,
              name: riskName,
              // NOT a lifecycle step: this rides the existing card, and inventing a phase
              // would make a finished tool look like it started again.
              phase: "completed",
              runId: runtimeSid,
              toolCallId: riskToolId,
              risk: {
                level: str(payload.risk) || "low",
                findings: Array.isArray(payload.findings)
                  ? payload.findings.filter(
                      (f): f is string => typeof f === "string",
                    )
                  : [],
                redacted: payload.redacted === true,
              },
            },
          ]);
          return;
        }
        case "message.interim": {
          // SEALED AS ITS OWN SEGMENT — upstream's words. It emits this precisely "so the
          // desktop can seal it as its own segment instead of losing it when
          // message.complete replaces the streaming buffer", and Atrium dropped it in the
          // default case, so that loss is exactly what happened.
          //
          // A PART, never merged into the reply text. Merging would need a containment
          // test on prose, and the gateway re-renders its final (whitespace collapsed,
          // directives stripped): a false negative duplicates the paragraph in the bubble,
          // a false positive loses it, and neither is decidable from here.
          //
          // A CONTENT part, not a tool card. The first cut used a tool part and the
          // segment was stored where nobody could see it — the activity row is the
          // analysis view and is off by default (raised in review).
          //
          // `already_streamed` does NOT decide whether to seal — it only says the text
          // also went out as deltas. The terminal replaces that buffer either way, which
          // is the whole reason this event exists.
          const interim = str(payload.text).trim();
          if (!interim) return;
          apply([{ type: EVENT_REASONING, text: interim, runId: runtimeSid }]);
          return;
        }
        case "message.complete": {
          finalized = true;
          // The MoA aggregator (if any) finished with the reply it produced.
          if (moaAggregatorKey) {
            const moaId = closeToolId("mixture_of_agents");
            apply([
              {
                type: EVENT_TOOL_STATUS,
                name: "mixture_of_agents",
                phase: "completed",
                ...(moaId !== undefined ? { toolCallId: moaId } : {}),
                runId: runtimeSid,
              },
            ]);
          }
          closeOpenTools();
          closeMoaAggregator("done");
          // Outbound scan (ordered on the apply chain): freshly-written
          // delivery files ride EVENT_MEDIA ahead of the final pair, so the
          // sink attaches them to THIS message before finalize.
          if (opts.filesFetcher) {
            const fetcher = opts.filesFetcher;
            chain = chain.then(async () => {
              // NO `session.status` FALLBACK. It used to sit here to recover a missing
              // cwd, and it could never work: that RPC returns only
              // `{output: "<human-readable lines>"}` — no `cwd` field in 0.18.2 or 0.19.0
              // — so the branch was dead and delivered files were silently lost (G-48).
              // The cwd now comes from `session.info`, which really carries it and fires
              // at turn start; a scan with no cwd still returns, but that case is now the
              // genuine "the gateway never told us" rather than a fallback that lied.
              // The tail `session.info` may still be in flight — wait for it, briefly.
              if (!sessionCwd) await awaitSessionCwd();
              if (!sessionCwd) {
                console.error(
                  `[hermes-ws-turn] no session cwd chat=${opts.chatId} — outbound scan ` +
                    "skipped; delivered files cannot be found",
                );
                return;
              }
              const dir = `${sessionCwd}/${HERMES_DELIVERY_DIR}`;
              const entries = await fetcher.listFiles(dir);
              const fresh = entries.filter((e) => e.mtime >= turnStartMs - 2_000);
              if (fresh.length === 0) return;
              await sink.apply([
                {
                  type: "media",
                  items: fresh.map((e) => ({
                    filename: e.name,
                    path: e.path,
                    explicit: true,
                  })),
                  runId: runtimeSid,
                } as BridgeEvent,
              ]);
            });
          }
          const text = str(payload.text) || replyText;
          const usage = (payload.usage ?? {}) as Record<string, unknown>;
          // Channel semantics (same as OpenClaw): totalTokens = tokens USED in
          // the context window, contextTokens = the window SIZE. Hermes maps
          // context_used → used and context_max → window (15968/272000 = the
          // captured 6% — inverting them would read the window as ~16k and
          // trigger premature pressure/summarize; codex P2).
          const used =
            typeof usage.context_used === "number" ? usage.context_used : undefined;
          const windowMax =
            typeof usage.context_max === "number" ? usage.context_max : undefined;
          // …and the FACTS THE GATEWAY ALREADY COMPUTED, which Atrium dropped (G-50).
          // `compressions` is the important one: the gateway counts its own compactions and
          // the count rides THIS terminal, whereas the `status.update` marker Atrium relies
          // on is broadcast `dropIfSlow` upstream — so a slow consumer sees a session that
          // silently forgot half its history. A count also says HOW MANY, which a marker
          // cannot.
          const compactionCount = num(usage.compressions);
          const contextPercent = num(usage.context_percent);
          const activeSubagents = num(usage.active_subagents);
          const apiCalls = num(usage.calls);
          if (
            used !== undefined ||
            windowMax !== undefined ||
            compactionCount !== undefined ||
            contextPercent !== undefined ||
            activeSubagents !== undefined ||
            apiCalls !== undefined
          ) {
            void opts.writer
              .reportSessionMeta(opts.chatId, {
                totalTokens: used,
                contextTokens: windowMax,
                ...(compactionCount !== undefined ? { compactionCount } : {}),
                ...(contextPercent !== undefined ? { contextPercent } : {}),
                ...(activeSubagents !== undefined ? { activeSubagents } : {}),
                ...(apiCalls !== undefined ? { apiCalls } : {}),
              })
              .catch((e) =>
                console.error(
                  "[hermes-ws-turn] usage meta failed:",
                  (e as Error)?.message ?? e,
                ),
              );
          }
          // THREE outcomes upstream, not two. `interrupted` means the run was cut short:
          // reading it as `complete` handed the user a half-sentence as the finished
          // answer, with nothing marking it — the worst kind of loss, because it looks
          // deliberate. `aborted` is Atrium's existing word for a turn stopped mid-flight
          // and it KEEPS the partial text; it also does not schedule the zero-content
          // auto-retry, which is right — an interrupted turn must not silently re-run.
          // HISTORY DESYNC. The gateway tells us, in its own words, that "the response
          // above is visible but was not saved to session history" — its history_version
          // moved under the turn. The reply is in the bubble and NOT in the session, so
          // resuming that session means the agent has forgotten what it just said: the
          // exact "il a oublié ce qu'on vient de dire" report, arriving pre-announced and
          // thrown away.
          //
          // So the session is DROPPED rather than merely reported. That is not a
          // workaround: a session whose history is missing our own reply cannot be resumed
          // faithfully, and the next turn re-carries the history through `freshText`. Same
          // machinery as lot 31, for the same reason — we cannot vouch for what is in
          // there. Reported too, because a repair nobody can see is invisible in the
          // health stats where it belongs.
          const historyWarning = isHermesHistoryDesyncWarning(str(payload.warning));
          const rawStatus = str(payload.status);
          if (historyWarning) {
            console.error(
              `[hermes-ws-turn] history desync chat=${opts.chatId} — dropping the ` +
                "session so the next turn re-carries the history",
            );
            sessionUntrusted = true;
            opts.onSessionForgotten?.();
            // ONE health record per turn. An `error` terminal is already counted by the
            // sink at finalize, with its own normalized code — signalling here too would
            // book two failures for one turn AND let the later code overwrite this one
            // (raised in review). The drop happens either way; only the counting differs.
            if (rawStatus !== "error") opts.onTurnError?.("history_desync");
          }
          const status =
            rawStatus === "error"
              ? "error"
              : rawStatus === "interrupted"
                ? "aborted"
                : "complete";
          const finalEv: BridgeEvent = {
            type: EVENT_MESSAGE_FINAL,
            text,
            // WHY it closed, from the provider's OWN terminal status — the three it
            // can report, told apart. Without it a Hermes turn stayed permanently
            // unexplainable once its traces expired.
            diagnosticFinalizeCause:
              status === "error"
                ? "gateway_error"
                : status === "aborted"
                  ? "gateway_abort"
                  : "gateway_final",
            // The drop rides THIS terminal, atomically, exactly as the silence path does.
            ...(historyWarning && boundStoredSid
              ? { clearProviderSession: boundStoredSid }
              : {}),
          };
          const statusEv: BridgeEvent = {
            type: EVENT_RUN_STATUS,
            status,
            runId: runtimeSid,
          };
          if (status === "error") {
            // Prefer ANY detail the runtime attached (live 2026-07-20: an
            // APIConnectionError run carried its cause outside `error`) — the
            // detail both informs the user and feeds the transient classifier.
            let msg =
              str(payload.error) ||
              str(payload.message) ||
              str(payload.detail) ||
              str(payload.summary) ||
              "Hermes run failed.";
            // Failure prose streamed as the reply body (live 2026-07-20:
            // "API call failed after 3 retries: Connection error" WAS the
            // text while `error` fell back): promote it — it is not content,
            // and leaving it blocks the zero-content auto-retry.
            // Two shapes, two burdens of proof. The runtime's log prefixes are evidence
            // in themselves; `Error: …` is the gateway's SUBSTITUTE for a missing answer,
            // written only when nothing visible was produced — so it is admitted only
            // when nothing streamed. Otherwise a real partial answer starting that way
            // would be erased from the bubble (raised in review).
            if (
              msg === "Hermes run failed." &&
              typeof finalEv.text === "string" &&
              (isHermesRuntimeFailureText(finalEv.text) ||
                isHermesSyntheticErrorText(finalEv.text, replyText))
            ) {
              msg = finalEv.text.trim();
              finalEv.text = "";
              // The prose also STREAMED live: the finalize must not resurrect
              // it from the stream row (codex P1 — atomic discard).
              (finalEv as { discardStreamText?: boolean }).discardStreamText = true;
            } else if (
              // Hermes 0.21 says it STRUCTURALLY: a failed turn carries `error`, and
              // `partial: true` only when real partial text exists; otherwise its `text` is
              // its own failure copy ("… Your message was not answered. Details: …",
              // prompt_turn.py turn_error_text). Not content — kept as the reply it would
              // block the zero-content auto-retry. Still refused when anything streamed:
              // what the person already saw is never erased on a flag.
              str(payload.error) !== "" &&
              payload.partial !== true &&
              typeof finalEv.text === "string" &&
              finalEv.text.trim() !== "" &&
              replyText.trim() === ""
            ) {
              finalEv.text = "";
              (finalEv as { discardStreamText?: boolean }).discardStreamText = true;
            }
            finalEv.error = msg;
            statusEv.message = msg;
            const kind = classifyProviderInternal(msg);
            if (kind) finalEv.errorKind = kind;
          }
          apply([finalEv, statusEv]);
          settle();
          return;
        }
        case "error": {
          finalized = true;
          closeOpenTools();
          closeMoaAggregator("error");
          let msg =
            str(payload.message) ||
            str(payload.text) ||
            str(payload.error) ||
            str(payload.detail) ||
            "Hermes run failed.";
          // Same failure-prose promotion as the terminal-status branch: the
          // runtime can stream its failure text as DELTAS then send a bare
          // `error` event (codex P2) — that prose is not content, and leaving
          // it would render a fake reply AND block the zero-content retry.
          let errText = replyText;
          let promoted = false;
          // Only the runtime's own log prefixes here: this branch reads what STREAMED, so
          // the "nothing was produced" evidence the synthetic shape needs cannot exist.
          if (isHermesRuntimeFailureText(errText)) {
            if (msg === "Hermes run failed.") msg = errText.trim();
            errText = "";
            promoted = true;
          }
          const errKind = classifyProviderInternal(msg);
          // A terminal this build could not DECODE reaches here as an `error` —
          // the router promotes it so the reader has one terminal shape. The reason
          // travels BESIDE the payload: filed as `gateway_error`, a protocol drift
          // of ours would sit in the record for ever as a failure Hermes reported,
          // and read from the payload it would be a fact Hermes could forge.
          const unreadable = synthetic === "unreadable_terminal";
          apply([
            {
              type: EVENT_MESSAGE_FINAL,
              text: errText,
              error: msg,
              ...(errKind ? { errorKind: errKind } : {}),
              diagnosticFinalizeCause: unreadable
                ? "unreadable_terminal"
                : "gateway_error",
              // The prose streamed live — discard the stream fallback too
              // (codex P1).
              ...(promoted ? { discardStreamText: true } : {}),
            },
            { type: EVENT_RUN_STATUS, status: "error", runId: runtimeSid, message: msg },
          ]);
          settle();
          return;
        }
        default:
          // message.start / status.update / session.title / reasoning.available
          // — no NormalizedEvent needed (forward-compatible ignore).
          return;
      }
    };
    // RECV DEADLINE. Until now this turn awaited its terminal with no bound at all: a
    // dropped frame or a silent gateway left the row `streaming` until Convex's
    // stuck-stream watchdog reaped it — up to STALE_STREAM_MS, twelve minutes of
    // "Réflexion…" for someone waiting on an answer that had already been lost. The
    // OpenClaw path has armed a recv deadline for exactly this since its own normalizer
    // was written; this transport simply never grew one.
    //
    // Silence is silence: a lost frame and a stalled provider are indistinguishable from
    // inside the bridge, and this covers both rather than only the case that prompted it.
    // The deadline may only exist AFTER the provider accepted the prompt. Placing the
    // first `armRecv()` post-ACK was not enough on its own: the event callback re-arms on
    // every frame, and a frame can arrive while `prompt.submit` is still in flight — the
    // same divergence, reached by the other door (raised in review). One barrier, checked
    // by both.
    let promptAccepted = false;
    /** `queued`: the provider stashed our prompt and will run it as the next turn. Until
     *  a `message.start` announces that turn's beginning, everything on this lane belongs
     *  to the turn that was interrupted — and must NOT be applied to this bubble. */
    let awaitingOurTurn = false;
    let ackQueued = false;
    let ackSteered = false;
    /** Events can arrive on this lane BEFORE `prompt.submit` resolves — the socket is
     *  already subscribed and the client routes notifications independently of the RPC
     *  reply (raised in review). Judging them before the ACK is known is exactly the
     *  mistake: a `queued` run's own `message.start` could land first, be treated as
     *  someone else's, and then the gate would wait forever for a second one that never
     *  comes — 240 s of "Réflexion…" and a healthy session dropped. So we HOLD them and
     *  decide once the verdict is in. */
    let ackPending = true;
    // The third slot is the ROUTER's own account of the event (see SyntheticOrigin).
    // Held events are replayed verbatim below, and a tuple that dropped it turned an
    // undecodable terminal arriving before the ACK back into a provider failure.
    const ackHeld: Array<
      [string, Record<string, unknown>, SyntheticOrigin | undefined]
    > = [];
    /** Bounded, like every buffer in this bridge. The window is one RPC round trip, so
     *  this is orders of magnitude above any real burst; overflowing means the provider
     *  is behaving in a way we do not model, and holding more would trade a wrong
     *  attribution for a memory leak. */
    const ACK_HOLD_MAX = 512;
    let ackHeldOverflowed = false;
    /** The provider explicitly said it is streaming — see the ACK check below. */
    let ackedStreaming = false;
    /** Taken when Hermes ACKed this turn `streaming`: its session was idle then, so
     *  every approval ordered before is over (AgentRequestRecord.supersedesBeforeSeq),
     *  and every one this turn raises is ordered after. */
    let streamingAckSeq: number | null = null;
    let recvTimer: ReturnType<typeof setTimeout> | null = null;
    const disarmRecv = (): void => {
      if (recvTimer !== null) {
        clearTimeout(recvTimer);
        recvTimer = null;
      }
    };
    /** Until when the turn is legitimately BLOCKED on a gateway prompt we did not answer
     *  — the gateway's own timeout plus a margin. 0 when nothing is pending. */
    let promptGraceUntil = 0;
    /** A prompt this turn will NOT answer (a credential, by design) or COULD not answer
     *  (no address, or the responder RPC failed). Upstream unblocks at its own timeout,
     *  so the recv deadline has to outlast it — otherwise the turn dies first, blames
     *  silence, and drops a session that is perfectly healthy. */
    const holdForPrompt = (type: string): void => {
      const budget = HERMES_PROMPT_TIMEOUT_MS[type];
      if (budget === undefined) return;
      promptGraceUntil = Math.max(
        promptGraceUntil,
        Date.now() + budget + PROMPT_GRACE_MARGIN_MS,
      );
      armRecv();
    };
    /** Until when an approval may hold the turn (0 = none blocks it). */
    let approvalHoldUntil = 0;
    /** Until when open server→client requests may hold the turn (0 = none). Hermes
     *  carries no deadline in the frame — the timeout is its config's — and withdraws the
     *  request itself (`request.cancel`) when it gives up, so the hold is the same
     *  ceiling as an approval's rather than a guessed time. */
    let serverRequestHoldUntil = 0;
    const holdServerRequest = (id: string, held: HermesHeldServerRequest = NOT_A_CLARIFY): void => {
      serverRequestsOpen.set(id, held);
      serverRequestHoldUntil = Date.now() + HERMES_APPROVAL_HOLD_CEILING_MS;
      startHumanBeat();
      armRecv();
    };
    releaseServerRequestRef = (id: string) => {
      if (!serverRequestsOpen.delete(id)) return;
      if (serverRequestsOpen.size === 0) serverRequestHoldUntil = 0;
      armRecv();
    };
    /** The agent is now blocked on an approval (`null` = one we could not show). */
    const holdForApproval = (providerRequestId: string | null): void => {
      blockedApprovals.push({ id: providerRequestId, answered: false });
      approvalHoldUntil = Date.now() + HERMES_APPROVAL_HOLD_CEILING_MS;
      // Shown or not, the agent waits on a person: the bubble must outlive the
      // Convex watchdog for as long as Hermes does (codex P2).
      startHumanBeat();
      armRecv();
    };
    /** The agent moved again: every approval it was blocked on is over — answered here,
     *  answered elsewhere, or timed out on Hermes' side. The cards still open close as
     *  no longer awaited (an answer of ours in flight keeps its own verdict: Convex
     *  ignores this settle for a `submitting` row). Leaving one open would let a click
     *  decide whatever approval Hermes queues NEXT for this session. */
    releaseApprovalsRef = () => {
      for (const { id } of blockedApprovals.splice(0)) {
        if (id !== null) settleRequest(id, "cancelled");
      }
      approvalOrderUnknown = false;
      approvalHoldUntil = 0;
      armRecv();
    };
    const armRecv = (): void => {
      disarmRecv();
      if (finalized || !promptAccepted) return;
      // A blocked turn is not a silent turn: while a prompt we cannot answer is pending,
      // the deadline stretches to cover the gateway's own timeout.
      const graceLeft =
        Math.max(promptGraceUntil, approvalHoldUntil, serverRequestHoldUntil) - Date.now();
      const stretched = graceLeft > RECV_SILENCE_MS;
      const budget = stretched ? graceLeft : RECV_SILENCE_MS;
      recvTimer = setTimeout(() => {
        if (stretched) {
          // The BLOCK's budget elapsed — not the turn's. Upstream has given up on its own
          // prompt by now and the agent carries on, and its first move may well be silent
          // thinking. Killing the turn here would end one that just resumed (raised in
          // review), so an ORDINARY deadline starts fresh instead.
          //
          // `promptGraceUntil` is deliberately NOT reset: it is compared, never
          // remembered, so once it is in the past `graceLeft` goes negative and the
          // branch below picks the ordinary budget on its own. Clearing it was a line no
          // test could ever redden — dead code that reads like a guard.
          armRecv();
          return;
        }
        void onSilence();
      }, budget);
      // Never hold the process open for a turn nobody is waiting on.
      (recvTimer as { unref?: () => void }).unref?.();
    };

    /** The silence path, in the ONE order that survives concurrency.
     *
     *  `finalized` is set LAST, not first. Setting it up front made a concurrent `/abort`
     *  a no-op — `forceSettle` returns early on `finalized` — so the abort answered,
     *  Convex finalized the assistant, and the next send could drain while the clear was
     *  still in flight; a late clear could then wipe THAT turn's binding (raised in
     *  review). Leaving the turn un-finalized until the invalidation is done means a
     *  concurrent Stop simply takes the turn normally, and the re-check below stands down.
     */
    const onSilence = async (): Promise<void> => {
      if (finalized) return;
      console.error(
        `[hermes-ws-turn] no event for ${RECV_SILENCE_MS} ms — settling ` +
          `response_timeout chat=${opts.chatId}`,
      );
      // TELL THE PROVIDER. Silence does not prove the run stopped: the frames may simply
      // have been lost while Hermes kept running tools and their side effects. Releasing
      // the chat without interrupting leaves that run alive, out of the user's sight.
      void opts.client
        .call("session.interrupt", { session_id: runtimeSid })
        .catch((e) =>
          console.error(
            "[hermes-ws-turn] interrupt after timeout failed (best effort):",
            (e as Error)?.message ?? e,
          ),
        );
      // The stored session is dropped ATOMICALLY WITH THE TERMINAL below — see
      // `clearProviderSession`. It used to be a separate write, guarded by a retry and an
      // in-memory quarantine, because it could fail on its own while the turn settled
      // anyway; riding the finalize removes that failure mode instead of compensating for
      // it, and removes the quarantine with it.
      //
      // ONLY on silence. A delivered gateway error says the run is over; silence says we
      // do not know. Clearing on every failure would cost a rehydration each time.
      if (finalized) return;
      finalized = true;
      sessionUntrusted = true;
      // The IN-PROCESS half of the drop; the durable half rides the terminal below.
      opts.onSessionForgotten?.();
      closeOpenTools();
      closeMoaAggregator("aborted");
      apply([
        {
          type: EVENT_MESSAGE_FINAL,
          text: replyText,
          error: "Hermes stopped sending before the reply was complete.",
          errorKind: "response_timeout",
          diagnosticFinalizeCause: "response_timeout",
          // The ID we were watching, not a flag: this terminal can land AFTER a user
          // Stop released the chat and a newer turn bound a session of its own, and the
          // mutation drops the binding only while it is still this one.
          // The CURRENT binding, not the one this turn started on: a rotation learned
          // mid-turn moved it, and clearing the stale id would match nothing and leave
          // the rotated session bound to a turn declared unusable (raised in review).
          //
          // …and this cause is RECOVERABLE (G-47): the gateway may well have FINISHED the
          // reply we stopped seeing, so the id being dropped is kept as a read-only handle
          // for exactly one harvest. Only the two causes where WE lost sight of a live turn
          // get it — a user Stop and a `/reset` clear too and record nothing (the user
          // cancelled), and `correlation_lost` is left out for now because a lane we could
          // not attribute is weaker ground than a turn we simply stopped hearing.
          ...(boundStoredSid
            ? { clearProviderSession: boundStoredSid, recoverableSession: true }
            : {}),
        },
        {
          type: EVENT_RUN_STATUS,
          status: "error",
          runId: runtimeSid,
          message: "Hermes stopped sending before the reply was complete.",
        },
      ]);
      settle();
    };

    /** The socket carrying this turn died.
     *
     *  This is the SAME ignorance as silence, reached faster: the connection dying tells
     *  us nothing about whether Hermes stopped the run, which keeps going with its tools
     *  and their side effects. It used to finalize through an injected `error` event —
     *  a DELIVERED failure, which is what that branch means — so the turn ended without
     *  dropping the session, and the next send resumed the one nobody could vouch for.
     *
     *  Unlike the silence path there is no `session.interrupt`: the socket it would
     *  travel on is exactly what just died. That makes the drop MORE necessary here,
     *  not less. */
    const onTransportLost = (reason: string): void => {
      if (finalized) return;
      finalized = true;
      sessionUntrusted = true;
      disarmRecv();
      opts.onSessionForgotten?.();
      closeOpenTools();
      closeMoaAggregator("error");
      const msg = reason || "Hermes WS connection lost.";
      apply([
        {
          type: EVENT_MESSAGE_FINAL,
          text: replyText,
          error: msg,
          diagnosticFinalizeCause: "connection_lost",
          // The CURRENT binding, not the one this turn started on: a rotation learned
          // mid-turn moved it, and clearing the stale id would match nothing and leave
          // the rotated session bound to a turn declared unusable (raised in review).
          //
          // …and this cause is RECOVERABLE (G-47): the gateway may well have FINISHED the
          // reply we stopped seeing, so the id being dropped is kept as a read-only handle
          // for exactly one harvest. Only the two causes where WE lost sight of a live turn
          // get it — a user Stop and a `/reset` clear too and record nothing (the user
          // cancelled), and `correlation_lost` is left out for now because a lane we could
          // not attribute is weaker ground than a turn we simply stopped hearing.
          ...(boundStoredSid
            ? { clearProviderSession: boundStoredSid, recoverableSession: true }
            : {}),
        },
        { type: EVENT_RUN_STATUS, status: "error", runId: runtimeSid, message: msg },
      ]);
      settle();
    };

    // The lane can be REFUSED (a live turn already owns this runtime session). Nothing
    // has been submitted and no row exists yet, so rejecting `accepted` is the clean
    // exit: the dispatch fails by name and Convex owns the single error bubble. Sending
    // anyway would put this turn's reply into someone else's message.
    const laneHandlers: HermesWsSessionHandlers = {
      onEvent: (type, payload, synthetic) => {
        // RE-ARMED BY ANY EVENT of this session — including the monitoring ones that
        // outlive the parent turn. Progress is progress: a delegation still reporting is
        // not a stalled provider.
        armRecv();
        if (ackPending) {
          if (ackHeld.length < ACK_HOLD_MAX) {
            ackHeld.push([type, payload, synthetic]);
            return;
          }
          // Overflow FAILS CLOSED. Routing the surplus "because streaming is the common
          // verdict" would have re-created the very defect this lot exists to close: an
          // old turn can emit 512 deltas and then its `message.complete` during a slow
          // ACK, and that terminal would have closed THIS bubble with someone else's
          // reply (raised in review). Correlation is lost — say so, do not guess.
          if (!ackHeldOverflowed) {
            ackHeldOverflowed = true;
            console.error(
              `[hermes-ws-turn] more than ${ACK_HOLD_MAX} events before the ` +
                `prompt.submit ACK — correlation lost chat=${opts.chatId}`,
            );
          }
          refuseUnshown([[type, payload]]);
          return;
        }
        onEvent(type, payload, synthetic);
      },
      onTransportLost,
      // A child is THIS turn's once its first `subagent.*` reached it: a late terminal
      // then finds its own parent even after the session's next turn took the lane.
      ownsMonitoring: (type, payload) => {
        if (!type.startsWith("subagent.")) return false;
        const child = str(payload.child_session_id) || str(payload.subagent_id);
        return child !== "" && openChildren.has(child);
      },
    };
    let unsubscribe: (() => void) & { linger?: () => void };
    try {
      unsubscribe = registerSession(runtimeSid, laneHandlers);
    } catch (err) {
      rejectAccepted(err);
      return;
    }
    // NOT armed here. Subscribing happens BEFORE `beginTurn`, the attachment staging and
    // `prompt.submit` — a sequence the code itself documents as able to take minutes. An
    // early deadline would finalize the bubble `response_timeout` and then let the prompt
    // go out anyway: the user told the turn failed while the gateway runs it, and a retry
    // duplicating any side effect (raised in review). Staging is bounded by
    // `PRE_SEND_DEADLINE_MS`, which is what that budget is for. This deadline starts when
    // the provider has ACCEPTED and owes us a reply — see the arm after the ACK below.

    try {
      // 3) Open the streaming row BEFORE resolving accepted (chat busy before
      // /send returns 200 — same contract as the REST path).
      try {
        await sink.beginTurn(
          runtimeSid,
          undefined,
          false,
          false,
          opts.dispatchOutboxId ?? null,
        );
      } catch (err) {
        // The lane is already subscribed and may hold requests (replayed from the resume):
        // this turn will show none of them, so Hermes is told at once (codex P2).
        refuseUnshown(ackHeld);
        ackHeld.length = 0;
        rejectAccepted(err);
        return;
      }

      // 4) Stage the attachments, then submit. The ACK ({status:"streaming"})
      // is the acceptance point. An attach/submit failure settles the already-
      // created row as an actionable error (bridge-owned, single bubble).
      try {
        // Stage files, collecting the returned @file: refs — the desktop puts
        // those refs IN the prompt text (they are how the agent finds the
        // file); images render to vision tiles and need no ref.
        const fileRefs: string[] = [];
        for (const att of opts.attachments ?? []) {
          if (att.mimeType.startsWith("image/")) {
            await opts.client.call("image.attach_bytes", {
              session_id: runtimeSid,
              content_base64: att.content,
              filename: att.fileName,
            });
          } else {
            const r = await opts.client.call("file.attach", {
              session_id: runtimeSid,
              name: att.fileName,
              data_url: `data:${att.mimeType};base64,${att.content}`,
            });
            const ref = str(r.ref_text);
            if (ref) fileRefs.push(ref);
          }
        }
        const promptParts = [effectiveText];
        if (fileRefs.length) promptParts.push(fileRefs.join("\n"));
        if (opts.filesFetcher) promptParts.push(DELIVERY_DIRECTIVE);
        // Same rule as the OpenClaw path, at Hermes' acceptance point: staging above
        // can block for minutes, and past the deadline this dispatch is no longer
        // ours to submit (codex P1).
        assertBeforeSendDeadline(turnStartedMs, Date.now(), opts.dispatchAgeMs ?? 0);
        const ack = await opts.client.call("prompt.submit", {
          session_id: runtimeSid,
          text: promptParts.join("\n\n"),
        });
        // The ACK is what makes "accepted" mean something, and the deadline below now
        // keys on it — so a resolved RPC is not enough. The declared contract is
        // `{status:"streaming"}` (live-captured, ws-capture.jsonl); anything else says
        // the provider did NOT tell us it is streaming.
        //
        // NOT rejected, on purpose. Refusing an unrecognised ACK would turn a version
        // variation into a failed turn for every user of it, and the only evidence we
        // have is one capture of one version. What it does instead is REFUSE TO START
        // THE CLOCK: an unknown acceptance state is exactly the state where a
        // `response_timeout` would be a guess, and guessing wrong tells someone their
        // turn failed while the answer is still coming. The turn then behaves as it did
        // before this lot — bounded by the watchdog — and the deviation is reported so
        // the next lot decides with data instead of a hunch.
        const ackStatus =
          typeof ack === "object" && ack !== null
            ? (ack as { status?: unknown }).status
            : undefined;
        ackedStreaming = ackStatus === "streaming";
        if (ackedStreaming) streamingAckSeq = nextHermesApprovalSeq();
        // THREE acknowledgements, not one — read from the upstream handler, never
        // guessed: `streaming` starts our run; `queued` means the session was BUSY, so
        // ours is stashed in a single slot and drained as the very NEXT turn while the
        // live one is interrupted; `steered` means our text was INJECTED into the live
        // turn. Treating the last two as "not streaming, carry on" is the defect: the
        // terminal that arrives next belongs to the OTHER turn, and applying it here put
        // someone else's reply into this bubble — then, since lot 31, dropped a session
        // that was perfectly fine.
        ackQueued = ackStatus === "queued";
        // `redirected` (Hermes v2026.7.30+, the default busy policy): the live run's model
        // request is cancelled and our text joins THAT turn as a correction, or degrades to
        // a steer during tool execution (agent/interrupt_control.py) — either way the next
        // terminal is the live turn's, exactly as for `steered`.
        ackSteered = ackStatus === "steered" || ackStatus === "redirected";
        if (!ackedStreaming && !ackQueued && !ackSteered) {
          protocolDrift.observeException(
            null,
            new TypeError("prompt.submit did not ACK status=streaming"),
            "hermes-ws-ack",
          );
        }
      } catch (err) {
        // The streaming row ALREADY exists (chat-busy contract), so the bridge
        // OWNS this failure: settle the row as an actionable error and resolve
        // accepted (200). Rejecting here would 502 → Convex failDispatch would
        // add a SECOND error bubble for the same send (codex P2).
        //
        // Whatever was held waiting for an ACK that never came is not ours to apply:
        // the prompt was never accepted, so nothing on this lane answers it.
        ackPending = false;
        refuseUnshown(ackHeld);
        ackHeld.length = 0;
        finalized = true;
        const msg = (err as Error)?.message ?? String(err);
        const sendKind = classifyProviderInternal(msg);
        apply([
          {
            type: EVENT_MESSAGE_FINAL,
            text: "",
            error: msg,
            ...(sendKind ? { errorKind: sendKind } : {}),
            diagnosticFinalizeCause: "upstream_error",
          },
          { type: EVENT_RUN_STATUS, status: "error", runId: runtimeSid, message: msg },
        ]);
        await chain.catch(() => {});
        // NOTE: no pendingBind flush on this path — the prompt was never
        // delivered, so the next send must stay FRESH (create + re-carry the
        // history), not resume this virgin session as warm.
        resolveAccepted();
        return;
      }
      // Prompt ACCEPTED on the minted session → persist it now. FIRE-AND-FORGET
      // (off the critical path): awaiting a slow Convex write here would hold
      // /send open past the ACK. Best-effort: a bind failure is a continuity
      // miss (the next turn mints a fresh session and re-carries the history),
      // never a turn failure; outbox serialization keeps the next send well
      // behind this write.
      // …and only a CONFORMING ack binds the session. The failed-submit path above
      // already states the rule — "the prompt was never delivered, so the next send must
      // stay FRESH" — and an ACK that did not say `streaming` is the same uncertainty:
      // remembering a possibly-virgin session as warm makes the NEXT turn resume it
      // without re-carrying the history, so a prompt that never arrived is never
      // recovered either (raised in review). Not binding costs at worst one redundant
      // rehydration; binding wrongly costs the conversation.
      if (pendingBind && ackedStreaming && opts.onBoundSession) {
        persistBinding(pendingBind);
      }
      resolveAccepted();
      // ACCEPTED: from here the provider owes us a reply, and silence is its silence.
      // BOUNDED IN EVERY CASE. Refusing to arm on a non-conforming ACK was the wrong
      // trade and the review named it: the turn then awaited `turnDone` with no deadline
      // at all, so without a later event the `finally` never ran — the session stayed
      // subscribed and the run held, per chat. Waiting forever leaks; a bounded wait that
      // might be wrong at least ends. An unrecognised ACK makes a dead turn MORE likely,
      // not less, so it is exactly the case that needs the clock. What the ACK still
      // decides is the SESSION BIND below and the report above.
      promptAccepted = true;
      // THE VERDICT IS IN — release what was held, interpreting it by that verdict.
      ackPending = false;
      const held = ackHeld.splice(0, ackHeld.length);
      if (ackHeldOverflowed) {
        // We cannot say which turn any of this belonged to, so we attribute NONE of it.
        // The session goes with it: like a silence, we do not know whether the run we
        // were watching ever stopped — the rule of lot 31.
        refuseUnshown(held);
        held.length = 0;
        if (!finalized) {
          finalized = true;
          sessionUntrusted = true;
          disarmRecv();
          void opts.client
            .call("session.interrupt", { session_id: runtimeSid })
            .catch(() => {});
          closeOpenTools();
          closeMoaAggregator("error");
          const lostMsg =
            "Hermes sent more events than this turn could attribute before " +
            "acknowledging the prompt.";
          opts.onSessionForgotten?.();
          apply([
            {
              type: EVENT_MESSAGE_FINAL,
              text: "",
              error: lostMsg,
              errorKind: "correlation_lost",
              diagnosticFinalizeCause: "correlation_lost",
              // The CURRENT binding, not the one this turn started on: a rotation learned
          // mid-turn moved it, and clearing the stale id would match nothing and leave
          // the rotated session bound to a turn declared unusable (raised in review).
          ...(boundStoredSid ? { clearProviderSession: boundStoredSid } : {}),
            },
            {
              type: EVENT_RUN_STATUS,
              status: "error",
              runId: runtimeSid,
              message: lostMsg,
            },
          ]);
          settle();
        }
      } else if (ackSteered) {
        // Our text joined the live turn: none of this was ever ours.
        refuseUnshown(held);
        held.length = 0;
      } else if (ackQueued) {
        // Our run begins at the first `message.start`. If it already arrived while the
        // ACK was in flight, the gate is ALREADY satisfied — arming it again would wait
        // for a second start that never comes.
        const start = held.findIndex(([t]) => t === "message.start");
        if (start >= 0) {
          refuseUnshown(held.slice(0, start));
          awaitingOurTurn = false;
          for (const [t, p, syn] of held.slice(start + 1)) onEvent(t, p, syn);
        } else {
          refuseUnshown(held);
          awaitingOurTurn = true;
        }
      } else {
        for (const [t, p, syn] of held) onEvent(t, p, syn);
      }
      // QUEUED: the provider owes us a reply, but not yet — the interrupted turn's
      // events come first, on this same lane. Gate the bubble until `message.start`
      // announces the beginning of a run (emitted by the upstream prompt handler for
      // every turn it starts, drained queued prompts included). The deadline is armed
      // all the same: waiting for a start that never comes must still end.
      armRecv();
      // STEERED: our text was injected into the LIVE turn, so there will be NO terminal
      // of our own — ever. Waiting for one meant 240 s of "Réflexion…" and then a
      // `response_timeout` that also dropped a healthy session. Settle it now, by name:
      // the agent did receive the text, and its answer belongs to the turn it joined.
      if (ackSteered && !finalized && !ackHeldOverflowed) {
        finalized = true;
        disarmRecv();
        closeOpenTools();
        closeMoaAggregator("error");
        const steeredMsg =
          "Hermes merged this message into the turn already running; " +
          "its answer appears in that turn.";
        apply([
          {
            type: EVENT_MESSAGE_FINAL,
            text: "",
            error: steeredMsg,
            errorKind: "prompt_steered",
            diagnosticFinalizeCause: "prompt_steered",
          },
          {
            type: EVENT_RUN_STATUS,
            status: "error",
            runId: runtimeSid,
            message: steeredMsg,
          },
        ]);
        settle();
      }

      // 5) Drain until the terminal event (or the socket dies — the client's
      // onClose finalizes via forceError below through the registry).
      await turnDone;
    } finally {
      // Whatever settled this turn — terminal, abort, deadline — the timer goes. A live
      // timer on a finished turn is a process that will not exit and a log line that
      // makes no sense.
      disarmRecv();
      // Late-child grace: keep listening ~2 min after the turn settles so a
      // delegation that finishes after the parent still lands its terminal in the
      // monitor (only monitoring events pass the finalized guard above) — but as a
      // LINGERER: the session's next turn may start meanwhile (Hermes resumes the same
      // runtime session id), and it must not be refused for this one's grace. The
      // timer never blocks process exit.
      unsubscribe.linger?.();
      const t = setTimeout(unsubscribe, 120_000);
      (t as { unref?: () => void }).unref?.();
      await chain.catch((e) =>
        console.error("[hermes-ws-turn] drain error:", (e as Error)?.message ?? e),
      );
    }
  })();
  // A turn that ENDS releases every prompt it still held — Hermes unblocks them on its
  // side (`_clear_pending` on interrupt, `unregister_gateway_notify` at run end), so a
  // card left open would offer an answer nobody can receive. An answer already in
  // flight is the person's: Convex keeps it over this settle (settleFromBridge).
  void done
    .catch(() => undefined)
    .then(() => {
      stopHumanBeat();
      for (const id of [...openRequests]) settleRequest(id, "cancelled");
    });

  return {
    accepted,
    done,
    runtimeSessionId: () => runtimeSid,
    storedSessionId: () => convexBoundSid,
    markSessionUntrusted: () => markUntrustedRef?.(),
    settledBindings: () => settledBindingsRef?.() ?? Promise.resolve(),
    forceSettle: (writeAborted?: boolean) => forceSettleRef?.(writeAborted),
    approvalHead,
    approvalAmbiguity,
    noteApprovalAnswered: (id: string) => {
      const entry = blockedApprovals.find((a) => a.id === id && !a.answered);
      if (entry) entry.answered = true;
    },
    noteApprovalOrderUnknown: () => {
      if (blockedApprovals.length > 0) approvalOrderUnknown = true;
    },
    noteServerRequestAnswered: (id: string) => releaseServerRequestRef(id),
    // A FINALIZED turn holds nothing answerable: once its transport is lost (or it ended)
    // it reads nothing more, yet it stays registered until `done` settles — an answer
    // taken in that window would release a run nobody here observes (0.21.5 pass 25).
    heldServerRequest: (id: string) => (finalizedRef() ? null : (serverRequestsOpen.get(id) ?? null)),
    holdsRequest: (id: string) => !finalizedRef() && openRequests.has(id),
  };
}
