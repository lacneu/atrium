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
import type { MediaFetcher } from "./core/media-fetcher.js";

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

type IngestOp =
  | { op: "startAssistant"; chatId: string; runId: string | null }
  | { op: "appendDelta"; messageId: string; text: string }
  | { op: "setSnapshot"; messageId: string; text: string }
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
   * seam — the writer never knows HOW bytes are obtained.
   */
  mediaFetcher?: MediaFetcher;
}

const INGEST_PATH = "/bridge/ingest";

/**
 * Live writer that POSTs each op to the Convex ingest httpAction.
 *
 * Delta coalescing: rather than one `appendDelta` mutation per streamed token,
 * deltas are buffered per message and flushed every `deltaFlushMs` (~50ms) or
 * immediately before any non-delta op (snapshot/part/finalize) so ordering is
 * preserved relative to the rest of the stream.
 */
export class HttpConvexWriter implements ConvexWriter {
  private readonly url: string;
  private readonly ingestSecret: string;
  private readonly deltaFlushMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly mediaFetcher?: MediaFetcher;
  // Warn once (not per attachment) when media arrives without a configured
  // fetcher, so a misconfigured deployment is visible without log spam.
  private warnedNoFetcher = false;

  // Per-message pending delta buffer + its flush timer.
  private pendingDelta = new Map<string, string>();
  private flushTimer = new Map<string, NodeJS.Timeout>();
  // Serialization chain: every op POSTs strictly in enqueue order, so a flush
  // timer firing concurrently with a snapshot/finalize never scrambles ordering
  // (the ingest mutations are sequential per message and order is load-bearing).
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: HttpConvexWriterOptions) {
    this.url = opts.convexHttpActionsUrl.replace(/\/$/, "") + INGEST_PATH;
    this.ingestSecret = opts.ingestSecret;
    this.deltaFlushMs = opts.deltaFlushMs ?? 50;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.mediaFetcher = opts.mediaFetcher;
  }

  /** Enqueue an op on the serialization chain; resolves with its result. */
  private post<T>(body: IngestOp): Promise<T> {
    const run = this.chain.then(() => this.doPost<T>(body));
    // Keep the chain alive even if this op rejects (don't poison later ops),
    // but propagate the error to the caller via `run`.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doPost<T>(body: IngestOp): Promise<T> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.ingestSecret}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Convex ingest ${body.op} -> HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (await response.json()) as T;
  }

  async startAssistant(chatId: string, runId: string | null): Promise<string> {
    const { messageId } = await this.post<{ messageId: string }>({
      op: "startAssistant",
      chatId,
      runId,
    });
    return messageId;
  }

  async appendDelta(messageId: string, text: string): Promise<void> {
    const buffered = (this.pendingDelta.get(messageId) ?? "") + text;
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
    const run = this.chain.then(async () => {
      const text = this.pendingDelta.get(messageId);
      this.pendingDelta.delete(messageId);
      if (text === undefined || text === "") {
        return; // everything already carried by an earlier flush — no POST
      }
      const waitedMs = Date.now() - enqueuedAt;
      const postStart = Date.now();
      try {
        await this.doPost({ op: "appendDelta", messageId, text });
        // Per-flush timing (~1 line per backend round-trip while streaming): the
        // production diagnostic that separates "backend slow" (high postMs),
        // "queue starved" (high waitedMs) and "gateway delivered late" (no flush
        // lines at all during the silent window) without dashboard access.
        console.log(
          `[stream] flush msg=${messageId} bytes=${text.length} waitedMs=${waitedMs} postMs=${Date.now() - postStart}`,
        );
      } catch (err) {
        // Re-buffer the UNSENT text (PREPEND — deltas may have arrived since) so
        // a transient ingest failure loses nothing; the next flush retries.
        this.pendingDelta.set(
          messageId,
          text + (this.pendingDelta.get(messageId) ?? ""),
        );
        throw err;
      }
    });
    // Keep the chain alive even if this flush rejects (don't poison later ops).
    this.chain = run.catch(() => undefined);
    return run;
  }

  async setSnapshot(messageId: string, text: string): Promise<void> {
    await this.flushDelta(messageId); // ordering: drain deltas first
    await this.post({ op: "setSnapshot", messageId, text });
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
    if (!this.mediaFetcher) {
      if (!this.warnedNoFetcher) {
        this.warnedNoFetcher = true;
        console.warn(
          "[media] no MediaFetcher configured -> outbound attachments are dropped",
        );
      }
      return;
    }
    // Best-effort: an attachment failure must NEVER abort the assistant turn —
    // the text + tool parts still land; only the attachment is skipped (logged).
    try {
      // The bridge STREAMS the raw bytes (no base64, no full buffer) directly to
      // a Convex upload URL — sidesteps the 20MB httpAction ceiling and the ~33%
      // base64 inflation. The server-side fs path stays inside the bridge.
      const opened = await this.mediaFetcher.open(media.path);
      if (!opened) {
        return; // missing/too-large/escaping — already logged by the fetcher
      }
      const mimeType = media.mimeType ?? opened.mimeType;
      const { uploadUrl } = await this.post<{ uploadUrl: string }>({
        op: "getUploadUrl",
      });
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
    } catch (err) {
      // Structural only (never the bytes/content). Filename hints at content, so
      // log just the failure class.
      console.warn(
        `[media] attachment skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    await this.flushDelta(messageId); // never strand buffered deltas behind final
    const postStart = Date.now();
    await this.post({ op: "finalize", messageId, status, text, error });
    // The finalize is the LAST write (it stamps the message's updatedAt) — its
    // wall-clock here vs the gateway's turn end is the end-to-end lag readout.
    console.log(
      `[stream] finalize msg=${messageId} status=${status} bytes=${text.length} postMs=${Date.now() - postStart}`,
    );
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
