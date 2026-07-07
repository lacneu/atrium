// Hermes /send + /abort glue for the bridge HTTP server. Keeps server.ts thin:
// it only branches on `cfg.kind === "hermes"` and calls these. The Hermes turn
// has no persistent session (unlike OpenClaw's SessionRegistry), so a tiny
// in-memory registry tracks the ONE in-flight turn per chat purely so /abort
// can cancel it (signal + server-side stopRun). Lost on restart = fine: an
// abort only means anything for a turn live in THIS process.

import type { BridgeConfig } from "../../config.js";
import type { ConvexWriter } from "../../convex-writer.js";
import { HermesClient } from "./client.js";
import { HermesWsClient } from "./ws-client.js";
import { HermesFilesFetcher } from "./files-fetcher.js";
import { safeSessionPart } from "../openclaw/session-keys.js";
import { runHermesTurn, HERMES_RESET_ABORT, type HermesTurnRun } from "./turn.js";
import {
  runHermesWsTurn,
  isHermesWsStoredSessionId,
  type HermesWsTurnRun,
} from "./ws-turn.js";

/** Non-secret routed body fields the Hermes path needs (subset of the send body). */
export interface HermesSendBody {
  chatId: string;
  agentId: string;
  canonical: string;
  openclawChatId: string | null; // reused as the Hermes session id (providerChatId)
  text: string;
  /** Inline base64 attachments (WS transport stages them via file.attach /
   *  image.attach_bytes before the prompt; REST has no upload channel). */
  attachments?: Array<{ mimeType: string; fileName: string; content: string }>;
}

interface LiveHermesTurn {
  abort: AbortController;
  run: HermesTurnRun;
}

interface LiveHermesWsTurn {
  run: HermesWsTurnRun;
}

/** Per-process registry of in-flight Hermes turns + the last-known Hermes
 *  session id per chat. The session map survives Convex clobbering the shared
 *  `openclawChatId` slot with an OpenClaw routing segment (`turn:...`) on a
 *  mixed-pool per-turn-routed chat — so a routed Hermes follow-up REUSES its
 *  server-side session instead of minting a fresh one (codex P2). Lost on
 *  restart → a fresh session then (benign continuity miss). */
export class HermesTurnRegistry {
  private turns = new Map<string, LiveHermesTurn>();
  private sessions = new Map<string, string>();
  // WS transport state: one persistent client per instance + the per-runtime-
  // session event subscribers (a turn registers its runtime session id and
  // receives ONLY its session's events — multiplex-safe).
  private wsClients = new Map<string, HermesWsClient>();
  private filesFetchers = new Map<string, HermesFilesFetcher>();
  // Keyed by `<instance>\u0000<runtimeSessionId>` — one instance's events (or
  // its socket dying) must NEVER reach another instance's turns.
  private wsSubscribers = new Map<string, (type: string, payload: Record<string, unknown>) => void>();
  private wsTurns = new Map<string, LiveHermesWsTurn>();

  /** One persistent WS client per instance (lazy; auto-reconnect on next use). */
  wsClientFor(cfg: BridgeConfig): HermesWsClient {
    const key = cfg.instanceName ?? "";
    const existing = this.wsClients.get(key);
    if (existing) return existing;
    const client = new HermesWsClient({
      baseUrl: cfg.gatewayHttpBase || cfg.openclawGatewayUrl,
      credential: cfg.openclawToken ?? "",
      onEvent: (type, sessionId, payload) => {
        const sub = this.wsSubscribers.get(`${key}\u0000${sessionId}`);
        sub?.(type, payload);
      },
      onClose: () => {
        // THIS instance's socket died: its subscribed turns get a terminal
        // error so no message is left streaming until the watchdog. Turns of
        // OTHER instances are untouched. Next turn reconnects lazily.
        for (const [k, sub] of this.wsSubscribers) {
          if (!k.startsWith(`${key}\u0000`)) continue;
          this.wsSubscribers.delete(k);
          sub("error", { message: "Hermes WS connection lost." });
        }
      },
    });
    this.wsClients.set(key, client);
    return client;
  }

  filesFetcherFor(cfg: BridgeConfig): HermesFilesFetcher {
    const key = cfg.instanceName ?? "";
    const existing = this.filesFetchers.get(key);
    if (existing) return existing;
    const f = new HermesFilesFetcher({
      baseUrl: cfg.gatewayHttpBase || cfg.openclawGatewayUrl,
      credential: cfg.openclawToken ?? "",
      maxBytes: cfg.mediaMaxBytes,
    });
    this.filesFetchers.set(key, f);
    return f;
  }

  subscribeWsSession(
    instanceName: string,
    runtimeSessionId: string,
    onEvent: (type: string, payload: Record<string, unknown>) => void,
  ): () => void {
    const k = `${instanceName}\u0000${runtimeSessionId}`;
    this.wsSubscribers.set(k, onEvent);
    return () => {
      if (this.wsSubscribers.get(k) === onEvent) {
        this.wsSubscribers.delete(k);
      }
    };
  }

  setWsTurn(chatId: string, turn: LiveHermesWsTurn): void {
    this.wsTurns.set(chatId, turn);
  }
  peekWsTurn(chatId: string): LiveHermesWsTurn | undefined {
    return this.wsTurns.get(chatId);
  }
  takeWsTurn(chatId: string): LiveHermesWsTurn | undefined {
    const t = this.wsTurns.get(chatId);
    this.wsTurns.delete(chatId);
    return t;
  }
  deleteWsTurnIf(chatId: string, turn: LiveHermesWsTurn): void {
    if (this.wsTurns.get(chatId) === turn) this.wsTurns.delete(chatId);
  }

  /** Close every WS client (bridge shutdown). */
  closeAll(): void {
    for (const [, c] of this.wsClients) c.close();
    this.wsClients.clear();
    this.wsSubscribers.clear();
  }

  set(chatId: string, turn: LiveHermesTurn): void {
    this.turns.set(chatId, turn);
  }
  take(chatId: string): LiveHermesTurn | undefined {
    const t = this.turns.get(chatId);
    this.turns.delete(chatId);
    return t;
  }
  peek(chatId: string): LiveHermesTurn | undefined {
    return this.turns.get(chatId);
  }
  /** Delete ONLY if the stored entry is still THIS one — a slow old-turn
   *  cleanup must not evict a newer turn registered after a fast Stop→resend
   *  (codex P2). */
  deleteIf(chatId: string, turn: LiveHermesTurn): void {
    if (this.turns.get(chatId) === turn) this.turns.delete(chatId);
  }
  /** Drop every remembered Hermes session for a chat (all targets) — a /reset
   *  must make the NEXT turn mint a FRESH session, not reuse the old one. */
  forgetChat(chatId: string): void {
    const suffix = `\u0000${chatId}`;
    for (const key of this.sessions.keys()) {
      if (key.endsWith(suffix)) this.sessions.delete(key);
    }
  }
  rememberSession(targetKey: string, sessionId: string): void {
    this.sessions.set(targetKey, sessionId);
  }
  knownSession(targetKey: string): string | null {
    return this.sessions.get(targetKey) ?? null;
  }
}

function hermesClientFor(cfg: BridgeConfig): HermesClient {
  return new HermesClient({
    // The Hermes API base is the instance's HTTP gateway URL (8642). Reuses the
    // same derived http base OpenClaw uses for its media fetches.
    baseUrl: cfg.gatewayHttpBase || cfg.openclawGatewayUrl,
    token: cfg.openclawToken ?? "",
  });
}

/** The turn's session key = the sink's enrichment handle AND the reply-to-send
 *  join Convex correlators use. Like OpenClaw's buildSessionKey, the LAST
 *  segment is the routing id (`openclawChatId ?? chatId`): for a hidden utility
 *  chat (summarizer/curator) Convex sets openclawChatId to a nonce
 *  (`summarize:<chat>:<ts>`), and the correlator clears the pending job only
 *  when the reply's key ENDS WITH that nonce — so it MUST be the tail segment
 *  (codex P2), not the raw chat id. */
function hermesSessionKey(body: HermesSendBody): string {
  const routeId = body.openclawChatId ?? body.chatId;
  // Sanitize every segment with the SAME transform Convex's correlators apply
  // (safeSessionPart: colons/unsafe → "-"), or a nonce like `summarize:<c>:<ts>`
  // would be echoed raw and never match the sanitized suffix the summarize/
  // curation correlators compare against (codex P2).
  return (
    `hermes:${safeSessionPart(body.agentId)}:chat:` +
    `${safeSessionPart(body.canonical)}:${safeSessionPart(routeId)}`
  );
}

/** True only for a REAL Hermes session id (observed shape `api_<ts>_<hex>` —
 *  what bindProviderChat persists). The chat's `openclawChatId` slot is SHARED
 *  with OpenClaw routing (per-turn `turn:<agent>:<msg>`, documentary
 *  `documentary:<msg>`); those carry a colon and must NOT be POSTed as a Hermes
 *  session id (`/api/sessions/turn:.../chat/stream` is not a session) — treat
 *  them as "no session", so ensureSession mints a fresh one (codex P1). */
export function isHermesSessionId(v: string | null): v is string {
  return typeof v === "string" && /^api_[0-9]+_[0-9a-f]+$/i.test(v);
}

// Convex's DELIBERATELY-FRESH session nonces (rotation to avoid context
// accumulation): a utility chat sets openclawChatId to one of these per
// invocation and EXPECTS a brand-new provider session each time. A Hermes turn
// must honor that (no session reuse), unlike a `turn:` per-turn-routing segment
// which wants continuity (codex P1).
const FRESH_SESSION_NONCE_RE = /^(summarize|documentary|curate):/i;

/**
 * Run one Hermes turn to completion. Registers it for /abort, persists a
 * newly-minted session id, and always deregisters. Throws only on a setup
 * error the caller should surface as a dispatch failure; a turn that reaches
 * the sink settles itself (success or actionable error) via the normalizer.
 */
export async function performHermesSend(
  cfg: BridgeConfig,
  writer: ConvexWriter,
  body: HermesSendBody,
  registry: HermesTurnRegistry,
): Promise<void> {
  if ((cfg.transport ?? "ws") === "ws") {
    return performHermesWsSend(cfg, writer, body, registry);
  }
  const client = hermesClientFor(cfg);
  const abort = new AbortController();
  // A Hermes session belongs to a SPECIFIC instance+agent+chat — a per-turn
  // switch to another target must not reuse it (codex P1). Key the bridge
  // memory by the full target, not the chat alone.
  const targetKey = `${cfg.instanceName ?? ""}\u0000${body.agentId}\u0000${body.chatId}`;
  // Continuity source of truth:
  //   1. a persisted Hermes id (api_...) in openclawChatId → reuse it;
  //   2. a rotation nonce (summarize:/documentary:/curate:) → FRESH, no reuse
  //      (respect the utility chat's deliberate rotation — codex P1);
  //   3. otherwise (null, or a `turn:` per-turn-routing segment) → the bridge's
  //      per-target memory (survives a routing-segment clobber this process).
  const priorSession = isHermesSessionId(body.openclawChatId)
    ? body.openclawChatId
    : body.openclawChatId && FRESH_SESSION_NONCE_RE.test(body.openclawChatId)
      ? null
      : registry.knownSession(targetKey);
  const run = runHermesTurn({
    client,
    writer,
    chatId: body.chatId,
    sessionKey: hermesSessionKey(body),
    providerChatId: priorSession,
    text: body.text,
    signal: abort.signal,
    onBoundSession: async (sessionId) => {
      registry.rememberSession(targetKey, sessionId);
      await (writer.bindProviderChat?.(body.chatId, sessionId) ??
        Promise.resolve());
    },
  });
  const entry = { abort, run };
  registry.set(body.chatId, entry);
  // Deregister when the BACKGROUND drain finishes (success/error/abort), but
  // ONLY if this entry is still the registered one (a fast Stop→resend may have
  // replaced it — codex P2). CATCH the rejection: a Convex write failing
  // mid-stream rejects `run.done`, and an unobserved rejected promise can crash
  // the process under current Node (codex P1).
  run.done.catch(() => {}).finally(() => registry.deleteIf(body.chatId, entry));
  // Return on ACCEPTANCE, not completion — /send mirrors OpenClaw's reply-on-ack
  // contract (the Convex action must not stay open for the whole generation). A
  // pre-stream dispatch failure rejects here → the caller returns 502 (codex P1).
  await run.accepted;
}

/** WS-transport send: session resume/create on the persistent JSON-RPC
 *  socket, prompt.submit as the acceptance point, events fanned to the turn by
 *  runtime session id. Same /send contract as the REST path (reply-on-ack). */
async function performHermesWsSend(
  cfg: BridgeConfig,
  writer: ConvexWriter,
  body: HermesSendBody,
  registry: HermesTurnRegistry,
): Promise<void> {
  const client = registry.wsClientFor(cfg);
  const targetKey = `${cfg.instanceName ?? ""}\u0000${body.agentId}\u0000${body.chatId}`;
  // Continuity: the persisted stored_session_id (WS shape only — never feed a
  // REST api_… id to the WS transport), else the bridge's per-target memory,
  // else fresh. Rotation nonces (summarize:/documentary:/curate:) stay fresh.
  const prior = isHermesWsStoredSessionId(body.openclawChatId)
    ? body.openclawChatId
    : body.openclawChatId && FRESH_SESSION_NONCE_RE.test(body.openclawChatId)
      ? null
      : (() => {
          const known = registry.knownSession(targetKey);
          return isHermesWsStoredSessionId(known) ? known : null;
        })();
  const run = runHermesWsTurn(
    {
      client,
      writer,
      chatId: body.chatId,
      sessionKey: hermesSessionKey(body),
      providerChatId: prior,
      text: body.text,
      attachments: body.attachments,
      // Outbound files honor the admin media setting: OFF ⇒ no delivery
      // directive, no scan, no hosting (codex P2).
      filesFetcher:
        cfg.mediaMode === "off" ? null : registry.filesFetcherFor(cfg),
      onBoundSession: async (storedSid) => {
        registry.rememberSession(targetKey, storedSid);
        await (writer.bindProviderChat?.(body.chatId, storedSid) ??
          Promise.resolve());
      },
    },
    (sid, onEvent) =>
      registry.subscribeWsSession(cfg.instanceName ?? "", sid, onEvent),
  );
  const entry = { run };
  registry.setWsTurn(body.chatId, entry);
  run.done.catch(() => {}).finally(() => registry.deleteWsTurnIf(body.chatId, entry));
  await run.accepted;
}

/** WS-transport abort: session.interrupt on the live runtime session. With a
 *  named target (the runtime session id stamped on the streaming row), abort
 *  ONLY on an exact match — a late stop must not kill a newer queued turn
 *  (codex P2, same contract as the REST path). */
async function performHermesWsAbort(
  cfg: BridgeConfig,
  chatId: string,
  registry: HermesTurnRegistry,
  expectedRunId: string | null = null,
  cause: "user" | "reset" = "user",
): Promise<boolean> {
  const current = registry.peekWsTurn(chatId);
  if (!current) return false;
  const liveSid = current.run.runtimeSessionId();
  if (expectedRunId && expectedRunId !== liveSid) return false;
  const turn = registry.takeWsTurn(chatId);
  if (!turn) return false;
  const sid = turn.run.runtimeSessionId();
  if (sid) {
    await registry
      .wsClientFor(cfg)
      .call("session.interrupt", { session_id: sid })
      .catch(() => {
        // Best-effort: the interrupt is a courtesy; the local settle below
        // guarantees the turn stops waiting either way.
      });
  }
  // Settle locally. User Stop: NO terminal (Convex already finalized the
  // message `aborted`). RESET: write the aborted terminal — dispatchReset does
  // NOT finalize optimistically, so without it the row would stay streaming
  // until the watchdog (codex P2).
  turn.run.forceSettle(cause === "reset");
  return true;
}

/**
 * Abort the in-flight Hermes turn for a chat: cancel the SSE request AND POST
 * the server-side run stop (best-effort). Returns true if a live turn was
 * found. Convex has already optimistically finalized the message as aborted.
 */
export async function performHermesAbort(
  cfg: BridgeConfig,
  chatId: string,
  registry: HermesTurnRegistry,
  expectedRunId: string | null = null,
  cause: "user" | "reset" = "user",
): Promise<boolean> {
  if ((cfg.transport ?? "ws") === "ws") {
    return performHermesWsAbort(cfg, chatId, registry, expectedRunId, cause);
  }
  // Target THIS turn: if the abort names a run id, only abort the registered
  // turn when it matches (a fast Stop→resend may have replaced the entry with a
  // newer turn — do NOT abort that one; codex P2). A null expectedRunId is a
  // legacy/best-effort abort of whatever is live.
  const current = registry.peek(chatId);
  if (!current) return false;
  const liveRunId = current.run.runId();
  // With a named target: abort ONLY on an EXACT match. If the live turn has no
  // run id yet (a newer turn that has not received run.started), it CANNOT be
  // the targeted old run — do NOT abort it (codex P2). A null expectedRunId is
  // a best-effort abort of whatever is live (e.g. Stop before run.started).
  if (expectedRunId && expectedRunId !== liveRunId) {
    return false;
  }
  const turn = registry.take(chatId);
  if (!turn) return false;
  const runId = turn.run.runId();
  // A /reset abort tells the turn to FINALIZE the message (Convex has not);
  // a user Stop lets Convex own the aborted terminal.
  turn.abort.abort(cause === "reset" ? HERMES_RESET_ABORT : undefined);
  if (runId) {
    await hermesClientFor(cfg)
      .stopRun(runId)
      .catch(() => {
        // Best-effort: the signal already cut the local stream; the server-side
        // stop is a courtesy so Hermes doesn't keep billing the run.
      });
  }
  return true;
}

/** Reset a Hermes chat: cancel any in-flight turn AND forget the persisted
 *  session so the next turn starts a fresh Hermes conversation (session-reset /
 *  delete-then-regenerate). Convex separately nulls the chat's openclawChatId. */
export async function performHermesReset(
  cfg: BridgeConfig,
  chatId: string,
  registry: HermesTurnRegistry,
  writer: ConvexWriter,
): Promise<void> {
  await performHermesAbort(cfg, chatId, registry, null, "reset");
  registry.forgetChat(chatId);
  // Clear the PERSISTED Hermes session too — else the next /send re-sends the
  // stored api_... id and priorSession resumes the OLD conversation, so a
  // reset/regenerate would keep the old server context (codex P1).
  await (writer.clearProviderChat?.(chatId) ?? Promise.resolve());
}

/** Provider-agnostic agent descriptor (mirrors the bridge's NormalizedAgent). */
export interface HermesDiscovered {
  agents: {
    agentId: string;
    displayName: string | null;
    emoji: string | null;
    model: string | null;
    isDefaultOnInstance: boolean;
    raw: unknown;
  }[];
  rawCount: number;
  gatewayVersion: string | null;
}

/** Discover the Hermes instance's single agent (the gateway exposes ONE agent
 *  as a "model" via /v1/models) + its version (via /health). Used by the same
 *  /agents poll the OpenClaw path uses — so the app's agent cache + bind
 *  whitelist work identically. Hermes has no per-provider subscription-usage
 *  RPC (unlike OpenClaw's usage.status), so no usage ride-along here. */
export async function discoverHermesAgents(
  cfg: BridgeConfig,
  registry?: HermesTurnRegistry,
): Promise<HermesDiscovered> {
  if ((cfg.transport ?? "ws") === "ws" && registry) {
    // WS transport: the gateway exposes ONE agent; model.options names the
    // CURRENT provider/model. `hermes serve` has no /health — version stays
    // null (the capability target is emitted regardless; range-floor rules).
    const client = registry.wsClientFor(cfg);
    const r = await client.call("model.options", {});
    const providers = Array.isArray(r.providers)
      ? (r.providers as Array<Record<string, unknown>>)
      : [];
    const current = providers.find((p) => p.is_current === true);
    const model =
      typeof current?.current_model === "string" && current.current_model
        ? String(current.current_model)
        : typeof current?.name === "string"
          ? String(current.name)
          : null;
    return {
      agents: [
        {
          // The SAME stable id the REST discovery exposes ("hermes-agent",
          // /v1/models) so a transport switch never re-keys the agent cache.
          agentId: "hermes-agent",
          displayName: "hermes-agent",
          emoji: null,
          model,
          isDefaultOnInstance: true,
          raw: current ?? r,
        },
      ],
      rawCount: 1,
      gatewayVersion: null,
    };
  }
  const client = hermesClientFor(cfg);
  const [models, health] = await Promise.all([
    client.models(),
    client.health().catch(() => null),
  ]);
  const list = Array.isArray(models?.data) ? models.data : [];
  const agents = list.map((m, i) => ({
    agentId: m.id,
    displayName: m.id,
    emoji: null,
    model: m.id,
    isDefaultOnInstance: i === 0,
    raw: m,
  }));
  return {
    agents,
    rawCount: list.length,
    gatewayVersion: health?.version ?? null,
  };
}
