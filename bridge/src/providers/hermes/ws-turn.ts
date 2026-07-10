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
  EVENT_CONTEXT_COMPACTION,
  EVENT_MESSAGE_DELTA,
  EVENT_MESSAGE_FINAL,
  EVENT_RUN_STATUS,
  EVENT_TOOL_STATUS,
  type BridgeEvent,
} from "../../core/events.js";
import type {
  ConvexWriter,
  SessionMetaReport,
  SubAgentRecord,
} from "../../convex-writer.js";
import type { HermesWsClient } from "./ws-client.js";
import type { HermesFilesFetcher } from "./files-fetcher.js";

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
  text: string;
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
    let sessionCwd: string | null = null;
    const noteCwd = (r: Record<string, unknown>) => {
      const info = r.info as { cwd?: unknown } | undefined;
      if (info && typeof info.cwd === "string" && info.cwd) sessionCwd = info.cwd;
    };
    try {
      if (opts.providerChatId && isHermesWsStoredSessionId(opts.providerChatId)) {
        const r = await opts.client.call("session.resume", {
          session_id: opts.providerChatId,
        });
        noteCwd(r);
        runtimeSid = str(r.session_id) || null;
        storedSid = str(r.stored_session_id) || opts.providerChatId;
      }
      if (!runtimeSid) {
        const r = await opts.client.call("session.create", {});
        noteCwd(r);
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
    // eternal spinner in the UI.
    const openTools = new Set<string>();
    const closeOpenTools = (): void => {
      for (const name of openTools) {
        apply([
          {
            type: EVENT_TOOL_STATUS,
            name,
            phase: "completed",
            runId: runtimeSid,
          },
        ]);
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

    const onEvent = (type: string, payload: Record<string, unknown>): void => {
      // Monitoring events (delegation / MoA) OUTLIVE the parent turn: a child
      // often completes AFTER the parent's message.complete (live-observed
      // order), and its terminal MUST still reach the monitor or the card
      // stays "running" and the composer's hold-the-send never releases.
      const isMonitoring =
        type.startsWith("subagent.") || type.startsWith("moa.");
      if (finalized && !isMonitoring) return;
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
          closeOpenTools();
          closeMoaAggregator("error");
          // The gateway is holding the tool run for a HUMAN approval Atrium
          // cannot surface yet — settle actionably instead of hanging until
          // the watchdog (live finding: the turn stalls silently otherwise).
          finalized = true;
          const msg =
            "L'agent Hermes attend une approbation d'outil que ce chat ne peut pas donner. Configurez l'auto-approbation sur la passerelle (tools.<outil>.approval_policy: auto) ou approuvez depuis le dashboard Hermes.";
          apply([
            { type: EVENT_MESSAGE_FINAL, text: replyText, error: msg },
            { type: EVENT_RUN_STATUS, status: "error", runId: runtimeSid, message: msg },
          ]);
          settle();
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
            record.status =
              str(payload.status) === "completed" ? "done" : "error";
            const result = str(payload.summary) || str(payload.text);
            if (result) record.resultText = result;
            if (record.status === "error") {
              record.errorMessage = str(payload.text) || "Sub-agent failed.";
            }
          }
          void opts.writer
            .upsertSubAgent?.(record)
            ?.catch(() => {/* monitor is best-effort */});
          // Parent phase: awaiting while children work, generating on complete.
          if (mid) {
            opts.writer.setPhase?.(
              mid,
              type === "subagent.complete" ? "generating" : "awaiting_subagents",
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
          openTools.add(name);
          apply([
            { type: EVENT_TOOL_STATUS, name, phase: "start", runId: runtimeSid },
          ]);
          return;
        }
        case "tool.complete": {
          const name = str(payload.name) || "tool";
          openTools.delete(name);
          apply([
            {
              type: EVENT_TOOL_STATUS,
              name,
              phase: "completed",
              runId: runtimeSid,
            },
          ]);
          return;
        }
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
          // The MoA aggregator (if any) finished with the reply it produced.
          if (moaAggregatorKey) {
            apply([
              {
                type: EVENT_TOOL_STATUS,
                name: "mixture_of_agents",
                phase: "completed",
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
              // cwd can be missing after a resume/recovery whose reply carried
              // no info block — recover it from session.status so delivered
              // files are not silently lost (codex P2).
              if (!sessionCwd && runtimeSid) {
                try {
                  const st = await opts.client.call("session.status", {
                    session_id: runtimeSid,
                  });
                  noteCwd(st);
                  const info = st as { cwd?: unknown };
                  if (!sessionCwd && typeof info.cwd === "string" && info.cwd) {
                    sessionCwd = info.cwd;
                  }
                } catch {
                  /* no cwd → no scan (nothing to deliver from) */
                }
              }
              if (!sessionCwd) return;
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
          closeOpenTools();
          closeMoaAggregator("error");
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
        const promptParts = [opts.text];
        if (fileRefs.length) promptParts.push(fileRefs.join("\n"));
        if (opts.filesFetcher) promptParts.push(DELIVERY_DIRECTIVE);
        await opts.client.call("prompt.submit", {
          session_id: runtimeSid,
          text: promptParts.join("\n\n"),
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
    forceSettle: (writeAborted?: boolean) => forceSettleRef?.(writeAborted),
  };
}
