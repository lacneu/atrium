// One Hermes turn, end to end. This is the Hermes analogue of OpenClaw's
// performSend → session-loop → normalizer path, but far simpler because Hermes
// has no persistent multiplexed socket: a turn is one SSE request. It drives
// the SAME TurnSink the OpenClaw path uses, so every write downstream
// (streaming message, tool parts, finalize) is identical.
//
// Lifecycle (mirrors OpenClaw's "reply on ACK, stream ASYNC"): the turn is
// ACCEPTED once the gateway returns the SSE stream (2xx). /send returns then;
// the frames drain in the BACKGROUND into the sink. A pre-accept failure
// (unreachable / 401 / 5xx) throws BEFORE any assistant message is created, so
// the caller returns 502 and Convex owns the single error bubble — no orphan,
// no double bubble.
//
// Continuity: the Hermes session id is created lazily on the first turn and
// persisted back to the chat's providerChatId slot (`onBoundSession`) so later
// turns reuse it — Hermes keeps the conversation server-side.

import { TurnSink } from "../../core/turn-sink.js";
import type { ConvexWriter } from "../../convex-writer.js";
import type { HermesClient } from "./client.js";
import { HermesNormalizer } from "./normalizer.js";

/** Abort reason set by /reset (vs a user Stop) — tells the turn to FINALIZE the
 *  message as aborted (Convex's dispatchReset does not). */
export const HERMES_RESET_ABORT = "hermes-reset";

export interface HermesTurnOptions {
  client: HermesClient;
  writer: ConvexWriter;
  chatId: string;
  sessionKey: string;
  /** The chat's stored Hermes session id (providerChatId), or null on turn 1. */
  providerChatId: string | null;
  text: string;
  /** Persist a NEWLY minted session id back to Convex (turn 1 only). */
  onBoundSession?: (sessionId: string) => Promise<void>;
  /** Aborts the in-flight SSE request (Stop button). */
  signal?: AbortSignal;
  pressure?: {
    totalTokens: number | null;
    contextTokens: number | null;
    costUsd?: number | null;
  };
}

/** A live Hermes turn. `accepted` resolves once the gateway took the run (or
 *  rejects with a HermesError on a pre-stream dispatch failure); `done`
 *  resolves when the background stream fully finalizes. */
export interface HermesTurnRun {
  accepted: Promise<void>;
  done: Promise<void>;
  runId(): string | null;
}

function messageOf(err: unknown): string {
  const e = err as { message?: string } | null;
  return (e && typeof e.message === "string" && e.message) || String(err);
}

/**
 * Start one Hermes turn. Awaits acceptance inline (so the caller can 200/502 on
 * it); the frame drain runs in the background. beginTurn (the assistant message)
 * is created only AFTER acceptance — a rejected dispatch never leaves an orphan
 * message nor collides with Convex's failDispatch bubble.
 */
export function runHermesTurn(opts: HermesTurnOptions): HermesTurnRun {
  const norm = new HermesNormalizer();
  let resolveAccepted!: () => void;
  let rejectAccepted!: (e: unknown) => void;
  const accepted = new Promise<void>((res, rej) => {
    resolveAccepted = res;
    rejectAccepted = rej;
  });

  const done = (async () => {
    let res: Response;
    try {
      let sessionId = await opts.client.ensureSession(opts.providerChatId);
      // Newly minted (turn 1): persist so the next turn reuses this session.
      if (!opts.providerChatId && opts.onBoundSession) {
        await opts.onBoundSession(sessionId);
      }
      // The ACCEPTANCE point: POST returns the SSE stream, or throws (dispatch
      // failure). The gateway TOOK the run.
      try {
        res = await opts.client.openStream(sessionId, opts.text, opts.signal);
      } catch (err) {
        // AUTO-RECOVER a vanished session: a REUSED session id can 404 if Hermes
        // dropped it (restart / eviction). Mint a fresh one and retry ONCE, so a
        // stale persisted id doesn't wedge the chat until a manual reset.
        const status = (err as { status?: number })?.status;
        if (status === 404 && opts.providerChatId) {
          sessionId = await opts.client.ensureSession(null);
          if (opts.onBoundSession) await opts.onBoundSession(sessionId);
          res = await opts.client.openStream(sessionId, opts.text, opts.signal);
        } else {
          throw err;
        }
      }
    } catch (err) {
      rejectAccepted(err);
      return;
    }
    // Open the streaming assistant row NOW, BEFORE resolving accepted: the chat
    // must look BUSY before /send returns 200, or Convex marks the outbox sent +
    // drainNextQueued sees an idle chat and dispatches the next queued message in
    // parallel / with incomplete context (codex P1). run_id is unknown yet (it
    // arrives on run.started) — stamped below once learned, so /abort can still
    // target THIS turn. A beginTurn failure cancels the accepted stream (no
    // billing without a message) and rejects → /send 502.
    const sink = new TurnSink(opts.chatId, opts.writer, undefined, opts.sessionKey);
    try {
      await sink.beginTurn(null, opts.pressure);
    } catch (err) {
      await res.body?.cancel().catch(() => {});
      rejectAccepted(err);
      return;
    }
    resolveAccepted();

    let chain: Promise<void> = Promise.resolve();
    let stampedRunId = false;
    const enqueue = (events: ReturnType<HermesNormalizer["feed"]>): void => {
      if (events.length === 0) return;
      chain = chain.then(() => sink.apply(events));
    };
    try {
      await opts.client.readStream(res, (frame) => {
        const events = norm.feed(frame);
        // Stamp the Hermes run id onto the message the FIRST time it is known,
        // so a later /abort for this turn matches it (codex P2). Best-effort.
        if (!stampedRunId && norm.currentRunId) {
          stampedRunId = true;
          const mid = sink.currentMessageId;
          const rid = norm.currentRunId;
          if (mid) chain = chain.then(() => opts.writer.updateRunId?.(mid, rid) ?? undefined);
        }
        enqueue(events);
      });
      if (!norm.isFinalized) {
        // Clean EOF, or accepted-but-streamed-nothing: settle honestly.
        enqueue(
          norm.endTurn(
            stampedRunId ? null : "Hermes accepted the run but sent no response.",
          ),
        );
      }
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      const reason = (opts.signal as { reason?: unknown } | undefined)?.reason;
      if (aborted) {
        // USER /abort: Convex already finalized the message `aborted` (writing
        // any terminal here races that, first-wins). But a /reset abort does NOT
        // go through Convex's optimistic finalize — the bridge must settle it or
        // the row is left streaming until the watchdog (codex P2).
        if (reason === HERMES_RESET_ABORT && !norm.isFinalized) {
          enqueue(norm.abortTurn());
        }
      } else if (!norm.isFinalized) {
        // Stream died mid-generation → finalize a delivered error.
        enqueue(norm.endTurn(messageOf(err)));
      }
    }
    // Drain the queued writes. Swallow here: a Convex write failing (e.g.
    // beginTurn after acceptance) is a BACKGROUND error — `done` must resolve so
    // the registry cleanup runs and the caller never sees an unhandled reject.
    await chain.catch((e) =>
      console.error("[hermes-turn] drain error:", (e as Error)?.message ?? e),
    );
  })();

  return { accepted, done, runId: () => norm.currentRunId };
}
