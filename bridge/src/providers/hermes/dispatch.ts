// Hermes /send + /abort glue for the bridge HTTP server. Keeps server.ts thin:
// it only branches on `cfg.kind === "hermes"` and calls these. The Hermes turn
// has no persistent session (unlike OpenClaw's SessionRegistry), so a tiny
// in-memory registry tracks the ONE in-flight turn per chat purely so /abort
// can cancel it (signal + server-side stopRun). Lost on restart = fine: an
// abort only means anything for a turn live in THIS process.

import type { BridgeConfig } from "../../config.js";
import type { ConvexWriter } from "../../convex-writer.js";
import { HermesClient, type HermesInterruptVerdict } from "./client.js";
import { HermesWsClient } from "./ws-client.js";
import { HermesFilesFetcher } from "./files-fetcher.js";
import { safeSessionPart } from "../openclaw/session-keys.js";
import { runHermesTurn, HERMES_RESET_ABORT, type HermesTurnRun } from "./turn.js";
import {
  runHermesWsTurn,
  isHermesWsStoredSessionId,
  readHermesGatewayVersion,
  type HermesWsTurnRun,
  type HermesWsSessionHandlers,
} from "./ws-turn.js";

/** Non-secret routed body fields the Hermes path needs (subset of the send body). */
export interface HermesSendBody {
  chatId: string;
  agentId: string;
  canonical: string;
  openclawChatId: string | null; // reused as the Hermes session id (providerChatId)
  /** A session this chat LOST a reply on, for ONE read-only harvest before it is forgotten
   *  (G-47). Deliberately NOT merged into `openclawChatId`: that slot decides what the turn
   *  RESUMES, and this is precisely a session nobody may resume. */
  recoverableSession?: {
    session: string;
    messageId: string;
    /** The instance that PRODUCED the session. Session ids are gateway-local, so a handle
     *  must never be replayed against another instance — a rebind or a per-turn routing
     *  switch would otherwise ask B to resume A's id (raised in review). */
    instanceName?: string | null;
  } | null;
  text: string;
  /** Inline base64 attachments (WS transport stages them via file.attach /
   *  image.attach_bytes before the prompt; REST has no upload channel). */
  attachments?: Array<{ mimeType: string; fileName: string; content: string }>;
  /** The user message id of this turn — excluded from the fresh-session
   *  rehydration history (present on the wire; optional for old callers). */
  messageId?: string | null;
  /** The OUTBOX row this turn was dispatched from — echoed into the assistant row
   *  as the correlation outbox reconciliation needs (provider-neutral). */
  outboxId?: string | null;
  /** How long the dispatch had already been pending when Convex sent the POST. */
  dispatchAgeMs?: number;
  /** Provider-session reset epoch (chats.providerResetCount at dispatch) —
   *  echoed by the post-ACK session bind so Convex refuses a bind that raced
   *  a /reset (bindProviderChat). Absent/null on an old Convex. */
  providerResetCount?: number | null;
  /** Per-instance hot config (the `rehydration` knob rides here, same source
   *  the OpenClaw path reads). */
  config?: { rehydration?: boolean } | null;
}

/**
 * FRESH-session history prepend (parity with the OpenClaw path, server.ts
 * performSend): when this chat has NO prior Hermes session — a brand-new chat or
 * a BRANCHED one (chatFork) — prepend the chat's rehydration history to the
 * first prompt, so the agent knows the carried conversation. Mirrors the
 * OpenClaw guards: per-instance `rehydration` knob (env kill-switch fallback),
 * and SKIPPED when attachments ride the turn (keep the first staged turn lean —
 * same posture as the OpenClaw gateway-crash guard). Best-effort: a context
 * fetch failure sends the bare prompt (a cold agent beats a failed send).
 */
export async function promptWithFreshSessionHistory(
  writer: ConvexWriter,
  body: HermesSendBody,
  freshSession: boolean,
): Promise<string> {
  if (!freshSession) return body.text;
  const enabled =
    body.config?.rehydration ?? process.env.OPENCLAW_REHYDRATION !== "off";
  if (!enabled) return body.text;
  if (body.attachments && body.attachments.length > 0) return body.text;
  // No messageId = no reliable exclusion of the CURRENT user message (already
  // persisted in Convex): the history would contain it AND we would append
  // body.text again — a duplicated prompt. Legacy callers without the field
  // ship bare instead (a cold agent beats a doubled message).
  if (!body.messageId) return body.text;
  try {
    const ctx = await writer.getRehydrationContext(
      body.chatId,
      body.messageId ?? null,
    );
    if (ctx.history) {
      // Content-free decision log (counts + chatId only), like OpenClaw's.
      console.error(
        `[rehydrate] hermes chat=${body.chatId} fresh session -> prepended ${ctx.turnCount} prior turn(s)`,
      );
      return `${ctx.history}\n\n${body.text}`;
    }
  } catch (e) {
    console.error(
      "[rehydrate] hermes context fetch failed (bare send):",
      (e as Error)?.message ?? e,
    );
  }
  return body.text;
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
/** Two turns cannot share one runtime session's event lane — see `subscribeWsSession`.
 *  A named class so the caller settles the bubble with a stable, actionable cause
 *  instead of matching on prose. */
/** Placeholder held between claiming a chat's turn seat and binding the run to it. */
const WS_TURN_SEAT_RESERVED = Symbol("ws-turn-seat-reserved");

/** The chat already has a live WS turn — its seat, and its `/abort` target, are taken. */
export class HermesChatTurnBusyError extends Error {
  readonly code = "chat_turn_busy";
  constructor(chatId: string) {
    super(`Chat ${chatId} already has a live Hermes WS turn on this bridge.`);
    this.name = "HermesChatTurnBusyError";
  }
}

export class HermesSessionLaneBusyError extends Error {
  readonly code = "session_lane_busy";
  constructor(runtimeSessionId: string) {
    super(
      `Hermes session ${runtimeSessionId} already has a live turn on this bridge.`,
    );
    this.name = "HermesSessionLaneBusyError";
  }
}

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
  private wsSubscribers = new Map<string, HermesWsSessionHandlers>();
  private wsTurns = new Map<string, LiveHermesWsTurn | typeof WS_TURN_SEAT_RESERVED>();

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
        sub?.onEvent(type, payload);
      },
      onClose: () => {
        // THIS instance's socket died: its subscribed turns settle so no message is
        // left streaming until the watchdog. Turns of OTHER instances are untouched.
        // Next turn reconnects lazily.
        //
        // Through the turn's own TRANSPORT-LOST callback, not an injected `error` event:
        // that branch means "Hermes delivered a failure", and a turn taking this exit
        // used to keep its stored session — which nobody can vouch for, since the run
        // may still be going on the other side of the socket that just died.
        //
        // ONE heartbeat drops EVERY session of the instance. That is the honest scope:
        // the socket is per-instance, so its death really does leave every turn on it
        // unattributable. The cost is bounded — one rehydration each.
        for (const [k, sub] of this.wsSubscribers) {
          if (!k.startsWith(`${key}\u0000`)) continue;
          this.wsSubscribers.delete(k);
          sub.onTransportLost("Hermes WS connection lost.");
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
    handlers: HermesWsSessionHandlers,
  ): () => void {
    const k = `${instanceName}\u0000${runtimeSessionId}`;
    // REFUSE, never overwrite. A `set` here used to silently replace a live turn's
    // handlers: turn N then received NOTHING and its terminal — its whole reply — was
    // applied to turn N+1's bubble. The wire cannot save us after the fact either, and
    // that is what settles the design: Hermes event frames carry ONLY `session_id`, with
    // no per-turn correlation of any kind (verified against the live capture), so two
    // Atrium turns sharing one runtime session are not demultiplexable. The honest move
    // is to keep the lane its first owner has and let the newcomer fail by NAME, before
    // it submits anything.
    const held = this.wsSubscribers.get(k);
    if (held !== undefined) {
      throw new HermesSessionLaneBusyError(runtimeSessionId);
    }
    this.wsSubscribers.set(k, handlers);
    return () => {
      // IDENTITY-checked: a later turn on the same runtime session must keep its own
      // handlers when this turn's deferred unsubscribe fires. `onClose` already deleted
      // the entry before notifying, so the double-fire is a no-op either way.
      if (this.wsSubscribers.get(k) === handlers) {
        this.wsSubscribers.delete(k);
      }
    };
  }

  /** CLAIM the chat's single WS turn seat, before the turn exists.
   *
   *  The seat is what `/abort` targets — one per chat — so a newcomer taking it left the
   *  turn the user is WATCHING impossible to stop. Refusing the seat alone was not
   *  enough either: the run had already been built and went on to submit, so the chat
   *  ended up with two live bubbles, one of them unabortable (raised in review). The
   *  claim therefore happens BEFORE the run is created, and a refused claim means no
   *  prompt is ever sent. */
  claimWsTurnSeat(chatId: string): boolean {
    if (this.wsTurns.has(chatId)) return false;
    this.wsTurns.set(chatId, WS_TURN_SEAT_RESERVED);
    return true;
  }
  /** Attach the run to a seat this caller has already claimed. */
  bindWsTurn(chatId: string, turn: LiveHermesWsTurn): void {
    if (this.wsTurns.get(chatId) === WS_TURN_SEAT_RESERVED) {
      this.wsTurns.set(chatId, turn);
    }
  }
  /** Give the seat back when the turn never started (pre-ACK failure). */
  releaseWsTurnSeat(chatId: string): void {
    if (this.wsTurns.get(chatId) === WS_TURN_SEAT_RESERVED) {
      this.wsTurns.delete(chatId);
    }
  }
  peekWsTurn(chatId: string): LiveHermesWsTurn | undefined {
    const t = this.wsTurns.get(chatId);
    // A merely RESERVED seat has no run to abort: nothing has been submitted yet.
    return t === WS_TURN_SEAT_RESERVED ? undefined : t;
  }
  takeWsTurn(chatId: string): LiveHermesWsTurn | undefined {
    const t = this.wsTurns.get(chatId);
    this.wsTurns.delete(chatId);
    // A reserved-but-unbound seat has no run: taking it frees the chat, and there is
    // nothing to abort.
    return t === WS_TURN_SEAT_RESERVED ? undefined : t;
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
  /** LAST OBSERVED gateway version, per instance. The WS transport can only learn it from
   *  a `session.info` event, so it is only known once a turn has run — the discovery poll
   *  of a freshly started bridge legitimately reports `null`, and that is the honest state
   *  rather than a guess. Mirrors the per-instance `lastGatewayVersion` the OpenClaw path
   *  keeps in `server.ts`: one gateway, one version, never shared between instances. */
  private gatewayVersions = new Map<string, string | null>();
  /** Record what a turn OBSERVED. `null` is a real observation — "a version arrived and it
   *  is not one this build reads" — and it must be kept, because it has to retire whatever
   *  was believed before: an upgrade to an unvalidated major otherwise keeps publishing the
   *  previous version's capability set (raised in review). */
  noteGatewayVersion(instanceName: string, version: string | null): void {
    this.gatewayVersions.set(instanceName, version);
  }
  gatewayVersionFor(instanceName: string): string | null {
    return this.gatewayVersions.get(instanceName) ?? null;
  }
  /** Has any turn on this instance looked yet, and what did it see? `seen: false` is the
   *  cold start, where older sources (the discovery snapshot, the configured fallback) are
   *  all there is; `seen: true` makes the live answer authoritative, `null` included. */
  observedVersionFor(instanceName: string): {
    seen: boolean;
    version: string | null;
  } {
    return this.gatewayVersions.has(instanceName)
      ? { seen: true, version: this.gatewayVersions.get(instanceName) ?? null }
      : { seen: false, version: null };
  }

  /** Per-chat RESET generation, bumped by forgetChat: a turn captures it at
   *  start and its post-ACK session persistence applies ONLY if unchanged —
   *  else a bind landing AFTER a user reset would rewrite the stale session id
   *  into the freshly-cleared slot and the next turn would resume the very
   *  session the reset discarded (codex P1). */
  private resetGens = new Map<string, number>();
  generationOf(chatId: string): number {
    return this.resetGens.get(chatId) ?? 0;
  }
  /** Drop every remembered Hermes session for a chat (all targets) — a /reset
   *  must make the NEXT turn mint a FRESH session, not reuse the old one. */
  forgetChat(chatId: string): void {
    const suffix = `\u0000${chatId}`;
    for (const key of this.sessions.keys()) {
      if (key.endsWith(suffix)) this.sessions.delete(key);
    }
    this.resetGens.set(chatId, this.generationOf(chatId) + 1);
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


/** WHICH session this send continues, or null for a fresh one.
 *
 *  Exported because it is a DECISION, and a decision that only exists inline is a decision
 *  no test can see change — the two transports each kept their own copy until one of them
 *  silently missed a rule the other had.
 *
 *  It briefly consulted an in-memory QUARANTINE, back when a timed-out turn cleared its
 *  session in a separate write that could fail on its own. That write now rides the
 *  finalize (lot 31), so by the time the chat is released the slot is already clear and
 *  there is nothing left to quarantine.
 *
 *  Order matters:
 *   1. a persisted Hermes id (`api_…`) → reuse it;
 *   2. a rotation nonce (summarize:/documentary:/curate:) → fresh, no reuse (respect the
 *      utility chat's deliberate rotation);
 *   3. otherwise (null, or a `turn:` per-turn-routing segment) → the bridge's per-target
 *      memory, which survives a routing-segment clobber within this process. */
export function selectPriorSession(
  registry: Pick<HermesTurnRegistry, "knownSession">,
  body: { chatId: string; openclawChatId: string | null },
  targetKey: string,
  /** Which id shape THIS transport may continue. Passed in rather than assumed: the two
   *  transports store different shapes, and feeding a REST `api_…` id to the WS path (or
   *  the reverse) resumes nothing. The first version of this function hard-coded the REST
   *  validator, so the WS path — the DEFAULT transport — kept its own copy of the
   *  selection and never consulted the quarantine at all (raised in review). One
   *  decision, one place, or the same blind spot returns. */
  isOwnSessionId: (id: string | null) => boolean = isHermesSessionId,
): string | null {
  if (isOwnSessionId(body.openclawChatId)) return body.openclawChatId;
  if (body.openclawChatId && FRESH_SESSION_NONCE_RE.test(body.openclawChatId)) return null;
  const known = registry.knownSession(targetKey);
  return isOwnSessionId(known) || known === null ? known : null;
}

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
  // Health-stats hook: a turn erroring AFTER acceptance (the background drain)
  // is reported as a downstream failure on its target (recordTurnError) — the
  // /send handler only classifies PRE-acceptance rejections.
  onTurnError?: (code: string) => void,
  /** When the /send HTTP handler received the request — the pre-send deadline is
   *  measured from there, so time lost in rehydration/staging counts too. */
  sendReceivedMs: number = Date.now(),
): Promise<void> {
  if ((cfg.transport ?? "ws") === "ws") {
    return performHermesWsSend(
      cfg,
      writer,
      body,
      registry,
      onTurnError,
      sendReceivedMs,
    );
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
  const priorSession = selectPriorSession(registry, body, targetKey);
  // Reset-generation snapshot: gates the post-ACK session persistence below
  // AND the send itself across the history-fetch await.
  const resetGen = registry.generationOf(body.chatId);
  // Branched/new chat on a FRESH Hermes session: carry the visible history to
  // the agent (parity with OpenClaw's rehydration — chatFork depends on it).
  const text = await promptWithFreshSessionHistory(
    writer,
    body,
    priorSession === null,
  );
  // A /reset landed DURING the context fetch: the turn was not registered yet
  // (nothing for the reset to abort), so without this check the send would
  // proceed and reply into a conversation the user just discarded (codex P1).
  // Throwing here is pre-acceptance → the caller 502s → a visible failed
  // dispatch on the message the user was resetting over — honest and safe.
  if (registry.generationOf(body.chatId) !== resetGen) {
    throw new Error("chat reset during dispatch");
  }
  const run = runHermesTurn({
    client,
    writer,
    chatId: body.chatId,
    sessionKey: hermesSessionKey(body),
    providerChatId: priorSession,
    text,
    // Session-recovery seam: the turn minted a FRESH session despite the
    // stored id (404) → re-request the prompt WITH the history (same guards:
    // knob, attachments, best-effort — all inside the helper).
    freshText: () => promptWithFreshSessionHistory(writer, body, true),
    signal: abort.signal,
    dispatchOutboxId: body.outboxId,
    sendReceivedMs,
    dispatchAgeMs: body.dispatchAgeMs,
    onTurnError,
    // In-process cache only: the DURABLE drop rides the terminal (lot 31). Without this
    // the selector's memory fallback handed the suspect session straight back inside the
    // same bridge process.
    onSessionForgotten: () => registry.forgetChat(body.chatId),
    onBoundSession: async (sessionId) => {
      // A /reset that ran AFTER this turn started owns the slot now: a late
      // (post-ACK, fire-and-forget) bind must not resurrect the discarded
      // session into the freshly-cleared chat (codex P1). Two layers: the
      // in-process generation gates the in-memory map; the reset EPOCH rides
      // to Convex where bindProviderChat compares it ATOMICALLY (the network
      // flight itself can still race a reset — only the mutation can close it).
      if (registry.generationOf(body.chatId) !== resetGen) return;
      registry.rememberSession(targetKey, sessionId);
      await (writer.bindProviderChat?.(
        body.chatId,
        sessionId,
        body.providerResetCount ?? undefined,
      ) ?? Promise.resolve());
    },
    // Same contract as the WS path — one callback, one meaning: this turn ended without
    // knowing whether the provider's run stopped, so its session must not be resumed.
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
  onTurnError?: (code: string) => void,
  sendReceivedMs: number = Date.now(),
): Promise<void> {
  // CLAIM THE SEAT FIRST — before any session RPC, and above all before any
  // `prompt.submit`. The chat has exactly one abortable turn, so a second one is a turn
  // the user cannot stop; refusing the seat AFTER building the run was not enough,
  // because the run went on to submit anyway (raised in review). Nothing is sent from
  // here on a refusal.
  if (!registry.claimWsTurnSeat(body.chatId)) {
    throw new HermesChatTurnBusyError(body.chatId);
  }
  try {
    await runClaimedWsSend(cfg, writer, body, registry, onTurnError, sendReceivedMs);
  } finally {
    // EVERY exit before the run is bound gives the seat back — not just a rejected
    // `accepted`. The rehydration await and the reset-generation guard both throw in
    // between, and a `/reset` landing there left the placeholder in place forever: every
    // later send answered `chat_turn_busy` until the bridge restarted (raised in review).
    // A no-op once the run owns the seat, by construction.
    registry.releaseWsTurnSeat(body.chatId);
  }
}

async function runClaimedWsSend(
  cfg: BridgeConfig,
  writer: ConvexWriter,
  body: HermesSendBody,
  registry: HermesTurnRegistry,
  onTurnError?: (code: string) => void,
  sendReceivedMs: number = Date.now(),
): Promise<void> {
  const client = registry.wsClientFor(cfg);
  const targetKey = `${cfg.instanceName ?? ""}\u0000${body.agentId}\u0000${body.chatId}`;
  // Continuity: the persisted stored_session_id (WS shape only — never feed a
  // REST api_… id to the WS transport), else the bridge's per-target memory,
  // else fresh. Rotation nonces (summarize:/documentary:/curate:) stay fresh.
  const prior = selectPriorSession(
    registry,
    body,
    targetKey,
    isHermesWsStoredSessionId,
  );
  // BEFORE anything is minted or sent: read back a reply the previous turn lost (G-47).
  // Best-effort by construction — a handle the gateway has forgotten, a session still
  // running, a turn that was mid-production: each returns null and this turn proceeds
  // exactly as it would have. The session is READ, never continued; whatever happens the
  // turn below runs on a fresh one with the rehydrated history.
  // The reset generation is captured BEFORE the harvest, not after. The seat is already
  // claimed but no run is bound to it yet, so a `/reset` landing during the harvest's network
  // wait has nothing to abort — and reading the generation afterwards would read the NEW one
  // and let the very prompt the reset meant to stop go through (raised in review).
  const preHarvestGen = registry.generationOf(body.chatId);
  const lost = body.recoverableSession ?? null;
  if (lost) {
    const text = await harvestLostReply(client, lost.session);
    // Posted EVEN when nothing was harvested. The mutation spends the handle before it
    // judges the text, so this is what makes the read ONE-SHOT — and the refusals are the
    // common case (a gateway that restarted has forgotten the session), so a handle left
    // standing would make every later send pay another `session.resume` (raised in review).
    await (writer
      .recoverLostReply?.(body.chatId, lost.messageId, lost.session, text ?? "")
      .catch((e) =>
        console.error(
          "[hermes-recover] the harvest could not be recorded:",
          (e as Error)?.message ?? e,
        ),
      ) ?? Promise.resolve());
  }
  // A /reset landed DURING the harvest: refuse the send, exactly as the history-fetch guard
  // below does for its own await.
  if (registry.generationOf(body.chatId) !== preHarvestGen) {
    throw new Error("chat reset during dispatch");
  }
  // Reset-generation snapshot: gates the post-ACK session persistence below
  // AND the send itself across the history-fetch await.
  const wsResetGen = preHarvestGen;
  // Same fresh-session history carry as the REST path (chatFork parity).
  const wsText = await promptWithFreshSessionHistory(
    writer,
    body,
    prior === null,
  );
  // Same mid-fetch /reset guard as the REST path (codex P1): the turn is not
  // registered yet, so the reset had nothing to abort — refuse the send.
  if (registry.generationOf(body.chatId) !== wsResetGen) {
    throw new Error("chat reset during dispatch");
  }
  const run = runHermesWsTurn(
    {
      client,
      writer,
      chatId: body.chatId,
      sessionKey: hermesSessionKey(body),
      providerChatId: prior,
      dispatchOutboxId: body.outboxId,
      sendReceivedMs,
      dispatchAgeMs: body.dispatchAgeMs,
      text: wsText,
      // Session-recovery seam (same as the REST path): a degraded/failed
      // resume minted a fresh session → the prompt must carry the history.
      freshText: () => promptWithFreshSessionHistory(writer, body, true),
      attachments: body.attachments,
      // Outbound files honor the admin media setting: OFF ⇒ no delivery
      // directive, no scan, no hosting (codex P2).
      filesFetcher:
        cfg.mediaMode === "off" ? null : registry.filesFetcherFor(cfg),
      onTurnError,
      // The gateway version, observed on the only frame that carries it. Cached per
      // INSTANCE (not per chat): one gateway, one version, and the /capabilities poll that
      // reads it back has no chat of its own.
      onGatewayVersion: (version) =>
        registry.noteGatewayVersion(cfg.instanceName ?? "", version),
      // See the REST path: the durable drop rides the terminal, this is the cache.
      onSessionForgotten: () => registry.forgetChat(body.chatId),
      onBoundSession: async (storedSid) => {
        // Same two-layer reset guard as the REST path: in-process generation
        // for the memory map + the Convex-side epoch for the atomic close.
        if (registry.generationOf(body.chatId) !== wsResetGen) return;
        registry.rememberSession(targetKey, storedSid);
        await (writer.bindProviderChat?.(
          body.chatId,
          storedSid,
          body.providerResetCount ?? undefined,
        ) ?? Promise.resolve());
      },
    },
    (sid, onEvent) =>
      registry.subscribeWsSession(cfg.instanceName ?? "", sid, onEvent),
  );
  const entry = { run };
  registry.bindWsTurn(body.chatId, entry);
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
): Promise<HermesAbortResult> {
  const current = registry.peekWsTurn(chatId);
  if (!current) return NOT_ABORTED;
  const liveSid = current.run.runtimeSessionId();
  if (expectedRunId && expectedRunId !== liveSid) return NOT_ABORTED;
  const turn = registry.takeWsTurn(chatId);
  if (!turn) return NOT_ABORTED;
  const sid = turn.run.runtimeSessionId();
  // FIRST, and regardless of how the interrupt turns out: a turn being cut must not persist
  // a binding it decided in its dying moments. `session.info` can rotate the session in the
  // turn's tail and queue that write (lot 36), and until now a user Stop let it land —
  // putting a session nobody will ever verify back into the slot (raised in review).
  turn.run.markSessionUntrusted();
  // SECOND, the local settle — BEFORE any waiting or any network call. User Stop: NO
  // terminal (Convex already finalized the message `aborted`). RESET: write the aborted
  // terminal — dispatchReset does NOT finalize optimistically, so without it the row would
  // stay streaming until the watchdog (codex P2).
  //
  // Its position is the point: settling after the bind wait left the reader consuming for
  // up to two seconds, and a provider terminal landing there finalized the message
  // `complete` — first-terminal-wins then made Convex's settle lose, so a Stop the user
  // pressed rendered a finished answer (raised in review). Protecting the session must
  // never cost the Stop.
  turn.run.forceSettle(cause === "reset");
  // THEN let the writes ALREADY in flight land, so the id below is the one Convex holds
  // and not one it is about to hold.
  await settleBindingsBounded(turn.run, chatId);
  // The STORED id, not the runtime one: `session.interrupt` is routed by runtime session,
  // but the chat's binding holds the stored id, so that is the only name a drop can match.
  const providerSession = turn.run.storedSessionId();
  let interrupt: HermesInterruptVerdict;
  if (sid) {
    interrupt = await registry
      .wsClientFor(cfg)
      .call("session.interrupt", { session_id: sid })
      .then<HermesInterruptVerdict>(() => "interrupted")
      // NOT "ineffective": on this transport the interrupt genuinely works
      // (`session.interrupt` calls `agent.interrupt()` and sets
      // `_turn_cancel_requested`), so a lost RPC answer says nothing about whether it
      // ran. Unknown state is still not resumed — that is lot 30's rule, not a new one.
      .catch<HermesInterruptVerdict>(() => "unknown");
  } else {
    // No runtime session means nothing was even asked. The prompt was submitted, so a
    // run may well be live on the other side; claiming otherwise is what left the
    // session bound to it.
    interrupt = "ineffective";
  }
  forgetSessionIfUnhonoured(registry, chatId, interrupt);
  return { aborted: true, interrupt, providerSession };
}

/**
 * READ a reply the gateway finished, from a session nobody may resume (G-47).
 *
 * The turn died from OUR side — a dead transport, a provider that went silent — so the
 * terminal cleared the session it could not vouch for. But the gateway may well have gone on
 * to FINISH the answer, and it keeps it in `inflight`. This reads it once and returns it;
 * whatever happens, the caller mints a fresh session for the turn that follows. The session
 * is read, never continued.
 *
 * Two guards, and both are upstream's OWN signals rather than inferences of ours:
 *   * `running` — `session.resume` on a live session answers through `_reuse_live_payload`,
 *     returning the live snapshot WITHOUT re-attaching. So this fires before any harm, which
 *     is what makes reading a session lot 30 forbids RESUMING defensible at all.
 *   * `inflight.streaming` — a turn still being produced holds a PARTIAL. Presenting that as
 *     the finished reply is the failure lot 34 exists to prevent, arriving by another door.
 *
 * Never throws: a handle the gateway has forgotten (the ordinary case after a restart) must
 * cost the next turn nothing.
 */
export async function harvestLostReply(
  client: Pick<HermesWsClient, "call">,
  session: string,
): Promise<string | null> {
  try {
    const r = await client.call("session.resume", { session_id: session });
    // The answer must be ABOUT the session we asked for: a rotation, or a stale handle, would
    // otherwise attribute one conversation's text to another.
    if (String((r as { stored_session_id?: unknown }).stored_session_id ?? "") !== session) {
      return null;
    }
    if ((r as { running?: unknown }).running === true) return null;
    const inflight = (r as { inflight?: unknown }).inflight;
    if (typeof inflight !== "object" || inflight === null) return null;
    const snap = inflight as { assistant?: unknown; streaming?: unknown };
    if (snap.streaming === true) return null;
    const text = typeof snap.assistant === "string" ? snap.assistant.trim() : "";
    return text === "" ? null : text;
  } catch (e) {
    console.error(
      "[hermes-recover] could not read the lost reply (non-fatal):",
      (e as Error)?.message ?? e,
    );
    return null;
  }
}

/** What an abort attempt learned, for the caller that has to act on it.
 *
 *  `interrupt`/`providerSession` are null when NOTHING was aborted: there is no verdict
 *  to give about a turn that was not there, and above all no session to drop — the chat
 *  may be bound to a turn that is working. */
export interface HermesAbortResult {
  aborted: boolean;
  interrupt: HermesInterruptVerdict | null;
  providerSession: string | null;
}

const NOT_ABORTED: HermesAbortResult = {
  aborted: false,
  interrupt: null,
  providerSession: null,
};

/**
 * THE SECOND LAYER, without which the durable drop is decoration.
 *
 * Convex nulls `openclawChatId`, but `selectPriorSession` FALLS BACK to this registry's
 * in-memory memory of the chat's session. So in the same bridge process the very next turn
 * resumed the session that had just been declared untrusted — the first cut of this lot
 * shipped the durable half only (raised in review). The rule is already stated at the
 * `onSessionForgotten` call sites: the durable drop rides the terminal, THIS is the cache.
 *
 * `forgetChat` also bumps the chat's reset GENERATION, which is what both transports'
 * `onBoundSession` guards compare against — so a bind still in flight at the dispatch
 * layer is refused too, cache and durable write alike.
 *
 * Conditional on the verdict, unlike the turn-level marking: a CONFIRMED interrupt leaves
 * a perfectly usable conversation behind, and evicting it would cost a rehydration for
 * nothing.
 */
/** How long an abort waits for a binding write it found in flight. One Convex mutation,
 *  no more: past that the Stop matters more than naming the slot exactly. */
const ABORT_BIND_SETTLE_MS = 2_000;

/**
 * Let the turn's in-flight binding writes LAND before reading which session it holds.
 *
 * The race this closes, raised in review: a rotation A→B whose `bindProviderChat(B)` is
 * already on the network when the Stop arrives. Reading the id then gave B while Convex
 * still held A, so the clear found a mismatch — and a mismatch drops NOTHING and bumps no
 * epoch, which is exactly what let the in-flight write land afterwards and put B back.
 *
 * Bounded, and failure is not fatal: on a timeout the id read is whatever Convex was last
 * known to hold, which degrades to the previous behaviour rather than blocking the Stop.
 */
async function settleBindingsBounded(
  run: { settledBindings(): Promise<void> },
  chatId: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ABORT_BIND_SETTLE_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const outcome = await Promise.race([
      run.settledBindings().then(() => "settled" as const),
      bound,
    ]);
    if (outcome === "timeout") {
      console.error(
        `[hermes-abort] a session bind was still in flight after ` +
          `${ABORT_BIND_SETTLE_MS} ms chat=${chatId} — naming the last known binding`,
      );
    }
  } catch {
    // `settledBindings` never rejects (the chain swallows its own errors); belt and
    // braces, because a throw here would turn a Stop into a 502.
  } finally {
    clearTimeout(timer);
  }
}

function forgetSessionIfUnhonoured(
  registry: HermesTurnRegistry,
  chatId: string,
  interrupt: HermesInterruptVerdict,
): void {
  if (interrupt === "interrupted") return;
  registry.forgetChat(chatId);
}

/**
 * DROP the chat's provider session durably, from the BRIDGE, when the stop was not honoured.
 *
 * The verdict's primary carrier is the `/abort` response: it rides Convex's guaranteed
 * settle, so the drop is atomic with the aborted terminal (lot 31's rule). But it is the
 * ONLY carrier, and a response that never arrives takes the drop with it — the bridge has
 * already tried to interrupt, the run may still be writing to the session, and Convex
 * settles the bubble without ever hearing about it (raised in review). This is the second
 * carrier, so the guarantee does not depend on one HTTP reply surviving.
 *
 * Applying twice is harmless: the later clear finds an empty slot and only bumps the epoch.
 * A `null` verdict means no turn was aborted — nothing to drop, and the chat may well be
 * bound to a turn that is working.
 *
 * Never throws: a failed durable write must not turn a Stop into a 502.
 */
export async function applyDurableSessionDrop(
  writer: Pick<ConvexWriter, "clearProviderChat">,
  chatId: string,
  result: HermesAbortResult,
): Promise<void> {
  if (result.interrupt === null || result.interrupt === "interrupted") return;
  try {
    await (writer.clearProviderChat?.(chatId) ?? Promise.resolve());
  } catch (e) {
    console.error(
      "[hermes-abort] durable session drop failed (the response still carries it):",
      (e as Error)?.message ?? e,
    );
  }
}

/**
 * The `/abort` JSON body. Extracted so the WIRE SHAPE has exactly one producer: its keys
 * are read on the other side by `convex/bridge.ts` → `readUntrustedSessionAfterAbort`,
 * and a rename on either side is a SILENT failure — Convex would read `undefined`, drop
 * nothing, and the phantom-turn defect would be back with every test still green.
 *
 * Both verdict fields are OMITTED rather than nulled: their absence is what an older
 * bridge sends mid-rolling-deploy, and it must read as "no verdict", never as "the stop
 * failed" (which would drop a healthy session on every Stop).
 */
export function hermesAbortResponseBody(
  result: HermesAbortResult,
): Record<string, unknown> {
  return {
    ok: true,
    aborted: result.aborted,
    ...(result.interrupt ? { interrupt: result.interrupt } : {}),
    ...(result.providerSession
      ? { providerSession: result.providerSession }
      : {}),
  };
}

/**
 * Abort the in-flight Hermes turn for a chat: cancel the SSE request AND ask the provider
 * to stop the run. Convex has already optimistically finalized the message as aborted.
 *
 * The server-side stop is NOT a courtesy, and the comment that used to call it one hid
 * the defect this returns a verdict for. Cancelling our read stops us reading; the run
 * goes on, bills, keeps running tools, and — this is the user-visible part —
 * `agent/turn_finalizer.py` persists its turn into the session transcript, so the NEXT
 * turn inherits a reply the user never saw and believes was cancelled. Reporting whether
 * the stop took effect is what lets Convex refuse to resume such a session.
 */
export async function performHermesAbort(
  cfg: BridgeConfig,
  chatId: string,
  registry: HermesTurnRegistry,
  expectedRunId: string | null = null,
  cause: "user" | "reset" = "user",
): Promise<HermesAbortResult> {
  if ((cfg.transport ?? "ws") === "ws") {
    return performHermesWsAbort(cfg, chatId, registry, expectedRunId, cause);
  }
  // Target THIS turn: if the abort names a run id, only abort the registered
  // turn when it matches (a fast Stop→resend may have replaced the entry with a
  // newer turn — do NOT abort that one; codex P2). A null expectedRunId is a
  // legacy/best-effort abort of whatever is live.
  const current = registry.peek(chatId);
  if (!current) return NOT_ABORTED;
  const liveRunId = current.run.runId();
  // With a named target: abort ONLY on an EXACT match. If the live turn has no
  // run id yet (a newer turn that has not received run.started), it CANNOT be
  // the targeted old run — do NOT abort it (codex P2). A null expectedRunId is
  // a best-effort abort of whatever is live (e.g. Stop before run.started).
  if (expectedRunId && expectedRunId !== liveRunId) {
    return NOT_ABORTED;
  }
  const turn = registry.take(chatId);
  if (!turn) return NOT_ABORTED;
  const runId = turn.run.runId();
  // Same three steps, same order, same reasons as the WS path: mark so no NEW binding can
  // be written, CUT THE STREAM, and only then wait on the writes already in flight. The
  // cut before the wait is what keeps a provider terminal from finishing a turn the user
  // stopped.
  turn.run.markSessionUntrusted();
  // A /reset abort tells the turn to FINALIZE the message (Convex has not);
  // a user Stop lets Convex own the aborted terminal.
  turn.abort.abort(cause === "reset" ? HERMES_RESET_ABORT : undefined);
  await settleBindingsBounded(turn.run, chatId);
  const providerSession = turn.run.storedSessionId();
  // On this transport the answer is a STRUCTURAL 404: the run id comes from
  // `/api/sessions/{id}/chat/stream`, which registers it in neither map
  // `_handle_stop_run` consults. The call is still made rather than short-circuited —
  // the verdict is measured, so it stays correct if upstream ever registers those ids,
  // and a bridge that assumed the answer would be a bridge that lies again.
  const interrupt: HermesInterruptVerdict = runId
    ? await hermesClientFor(cfg).stopRun(runId)
    : // Nothing to name, so nothing was asked — while the prompt WAS accepted, so a run
      // may be live. Proven no-op, not an unknown.
      "ineffective";
  if (interrupt !== "interrupted") {
    console.error(
      `[hermes-abort] stop did not take effect (${interrupt}) chat=${chatId} — ` +
        `dropping the provider session: the run may still be writing to it`,
    );
  }
  forgetSessionIfUnhonoured(registry, chatId, interrupt);
  return { aborted: true, interrupt, providerSession };
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

/** Agent-files ops on the Hermes managed-files API. The allowlisted identity
 *  files (SOUL.md, AGENTS.md, …) live at the agent home root — list surfaces
 *  the ones present (with mtime as updatedAtMs, the CAS base), get reads the
 *  decoded content, set enforces compare-and-set against the current mtime
 *  then uploads. Same response contract as the OpenClaw op so Convex/UI are
 *  untouched. */
/** Hermes scheduled jobs via the WS RPC `cron.manage {action:"list"}`
 *  (tui_gateway). Normalized to the provider-neutral /cron-list summaries;
 *  agentId stays null — a Hermes instance has a single agent, so every job
 *  belongs to it. Defensive field mapping: the cronjob tool's JSON is not a
 *  pinned contract, unknown fields simply yield nulls. */
export async function performHermesCronList(
  cfg: BridgeConfig,
  registry: HermesTurnRegistry,
): Promise<
  {
    id: string | null;
    name: string | null;
    enabled: boolean | null;
    schedule: string | null;
    nextRunAtMs: number | null;
    lastRunStatus: string | null;
    agentId: string | null;
  }[]
> {
  const client = registry.wsClientFor(cfg);
  const payload = (await client.call("cron.manage", { action: "list" })) as
    | Record<string, unknown>
    | unknown[]
    | undefined;
  const rawList = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as Record<string, unknown> | undefined)?.jobs)
      ? ((payload as Record<string, unknown>).jobs as unknown[])
      : Array.isArray((payload as Record<string, unknown> | undefined)?.result)
        ? ((payload as Record<string, unknown>).result as unknown[])
        : [];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v ? v : null;
  // ISO-8601 → epoch ms (Hermes stamps next_run_at/last_run_at as ISO strings).
  const iso = (v: unknown): number | null => {
    if (typeof v !== "string" || !v) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  };
  return rawList
    .filter((j): j is Record<string, unknown> => typeof j === "object" && j !== null)
    .map((j) => {
      // Hermes 0.18 jobs carry `schedule` as an OBJECT {kind, expr|at, display}
      // plus a flat `schedule_display` — read the structured form too, or every
      // job renders a bare "—" in the tab.
      const sched = j.schedule;
      const schedObj =
        typeof sched === "object" && sched !== null
          ? (sched as Record<string, unknown>)
          : {};
      return {
        id: str(j.id) ?? str(j.job_id) ?? str(j.name),
        name: str(j.name),
        enabled:
          typeof j.enabled === "boolean"
            ? j.enabled
            : typeof j.paused === "boolean"
              ? !j.paused
              : null,
        schedule:
          str(sched) ??
          str(j.schedule_display) ??
          str(schedObj.display) ??
          str(schedObj.expr) ??
          str(schedObj.at) ??
          str(schedObj.kind) ??
          str(j.cron) ??
          str(j.when),
        nextRunAtMs:
          num(j.next_run_at_ms) ??
          num(j.nextRunAtMs) ??
          iso(j.next_run_at) ??
          iso(j.next_run),
        lastRunStatus: str(j.last_run_status) ?? str(j.last_status),
        agentId: null,
      };
    });
}

/** Hermes cron management via `cron.manage` — the 0.18 surface only supports
 *  remove + pause/resume (by job name); no update/run-now/history. Returns a
 *  discriminated result so the endpoint maps unsupported ops to a clean 501
 *  instead of a fake success. */
export async function performHermesCronManage(
  cfg: BridgeConfig,
  registry: HermesTurnRegistry,
  body: { op: string; jobId: string; patch?: { enabled?: boolean } },
): Promise<{ ok: true } | { ok: false; code: "unsupported" | "gateway_error"; message?: string }> {
  const client = registry.wsClientFor(cfg);
  const call = async (action: string): Promise<{ ok: true }> => {
    // Contract pinned against tui_gateway 0.18.2: the RPC param is CALLED
    // `name` but CARRIES the opaque job id — the server does
    // `params.get("name")` and passes it straight to cronjob(job_id=...),
    // whose remove/pause/resume resolve by id. Send the verified id here.
    await client.call("cron.manage", { action, name: body.jobId });
    return { ok: true };
  };
  try {
    switch (body.op) {
      case "remove":
        return await call("remove");
      case "update": {
        // Only the enabled flip maps onto pause/resume; any other field is
        // beyond the Hermes surface (fail closed, never a partial apply).
        const patch = body.patch ?? {};
        const keys = Object.keys(patch);
        if (keys.length === 1 && typeof patch.enabled === "boolean") {
          return await call(patch.enabled ? "resume" : "pause");
        }
        return { ok: false, code: "unsupported" };
      }
      default:
        return { ok: false, code: "unsupported" };
    }
  } catch (err) {
    return {
      ok: false,
      code: "gateway_error",
      message: (err as Error)?.message ?? String(err),
    };
  }
}

export async function performHermesAgentFilesOp(
  cfg: BridgeConfig,
  registry: HermesTurnRegistry,
  body:
    | { op: "list"; agentId: string }
    | { op: "get"; agentId: string; name: string }
    | {
        op: "set";
        agentId: string;
        name: string;
        content: string;
        baseUpdatedAtMs: number | null;
      },
  allowedNames: readonly string[],
): Promise<{ status: number; body: unknown }> {
  const fetcher = registry.filesFetcherFor(cfg);
  const root = await fetcher.agentFilesRoot();
  // STRICT list: an admin op must surface a gateway failure as a retryable
  // error (502), never as an empty tab or a phantom CAS conflict (codex P2).
  const entries = await fetcher.listFilesStrict(root);
  const byName = new Map(entries.map((e) => [e.name, e]));
  // Response shapes REPLICATE the OpenClaw op exactly (conf.ts fileMeta /
  // CONFLICT / before.content) — Convex parses `data.file` and the editor's
  // CAS reads `currentUpdatedAtMs`; any drift here breaks the tab silently.
  const meta = (name: string, missing: boolean) => ({
    name,
    missing,
    size: byName.get(name)?.size ?? null,
    updatedAtMs: byName.get(name)?.mtime ?? null,
  });
  if (body.op === "list") {
    // EVERY allowlisted name, present or not — a `missing` row is how the UI
    // offers to CREATE a file that does not exist yet (same as OpenClaw).
    return {
      status: 200,
      body: {
        ok: true,
        files: allowedNames.map((n) => meta(n, !byName.has(n))),
      },
    };
  }
  if (body.op === "get") {
    const f = await fetcher.readAgentFile(body.name);
    // A file we could not READ must not be offered as an empty one to edit.
    //
    // An undecodable 200 used to arrive here as `{content: "", missing: false}`, so the
    // editor opened a blank document over a file that exists — and saving it, with the
    // current mtime satisfying the compare-and-set, overwrote real content with nothing.
    // The same contract the write path relies on has to hold on the read.
    if (!f.missing && !f.decoded) {
      return {
        status: 502,
        body: {
          ok: false,
          error: {
            code: "UNREADABLE",
            message:
              "the file exists but its contents could not be read — refusing to " +
              "present it as empty",
          },
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        file: { ...meta(body.name, f.missing), content: f.content },
      },
    };
  }
  // set — compare-and-set on the file's mtime (null base = create-only).
  const beforeRead = await fetcher.readAgentFile(body.name);
  // A file that EXISTS but cannot be read is not safely writable either.
  //
  // The `get` refusal alone was not enough: an admin action can call the write directly
  // with an `updatedAtMs` obtained from `list`, never having read the file. The
  // compare-and-set would pass on a matching mtime, the real content would be
  // overwritten, and the response would report `before: ""` — a revision claiming the
  // file was empty before a write that destroyed it. A create (missing file) is
  // untouched: there is nothing to read and nothing to lose.
  if (!beforeRead.missing && !beforeRead.decoded) {
    return {
      status: 502,
      body: {
        ok: false,
        error: {
          code: "UNREADABLE",
          message:
            "the file exists but its current contents could not be read — refusing " +
            "to overwrite it blind",
        },
      },
    };
  }
  const currentMs = byName.get(body.name)?.mtime ?? null;
  const conflict = (): { status: number; body: unknown } => ({
    status: 409,
    body: {
      ok: false,
      error: { code: "CONFLICT", currentUpdatedAtMs: currentMs },
    },
  });
  if (body.baseUpdatedAtMs !== null && currentMs !== null) {
    // Allow small fs-timestamp jitter (<1s) between list and the stored base.
    if (Math.abs(currentMs - body.baseUpdatedAtMs) > 1_000) return conflict();
  } else if (body.baseUpdatedAtMs === null && currentMs !== null) {
    return conflict();
  } else if (body.baseUpdatedAtMs !== null && currentMs === null) {
    // EDIT of a file that no longer exists — surface the conflict, never a
    // silent create-over-delete.
    return conflict();
  }
  await fetcher.writeAgentFile(body.name, body.content);
  // Report what the FILESYSTEM now holds, in the same vocabulary as the OpenClaw
  // path — `confirmed.content` plus an honest `missing`.
  //
  // This used to answer `missing: false` unconditionally and send no confirmation at
  // all, so an acknowledged write that never landed read as success on the Convex side
  // (`writeLanded` has nothing to contradict) — the editor showed "saved" and an
  // approved curation purged its proposal. A guarantee that holds for one provider and
  // not the other is not a guarantee: every feature here is built for BOTH.
  const after = await fetcher.listFilesStrict(root);
  const afterEntry = after.find((e) => e.name === body.name);
  const afterRead = await fetcher.readAgentFile(body.name);
  return {
    status: 200,
    body: {
      ok: true,
      file: {
        name: body.name,
        missing: afterEntry === undefined || afterRead.missing,
        size: afterEntry?.size ?? null,
        updatedAtMs: afterEntry?.mtime ?? null,
      },
      before: { content: beforeRead.missing ? null : beforeRead.content },
      // A confirmation ONLY when the read-back actually decoded. A malformed 200 used
      // to arrive as `content: ""`, indistinguishable from an empty file — so a write of
      // "" confirmed itself against a response that carried nothing. `null` here means
      // unverifiable, which the Convex side treats as "not evidence of failure" rather
      // than as a match.
      confirmed: {
        content: afterRead.missing || !afterRead.decoded ? null : afterRead.content,
      },
    },
  };
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
  /** TRUE when this discovery actually got an answer about the version — so a refused or
   *  absent version is a decision and not just a gap. See the REST branch. */
  versionObserved: boolean;
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
    // CURRENT provider/model. `hermes serve` has no /health, so the version cannot be
    // asked for here — it is OBSERVED, from the `session.info` event of a turn, and read
    // back from the registry. A bridge that has not run a turn yet therefore reports
    // `null`, which is the honest answer and not the hard-coded one it used to be (G-55).
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
      // Read back from the registry, which the TURNS populate: on this transport the
      // version arrives on `session.info`, never on a discovery RPC.
      gatewayVersion: registry.gatewayVersionFor(cfg.instanceName ?? ""),
      versionObserved: registry.observedVersionFor(cfg.instanceName ?? "").seen,
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
    // The SAME scheme rule the WS reader applies. `/health` is a second door onto the same
    // manifest, and it used to be the lax one: a `/health` reporting the calendar tag
    // (`2026.7.20`, the tag of 0.19.0) went straight through to the compat surface and its
    // banner (raised in review).
    gatewayVersion: readHermesGatewayVersion(health?.version, "health"),
    // Did this poll get an ANSWER about the version? A reachable `/health` that reports a
    // version we refuse is an observation and must retire what was believed; a `/health`
    // that never answered is not, and must leave it alone. Without the distinction, a
    // gateway that came back at an unreadable version kept its old entry in the server's
    // cache — which the poll then declined to refresh, because it already had one (raised
    // in review).
    versionObserved: health !== null,
  };
}
