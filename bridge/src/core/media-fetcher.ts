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
  size: number;
}

export interface MediaFetcher {
  /**
   * Open `path` (an absolute outbound media path the normalizer already
   * validated against traversal / scheme / inbound) as a readable byte stream
   * + mime + size. Returns null when the file is missing, too large, or escapes
   * the configured root — the caller treats null as "no attachment" and never
   * breaks the turn.
   */
  open(path: string): Promise<OpenedMedia | null>;
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

function mimeForFilename(filename: string): string {
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

  async open(path: string): Promise<OpenedMedia | null> {
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
      return null;
    }
    const resolved = resolve(join(this.baseDir, filename));
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + sep)) {
      this.onSkip("path escapes media dir", filename);
      return null;
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
        return null;
      }
      if (!info.isFile()) {
        this.onSkip("not a file", filename);
        return null;
      }
      size = info.size;
    } catch {
      this.onSkip("not found", filename);
      return null;
    }
    if (size > this.maxBytes) {
      this.onSkip(`too large (${size} > ${this.maxBytes} bytes)`, filename);
      return null;
    }
    const stream = createReadStream(resolved);
    return { stream, mimeType: mimeForFilename(filename), size };
  }
}
