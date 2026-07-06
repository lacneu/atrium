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
  EVENT_MESSAGE_DELTA,
  EVENT_MESSAGE_FINAL,
  EVENT_RUN_STATUS,
  type BridgeEvent,
} from "../../core/events.js";
import type { ConvexWriter, SessionMetaReport } from "../../convex-writer.js";
import type { HermesWsClient } from "./ws-client.js";

export interface HermesWsTurnOptions {
  client: HermesWsClient;
  writer: ConvexWriter;
  chatId: string;
  sessionKey: string;
  /** The chat's stored Hermes WS session id (stored_session_id), or null. */
  providerChatId: string | null;
  text: string;
  /** Persist a NEWLY minted stored_session_id (turn 1 / after reset). */
  onBoundSession?: (storedSessionId: string) => Promise<void>;
}

export interface HermesWsTurnRun {
  /** Resolves when prompt.submit is ACKed (or rejects: dispatch failure). */
  accepted: Promise<void>;
  /** Resolves when the turn fully finalized. */
  done: Promise<void>;
  /** The RUNTIME session id — session.interrupt's target. */
  runtimeSessionId(): string | null;
  /** Settle the turn. `writeAborted=false` (user Stop): NO terminal — Convex
   *  already finalized the message `aborted`. `writeAborted=true` (/reset):
   *  write the aborted terminal pair FIRST — dispatchReset does NOT finalize
   *  optimistically, so the bridge must, or the row stays streaming. */
  forceSettle(writeAborted?: boolean): void;
}

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
  registerSession: (runtimeSessionId: string, onEvent: (type: string, payload: Record<string, unknown>) => void) => () => void,
): HermesWsTurnRun {
  let runtimeSid: string | null = null;
  let forceSettleRef: ((writeAborted?: boolean) => void) | null = null;
  let resolveAccepted!: () => void;
  let rejectAccepted!: (e: unknown) => void;
  const accepted = new Promise<void>((res, rej) => {
    resolveAccepted = res;
    rejectAccepted = rej;
  });

  const done = (async () => {
    // 1) Session: resume the stored one, else create (and persist) a new one.
    let storedSid: string | null = null;
    try {
      if (opts.providerChatId && isHermesWsStoredSessionId(opts.providerChatId)) {
        const r = await opts.client.call("session.resume", {
          session_id: opts.providerChatId,
        });
        runtimeSid = str(r.session_id) || null;
        storedSid = str(r.stored_session_id) || opts.providerChatId;
      }
      if (!runtimeSid) {
        const r = await opts.client.call("session.create", {});
        runtimeSid = str(r.session_id) || null;
        storedSid = str(r.stored_session_id) || null;
        if (!runtimeSid) {
          throw new Error("Hermes WS session.create returned no session_id");
        }
        if (storedSid && opts.onBoundSession) await opts.onBoundSession(storedSid);
      }
    } catch (err) {
      // A stale stored session that fails to resume → recover with a fresh one
      // ONCE (same auto-recovery contract as the REST 404 path).
      if (opts.providerChatId && !runtimeSid) {
        try {
          const r = await opts.client.call("session.create", {});
          runtimeSid = str(r.session_id) || null;
          storedSid = str(r.stored_session_id) || null;
          if (runtimeSid && storedSid && opts.onBoundSession) {
            await opts.onBoundSession(storedSid);
          }
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
    const sink = new TurnSink(opts.chatId, opts.writer, undefined, opts.sessionKey);
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
      if (writeAborted) {
        apply([
          { type: EVENT_MESSAGE_FINAL, text: replyText },
          { type: EVENT_RUN_STATUS, status: "aborted", runId: runtimeSid },
        ]);
      }
      settle();
    };

    const onEvent = (type: string, payload: Record<string, unknown>): void => {
      if (finalized) return;
      switch (type) {
        case "message.delta": {
          const text = str(payload.text);
          if (!text) return;
          replyText += text;
          apply([{ type: EVENT_MESSAGE_DELTA, text, runId: runtimeSid }]);
          return;
        }
        case "thinking.delta":
        case "reasoning.delta":
          // Reasoning stream — NEVER reply text (would duplicate/pollute).
          return;
        case "session.info": {
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
        case "message.complete": {
          finalized = true;
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
          if (used !== undefined || windowMax !== undefined) {
            void opts.writer
              .reportSessionMeta(opts.chatId, {
                totalTokens: used,
                contextTokens: windowMax,
              })
              .catch((e) =>
                console.error(
                  "[hermes-ws-turn] usage meta failed:",
                  (e as Error)?.message ?? e,
                ),
              );
          }
          const status = str(payload.status) === "error" ? "error" : "complete";
          const finalEv: BridgeEvent = { type: EVENT_MESSAGE_FINAL, text };
          const statusEv: BridgeEvent = {
            type: EVENT_RUN_STATUS,
            status,
            runId: runtimeSid,
          };
          if (status === "error") {
            const msg = str(payload.error) || "Hermes run failed.";
            finalEv.error = msg;
            statusEv.message = msg;
          }
          apply([finalEv, statusEv]);
          settle();
          return;
        }
        case "error": {
          finalized = true;
          const msg = str(payload.message) || str(payload.text) || "Hermes run failed.";
          apply([
            { type: EVENT_MESSAGE_FINAL, text: replyText, error: msg },
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
    const unsubscribe = registerSession(runtimeSid, onEvent);

    try {
      // 3) Open the streaming row BEFORE resolving accepted (chat busy before
      // /send returns 200 — same contract as the REST path).
      try {
        await sink.beginTurn(runtimeSid);
      } catch (err) {
        rejectAccepted(err);
        return;
      }

      // 4) Submit. The ACK ({status:"streaming"}) is the acceptance point.
      try {
        await opts.client.call("prompt.submit", {
          session_id: runtimeSid,
          text: opts.text,
        });
      } catch (err) {
        // The streaming row ALREADY exists (chat-busy contract), so the bridge
        // OWNS this failure: settle the row as an actionable error and resolve
        // accepted (200). Rejecting here would 502 → Convex failDispatch would
        // add a SECOND error bubble for the same send (codex P2).
        finalized = true;
        const msg = (err as Error)?.message ?? String(err);
        apply([
          { type: EVENT_MESSAGE_FINAL, text: "", error: msg },
          { type: EVENT_RUN_STATUS, status: "error", runId: runtimeSid, message: msg },
        ]);
        await chain.catch(() => {});
        resolveAccepted();
        return;
      }
      resolveAccepted();

      // 5) Drain until the terminal event (or the socket dies — the client's
      // onClose finalizes via forceError below through the registry).
      await turnDone;
    } finally {
      unsubscribe();
      await chain.catch((e) =>
        console.error("[hermes-ws-turn] drain error:", (e as Error)?.message ?? e),
      );
    }
  })();

  return {
    accepted,
    done,
    runtimeSessionId: () => runtimeSid,
    forceSettle: (writeAborted?: boolean) => forceSettleRef?.(writeAborted),
  };
}
