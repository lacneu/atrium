// Per-session lifecycle: one OpenClaw connection + one RunManager + the inbound
// frame-consumer loop that drives the normalizer's receive-loop timing.
//
// A "session" maps a Convex chat (chatId) to an OpenClaw session key and the
// persistent operator WebSocket that serves it. The registry lazily creates a
// session on first send and reuses it for subsequent turns on the same chat.
//
// The consumer loop mirrors backend/app/main.py `_openclaw_to_browser`: a single
// pending `frames()` read across iterations so a frame dequeued exactly when the
// timeout fires is never dropped; on timeout we `tick()` the normalizer so an
// armed grace always finalizes (never a hung "thinking" UI).

import {
  gatewayAtLeast,
  openClawAgentRequestsEnabled,
  openClawInlineWidgetsEnabled,
  SESSION_EVENTS_SINCE,
} from "./compat.js";
import { INLINE_WIDGETS_CAP } from "./providers/openclaw/widgets.js";
import {
  holdGatewayVersion,
  trustedGatewayVersion,
} from "./providers/openclaw/gateway-version-hint.js";
import {
  connectUserHeader,
  humanConnectIdentity,
  systemConnectIdentity,
} from "./providers/openclaw/connect-identity.js";
import { TALK_CALL_HOLD_MS } from "./core/talk-relay.js";
import { presentedIdentity } from "./providers/openclaw/gateway-identity.js";
import { OpenClawConnection } from "./providers/openclaw/openclaw-client.js";
import { RunManager } from "./providers/openclaw/run-manager.js";
import { SubAgentObserver } from "./providers/openclaw/sub-agent-observer.js";
import { ChildRowStatus } from "./providers/openclaw/child-row-status.js";
import type { ConvexWriter, SubAgentRecord } from "./convex-writer.js";
import { attachRosterPolicy, attachSharingRefresh } from "./providers/openclaw/models-roster.js";
import type { OutboundScan } from "./core/turn-sink.js";
import { gatewayHostOf } from "./core/health.js";
import { deviceTokenPromotion } from "./core/device-token-promotion.js";
import type { BridgeConfig } from "./config.js";
import { mediaIdentityHeaders, type MediaFetcherProvider } from "./core/media-fetcher-provider.js";
import { ArtifactCopier } from "./core/artifact-copier.js";
import type { MediaFetcher } from "./core/media-fetcher.js";
import { requestArtifactDownload, type ArtifactRequester } from "./providers/openclaw/artifact-download.js";
import { buildSessionKey } from "./providers/openclaw/session-keys.js";
import { protocolDrift } from "./providers/openclaw/protocol-drift.js";
import type { FinalizeCause } from "./core/finalize-causes.js";
import { OpenClawAgentRequestObserver } from "./providers/openclaw/agent-request-observer.js";
import {
  FULL_MESSAGE_MAX_CHARS,
  TranscriptShadow,
  type SessionEventSource,
  type TranscriptShadowDeps,
} from "./providers/openclaw/transcript-shadow.js";
import {
  SESSION_SCOPED_EVENTS_CAP,
  SessionEventsHub,
} from "./providers/openclaw/session-events.js";
import {
  CHAT_HISTORY_PAGE_LIMIT,
  CHAT_HISTORY_PAGE_MAX_BYTES,
  chatHistoryParams,
} from "./core/rpc-params.js";
import { errForLog } from "./core/log-safe-error.js";

// Stable errorCode for a bridge-side infrastructure end (socket drop / crash
// mid-turn): the UI maps it to "connection lost — retry", never the user
// "Interrompu". Distinct from the user Stop (Convex-set "aborted").
const CONNECTION_LOST_CODE: FinalizeCause = "connection_lost";
// The gateway ANNOUNCED its own restart (`event:"shutdown"`) before the socket
// went away: a KNOWN maintenance window, not a mystery. Distinct from
// connection_lost because the honest message differs ("it is coming back", and
// often when) and because a restart RESUMES the run gateway-side.
const GATEWAY_RESTARTING_CODE: FinalizeCause = "gateway_restarting";
// The gateway hung up with `1008 "slow consumer"`: our receive buffer passed its
// ceiling, so it had already been DROPPING frames before cutting us off. Distinct
// from a network blip — the reply was provably incomplete, and the remedy is on
// our side, not the user's.
const CONNECTION_SATURATED_CODE: FinalizeCause = "connection_saturated";

/**
 * Everything needed to serve ONE instance: its full per-instance config (gateway
 * URL + creds + media dirs), its Convex writer (with that instance's media fetcher
 * baked in), its hot media provider and its deterministic outbound scan. One bridge
 * holds a Map<instanceName, InstanceBundle> (one bridge, N gateways) — keeping the
 * per-instance-ness in the bundle leaves Session/RunManager/writer unchanged.
 */
export interface InstanceBundle {
  config: BridgeConfig;
  writer: ConvexWriter;
  mediaProvider: MediaFetcherProvider;
  outboundScan?: OutboundScan;
}

/** What the transcript file copier needs of the instance (projection `on`, final design
 *  step 2): its gateway's HTTP origin, the identity a media request presents, and the
 *  current media fetcher and cap (hot). */
export interface ArtifactCopyEnv {
  httpBase: () => string;
  identityHeaders: () => Record<string, string>;
  mediaFetcher: () => MediaFetcher | undefined;
  maxBytes: () => number;
}

/** A copier reading through `conn` (a conversation socket, or the resume route's short
 *  operator connection) — null when the writer cannot report copies (an older fake). */
export function buildArtifactCopier(
  env: ArtifactCopyEnv,
  writer: ConvexWriter,
  conn: ArtifactRequester,
): ArtifactCopier | null {
  if (
    writer.transcriptFileUpload === undefined ||
    writer.transcriptFileCopied === undefined ||
    writer.transcriptFileFailed === undefined
  ) {
    return null;
  }
  return new ArtifactCopier({
    download: (key, artifactId) => requestArtifactDownload(conn, key, artifactId),
    httpBase: env.httpBase,
    identityHeaders: env.identityHeaders,
    mediaFetcher: env.mediaFetcher,
    maxBytes: env.maxBytes,
    upload: writer.transcriptFileUpload.bind(writer),
    copied: writer.transcriptFileCopied.bind(writer),
    failed: writer.transcriptFileFailed.bind(writer),
  });
}

/** The copy environment of one served instance. */
export function artifactCopyEnvOf(bundle: InstanceBundle): ArtifactCopyEnv {
  return {
    httpBase: () => bundle.config.gatewayHttpBase,
    identityHeaders: () => mediaIdentityHeaders(bundle.config),
    // The gateway's media route ONLY, never a local mount (MediaFetcherProvider.mediaRoute).
    mediaFetcher: () => bundle.mediaProvider.mediaRoute(),
    maxBytes: () => bundle.mediaProvider.currentMaxBytes(),
  };
}

/** The bridge's clock, in SECONDS (matches the normalizer's time unit).
 *
 *  NOT monotonic: the default reads the WALL clock, so an NTP correction can
 *  move it backwards. Everything that only measures elapsed time tolerates
 *  that; the one consumer that ORDERS by it — the plan stamp
 *  (convex/lib/planOrder.ts) — states the inversion as a limit rather than
 *  claiming a guarantee this does not give. */
export type Clock = () => number;

/** Exported so the unit (seconds, not milliseconds) can be pinned by a test:
 *  a stamp written in milliseconds would outrank every real one forever. */
export const defaultClock: Clock = () => Date.now() / 1000;

/**
 * Per-turn routing the registry needs to build the gateway session key. `agentId`
 * and `canonical` are routed FROM THE REQUEST BODY (Convex resolves the discovered
 * agent + the per-user canonical) — never a static bridge env. This is the fix for
 * the "Agent <env-id> no longer exists" production bug.
 */
export interface SessionRouting {
  chatId: string;
  openclawChatId: string | null;
  agentId: string;
  canonical: string;
  /** What the gateway is told to call this person, when the instance names people
   *  differently from the routing key. Absent ⇒ the canonical — which is what every
   *  instance sent before `instances.identitySource` existed. NEVER used to build
   *  the session key: that stays on `canonical`, so changing how people are named
   *  cannot move a conversation's gateway session. */
  gatewayUser?: string;
  /** Which served instance this turn routes to (selects the gateway + creds). The
   *  server always sets it (from the guarded body); when omitted, a bridge serving a
   *  SINGLE instance falls back to that one. */
  instanceName?: string;
  /** Whether this conversation WANTS inline widgets (the instance switch AND the
   *  conversation override, decided by Convex per send). `undefined` ⇒ this route does
   *  not know and does not care (patch, reset, abort, …): it never re-opens a socket.
   *  The socket declares `inline-widgets` only when wanted AND the gateway version
   *  supports it (compat.ts `inlineWidgets`). */
  inlineWidgets?: boolean;
  /** The conversation's widget wish for a route that does NOT re-key on it (patch,
   *  reset, compact, knowledge, permission mode, sub-agent interaction): used ONLY if
   *  this acquire has to CREATE the socket, so a socket born from a session operation
   *  declares what the next turn wants instead of nothing. Ignored when
   *  `inlineWidgets` is given. When neither is, creation inherits the wish of the
   *  chat's previous socket (closed or re-keyed), and only then falls back to off. */
  widgetsAtCreate?: boolean;
}

export interface BridgeSession {
  readonly chatId: string;
  readonly sessionKey: string;
  /** The SHADOW transcript reconciler of this conversation session (redesign phase 1):
   *  reads `chat.history` back at the Control UI's triggers, never touches a bubble.
   *  Optional so test doubles that predate it keep compiling. */
  readonly transcriptShadow?: TranscriptShadow;
  /** The served instance (gateway) this session is bound to (one bridge, N gateways). */
  readonly instanceName: string;
  readonly connection: OpenClawConnection;
  readonly runManager: RunManager;
  readonly clock: Clock;
  /** The widget wish this socket was opened for (SessionRouting.inlineWidgets). */
  readonly widgetsWanted: boolean;
  /** TRUE until this bridge has run its first turn on this session (set false by
   *  performSend after the first send). A session is created fresh on an agent
   *  SWITCH (the epoch re-keys → a NEW sessionKey → acquire() builds a new Session),
   *  so `firstSendPending` is the bridge's OWN "never sent a turn on this key" signal
   *  — independent of the gateway's `systemSent`, which it reports truthy for a
   *  freshly-created webchat session (so it cannot tell a brand-new cross-agent
   *  session from a warm one). Rehydration uses it to re-ground a switched agent. */
  firstSendPending: boolean;
  /** The gateway `sessionId` for which the pre-send guard observed a STRUCTURAL
   *  compaction refusal (no transcript, an unsupported harness, a deferred
   *  compaction that is not scheduled). Null when none. While it matches the live
   *  sessionId, the guard SKIPS the compaction RPC instead of spending 60 s on a
   *  call already known not to work — the user gets the named cause and the two
   *  wired actions immediately. A transient refusal ("already active") is NOT
   *  remembered: it says only "not right now". */
  presendCompactRefusedFor: string | null;
  /** Keep this conversation's socket OPEN while a gateway-owned voice call rides on
   *  it. On a GPT Live call the gateway binds the call to the connection that created
   *  it and closes the call when that connection closes (upstream
   *  `client-gateway-control.ts`, `registerTalkConnectionCleanup`) — so the idle
   *  sweeper must not reap this session mid-call. Bounded: the gateway's own call TTL. */
  holdForVoiceCall(voiceSessionId: string, holdMs: number): void;
  /** Lengthen an EXISTING hold (the offer was spent: the call is allocated and its
   *  TTL starts now). Returns false — and holds nothing — when no hold exists for
   *  that call any more: a hangup that raced the offer's HTTP round trip already
   *  released it, and re-arming would pin the socket for a call the gateway has
   *  closed (codex P2, pass 3). */
  extendVoiceCall(voiceSessionId: string, holdMs: number): boolean;
  /** Extend every live hold on this socket — see the implementation. */
  extendLiveVoiceCalls(holdMs: number): number;
  /** Is a gateway-owned voice call possibly live on this socket at `now`? */
  holdsVoiceCall(now: number): boolean;
  /** THAT call ended (hangup, or the gateway closed it). The gateway allows two calls
   *  per owning socket, so releasing one must not release the other (codex P1). */
  releaseVoiceCall(voiceSessionId: string): void;
  /** How many voice holds are LIVE right now (expired ones do not count).
   *  Read-only: the rekey guard reads the map itself, this exists so the hold can
   *  be OBSERVED — by diagnostics, and by the tests that pin when it is taken
   *  relative to the RPCs it must cover. */
  liveVoiceCallCount(): number;
  /** Prod the inbound consume loop to re-evaluate its next deadline. MUST be
   *  called after `runManager.beginTurn` (which arms the recv/grace deadline from
   *  OUTSIDE the loop) so a loop blocked on a null-timeout frame wait does not
   *  hang the turn forever in "streaming". */
  wake(): void;
  /** Test/diagnostic seam: count of children with an ordered registration recorded
   *  (registeredChildren). Asserts the set never leaks across terminated/swept children. */
  readonly registeredChildCount: number;
  /** Phase 2c: arm the sub-agent observer to capture the reply to a user INTERACTION
   *  before the /subagent-send endpoint dispatches the chat.send to the child. */
  armSubAgentInteraction(childKey: string, interactionId: string): void;
  /** Undo that arming for a send refused for certain (see SubAgentObserver). */
  disarmSubAgentInteraction(childKey: string, interactionId: string): void;
  /** Record the outbound mount `/send` just instructed the agent to use, so a
   *  delegated child's `MEDIA:` directive is recognised on a custom mount. */
  noteOutboundMount(dir: string | null): void;

}

/**
 * A live session's non-secret routed identity + the gateway version its
 * connection captured at handshake. Consumed by `/health` and `/capabilities`
 * (compat manifest targets). Deliberately excludes chatId/sessionKey: both
 * endpoints are unauthenticated, so only the bounded operator identity leaks.
 */
export interface LiveTarget {
  canonical: string;
  agentId: string;
  /** Which served instance (gateway) this session belongs to (one bridge, N gateways). */
  instanceName: string;
  gatewayVersion: string | null;
  /** Gateway WS frame limit (policy.maxPayload) from this session's handshake —
   *  the authoritative inbound-attachment ceiling, surfaced for /health. */
  maxPayload: number | null;
}

class Session implements BridgeSession {
  /** See BridgeSession.widgetsWanted — set once by the registry after the handshake. */
  widgetsWanted = false;
  readonly chatId: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly canonical: string;
  readonly instanceName: string;
  readonly connection: OpenClawConnection;
  readonly runManager: RunManager;
  // PERSISTENT, chat-level observation of sub-agents this chat's agent spawns
  // (sessions_spawn). INBOUND-ONLY: it reads child frames off the same connection
  // and upserts their status to Convex; it NEVER influences what the bridge sends.
  // Decoupled from the parent-turn lifecycle so a child frame arriving AFTER the
  // parent turn finalized still records (the whole reason the monitor exists).
  readonly observer: SubAgentObserver;
  /** The children's STATUS, read from their gateway session rows (0.101.4,
   *  providers/openclaw/child-row-status.ts) — every projection mode. Null when the
   *  writer cannot record a row. Lives exactly as long as this socket. */
  readonly childRows: ChildRowStatus | null;
  /** See BridgeSession.transcriptShadow. */
  readonly transcriptShadow: TranscriptShadow;
  /** PROJECTION `on` (final design step 2): copies the files this session's transcript
   *  rows carry, once, by artifact id. Absent when the instance gave no copy environment. */
  readonly artifactCopier: ArtifactCopier | null;
  /** What the agent ASKS the person on this session (questions, approvals) — see
   *  providers/openclaw/agent-request-observer.ts. Inbound-only, like the sub-agent
   *  observer; its one effect on the turn is to say that a human now holds it. */
  private readonly agentRequests: OpenClawAgentRequestObserver;
  // Child session keys whose INITIAL running-row creation we have already ordered
  // (awaited). Lets flushSubAgentObserved await ONLY the first `running` upsert per
  // child (its spawn registration) and fire every later status/heartbeat off the
  // loop's critical path. Cleared with the observer on connection close.
  private readonly registeredChildren = new Set<string>();
  private readonly writer: ConvexWriter;
  readonly clock: Clock;
  // Last time this session saw work (a send via acquire, or an inbound frame), on
  // the SECONDS Clock. The registry's idle sweeper reaps a session — closing its
  // WebSocket/FD — once this is older than IDLE_SESSION_TTL_SECONDS, so idle sockets
  // don't accumulate to FD exhaustion (the next send transparently reconnects).
  lastActivityAt: number;
  // Per voice call the gateway bound to THIS socket: until which instant (SECONDS
  // clock) it may still be live, and the CEILING past which no extension may push it.
  // The sweeper treats the session as busy while any entry is in the future. Keyed by
  // voiceSessionId because the gateway allows two calls per owning socket — one
  // timestamp would let the first hangup release the second call's hold (codex P1,
  // 2026-09-19). The ceiling exists because the gateway arms a call's TTL at
  // ALLOCATION: every hold for one call dies at the same absolute instant however
  // often it is extended (codex P2, pass 13).
  private readonly voiceCallsUntil = new Map<
    string,
    { until: number; ceiling: number }
  >();
  // See BridgeSession.firstSendPending. True until performSend runs the first turn.
  firstSendPending = true;
  // See BridgeSession.presendCompactRefusedFor.
  presendCompactRefusedFor: string | null = null;
  private consumerStarted = false;
  // Wake seam for the consume loop (see consume() + wake()): lets beginTurn,
  // which runs OFF this loop and arms the recv/grace deadline, prod the loop to
  // re-evaluate. `wakeConsumer` resolves the loop's in-flight race; `wakePending`
  // captures a wake that lands while the loop is NOT in its race (resolver null),
  // making liveness independent of interleaving.
  private wakeConsumer: (() => void) | null = null;
  private wakePending = false;

  constructor(
    chatId: string,
    sessionKey: string,
    routing: {
      agentId: string;
      canonical: string;
      instanceName: string;
      /** What Convex has STORED as this chat's provider session, when it has one. */
      openclawChatId?: string | null;
    },
    connection: OpenClawConnection,
    writer: ConvexWriter,
    clock: Clock,
    outboundScan?: OutboundScan,
    // Health-stats hook: a turn of THIS session finalizing in error is a
    // downstream failure on its target (HealthRegistry.recordTurnError).
    onTurnError?: (code: string) => void,
    // The instance's session-events connection (transcript redesign, phase 2): what
    // feeds this session's reconciler with `session.message` / `sessions.changed`.
    // Never this conversation's socket (session-events.ts).
    sessionEvents?: SessionEventSource,
    // PROJECTION `on` (final design step 2): what the transcript file copier needs.
    artifactCopy?: ArtifactCopyEnv,
  ) {
    this.chatId = chatId;
    this.sessionKey = sessionKey;
    this.agentId = routing.agentId;
    this.canonical = routing.canonical;
    this.instanceName = routing.instanceName;
    this.connection = connection;
    this.runManager = new RunManager(
      chatId,
      sessionKey,
      writer,
      outboundScan,
      onTurnError,
      // What Convex has STORED for this chat. A terminal `session_gone` names it so the
      // clear can be matched exactly rather than dropping whatever is bound.
      routing.openclawChatId ?? null,
    );
    // The connection's negotiated version, read at trace time (a reconnect may change it).
    this.runManager.setGatewayVersionSource(() => this.connection.gatewayVersion);
    // FRAME-LOSS reporting (see providers/openclaw/frame-seq.ts). The gateway
    // drops frames destined for this socket when its outbound buffer is full,
    // advancing the envelope `seq` as it does — the hole is the only trace.
    // Recorded at CONNECTION (= chat) level, deliberately NOT charged to the
    // turn in flight (codex P2): the envelope seq names neither session nor run,
    // and this same socket also carries SUB-AGENT frames — so blaming the active
    // reply would fabricate a "this answer is truncated" diagnostic. The
    // gateway's OWN `seq gap` report does name its run and IS charged to the turn
    // (normalizer -> sink). Fire-and-forget: a diagnostic never delays a turn.
    // The model roster follows the gateway's config WITHOUT a turn: the roster policy
    // (models-roster.ts) turns the connection's `config.changed` into an invalidation
    // and a refresh that pushes the roster to Convex; a frame gap moves the epoch in the
    // transport itself. Same hop as the frame-gap report; a refresh never delays a turn.
    attachRosterPolicy(this, writer); // disposes itself on the connection's close
    // Same hop for the session's VISIBILITY: a `session.sharing` notice for this key
    // re-describes and publishes (models-roster.ts attachSharingRefresh).
    attachSharingRefresh(this, writer);
    // A loss on a participant's speaker socket carrying a run of this chat arrives
    // here too (speaker-pool.ts), named by its source; an end mid-run is uncounted.
    connection.onFrameGap = (gap) => {
      const counted = gap.carriedBy !== "speaker_closed";
      void writer.noteFrameGap?.(chatId, {
        source: gap.carriedBy ?? "envelope",
        expected: counted ? gap.expected : null,
        received: counted ? gap.received : null,
        missing: counted ? gap.missing : null,
      });
    };
    this.writer = writer;
    this.observer = new SubAgentObserver(sessionKey, chatId, {
      // Read at the moment a child settles, not captured here: `/send` carries
      // the instance's CURRENT outbound mount per turn and an admin may change
      // it while this session lives.
      outboundAgentMount: () => this.outboundAgentMount,
    });
    const writeRow = writer.applySubAgentRowStatus?.bind(writer);
    this.childRows =
      writeRow === undefined
        ? null
        : new ChildRowStatus({
            chatId,
            parentSessionKey: sessionKey,
            gateway: connection,
            write: writeRow,
            ...(writer.missingSubAgentRows === undefined
              ? {}
              : {
                  missing: (parentKey: string, presentKeys: string[]) =>
                    writer.missingSubAgentRows!(chatId, parentKey, presentKeys),
                }),
            ...(sessionEvents === undefined ? {} : { events: sessionEvents }),
          });
    this.agentRequests = new OpenClawAgentRequestObserver({
      chatId,
      sessionKey,
      agentId: routing.agentId,
      gateway: connection,
      upsert: writer.upsertAgentRequest?.bind(writer),
      settle: writer.settleAgentRequest?.bind(writer),
      currentMessageId: () =>
        this.runManager.turnActive ? this.runManager.currentMessageId : null,
      noteQuestion: (id, expiresInSec) =>
        this.runManager.noteHumanQuestion(id, expiresInSec, this.clock()),
      noteQuestionSettled: (id) =>
        this.runManager.noteHumanQuestionSettled(id, this.clock()),
      noteApprovalSettled: (id) =>
        this.runManager.noteApprovalSettled(id, this.clock()),
      wake: () => this.wake(),
      nowMs: () => Date.now(),
    });
    this.clock = clock;
    this.lastActivityAt = clock();
    // The copier reads through THIS conversation's socket — the Control UI asks
    // `artifacts.download` on the socket that shows the session (final design §3.5).
    this.artifactCopier =
      artifactCopy === undefined ? null : buildArtifactCopier(artifactCopy, writer, connection);
    const copier = this.artifactCopier;
    // SHADOW transcript reconciler: off until a /send carries the instance switch.
    this.transcriptShadow = new TranscriptShadow({
      chatId,
      sessionKey,
      instanceName: this.instanceName,
      ...transcriptReaders(connection, sessionKey),
      // Convex's ANSWER is the reconciler's input (the runs it found over, a refusal to
      // split): it was dropped here, so no settled run ever reached the turn (codex phase 4
      // pass 6 review).
      apply: async (report) => (await writer.applyTranscript?.(report)) ?? undefined,
      ...(sessionEvents === undefined ? {} : { events: sessionEvents }),
      // READ-ONLY view of the turn: the run in the foreground, for CU-16's admission.
      foregroundRunId: () =>
        this.runManager.turnActive ? (this.runManager.activeRunIds[0] ?? null) : null,
      foregroundRunIds: () => (this.runManager.turnActive ? this.runManager.activeRunIds : []),
      // The live overlay's transcript facts (phase 3).
      onUserRow: (row) => {
        void this.runManager.onUserRow(row).catch((e) =>
          console.error("[send] steer split failed (non-fatal):", errForLog(e)),
        );
      },
      onInputDropped: (sendId) => this.runManager.noteInputDropped(sendId),
      // PROJECTION `on` (final design step 2): the files Convex has no copy of yet. Called
      // only in `on` (TranscriptShadow.emitFiles).
      ...(copier === null ? {} : { copyFiles: (files) => copier.enqueue(files) }),
      // PROJECTION `on` (phase 4): the transcript proved runs over — a foreground turn
      // among them ends here (never on a timer).
      onRunsSettled: (runIds) => {
        void this.runManager
          .settleFromTranscript(runIds, this.clock())
          .then((ended) => {
            if (ended) {
              console.log(`[transcript] chat=${this.chatId} turn settled by the transcript`);
              this.wake();
            }
          })
          .catch((e) =>
            console.error("[transcript] settle failed (non-fatal):", errForLog(e)),
          );
      },
    });
    // The reconciler lives exactly as long as this socket, whichever path closes it (the
    // consume loop's end, a crash recovery, the reaper, a re-key): otherwise its
    // session-events attachment would keep it — and reads on a dead socket — alive.
    if (typeof connection.onClosed === "function") {
      connection.onClosed(() => {
        this.transcriptShadow.close();
        this.childRows?.close();
        copier?.close();
        // THE RECONNECTION HYDRATION (0.102.1, Codex pass 4): EVERY close of this
        // conversation's socket, whatever its cause and whatever this process held about a
        // turn, asks Convex once — the Control UI re-reads the gateway's state at every
        // reconnection instead of deciding from its own. Convex decides from its state
        // (a projected bubble of this chat still streaming is asked of the gateway; none,
        // nothing), and the request is held until acknowledged (convex-writer).
        void writer.resumeStreams?.(chatId);
      });
    }
  }

  /** The outbound mount the AGENT was instructed to write to on the last send.
   *  A child's `MEDIA:` directive names a path under it, and an instance may
   *  override the bridge's own default — matching only the image default left
   *  every such delivery unrecognised on the child lane. */
  private outboundAgentMount: string | null = null;

  /** An approval of this chat was answered from Atrium: release the turn it holds
   *  (see RunManager.noteApprovalSettled). Detached — a label and a deadline. */
  /** Whether this conversation's live socket routed approval `id` here (see the
   *  observer's `routedApproval`). */
  routedApproval(approvalId: string): boolean {
    return this.agentRequests.routedApproval(approvalId);
  }

  noteApprovalAnswered(approvalId: string): void {
    void this.runManager
      .noteApprovalSettled(approvalId, this.clock())
      .then(() => this.wake())
      .catch((err) =>
        console.error(
          `[agent-request] approval release failed chat=${this.chatId}:`,
          errForLog(err),
        ),
      );
  }

  /** Record the mount `/send` just instructed the agent to use. */
  noteOutboundMount(dir: string | null): void {
    this.outboundAgentMount = dir;
  }

  /** Test/diagnostic seam (mirrors observer.size): how many children currently hold an
   *  ORDERED registration in registeredChildren. Lets a test assert the set never leaks
   *  — a child terminalized by a frame OR by the TTL sweep frees its key. */
  get registeredChildCount(): number {
    return this.registeredChildren.size;
  }

  /** Phase 2c: arm the sub-agent observer to capture the reply to a user INTERACTION,
   *  called just before the /subagent-send endpoint dispatches the chat.send to the
   *  child (so a re-woken, already-reaped child's terminal is recognized as the
   *  interaction reply and routed to the interaction store). */
  armSubAgentInteraction(childKey: string, interactionId: string): void {
    this.observer.armInteraction(childKey, interactionId, this.clock());
    // Followed again (a child finished long ago, or one a reconnection did not relist).
    this.childRows?.track(childKey);
    // A deadline moved (a resurrected observation's TTL): the consume loop blocks on
    // the one it computed before, so it must re-read it.
    this.wake();
  }

  disarmSubAgentInteraction(childKey: string, interactionId: string): void {
    if (this.observer.disarmInteraction(childKey, interactionId)) this.wake();
  }

  /** Why this socket must not be closed for a mere preference (the widget wish), or
   *  null: a gateway-owned voice call rides it, or it still carries work the bridge
   *  owes a reply for (RunManager.liveWork, a pending sub-agent interaction). */
  /** A sub-agent interaction's reply is still owed on this socket (pending, or in its
   *  recovery grace after a provisional error). */
  subAgentReplyPending(now: number): boolean {
    return this.observer.interactionPending(now);
  }

  busyReason(now: number): string | null {
    if (this.holdsVoiceCall(now)) return "voice call live";
    const work = this.runManager.liveWork;
    if (work !== null) return work;
    if (this.observer.interactionPending(now)) return "sub-agent interaction pending";
    return null;
  }

  /**
   * Flush OBSERVED sub-agent records (from both observe() AND the TTL sweep()),
   * ORDERING the initial running-row creation.
   *
   * The FIRST `running` record for a child (its spawn registration) is AWAITED, so the
   * row commits before the consume loop reads the NEXT frame — e.g. the parent's
   * chat:final, which finalizes the turn and runs the queue drain. That closes the
   * spawn-upsert race (P1.2): by the time the parent reply is shown, the `running` row
   * exists, so a fast follow-up is HELD (isChatBusy) instead of mis-routed into the
   * yielded child. doPost is deadline-bounded, so this await can never wedge the loop.
   *
   * Every LATER record (status changes, the throttled keep-alive heartbeat, terminals)
   * stays OFF the loop's critical path (void + catch) — preserving the fire-and-forget
   * contract so a slow observation write never delays the turn. A terminal record frees
   * the child's key from registeredChildren so the set stays bounded to live children —
   * this is THE cleanup, and the sweep path MUST route through here (not a bare flush)
   * so a TTL-terminalized child's key is freed too.
   */
  private async flushSubAgentObserved(
    records: SubAgentRecord[],
  ): Promise<void> {
    for (const record of records) {
      // Phase 2c: a pure INTERACTION-reply record routes to the interaction store
      // ONLY — never the subAgents row (the original answer stays intact). Off the
      // critical path (best-effort), like the other observation writes.
      if (record.interactionReply) {
        void this.writer
          .recordInteractionReply(record.interactionReply)
          .catch((err) => {
            console.warn(
              `[subagent] interaction reply write failed chat=${this.chatId}:`,
              errForLog(err),
            );
          });
        // The interaction's run ended: the row now states the child's status.
        this.childRows?.runEnded(record.childSessionKey);
        continue;
      }
      // A child's files are in the CHILD's transcript: what the parent shows is what the
      // PARENT's rows carry (copied by identity, core/artifact-copier.ts). Nothing of the
      // child's live frames is attached to the parent's bubble.
      const isRegistration =
        record.status === "running" &&
        !this.registeredChildren.has(record.childSessionKey);
      if (isRegistration) {
        try {
          await this.writer.upsertSubAgent(record);
          this.registeredChildren.add(record.childSessionKey);
          // Its row exists in Convex now: follow the child's session row.
          this.childRows?.track(record.childSessionKey);
        } catch (err) {
          // Best-effort: a failed registration must not break the loop. Leave the
          // child UNREGISTERED so the next frame re-attempts the ordered write.
          console.warn(
            `[subagent] registration upsert failed chat=${this.chatId}:`,
            errForLog(err),
          );
        }
      } else {
        const ended = record.status !== "running";
        if (ended) {
          this.registeredChildren.delete(record.childSessionKey);
        } else {
          this.childRows?.track(record.childSessionKey);
        }
        const childKey = record.childSessionKey;
        void this.writer
          .upsertSubAgent(record)
          .catch((err) => {
            console.warn(
              `[subagent] upsert failed chat=${this.chatId}:`,
              errForLog(err),
            );
          })
          // A run ended on this socket: read the child's row — after this write, so a
          // child first seen terminal already has its Convex row. Only the STATUS comes
          // from the row; the content above keeps its frame source.
          .finally(() => {
            if (ended) this.childRows?.runEnded(childKey);
          });
      }
      // Per-tool DETAIL (args + result) rides on the same tool-frame emission; route
      // it to its OWN table best-effort, off the critical path — it never gates the
      // summary upsert above and a failed detail write must not wedge the loop.
      if (record.toolPart) {
        void this.writer
          .upsertSubAgentToolPart(record.toolPart)
          .catch((err) => {
            console.warn(
              `[subagent] tool-part upsert failed chat=${this.chatId}:`,
              errForLog(err),
            );
          });
      }
    }
  }

  /**
   * Start the single inbound consumer loop for this session's connection.
   * Idempotent. Resolves when the connection closes (frames() terminates).
   */
  startConsumer(): void {
    if (this.consumerStarted) {
      return;
    }
    this.consumerStarted = true;
    // A question asked while no socket of ours was listening would otherwise stay
    // invisible until it expired. Detached: a read, never on the consume path. Only on a
    // gateway where the surface is bench-proven (compat.ts, AGENT_REQUESTS_MIN_VERSION):
    // below it the bridge sends no `question.*` / `approval.*` call at all.
    if (openClawAgentRequestsEnabled(this.connection.gatewayVersion)) {
      void this.agentRequests.replayPending();
    }
    // A new conversation socket inherits nothing: relist this conversation's children
    // from the gateway (detached, a read; it never delays the consume loop).
    void this.childRows?.relistChildren();
    // The consume loop catches its own feed/tick/endTurn errors, but a throw in
    // the loop machinery itself (iterator, race) would otherwise become an
    // unhandled rejection and kill the whole bridge. Guard it: finalize any
    // mid-flight turn, then CLOSE the connection so `SessionRegistry.acquire`
    // transparently reconnects on the next send — this session self-heals instead
    // of taking the process down. The `.catch` callback stays SYNCHRONOUS (it only
    // schedules the detached, fully-guarded recovery) so it can never itself reject.
    void this.consume().catch((err) => {
      console.error(
        `[session] consume loop crashed chat=${this.chatId} — recovering:`,
        errForLog(err),
      );
      void this.recoverFromConsumeCrash();
    });
  }

  /**
   * Recover from a consume-loop crash. Mirrors the `winner.done` (connection
   * closed) path: if a turn was mid-flight, finalize it as `aborted` so the
   * assistant message never hangs in "streaming" forever; then close the
   * connection so the next send reconnects. Fully self-contained — it MUST NOT
   * throw (it runs detached, so a throw would be an unhandled rejection, i.e. the
   * very crash we are guarding against).
   */
  private async recoverFromConsumeCrash(): Promise<void> {
    // Close FIRST: close() synchronously marks the connection isClosed, so a
    // concurrent SessionRegistry.acquire() during the AWAITED endTurn() below can
    // no longer hand this dead-consumer session to a new /send (which would
    // chat.send + beginTurn with NO frame reader -> a turn stuck in "streaming").
    // acquire then drops this session and reconnects a fresh one. endTurn writes to
    // Convex (not this socket), so closing first does not affect the finalize.
    try {
      this.connection.close(); // the policy disposes itself on the connection's close
    } catch {
      /* already gone */
    }
    // …and the reconciler with it (detaches from the session-events connection), even
    // on a connection double that has no close listeners.
    this.transcriptShadow.close();
    this.childRows?.close();
    // The connection is gone -> no more child frames; drop observations AND the
    // registration-ordering set so the crash-recovery path can't leak the registry
    // (keep registeredChildren in lockstep with the observer — invariant: it only ever
    // holds keys of currently-observed children).
    this.observer.clear();
    this.registeredChildren.clear();
    if (!this.runManager.isFinalized) {
      try {
        // A crash/close mid-turn is an INFRASTRUCTURE end, not a user stop —
        // finalize as a clear "connection lost" error, never "aborted" (which
        // the UI renders as the user's "Interrompu"). A user Stop set Convex
        // status "aborted" already; first-terminal-wins keeps it.
        const crashCause = this.closeCauseCode();
        await this.runManager.endTurn(
          this.clock(),
          "error",
          crashCause,
          // THE CAUSE WE JUST COMPUTED, not the generic one. This slot used to
          // feed a trace; it is now the turn's durable verdict, and writing
          // `external` over a known `gateway_restarting` or `connection_saturated`
          // would make the record lie about the one class of incident an operator
          // most needs to recognise afterwards.
          crashCause,
          Session.namedKind(crashCause),
        );
      } catch (err) {
        console.error(
          `[session] crash finalize error chat=${this.chatId}:`,
          errForLog(err),
        );
      }
    }
  }

  /**
   * Prod the consume loop to re-evaluate its next deadline. Called by performSend
   * right after `runManager.beginTurn` arms the recv/grace deadline from OUTSIDE
   * the loop: without it, a loop already blocked on a null-timeout frame wait
   * never re-reads nextTimeout, so when the gateway sends nothing further (or the
   * whole reply arrived in the pre-ack buffer) the turn hangs in "streaming"
   * forever (the recv guard never fires). Best-effort: a wake that lands while the
   * loop is not currently racing sets `wakePending`, which the loop checks
   * synchronously before blocking — so correctness does not depend on interleaving.
   */
  wake(): void {
    this.wakePending = true;
    const w = this.wakeConsumer;
    if (w) {
      this.wakeConsumer = null;
      w();
    }
  }

  private async consume(): Promise<void> {
    const iterator = this.connection.frames();
    // Maintain a single pending read so a frame is never lost on a tick timeout.
    let nextFrame = iterator.next();
    while (true) {
      // The next deadline is the EARLIER of the parent turn's grace and any live
      // sub-agent observation's TTL — so the observer's stalled-child sweep fires
      // even when the parent turn is idle/finalized (the FD-leak TTL guardrail).
      const tNow = this.clock();
      const timeoutSec = minTimeout(
        this.runManager.nextTimeout(tNow),
        this.observer.nextTimeout(tNow),
      );
      const timeoutMs =
        timeoutSec === null ? null : Math.max(0, timeoutSec * 1000);
      // Arm the wake resolver for THIS race, then check `wakePending`
      // synchronously BEFORE blocking: a wake() delivered during the previous
      // iteration's await (feed/tick/recovery, when the resolver was null) is
      // honored here without blocking, so a deadline armed off-loop (beginTurn)
      // is never missed regardless of interleaving.
      const wakeSignal = new Promise<"wake">((resolve) => {
        this.wakeConsumer = () => resolve("wake");
      });
      if (this.wakePending) {
        this.wakePending = false;
        this.wakeConsumer = null;
        continue;
      }
      const raced = await Promise.race([
        raceWithTimeout(nextFrame, timeoutMs),
        wakeSignal,
      ]);
      this.wakeConsumer = null;
      if (raced === "wake") {
        this.wakePending = false;
        continue; // deadlines changed (beginTurn) — re-evaluate nextTimeout
      }
      const winner = raced;
      const now = this.clock();
      if (winner.kind === "frame") {
        if (winner.done) {
          // Connection closed. A turn in flight is NOT finalized here: the gateway may
          // still run it (a restart recovery, a compaction that recreated the session
          // and dropped this socket), and its durable rows say how it ended.
          if (!this.runManager.isFinalized) {
            // Whatever the gateway sent between the last frame read and the close is
            // gone: from here on, an absence in this turn's stream proves nothing.
            this.runManager.noteStreamGap();
            // CU-22: no transcript poll and no settle on a deadline. The bubble stays as
            // the run left it; the next reconciler read — the resume a send or the
            // stuck-stream net asks for (`/resume`) — settles it from the run's durable
            // rows, or resumes it if the gateway still runs it.
            console.log(
              `[session] close mid-turn — left to the transcript (resume) chat=${this.chatId}`,
            );
          }
          // Drop every sub-agent observation (status left as last-known): the
          // connection is gone, so no more child frames can arrive — never leak
          // the registry past the session's life. Also drop the registration-ordering
          // set so a reconnect re-orders the first running-row write for each child.
          this.observer.clear();
          this.registeredChildren.clear();
          // No more frames, no more reads on a closed socket (the next session reads).
          this.transcriptShadow.close();
          this.childRows?.close();
          break;
        }
        nextFrame = iterator.next();
        this.lastActivityAt = now; // active turn (or live child) -> not idle, don't reap
        // Capture the live message BEFORE the feed: the frame that FINALIZES a
        // turn clears currentMessageId inside feed(), and the observer below
        // would then see null for the turn's own final — losing the anchor an
        // announce-spawned child's sighting backfills from (its spawn often
        // lands before the deferred message even opened). ONLY while the turn
        // is actually ACTIVE: after a finished turn the sink still remembers
        // its message, and handing that stale id to the FIRST frame of a NEW
        // deferred run would anchor its spawns to the previous bubble.
        const preFeedMessageId =
          this.runManager.turnActive &&
          this.runManager.frameOwnedByActiveTurn(winner.value)
            ? this.runManager.currentMessageId
            : null;
        try {
          await this.runManager.feed(winner.value, now);
        } catch (err) {
          // NO sensor call here: `runManager.feed` reports the frame itself and rethrows
          // (C4 lives on the reader, so the voice relay and the pre-ack replay are
          // covered too). Reporting again would count one unreadable frame twice.
          console.error("session feed error:", errForLog(err));
        }
        // THE TRANSCRIPT PROJECTION (shadow): a terminal chat frame of any run of this
        // session asks for a read. Read-only — the frame went through the feed above
        // untouched, and nothing here can change what it did.
        try {
          this.transcriptShadow.observeFrame(winner.value);
        } catch (err) {
          // Shadow-only: a failure here loses a READ trigger, never a frame (the feed
          // above already consumed it), so it is logged rather than sensed.
          console.error("session transcript observe error:", errForLog(err));
        }
        // AGENT REQUESTS ride broadcasts, not the turn's frames: the feed above drops
        // them. Awaited because the one local effect — a human now holds the turn —
        // decides the very next deadline; the network writes inside are detached.
        if (
          OpenClawAgentRequestObserver.handles(winner.value) &&
          openClawAgentRequestsEnabled(this.connection.gatewayVersion)
        ) {
          await this.agentRequests.observe(winner.value);
        }
        // POST-feed re-evaluation: a legitimately NEW runId admitted DURING
        // feed() (lifecycle_end / compaction adoption windows) was not in
        // ownRunIds when preFeedMessageId was computed. If that first frame
        // is the sessions_spawn result, registering without an anchor is
        // permanent (no spawnRunHint on tool-result registrations). preFeed
        // still wins when set — a turn-FINAL frame deactivates the turn
        // inside feed(), so only the pre-feed view holds its anchor.
        const postFeedMessageId =
          this.runManager.turnActive &&
          this.runManager.frameOwnedByActiveTurn(winner.value)
            ? this.runManager.currentMessageId
            : null;
        const observeAnchor = preFeedMessageId ?? postFeedMessageId;
        // INBOUND-ONLY sub-agent observation, INDEPENDENT of the parent turn's
        // lifecycle (runs even after runManager finalized / its sink went inactive
        // — that's the gap this closes). Errors here never affect the turn.
        try {
          // AWAIT: the initial spawn-registration write is ordered (commits before the
          // next frame / parent finalize) to close the spawn-upsert race; later
          // status/heartbeat writes stay off the critical path. See flushSubAgentObserved.
          await this.flushSubAgentObserved(
            this.observer.observe(
              winner.value,
              now,
              // NO unconditional fallback to currentMessageId here: the
              // anchor is null precisely when this frame does NOT belong to
              // the active turn (a stashed announce) — reading the active
              // turn's message back would re-anchor the announce's spawns to
              // an unrelated reply.
              observeAnchor,
              // CHILD-lane registration fallback (child frames are never
              // owned by the parent turn): the last-known message — the turn
              // that spawned the child, or post-final the settled parent.
              // Null while a deferred announce has not opened its message.
              this.runManager.currentMessageId,
            ),
          );
        } catch (err) {
          // Same sensor, distinct site: the sub-agent observer reads the SAME frame on an
          // independent path, so a throw here is a second way to lose a frame silently.
          // Instrumenting only the feed would have covered one of two identical blind
          // spots.
          protocolDrift.observeException(winner.value, err, "subagent-observe");
          console.error(
            "session subagent observe error:",
            errForLog(err),
          );
        }
        // Anchor propagation for frames the observer never re-observes (a
        // stashed announce replays INSIDE feed()): hand the turn's run ids +
        // message anchor to the observer's run-correlated backfill. NOT gated
        // on turnActive — a deferred announce whose first visible frame is
        // also terminal opens AND finalizes its message inside feed(), so the
        // anchor only becomes readable once the turn is already inactive
        // (ownRunIds and currentMessageId both persist until the NEXT turn).
        // Correlation stays strict by runId, so a stashed announce's parked
        // spawns can never take another turn's anchor. No-op when nothing is
        // parked for those runs.
        try {
          const anchor = this.runManager.currentMessageId;
          if (anchor !== null) {
            await this.flushSubAgentObserved(
              this.observer.noteRunAnchor(
                this.runManager.activeRunIds,
                anchor,
                now,
              ),
            );
          }
        } catch (err) {
          // THIRD frame-path site. The programme named two; this one runs on the same
          // arrived frame (anchor propagation for frames the observer never re-observes),
          // so a throw here loses a frame exactly as silently as the other two.
          protocolDrift.observeException(winner.value, err, "subagent-anchor");
          console.error(
            "session subagent anchor error:",
            errForLog(err),
          );
        }
      } else {
        // timeout: resolve any expired normalizer deadline (may finalize) AND reap
        // any stalled sub-agent observation (FD-leak TTL guardrail).
        try {
          await this.runManager.tick(now);
        } catch (err) {
          console.error("session tick error:", errForLog(err));
        }
        // A PURE recv-silence elapsed (the gateway is reasoning silently, socket still
        // alive). §8.2 net: a silence asks the transcript, it never ends the turn. The
        // read settles it if the gateway says the run is over; the silence budget
        // restarts so a longer silence asks again, once per budget.
        if (this.runManager.takeRecvSilence() && !this.runManager.isFinalized) {
          console.log(
            `[session] recv-silence — reading the transcript chat=${this.chatId}`,
          );
          this.transcriptShadow.requestRead("silence");
          this.runManager.rearmSilence(now);
        }
        try {
          // The TTL sweep returns visible terminal upserts for silently-hung
          // sub-agents (Bug C). Route them through the SAME observed-flush helper (not a
          // bare fire-and-forget) so a TTL-terminalized child's key is removed from
          // registeredChildren — else a swept child leaks its key forever (it never hits
          // the per-frame cleanup branch). Sweep emits only terminal records, so this
          // awaits nothing (no registration write) — it just cleans up + fires the writes.
          await this.flushSubAgentObserved(this.observer.sweep(now));
        } catch (err) {
          console.error(
            "session subagent sweep error:",
            errForLog(err),
          );
        }
      }
    }
  }

  /**
   * The stable cause for a turn that was in flight when THIS connection ended.
   *
   * Only the ends whose message genuinely differs for the reader get their own
   * code. An auth refusal or another policy close stays `connection_lost` here —
   * accurate (the connection WAS lost) and not actionable by the user; the
   * precise kind is reported by `bridge_status`, where the operator looks.
   */
  /**
   * The named kind to report as the failure CLASS, or null.
   *
   * Only the ends this lot newly identifies are stated: the historic
   * `connection_lost` path keeps reporting exactly what it always did, so the
   * operator telemetry gains the new classes without any pre-existing series
   * changing meaning underneath.
   */
  private static namedKind(cause: string): string | null {
    return cause === GATEWAY_RESTARTING_CODE ||
      cause === CONNECTION_SATURATED_CODE
      ? cause
      : null;
  }

  private closeCauseCode(): FinalizeCause {
    switch (this.connection.connectionEnd?.kind) {
      case "gateway_restarting":
        return GATEWAY_RESTARTING_CODE;
      case "slow_consumer":
      // OUR side of the same fact: frames were dropped because one end could not
      // keep up. The reader's message is identical, so the cause is too.
      case "inbound_overflow":
        return CONNECTION_SATURATED_CODE;
      default:
        return CONNECTION_LOST_CODE;
    }
  }

  /**
   * Hold the socket for a call, with a CEILING it can never be extended past.
   *
   * The gateway arms a call's 30-minute TTL at ALLOCATION — the mint — not when the
   * browser finally connects. So every hold for a given call, however often it is
   * later extended, dies at the same absolute instant. Without that ceiling an
   * extension simply reset the clock, and a consult belonging to one call pushed an
   * unrelated, already-dead call on the same socket half an hour past its own TTL
   * (the gateway allows two per owner connection) — freezing the chat's agent long
   * after anything was live (codex P2, pass 13).
   */
  holdForVoiceCall(voiceSessionId: string, holdMs: number): void {
    const now = this.clock();
    const existing = this.voiceCallsUntil.get(voiceSessionId);
    this.voiceCallsUntil.set(voiceSessionId, {
      until: now + Math.ceil(holdMs / 1000),
      // Re-holding the SAME id keeps the original ceiling: it is the same call.
      ceiling: existing?.ceiling ?? now + Math.ceil(TALK_CALL_HOLD_MS / 1000),
    });
    this.lastActivityAt = now;
  }

  /**
   * Extend a hold BY NAME — and re-set its ceiling with it.
   *
   * This is the allocation moment: the offer being spent is when the gateway arms the
   * call's TTL, up to a minute after the mint. The caller names the call, so it knows
   * what it is saying; `extendLiveVoiceCalls` does not and may only prolong WITHIN
   * the ceiling this sets.
   */
  extendVoiceCall(voiceSessionId: string, holdMs: number): boolean {
    const now = this.clock();
    const current = this.voiceCallsUntil.get(voiceSessionId);
    if (current === undefined || current.until <= now) {
      this.voiceCallsUntil.delete(voiceSessionId);
      return false;
    }
    current.until = now + Math.ceil(holdMs / 1000);
    current.ceiling = current.until;
    this.lastActivityAt = now;
    return true;
  }

  /**
   * Extend every hold that is still live, without naming one.
   *
   * The relayed lane extends by id when the offer is spent — its proof that the call
   * really connected. The DIRECT lane has no such moment: the browser talks to the
   * provider and the bridge never hears about it. Its one server-visible proof of
   * life is a CONSULT, which does not carry a voice session id. So the consult
   * extends whatever this socket is holding: it cannot name the call, but it has
   * just proven one is happening (codex P1, pass 12).
   *
   * Returns how many holds were extended — zero means the consult belongs to a call
   * this socket never held, which the caller may ignore.
   */
  extendLiveVoiceCalls(holdMs: number): number {
    const now = this.clock();
    let extended = 0;
    for (const [id, hold] of this.voiceCallsUntil) {
      if (hold.until <= now) {
        this.voiceCallsUntil.delete(id);
        continue;
      }
      // Clamped to each hold's OWN ceiling: a consult proves a call is live, not
      // WHICH one, so it must never push another past the instant it must die.
      const next = Math.min(now + Math.ceil(holdMs / 1000), hold.ceiling);
      if (next > hold.until) {
        hold.until = next;
        extended += 1;
      }
    }
    if (extended > 0) this.lastActivityAt = now;
    return extended;
  }

  liveVoiceCallCount(): number {
    const now = this.clock();
    let live = 0;
    for (const hold of this.voiceCallsUntil.values()) {
      if (hold.until > now) live += 1;
    }
    return live;
  }

  releaseVoiceCall(voiceSessionId: string): void {
    this.voiceCallsUntil.delete(voiceSessionId);
  }

  /** Is a gateway-owned voice call possibly live on this socket at `now`? Expired
   *  holds are dropped on the way, so an un-hung-up call cannot pin the socket past
   *  the gateway's own call TTL. */
  holdsVoiceCall(now: number): boolean {
    for (const [id, hold] of this.voiceCallsUntil) {
      if (hold.until > now) return true;
      this.voiceCallsUntil.delete(id);
    }
    return false;
  }

  close(): void {
    this.connection.close(); // the policy disposes itself on the connection's close
  }
}

type RaceResult<T> =
  | { kind: "frame"; done: false; value: T }
  | { kind: "frame"; done: true; value: undefined }
  | { kind: "timeout" };

/**
 * Await the pending iterator read, but give up after `timeoutMs` (null = wait
 * forever). On timeout the original `nextFrame` promise is left pending so the
 * next iteration re-awaits it — no frame is dropped.
 */
/** The earlier of two seconds-until-deadline values (null = no deadline on that
 *  side). Used to combine the parent turn's grace with the sub-agent observer TTL. */
export function minTimeout(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export function raceWithTimeout<T>(
  nextFrame: Promise<IteratorResult<T>>,
  timeoutMs: number | null,
): Promise<RaceResult<T>> {
  const framePromise = nextFrame.then(
    (r): RaceResult<T> =>
      r.done
        ? { kind: "frame", done: true, value: undefined }
        : { kind: "frame", done: false, value: r.value },
  );
  if (timeoutMs === null) {
    return framePromise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<RaceResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
  // Cancel the timer the moment EITHER side settles. When a frame wins the race
  // (the common case during active streaming, called once per frame), an
  // un-cleared setTimeout stays armed for the full timeoutMs — thousands of live
  // timers would pile up over a long response. clearTimeout on the timeout-wins
  // path is a harmless no-op.
  return Promise.race([framePromise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

// Idle-session sweeper cadence + TTL. Each chat holds its own WebSocket (an open
// FD) for the lifetime of its Session, and an idle gateway socket stays open
// indefinitely (the gateway drives keepalive). Without reaping, EVERY chat ever
// sent-to leaks one socket/FD -> eventual EMFILE/ENFILE -> the bridge can open
// nothing (gateway, Convex, HTTP) -> ALL chats down, restart required (the prod
// "bridge falls + new chats readonly" failure). The sweeper closes + drops a
// session idle beyond the TTL, and reaps closed husks; the next send reconnects.
const SWEEP_INTERVAL_MS = 60_000; // setInterval unit = milliseconds
// TTL is compared against the module Clock, which is in SECONDS (Date.now()/1000),
// so it MUST be expressed in seconds too. A milliseconds value here would push the
// reap horizon to ~10 days and silently defeat the FD-leak fix.
export const IDLE_SESSION_TTL_SECONDS = 15 * 60;

/**
 * Owns the live sessions. `acquire` returns the session for a chat, creating
 * (and connecting) it on first use. Routing uses `openclawChatId` to build the
 * gateway session key; when absent we fall back to the Convex chatId.
 */
const MAX_RECENT_CHAT_KEYS = 4;

/**
 * The name this conversation's socket presents.
 *
 * Falls back to the routing key when the instance's chosen name cannot travel in
 * the header that carries it. That case is REAL: with `identitySource: "email"`
 * the name is somebody's verified address, and an internationalized address
 * (`josé@example.com`) is valid everywhere except this header. Without the
 * fallback that person could not send AT ALL — every turn failing at connect,
 * 502, from a setting an administrator flipped on a screen far away.
 *
 * A silent divergence for one person (their gateway profile stays keyed by the
 * Atrium key, so they keep the second profile the setting exists to merge) is
 * strictly better than that person being unable to speak. It is said out loud in
 * the log, without the address — the routing key identifies them for an operator
 * and carries no personal data into the bridge log.
 */
/**
 * How a reconciler reads ONE session through ONE connection: its `chat.history` pages and
 * the full message of a capped row (0.101.3: the Control UI's own question,
 * ui/src/pages/chat/chat-pane-sidebar-layout.ts:270-277 at v2026.9.33, with its bound).
 * Shared by a conversation's own socket and a read of a bubble's session through a
 * connection of its own (server.ts `readBubbleSessionApart`, Codex pass 7).
 */
export function transcriptReaders(
  connection: Pick<OpenClawConnection, "request" | "gatewayVersion">,
  sessionKey: string,
): Pick<TranscriptShadowDeps, "readHistory" | "readMessage"> {
  return {
    readHistory: async (cursor, opts) =>
      (
        await connection.request(
          "chat.history",
          chatHistoryParams(
            {
              sessionKey,
              cursor,
              limit: CHAT_HISTORY_PAGE_LIMIT,
              maxBytes: CHAT_HISTORY_PAGE_MAX_BYTES,
              ...(opts?.inputRunIds === undefined ? {} : { inputRunIds: opts.inputRunIds }),
            },
            connection.gatewayVersion,
          ),
        )
      ).payload,
    readMessage: async (messageId) =>
      (
        await connection.request("chat.message.get", {
          sessionKey,
          messageId,
          maxChars: FULL_MESSAGE_MAX_CHARS,
        })
      ).payload,
  };
}

export function gatewayNameFor(routing: SessionRouting): string {
  const wanted = routing.gatewayUser;
  if (wanted === undefined) return routing.canonical;
  const presented = presentedIdentity(wanted, routing.canonical);
  if (presented === wanted) return wanted;
  console.warn(
    `[identity] ${routing.canonical}: this instance names people by an address, ` +
      `but theirs cannot be sent in the identity header — naming them by their ` +
      `Atrium key instead, so this person keeps a separate gateway profile.`,
  );
  return presented;
}

/**
 * The registry refused to re-key a chat's socket: a gateway-owned voice call is live
 * on it, and the gateway ends that call with the socket. THE TURN WAS NEVER SENT —
 * this is thrown before any gateway RPC.
 *
 * Carries no chat content, only the chat id the bridge already logs.
 */
/**
 * The registry refused to re-key a chat's socket: a sub-agent's reply is still owed on
 * it (an interaction pending, or in its recovery grace). THE TURN WAS NEVER SENT —
 * thrown before any gateway RPC. Chat id only.
 */
export class SubAgentReplyPendingError extends Error {
  constructor(readonly chatId: string) {
    super(`send withheld: a sub-agent reply is still owed on chat ${chatId}'s socket`);
    this.name = "SubAgentReplyPendingError";
  }
}

export class TalkCallActiveError extends Error {
  constructor(readonly chatId: string) {
    super(
      `send withheld: a gateway-owned voice call is live on chat ${chatId}'s socket`,
    );
    this.name = "TalkCallActiveError";
  }
}

/** An acquire that must never displace the chat's socket found one bound to ANOTHER
 *  identity (session key or instance): nothing was closed. */
export class SessionDisplaceRefusedError extends Error {
  constructor(readonly chatId: string) {
    super(`acquire refused: chat ${chatId}'s socket is bound to another session`);
    this.name = "SessionDisplaceRefusedError";
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Map<string, Promise<Session>>();
  // RECENT session keys per chat (bounded history): the sessions map keeps
  // ONE entry per chat, so an agent/instance re-key drops the previous key
  // instantly — but a background chain started on it can still produce
  // invisible links for a while, and the task discovery must keep matching
  // that registry session. Cap 4 keys / 30 min TTL per chat.
  /** How many recent session keys a chat keeps for discovery. The task probe must ask
   *  for ALL of them — asking fewer left the oldest retained key unqueried, which is
   *  where a chain still producing invisible links lives after a re-key (codex). */
  static readonly MAX_RECENT_CHAT_KEYS = MAX_RECENT_CHAT_KEYS;

  private readonly recentChatKeys = new Map<
    string,
    { key: string; at: number }[]
  >();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** ONE session-events connection per served instance (transcript redesign, phase 2),
   *  opened lazily by the first session whose projection is on, closed after the last
   *  detaches. See providers/openclaw/session-events.ts. */
  private readonly sessionEventHubs = new Map<string, SessionEventsHub>();

  constructor(
    // The instances this bridge serves, keyed by instanceName. Each bundle carries
    // its own gateway config + writer + media — `acquire` picks the bundle for the
    // turn's routed instance (one bridge, N gateways).
    private readonly served: Map<string, InstanceBundle>,
    private readonly clock: Clock = defaultClock,
    // Health-stats hook wired by boot (index.ts): a turn finalizing in error is
    // reported against its target (full identity — recordTurnError may have to
    // CREATE the row when the error beats the send's recordOk) so the admin
    // Connections stats count turn-level failures, not just send transport.
    private readonly onTurnError?: (
      target: {
        instanceName: string;
        canonical: string;
        agentId: string;
        gatewayHost: string;
      },
      code: string,
    ) => void,
  ) {}

  /** The bundle serving `instanceName`, or undefined when this bridge does not serve
   *  it (the server's membership guard rejects before acquire is reached). */
  getBundle(instanceName: string): InstanceBundle | undefined {
    return this.served.get(instanceName);
  }

  /** NON-ACQUIRING lookup of a chat's live session (the map holds one per
   *  chat). For observation-only signals (e.g. the /abort handler flagging a
   *  user stop) — never re-keys or closes anything. */
  peekByChat(chatId: string): Session | undefined {
    return this.sessions.get(chatId);
  }

  /** Register a newly-resolved instance at RUNTIME (boot self-heal). Mutates the SAME
   *  served map the HTTP server holds, so the instance becomes routable immediately —
   *  no restart. Callers check membership/collision before building the bundle. */
  register(instanceName: string, bundle: InstanceBundle): void {
    this.served.set(instanceName, bundle);
  }

  /** Start the idle-session sweeper on first use (lazy, so pure-helper tests that
   *  never acquire don't spin a timer). The interval is unref'd — it never keeps
   *  the process alive — and is cleared by closeAll. */
  private ensureSweeper(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(
      () => this.reapStaleSessions(this.clock()),
      SWEEP_INTERVAL_MS,
    );
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  /** Close + drop sessions that are already closed (husks) or idle beyond the TTL.
   *  Returns the number reaped. Pure over `now` -> unit-testable with a fake clock. */
  reapStaleSessions(now: number): number {
    let reaped = 0;
    for (const [chatId, session] of this.sessions) {
      const dead = session.connection.isClosed;
      // A socket carrying a gateway-owned voice call is never "idle": the call is
      // the activity, and reaping the socket would end it (gateway-side cleanup).
      const idle =
        now - session.lastActivityAt > IDLE_SESSION_TTL_SECONDS &&
        !session.holdsVoiceCall(now);
      if (dead || idle) {
        if (!dead) {
          try {
            session.close();
          } catch {
            /* already gone */
          }
        }
        this.sessions.delete(chatId);
        reaped++;
      }
    }
    return reaped;
  }

  /** The Convex writer for an instance (read seam for session re-hydration in
   *  performSend). Undefined when the instance is not served. */
  getWriter(instanceName: string): ConvexWriter | undefined {
    return this.served.get(instanceName)?.writer;
  }

  /**
   * Refuse to re-key the chat's socket while a gateway-owned voice call is live on
   * it. Thrown BEFORE any gateway RPC: the turn is never sent.
   *
   * By TYPE, not by message, like every other decision the bridge takes itself — a
   * refusal must not depend on how it was phrased (`classifyGatewayError`).
   */
  async acquire(
    routing: SessionRouting,
    opts?: {
      /** False: an automatic caller (the CU-22 resume) that must never close a socket
       *  bound to another identity — it may carry another agent's live turn, on an
       *  instance whose projection is off. Throws SessionDisplaceRefusedError instead. */
      displace?: boolean;
    },
  ): Promise<BridgeSession> {
    this.ensureSweeper();
    const displace = opts?.displace !== false;
    const { chatId, openclawChatId, agentId, canonical } = routing;
    // The session key is derived from THIS turn's routed agent + canonical, so a
    // rebind (deleted agent → default = new agentId, or a changed canonical)
    // yields a DIFFERENT key. We keep at most one live connection per chatId; if
    // the key changed we must close the stale one (else its consumer loop keeps
    // writing to the same chat under the old agent → leak + cross-write).
    const sessionKey = buildSessionKey(
      openclawChatId ?? chatId,
      agentId,
      canonical,
    );
    // The routed instance is ALSO part of a session's identity (one bridge, N
    // gateways): a chat whose routed instance changes (a chat with no stored
    // instanceName re-resolves per turn, and two gateways can expose the SAME agent
    // ids → identical sessionKey) must NOT reuse the cached session bound to the OLD
    // gateway's connection. Re-key on an instance change so create() picks the right
    // bundle. (Sole-instance fallback mirrors create().)
    const effectiveInstance =
      routing.instanceName ??
      (this.served.size === 1 ? [...this.served.keys()][0] : undefined);
    const sameIdentity = (s: Session): boolean =>
      s.sessionKey === sessionKey && s.instanceName === effectiveInstance;
    // The widget wish is part of what the socket DECLARED at connect, so a change of
    // it needs a new handshake — but only a route that knows the wish can ask for one.
    const sameWidgets = (s: Session): boolean =>
      routing.inlineWidgets === undefined || s.widgetsWanted === routing.inlineWidgets;
    const matches = (s: Session): boolean => sameIdentity(s) && sameWidgets(s);

    const existing = this.sessions.get(chatId);
    if (existing && !existing.connection.isClosed && matches(existing)) {
      existing.lastActivityAt = this.clock(); // a send keeps it warm (not idle)
      return existing;
    }
    // Only the widget wish changed: that is a preference, not an identity. It must
    // never cost a live voice call (the gateway ends it with the socket) nor any work
    // the socket still carries — a turn, a `chat.send` awaiting its ACK, a stashed
    // delivery, a sub-agent interaction (busyReason; codex pass 10: a send in its ACK
    // window was closed under the gateway that had accepted it). The socket is kept
    // and the switch applies on the first acquire that finds it idle.
    const busy =
      existing && !existing.connection.isClosed && sameIdentity(existing)
        ? existing.busyReason(this.clock())
        : null;
    if (existing && busy !== null) {
      const why = busy;
      console.log(
        `[session] chat ${chatId}: widget switch deferred (${why}) — the socket keeps its capabilities until it is idle`,
      );
      // The case that costs the person something: widgets are ON for the
      // conversation and this turn runs on a socket that never declared them — the
      // agent gets no show_widget. Only a wish CHANGED mid-call can lead here now
      // (every socket-opening route carries the wish), so it is named on its own.
      if (routing.inlineWidgets === true && !existing.widgetsWanted) {
        console.warn(
          `[widgets] chat ${chatId}: inline widgets unavailable for this turn (${why}) — the socket was opened without them; they apply once it is idle`,
        );
      }
      existing.lastActivityAt = this.clock();
      return existing;
    }
    // A closed, missing, OR re-keyed (incl. re-routed) session: drop (closing if
    // still open) and (re)connect, deduping concurrent acquisitions for the same chat.
    if (existing) {
      if (!existing.connection.isClosed && !displace && !sameIdentity(existing)) {
        throw new SessionDisplaceRefusedError(chatId);
      }
      if (!existing.connection.isClosed) {
        // ONE live socket per chat is this registry's invariant (the old consumer
        // loop would keep writing under the old key). A gateway-owned voice call
        // (GPT Live) is bound by the GATEWAY to the socket that minted it and ends
        // with that socket — so re-keying mid-call ENDS THE CALL.
        //
        // THE REFUSAL LIVES HERE, and nowhere else can make it true. Convex checks
        // the freeze before every send, every drain, every mint — but each of those
        // is a read that happens BEFORE the POST, so a call minted in the gap still
        // got cut (two concurrent mints; a call started while the dispatch was
        // encoding attachments — codex P1, pass 3). This is the one place every path
        // funnels through, and the only one that can decide with the socket in hand.
        // Refusing here also makes the guarantee hold against a client that never
        // asked Convex at all.
        if (existing.holdsVoiceCall(this.clock())) {
          throw new TalkCallActiveError(chatId);
        }
        // …and the same REFUSAL, for the same reason, while a sub-agent's reply is
        // still owed on this socket: the child's run streams to the socket that sent
        // the interaction (its `tool` stream reaches that socket only), so closing it
        // loses the reply — including one the gateway is still RECOVERING after a
        // provisional error (codex pass 13: Alice's child recovering, a call or a
        // turn on Bob re-keyed the socket). Refused, not deferred, exactly like a live
        // call: a re-key cannot be half-applied.
        if (existing.subAgentReplyPending(this.clock())) {
          throw new SubAgentReplyPendingError(chatId);
        }
        existing.close();
      }
      this.sessions.delete(chatId);
    }
    const pending = this.inflight.get(chatId);
    if (pending) {
      // Honor an in-flight create only if it targets the SAME key + instance;
      // otherwise wait for it to settle, then recurse so the re-key is applied.
      return pending.then((s) => {
        if (matches(s)) return s;
        if (!displace && !sameIdentity(s)) throw new SessionDisplaceRefusedError(chatId);
        return this.acquire(routing, opts);
      });
    }
    // What the chat's previous socket was opened for: a route that names no wish
    // creates the new one with the same (never silently off when it was on).
    const inheritedWish = existing?.widgetsWanted;
    const promise = this.create(chatId, sessionKey, routing, inheritedWish).finally(() => {
      this.inflight.delete(chatId);
    });
    this.inflight.set(chatId, promise);
    return promise;
  }

  private async create(
    chatId: string,
    sessionKey: string,
    routing: SessionRouting,
    inheritedWish?: boolean,
  ): Promise<Session> {
    // Pick the bundle for THIS turn's routed instance (selects the gateway + creds +
    // writer + outbound scan). The server's membership guard ran first, so the bundle
    // is present; we still throw a clear error if not (never connect with the wrong
    // instance's config). Credentials were RESOLVED AT BOOT from Convex and are
    // non-null by construction (a secret with missing creds is skipped at boot).
    const bundle =
      (routing.instanceName
        ? this.served.get(routing.instanceName)
        : undefined) ??
      (this.served.size === 1 ? [...this.served.values()][0] : undefined);
    if (!bundle) {
      throw new Error(
        `instance not served: ${routing.instanceName ?? "(unspecified)"}`,
      );
    }
    const instanceName =
      routing.instanceName ?? bundle.config.instanceName ?? "";
    // AGENT REQUESTS: `approvals` makes this socket a reviewer surface the gateway
    // routes approvals to (server-request-context.ts canDeliverApprovals). Declared
    // ONLY where Atrium shows them — elsewhere an approval would wait for a card no
    // one sees instead of failing fast. The version is known only after the
    // handshake: the socket opens on the version a LIVE socket to this instance
    // proves (gateway-version-hint.ts — none after a boot or a gateway restart), and
    // re-opens ONCE when the real one allows more.
    // INLINE WIDGETS: declared when the conversation wants them AND the gateway
    // version is one Atrium renders them for — the gateway then offers `show_widget`
    // to the agent (upstream SHOW_WIDGET_REQUIRED_CLIENT_CAPS). Same post-handshake
    // judgement as approvals, same fail-closed end.
    // THE WISH, most specific first: the turn's own (send, talk mint), then the one
    // a session operation carries for creation, then the chat's previous socket's.
    const widgetsWanted =
      routing.inlineWidgets ?? routing.widgetsAtCreate ?? inheritedWish ?? false;
    const approvalCaps = (version: string | null): string[] => [
      ...(openClawAgentRequestsEnabled(version) ? ["approvals"] : []),
      ...(widgetsWanted && openClawInlineWidgetsEnabled(version) ? [INLINE_WIDGETS_CAP] : []),
    ];
    const sameCaps = (a: readonly string[], b: readonly string[]): boolean =>
      a.length === b.length && a.every((cap) => b.includes(cap));
    const connectConversation = (caps: readonly string[]) =>
      OpenClawConnection.connect(
        bundle.config.openclawGatewayUrl,
        bundle.config.openclawToken ?? "",
        bundle.config.deviceIdentity!,
        deviceTokenPromotion(bundle.config),
        0,
        // THE per-user socket. In trusted-proxy mode this conversation's socket acts
        // as the person who owns it, so every session the gateway creates from it
        // carries their profile as `createdActor` — the fact the gateway's own
        // visibility boundary reads. `undefined` in token mode: unchanged handshake.
        // The NAME, not the routing key. They are the same string unless the instance
        // says otherwise, and the session key above is built from the canonical
        // either way.
        humanConnectIdentity(bundle.config, gatewayNameFor(routing)),
        connectUserHeader(bundle.config),
        caps,
      );
    // Every re-open is judged again on ITS handshake: the gateway may restart on
    // another version between two of them (codex P2). The unsafe direction — the
    // capability announced to a gateway Atrium does not observe approvals on — never
    // survives: after a few disagreements the socket opens without it (fail closed:
    // an approval is then refused as unrouted, never left waiting unseen).
    let declared = approvalCaps(trustedGatewayVersion(instanceName));
    let connection = await connectConversation(declared);
    for (let attempt = 0; ; attempt += 1) {
      const owed = approvalCaps(connection.gatewayVersion);
      if (sameCaps(owed, declared)) break;
      // Out of attempts and on the safe side (nothing announced): keep it.
      if (attempt >= 2 && declared.length === 0) break;
      connection.close();
      declared = attempt >= 2 ? [] : owed;
      connection = await connectConversation(declared);
    }
    connection.onClosed(holdGatewayVersion(instanceName, connection.gatewayVersion));
    // WHAT THIS SOCKET DECLARED, and the wish behind it: the one fact a report of
    // "the agent had no show_widget" needs, and that nothing recorded — prod 0.91.0
    // (a Talk mint opening the socket without inline-widgets) had to be inferred from
    // which route opened it. Ids and capability names only.
    console.log(
      `[session] chat ${chatId}: socket opened (gateway ${connection.gatewayVersion ?? "?"}, caps: ${declared.join(",") || "none"}; widgets ${widgetsWanted ? "wanted" : "not wanted"})`,
    );
    // SUBSCRIBE to session events (W2 / G-09). `session.operation` is the
    // gateway's own account of a compaction — it carries the CAUSE (`overflow` vs
    // a threshold vs `manual`), which Atrium could only infer until now, and it is
    // delivered ONLY to connections that asked for it. Best-effort on purpose: a
    // gateway that does not know the method, or refuses the scope, must not stop
    // this session from serving turns — the rotation heuristic still covers the
    // detection, only the cause stays unknown.
    // NO `sessions.subscribe` on THIS connection — MEASURED, 2026-07-26.
    //
    // Subscribing here was the obvious way to receive `session.operation`, the
    // gateway's own account of a compaction and the only carrier of its CAUSE
    // (G-09). It also broke the live bench: `spawn-parallel-merge` went from OK in
    // 67 s to a reproducible failure at ~180 s, with two of three announce runs
    // never merging and the children anchored to the wrong bubble. Attributed by
    // bisect — the pre-lot bridge passed, this lot failed, and removing ONLY the
    // subscription (everything else of the lot in place) made it pass again.
    //
    // The socket that carries a conversation is not a place to add a diagnostic
    // stream: the sessions channel pushes `sessions.changed` / `session.message` /
    // `session.tool` traffic through the same consumer, and the frames the turn
    // depends on are what gets lost. A diagnostic must never cost the conversation.
    //
    // What IS observable without it, stated precisely:
    //  - the compaction's PHASE and VERDICT, from `{stream:"compaction"}` — that
    //    stream carries `{phase, willRetry, completed}` and no cause;
    //  - the CAUSE of the compactions ATRIUM itself performs: the pre-send guard
    //    labels its own compaction `pre_compaction` and the rotation it produces
    //    carries that label (normalizer.notePresendCompactionCause);
    //  - the guard's own REFUSAL class, on the guard's own trace.
    // What stays UNOBSERVABLE: the cause of a compaction the GATEWAY decided on its
    // own (an overflow it hit, a memory threshold it crossed). That needs a
    // SEPARATE, dedicated connection whose frames never reach RunManager.feed —
    // scoped as its own piece of work, not smuggled into the turn path.
    // `handleSessionOperation` stays ready for it and is unfed until then.
    const cfg = bundle.config;
    const onTurnError = this.onTurnError;
    const session = new Session(
      chatId,
      sessionKey,
      {
        agentId: routing.agentId,
        canonical: routing.canonical,
        instanceName,
        openclawChatId: routing.openclawChatId ?? null,
      },
      connection,
      bundle.writer,
      this.clock,
      bundle.outboundScan,
      // Bind the session's own target identity once — the sink only supplies
      // the failure code. Full identity (incl. host) so the health row can be
      // ensured even when the error beats the send's recordOk (codex P2).
      onTurnError
        ? (code) =>
            onTurnError(
              {
                instanceName,
                canonical: routing.canonical,
                agentId: routing.agentId,
                gatewayHost: gatewayHostOf(cfg.openclawGatewayUrl),
              },
              code,
            )
        : undefined,
      this.sessionEventsFor(instanceName, cfg),
      artifactCopyEnvOf(bundle),
    );
    session.widgetsWanted = widgetsWanted;
    session.runManager.setWidgetsEnabled(declared.includes(INLINE_WIDGETS_CAP));
    session.startConsumer();
    this.sessions.set(chatId, session);
    {
      const hist = this.recentChatKeys.get(chatId) ?? [];
      if (!hist.some((h) => h.key === session.sessionKey)) {
        hist.push({ key: session.sessionKey, at: this.clock() });
        if (hist.length > MAX_RECENT_CHAT_KEYS) hist.shift();
      }
      this.recentChatKeys.set(chatId, hist);
    }
    return session;
  }

  /**
   * Snapshot the routed identity + handshake-captured gateway version of every
   * LIVE (non-closed) session, for `/health` and `/capabilities`. Non-secret.
   */
  listLive(): LiveTarget[] {
    const out: LiveTarget[] = [];
    for (const session of this.sessions.values()) {
      if (session.connection.isClosed) continue;
      out.push({
        canonical: session.canonical,
        agentId: session.agentId,
        instanceName: session.instanceName,
        gatewayVersion: session.connection.gatewayVersion,
        maxPayload: session.connection.maxPayload,
      });
    }
    return out;
  }

  /** The LIVE session keys currently bound to a chat (any instance). The
   *  task-discovery probe matches them against the gateway registry's
   *  requesterSessionKey (measured live: it IS the requesting session's
   *  exact key) to find background tasks this chat started — including the
   *  chain links whose ack the gateway never surfaced as a tool frame. */
  sessionKeysForChat(chatId: string): string[] {
    const keys = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.chatId === chatId && !session.connection.isClosed) {
        keys.add(session.sessionKey);
      }
    }
    // RECENT keys too (see recentChatKeys): a chain started before an
    // agent/instance re-key keeps producing invisible links on the OLD
    // session for a while — drop entries past the TTL as we read.
    const hist = this.recentChatKeys.get(chatId);
    if (hist !== undefined) {
      const cutoff = this.clock() - 30 * 60;
      const fresh = hist.filter((h) => h.at >= cutoff);
      if (fresh.length !== hist.length) {
        this.recentChatKeys.set(chatId, fresh);
      }
      for (const h of fresh) keys.add(h.key);
    }
    return [...keys];
  }

  /** Cleanly close every live session (graceful shutdown). */
  closeAll(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
    for (const hub of this.sessionEventHubs.values()) hub.stop();
    this.sessionEventHubs.clear();
  }

  /** The session-events connection of one served instance (created on first use; it
   *  connects only when a session attaches). Its socket is NOT a conversation socket:
   *  it declares `session-scoped-events`, so no turn frame of any session reaches it, and
   *  its frames are read by the hub alone — never by a RunManager. */
  sessionEventsFor(instanceName: string, cfg: BridgeConfig): SessionEventsHub {
    const existing = this.sessionEventHubs.get(instanceName);
    if (existing !== undefined) return existing;
    const hub = new SessionEventsHub({
      instanceName,
      versionSupported: (v) => gatewayAtLeast(v, SESSION_EVENTS_SINCE) !== false,
      connect: () =>
        OpenClawConnection.connect(
          cfg.openclawGatewayUrl,
          cfg.openclawToken ?? "",
          cfg.deviceIdentity!,
          deviceTokenPromotion(cfg),
          0,
          // SYSTEM, like the transcript fetcher: the hub serves every conversation of
          // the instance, whoever owns it.
          systemConnectIdentity(cfg),
          connectUserHeader(cfg),
          [SESSION_SCOPED_EVENTS_CAP],
        ),
    });
    this.sessionEventHubs.set(instanceName, hub);
    return hub;
  }
}
