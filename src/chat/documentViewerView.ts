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
  const mime = (mimeType ?? "").toLowerCase();
  const ext = fileExtension(filename);
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  // Markdown renders INTERPRETED by default (raw behind a toggle). The .md
  // extension wins even over a generic text/plain mime — deliverers often
  // guess that mime for .md files, and the user expects the finished render.
  if (mime === "text/markdown" || ext === "md" || ext === "markdown") {
    return "markdown";
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
