// Phase 3 — shared-fs INBOUND large media. Convex classifies tool-read files (in
// shared-fs mode) as "references": a short-lived getUrl instead of inline base64.
// The bridge STREAMS each reference to a shared volume (no buffer, no base64 → any
// size) and INJECTS the gateway-visible path into the chat message as a
// `[FICHIERS REÇUS]` block (modeled EXACTLY on the proven OpenWebUI pipe). The agent
// reads the file BY PATH (office-to-md / docling / transcription), bypassing the WS
// maxPayload ceiling. KEY difference from the pipe: there OpenWebUI had already
// written the file; HERE the bridge writes the bytes itself (streamed from Convex).

import { constants, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fillTemplate, type InboundInjection } from "./instance-config.js";

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
  /** Published dir the bridge WRITES and the gateway mounts read-only. */
  inboundDir: string;
  /** Private same-filesystem dir used for incomplete files; never gateway-mounted. */
  stagingDir: string;
  /** The gateway-visible mount prefix the agent reads the file from. */
  agentMount: string;
  /** Per-file byte cap — abort + delete the partial file above it. */
  maxBytes: number;
  /** Injected fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected file close (tests). Defaults to FileHandle.close. */
  closeFileImpl?: (file: FileHandle) => Promise<void>;
}

export const INBOUND_TOO_LARGE = "inbound_media_too_large";
export const INBOUND_COLLISION = "inbound_media_collision";
export const INBOUND_FETCH_FAILED = "inbound_media_fetch_failed";
export const INBOUND_PATH_REFUSED = "inbound_media_path_refused";
export const INBOUND_STAGE_FAILED = "inbound_media_stage_failed";
export const INBOUND_CLEANUP_FAILED = "inbound_media_cleanup_failed";

const PRIVATE_FILE_MODE = 0o600;
const SHARED_WRITE_MASK = 0o022;
const MAX_LEAF_BYTES = 255;
const CONTROL_OR_SEPARATOR = /[\u0000-\u001f\u007f/\\]/u;
const BOUNDED_FAILURES = new Set([
  INBOUND_TOO_LARGE,
  INBOUND_COLLISION,
  INBOUND_FETCH_FAILED,
  INBOUND_PATH_REFUSED,
  INBOUND_STAGE_FAILED,
  INBOUND_CLEANUP_FAILED,
]);
const RECOVERABLE_DROP_FAILURES = new Set([
  INBOUND_TOO_LARGE,
  INBOUND_COLLISION,
  INBOUND_FETCH_FAILED,
]);

function refused(code: string): Error {
  return new Error(code);
}

function boundedFailure(error: unknown): Error {
  if (error instanceof Error && BOUNDED_FAILURES.has(error.message)) {
    return error;
  }
  return refused(INBOUND_STAGE_FAILED);
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function sameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validLeaf(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    value === value.normalize("NFC") &&
    Buffer.byteLength(value) <= MAX_LEAF_BYTES &&
    !CONTROL_OR_SEPARATOR.test(value) &&
    basename(value) === value
  );
}

function anchoredChildPath(
  directory: FileHandle,
  configuredPath: string,
  name: string,
): string {
  // Linux exposes a held directory descriptor as a traversable path. Production
  // opens through it so replacing any configured parent cannot redirect writes.
  return process.platform === "linux"
    ? `/proc/self/fd/${directory.fd}/${name}`
    : join(configuredPath, name);
}

async function openPrivateDirectory(path: string): Promise<FileHandle> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw refused(INBOUND_PATH_REFUSED);
  }
  const root = parse(path).root;
  let current = root;
  const expectedUid = process.geteuid?.();
  if (expectedUid === undefined) {
    throw refused(INBOUND_PATH_REFUSED);
  }
  try {
    for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const metadata = await lstat(current);
      const sharedWritable = (metadata.mode & SHARED_WRITE_MASK) !== 0;
      const sticky = (metadata.mode & 0o1000) !== 0;
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        ![0, expectedUid].includes(metadata.uid) ||
        (sharedWritable && !sticky)
      ) {
        throw refused(INBOUND_PATH_REFUSED);
      }
    }
    if ((await realpath(path)) !== path) {
      throw refused(INBOUND_PATH_REFUSED);
    }
  } catch (error) {
    throw boundedFailure(error);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const directoryOnly = constants.O_DIRECTORY ?? 0;
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | directoryOnly | noFollow);
  } catch {
    throw refused(INBOUND_PATH_REFUSED);
  }
  try {
    await assertPrivateDirectory(path, handle);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw boundedFailure(error);
  }
}

async function assertPrivateDirectory(
  path: string,
  handle: FileHandle,
): Promise<void> {
  let opened: Stats;
  let current: Stats;
  try {
    [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
  } catch {
    throw refused(INBOUND_PATH_REFUSED);
  }
  const expectedUid = process.geteuid?.();
  if (
    expectedUid === undefined ||
    !opened.isDirectory() ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameObject(opened, current) ||
    opened.uid !== expectedUid ||
    (opened.mode & SHARED_WRITE_MASK) !== 0
  ) {
    throw refused(INBOUND_PATH_REFUSED);
  }
}

interface MediaDirectories {
  published: FileHandle;
  staging: FileHandle;
}

async function openMediaDirectories(
  config: InboundMediaConfig,
): Promise<MediaDirectories> {
  const stagingFromPublished = relative(config.inboundDir, config.stagingDir);
  const publishedFromStaging = relative(config.stagingDir, config.inboundDir);
  if (
    stagingFromPublished === "" ||
    (!stagingFromPublished.startsWith(`..${sep}`) &&
      stagingFromPublished !== "..") ||
    (!publishedFromStaging.startsWith(`..${sep}`) &&
      publishedFromStaging !== "..")
  ) {
    throw refused(INBOUND_PATH_REFUSED);
  }
  const published = await openPrivateDirectory(config.inboundDir);
  let staging: FileHandle | undefined;
  try {
    staging = await openPrivateDirectory(config.stagingDir);
    const [publishedStat, stagingStat] = await Promise.all([
      published.stat(),
      staging.stat(),
    ]);
    if (
      publishedStat.dev !== stagingStat.dev ||
      sameObject(publishedStat, stagingStat)
    ) {
      throw refused(INBOUND_PATH_REFUSED);
    }
    return { published, staging };
  } catch (error) {
    await staging?.close().catch(() => undefined);
    await published.close().catch(() => undefined);
    throw boundedFailure(error);
  }
}

/** Validate the private/published directory boundary without staging content. */
export async function validateInboundDirectoryPair(
  inboundDir: string,
  stagingDir: string,
): Promise<void> {
  const directories = await openMediaDirectories({
    inboundDir,
    stagingDir,
    agentMount: "/",
    maxBytes: 1,
  });
  const stagingClosed = await directories.staging
    .close()
    .then(() => true)
    .catch(() => false);
  const publishedClosed = await directories.published
    .close()
    .then(() => true)
    .catch(() => false);
  if (!stagingClosed || !publishedClosed) {
    throw refused(INBOUND_CLEANUP_FAILED);
  }
}

async function assertInboundFile(
  path: string,
  handle: FileHandle,
  expectedLinks: number,
): Promise<Stats> {
  let opened: Stats;
  let current: Stats;
  try {
    [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
  } catch {
    throw refused(INBOUND_PATH_REFUSED);
  }
  if (
    !opened.isFile() ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameObject(opened, current) ||
    opened.nlink !== expectedLinks ||
    current.nlink !== expectedLinks ||
    (opened.mode & 0o777) !== PRIVATE_FILE_MODE ||
    opened.uid !== process.geteuid?.()
  ) {
    throw refused(INBOUND_PATH_REFUSED);
  }
  return opened;
}

async function removeOwnedPartial(
  path: string,
  identity: Stats,
  expectedLinks: number,
): Promise<boolean> {
  try {
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameObject(identity, current) ||
      current.nlink !== expectedLinks ||
      current.uid !== identity.uid ||
      (current.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      return false;
    }
    await unlink(path);
    return true;
  } catch (error) {
    return errno(error) === "ENOENT";
  }
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw refused(INBOUND_STAGE_FAILED);
  }
  throw refused(INBOUND_COLLISION);
}

/** Sanitize a user-supplied filename to a safe basename (defeats path traversal). */
export function safeBasename(fileName: string): string {
  const portable = String(fileName ?? "")
    .normalize("NFC")
    .replaceAll("\\", "/");
  const base = basename(portable);
  if (!validLeaf(base)) {
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
interface PublishedReceipt {
  diskName: string;
  identity: Stats;
}

interface OwnedStageResult {
  staged: StagedInboundFile;
  receipt: PublishedReceipt;
}

async function stageInboundReferenceOwned(
  ref: InboundReference,
  diskName: string,
  config: InboundMediaConfig,
): Promise<OwnedStageResult> {
  if (
    !validLeaf(diskName) ||
    !Number.isSafeInteger(config.maxBytes) ||
    config.maxBytes < 1
  ) {
    throw refused(INBOUND_PATH_REFUSED);
  }
  const stagingName = `.atrium-inbound-${process.pid}-${randomBytes(16).toString("hex")}.part`;
  const directories = await openMediaDirectories(config);
  const publishedDirectory = directories.published;
  const stagingDirectory = directories.staging;
  const diskPath = join(config.inboundDir, diskName);
  const finalWritePath = anchoredChildPath(
    publishedDirectory,
    config.inboundDir,
    diskName,
  );
  const stagingPath = join(config.stagingDir, stagingName);
  const stagingWritePath = anchoredChildPath(
    stagingDirectory,
    config.stagingDir,
    stagingName,
  );
  let file: FileHandle | undefined;
  let identity: Stats | undefined;
  let failure: Error | undefined;
  let committed = false;
  let published = false;
  let stagingPresent = false;
  let written = 0;

  try {
    try {
      file = await open(
        stagingWritePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
      );
      stagingPresent = true;
    } catch (error) {
      if (errno(error) === "EEXIST" || errno(error) === "ELOOP") {
        throw refused(INBOUND_COLLISION);
      }
      throw refused(INBOUND_STAGE_FAILED);
    }
    identity = await file.stat();
    identity = await assertInboundFile(stagingPath, file, 1);
    await requireAbsent(finalWritePath);

    const fetchImpl = config.fetchImpl ?? fetch;
    const res = await fetchImpl(ref.url).catch(() => {
      throw refused(INBOUND_FETCH_FAILED);
    });
    if (!res.ok || res.body === null) {
      throw refused(INBOUND_FETCH_FAILED);
    }

    const cap = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        written += chunk.length;
        if (written > config.maxBytes) {
          callback(refused(INBOUND_TOO_LARGE));
          return;
        }
        callback(null, chunk);
      },
    });
    const sink = new Writable({
      async write(chunk: Buffer, _encoding, callback) {
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const result = await file!.write(
              chunk,
              offset,
              chunk.length - offset,
            );
            if (result.bytesWritten < 1) {
              throw refused(INBOUND_STAGE_FAILED);
            }
            offset += result.bytesWritten;
          }
          identity = await assertInboundFile(stagingPath, file!, 1);
          callback();
        } catch (error) {
          callback(boundedFailure(error));
        }
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      cap,
      sink,
    );
    await file.sync();
    identity = await assertInboundFile(stagingPath, file, 1);
    await assertPrivateDirectory(config.inboundDir, publishedDirectory);
    await assertPrivateDirectory(config.stagingDir, stagingDirectory);
    try {
      await link(stagingWritePath, finalWritePath);
      published = true;
    } catch (error) {
      if (errno(error) === "EEXIST") {
        throw refused(INBOUND_COLLISION);
      }
      throw refused(INBOUND_STAGE_FAILED);
    }
    identity = await assertInboundFile(diskPath, file, 2);
    if (!(await removeOwnedPartial(stagingWritePath, identity, 2))) {
      throw refused(INBOUND_CLEANUP_FAILED);
    }
    stagingPresent = false;
    identity = await assertInboundFile(diskPath, file, 1);
    await stagingDirectory.sync();
    await publishedDirectory.sync();
    await assertPrivateDirectory(config.inboundDir, publishedDirectory);
    await assertPrivateDirectory(config.stagingDir, stagingDirectory);
    committed = true;
  } catch (error) {
    failure = boundedFailure(error);
  } finally {
    if (file !== undefined) {
      try {
        if (config.closeFileImpl !== undefined) {
          await config.closeFileImpl(file);
        } else {
          await file.close();
        }
      } catch {
        if (!committed) failure = refused(INBOUND_STAGE_FAILED);
      }
    }
  }

  if (failure !== undefined) {
    const finalExpectedLinks = stagingPresent ? 2 : 1;
    const finalCleaned =
      !published ||
      (identity !== undefined &&
        (await removeOwnedPartial(
          finalWritePath,
          identity,
          finalExpectedLinks,
        )));
    const stagingCleaned =
      !stagingPresent ||
      (identity !== undefined &&
        (await removeOwnedPartial(stagingWritePath, identity, 1)));
    const stagingSynced = await stagingDirectory
      .sync()
      .then(() => true)
      .catch(() => false);
    const publishedSynced = await publishedDirectory
      .sync()
      .then(() => true)
      .catch(() => false);
    const stagingClosed = await stagingDirectory
      .close()
      .then(() => true)
      .catch(() => false);
    const publishedClosed = await publishedDirectory
      .close()
      .then(() => true)
      .catch(() => false);
    if (
      !finalCleaned ||
      !stagingCleaned ||
      !stagingSynced ||
      !publishedSynced ||
      !stagingClosed ||
      !publishedClosed
    ) {
      throw refused(INBOUND_CLEANUP_FAILED);
    }
    throw failure;
  }
  // The file and directory were both fsynced before this point. A close error
  // cannot safely be retried and must not report failure after publication.
  await stagingDirectory.close().catch(() => undefined);
  await publishedDirectory.close().catch(() => undefined);

  const agentPath = `${config.agentMount.replace(/\/$/, "")}/${diskName}`;
  return {
    staged: { agentPath, size: written, mimeType: ref.mimeType },
    receipt: { diskName, identity: identity! },
  };
}

/** Stage one reference and return only the public, gateway-visible receipt. */
export async function stageInboundReference(
  ref: InboundReference,
  diskName: string,
  config: InboundMediaConfig,
): Promise<StagedInboundFile> {
  return (await stageInboundReferenceOwned(ref, diskName, config)).staged;
}

/**
 * Build the `[FICHIERS REÇUS]` text block injected into the chat message (mirrors
 * the OpenWebUI pipe). Returns "" when nothing staged (no empty block).
 *
 * `inbound_files` injection (tri-state on the resolved injection Convex sent):
 *   - `enabled:false` (admin disabled) → "" (no block at all);
 *   - `enabled:true` with a usable template → the admin's text, `{files}` filled;
 *   - `undefined` (pre-feature Convex) OR a malformed `enabled:true` with an empty template
 *     → the bridge's own default header + list (a present-but-empty entry falls back, never
 *     silently drops the block). Only an explicit disable suppresses it.
 * The per-file list itself is always Atrium-generated; only the surrounding preamble is
 * configurable.
 */
export function buildFilesReceivedBlock(
  staged: StagedInboundFile[],
  injection?: InboundInjection,
): string {
  if (staged.length === 0) return "";
  const files = staged
    .map((f) => {
      const bits: string[] = [];
      if (f.size > 0) bits.push(`${f.size} o`);
      if (f.mimeType) bits.push(f.mimeType);
      const suffix = bits.length > 0 ? ` (${bits.join(", ")})` : "";
      return `- ${f.agentPath}${suffix}`;
    })
    .join("\n");
  if (injection !== undefined && !injection.enabled) return ""; // explicit disable
  if (injection !== undefined && injection.template.length > 0) {
    return "\n" + fillTemplate(injection.template, { files });
  }
  return ["", "[FICHIERS REÇUS]", files].join("\n"); // absent OR enabled-but-empty
}

async function rollbackPublished(
  receipts: PublishedReceipt[],
  config: InboundMediaConfig,
): Promise<boolean> {
  if (receipts.length === 0) return true;
  let publishedDirectory: FileHandle;
  try {
    // Rollback only needs the published boundary. Re-opening the staging
    // directory here would strand earlier publications when a later file fails
    // precisely because that staging mount disappeared or became unsafe.
    publishedDirectory = await openPrivateDirectory(config.inboundDir);
  } catch {
    return false;
  }
  let cleaned = true;
  for (const receipt of [...receipts].reverse()) {
    const path = anchoredChildPath(
      publishedDirectory,
      config.inboundDir,
      receipt.diskName,
    );
    if (!(await removeOwnedPartial(path, receipt.identity, 1))) {
      cleaned = false;
    }
  }
  const synced = await publishedDirectory
    .sync()
    .then(() => true)
    .catch(() => false);
  const publishedClosed = await publishedDirectory
    .close()
    .then(() => true)
    .catch(() => false);
  return cleaned && synced && publishedClosed;
}

/**
 * Stage every reference. Fetch, size, and collision failures drop only that file.
 * A local-path or cleanup failure aborts the turn and rolls back every file this
 * batch already published. `prefix` is the turn's clientMessageId.
 */
export async function stageInboundReferences(
  refs: InboundReference[],
  prefix: string,
  config: InboundMediaConfig,
  onDrop?: (fileName: string, reason: string) => void,
): Promise<StagedInboundFile[]> {
  const staged: StagedInboundFile[] = [];
  const receipts: PublishedReceipt[] = [];
  for (const [i, ref] of refs.entries()) {
    try {
      const result = await stageInboundReferenceOwned(
        ref,
        inboundDiskName(prefix, i, ref.fileName),
        config,
      );
      staged.push(result.staged);
      receipts.push(result.receipt);
    } catch (err) {
      if (
        !(err instanceof Error) ||
        !RECOVERABLE_DROP_FAILURES.has(err.message)
      ) {
        if (!(await rollbackPublished(receipts, config))) {
          throw refused(INBOUND_CLEANUP_FAILED);
        }
        throw boundedFailure(err);
      }
      onDrop?.(safeBasename(ref.fileName), err.message);
    }
  }
  return staged;
}
