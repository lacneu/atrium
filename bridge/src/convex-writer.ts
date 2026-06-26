// Maps normalized bridge events onto the INTERNAL Convex stream mutations.
//
// Why an HTTP ingest endpoint and NOT a deploy-key client:
//   `internal.stream.*` are internalMutations — not callable from a browser and
//   not callable from the public `ConvexHttpClient` (admin auth is a private,
//   untyped CLI-only path). The supported server->Convex pattern is to POST to
//   an authenticated httpAction that holds the secret and runs the internal
//   mutations via `ctx.runMutation`. The bridge therefore speaks to ONE Convex
//   ingest endpoint (convex/bridge_ingest.ts) with a Bearer secret.
//
// The `ConvexWriter` INTERFACE is the load-bearing seam: run-manager depends on
// it, the live HTTP writer implements it, and the test substitutes a fake that
// records the calls. Keeping media resolution behind the interface means the
// fake records `addMedia` without touching the filesystem or Convex storage.

import { Readable } from "node:stream";
import { MEDIA_TOO_LARGE_CODE, type MediaFetcher } from "./core/media-fetcher.js";

/** Mirrors convex/schema.ts messagePart `tool` variant. */
export interface ToolPart {
  kind: "tool";
  name: string;
  phase: string;
  input?: unknown;
  output?: unknown;
}

/** Mirrors convex/schema.ts messagePart `reasoning` variant. */
export interface ReasoningPart {
  kind: "reasoning";
  text: string;
}

// The provenance part shape lives in core/provenance.ts (pure contract module).
export type { ProvenancePart } from "./core/provenance.js";

export type FinalizeStatus = "complete" | "error" | "aborted";

/**
 * The seam between the run-manager and Convex. Each method maps 1:1 onto an
 * internal stream mutation (see convex/stream.ts). All calls MUST be awaited in
 * order by the run-manager so appendDelta ordering is deterministic.
 */
export interface ConvexWriter {
  /** run start -> internal.stream.startAssistant; returns the new message id. */
  startAssistant(chatId: string, runId: string | null): Promise<string>;
  /** message.delta -> internal.stream.appendDelta. */
  appendDelta(messageId: string, text: string): Promise<void>;
  /** message.snapshot -> internal.stream.setSnapshot. */
  setSnapshot(messageId: string, text: string): Promise<void>;
  /** tool.status -> internal.stream.addPart(kind:tool). */
  addToolPart(messageId: string, part: ToolPart): Promise<void>;
  /** plugin provenance report -> internal.stream.addPart(kind:provenance). */
  addProvenancePart(
    messageId: string,
    part: import("./core/provenance.js").ProvenancePart,
  ): Promise<void>;
  /**
   * media -> fetch bytes for `path`, store in Convex storage, then
   * internal.stream.addPart(kind:media,storageId). Resolution is behind the
   * interface so the fake can record it without I/O.
   */
  addMedia(
    messageId: string,
    media: { filename: string; path: string; mimeType?: string },
  ): Promise<void>;
  /** media.undelivered -> a SOC2-safe `openclaw.media` dropped diagnostic (NO part):
   *  the agent generated media (codex imageGeneration) but the turn delivered none. */
  noteMediaUndelivered(messageId: string): Promise<void>;
  /** message.final -> internal.stream.finalize. */
  finalize(
    messageId: string,
    status: FinalizeStatus,
    text: string,
    error: string | null,
  ): Promise<void>;
  /**
   * Session re-hydration: a bounded block of this chat's prior turns (excluding
   * `excludeMessageId`), or null when there is nothing to inject. The bridge
   * prepends it to chat.send when it detects a fresh/rolled OpenClaw session, so
   * the model regains the conversation the webchat displays. Read-only; behind
   * the interface so the fake can stub it without I/O.
   */
  getRehydrationContext(
    chatId: string,
    excludeMessageId?: string | null,
  ): Promise<{ history: string | null; turnCount: number }>;
  /**
   * Mirror the gateway session meta onto the chat (LIVE model/reasoning/context
   * for the header strip). Fire-and-forget at the call site: never block or fail
   * a turn on a meta write.
   */
  reportSessionMeta(chatId: string, meta: SessionMetaReport): Promise<void>;
}

/** Operations the Convex ingest httpAction understands (its JSON `op` field). */
/**
 * OpenClaw `sessions.describe` meta the bridge mirrors to Convex (non-secret knob
 * labels + token counts) so the chat header can render the model/reasoning chips
 * + context meter from LIVE gateway state. Every field optional (a fresh session
 * omits the token counts). Matches the `setSessionMeta` ingest op shape.
 */
export interface SessionMetaReport {
  model?: string;
  modelProvider?: string;
  agentRuntime?: string;
  thinkingLevel?: string;
  thinkingDefault?: string;
  thinkingLevels?: { id: string; label: string }[];
  // Available models for the write-back picker (deduped by id from models.list).
  availableModels?: { id: string; label: string }[];
  verboseLevel?: string;
  totalTokens?: number;
  contextTokens?: number;
  estimatedCostUsd?: number;
}

// Delivery-recorder tags, present only while a turn is being recorded (learned once
// per turn from the startAssistant ack). recSessionId is the turn's recording session
// (Convex correlates the delta by the timing row's _id and records only if this still
// matches the active session); bridgeRecvAt (t0) + bridgeSentAt (t1) bound the
// single-clock bridge-internal segment; bridgeSentAt (t1) + bridgeSkew feed segment A;
// sizeBytes is the flush size in UTF-8 bytes. See convex/deliveryTiming.ts.
interface RecTags {
  recSessionId?: string;
  bridgeRecvAt?: number;
  bridgeSentAt?: number;
  bridgeSkew?: number;
  sizeBytes?: number;
}

type IngestOp =
  | { op: "startAssistant"; chatId: string; runId: string | null }
  // Delivery recorder clock calibration: a lightweight round-trip (no server writes)
  // so the measured RTT is free of server work -> a clean skew. See deliveryTiming.ts.
  | { op: "calibrate" }
  | ({ op: "appendDelta"; messageId: string; text: string } & RecTags)
  | ({ op: "setSnapshot"; messageId: string; text: string } & RecTags)
  | {
      op: "addPart";
      messageId: string;
      part: ToolPart | import("./core/provenance.js").ProvenancePart;
    }
  // Outbound media is a 3-step, base64-free flow (Convex upload URL pattern):
  //   1. getUploadUrl -> Convex `ctx.storage.generateUploadUrl()` (no size limit)
  //   2. the bridge STREAMS the raw file bytes straight to that URL (not an ingest
  //      op — a direct binary POST; the server-side fs path NEVER reaches Convex)
  //   3. addMediaPart -> persist the returned storageId as a kind:media part
  | { op: "getUploadUrl" }
  | {
      op: "addMediaPart";
      messageId: string;
      storageId: string;
      filename: string;
      mimeType: string;
    }
  // SOC2-safe DIAGNOSTIC for the outbound-media path (no message part created).
  // Recorded as an `openclaw.media` trace so the chain "gateway surfaced a file
  // -> bridge fetched bytes -> stored part" is observable remotely WITHOUT any
  // filename/path/content on the wire — only structural codes/buckets:
  //   phase "received" : the normalizer surfaced a media ref (addMedia called).
  //                      Its ABSENCE for a file-gen turn => the gateway never
  //                      surfaced the file (normalizer/frame-parsing gap).
  //   phase "stored"   : bytes fetched + persisted (bytesBucket + mimeBase).
  //   phase "dropped"  : not persisted; `reason` says WHY (no_fetcher,
  //                      not_found, too_large, path_escape, ... upload_error).
  | {
      op: "mediaTrace";
      messageId: string;
      phase: "received" | "stored" | "dropped";
      reason?: string;
      bytesBucket?: string;
      mimeBase?: string;
    }
  | {
      op: "finalize";
      messageId: string;
      status: FinalizeStatus;
      text: string;
      error: string | null;
    }
  // Session re-hydration READ: fetch a bounded block of this chat's prior turns
  // (excluding the current message) to prepend when the OpenClaw session is fresh.
  | {
      op: "getRehydrationContext";
      chatId: string;
      excludeMessageId?: string | null;
    }
  // Mirror the gateway's `sessions.describe` meta onto the chat so the header
  // strip (model + reasoning chips + context meter) shows LIVE values.
  | { op: "setSessionMeta"; chatId: string; meta: SessionMetaReport };

export interface HttpConvexWriterOptions {
  /** Convex httpActions base URL (the `.site` origin). */
  convexHttpActionsUrl: string;
  /** Bearer secret presented to the ingest endpoint. */
  ingestSecret: string;
  /** Coalesce window for deltas in ms (one mutation per flush, not per token). */
  deltaFlushMs?: number;
  /** Injected fetch (defaults to global fetch); lets tests stub the network. */
  fetchImpl?: typeof fetch;
  /**
   * Resolves an outbound media path to bytes (see core/media-fetcher.ts). When
   * absent, `addMedia` is a no-op: the turn still streams text/tools, but no
   * attachment part is created (logged once). This is the OpenClaw/Hermes media
   * seam — the writer never knows HOW bytes are obtained. STATIC: frozen for the
   * writer's lifetime. Tests use this; production uses `getFetcher` (hot-swap).
   */
  mediaFetcher?: MediaFetcher;
  /**
   * DYNAMIC fetcher resolver (D-E). Read lazily on EVERY `addMedia` so a hot
   * `mediaMode`/`mediaMaxMb` change (applied per-`/send` via MediaFetcherProvider)
   * takes effect immediately — the outbound media path runs async on gateway
   * events, decoupled from the send that delivered the config, so a frozen
   * fetcher would never reflect the change. Takes precedence over `mediaFetcher`.
   */
  getFetcher?: () => MediaFetcher | undefined;
}

const INGEST_PATH = "/bridge/ingest";

/**
 * Coarse byte bucket for the media diagnostic — never the exact size (mirrors the
 * SOC2 textLen->bucket discipline). Tells "empty vs small vs large" without a
 * fingerprint of the content.
 */
export function bytesBucket(size: number | null | undefined): string {
  // UNKNOWN (a chunked download with no Content-Length/size) is distinct from a
  // genuinely empty file: never collapse it to "0" (would read as empty).
  if (size == null || !Number.isFinite(size)) return "unknown";
  if (size <= 0) return "0";
  if (size < 1024) return "<1KB";
  if (size < 100 * 1024) return "1KB-100KB";
  if (size < 1024 * 1024) return "100KB-1MB";
  if (size < 10 * 1024 * 1024) return "1MB-10MB";
  return ">10MB";
}

/** Base type of a mime (e.g. "image" from "image/png") — the SOC2 mimeType base. */
export function mimeBaseOf(mimeType: string): string {
  const slash = mimeType.indexOf("/");
  return slash > 0 ? mimeType.slice(0, slash) : mimeType || "unknown";
}

/**
 * Did this error originate from the streamed byte-cap (MEDIA_TOO_LARGE_CODE)?
 * The cap fires mid-upload, and fetch/undici wraps a request-body stream error
 * (the original becomes `.cause`), so we walk the cause chain rather than trust a
 * top-level `.code`. Bounded depth — never loop on a self-referential cause.
 */
export function causedByTooLarge(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    if (
      typeof cur === "object" &&
      (cur as { code?: unknown }).code === MEDIA_TOO_LARGE_CODE
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Live writer that POSTs each op to the Convex ingest httpAction.
 *
 * Delta coalescing: rather than one `appendDelta` mutation per streamed token,
 * deltas are buffered per message and flushed every `deltaFlushMs` (~50ms) or
 * immediately before any non-delta op (snapshot/part/finalize) so ordering is
 * preserved relative to the rest of the stream.
 */
// Bridge-level deadline on EVERY Convex write. Without it a slow/hung Convex
// backend (the prod listChats-saturation incident) backs up the writer and the
// consume loop awaiting it -> chats wedge with no self-heal. On timeout the op
// aborts + throws; the per-message chain swallows the rejection so it self-heals.
const WRITE_TIMEOUT_MS = 20_000;
// Hard cap on ONE message's un-flushed delta buffer (chars). A sustained Convex
// outage would otherwise grow it without bound -> OOM (which the process safety
// net CANNOT catch). The turn's setSnapshot/finalize carries the FULL text, so
// only intermediate streaming fidelity is trimmed under extreme backpressure.
const MAX_PENDING_DELTA_CHARS = 256 * 1024;
// Delivery-recorder clock calibration. Take several samples and keep the min-RTT one
// (NTP technique: least queuing => most symmetric => least-biased midpoint), and
// re-arm after a TTL so NTP drift / a noisy one-off sample can't bias segment A for
// the whole life of a long-running ("Mars") bridge.
const CALIBRATE_SAMPLES = 5;
const SKEW_TTL_MS = 5 * 60 * 1000;

export class HttpConvexWriter implements ConvexWriter {
  private readonly url: string;
  private readonly ingestSecret: string;
  private readonly deltaFlushMs: number;
  private readonly fetchImpl: typeof fetch;
  // Resolve the current fetcher lazily (hot-swap seam). Built from `getFetcher`
  // when given, else a constant returning the static `mediaFetcher` (tests).
  private readonly getFetcher: () => MediaFetcher | undefined;
  // Warn once (not per attachment) when media arrives without a configured
  // fetcher, so a misconfigured deployment is visible without log spam.
  private warnedNoFetcher = false;

  // Per-message pending delta buffer + its flush timer.
  private pendingDelta = new Map<string, string>();
  private flushTimer = new Map<string, NodeJS.Timeout>();
  // Delivery recorder t0: when the FIRST delta of the current (un-flushed) batch was
  // received by the writer. Read + cleared on flush; bridge-internal = t1 - t0 (single
  // bridge clock, no skew). See convex/deliveryTiming.ts.
  private pendingFirstAt = new Map<string, number>();
  // One-shot "this message's deltas were capped" marker (log once per message).
  private deltaCapped = new Set<string>();
  // The text Convex's `liveText` CURRENTLY holds for a message (== the sum of
  // flushed deltas, or the last snapshot). Lets setSnapshot send only the new
  // SUFFIX as a delta when a snapshot STRICTLY EXTENDS what we already wrote --
  // turning a stream of full ~2KB snapshot re-writes into a few bytes per frame on a
  // write-constrained backend, with an IDENTICAL final `liveText`. Updated ONLY on
  // a SUCCESSFUL post (flushDelta append + setSnapshot), so it never diverges from
  // the server (a post-backpressure trimmed liveText makes the next snapshot fail
  // the prefix test -> a full setSnapshot corrects it). Evicted with forgetMessage.
  private confirmedText = new Map<string, string>();
  // Messages whose last SUFFIX appendDelta post FAILED. appendDelta is NOT
  // idempotent, and a timeout/lost-response is NOT proof the mutation didn't apply
  // server-side -> re-extending from the old prefix could DOUBLE the suffix. So the
  // next snapshot for such a message is forced to a FULL (idempotent) setSnapshot,
  // which corrects liveText whether or not the failed delta landed. Cleared once a
  // full snapshot resyncs; evicted with forgetMessage.
  private pendingResync = new Set<string>();
  // PER-MESSAGE serialization chains: ordering is load-bearing only WITHIN a
  // message (a flush timer firing concurrently with a snapshot/finalize must not
  // scramble that message's ingest order). A SINGLE global chain (the old design)
  // also serialized UNRELATED chats, so one slow op blocked EVERY chat. Keyed by
  // messageId; message-less ops (startAssistant/getUploadUrl/getRehydrationContext)
  // run independently. Entries are evicted on finalize so the map stays bounded.
  private chains = new Map<string, Promise<unknown>>();

  // Delivery recorder (convex/deliveryTiming.ts). Learned ONCE per turn from the
  // startAssistant ack — so the per-delta hot path stays free when not recording.
  //   recTurns : messageId -> the recording sessionId the turn was started under.
  //              Sent back on each tagged delta so Convex can reject a late delta
  //              whose session is no longer active (no in-memory seq counter, so a
  //              bridge restart mid-session can't collide a correlator).
  //   recSkew  : bridge<->Convex clock offset (serverClock - bridgeClock), measured
  //              once via the lightweight `calibrate` op (see calibrate()); feeds A.
  //   calibrating : in-flight guard so calibration fires at most once.
  private readonly recTurns = new Map<string, string>();
  private recSkew: number | undefined = undefined;
  private skewAt = 0; // bridge-clock time recSkew was measured (for the TTL re-arm)
  private calibrating = false;

  constructor(opts: HttpConvexWriterOptions) {
    this.url = opts.convexHttpActionsUrl.replace(/\/$/, "") + INGEST_PATH;
    this.ingestSecret = opts.ingestSecret;
    this.deltaFlushMs = opts.deltaFlushMs ?? 50;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const staticFetcher = opts.mediaFetcher;
    this.getFetcher = opts.getFetcher ?? (() => staticFetcher);
  }

  /** Post an op. A message-keyed op (it carries `messageId`) is serialized on that
   *  message's chain; a message-less op (startAssistant/getUploadUrl/...) runs
   *  independently so it never blocks behind another chat's work. */
  private post<T>(body: IngestOp): Promise<T> {
    const messageId =
      "messageId" in body && typeof (body as { messageId?: unknown }).messageId === "string"
        ? (body as { messageId: string }).messageId
        : null;
    if (messageId === null) return this.doPost<T>(body);
    return this.enqueue<T>(messageId, () => this.doPost<T>(body));
  }

  /** Run `op` after the message's prior op, and become its new chain tail. The
   *  tail swallows rejections (don't poison later ops) but the caller still sees
   *  this op's error via the returned promise. */
  private enqueue<T>(messageId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(messageId) ?? Promise.resolve();
    const run = prev.then(op);
    this.chains.set(messageId, run.catch(() => undefined));
    return run;
  }

  /** Diagnostic/test seam: does this message still hold ANY retained state (chain,
   *  buffered delta, cap flag, or flush timer)? The memory-bounding invariant is
   *  "after finalize, false for every message" — so a test can assert cleanup ran
   *  even when the final flush/post failed, without reaching into private maps. */
  hasMessageState(messageId: string): boolean {
    return (
      this.chains.has(messageId) ||
      this.pendingDelta.has(messageId) ||
      this.deltaCapped.has(messageId) ||
      this.confirmedText.has(messageId) ||
      this.pendingResync.has(messageId) ||
      this.flushTimer.has(messageId) ||
      this.pendingFirstAt.has(messageId) ||
      this.recTurns.has(messageId)
    );
  }

  /** Drop a finalized message's chain + buffers so the maps stay bounded (the
   *  finalize is its last op). Idempotent. */
  private forgetMessage(messageId: string): void {
    const t = this.flushTimer.get(messageId);
    if (t) {
      clearTimeout(t);
      this.flushTimer.delete(messageId);
    }
    this.pendingDelta.delete(messageId);
    this.pendingFirstAt.delete(messageId);
    this.deltaCapped.delete(messageId);
    this.confirmedText.delete(messageId);
    this.pendingResync.delete(messageId);
    this.chains.delete(messageId);
    this.recTurns.delete(messageId);
  }

  private async doPost<T>(body: IngestOp): Promise<T> {
    // Bridge-level deadline: a slow/hung Convex backend must time out + throw (the
    // chain then self-heals) rather than wedge the writer — and the consume loop
    // awaiting it — forever. Mirrors the gateway-http-media-fetcher abort pattern.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.ingestSecret}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Convex ingest ${body.op} timed out after ${WRITE_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Convex ingest ${body.op} -> HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (await response.json()) as T;
  }

  async startAssistant(chatId: string, runId: string | null): Promise<string> {
    const ack = await this.post<{
      messageId: string;
      rec?: { recording: boolean; sessionId: string | null };
    }>({ op: "startAssistant", chatId, runId });
    // Delivery recorder: learn ONCE per turn the recording session (if any) to tag
    // this turn's deltas with, and trigger a one-time clock calibration. The skew is
    // NOT derived from this round-trip (startAssistant does heavy server work between
    // receipt and response, which would bias it negative — see calibrate()).
    if (ack.rec?.recording && ack.rec.sessionId) {
      this.recTurns.set(ack.messageId, ack.rec.sessionId);
      void this.calibrate();
    }
    return ack.messageId;
  }

  /** One-time bridge<->Convex clock calibration via the LIGHTWEIGHT `calibrate` op
   *  (no server writes), so the measured round-trip is free of mutation time and the
   *  skew is accurate (a startAssistant-derived skew was biased by ~half its server
   *  work, pushing segment A negative). serverNow is the server's request-receipt time
   *  (≈ the round-trip midpoint for symmetric latency):
   *    skew = serverNow - (sentAt + RTT/2)   (serverClock - bridgeClock)
   *  Fire-and-forget from startAssistant; resolves long before the first delta (the
   *  model thinks first). Best-effort: a failure leaves skew unset (A uncorrected) and
   *  is retried on the next recorded turn. */
  private async calibrate(): Promise<void> {
    if (this.calibrating) return;
    // Re-arm after the TTL so drift on a long-lived bridge is corrected; skip while
    // a fresh skew is still valid.
    if (this.recSkew !== undefined && Date.now() - this.skewAt < SKEW_TTL_MS) {
      return;
    }
    this.calibrating = true;
    try {
      // Keep the MIN-RTT sample: the least-queued round-trip has the most symmetric
      // up/down split, so its midpoint estimate is the least biased.
      let best: { skew: number; rtt: number } | undefined;
      for (let i = 0; i < CALIBRATE_SAMPLES; i++) {
        const sentAt = Date.now();
        const { serverNow } = await this.post<{ serverNow: number }>({
          op: "calibrate",
        });
        const rtt = Date.now() - sentAt;
        const skew = serverNow - (sentAt + rtt / 2);
        if (best === undefined || rtt < best.rtt) best = { skew, rtt };
      }
      if (best !== undefined) {
        this.recSkew = best.skew;
        this.skewAt = Date.now();
      }
    } catch {
      // Keep any prior (stale) skew — better than none; retried next recorded turn.
    } finally {
      this.calibrating = false;
    }
  }

  /** Delivery-recorder tags for a stream write (session + t1 + skew + UTF-8 size), or
   *  {} when this turn isn't being recorded -> the op body is byte-identical to before
   *  and Convex's appendDelta/setSnapshot skip the recorder entirely. */
  private recTags(messageId: string, text: string, recvAt?: number): RecTags {
    const sessionId = this.recTurns.get(messageId);
    if (sessionId === undefined) return {};
    return {
      recSessionId: sessionId,
      bridgeRecvAt: recvAt, // t0 (delta-flush batch start OR snapshot-frame receipt)
      bridgeSentAt: Date.now(),
      bridgeSkew: this.recSkew,
      sizeBytes: Buffer.byteLength(text, "utf8"),
    };
  }

  async appendDelta(messageId: string, text: string): Promise<void> {
    // t0: stamp when the first delta of the current (un-flushed) batch arrives.
    if (!this.pendingFirstAt.has(messageId)) {
      this.pendingFirstAt.set(messageId, Date.now());
    }
    let buffered = (this.pendingDelta.get(messageId) ?? "") + text;
    if (buffered.length > MAX_PENDING_DELTA_CHARS) {
      // Sustained backpressure: cap the buffer (keep the most-recent tail) so it
      // can't grow without bound -> OOM. setSnapshot/finalize still carries the
      // full normalizer text, so only intermediate streaming fidelity is trimmed.
      if (!this.deltaCapped.has(messageId)) {
        this.deltaCapped.add(messageId);
        console.warn(
          `[stream] delta buffer capped for ${messageId} (Convex backpressure) — intermediate text trimmed; snapshot will correct`,
        );
      }
      buffered = buffered.slice(buffered.length - MAX_PENDING_DELTA_CHARS);
      // The discarded PREFIX means the original t0 now points at content that won't be
      // sent, which would inflate the bridge-internal segment (Codex review). Advance t0
      // to now so it bounds only the kept (recent) tail.
      this.pendingFirstAt.set(messageId, Date.now());
    }
    this.pendingDelta.set(messageId, buffered);
    if (this.flushTimer.has(messageId)) {
      return; // a flush is already scheduled
    }
    const timer = setTimeout(() => {
      // A failed timer-fired flush must NEVER surface as an unhandled rejection
      // (which would kill the bridge process); the error is logged and the next
      // flush retries with the (still-buffered + newer) text.
      this.flushDelta(messageId).catch((err) => {
        console.warn(
          `[stream] delta flush failed for ${messageId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.deltaFlushMs);
    // Do not keep the process alive solely for a pending flush.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.flushTimer.set(messageId, timer);
  }

  /** Flush the coalesced delta buffer for a message as a single appendDelta.
   *
   * BACKPRESSURE-ADAPTIVE: the buffer is captured at CHAIN-EXECUTION time, not at
   * timer-fire time. While an earlier op is still in flight (slow backend), new
   * deltas keep accumulating in the SAME buffer and the next executed flush
   * carries ALL of them in ONE appendDelta — so the queue stays bounded (one real
   * POST per backend round-trip, no-op flushes in between). With fire-time
   * capture, a slow backend enqueued one ~50ms-of-text POST per window and kept
   * "streaming" for minutes after the gateway had finished. */
  private flushDelta(messageId: string): Promise<void> {
    const timer = this.flushTimer.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimer.delete(messageId);
    }
    const enqueuedAt = Date.now();
    return this.enqueue(messageId, async () => {
      const text = this.pendingDelta.get(messageId);
      this.pendingDelta.delete(messageId);
      // Consume this batch's t0 (read + clear; the next delta starts a fresh batch).
      const recvAt = this.pendingFirstAt.get(messageId);
      this.pendingFirstAt.delete(messageId);
      if (text === undefined || text === "") {
        return; // everything already carried by an earlier flush — no POST
      }
      const waitedMs = Date.now() - enqueuedAt;
      const postStart = Date.now();
      try {
        await this.doPost({
          op: "appendDelta",
          messageId,
          text,
          ...this.recTags(messageId, text, recvAt),
        });
        // liveText now == prior + this delta. Track it so a later snapshot can be
        // diffed to a suffix (only AFTER the post succeeds — a failure re-buffers
        // the text below, so the server never received it).
        this.confirmedText.set(
          messageId,
          (this.confirmedText.get(messageId) ?? "") + text,
        );
        // Per-flush timing (~1 line per backend round-trip while streaming): the
        // production diagnostic that separates "backend slow" (high postMs),
        // "queue starved" (high waitedMs) and "gateway delivered late" (no flush
        // lines at all during the silent window) without dashboard access.
        console.log(
          `[stream] flush msg=${messageId} bytes=${text.length} waitedMs=${waitedMs} postMs=${Date.now() - postStart}`,
        );
      } catch (err) {
        // Re-buffer the UNSENT text (PREPEND — deltas may have arrived since) so
        // a transient ingest failure loses nothing; the next flush retries. Bounded
        // by appendDelta's MAX_PENDING_DELTA_CHARS cap so a long outage can't OOM.
        const merged = text + (this.pendingDelta.get(messageId) ?? "");
        const overflowed = merged.length > MAX_PENDING_DELTA_CHARS;
        this.pendingDelta.set(
          messageId,
          overflowed
            ? merged.slice(merged.length - MAX_PENDING_DELTA_CHARS)
            : merged,
        );
        // Restore this batch's t0 onto the re-buffered text (Codex review). The catch
        // PREPENDS the failed text, so normally the merged batch's oldest content is the
        // original one — keep the EARLIEST receipt so the retry's bridge-internal segment
        // reflects the full wait. BUT if the merge OVERFLOWED, that original prefix was
        // just dropped, so the old t0 would point at unsent content and inflate the
        // segment — advance to now instead (bounds only the kept tail).
        if (overflowed) {
          this.pendingFirstAt.set(messageId, Date.now());
        } else if (recvAt !== undefined) {
          const cur = this.pendingFirstAt.get(messageId);
          this.pendingFirstAt.set(
            messageId,
            cur === undefined ? recvAt : Math.min(cur, recvAt),
          );
        }
        // A timed-out / lost-response append MAY have applied server-side; the
        // re-buffered retry would then DOUBLE it. confirmedText (success-only) tracks
        // a single copy, so a later snapshot must NOT trust the prefix and emit a
        // suffix — force the next snapshot to a full (idempotent) setSnapshot that
        // corrects any such doubling. (Finalize's full text is the same backstop for
        // a pure-delta stream that never snapshots.)
        this.pendingResync.add(messageId);
        throw err;
      }
    });
  }

  async setSnapshot(messageId: string, text: string): Promise<void> {
    // t0: this snapshot FRAME's receipt (snapshot-streaming gateways never call
    // appendDelta, so without this the bridge-internal segment is empty for them).
    const recvAt = Date.now();
    await this.flushDelta(messageId); // ordering: drain deltas first (-> confirmedText current)
    // WRITE REDUCTION: many gateways stream by re-sending the WHOLE text each frame
    // (full ~2KB snapshots), which on a write-constrained backend is wasteful. When
    // the new snapshot STRICTLY EXTENDS what `liveText` already holds, send only the
    // new suffix as a delta (a few bytes) instead of the whole text; otherwise (a
    // revision/shrink, or a backpressure-trimmed liveText whose prefix the full text
    // no longer matches) write the full snapshot, which also CORRECTS liveText.
    //
    // We NEVER skip a write: an identical frame falls to the else and re-stamps the
    // message. Both Convex handlers patch `updatedAt` (stream.ts appendDelta AND
    // setSnapshot), so EVERY frame keeps bumping the heartbeat reconcileStuckStreams
    // relies on -- skipping identical frames would let a slow-but-alive turn (model
    // re-sending the same partial text) be reaped as stream_orphaned after 12min.
    // `liveText` ends byte-identical to `text` either way. flushDelta + the turn-sink's
    // per-message ordering make this read-then-post race-free; confirmedText advances
    // ONLY after a SUCCESSFUL post (this.post propagates the rejection), so a failed
    // write leaves it at `prev` and the next snapshot re-extends with no gap.
    const prev = this.confirmedText.get(messageId) ?? "";
    const canSuffix =
      !this.pendingResync.has(messageId) &&
      text.length > prev.length &&
      text.startsWith(prev);
    try {
      if (canSuffix) {
        const suffix = text.slice(prev.length);
        await this.post({
          op: "appendDelta",
          messageId,
          text: suffix,
          ...this.recTags(messageId, suffix, recvAt),
        });
      } else {
        await this.post({
          op: "setSnapshot",
          messageId,
          text,
          ...this.recTags(messageId, text, recvAt),
        });
      }
    } catch (err) {
      // ANY timed-out / lost-response write MAY have applied server-side. appendDelta
      // is not idempotent (re-extending from `prev` could double), and even a
      // maybe-applied full setSnapshot leaves confirmedText behind so a later suffix
      // could double onto it. Force the NEXT snapshot to a full (idempotent)
      // setSnapshot that corrects liveText either way; confirmedText is NOT advanced
      // (we rethrow before the set below).
      this.pendingResync.add(messageId);
      throw err;
    }
    // Success: liveText == text. A full snapshot here also resyncs any prior
    // ambiguity, so clear the flag.
    this.pendingResync.delete(messageId);
    this.confirmedText.set(messageId, text);
  }

  async addToolPart(messageId: string, part: ToolPart): Promise<void> {
    await this.flushDelta(messageId);
    await this.post({ op: "addPart", messageId, part });
  }

  async addProvenancePart(
    messageId: string,
    part: import("./core/provenance.js").ProvenancePart,
  ): Promise<void> {
    await this.flushDelta(messageId);
    await this.post({ op: "addPart", messageId, part });
  }

  async addMedia(
    messageId: string,
    media: { filename: string; path: string; mimeType?: string },
  ): Promise<void> {
    await this.flushDelta(messageId); // ordering: drain deltas before the part
    // DIAGNOSTIC (SOC2-safe): the normalizer surfaced a media ref, so addMedia was
    // called. This "received" trace is the load-bearing A/B discriminator — if it
    // is ABSENT for a file-gen turn, the gateway never surfaced the file (a
    // normalizer/frame gap), NOT a fetcher/mount problem.
    this.emitMediaTrace(messageId, "received");
    // Resolve the fetcher lazily so a hot mediaMode change (off ↔ shared-fs ↔
    // gateway-http) applied since boot takes effect on THIS attachment.
    const fetcher = this.getFetcher();
    if (!fetcher) {
      if (!this.warnedNoFetcher) {
        this.warnedNoFetcher = true;
        console.warn(
          "[media] no MediaFetcher configured -> outbound attachments are dropped",
        );
      }
      this.emitMediaTrace(messageId, "dropped", { reason: "no_fetcher" });
      return;
    }
    // Best-effort: an attachment failure must NEVER abort the assistant turn —
    // the text + tool parts still land; only the attachment is skipped (logged).
    try {
      // The bridge STREAMS the raw bytes (no base64, no full buffer) directly to
      // a Convex upload URL — sidesteps the 20MB httpAction ceiling and the ~33%
      // base64 inflation. The server-side fs path stays inside the bridge.
      const opened = await fetcher.open(media.path);
      if (!opened.ok) {
        // The structural reason (not_found / too_large / path_escape / ...) — the
        // single most useful signal: each is a DIFFERENT fix. Already warned
        // locally by the fetcher (with the filename); the trace stays code-only.
        this.emitMediaTrace(messageId, "dropped", { reason: opened.reason });
        return;
      }
      const mimeType = media.mimeType ?? opened.mimeType;
      const { uploadUrl } = await this.post<{ uploadUrl: string }>({
        op: "getUploadUrl",
      });
      // The getUploadUrl await is the window where the just-opened fs stream can
      // fail (file removed after the stat, EACCES). If it errored BEFORE we start
      // reading, the stream is settled and toWeb would yield 0 bytes cleanly -> a
      // silent EMPTY upload. Detect that here and DROP instead. (There is NO async
      // gap between this check and toWeb in streamToUploadUrl, and an fs error is
      // always async, so a post-check error can only fire mid-read, where toWeb
      // propagates it -> the catch below reports the drop.)
      if (opened.readError?.()) {
        this.emitMediaTrace(messageId, "dropped", { reason: "read_error" });
        return;
      }
      const storageId = await this.streamToUploadUrl(
        uploadUrl,
        opened.stream,
        mimeType,
      );
      await this.post({
        op: "addMediaPart",
        messageId,
        storageId,
        filename: media.filename,
        mimeType,
      });
      this.emitMediaTrace(messageId, "stored", {
        bytesBucket: bytesBucket(opened.size),
        mimeBase: mimeBaseOf(mimeType),
      });
    } catch (err) {
      // Structural only (never the bytes/content). Filename hints at content, so
      // log just the failure class. A cap-exceeded error surfaces HERE (not from
      // open()) when the gateway omits Content-Length/size: report `too_large` so
      // the diagnostic points at the real fix (raise cap / shrink file), not at a
      // generic upload/storage failure.
      console.warn(
        `[media] attachment skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.emitMediaTrace(messageId, "dropped", {
        reason: causedByTooLarge(err) ? "too_large" : "upload_error",
      });
    }
  }

  /**
   * The agent GENERATED media this turn (e.g. a codex `imageGeneration` item) but
   * delivered none — no `MEDIA:`/`mediaUrls`/outbound path, so there is nothing for
   * the bridge to fetch. Record a SOC2-safe `openclaw.media` dropped diagnostic
   * (reason `generated_no_delivery`, NO part, no content) so the #7 self-correction
   * loop can flag the agent's missing delivery directive.
   */
  async noteMediaUndelivered(messageId: string): Promise<void> {
    this.emitMediaTrace(messageId, "dropped", {
      reason: "generated_no_delivery",
    });
  }

  /**
   * Fire-and-forget SOC2-safe media diagnostic. Sent OFF the serialization chain
   * (a direct doPost, NOT this.post) so a slow/stuck observability mutation can
   * NEVER delay the turn's real ops (getUploadUrl/addMediaPart/finalize) — a
   * diagnostic must never block the flow (Codex P2). It records an independent
   * `openclaw.media` trace (own timestamp, no part, no ordering-sensitive state),
   * so racing the chain is harmless. Errors are swallowed; carries only structural
   * codes/buckets: no filename, no path, no bytes.
   */
  private emitMediaTrace(
    messageId: string,
    phase: "received" | "stored" | "dropped",
    extra?: { reason?: string; bytesBucket?: string; mimeBase?: string },
  ): void {
    void this.doPost({ op: "mediaTrace", messageId, phase, ...extra }).catch(
      () => {
        // best-effort: never surface as an unhandled rejection.
      },
    );
  }

  /**
   * POST a raw byte stream to a Convex upload URL and return the storageId. The
   * URL is pre-signed (generateUploadUrl) so no auth header is sent; the body is
   * the file's web ReadableStream with `duplex: "half"` (required by undici for
   * a streaming request body), so bytes flow disk -> network without buffering.
   */
  private async streamToUploadUrl(
    uploadUrl: string,
    stream: Readable,
    mimeType: string,
  ): Promise<string> {
    const response = await this.fetchImpl(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": mimeType },
      body: Readable.toWeb(stream) as ReadableStream,
      // `duplex` is not in the DOM RequestInit type but is required by undici
      // for a streaming body; cast keeps the rest of the init type-checked.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `upload POST -> HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    const body = (await response.json()) as { storageId?: string };
    if (!body.storageId) {
      throw new Error("upload POST returned no storageId");
    }
    return body.storageId;
  }

  async finalize(
    messageId: string,
    status: FinalizeStatus,
    text: string,
    error: string | null,
  ): Promise<void> {
    try {
      await this.flushDelta(messageId); // never strand buffered deltas behind final
      const postStart = Date.now();
      await this.post({ op: "finalize", messageId, status, text, error });
      // The finalize is the LAST write (it stamps the message's updatedAt) — its
      // wall-clock here vs the gateway's turn end is the end-to-end lag readout.
      console.log(
        `[stream] finalize msg=${messageId} status=${status} bytes=${text.length} postMs=${Date.now() - postStart}`,
      );
    } finally {
      // The message is terminal: drop its chain + buffers so the maps never grow
      // without bound across the process lifetime (one entry per message ever).
      // MUST cover the flush too: if the FINAL flushDelta (or the finalize post)
      // throws/times out under Convex backpressure, a `finally` that began AFTER the
      // flush would leak this message's chain + delta buffer forever and strand it
      // in `streaming` — defeating the very memory bound this cleanup exists for.
      this.forgetMessage(messageId);
    }
  }

  async getRehydrationContext(
    chatId: string,
    excludeMessageId?: string | null,
  ): Promise<{ history: string | null; turnCount: number }> {
    return this.post<{ history: string | null; turnCount: number }>({
      op: "getRehydrationContext",
      chatId,
      excludeMessageId: excludeMessageId ?? null,
    });
  }

  async reportSessionMeta(chatId: string, meta: SessionMetaReport): Promise<void> {
    // OFF the serialization chain ON PURPOSE. This chat-level meta (header chips +
    // context meter) is independent of the per-MESSAGE delta/part/finalize
    // ORDERING the chain guarantees, so it doesn't need the chain — and putting it
    // ON the chain makes a slow/hung meta POST block the turn's CRITICAL writes
    // that share it (getRehydrationContext + startAssistant), defeating the
    // "fire-and-forget at the call site" contract. doPost runs it concurrently;
    // both call sites already handle the rejection (performSend voids+catches,
    // performPatch awaits in try/catch). Two near-concurrent describes may land
    // last-write-wins — acceptable for a meta snapshot.
    await this.doPost({ op: "setSessionMeta", chatId, meta });
  }
}
