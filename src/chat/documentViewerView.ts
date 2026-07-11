// Pure view logic for the right-column Document Viewer (Release A): which
// in-app renderer a file gets, from its mimeType AND filename extension (agent
// deliveries sometimes arrive as application/octet-stream — the extension is
// then the only signal). Provider-agnostic by construction: it operates on the
// resolved Convex storage URL of a file part, whether the file was uploaded by
// the user or delivered by an OpenClaw or Hermes agent.
//
// Office formats (docx/pptx/xlsx…) deliberately map to "none" in Release A —
// Release B renders them through an instance-designated converter AGENT (the
// gateway's own skills produce a faithful PDF; Atrium never embeds conversion
// infra — community-software rule).

export type ViewerKind =
  | "pdf"
  | "image"
  | "markdown"
  | "csv"
  | "log"
  | "json"
  | "video"
  | "audio"
  | "text"
  | "none";

// Extensions rendered as plain text (source/code/config/data). Markdown is
// shown as raw text too in Release A — honest and predictable; a rendered
// preview can come later without changing the kind model.
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "log", "json", "yaml", "yml",
  "xml", "html", "css", "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs",
  "java", "c", "h", "cpp", "hpp", "sh", "bash", "sql", "toml", "ini", "env",
]);

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp",
]);

// Office formats the viewer can render THROUGH a PDF rendition (Release B): the
// instance converter agent turns them into a PDF the pdf.js path then shows.
// Client-side copy of the server authority (convex/fileRenditions) — used ONLY
// to decide whether to OFFER the render button; the server re-checks everything.
const CONVERTIBLE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/rtf",
]);
const CONVERTIBLE_EXTENSIONS = new Set([
  "pptx", "ppt", "docx", "doc", "xlsx", "xls", "odt", "odp", "ods", "rtf",
]);

/** Is this file a convertible Office document (offer the "render as PDF" path)? */
export function isConvertibleDocument(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  if (CONVERTIBLE_MIMES.has(mime)) return true;
  const ext = fileExtension(filename);
  return ext !== null && CONVERTIBLE_EXTENSIONS.has(ext);
}

/** Lower-cased extension of a filename, or null (no dot / trailing dot). */
export function fileExtension(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const idx = filename.lastIndexOf(".");
  if (idx <= 0 || idx === filename.length - 1) return null;
  return filename.slice(idx + 1).toLowerCase();
}

/** The in-app renderer for a file. Mime wins when it is SPECIFIC; the extension
 *  is the fallback for generic/absent mimes (application/octet-stream…). */
export function viewerKindFor(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): ViewerKind {
  // Strip mime parameters: "text/csv; charset=utf-8" must match text/csv.
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  const ext = fileExtension(filename);
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  // RICH text kinds render INTERPRETED by default (raw behind a toggle). A
  // SPECIFIC mime decides first; the extension only speaks for generic/absent
  // mimes (deliverers often guess text/plain or octet-stream) — it must not
  // override a contradicting specific type (data.csv served as JSON is JSON).
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/csv" || mime === "text/tab-separated-values") return "csv";
  // "+json" catches the structured-suffix family (problem+json, ld+json…).
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (mime === "text/x-log") return "log";
  const genericMime =
    mime === "" ||
    mime === "text/plain" ||
    mime === "application/octet-stream" ||
    mime === "binary/octet-stream";
  if (genericMime) {
    if (ext === "md" || ext === "markdown") return "markdown";
    if (ext === "csv" || ext === "tsv") return "csv";
    if (ext === "json") return "json";
    if (ext === "log") return "log";
  }
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/x-yaml"
  ) {
    return "text";
  }
  // Generic or missing mime → sniff the extension.
  if (ext === "pdf") return "pdf";
  if (ext !== null && IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext !== null && TEXT_EXTENSIONS.has(ext)) return "text";
  return "none";
}

/** Zoom steps offered by the PDF toolbar. "fit" scales to the panel width. */
export const PDF_ZOOM_STEPS = ["fit", 0.5, 0.75, 1, 1.5, 2] as const;
export type PdfZoom = (typeof PDF_ZOOM_STEPS)[number];

/** Clamp a 1-based page number into [1, pageCount] (0/negative counts → 1). */
export function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 1;
  const max = Math.max(1, Math.floor(pageCount));
  return Math.min(Math.max(1, Math.floor(page)), max);
}

/** Cap on text-preview bytes fetched into the panel: big logs/CSVs must not
 *  freeze the tab — beyond the cap the preview truncates with a notice. */
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

// ── Rich text-preview helpers (pure, unit-tested) ────────────────────────────

/** Bounds on the TABLE view of a CSV: rows and columns beyond them stay
 *  reachable through the raw mode. Rendering thousands of DOM rows — or a
 *  10k-column header times every row — would freeze the panel. */
export const CSV_PREVIEW_MAX_ROWS = 1000;
export const CSV_PREVIEW_MAX_COLS = 100;

/** Bound on COLORIZED log lines: a 512 KiB preview of short lines can hold
 *  hundreds of thousands of them, and one <span> each would freeze the panel
 *  the colorized mode is meant to make safe. The raw mode shows everything. */
export const LOG_PREVIEW_MAX_LINES = 5000;

/** JSON tree bounds: a node auto-opens only when it is small, and never mounts
 *  more than a hard cap of children (the rest collapses into a "+N more" line)
 *  — a flat 100k-entry root must not mount 100k components. */
export const JSON_TREE_OPEN_MAX_ENTRIES = 100;
export const JSON_TREE_MAX_CHILDREN = 500;

export interface CsvPreview {
  header: string[];
  rows: string[][];
  /** Total DATA rows parsed (before the row cap). */
  totalRows: number;
  truncatedRows: boolean;
  delimiter: string;
}

/** The delimiter the file's TYPE imposes, or undefined when it must be
 *  auto-detected: a valid .tsv whose header contains a comma would otherwise
 *  tie the column counts and let the comma win. */
export function forcedCsvDelimiter(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): string | undefined {
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "text/tab-separated-values" || fileExtension(filename) === "tsv") {
    return "\t";
  }
  return undefined;
}

/** Pick the delimiter that yields the most columns on the first line — French
 *  CSVs commonly use ';' and TSVs use tabs, and files rarely self-declare. */
export function detectCsvDelimiter(firstLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    const count = splitCsvLine(firstLine, d).length;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180-style parse of ONE record already known to be a full line set —
 *  internal to parseCsvPreview; exported only through it. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse a CSV/TSV text into a bounded table preview. RFC 4180 semantics:
 * quoted fields may contain the delimiter, doubled quotes and NEWLINES —
 * records are split with quote-awareness, not by a naive line split. The first
 * record is treated as the header (the common delivered-file shape).
 */
export function parseCsvPreview(
  text: string,
  maxRows: number = CSV_PREVIEW_MAX_ROWS,
  forcedDelimiter?: string,
): CsvPreview {
  // Quote-aware record split (a newline inside quotes is field content).
  const records: string[] = [];
  let cur = "";
  let quoted = false;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const ch of normalized) {
    if (ch === '"') quoted = !quoted;
    if (ch === "\n" && !quoted) {
      records.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur !== "") records.push(cur);
  // Leading blank lines are skipped when locating the HEADER, but blank lines
  // between data rows are KEPT: in a one-column CSV an empty (or whitespace)
  // line is a legitimate record, and dropping it would skew count and order.
  const headerIdx = records.findIndex((r) => r.trim() !== "");
  if (headerIdx === -1) {
    return { header: [], rows: [], totalRows: 0, truncatedRows: false, delimiter: "," };
  }
  const delimiter = forcedDelimiter ?? detectCsvDelimiter(records[headerIdx]!);
  const header = splitCsvLine(records[headerIdx]!, delimiter);
  const dataRecords = records.slice(headerIdx + 1);
  const rows = dataRecords
    .slice(0, maxRows)
    .map((r) => splitCsvLine(r, delimiter));
  return {
    header,
    rows,
    totalRows: dataRecords.length,
    truncatedRows: dataRecords.length > maxRows,
    delimiter,
  };
}

/** Compare two CSV cells for column sorting: numeric when BOTH parse as
 *  numbers (so "9" sorts before "10"), locale-aware text otherwise. Plain
 *  integers compare as BigInt — a float conversion would collapse distinct
 *  64-bit ids into equal values and leave the column misordered. */
export function compareCsvCells(a: string, b: string): number {
  const ta = a.trim();
  const tb = b.trim();
  if (/^-?\d+$/.test(ta) && /^-?\d+$/.test(tb)) {
    const ba = BigInt(ta);
    const bb = BigInt(tb);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  }
  const na = Number(a);
  const nb = Number(b);
  if (ta !== "" && tb !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return na - nb;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export type LogLevel = "error" | "warn" | "info" | "debug" | "plain";

/** Classify a log line by the usual level tokens (case-insensitive, bounded to
 *  word-ish positions so "errors_total" does not light up as an error). */
export function classifyLogLine(line: string): LogLevel {
  if (/\b(error|err|fatal|critical|panic)\b/i.test(line)) return "error";
  if (/\b(warn|warning)\b/i.test(line)) return "warn";
  if (/\b(info|notice)\b/i.test(line)) return "info";
  if (/\b(debug|trace|verbose)\b/i.test(line)) return "debug";
  return "plain";
}
