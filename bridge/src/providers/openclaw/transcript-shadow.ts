// THE TRANSCRIPT RECONCILER (transcript redesign, design §4).
//
// Per conversation session: reads the gateway's `chat.history` back with a delta cursor
// at the Control UI's own triggers, and posts what it read — rows with what they say,
// run statuses, the input guard, the cursor — to Convex (`applyTranscript`), which
// places the bubbles from them. It never writes a bubble itself.
//
// TRIGGERS (design §4.1), each the Control UI's:
//   - a terminal chat frame of ANY run of the session (`final`/`error`/`aborted`):
//     one delta read (ui/src/pages/chat/chat-state-events.ts, terminal handling);
//   - a `final` WITHOUT a message: the bounded recovery — read, then 100/400/1500/3000 ms
//     (five reads), stopping as soon as a visible row of that run was read
//     (chat-state-events.ts:73 `MISSING_TERMINAL_HISTORY_RETRY_DELAYS_MS`, :319-342
//     `recoverMissingTerminalReply`);
//   - the `chat.send` ACK `ok` (chat-send-delivery.ts:476-490);
//   - the projection switched on for a session — a new conversation socket is a new
//     session, so this is also the reconnect read: a fresh tail page when no cursor is
//     known (chat-history-stream.ts reconnect);
//   - PHASE 2, from the dedicated session-events connection (session-events.ts):
//       · `session.message` of this session — the row is applied DIRECTLY when CU-16
//         admits it (transcript-rows.ts `admitLiveRow`), and the transcript is read back
//         as `handleSessionMessageEvent` does (chat-state-events.ts:128-202 at v2026.9.8);
//       · `sessions.changed` of this session — reset/new → fresh page, compact, a batch
//         write, custody reasons, run end → a read (`classifySessionsChanged`);
//       · the subscription (re)established — a read covers what the gap missed.
//
// THE INPUT GUARD (phase 2): every read asks the gateway about the sends whose custody
// is not settled yet (`inputRunIds`, the Control UI's `readChatInputRunIds`,
// ui/src/pages/chat/chat-pending-inputs.ts:190-217 at v2026.9.8), and posts what it says
// back — `pendingInputs` (queued / cancelled / interrupted, 9.7+ `queued`/`queuedCount`)
// and `inputReceipts` (pending / consumed, 9.7+ `queued`/`cancelled` flags). A send
// leaves custody when its user row `<sendId>:user` is read, when a receipt settles it
// (consumed, or pending+cancelled), or when the gateway — asked after the ACK — answers
// no receipt at all for it (an exact queried absence, chat-pending-inputs.ts:73-80).
//
// COST: at most ONE read in flight and ONE chained behind it per session (the Control
// UI's coalescing, chat-history.ts:107-148). A delta costs only what changed; a `reset`
// costs one tail page of 80 rows. Directly applied rows are posted between reads, on
// the same single flight.

import type { TranscriptApplyReport, TranscriptFileToCopy } from "../../convex-writer.js";
import type { GatewayFrame } from "./openclaw-client.js";
import { protocolDrift } from "./protocol-drift.js";
import {
  admitLiveRow,
  classifySessionsChanged,
  INPUT_RUN_IDS_MAX,
  INPUT_RUN_ID_MAX_CHARS,
  capDisplayedRow,
  isDisplayCapped,
  parseHistoryReply,
  rowContentBytes,
  toTranscriptRow,
  runTerminalStatus,
  type CappedRef,
  type HistoryRead,
  type RowDisplay,
  type TranscriptRow,
} from "./transcript-rows.js";
import { errForLog } from "../../core/log-safe-error.js";

/** `off`: the reconciler has not been switched on yet (no `/send` or `/resume` gave it
 *  its cursor); `on`: it reads the transcript and its facts place the bubbles. */
export type ProjectionMode = "off" | "on";

/** Upstream `MISSING_TERMINAL_HISTORY_RETRY_DELAYS_MS` (chat-state-events.ts:73). */
export const TERMINAL_RECOVERY_DELAYS_MS: readonly number[] = [100, 400, 1_500, 3_000];

export type TerminalObservation = TranscriptApplyReport["terminals"][number];

/** What one read posts to Convex (convex/transcriptProjection.ts `applyTranscript`). */
export type TranscriptApply = TranscriptApplyReport & { rows: TranscriptRow[] };

export type TranscriptCursor = { sessionId: string; deltaCursor: string };

/** What Convex answers to an apply (absent on an older Convex). `ok:false` with
 *  `reason:"too_large"`: refused WHOLE, nothing written (convex/transcriptProjection.ts
 *  `MAX_APPLY_TEXT_*`). */
export type TranscriptApplyResult = {
  ok?: boolean;
  reason?: string;
  settledRuns?: unknown;
  /** PROJECTION `on` (final design step 2): the session's files waiting for their copy —
   *  the ones this apply recorded and any still pending (convex/transcriptFiles.ts). */
  filesToCopy?: unknown;
};

/** The row TEXT one Convex apply may carry (convex/transcriptProjection.ts
 *  `MAX_APPLY_TEXT_ROWS` = 40, `MAX_APPLY_TEXT_BYTES` = 4 MiB), with margin. A read's texts
 *  go ahead of it in `textsOnly` posts under these bounds, so the read itself carries
 *  identities only and Convex never holds more than one transaction can persist (codex
 *  phase 4 pass 6). */
export const TEXT_CHUNK_MAX_ROWS = 32;
export const TEXT_CHUNK_MAX_BYTES = 3 * 1024 * 1024;

/** What a row's content weighs for Convex's bound: UTF-8 of text, acknowledgment, error
 *  text and blocks (transcript-rows.ts `rowContentBytes`), plus the same envelope Convex
 *  charges (`textDocBytes`). */
export function rowTextBytes(r: RowContent): number {
  return rowContentBytes(r) + 128;
}

/** What a row SAYS (projection `on`): everything a `textsOnly` post carries ahead of its
 *  read. */
type RowContent = Pick<TranscriptRow, "text" | "yieldAck" | "errorMessage" | "blocks">;

const hasContent = (r: RowContent): boolean =>
  r.text !== undefined || r.yieldAck !== undefined || r.errorMessage !== undefined || r.blocks !== undefined;

/** The rows that carry a text, in order, in chunks under both bounds. A single row is a
 *  chunk of its own whatever it weighs (a row's text is already bounded at 32 KiB
 *  characters by `toTranscriptRow`, ~196 KB at most — far under the byte bound). */
export function chunkTextRows<R extends RowContent>(
  rows: readonly R[],
  maxRows: number = TEXT_CHUNK_MAX_ROWS,
  maxBytes: number = TEXT_CHUNK_MAX_BYTES,
): R[][] {
  const chunks: R[][] = [];
  let chunk: R[] = [];
  let bytes = 0;
  for (const r of rows) {
    if (!hasContent(r)) continue;
    const cost = rowTextBytes(r);
    if (chunk.length > 0 && (chunk.length >= maxRows || bytes + cost > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(r);
    bytes += cost;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** A row without what it shows (its identity), as a read posts it once its content went
 *  ahead. */
/** A `chat.message.get` reply (ChatMessageGetResultSchema, packages/gateway-protocol/src/
 *  schema/logs-chat.ts:238-244 at v2026.9.33), read defensively. */
function asPayload(x: unknown): { ok?: unknown; message?: unknown; unavailableReason?: unknown } | null {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as { ok?: unknown; message?: unknown; unavailableReason?: unknown })
    : null;
}

/** The full message the Control UI asks for a capped one (`DETAIL_FULL_MESSAGE_MAX_CHARS`,
 *  ui/src/pages/chat/chat-pane-sidebar-layout.ts:36 at v2026.9.33); Atrium's own row bound
 *  (ROW_TEXT_MAX_BYTES, 768 KiB) still applies to what comes back. */
export const FULL_MESSAGE_MAX_CHARS = 500_000;
/** Capped rows one read completes (each is one `chat.message.get`); the rest stay previews
 *  until a later read. */
export const MAX_CAPPED_PER_READ = 8;
/** Full rows a live reader keeps, to post them again when a read brings their preview back. */
const MAX_CAPPED_ROWS_KEPT = 16;
/** Row outcomes remembered for the whole process (0.101.3 review): a reader dies with its
 *  session after IDLE_SESSION_TTL_SECONDS, and a new one must not ask the gateway again
 *  for a row already completed — nor post its preview as if it were news. */
const MAX_CAPPED_OUTCOMES = 4096;
const CAPPED_OUTCOMES = new Map<string, "completed" | "failed">();
/** The sessions whose tail was scanned in this process (bounded like the outcomes). */
const MAX_TAIL_SCANS = 1024;
const TAIL_SCANNED = new Set<string>();

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  if (map.size >= max) map.delete(map.keys().next().value as K);
  map.set(key, value);
}

/** Tests only: a fresh process (no row outcome, no scanned tail remembered). */
export function resetCappedRowMemory(): void {
  CAPPED_OUTCOMES.clear();
  TAIL_SCANNED.clear();
}

export function withoutText<R extends RowContent & { blocksTruncated?: true }>(
  r: R,
): Omit<R, "text" | "yieldAck" | "errorMessage" | "blocks" | "blocksTruncated"> {
  const { text: _text, yieldAck: _ack, errorMessage: _err, blocks: _blocks, blocksTruncated: _cut, ...identity } = r;
  return identity;
}

/** Most files one answer hands over (Convex bounds its own list the same way). */
export const MAX_FILES_TO_COPY = 16;

/** The files Convex's answer asks to copy, read defensively (an older Convex sends none). */
export function readFilesToCopy(value: unknown): TranscriptFileToCopy[] {
  if (!Array.isArray(value)) return [];
  const out: TranscriptFileToCopy[] = [];
  for (const raw of value.slice(0, MAX_FILES_TO_COPY)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const str = (k: string): string | undefined => (typeof r[k] === "string" && r[k] !== "" ? (r[k] as string) : undefined);
    const fileId = str("fileId");
    const sessionKey = str("sessionKey");
    const kind = str("kind");
    const artifactId = str("artifactId");
    const mediaSource = str("mediaSource");
    if (fileId === undefined || sessionKey === undefined || kind === undefined) continue;
    if ((artifactId === undefined) === (mediaSource === undefined)) continue;
    const mimeType = str("mimeType");
    const label = str("label");
    out.push({
      fileId,
      sessionKey,
      kind,
      ...(artifactId !== undefined ? { artifactId } : {}),
      ...(mediaSource !== undefined ? { mediaSource } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(typeof r.sizeBytes === "number" && Number.isFinite(r.sizeBytes) ? { sizeBytes: r.sizeBytes } : {}),
      ...(label !== undefined ? { label } : {}),
      attempts: typeof r.attempts === "number" && Number.isFinite(r.attempts) ? r.attempts : 0,
    });
  }
  return out;
}

/** What the session-events demultiplexer delivers for ONE session key. */
export interface SessionEventListener {
  onSessionMessage(payload: Record<string, unknown>): void;
  onSessionsChanged(payload: Record<string, unknown>): void;
  /** The subscription is (re)established: events may have been missed before it. */
  onSubscribed(): void;
}

/** Where session events come from (session-events.ts `SessionEventsHub`). */
export interface SessionEventSource {
  /** Start delivering this session's events to `listener`; returns the detach. */
  attach(sessionKey: string, listener: SessionEventListener): () => void;
}

export interface TranscriptShadowDeps {
  chatId: string;
  sessionKey: string;
  /** One `chat.history` read: `cursor` null ⇒ a tail page; `inputRunIds` the sends whose
   *  custody the reply should report. Resolves to the reply payload. */
  readHistory: (
    cursor: string | null,
    opts?: { inputRunIds?: readonly string[] },
  ) => Promise<unknown>;
  /** PROJECTION `on` (0.101.3): one `chat.message.get` of this session — the full message a
   *  read capped for display (`isDisplayCapped`). Resolves to the reply payload. Absent ⇒
   *  capped rows stay the bounded preview, marked `capped`. */
  readMessage?: (messageId: string) => Promise<unknown>;
  /** The instance this conversation runs on: with `sessionKey`, the scope of what the
   *  process remembers about capped rows across readers (0.101.3). */
  instanceName?: string;
  /** Post one read to Convex. Resolves to Convex's answer when it gives one (phase 4:
   *  the runs the projection found over). */
  apply: (payload: TranscriptApply) => Promise<TranscriptApplyResult | void>;
  /** The session-events demultiplexer (phase 2). Absent ⇒ event triggers are off. */
  events?: SessionEventSource;
  /** The run in the foreground of this session's turn, if any (read-only). */
  foregroundRunId?: () => string | null;
  /** PROJECTION `on` (phase 4): every run the foreground turn owns — Convex names them
   *  again in its answer while they are over, so a lost answer is replayed by any read. */
  foregroundRunIds?: () => readonly string[];
  /** PROJECTION `on` (phase 3): every USER row read or received — the steer fact the
   *  live overlay cuts a run's bubble on (CU-20). Never awaited by the reconciler. */
  onUserRow?: (row: TranscriptRow) => void;
  /** PROJECTION `on`: the gateway says it will never run this input (cancelled, or
   *  asked after its ACK and holding no receipt for it). */
  onInputDropped?: (sendId: string) => void;
  /** PROJECTION `on` (phase 4): runs the transcript proved OVER (Convex's run table — a
   *  terminal, or a fresh read that found the session idle). A foreground turn among
   *  them ends here: a fact, never a timer. Never awaited by the reconciler. */
  onRunsSettled?: (runIds: readonly string[]) => void;
  /** PROJECTION `on` (final design step 2): files a row carries that Convex has no copy of
   *  yet — handed to the copier (core/artifact-copier.ts) the moment the row is stored.
   *  Never awaited by the reconciler. */
  copyFiles?: (files: readonly TranscriptFileToCopy[]) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

/** PROJECTION `on` (phase 4): a read that FAILED is asked again after these delays —
 *  nothing else might come to end a turn or release a queued send whose terminal read
 *  was lost. Bounded; a successful read resets the count. */
export const FAILED_READ_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 20_000];

/** Pending terminal observations kept between reads (a burst of runs is bounded). */
const MAX_PENDING_TERMINALS = 50;
/** Directly applied rows waiting for their post (one apply carries at most this many). */
const MAX_PENDING_LIVE_ROWS = 100;

type Custody = {
  /** `unconfirmed`: sent, no ACK yet. `accepted`: ACK `started`/`in_flight`/`ok`.
   *  `failed`: the ACK was an error — still asked about: whether the gateway holds an
   *  input Atrium believes failed is exactly what the guard measure checks. */
  state: "unconfirmed" | "accepted" | "failed";
};

export class TranscriptShadow {
  private mode: ProjectionMode = "off";
  private cursor: TranscriptCursor | null = null;
  /** Full rows this reader completed (bounded): a later read of their preview posts them
   *  again. Whether a row was asked at all is remembered process-wide (`CAPPED_OUTCOMES`). */
  private readonly completedRows = new Map<string, TranscriptRow>();
  private inFlight: Promise<void> | null = null;
  /** The reason of the read wanted next (null: none). Requests while a read is in flight
   *  collapse into ONE more read. */
  private readWanted: string | null = null;
  private closed = false;
  private pendingTerminals: TerminalObservation[] = [];
  /** Rows CU-16 admitted from `session.message`, by entry id, waiting for their post. */
  private readonly pendingLive = new Map<string, TranscriptRow>();
  /** The gateway session the live rows were published in (the event's snapshot). */
  private liveSessionId: string | null = null;
  /** Bumped by a session reset: a read issued before it never moves the cursor. */
  private epoch = 0;
  /** Sends whose custody is not settled — insertion-ordered, bounded. */
  private readonly custody = new Map<string, Custody>();
  /** Runs a visible durable row was read for — what ends a terminal recovery. */
  private readonly visibleRuns = new Set<string>();
  /** Runs whose bounded recovery is running (one per run, like the Control UI's claim). */
  private readonly recovering = new Set<string>();
  /** The last foreground run seen, and the last one whose terminal was observed
   *  (`lastLocalTerminalReconcile` in the Control UI) — CU-16's `finishingChatRunId`. */
  private lastForegroundRunId: string | null = null;
  private recentTerminalRunId: string | null = null;
  private detachEvents: (() => void) | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastReadAt = 0;
  /** Consecutive failed reads (projection `on`: drives the bounded re-read). */
  private failedReads = 0;
  /** Reads started, and the latest of them whose post Convex accepted (`readNow`). */
  private readsStarted = 0;
  private readsApplied = 0;
  private readonly log: (line: string) => void;
  /** Counters, for tests and the log line. */
  readonly stats = {
    reads: 0,
    applies: 0,
    failures: 0,
    resets: 0,
    sessionMessages: 0,
    sessionsChanged: 0,
    liveRows: 0,
    liveApplies: 0,
    textChunksSplit: 0,
    eventResets: 0,
    subscribed: 0,
  };

  constructor(private readonly deps: TranscriptShadowDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** The projection is doing something on this session. The reconciler itself never
   *  writes a bubble; its facts also feed the live overlay (`onUserRow` /
   *  `onInputDropped`). */
  get active(): boolean {
    return !this.closed && this.mode !== "off";
  }

  /** The sends whose custody the next read asks about (tests, diagnostics). */
  get inputRunIds(): string[] {
    return [...this.custody.keys()].slice(-INPUT_RUN_IDS_MAX).sort();
  }

  /**
   * Switch the reconciler on with the cursor Convex stored, as carried by a `/send` (or
   * none, for a `/resume`). The first switch-on triggers a read (a tail page when no
   * cursor is known yet) — the Control UI's own "pane opened" read — and attaches the
   * session to the session-events connection.
   */
  configure(opts: { cursor?: TranscriptCursor | null }): void {
    if (this.closed) return;
    const wasActive = this.mode !== "off";
    this.mode = "on";
    // Convex's cursor is adopted only when this process holds none: a live process is
    // never behind the store it writes to.
    if (this.cursor === null && opts.cursor) this.cursor = { ...opts.cursor };
    if (!wasActive) {
      this.attach();
      this.requestRead("configured");
    }
  }

  /** A `chat.send` is about to leave with this send identity: until the gateway settles
   *  it, every read asks about it (the Control UI includes unconfirmed sends,
   *  chat-pending-inputs.ts:200-202). */
  noteSend(sendId: string | null | undefined): void {
    if (!this.active || typeof sendId !== "string") return;
    if (sendId.length === 0 || sendId.length > INPUT_RUN_ID_MAX_CHARS) return;
    this.custody.delete(sendId);
    this.custody.set(sendId, { state: "unconfirmed" });
    while (this.custody.size > INPUT_RUN_IDS_MAX) {
      const oldest = this.custody.keys().next().value as string;
      this.custody.delete(oldest);
    }
  }

  /** The `chat.send` ACK. Only `ok` asks for a read (the reply is in the transcript);
   *  `started`/`in_flight` are custody, not persistence (docs/web/webchat.md:55-56). */
  noteAck(status: unknown, sendId?: string | null): void {
    if (!this.active) return;
    if (typeof sendId === "string") {
      const c = this.custody.get(sendId);
      if (c !== undefined) {
        const accepted = status === "started" || status === "in_flight" || status === "ok";
        c.state = accepted ? "accepted" : "failed";
      }
    }
    if (status !== "ok") return;
    this.requestRead("ack_ok");
  }

  /**
   * Observe a frame of the conversation socket. Only a TERMINAL `chat` frame of THIS
   * session counts — of any run, foreign or ours (CU-6: the session is the only filter).
   * Read-only: the frame continues to the turn pipeline untouched.
   */
  observeFrame(frame: GatewayFrame): void {
    if (!this.active) return;
    const foreground = this.deps.foregroundRunId?.() ?? null;
    if (foreground !== null) this.lastForegroundRunId = foreground;
    if (frame.type !== "event" || frame.event !== "chat") return;
    const payload = frame.payload as Record<string, unknown> | undefined;
    if (payload === undefined || payload.sessionKey !== this.deps.sessionKey) return;
    const runId = typeof payload.runId === "string" && payload.runId !== "" ? payload.runId : null;
    if (runId === null) return;
    const status = runTerminalStatus(payload);
    if (status === null) return;
    if (runId === this.lastForegroundRunId) this.recentTerminalRunId = runId;
    const emptyFinal = payload.state === "final" && payload.message === undefined;
    this.pendingTerminals.push({
      runId,
      status,
      ...(emptyFinal ? { emptyFinal: true as const } : {}),
      at: this.now(),
    });
    if (this.pendingTerminals.length > MAX_PENDING_TERMINALS) {
      this.pendingTerminals.splice(0, this.pendingTerminals.length - MAX_PENDING_TERMINALS);
    }
    if (emptyFinal) void this.recoverTerminal(runId);
    else this.requestRead("terminal");
  }

  /**
   * A `session.message` of this session (dedicated session-events connection). CU-16
   * decides whether its row is applied now; the read that follows is the Control UI's
   * `handleSessionMessageEvent` (chat-state-events.ts:128-202 at v2026.9.8): with a run
   * in the foreground and the session still active, only a USER row re-reads (custody
   * changed); otherwise the session is reconciled from the transcript.
   */
  onSessionMessage(payload: Record<string, unknown>): void {
    if (!this.active) return;
    this.stats.sessionMessages++;
    const foreground = this.deps.foregroundRunId?.() ?? null;
    if (foreground !== null) this.lastForegroundRunId = foreground;
    const admission = admitLiveRow(payload, {
      activeRunId: foreground,
      recentTerminalRunId: this.recentTerminalRunId,
      ...this.displayOpt(),
    });
    if (admission.admitted && admission.row !== null) {
      const sessionId =
        typeof payload.sessionId === "string" && payload.sessionId !== "" ? payload.sessionId : null;
      if (sessionId !== null && this.liveSessionId !== null && sessionId !== this.liveSessionId) {
        // Rows of two gateway sessions never ride one post.
        this.pendingLive.clear();
      }
      if (sessionId !== null) this.liveSessionId = sessionId;
      this.pendingLive.set(admission.row.entryId, admission.row);
      this.stats.liveRows++;
      while (this.pendingLive.size > MAX_PENDING_LIVE_ROWS) {
        const oldest = this.pendingLive.keys().next().value as string;
        this.pendingLive.delete(oldest);
      }
    }
    const isUser = admission.role === "user";
    if (isUser && admission.row !== null) this.emitUserRow(admission.row);
    if (foreground !== null && admission.hasActiveRun === true && !isUser) {
      // The turn is live: its rows reach the store by the read its terminal triggers.
      this.pump();
      return;
    }
    this.requestRead(isUser ? "event:user_row" : "event:message");
  }

  /** A `sessions.changed` of this session (`classifySessionsChanged`). */
  onSessionsChanged(payload: Record<string, unknown>): void {
    if (!this.active) return;
    this.stats.sessionsChanged++;
    const action = classifySessionsChanged(payload);
    if (action.reset) {
      // `sessionReset`: the old transcript's cursor and live rows name nothing in the
      // new one (chat-state-events.ts:372-377).
      this.stats.eventResets++;
      this.epoch++;
      this.cursor = null;
      this.pendingLive.clear();
      this.liveSessionId = null;
    }
    if (action.read) this.requestRead(`event:${action.why}`);
  }

  /** The session-events subscription is (re)established: what happened while it was
   *  down is in the transcript (the Control UI reads history after `subscriptionReady`,
   *  chat-history-stream.ts at v2026.9.7+). */
  onSubscribed(): void {
    if (!this.active) return;
    this.stats.subscribed++;
    this.requestRead("event:subscribed");
  }

  /** PROJECTION `on` (phase 4): the foreground turn's runs, for Convex to answer about. */
  private foregroundOpt(): { foregroundRunIds?: string[] } {
    if (this.mode !== "on") return {};
    const ids = (this.deps.foregroundRunIds?.() ?? []).filter((x) => x !== "").slice(0, 10);
    return ids.length > 0 ? { foregroundRunIds: [...ids] } : {};
  }

  /** Rows carry what they say (text, blocks, display order). */
  private displayOpt(): { display?: RowDisplay } {
    return this.mode === "on" ? { display: { sessionKey: this.deps.sessionKey } } : {};
  }

  private emitSettled(res: TranscriptApplyResult | void): void {
    if (this.mode !== "on" || res === undefined || res === null) return;
    const ids = Array.isArray(res.settledRuns)
      ? res.settledRuns.filter((x): x is string => typeof x === "string" && x !== "").slice(0, 100)
      : [];
    if (ids.length === 0) return;
    try {
      this.deps.onRunsSettled?.(ids);
    } catch {
      /* the overlay's bookkeeping never fails a read */
    }
  }

  /** PROJECTION `on`: hand the files Convex's answer names to the copier. */
  private emitFiles(res: TranscriptApplyResult | void): void {
    if (this.mode !== "on" || res === undefined || res === null) return;
    const files = readFilesToCopy(res.filesToCopy);
    if (files.length === 0) return;
    try {
      this.deps.copyFiles?.(files);
    } catch {
      /* the copier's bookkeeping never fails a read */
    }
  }

  private emitUserRow(row: TranscriptRow): void {
    if (row.sendId === undefined) return;
    try {
      this.deps.onUserRow?.(row);
    } catch {
      /* the overlay's bookkeeping never fails a read */
    }
  }

  /** Stop everything: the connection is gone. */
  close(): void {
    this.closed = true;
    this.pendingTerminals = [];
    this.pendingLive.clear();
    this.custody.clear();
    this.detach();
  }

  /** Resolves when no read is in flight or chained (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
  }

  /**
   * Ask for a read and resolve whether one STARTED after this call was READ AND APPLIED
   * (0.102.1, Codex pass 7): a run is closed only on the gateway's proof applied, never on
   * a read that merely finished — `idle()` says the reads are done, not that they worked.
   * The caller bounds the wait; a failed read's own retry is not awaited.
   */
  async readNow(reason: string): Promise<boolean> {
    const target = this.readsStarted + 1;
    this.requestRead(reason);
    await this.idle();
    return this.readsApplied >= target;
  }

  /** Ask for a read: joins the one in flight by chaining ONE more behind it. */
  requestRead(reason: string): void {
    if (!this.active) return;
    if (this.readWanted === null) this.readWanted = reason;
    this.pump();
  }

  private attach(): void {
    if (this.detachEvents !== null || this.deps.events === undefined) return;
    const listener: SessionEventListener = {
      onSessionMessage: (p) => this.onSessionMessage(p),
      onSessionsChanged: (p) => this.onSessionsChanged(p),
      onSubscribed: () => this.onSubscribed(),
    };
    try {
      this.detachEvents = this.deps.events.attach(this.deps.sessionKey, listener);
    } catch (err) {
      this.log(
        `[transcript] chat=${this.deps.chatId} session events unavailable (non-fatal): ${
          errForLog(err)
        }`,
      );
    }
  }

  private detach(): void {
    const detach = this.detachEvents;
    this.detachEvents = null;
    detach?.();
  }

  /** Run the single flight: reads first (they are the authority), then the directly
   *  applied rows a read did not already bring. */
  private pump(): void {
    if (this.inFlight !== null || !this.active) return;
    if (this.readWanted === null && this.pendingLive.size === 0) return;
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (!this.active) return;
      if (this.readWanted !== null) {
        const why = this.readWanted;
        this.readWanted = null;
        await this.readOnce(why);
        continue;
      }
      if (this.pendingLive.size > 0) {
        await this.postLive();
        continue;
      }
      return;
    }
  }

  /** CU-13: a final without a message → read, then up to four more reads at
   *  100/400/1500/3000 ms, stopping once a visible row of the run was read. */
  private async recoverTerminal(runId: string): Promise<void> {
    if (this.recovering.has(runId)) return;
    this.recovering.add(runId);
    try {
      for (let attempt = 0; ; attempt++) {
        if (!this.active || this.visibleRuns.has(runId)) return;
        this.requestRead(`recover:${attempt}`);
        await this.idle();
        if (!this.active || this.visibleRuns.has(runId)) return;
        const delay = TERMINAL_RECOVERY_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.log(
            `[transcript] chat=${this.deps.chatId} run ${runId} ended with no message and no visible row after ${attempt + 1} reads — nothing to show (CU-13)`,
          );
          return;
        }
        await this.sleep(delay);
      }
    } finally {
      this.recovering.delete(runId);
    }
  }

  private async readOnce(reason: string): Promise<void> {
    let read: HistoryRead | null = null;
    const epoch = this.epoch;
    const seq = ++this.readsStarted;
    try {
      this.stats.reads++;
      let readAt = this.nextReadAt();
      let asked = this.inputRunIds;
      // The sends ALREADY acknowledged when this read leaves: only for them can a reply
      // without a receipt mean absence. Taken as a set, never as a time — the read's
      // stamp is synthetic and the ACK's would come from a clock that can repeat a
      // millisecond or go back.
      let ackedBefore = this.ackedNow();
      read = parseHistoryReply(
        await this.deps.readHistory(this.cursor?.deltaCursor ?? null, { inputRunIds: asked }),
        this.displayOpt().display,
      );
      if (read === null) {
        this.stats.failures++;
        this.log(`[transcript] chat=${this.deps.chatId} unreadable chat.history reply (${reason})`);
        return;
      }
      if (read.kind === "reset") {
        // A normal cursor discontinuity (logs-chat.ts `ChatHistoryResetResultSchema`):
        // record it, drop the cursor, and take a fresh tail page in the SAME read.
        this.stats.resets++;
        await this.post(read, readAt, asked, ackedBefore, epoch);
        this.cursor = null;
        this.stats.reads++;
        readAt = this.nextReadAt();
        asked = this.inputRunIds;
        ackedBefore = this.ackedNow();
        read = parseHistoryReply(
          await this.deps.readHistory(null, { inputRunIds: asked }),
          this.displayOpt().display,
        );
        if (read === null || read.kind === "reset") {
          this.stats.failures++;
          return;
        }
      }
      read = await this.completeCapped(read);
      await this.post(read, readAt, asked, ackedBefore, epoch);
      this.readsApplied = Math.max(this.readsApplied, seq);
      this.failedReads = 0;
      await this.scanCappedTail(epoch);
    } catch (err) {
      this.stats.failures++;
      this.log(
        `[transcript] chat=${this.deps.chatId} read failed (${reason}, non-fatal): ${
          errForLog(err)
        }`,
      );
      this.retryFailedRead();
    }
  }

  /**
   * THE FULL TEXT OF A CAPPED ROW (0.101.3, prod feedback prod-ms71ea7g…, 2026-10-19: a long
   * answer shown cut at 8 000 characters). `chat.history` bounds each text to 8 000
   * characters and marks the message `__openclaw.truncated`; the rows of a read are then the
   * preview, and the bubble that the rows decide was cut for good. As the Control UI does
   * (chat-message-recovery.ts:30-41, chat-pane-sidebar-layout.ts:262-279), the full message is
   * asked by `chat.message.get` (`operator.read`, src/gateway/methods/core-descriptors.ts:367;
   * handler src/gateway/server-methods/chat-message-get-handler.ts:88-262), and the row
   * rebuilt from it replaces the preview when it is the same row (same `entryId`, same
   * `seq`) and fits Atrium's bound. Once per row and version: a failure, a refusal
   * (`not_found` / `oversized` / `not_visible`) or a row over the bound keeps the preview,
   * marked `capped`, and is never asked again.
   */
  private async completeCapped(read: HistoryRead): Promise<HistoryRead> {
    const refs = read.capped ?? [];
    if (this.mode !== "on" || refs.length === 0) return read;
    const rows = [...read.rows];
    const at = new Map(rows.map((r, i) => [r.entryId, i]));
    for (const ref of refs.slice(0, MAX_CAPPED_PER_READ)) {
      const i = at.get(ref.entryId);
      if (i === undefined) continue;
      const full = await this.completion(ref);
      if (full !== null) rows[i] = { ...full, ...(rows[i]!.segmentOrder !== undefined ? { segmentOrder: rows[i]!.segmentOrder } : {}) };
    }
    return { ...read, rows };
  }

  /** This conversation's scope in the process-wide memory: its instance and session key. */
  private scope(): string {
    return `${this.deps.instanceName ?? ""}\u0000${this.deps.sessionKey}`;
  }

  /** The process-wide key of one row version. */
  private outcomeKey(ref: Pick<CappedRef, "entryId" | "seq">): string {
    return `${this.scope()}\u0000${ref.entryId}\u0000${ref.seq}`;
  }

  /** One capped row's full version, asked once per process (`CAPPED_OUTCOMES`); null: keep
   *  the preview — which Convex never lets replace a whole text of the same row version
   *  (convex/transcriptProjection.ts `storedWhole`), so a row completed by an earlier
   *  reader stays whole. */
  private async completion(ref: CappedRef): Promise<TranscriptRow | null> {
    const key = this.outcomeKey(ref);
    const kept = this.completedRows.get(key);
    if (kept !== undefined) return kept;
    if (CAPPED_OUTCOMES.has(key)) return null;
    let full: TranscriptRow | null = null;
    if (this.deps.readMessage !== undefined) {
      try {
        const payload = asPayload(await this.deps.readMessage(ref.entryId));
        if (payload?.ok === true && payload.message !== undefined) {
          const { display } = this.displayOpt();
          let row = toTranscriptRow(payload.message, ref.envelope, display);
          // Still capped at FULL_MESSAGE_MAX_CHARS: the longer preview, told as cut.
          if (row !== null && isDisplayCapped(payload.message)) row = capDisplayedRow(row);
          if (row !== null && row.entryId === ref.entryId && row.seq === ref.seq && row.text !== undefined) full = row;
        } else {
          this.log(
            `[transcript] chat=${this.deps.chatId} capped row ${ref.entryId} not recovered (${String(payload?.unavailableReason ?? "no message")}) — the preview stays, marked cut`,
          );
        }
      } catch (err) {
        this.log(
          `[transcript] chat=${this.deps.chatId} capped row ${ref.entryId} not recovered: ${errForLog(err)} — the preview stays, marked cut`,
        );
      }
    }
    remember(CAPPED_OUTCOMES, key, full !== null ? "completed" : "failed", MAX_CAPPED_OUTCOMES);
    if (full !== null) remember(this.completedRows, key, full, MAX_CAPPED_ROWS_KEPT);
    return full;
  }

  /**
   * ROWS STORED CAPPED BEFORE 0.101.3: a conversation resumes by its stored cursor, so a
   * read never brings them back. Once per process and session, the tail page is read (the
   * page the Control UI reads when it opens a conversation) for its capped rows only, and
   * those — completed, or stripped and marked cut — are posted as texts, which updates the
   * stored rows and re-projects their bubbles (`postTexts`). Nothing else of the page is
   * posted. Non-fatal.
   */
  private async scanCappedTail(epoch: number): Promise<void> {
    if (TAIL_SCANNED.has(this.scope()) || this.mode !== "on" || this.deps.readMessage === undefined) return;
    TAIL_SCANNED.delete(this.scope());
    if (TAIL_SCANNED.size >= MAX_TAIL_SCANS) TAIL_SCANNED.delete(TAIL_SCANNED.values().next().value as string);
    TAIL_SCANNED.add(this.scope());
    try {
      const page = parseHistoryReply(await this.deps.readHistory(null, {}), this.displayOpt().display);
      // Only the rows no read of this process handled (a read that brought them completed
      // and posted them already).
      const fresh = (page?.capped ?? []).filter((c) => !CAPPED_OUTCOMES.has(this.outcomeKey(c)));
      if (page === null || page.kind === "reset" || fresh.length === 0) return;
      const sessionId = page.sessionId ?? this.cursor?.sessionId ?? "";
      if (epoch !== this.epoch || (this.cursor !== null && sessionId !== this.cursor.sessionId)) return;
      const ids = new Set(fresh.map((c) => c.entryId));
      const completed = await this.completeCapped({ ...page, capped: fresh });
      // Only rows really completed: a preview is never posted by the scan (0.101.3 review).
      const rows = completed.rows.filter(
        (r) => ids.has(r.entryId) && !(r.blocks ?? []).some((b) => b.type === "text" && b.capped === true),
      );
      if (rows.length > 0) await this.postTexts(sessionId, rows, this.nextReadAt());
    } catch (err) {
      this.log(`[transcript] chat=${this.deps.chatId} capped-row tail scan failed (non-fatal): ${errForLog(err)}`);
    }
  }

  /** PROJECTION `on` (phase 4): ask again after a failed read, a bounded number of times
   *  (FAILED_READ_RETRY_DELAYS_MS). Detached: the single flight is not held. */
  private retryFailedRead(): void {
    if (this.mode !== "on") return;
    const delay = FAILED_READ_RETRY_DELAYS_MS[this.failedReads];
    this.failedReads++;
    if (delay === undefined) return;
    void this.sleep(delay).then(() => this.requestRead("retry"));
  }

  /** The sends whose ACK has been observed (accepted or refused) — snapshotted when a
   *  read is issued. */
  private ackedNow(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const [id, c] of this.custody) if (c.state !== "unconfirmed") out.add(id);
    return out;
  }

  /** The issue time of a read, STRICTLY increasing: Convex lets an older read (a POST
   *  that timed out here and still committed there) merge its rows but never move the
   *  cursor or the session back (convex/transcriptProjection.ts `readAt`). */
  private nextReadAt(): number {
    this.lastReadAt = Math.max(this.now(), this.lastReadAt + 1);
    return this.lastReadAt;
  }

  /** What the read says about the sends it asked about: the ones it settled, and the
   *  ones the gateway — asked after their ACK — holds no receipt for (reported ABSENT
   *  once). PURE: custody is only released once the read is STORED (`post`), so a failed
   *  write asks again and re-proves the absence instead of losing it. */
  private settleCustody(
    read: HistoryRead,
    asked: readonly string[],
    ackedBefore: ReadonlySet<string>,
  ): { settled: Set<string>; absent: string[]; unreadable: string[] } {
    const settled = new Set<string>();
    for (const row of read.rows) {
      if (row.role === "user" && row.sendId !== undefined) settled.add(row.sendId);
    }
    const receiptIds = new Set<string>();
    for (const r of read.inputReceipts ?? []) {
      receiptIds.add(r.runId);
      if (r.state === "consumed" || r.cancelled === true) settled.add(r.runId);
    }
    for (const item of read.pendingInputs?.items ?? []) {
      if (item.runId !== undefined && item.state === "cancelled") settled.add(item.runId);
    }
    // A receipt Atrium could not interpret is an OBSERVATION, never an absence: its id
    // stays in custody and is reported unreadable. A receipt with no usable id makes
    // every asked id of this read unprovable (any of them may be the one it names).
    const unreadable = new Set<string>(read.unreadableReceipts.ids.filter((id) => asked.includes(id)));
    if (read.unreadableReceipts.unattributed > 0) {
      for (const id of asked) if (!receiptIds.has(id) && !settled.has(id)) unreadable.add(id);
    }
    for (const id of unreadable) receiptIds.add(id);
    const absent: string[] = [];
    if (read.inputReceipts !== null) {
      for (const id of asked) {
        const c = this.custody.get(id);
        if (c === undefined || receiptIds.has(id) || settled.has(id)) continue;
        if (ackedBefore.has(id)) {
          absent.push(id);
          settled.add(id);
        }
      }
    }
    return { settled, absent, unreadable: [...unreadable] };
  }

  private async post(
    read: HistoryRead,
    readAt: number,
    asked: readonly string[],
    ackedBefore: ReadonlySet<string>,
    epoch: number,
  ): Promise<void> {
    const terminals = this.pendingTerminals;
    this.pendingTerminals = [];
    const sessionId = read.sessionId ?? this.cursor?.sessionId ?? "";
    // A different gateway session (reset, rotation): its seq restarts, the old cursor
    // means nothing there.
    if (this.cursor !== null && read.sessionId !== null && read.sessionId !== this.cursor.sessionId) {
      this.cursor = null;
    }
    const { settled, absent, unreadable } = this.settleCustody(read, asked, ackedBefore);
    for (const state of read.unreadableReceipts.states) {
      protocolDrift.observeUnknownValue("chat.history.inputReceipts.state", state);
    }
    const payload: TranscriptApply = {
      chatId: this.deps.chatId,
      sessionKey: this.deps.sessionKey,
      sessionId,
      kind: read.kind,
      ...(read.deltaCursor === null ? {} : { deltaCursor: read.deltaCursor }),
      // Identities only: what the rows SAY went ahead in persistable chunks (below).
      rows: read.rows.map((r) => withoutText(r) as TranscriptRow),
      terminals,
      ...(read.activeRunIds === null ? {} : { activeRunIds: read.activeRunIds }),
      ...(read.hasActiveRun === null ? {} : { hasActiveRun: read.hasActiveRun }),
      ...(read.lastRunFailure !== undefined ? { lastRunFailure: read.lastRunFailure } : {}),
      ...(read.queueMode === null ? {} : { queueMode: read.queueMode }),
      ...(read.effectiveQueueMode === null ? {} : { effectiveQueueMode: read.effectiveQueueMode }),
      unidentified: read.unidentified,
      readAt,
      ...(asked.length > 0 ? { inputRunIds: [...asked] } : {}),
      ...this.foregroundOpt(),
      ...(read.pendingInputs === null ? {} : { pendingInputs: read.pendingInputs }),
      ...(read.inputReceipts === null ? {} : { inputReceipts: read.inputReceipts }),
      ...(absent.length > 0 ? { inputAbsent: absent } : {}),
      ...(unreadable.length > 0 ? { inputUnreadable: unreadable } : {}),
    };
    try {
      // THE TEXTS FIRST, each chunk persisted before the next is sent, the read last: a
      // failure anywhere throws before the read — the cursor never moves past a row whose
      // text was not stored (codex phase 4 pass 6).
      await this.postTexts(sessionId, read.rows, readAt);
      const answer = await this.deps.apply(payload);
      // A read Convex refused as too large stored NOTHING: its cursor must not be kept.
      if (answer !== undefined && answer.ok === false && answer.reason === "too_large") {
        throw new Error("read refused as too large");
      }
      this.emitSettled(answer);
      this.emitFiles(answer);
      this.stats.applies++;
    } catch (err) {
      // The read is lost, not the terminals nor the custody it would have settled: the
      // terminals ride the next apply, and the sends stay asked about.
      this.pendingTerminals = [...terminals, ...this.pendingTerminals].slice(-MAX_PENDING_TERMINALS);
      throw err;
    }
    for (const id of settled) this.custody.delete(id);
    for (const row of read.rows) {
      if (row.role === "user") this.emitUserRow(row);
      // A row the read brought needs no direct post of its own.
      this.pendingLive.delete(row.entryId);
      if (row.runId !== undefined && !row.hidden && (row.visible || row.role === "toolresult")) {
        this.visibleRuns.add(row.runId);
      }
    }
    if (this.visibleRuns.size > 500) {
      // Bounded memory: the oldest runs are long settled.
      const keep = [...this.visibleRuns].slice(-250);
      this.visibleRuns.clear();
      for (const id of keep) this.visibleRuns.add(id);
    }
    // Inputs the gateway will never run: no run is coming to answer them.
    const dropped = new Set<string>(absent);
    for (const r of read.inputReceipts ?? []) if (r.cancelled === true) dropped.add(r.runId);
    for (const item of read.pendingInputs?.items ?? []) {
      if (item.runId !== undefined && item.state === "cancelled") dropped.add(item.runId);
    }
    for (const id of dropped) {
      try {
        this.deps.onInputDropped?.(id);
      } catch {
        /* the overlay's bookkeeping never fails a read */
      }
    }
    // A read issued before a session reset never moves the cursor of the new session.
    if (read.deltaCursor !== null && epoch === this.epoch) {
      this.cursor = { sessionId, deltaCursor: read.deltaCursor };
    }
  }

  /** Post what `rows` SAY, ahead of their read, in `textsOnly` chunks Convex can persist
   *  (`chunkTextRows`). A chunk Convex still refuses as too large (a Convex with tighter
   *  bounds than this bridge) is split in two and posted again; a single row refused alone
   *  is left without its text — its bubble keeps the live text, never a cut or wrong one.
   *  Any other refusal or failure throws: the caller's read is then not posted. */
  private async postTexts(sessionId: string, rows: readonly TranscriptRow[], readAt: number): Promise<void> {
    const queue = chunkTextRows(rows);
    // The CUT rows (user rows steered into a run) ride the first chunk, before any text:
    // a text's steer segment is then known when Convex stores it, so a text of a deleted
    // segment is never stored as another segment's (codex phase 4 pass 9).
    const cuts = rows.filter((r) => r.role === "user" && r.steerTargetRunId !== undefined);
    if (queue.length > 0 && cuts.length > 0) queue[0] = [...cuts, ...queue[0]!];
    while (queue.length > 0) {
      const chunk = queue.shift()!;
      const res = await this.deps.apply({
        chatId: this.deps.chatId,
        sessionKey: this.deps.sessionKey,
        sessionId,
        kind: "live",
        textsOnly: true,
        rows: chunk,
        terminals: [],
        unidentified: 0,
        readAt,
      });
      this.emitFiles(res);
      if (res !== undefined && res.ok === false) {
        if (res.reason !== "too_large") {
          throw new Error(`texts refused: ${res.reason ?? "unknown"}`);
        }
        this.stats.textChunksSplit++;
        if (chunk.length > 1) {
          const half = Math.ceil(chunk.length / 2);
          queue.unshift(chunk.slice(0, half), chunk.slice(half));
        } else {
          this.log(
            `[transcript] chat=${this.deps.chatId} one row's text refused as too large — its bubble keeps the live text`,
          );
        }
      }
    }
  }

  /** Post the rows CU-16 admitted (kind `live`): rows only — Convex moves no cursor, no
   *  floor and no session state for them (convex/transcriptProjection.ts). A failure
   *  drops them: the read the same event asked for brings them back. */
  private async postLive(): Promise<void> {
    const all = [...this.pendingLive.values()];
    this.pendingLive.clear();
    const sessionId = this.liveSessionId ?? this.cursor?.sessionId ?? "";
    // Over one apply's text bounds: the texts go ahead in chunks, the post carries the
    // identities (the same rule as a read's).
    const oversized = chunkTextRows(all).length > 1;
    const rows = oversized ? all.map((r) => withoutText(r) as TranscriptRow) : all;
    const payload: TranscriptApply = {
      chatId: this.deps.chatId,
      sessionKey: this.deps.sessionKey,
      sessionId,
      kind: "live",
      rows,
      terminals: [],
      unidentified: 0,
      readAt: this.nextReadAt(),
      ...this.foregroundOpt(),
    };
    try {
      if (oversized) await this.postTexts(sessionId, all, payload.readAt);
      const answer = await this.deps.apply(payload);
      this.emitSettled(answer);
      this.emitFiles(answer);
      this.stats.liveApplies++;
      for (const row of rows) {
        if (row.runId !== undefined && !row.hidden && (row.visible || row.role === "toolresult")) {
          this.visibleRuns.add(row.runId);
        }
      }
    } catch (err) {
      this.stats.failures++;
      this.log(
        `[transcript] chat=${this.deps.chatId} live rows post failed (non-fatal, the read brings them): ${
          errForLog(err)
        }`,
      );
    }
  }
}
