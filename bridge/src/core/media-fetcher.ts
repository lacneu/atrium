// MediaFetcher — resolves an outbound media PATH (surfaced by a provider's
// normalizer) to a readable byte STREAM the writer pipes into Convex File
// Storage. This is the provider/deployment seam for OUTBOUND attachments.
//
// Why a STREAM (not bytes/base64): the bytes go bridge -> Convex via an upload
// URL (ctx.storage.generateUploadUrl), which accepts a raw-binary POST with NO
// size limit. Streaming disk -> network means zero base64 inflation (~33%
// saved), no 20MB httpAction ceiling, and no full-file buffer in the bridge
// (large videos/images don't blow memory). This mirrors the community-proposed
// HTTP-streaming file transfer (openclaw issue #11769) instead of the base64
// path that the OpenClaw WS protocol forces (its JSON frames + a `maxPayload`
// frame cap are exactly why OpenClaw itself base64s small files and offloads
// large ones to the filesystem).
//
// Why an interface: there is NO remote media RPC on the OpenClaw gateway
// v2026.5.19 (verified: no HTTP file route, `artifacts.*` empty, WS is JSON).
// The proven mechanism (docs/BRIDGE_PROTOCOL.md + docs/DEPLOYMENT.md) is a
// read-only mount of the gateway's `media/outbound`. `LocalDirMediaFetcher`
// streams from that mount (prod) or a synced/SSHFS dir (dev). Hermes — or a
// future OpenClaw plugin HTTP endpoint — implements the same interface without
// touching the writer.

import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { basename, join, resolve, sep } from "node:path";

export interface OpenedMedia {
  /** Raw byte stream of the file (no base64, no full buffer). */
  stream: Readable;
  mimeType: string;
  /**
   * Byte size IF known UP FRONT (shared-fs stat; an HTTP Content-Length/meta.size),
   * else `null` — a chunked gateway-http download (the 6.5 case) has no size until
   * drained. `null` means UNKNOWN, NOT empty: the diagnostic must bucket it as
   * "unknown" rather than "0" (which would read as an empty file).
   */
  size: number | null;
  /**
   * The error the byte stream emitted BEFORE the consumer attached, or null — set
   * by fetchers whose stream can fail asynchronously in the window between open()
   * and the upload's first read (the local-fs `createReadStream`: file removed
   * after the stat, EACCES, EMFILE). The consumer MUST check this after any await
   * that precedes consuming `stream` and treat a non-null result as a DROP: a
   * swallowed early error otherwise settles the stream so `Readable.toWeb` yields
   * 0 bytes cleanly -> a SILENT empty upload. Absent (network fetchers) => null:
   * their stream comes from an already-resolved fetch body, so failures surface at
   * open() (fetch_error) or mid-read (propagated through toWeb -> the fetch throws).
   */
  readError?: () => Error | null;
}

/**
 * Marker `code` for the cap-exceeded error thrown by a fetcher that can only
 * enforce the size limit ON THE FLOW (gateway-http, when the gateway omits
 * Content-Length/meta.size). It surfaces mid-stream — i.e. AFTER `open()` already
 * returned `ok:true` — so the writer's stream/upload catch must recognise it and
 * report `too_large` (operator fix = raise the cap / shrink the file) instead of a
 * generic `upload_error` (which points at storage). Defined here, the shared seam,
 * so the thrower (gateway-http fetcher) and the catcher (convex-writer) agree on
 * one string.
 */
export const MEDIA_TOO_LARGE_CODE = "media_too_large";

/**
 * Why a fetcher could NOT open an outbound media path. STRUCTURAL reason CODES
 * (no filename, no path, no content) — safe to surface on the observability API
 * (SOC2). Each maps to a DIFFERENT operator fix, so the caller + the diagnostic
 * trace keep them distinct rather than collapsing to a bare "dropped":
 *   - not_found        -> file absent on the bridge's view (classic shared-FS /
 *                         mount-not-wired / wrong-host case)
 *   - too_large        -> exceeds OPENCLAW_MEDIA_MAX_MB (raise the cap)
 *   - path_escape      -> resolved outside the media root (security reject)
 *   - symlink_rejected -> a symlink in the media dir (security reject)
 *   - not_a_file       -> a dir / socket / device at that path
 *   - invalid_filename -> empty / "." / ".." / separator in the basename
 *   - fetch_error      -> a transport/IO failure specific to a network fetcher
 *                         (incl. a timeout/abort — never lets the turn hang)
 *   - route_absent     -> the gateway has no `/__openclaw__/assistant-media` route
 *                         (gateway-http mode against a pre-6.x gateway): a
 *                         DISTINCT, actionable signal to switch to shared-fs,
 *                         not a transient transport blip
 */
export type MediaSkipReason =
  | "not_found"
  | "too_large"
  | "path_escape"
  | "symlink_rejected"
  | "not_a_file"
  | "invalid_filename"
  | "fetch_error"
  | "route_absent"
  // The source is OLDER than the caller's freshness bound: the path was merely
  // MENTIONED (e.g. the agent read memory notes citing last week's deliveries),
  // not produced this turn — re-delivering it would attach stale files.
  | "stale_mention"
  // A mention-only path whose age CANNOT be verified (gateway-http against a
  // gateway that reports no mtime and no Last-Modified — live-probed on 6.11:
  // neither exists). Failing OPEN here is exactly the stale re-delivery bug, so
  // an unverifiable MENTION is refused; explicit MEDIA:/structured deliveries
  // never carry a freshness bound and are unaffected.
  | "unverifiable_mention";

/** Discriminated open() outcome: the bytes, or the structural reason it failed. */
export type OpenResult =
  | ({ ok: true } & OpenedMedia)
  | { ok: false; reason: MediaSkipReason };

export interface MediaFetcher {
  /**
   * Open `path` (an absolute outbound media path the normalizer already
   * validated against traversal / scheme / inbound) as a readable byte stream
   * + mime + size. Returns `{ ok: false, reason }` when the file is missing, too
   * large, or escapes the configured root — the caller treats a failure as "no
   * attachment" (never breaks the turn) but records the structural REASON so the
   * outbound-media path is diagnosable remotely (SOC2-safe codes, never a path).
   *
   * `opts.rejectOlderThanMs`: when set, a source whose last-modified time is
   * KNOWN and OLDER is refused with reason "stale_mention" — the freshness guard
   * for paths merely MENTIONED in tool output (an agent reading its memory notes
   * must not re-deliver last week's files). An UNKNOWN mtime fails OPEN
   * (delivered) so a legit delivery is never lost to a missing signal.
   */
  open(
    path: string,
    opts?: { rejectOlderThanMs?: number | null },
  ): Promise<OpenResult>;
}

// Minimal extension -> mime map for the file kinds the chat matrix exercises
// (markdown, office docs, images, audio/video, archives). Unknown ->
// octet-stream so the browser still offers a download.
const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

export function mimeForFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export interface LocalDirMediaFetcherOptions {
  /** Directory the bridge reads outbound files from (the `:ro` mount / sync). */
  baseDir: string;
  /** Reject files larger than this (a safety valve; streaming has no real ceiling). */
  maxBytes: number;
  /** Injected for tests; defaults to a structural (non-PHI) console warning. */
  onSkip?: (reason: string, filename: string) => void;
}

/**
 * Streams outbound media bytes from a local directory (the gateway's
 * `media/outbound` mounted read-only, or a synced copy in dev). The gateway's
 * absolute path is mapped onto `baseDir` by BASENAME only, so the mount point is
 * decoupled from the gateway's `/home/node/.openclaw/...` layout.
 */
export class LocalDirMediaFetcher implements MediaFetcher {
  private readonly baseDir: string;
  private readonly maxBytes: number;
  private readonly onSkip: (reason: string, filename: string) => void;

  constructor(opts: LocalDirMediaFetcherOptions) {
    this.baseDir = resolve(opts.baseDir);
    this.maxBytes = opts.maxBytes;
    this.onSkip =
      opts.onSkip ??
      ((reason, filename) =>
        // Filename is structural (non-PHI); never log bytes/content.
        console.warn(`[media] skip ${filename}: ${reason}`));
  }

  async open(
    path: string,
    opts?: { rejectOlderThanMs?: number | null },
  ): Promise<OpenResult> {
    const filename = basename(path);
    // Defense in depth: the normalizer already rejected "..", but a bad basename
    // (".", "..", empty, or containing a separator) must never reach a join.
    if (
      filename === "" ||
      filename === "." ||
      filename === ".." ||
      filename.includes("/") ||
      filename.includes(sep)
    ) {
      this.onSkip("invalid filename", filename || "<empty>");
      return { ok: false, reason: "invalid_filename" };
    }
    const resolved = resolve(join(this.baseDir, filename));
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + sep)) {
      this.onSkip("path escapes media dir", filename);
      return { ok: false, reason: "path_escape" };
    }
    let size: number;
    try {
      // lstat (NOT stat): the prefix check above only constrains the LINK path to
      // baseDir, not its TARGET. A symlink INSIDE baseDir (e.g. a tool/agent that
      // can write to the mounted media/outbound dir creates
      // `report.pdf -> /etc/passwd` and then emits that filename) would otherwise
      // have stat() follow it and createReadStream() exfiltrate a file OUTSIDE the
      // media dir. lstat does not follow the link, so a symlink is rejected here
      // (isSymbolicLink), and the createReadStream below reads the real regular
      // file in baseDir — never a link target. Defense-in-depth (the realistic
      // vector is a static symlink, not a TOCTOU swap).
      const info = await lstat(resolved);
      if (info.isSymbolicLink()) {
        this.onSkip("symlink rejected (path escape)", filename);
        return { ok: false, reason: "symlink_rejected" };
      }
      if (!info.isFile()) {
        this.onSkip("not a file", filename);
        return { ok: false, reason: "not_a_file" };
      }
      // Freshness guard (mentioned-only paths): a file last modified BEFORE the
      // caller's bound was not produced this turn — refuse the re-delivery.
      if (
        opts?.rejectOlderThanMs != null &&
        info.mtimeMs < opts.rejectOlderThanMs
      ) {
        this.onSkip("stale mention (older than the current turn)", filename);
        return { ok: false, reason: "stale_mention" };
      }
      size = info.size;
    } catch {
      this.onSkip("not found", filename);
      return { ok: false, reason: "not_found" };
    }
    if (size > this.maxBytes) {
      this.onSkip(`too large (${size} > ${this.maxBytes} bytes)`, filename);
      return { ok: false, reason: "too_large" };
    }
    const stream = createReadStream(resolved);
    // CAPTURE (do not swallow) an error that fires BEFORE the consumer attaches:
    // the writer consumes this stream only after an async getUploadUrl round-trip,
    // so an fs error in that window (file removed after the stat, EACCES, EMFILE)
    // emits 'error' with no listener -> uncaughtException if unguarded. A bare
    // swallow avoids the crash but then settles the stream so `Readable.toWeb`
    // yields 0 bytes cleanly -> a SILENT empty upload. We instead HOLD the error
    // and expose it via readError(); the writer checks it after the round-trip and
    // drops. An error DURING the read (consumer already attached) still propagates
    // through toWeb -> the upload fetch throws -> drop (verified).
    let earlyError: Error | null = null;
    stream.once("error", (err: Error) => {
      earlyError = err;
    });
    return {
      ok: true,
      stream,
      mimeType: mimeForFilename(filename),
      size,
      readError: () => earlyError,
    };
  }
}
