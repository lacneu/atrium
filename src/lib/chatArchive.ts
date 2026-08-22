// Turning the bounded pages Convex hands out into one archive, and back.
//
// The loop lives HERE rather than on the server because the bytes are already in
// the browser and a folder of attachments is far larger than any single Convex
// read. Everything below is injected, so the orchestration — the cursors, the
// blob mapping, the undo — is testable without a backend.

import { readZip, writeZip, type ZipEntry } from "./zipStore";

/** Where the manifest lives inside the archive. */
export const MANIFEST_ENTRY = "manifest.json";
/** Prefix for a conversation's own row. */
export const CHAT_PREFIX = "chats/";
/** Prefix for a section page. */
export const SECTION_PREFIX = "sections/";
/** Prefix for the bytes of an attachment. */
export const BLOB_PREFIX = "blobs/";

/**
 * Ceiling on one archive, in bytes.
 *
 * The whole thing is assembled in memory, so this is what the tab can be asked
 * to hold. Hit, the build STOPS and says so — an archive silently missing its
 * last attachments would look complete.
 */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

/** Pages walked per section before the build gives up on a runaway cursor. */
export const MAX_SECTION_PAGES = 10_000;

/** Bytes a store-mode entry costs beyond its payload and its name: a local
 *  header (30) and a central directory entry (46). */
const ZIP_ENTRY_OVERHEAD = 76;

export class ArchiveTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    this.name = "ArchiveTooLarge";
  }
}

export interface ExportManifest {
  formatVersion: number;
  origin: string | null;
  sections: string[];
  notIncluded: { what: string; why: string }[];
  chatFieldsDropped: string[];
}

export interface SectionPage {
  rows: Record<string, unknown>[];
  blobs: { key: string; url: string | null; filename: string; mimeType: string }[];
  cursor: string | null;
}

export interface ExportSource {
  manifest(): Promise<ExportManifest>;
  chat(chatId: string): Promise<Record<string, unknown>>;
  section(
    chatId: string,
    section: string,
    cursor: string | null,
  ): Promise<SectionPage>;
  /** Fetch an attachment's bytes from the signed url the page carried. */
  blob(url: string): Promise<Uint8Array>;
}

/**
 * Build one archive from one or more conversations.
 *
 * Names inside the archive are ASCII BY CONSTRUCTION — the manifest, a section,
 * and a blob key which is a Convex identifier. It costs nothing and it means the
 * file opens even in unzip implementations old enough to ignore the UTF-8 flag,
 * which are still what a lot of people have.
 */
export async function buildArchive(
  source: ExportSource,
  chatIds: ReadonlyArray<string>,
): Promise<{
  archive: Uint8Array;
  manifest: ExportManifest;
  blobCount: number;
  /** Attachments a row names whose bytes are no longer in storage. Stated in the
   *  archive too, so a reader is told rather than left to infer. */
  missingBlobs: string[];
}> {
  const encoder = new TextEncoder();
  const manifest = await source.manifest();
  const entries: ZipEntry[] = [];
  let total = 0;
  let blobCount = 0;
  const seenBlobs = new Set<string>();

  const add = (name: string, bytes: Uint8Array): void => {
    // What the FILE will weigh, not just the payload: every entry costs a local
    // header, a central directory entry and the name twice. Counting only the
    // data let an archive of many small entries overshoot the announced ceiling
    // by megabytes — right where the browser allocation is most likely to fail.
    total += bytes.length + ZIP_ENTRY_OVERHEAD + 2 * name.length;
    if (total > MAX_ARCHIVE_BYTES) throw new ArchiveTooLarge(total);
    entries.push({ name, bytes });
  };

  const missingBlobs: string[] = [];

  for (const chatId of chatIds) {
    const chat = await source.chat(chatId);
    add(`${CHAT_PREFIX}${chatId}.json`, encoder.encode(JSON.stringify(chat)));

    for (const section of manifest.sections) {
      let cursor: string | null = null;
      let page = 0;
      do {
        const result: SectionPage = await source.section(
          chatId,
          section,
          cursor,
        );
        if (result.rows.length > 0) {
          add(
            `${SECTION_PREFIX}${chatId}/${section}/${page}.json`,
            encoder.encode(JSON.stringify(result.rows)),
          );
        }
        for (const blob of result.blobs) {
          if (blob.url === null) {
            // The bytes are gone from storage. The row still names them, so the
            // import would silently drop the attachment: an archive that looks
            // complete while it is not is the one failure worth reporting.
            missingBlobs.push(blob.key);
            continue;
          }
          // One blob may be referenced by several rows — a fork shares bytes —
          // so it is stored once.
          if (seenBlobs.has(blob.key)) continue;
          seenBlobs.add(blob.key);
          add(`${BLOB_PREFIX}${blob.key}`, await source.blob(blob.url));
          blobCount += 1;
        }
        cursor = result.cursor;
        page += 1;
      } while (cursor !== null && page < MAX_SECTION_PAGES);
      if (cursor !== null) {
        // A cursor that never ends means the page contract is not being kept.
        // Stopping quietly here would ship a truncated conversation.
        throw new Error(
          `export of ${section} did not finish within ${MAX_SECTION_PAGES} pages`,
        );
      }
    }
  }

  // LAST, so it can state what turned out to be missing. Order inside a zip is
  // not meaningful; being able to say what was lost is.
  entries.unshift({
    name: MANIFEST_ENTRY,
    bytes: encoder.encode(JSON.stringify({ ...manifest, missingBlobs })),
  });
  return { archive: writeZip(entries), manifest, blobCount, missingBlobs };
}

export interface ImportTarget {
  begin(
    manifest: { formatVersion: number; origin: string | null },
    targetProjectId: string | null,
  ): Promise<string>;
  batch(
    importId: string,
    section: string,
    rows: Record<string, unknown>[],
    blobs: { key: string; storageId: string }[],
  ): Promise<{ written: number; writtenIds: string[] }>;
  finish(importId: string): Promise<{ done: boolean }>;
  abandon(importId: string): Promise<{ done: boolean }>;
  /** Upload bytes and have them registered to the importing user. */
  upload(bytes: Uint8Array, name: string): Promise<string>;
  /** Tell the server these bytes belong to this import. Without it, discarding
   *  would have to accept any storage id the caller names — including an
   *  attachment of a conversation they still have. */
  registerBlob(importId: string, storageId: string): Promise<void>;
  /** Remove bytes this import uploaded. The server can only undo the ROWS it
   *  wrote, so blobs uploaded before a failure would stay behind for ever — a
   *  repeated bad import would then be a way to fill the storage. */
  discardUpload(importId: string, storageId: string): Promise<void>;
}

/**
 * Apply one archive.
 *
 * Sections are applied in the order the manifest lists them, after the chats,
 * because a row whose reference has not been imported yet is skipped rather than
 * written — order is what makes the references resolve.
 *
 * ANY failure abandons the import. A half-applied archive would leave a folder
 * of conversations nobody can name, and the server can undo precisely only while
 * the import is still identified.
 */
export async function applyArchive(
  target: ImportTarget,
  archive: Uint8Array,
  targetProjectId: string | null,
): Promise<{ importId: string; written: number; purged: boolean }> {
  const decoder = new TextDecoder();
  const entries = readZip(archive);
  const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]));

  const manifestBytes = byName.get(MANIFEST_ENTRY);
  if (manifestBytes === undefined) throw new Error("archive has no manifest");
  const manifest = JSON.parse(decoder.decode(manifestBytes)) as ExportManifest;

  const importId = await target.begin(
    { formatVersion: manifest.formatVersion, origin: manifest.origin ?? null },
    targetProjectId,
  );

  let written = 0;
  /** Whether the import's own bookkeeping was fully cleared. False is not a
   *  failure of the import — the history is there — but it must not be reported
   *  as a clean finish either. */
  let purged = false;
  /** Archive blob key -> the storage id this deployment minted for it. */
  const uploaded = new Map<string, string>();
  /** Keys some imported row actually named. An untrusted archive may carry blobs
   *  no row references, and a row may be skipped for want of a reference — so
   *  the rest are removed rather than left behind on a SUCCESSFUL import. */
  const usedBlobs = new Set<string>();
  try {
    // Bytes first: a row naming an attachment cannot be written before the
    // attachment exists here.
    for (const entry of entries) {
      if (!entry.name.startsWith(BLOB_PREFIX)) continue;
      const key = entry.name.slice(BLOB_PREFIX.length);
      if (uploaded.has(key)) {
        // ZIP allows two entries to share a name, and an archive is untrusted.
        // Overwriting would strand the first upload outside the cleanup map, so
        // an ambiguous archive is refused rather than half-applied.
        throw new Error(`archive names the same blob twice: ${key}`);
      }
      const storageId = await target.upload(entry.bytes, key);
      await target.registerBlob(importId, storageId);
      uploaded.set(key, storageId);
    }

    const chatEntries = entries.filter((entry) =>
      entry.name.startsWith(CHAT_PREFIX),
    );
    for (const entry of chatEntries) {
      const chat = JSON.parse(decoder.decode(entry.bytes)) as Record<
        string,
        unknown
      >;
      const result = await target.batch(
        importId,
        "chats",
        [chat],
        blobsForRows([chat], uploaded),
      );
      written += result.written;
      markUsed([chat], result.writtenIds, usedBlobs);
    }

    for (const section of manifest.sections) {
      const pages = entries
        .filter((entry) =>
          entry.name.startsWith(`${SECTION_PREFIX}`) &&
          entry.name.includes(`/${section}/`),
        )
        // Page order is the order they were exported in, and references inside a
        // section can point backwards — so the numbers, not the string sort.
        .sort((a, b) => pageNumber(a.name) - pageNumber(b.name));
      for (const page of pages) {
        const rows = JSON.parse(decoder.decode(page.bytes)) as Record<
          string,
          unknown
        >[];
        const result = await target.batch(
          importId,
          section,
          rows,
          blobsForRows(rows, uploaded),
        );
        written += result.written;
        // USED means WRITTEN. A row skipped for want of a reference names its
        // bytes just the same, and counting that as used left an orphan behind a
        // successful import.
        markUsed(rows, result.writtenIds, usedBlobs);
      }
    }

    for (const [key, storageId] of uploaded) {
      if (!usedBlobs.has(key)) await target.discardUpload(importId, storageId);
    }

    // The server purges a bounded page per call, so the number of calls follows
    // the number of rows written. A fixed ceiling that simply gave up would
    // report a clean finish over a mapping table still holding thousands of
    // rows — so the ceiling is derived, and falling short is REPORTED.
    const passes = Math.ceil(written / 100) + 100;
    for (let i = 0; i < passes && !purged; i += 1) {
      purged = (await target.finish(importId)).done;
    }
  } catch (error) {
    // Undone rather than left behind. Best effort: if the undo itself fails the
    // original failure is what the caller needs to see.
    try {
      let done = false;
      for (let i = 0; i < MAX_SECTION_PAGES && !done; i += 1) {
        done = (await target.abandon(importId)).done;
      }
      // The rows are the server's to undo; these are not — it never learned
      // about a blob whose batch never ran.
      for (const storageId of uploaded.values()) {
        await target.discardUpload(importId, storageId);
      }
    } catch {
      /* the original error is the one worth raising */
    }
    throw error;
  }

  return { importId, written, purged };
}

/**
 * The blob mappings a batch actually needs.
 *
 * Handing every batch the archive's whole list is what breaks on a large
 * archive: Convex bounds an argument array, and the request size well before
 * that — so an import of a few thousand attachments failed on its very first
 * batch, which carried only a conversation row.
 */
function blobsForRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  all: ReadonlyMap<string, string>,
): { key: string; storageId: string }[] {
  const needed = new Set<string>();
  for (const row of rows) {
    const single = row.archiveBlobKey;
    if (typeof single === "string") needed.add(single);
    const many = row.archiveBlobKeys;
    if (Array.isArray(many)) {
      for (const key of many) if (typeof key === "string") needed.add(key);
    }
  }
  const out: { key: string; storageId: string }[] = [];
  for (const key of needed) {
    const storageId = all.get(key);
    if (storageId !== undefined) out.push({ key, storageId });
  }
  return out;
}

/** Mark the blobs named by the rows the server actually WROTE. */
function markUsed(
  rows: ReadonlyArray<Record<string, unknown>>,
  writtenIds: ReadonlyArray<string>,
  used: Set<string>,
): void {
  const wrote = new Set(writtenIds);
  for (const row of rows) {
    if (typeof row._id !== "string" || !wrote.has(row._id)) continue;
    const single = row.archiveBlobKey;
    if (typeof single === "string") used.add(single);
    const many = row.archiveBlobKeys;
    if (Array.isArray(many)) {
      for (const key of many) if (typeof key === "string") used.add(key);
    }
  }
}

/** `sections/<chat>/<section>/<n>.json` -> n. */
function pageNumber(name: string): number {
  const match = /\/(\d+)\.json$/.exec(name);
  return match === null ? 0 : Number(match[1]);
}
