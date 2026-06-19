// Phase 3 — shared-fs INBOUND large media. Convex classifies tool-read files (in
// shared-fs mode) as "references": a short-lived getUrl instead of inline base64.
// The bridge STREAMS each reference to a shared volume (no buffer, no base64 → any
// size) and INJECTS the gateway-visible path into the chat message as a
// `[FICHIERS REÇUS]` block (modeled EXACTLY on the proven OpenWebUI pipe). The agent
// reads the file BY PATH (office-to-md / docling / transcription), bypassing the WS
// maxPayload ceiling. KEY difference from the pipe: there OpenWebUI had already
// written the file; HERE the bridge writes the bytes itself (streamed from Convex).

import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** One inbound tool-read file to stream from Convex storage. */
export interface InboundReference {
  /** Short-lived Convex getUrl the bridge GETs (server-minted; never client). */
  url: string;
  mimeType: string;
  fileName: string;
}

/** A staged file, ready to be referenced in the `[FICHIERS REÇUS]` block. */
export interface StagedInboundFile {
  /** The GATEWAY-visible path the agent reads (after dir → mount translation). */
  agentPath: string;
  /** Bytes written to disk. */
  size: number;
  mimeType: string;
}

export interface InboundMediaConfig {
  /** Dir the bridge WRITES inbound files to (bind-mounted into the gateway). */
  inboundDir: string;
  /** The gateway-visible mount prefix the agent reads the file from. */
  agentMount: string;
  /** Per-file byte cap — abort + delete the partial file above it. */
  maxBytes: number;
  /** Injected fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export const INBOUND_TOO_LARGE = "inbound_media_too_large";

/** Sanitize a user-supplied filename to a safe basename (defeats path traversal). */
export function safeBasename(fileName: string): string {
  const base = basename(String(fileName ?? ""));
  if (
    base === "" ||
    base === "." ||
    base === ".." ||
    base.includes("/") ||
    base.includes(sep)
  ) {
    return "file";
  }
  return base;
}

/** A unique, collision-free on-disk name (deterministic — no Math.random). */
export function inboundDiskName(
  prefix: string,
  index: number,
  fileName: string,
): string {
  return `${safeBasename(prefix)}-${index}-${safeBasename(fileName)}`;
}

/**
 * Stream ONE reference to `inboundDir/<diskName>` and return its gateway-visible
 * path. Enforces `maxBytes` MID-STREAM (so an oversize file never fully lands) and
 * deletes a partial file on ANY error — a half-written path must NEVER be injected.
 */
export async function stageInboundReference(
  ref: InboundReference,
  diskName: string,
  config: InboundMediaConfig,
): Promise<StagedInboundFile> {
  const fetchImpl = config.fetchImpl ?? fetch;
  await mkdir(config.inboundDir, { recursive: true });
  const diskPath = join(config.inboundDir, diskName);

  const res = await fetchImpl(ref.url);
  if (!res.ok || res.body === null) {
    throw new Error(`inbound fetch failed (status ${res.status})`);
  }

  let written = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > config.maxBytes) {
        cb(new Error(INBOUND_TOO_LARGE));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      cap,
      createWriteStream(diskPath),
    );
  } catch (err) {
    // Never leave a partial file (a truncated path injected to the agent is worse
    // than a clean failure). Best-effort delete; rethrow for the caller to drop it.
    await rm(diskPath, { force: true }).catch(() => {});
    throw err;
  }

  const agentPath = `${config.agentMount.replace(/\/$/, "")}/${diskName}`;
  return { agentPath, size: written, mimeType: ref.mimeType };
}

/**
 * Build the `[FICHIERS REÇUS]` text block injected into the chat message (mirrors
 * the OpenWebUI pipe). Returns "" when nothing staged (no empty block).
 */
export function buildFilesReceivedBlock(staged: StagedInboundFile[]): string {
  if (staged.length === 0) return "";
  const lines: string[] = ["", "[FICHIERS REÇUS]"];
  for (const f of staged) {
    const bits: string[] = [];
    if (f.size > 0) bits.push(`${f.size} o`);
    if (f.mimeType) bits.push(f.mimeType);
    const suffix = bits.length > 0 ? ` (${bits.join(", ")})` : "";
    lines.push(`- ${f.agentPath}${suffix}`);
  }
  return lines.join("\n");
}

/**
 * Stage every reference (best-effort per file — one failure drops only THAT file,
 * never the turn) and return the staged files for the block. `prefix` (the turn's
 * clientMessageId) makes on-disk names unique + idempotent across retries.
 */
export async function stageInboundReferences(
  refs: InboundReference[],
  prefix: string,
  config: InboundMediaConfig,
  onDrop?: (fileName: string, reason: string) => void,
): Promise<StagedInboundFile[]> {
  const staged: StagedInboundFile[] = [];
  for (const [i, ref] of refs.entries()) {
    try {
      staged.push(
        await stageInboundReference(
          ref,
          inboundDiskName(prefix, i, ref.fileName),
          config,
        ),
      );
    } catch (err) {
      onDrop?.(
        safeBasename(ref.fileName),
        err instanceof Error ? err.message : "stage_failed",
      );
    }
  }
  return staged;
}
