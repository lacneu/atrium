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
import type { HermesWsClient } from "./ws-client.js";
import type { HermesFilesFetcher } from "./files-fetcher.js";
import { protocolDrift } from "../openclaw/protocol-drift.js";

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
}

/** What a turn hands the registry when it subscribes to its session's lane.
 *
 *  `onTransportLost` is a CALLBACK and not an injected `error` event on purpose: losing
 *  the bridge→Hermes socket is not something Hermes said. Routing it through the event
 *  lane would mean a wire frame could impersonate it, and would put a bridge-internal
 *  name into the terminal vocabulary the reader's switch defines. */
export interface HermesWsSessionHandlers {
  onEvent: (type: string, payload: Record<string, unknown>) => void;
  /** THIS instance's socket died while the turn was waiting. */
  onTransportLost: (reason: string) => void;
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
  "clarify.request": { method: "clarify.respond", key: "answer" },
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
  "clarify.request": 300_000,
  "secret.request": 300_000,
  "sudo.request": 120_000,
  "terminal.read.request": 30_000,
};

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
  ) => () => void,
): HermesWsTurnRun {
  // The /send handler's OWN entry when given (time lost before this turn started
  // counts too — codex P1); this turn's start otherwise.
  const turnStartedMs = opts.sendReceivedMs ?? Date.now();
  let runtimeSid: string | null = null;
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
          { type: EVENT_MESSAGE_FINAL, text: replyText },
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
    const onEvent = (type: string, payload: Record<string, unknown>): void => {
      try {
        applyEvent(type, payload);
      } catch (err) {
        protocolDrift.observeException({ type, payload }, err, "hermes-ws-event");
        throw err;
      }
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
    const applyEvent = (type: string, payload: Record<string, unknown>): void => {
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
          // It used to KILL the turn — and tell the user to go approve on the Hermes
          // dashboard, which is advice to work around our own defect. Worse, it never
          // answered the gateway: Hermes went on blocking, denied itself ~60 s later, and
          // PERSISTED that turn, so the next one resumed from a context this thread does
          // not contain. Answer now, keep the turn alive, and show what was asked.
          //
          // The answer is a DENY, which is the same verdict upstream reaches on expiry —
          // reached immediately instead of after a minute of dead air. The agent is told,
          // so it can adapt or explain, rather than being cut off mid-thought.
          surfacePrompt("hermes.approval", payload);
          void opts.client
            .call("approval.respond", { session_id: runtimeSid, choice: "deny" })
            .catch((e) =>
              console.error(
                "[hermes-ws-turn] approval.respond failed (best effort):",
                (e as Error)?.message ?? e,
              ),
            );
          return;
        }
        case "clarify.request":
        case "terminal.read.request": {
          // Answered EMPTY, never composed. Writing something like "proceed with your
          // best guess" would be Atrium answering the agent in the user's place. The
          // question is surfaced instead, and the user replies on the next turn.
          surfacePrompt(
            type === "clarify.request" ? "hermes.clarify" : "hermes.terminal_read",
            payload,
          );
          respondToPrompt(type, payload);
          return;
        }
        case "secret.request":
        case "sudo.request": {
          // NOT answered — see HERMES_PROMPT_RESPONDERS. A credential prompt gets no
          // reply invented by Atrium; the gateway's own expiry is the fail-closed, and
          // answering would suppress the `*.expire` that announces it.
          surfacePrompt(
            type === "secret.request" ? "hermes.secret" : "hermes.sudo",
            payload,
          );
          holdForPrompt(type);
          return;
        }
        case "secret.expire":
        case "sudo.expire": {
          surfacePrompt(
            type === "secret.expire" ? "hermes.secret" : "hermes.sudo",
            payload,
            "expired",
          );
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
          apply([
            {
              type: EVENT_MESSAGE_FINAL,
              text: errText,
              error: msg,
              ...(errKind ? { errorKind: errKind } : {}),
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
    const ackHeld: Array<[string, Record<string, unknown>]> = [];
    /** Bounded, like every buffer in this bridge. The window is one RPC round trip, so
     *  this is orders of magnitude above any real burst; overflowing means the provider
     *  is behaving in a way we do not model, and holding more would trade a wrong
     *  attribution for a memory leak. */
    const ACK_HOLD_MAX = 512;
    let ackHeldOverflowed = false;
    /** The provider explicitly said it is streaming — see the ACK check below. */
    let ackedStreaming = false;
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
    const armRecv = (): void => {
      disarmRecv();
      if (finalized || !promptAccepted) return;
      // A blocked turn is not a silent turn: while a prompt we cannot answer is pending,
      // the deadline stretches to cover the gateway's own timeout.
      const graceLeft = promptGraceUntil - Date.now();
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
          // The ID we were watching, not a flag: this terminal can land AFTER a user
          // Stop released the chat and a newer turn bound a session of its own, and the
          // mutation drops the binding only while it is still this one.
          // The CURRENT binding, not the one this turn started on: a rotation learned
          // mid-turn moved it, and clearing the stale id would match nothing and leave
          // the rotated session bound to a turn declared unusable (raised in review).
          ...(boundStoredSid ? { clearProviderSession: boundStoredSid } : {}),
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
          // The CURRENT binding, not the one this turn started on: a rotation learned
          // mid-turn moved it, and clearing the stale id would match nothing and leave
          // the rotated session bound to a turn declared unusable (raised in review).
          ...(boundStoredSid ? { clearProviderSession: boundStoredSid } : {}),
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
      onEvent: (type, payload) => {
        // RE-ARMED BY ANY EVENT of this session — including the monitoring ones that
        // outlive the parent turn. Progress is progress: a delegation still reporting is
        // not a stalled provider.
        armRecv();
        if (ackPending) {
          if (ackHeld.length < ACK_HOLD_MAX) {
            ackHeld.push([type, payload]);
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
          return;
        }
        onEvent(type, payload);
      },
      onTransportLost,
    };
    let unsubscribe: () => void;
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
        // THREE acknowledgements, not one — read from the upstream handler, never
        // guessed: `streaming` starts our run; `queued` means the session was BUSY, so
        // ours is stashed in a single slot and drained as the very NEXT turn while the
        // live one is interrupted; `steered` means our text was INJECTED into the live
        // turn. Treating the last two as "not streaming, carry on" is the defect: the
        // terminal that arrives next belongs to the OTHER turn, and applying it here put
        // someone else's reply into this bubble — then, since lot 31, dropped a session
        // that was perfectly fine.
        ackQueued = ackStatus === "queued";
        ackSteered = ackStatus === "steered";
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
        held.length = 0;
      } else if (ackQueued) {
        // Our run begins at the first `message.start`. If it already arrived while the
        // ACK was in flight, the gate is ALREADY satisfied — arming it again would wait
        // for a second start that never comes.
        const start = held.findIndex(([t]) => t === "message.start");
        if (start >= 0) {
          awaitingOurTurn = false;
          for (const [t, p] of held.slice(start + 1)) onEvent(t, p);
        } else {
          awaitingOurTurn = true;
        }
      } else {
        for (const [t, p] of held) onEvent(t, p);
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
      // Late-child grace: keep the session lane subscribed ~2 min after the
      // turn settles so a delegation that finishes after the parent still
      // lands its terminal in the monitor (only monitoring events pass the
      // finalized guard above). The timer never blocks process exit.
      const t = setTimeout(unsubscribe, 120_000);
      (t as { unref?: () => void }).unref?.();
      await chain.catch((e) =>
        console.error("[hermes-ws-turn] drain error:", (e as Error)?.message ?? e),
      );
    }
  })();

  return {
    accepted,
    done,
    runtimeSessionId: () => runtimeSid,
    storedSessionId: () => convexBoundSid,
    markSessionUntrusted: () => markUntrustedRef?.(),
    settledBindings: () => settledBindingsRef?.() ?? Promise.resolve(),
    forceSettle: (writeAborted?: boolean) => forceSettleRef?.(writeAborted),
  };
}
