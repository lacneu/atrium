// THE TRANSCRIPT FILE COPIER (transcript redesign, final design §3.5, step 2 — projection
// `on` only).
//
// A file a transcript row carries is copied ONCE into Convex storage, the moment the row is
// stored: a `sessions.reset` deletes the gateway's managed copy within seconds (bench probe
// 2026-10-16, design §2.1), and Atrium's viewer, export, archive and 30-day trash outlive
// the gateway session. Identity is the row's, never a name, path or content: a managed file
// by its `artifactId`, a `MEDIA:` reference by its row and block (convex/transcriptFiles.ts).
//
//   - managed file: `artifacts.download` on the conversation socket → the ticketed URL →
//     the bytes, read with NO credential (the ticket authorizes; the same in token and
//     trusted-proxy mode) — providers/openclaw/artifact-download.ts;
//   - `MEDIA:` reference: the configured media fetcher (meta probe + ticket, or the shared
//     mount), named with the session like the Control UI names it;
//   - the bytes stream through a byte cap and a SHA-256 into a Convex upload URL, and Convex
//     finalizes `copied` under its uniqueness guard (a copy that lost a race releases its
//     blob there).
//
// Outcomes: `gone` (the gateway says it no longer has it), `refused` (it can never be copied
// — over the size cap, media disabled, a source the fetcher refuses), else a transient
// failure retried after 1 s / 5 s / 30 s, then left `pending` for the next read of the
// session or Convex's resume cron. Nothing is ever silently dropped.

import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import type {
  TranscriptFileAnswer,
  TranscriptFileCopiedReport,
  TranscriptFileFailedReport,
  TranscriptFileToCopy,
} from "../convex-writer.js";
import { MEDIA_TOO_LARGE_CODE, type MediaFetcher, type MediaSkipReason } from "./media-fetcher.js";
import { errForLog } from "./log-safe-error.js";

/** The bounded in-process retry of a transient failure (design §3.5 step 5). */
export const COPY_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];
/** Copies running at once per copier (one conversation). */
export const COPY_CONCURRENCY = 2;
/** The managed media route the ticketed URL must name (managed-image-attachments.ts:107). */
const MANAGED_ROUTE_PREFIX = "/api/chat/media/outgoing/";

/** What `artifacts.download` answered (providers/openclaw/artifact-download.ts). */
export type DownloadGrant =
  | { ok: true; url?: string; data?: string; mimeType?: string; sizeBytes?: number }
  | { ok: false; reason: "artifact_not_found" | "artifact_download_unsupported" | "transient" };

export interface ArtifactCopierDeps {
  /** `artifacts.download {sessionKey, artifactId}` on the conversation socket. */
  download(sessionKey: string, artifactId: string): Promise<DownloadGrant>;
  /** The gateway's HTTP origin (same host:port as its WebSocket). */
  httpBase(): string;
  /** Identity headers a trusted-proxy gateway needs to ATTRIBUTE a request (empty in token
   *  mode). Never a credential: the ticket authorizes the read. */
  identityHeaders(): Record<string, string>;
  /** The gateway's MEDIA ROUTE, for `MEDIA:` references, named with the row's session
   *  (MediaFetcherProvider.mediaRoute — never a local mount; undefined: off / no route). */
  mediaFetcher(): MediaFetcher | undefined;
  /** The byte cap (OPENCLAW_MEDIA_MAX_MB, hot). */
  maxBytes(): number;
  upload(stream: Readable, mimeType: string): Promise<string>;
  copied(report: TranscriptFileCopiedReport): Promise<TranscriptFileAnswer>;
  failed(report: TranscriptFileFailedReport): Promise<TranscriptFileAnswer>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Bound on the time to the download's RESPONSE HEADERS (the body is not bounded here:
   *  it flows at the upload's speed, like the media fetcher). */
  connectTimeoutMs?: number;
}

/** One attempt's outcome. */
export type CopyOutcome =
  | { kind: "copied"; duplicate: boolean }
  | { kind: "gone"; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "retry"; reason: string };

/** The fetcher reasons that will not change on a retry: the source is gone or refused. */
const FETCH_GONE: ReadonlySet<MediaSkipReason> = new Set(["not_found"]);
const FETCH_REFUSED: ReadonlySet<MediaSkipReason> = new Set([
  "too_large",
  "path_escape",
  "symlink_rejected",
  "not_a_file",
  "invalid_filename",
  "not_in_this_mount",
  "route_absent",
]);

class TooLargeError extends Error {
  readonly code = MEDIA_TOO_LARGE_CODE;
}

/** A pass-through that counts, hashes and caps the bytes actually flowing. */
function meter(maxBytes: number): { stream: Transform; digest: () => { sha256: string; bytes: number } } {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cb(new TooLargeError(`file exceeds the media cap (${maxBytes} bytes)`));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  return { stream, digest: () => ({ sha256: hash.digest("hex"), bytes }) };
}

const causedByTooLarge = (err: unknown): boolean => {
  for (let e: unknown = err, i = 0; e !== null && e !== undefined && i < 5; i++) {
    if (e instanceof TooLargeError || (e as { code?: unknown }).code === MEDIA_TOO_LARGE_CODE) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
};

export class ArtifactCopier {
  private readonly inFlight = new Set<string>();
  private readonly queue: TranscriptFileToCopy[] = [];
  private running = 0;
  private closed = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly fetchImpl: typeof fetch;
  /** Counters, for tests and the log line. */
  readonly stats = { copied: 0, duplicates: 0, gone: 0, refused: 0, retries: 0, deferred: 0 };

  constructor(private readonly deps: ArtifactCopierDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? ((line) => console.log(line));
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Copy these files (fire and forget). A file already being copied here is not copied
   *  twice by this process; Convex's guard covers another process. */
  enqueue(files: readonly TranscriptFileToCopy[]): void {
    if (this.closed) return;
    for (const f of files) {
      if (this.inFlight.has(f.fileId)) continue;
      this.inFlight.add(f.fileId);
      this.queue.push(f);
    }
    this.pump();
  }

  /** Stop taking work (the conversation's socket is gone); copies running finish. */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  /** Resolves when nothing is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 5));
  }

  private pump(): void {
    while (this.running < COPY_CONCURRENCY && this.queue.length > 0) {
      const file = this.queue.shift()!;
      this.running++;
      void this.copyWithRetries(file).finally(() => {
        this.running--;
        this.inFlight.delete(file.fileId);
        this.pump();
      });
    }
  }

  /** One file, with the bounded retry; the outcome is reported to Convex exactly once. */
  async copyWithRetries(file: TranscriptFileToCopy): Promise<CopyOutcome> {
    let outcome: CopyOutcome = { kind: "retry", reason: "not_attempted" };
    for (let attempt = 0; ; attempt++) {
      outcome = await this.copyOnce(file);
      if (outcome.kind !== "retry") break;
      const delay = COPY_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || this.closed) break;
      this.stats.retries++;
      await this.sleep(delay);
    }
    try {
      if (outcome.kind === "copied") {
        if (outcome.duplicate) this.stats.duplicates++;
        else this.stats.copied++;
      } else {
        if (outcome.kind === "gone") this.stats.gone++;
        else if (outcome.kind === "refused") this.stats.refused++;
        else this.stats.deferred++;
        await this.deps.failed({ fileId: file.fileId, outcome: outcome.kind, reason: outcome.reason });
      }
    } catch (err) {
      // The report is lost, not the file: it stays `pending` and is asked again.
      this.log(`[transcript-files] file=${file.fileId} outcome report failed (non-fatal): ${errForLog(err)}`);
    }
    return outcome;
  }

  /** One attempt: open the source, stream it into storage, finalize. Never throws. */
  async copyOnce(file: TranscriptFileToCopy): Promise<CopyOutcome> {
    const maxBytes = this.deps.maxBytes();
    if (typeof file.sizeBytes === "number" && file.sizeBytes > maxBytes) {
      return { kind: "refused", reason: "too_large" };
    }
    let opened: { stream: Readable; mimeType: string } | CopyOutcome;
    try {
      opened = file.artifactId !== undefined ? await this.openManaged(file, maxBytes) : await this.openMedia(file);
    } catch (err) {
      return { kind: "retry", reason: `open_failed:${err instanceof Error ? err.name : "unknown"}` };
    }
    if ("kind" in opened) return opened;
    const m = meter(maxBytes);
    opened.stream.once("error", (e) => m.stream.destroy(e as Error));
    m.stream.once("error", () => opened.stream.destroy());
    let storageId: string;
    try {
      storageId = await this.deps.upload(opened.stream.pipe(m.stream), opened.mimeType);
    } catch (err) {
      if (causedByTooLarge(err)) return { kind: "refused", reason: "too_large" };
      this.log(`[transcript-files] file=${file.fileId} upload failed (will retry): ${errForLog(err)}`);
      return { kind: "retry", reason: "upload_failed" };
    }
    const { sha256, bytes } = m.digest();
    try {
      const answer = await this.deps.copied({
        fileId: file.fileId,
        storageId,
        sha256,
        sizeBytes: bytes,
        mimeType: opened.mimeType,
      });
      if (answer.ok !== true) return { kind: "retry", reason: "finalize_unacknowledged" };
      return { kind: "copied", duplicate: answer.duplicate === true };
    } catch (err) {
      this.log(`[transcript-files] file=${file.fileId} finalize failed (will retry): ${errForLog(err)}`);
      return { kind: "retry", reason: "finalize_failed" };
    }
  }

  /** A managed file: the download grant, then its ticketed URL read without credentials. */
  private async openManaged(
    file: TranscriptFileToCopy,
    maxBytes: number,
  ): Promise<{ stream: Readable; mimeType: string } | CopyOutcome> {
    const grant = await this.deps.download(file.sessionKey, file.artifactId!);
    if (!grant.ok) {
      if (grant.reason === "artifact_not_found") return { kind: "gone", reason: "artifact_not_found" };
      if (grant.reason === "artifact_download_unsupported") return { kind: "refused", reason: "download_unsupported" };
      return { kind: "retry", reason: "download_refused" };
    }
    const mimeType = grant.mimeType ?? file.mimeType ?? "application/octet-stream";
    if (typeof grant.sizeBytes === "number" && grant.sizeBytes > maxBytes) {
      return { kind: "refused", reason: "too_large" };
    }
    if (grant.url === undefined) {
      // `bytes` mode: the bytes rode the answer.
      const bytes = Buffer.from(grant.data ?? "", "base64");
      return { stream: Readable.from([bytes]), mimeType };
    }
    const base = this.deps.httpBase().replace(/\/+$/, "");
    let target: URL;
    try {
      target = new URL(grant.url, `${base}/`);
    } catch {
      return { kind: "retry", reason: "bad_download_url" };
    }
    // Only the gateway's own managed route, on the gateway's own origin: the answer is read
    // as data, and a URL that points anywhere else is not followed.
    if (target.origin !== new URL(`${base}/`).origin || !target.pathname.startsWith(MANAGED_ROUTE_PREFIX)) {
      return { kind: "retry", reason: "foreign_download_url" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.connectTimeoutMs ?? 60_000);
    timer.unref?.();
    try {
      const res = await this.fetchImpl(target.toString(), {
        headers: this.deps.identityHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 404) {
        void res.body?.cancel().catch(() => {});
        // The ticket was minted, then the record left the transcript (a reset raced us).
        return { kind: "gone", reason: "not_found" };
      }
      if (!res.ok || res.body === null) {
        void res.body?.cancel().catch(() => {});
        return { kind: "retry", reason: `http_${res.status}` };
      }
      const len = Number.parseInt(res.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(len) && len > maxBytes) {
        void res.body.cancel().catch(() => {});
        return { kind: "refused", reason: "too_large" };
      }
      const served = res.headers.get("content-type")?.split(";")[0]?.trim();
      return {
        stream: Readable.fromWeb(res.body as NodeWebReadableStream),
        mimeType: served || mimeType,
      };
    } catch {
      return { kind: "retry", reason: "fetch_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A `MEDIA:` reference: the gateway's media route, named with the row's session. */
  private async openMedia(file: TranscriptFileToCopy): Promise<{ stream: Readable; mimeType: string } | CopyOutcome> {
    const fetcher = this.deps.mediaFetcher();
    if (fetcher === undefined) return { kind: "refused", reason: "media_disabled" };
    const opened = await fetcher.open(file.mediaSource!, { sessionKey: file.sessionKey });
    if (!opened.ok) {
      if (FETCH_GONE.has(opened.reason)) return { kind: "gone", reason: opened.reason };
      if (FETCH_REFUSED.has(opened.reason)) return { kind: "refused", reason: opened.reason };
      return { kind: "retry", reason: opened.reason };
    }
    if (opened.readError?.()) return { kind: "retry", reason: "read_error" };
    return { stream: opened.stream, mimeType: opened.mimeType || file.mimeType || "application/octet-stream" };
  }
}
