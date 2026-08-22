// Reading an archive back in.
//
// EVERYTHING HERE TREATS THE ARCHIVE AS UNTRUSTED. It is a file: it may have been
// edited, truncated, or written by hand. Nothing in it names a row in this
// deployment, nobody in it owns anything here, and no count in it may be believed.

import { ARCHIVE_FORMAT_VERSION } from "./exportArchive";

/** Archive shapes this version knows how to read. */
export const SUPPORTED_FORMAT_VERSIONS: ReadonlyArray<number> = [
  ARCHIVE_FORMAT_VERSION,
];

/** Rows applied per call. The batch is what keeps one transaction bounded. */
export const MAX_ROWS_PER_BATCH = 200;
/** Longest string any single field may carry. */
export const MAX_STRING_LENGTH = 200_000;
/** Fields one row may carry, at any depth. */
export const MAX_FIELDS_PER_ROW = 500;
/** How deep a row's own structure may nest. Bounded because the walk that checks
 *  it is recursive, and a hand-written archive can nest as deep as it likes. */
export const MAX_ROW_DEPTH = 12;
/** Longest identifier an archive may use to name its own rows. */
export const MAX_ARCHIVE_ID_LENGTH = 128;
/** Longest filename kept from an archive. */
export const MAX_FILENAME_LENGTH = 200;

export type ImportRejection =
  | "unsupported_format"
  | "malformed_manifest"
  | "batch_too_large"
  | "row_too_large"
  | "row_too_deep"
  | "string_too_long"
  | "bad_archive_id"
  | "storage_pointer_present";

export class ArchiveRejected extends Error {
  constructor(
    readonly reason: ImportRejection,
    detail?: string,
  ) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.name = "ArchiveRejected";
  }
}

/**
 * Whether a value can name a row inside the archive.
 *
 * OPAQUE by design: it is a key into this import's own mapping table and is never
 * handed to anything that resolves identifiers. Bounded because it is stored.
 */
export function isArchiveId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ARCHIVE_ID_LENGTH
  );
}

/** Characters no filename needs and a terminal misreads. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * A filename safe to store and to show.
 *
 * It reaches the interface and a download, so the separators go: a name like
 * `../../etc/passwd` is not a traversal in Convex storage, but it is one wherever
 * a reader saves the file, and it is a lie in any listing.
 */
export function sanitizeFilename(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  const flattened = value
    .replace(/[\\/]+/g, "_")
    .replace(CONTROL_CHARACTERS, "")
    .trim();
  const safe = flattened.length === 0 ? "sans-nom" : flattened;
  // BY CODE POINT. Slicing UTF-16 units can cut an emoji between its two
  // surrogates, and Convex refuses a string that is not valid Unicode — so a
  // name with one at the boundary would fail the whole batch.
  return Array.from(safe).slice(0, MAX_FILENAME_LENGTH).join("");
}

/** What the manifest must say before a single row is written. */
export function validateManifest(raw: unknown): {
  formatVersion: number;
  origin: string | null;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArchiveRejected("malformed_manifest", "not an object");
  }
  const manifest = raw as Record<string, unknown>;
  const formatVersion = manifest.formatVersion;
  if (typeof formatVersion !== "number") {
    throw new ArchiveRejected("malformed_manifest", "no format version");
  }
  if (!SUPPORTED_FORMAT_VERSIONS.includes(formatVersion)) {
    // REFUSED, not read as best it can be. A shape this version does not know is
    // one whose references it cannot be sure it is remapping correctly, and a
    // half-understood import is worse than none.
    throw new ArchiveRejected("unsupported_format", `version ${formatVersion}`);
  }
  const origin = manifest.origin;
  return {
    formatVersion,
    // An origin that is not a string is simply absent: the archive then counts as
    // foreign, which is the safe reading — foreign means readable, never
    // reattached.
    origin: typeof origin === "string" ? origin : null,
  };
}

/**
 * Check one row before it is written, and refuse rather than repair.
 *
 * The storage pointer is the one worth naming: a row that carries one is either
 * from a version that should not have written it, or hand-edited to make this
 * import read bytes it does not own. Either way the archive is not what it claims,
 * so the whole batch is refused rather than the field quietly dropped.
 */
export function assertRowAcceptable(
  row: unknown,
  storagePointerKeys: ReadonlyArray<string>,
  /**
   * Keys whose contents are the USER'S OWN data, checked for size but not for
   * structure. The export deliberately keeps a tool's `input`/`output` opaque —
   * including a business field that happens to be called `storageId` — so
   * rejecting them here would refuse an archive this very deployment produced.
   */
  opaqueKeys: ReadonlyArray<string> = [],
): void {
  let fields = 0;
  /** Bounds still apply to opaque content — only its SHAPE is none of our business. */
  const walkSizeOnly = (value: unknown, depth: number): void => {
    if (depth > MAX_ROW_DEPTH) throw new ArchiveRejected("row_too_deep");
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LENGTH) {
        throw new ArchiveRejected("string_too_long");
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walkSizeOnly(item, depth + 1);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const inner of Object.values(value as Record<string, unknown>)) {
      fields += 1;
      if (fields > MAX_FIELDS_PER_ROW) {
        throw new ArchiveRejected("row_too_large");
      }
      walkSizeOnly(inner, depth + 1);
    }
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_ROW_DEPTH) throw new ArchiveRejected("row_too_deep");
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LENGTH) {
        throw new ArchiveRejected("string_too_long");
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      fields += 1;
      if (fields > MAX_FIELDS_PER_ROW) {
        throw new ArchiveRejected("row_too_large");
      }
      if (opaqueKeys.includes(key)) {
        walkSizeOnly(inner, depth + 1);
        continue;
      }
      if (storagePointerKeys.includes(key)) {
        throw new ArchiveRejected("storage_pointer_present", key);
      }
      walk(inner, depth + 1);
    }
  };
  walk(row, 0);
}
