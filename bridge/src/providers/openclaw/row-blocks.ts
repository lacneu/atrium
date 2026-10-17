// WHAT ONE TRANSCRIPT ROW SHOWS, AS ORDERED BLOCKS (transcript redesign, final design §3.4,
// step 1 — projection `on` only).
//
// The Control UI renders each projected `chat.history` / `session.message` row through
// `normalizeMessage` (ui/src/lib/chat/message-normalizer.ts:460 at v2026.9.33): text, the
// files the row carries (managed `image` / `attachment` / `audio` / `video` blocks, and
// `MEDIA:` lines split out of the text by `splitMediaFromOutput`), and the row's tool
// blocks — in content order. This module is that reading, reduced to what Atrium stores:
//   - `text`: a visible text segment (sanitized like the live stream's text);
//   - `file`: a file the row references — by `artifactId` (a gateway-managed copy) or by a
//     `mediaSource` the gateway's media route serves (a `MEDIA:` line, a structured
//     attachment url) — never by name, path or content as an identity;
//   - `tool`: a tool call / result the row carries, by `toolCallId`.
//
// Every rule is a port of the upstream function named beside it; what is NOT ported is
// said where it would apply. Nothing here decides placement, merges rows or reads a file.


import { redactPrivateToolArgs } from "../../core/private-tool-args.js";
import { findCodeRegions } from "./code-regions.js";
import { isToolCallItem, resolveToolCallId, resolveToolName, toolItemCallIds } from "./tool-call-id.js";
import {
  extractEmbeddedIpv4FromIpv6,
  isBlockedSpecialUseIpv4Address,
  isBlockedSpecialUseIpv6Address,
  isCanonicalDottedDecimalIPv4,
  isIpv4Address,
  isLegacyIpv4Literal,
  parseCanonicalIpAddress,
  parseLooseIpAddress,
} from "./net-policy-ip.js";
import { sanitizeDisplay } from "./normalizer.js";
import { stripInboundMetadata } from "./strip-inbound-meta.js";
import {
  extractCanvasShortcodes,
  isNestedShowWidgetCallId,
  MAX_WIDGET_PARTS_PER_TURN,
  previewFromChatPart,
  SHOW_WIDGET_TOOL,
  widgetFromPreview,
  widgetFromShowWidgetResult,
  type WidgetOrigin,
  type WidgetVerdict,
} from "./widgets.js";

const asRecord = (x: unknown): Record<string, unknown> | null =>
  typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

const readString = (r: Record<string, unknown> | null | undefined, key: string): string | undefined =>
  typeof r?.[key] === "string" ? (r[key] as string) : undefined;

const finiteNumber = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isFinite(x) ? x : undefined;

// ── Bounds (mirrored by convex/lib/transcriptProjection.ts `sanitizeRowBlocks`) ─────────

/** Most blocks one row keeps (a row past it keeps its first ones and says so). */
export const MAX_ROW_BLOCKS = 64;
/** `isValidMedia` refuses a candidate longer than this (src/media/parse-output.ts:192). */
export const MAX_MEDIA_SOURCE_CHARS = 4096;
/** A remote reference kept as is, bounded like a media source. */
export const MAX_REMOTE_URL_CHARS = 4096;
export const MAX_ARTIFACT_ID_CHARS = 256;
export const MAX_FILE_LABEL_CHARS = 512;
export const MAX_MIME_CHARS = 128;
export const MAX_TOOL_ID_CHARS = 256;
export const MAX_TOOL_NAME_CHARS = 128;

export type FileKind = "image" | "audio" | "video" | "document";

export type RowTextBlock = {
  type: "text";
  /** Absent with `omitted` when the row's content was over its byte budget. */
  text?: string;
  omitted?: true;
};

export type RowFileBlock = {
  type: "file";
  kind: FileKind;
  /** A gateway-managed copy (`artifact_managed_*`): fetched by `artifacts.download`. */
  artifactId?: string;
  /** A reference the gateway's media route serves (`/__openclaw__/assistant-media`). */
  mediaSource?: string;
  /** An `https:` reference the Control UI's BROWSER loads itself: Atrium never fetches it,
   *  never copies it — it shows it as is (`url`), as the Control UI does for a source that is
   *  not local (chat-message-attachments.ts:127-134, `{status:"available", url}`). */
  remote?: true;
  url?: string;
  /** A block the Control UI renders as an error (`attachment_error`, its `code`). */
  errorCode?: "file-not-found" | "unsupported-format" | "delivery-failed";
  /** An image the history omitted (`omitted:true`, no artifactId nor url). */
  omitted?: true;
  mimeType?: string;
  sizeBytes?: number;
  label?: string;
};

export type RowToolBlock = {
  type: "tool";
  toolCallId: string;
  name?: string;
  status: "call" | "result" | "error";
  /** The call's ARGUMENTS (a call block) and the RESULT (a result block), as the live tool
   *  part carries them (codex review 11): `input` = the call's `arguments`/`args`/`input`
   *  (upstream tool-cards.ts:375 `coerceArgs(item.arguments ?? item.args ?? item.input)`),
   *  `output` = the result's `{content, details}` — the shape of the live `data.result`
   *  (normalizer.ts tool `result` frame). As `chat.history` serves them — already masked by
   *  the gateway's storage (src/agents/transcript-redact.ts:721) — with the private arguments
   *  removed as the live writer removes them (core/private-tool-args.ts, turn-sink.ts tool
   *  part). The card masks the input again at display, as the Control UI does (review 15). */
  input?: unknown;
  output?: unknown;
  /** Left out for the row's content budget (`boundRowContent`): the card stays, marked cut,
   *  with the size it had — as a live part over PART_FIELD_CAP is shown (convex/messages.ts
   *  `inputOmitted`/`outputOmitted`). */
  inputOmitted?: true;
  inputBytes?: number;
  outputOmitted?: true;
  outputBytes?: number;
};

/** An inline widget the row names (a managed canvas document, `cv_*`), as the Control UI
 *  reads it: a `{type:"canvas"}` item the gateway appends to a history row
 *  (chat-display-projection.canvas.ts `augmentChatHistoryWithCanvasBlocks`), an `[embed]`
 *  shortcode of the text (message-normalizer.ts:398 `extractCanvasShortcodes`), or the
 *  `show_widget` RESULT that minted the document. `origin` says which: only `tool` proves
 *  the document belongs to the session that wrote the row (widgets.ts `WidgetOrigin`);
 *  Convex registers a view from it alone and shows the other two only for a view
 *  registered to the conversation (convex/lib/rowParts.ts). Always the row's LAST blocks:
 *  a file block keeps its index whatever widgets the row names. */
export type RowWidgetBlock = {
  type: "widget";
  viewId: string;
  title?: string;
  preferredHeight?: number;
  origin: WidgetOrigin;
};

export type RowBlock = RowTextBlock | RowFileBlock | RowToolBlock | RowWidgetBlock;

// ── `splitMediaFromOutput` (src/media/parse.ts:16 → src/media/parse-output.ts:410) ─────
// Called by the Control UI as `splitMediaFromOutput(text, {extractAudioDirectives:false})`
// (message-normalizer.ts:399): markdown images are NOT extracted and audio tags are not
// parsed, so only the `MEDIA:` directive branch matters. Ported verbatim, with the code
// regions (code-regions.ts) and the IP policy (net-policy-ip.ts) on the upstream parser and
// library.

/** parse-output.ts:20. */
const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;
/** parse-output.ts:52. */
const FILE_URL_PREFIX_RE = /^file:(?:\/\/)?/i;
/** parse-output.ts:60. */
const TRAILING_SERIALIZED_JSON_AFTER_EXT_RE = /^(.*\.\w{1,10})\\?"(?=[\]},:]|$).*/s;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const MEDIA_SOURCE_ROOT_RE = /^(?:[a-z]:[\\/]|[/~]|\.{1,2}[\\/]|\\\\)/i;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT = /\.\w{1,10}$/;
const TRAVERSAL_SEGMENT_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)/;
/** packages/net-policy/src/url-protocol.ts:1. */
const HTTP_URL_PREFIX_RE = /^https?:\/\//i;

function normalizeMediaSource(src: string): string {
  return src.replace(FILE_URL_PREFIX_RE, "");
}

/** parse-output.ts:62. */
function cleanCandidate(raw: string): string {
  const stripped = raw.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
  const jsonSuffixMatch = TRAILING_SERIALIZED_JSON_AFTER_EXT_RE.exec(stripped);
  return jsonSuffixMatch?.[1] ?? stripped;
}

function isSupportedHomeRelativePath(candidate: string): boolean {
  return candidate.startsWith("~/") || candidate.startsWith("~\\");
}

/** parse-output.ts:80. */
function hasTraversalOrUnsupportedHomeDirPrefix(candidate: string): boolean {
  return (
    candidate.startsWith("../") ||
    candidate === ".." ||
    (candidate.startsWith("~") && !isSupportedHomeRelativePath(candidate)) ||
    TRAVERSAL_SEGMENT_RE.test(candidate)
  );
}

/** parse-output.ts:91. */
function looksLikeLocalFilePath(candidate: string): boolean {
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(candidate) ||
    candidate.startsWith("\\\\") ||
    (!SCHEME_RE.test(candidate) && (candidate.includes("/") || candidate.includes("\\")))
  );
}

/** parse-output.ts:104. */
function isLikelyLocalPath(candidate: string): boolean {
  if (hasTraversalOrUnsupportedHomeDirPrefix(candidate)) return false;
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    isSupportedHomeRelativePath(candidate) ||
    WINDOWS_DRIVE_RE.test(candidate) ||
    candidate.startsWith("\\\\") ||
    (!SCHEME_RE.test(candidate) && (candidate.includes("/") || candidate.includes("\\")))
  );
}

/** parse-output.ts:119. */
function normalizeRemoteMediaHostname(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (normalized.split(".").some((label) => label.length === 0)) return "";
  return normalized;
}

/** parse-output.ts:131, with the IP policy of packages/net-policy/src/ip.ts ported as is
 *  (net-policy-ip.ts). */
function isBlockedRemoteMediaHostname(hostname: string): boolean {
  const normalized = normalizeRemoteMediaHostname(hostname);
  if (!normalized) return true;
  if (!normalized.includes(".")) return true;
  if (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }
  const strictIp = parseCanonicalIpAddress(normalized);
  if (strictIp) {
    if (isIpv4Address(strictIp)) return isBlockedSpecialUseIpv4Address(strictIp);
    if (isBlockedSpecialUseIpv6Address(strictIp)) return true;
    const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(strictIp);
    return embeddedIpv4 ? isBlockedSpecialUseIpv4Address(embeddedIpv4) : false;
  }
  if (normalized.includes(":") && !parseLooseIpAddress(normalized)) return true;
  return !isCanonicalDottedDecimalIPv4(normalized) && isLegacyIpv4Literal(normalized);
}

/** parse-output.ts:168. */
function isAllowedRemoteMediaUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !isBlockedRemoteMediaHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** `parseInboundMediaUri` (src/media/inbound-media-uri.ts:33), as a validity test. */
function isInboundMediaUri(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    if (parsed.hostname !== "inbound") return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    const id = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    return !(!id || id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0"));
  } catch {
    return false;
  }
}

/** parse-output.ts:182. */
function isValidMedia(source: string, opts?: { allowSpaces?: boolean; allowBareFilename?: boolean }): boolean {
  const candidate = normalizeMediaSource(source);
  if (!candidate) return false;
  if (candidate.length > MAX_MEDIA_SOURCE_CHARS) return false;
  if (!opts?.allowSpaces && /\s/.test(candidate)) return false;
  if (HTTP_URL_PREFIX_RE.test(candidate)) return isAllowedRemoteMediaUrl(candidate);
  if (/^media:\/\//i.test(candidate)) return isInboundMediaUri(candidate);
  if (isLikelyLocalPath(candidate)) return true;
  if (hasTraversalOrUnsupportedHomeDirPrefix(candidate)) return false;
  if (opts?.allowBareFilename && !SCHEME_RE.test(candidate) && HAS_FILE_EXT.test(candidate)) return true;
  return false;
}

function beginsIndependentMediaSource(raw: string): boolean {
  const candidate = normalizeMediaSource(cleanCandidate(raw));
  return MEDIA_SOURCE_ROOT_RE.test(candidate) || SCHEME_RE.test(candidate);
}

/** parse-output.ts:228. */
function splitUnquotedMediaDirectiveParts(payload: string): string[] {
  const parts: string[] = [];
  let previousEnd = 0;
  for (const match of payload.matchAll(/\S+/g)) {
    const candidate = normalizeMediaSource(cleanCandidate(match[0]));
    const previous = parts.at(-1);
    const previousCandidate = previous ? normalizeMediaSource(cleanCandidate(previous)) : "";
    if (
      MEDIA_SOURCE_ROOT_RE.test(previousCandidate) &&
      !beginsIndependentMediaSource(candidate) &&
      (!HAS_FILE_EXT.test(previousCandidate) || !isValidMedia(candidate))
    ) {
      parts[parts.length - 1] = `${previous}${payload.slice(previousEnd, match.index)}${match[0]}`;
    } else {
      parts.push(match[0]);
    }
    previousEnd = (match.index ?? 0) + match[0].length;
  }
  return parts;
}

/** parse-output.ts:250. */
function unwrapQuoted(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) return undefined;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first !== last) return undefined;
  if (first !== `"` && first !== "'" && first !== "`") return undefined;
  return trimmed.slice(1, -1).trim();
}

function cleanLineText(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

export type MediaSegment = { type: "text"; text: string } | { type: "media"; url: string };

/** `splitMediaOutput` (parse-output.ts:410-687) with `extractAudioDirectives:false` and no
 *  markdown-image extraction: the visible text and the ordered segments. */
export function splitMediaFromOutput(raw: string): { text: string; segments?: MediaSegment[] } {
  const trimmedRaw = raw.trimEnd();
  if (!trimmedRaw.trim()) return { text: "" };
  if (!/media:/i.test(trimmedRaw) && !trimmedRaw.includes("[[")) return { text: trimmedRaw };

  const media: string[] = [];
  let foundMediaToken = false;
  const segments: MediaSegment[] = [];
  let lastTextSegment: { type: "text"; text: string } | undefined;
  const pushTextSegment = (text: string): void => {
    const last = segments[segments.length - 1];
    if (last?.type === "text") {
      last.text = `${last.text}\n${text.trim() ? text : ""}`;
    } else if (!text.trim()) {
      if (last?.type === "media" && lastTextSegment && !lastTextSegment.text.endsWith("\n")) {
        lastTextSegment.text += "\n";
      }
    } else {
      lastTextSegment = { type: "text", text };
      segments.push(lastTextSegment);
    }
  };

  // parse-output.ts:463: the BLOCK code regions (fenced and indented), by the upstream parser.
  const codeBlocks = findCodeRegions(trimmedRaw).filter((region) => region.block);
  const lines = trimmedRaw.split("\n");
  const keptLines: string[] = [];
  let lineOffset = 0;
  let codeBlockIndex = 0;
  for (const line of lines) {
    const lineEnd = lineOffset + line.length;
    let codeBlock = codeBlocks[codeBlockIndex];
    while (codeBlock && lineOffset >= codeBlock.end) {
      codeBlockIndex += 1;
      codeBlock = codeBlocks[codeBlockIndex];
    }
    if (codeBlock && lineEnd > codeBlock.start) {
      keptLines.push(line);
      pushTextSegment(line);
      lineOffset += line.length + 1;
      continue;
    }
    const linePrefix = line.trimStart().slice(0, "MEDIA:".length);
    if (!linePrefix.toUpperCase().startsWith("MEDIA:")) {
      keptLines.push(line);
      pushTextSegment(line);
      lineOffset += line.length + 1;
      continue;
    }
    const matches = Array.from(line.matchAll(MEDIA_TOKEN_RE));
    if (matches.length === 0) {
      keptLines.push(line);
      pushTextSegment(line);
      lineOffset += line.length + 1;
      continue;
    }
    const pieces: string[] = [];
    const lineSegments: MediaSegment[] = [];
    let cursor = 0;
    for (const match of matches) {
      const start = match.index ?? 0;
      pieces.push(line.slice(cursor, start));
      const payload = match[1] ?? "";
      const unwrapped = unwrapQuoted(payload);
      const payloadValue = unwrapped ?? payload;
      const parts = unwrapped ? [unwrapped] : splitUnquotedMediaDirectiveParts(payload);
      const mediaStartIndex = media.length;
      let validCount = 0;
      const invalidParts: string[] = [];
      let hasValidMedia = false;
      for (const part of parts) {
        const candidate = unwrapped === undefined ? cleanCandidate(part) : part;
        const allowSpaces = Boolean(unwrapped) || /\s/.test(candidate);
        if (isValidMedia(candidate, { allowSpaces })) {
          media.push(candidate);
          hasValidMedia = true;
          foundMediaToken = true;
          validCount += 1;
        } else if (!/\s/.test(part) || !hasTraversalOrUnsupportedHomeDirPrefix(candidate)) {
          invalidParts.push(part);
        }
      }
      const trimmedPayload = payloadValue.trim();
      const looksLikeLocalPath = looksLikeLocalFilePath(trimmedPayload) || FILE_URL_PREFIX_RE.test(trimmedPayload);
      if (
        !unwrapped &&
        validCount === 1 &&
        invalidParts.length > 0 &&
        !parts.slice(1).some(beginsIndependentMediaSource) &&
        /\s/.test(payloadValue) &&
        looksLikeLocalPath
      ) {
        const fallback = cleanCandidate(payloadValue);
        if (isValidMedia(fallback, { allowSpaces: true })) {
          media.splice(mediaStartIndex, media.length - mediaStartIndex, fallback);
          hasValidMedia = true;
          foundMediaToken = true;
          invalidParts.length = 0;
        }
      }
      if (!hasValidMedia) {
        const fallback = unwrapped ?? cleanCandidate(payloadValue);
        if (isValidMedia(fallback, { allowSpaces: true, allowBareFilename: true })) {
          media.push(fallback);
          hasValidMedia = true;
          foundMediaToken = true;
          invalidParts.length = 0;
        }
      }
      if (hasValidMedia) {
        const beforeText = cleanLineText(pieces.join(""));
        if (beforeText) lineSegments.push({ type: "text", text: beforeText });
        pieces.length = 0;
        for (const url of media.slice(mediaStartIndex)) lineSegments.push({ type: "media", url });
        if (invalidParts.length > 0) pieces.push(invalidParts.join(" "));
      } else if (looksLikeLocalPath) {
        foundMediaToken = true;
      } else {
        pieces.push(match[0]);
      }
      cursor = start + match[0].length;
    }
    pieces.push(line.slice(cursor));
    const cleanedLine = cleanLineText(pieces.join(""));
    if (cleanedLine) {
      keptLines.push(cleanedLine);
      lineSegments.push({ type: "text", text: cleanedLine });
    }
    for (const segment of lineSegments) {
      if (segment.type === "text") {
        pushTextSegment(segment.text);
        continue;
      }
      segments.push(segment);
    }
    lineOffset += line.length + 1;
  }
  const visibleText = keptLines.join("\n").replace(/^(?:[ \t]*\n)+/, "");
  const cleanedText = visibleText.trimEnd();
  if (media.length === 0) {
    const parsedText = foundMediaToken ? cleanedText : trimmedRaw;
    return { text: parsedText, segments: parsedText ? [{ type: "text", text: parsedText }] : [] };
  }
  return {
    text: cleanedText,
    segments: segments.length > 0 ? segments : [{ type: "text", text: cleanedText }],
  };
}

// ── File facts (ui/src/lib/chat/message-normalizer.ts) ──────────────────────────────────

/** message-normalizer.ts:227. */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/opus",
  m4a: "audio/mp4",
  m2a: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

const SAME_ORIGIN_MEDIA_ROUTE_MARKERS = [
  "/__openclaw__/assistant-media",
  "/__openclaw__/media/",
  "/api/chat/media/outgoing/",
  "/media/inbound/",
];

/** `getMediaFileName` (ui/src/lib/media-file-extension.ts:17). */
function mediaFileName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let filename: string;
  try {
    const sameOrigin = trimmed.startsWith("/") && SAME_ORIGIN_MEDIA_ROUTE_MARKERS.some((m) => trimmed.includes(m));
    if (/^https?:\/\//i.test(trimmed) || sameOrigin) {
      const pathname = new URL(trimmed, "https://openclaw.invalid").pathname;
      filename = pathname.slice(pathname.lastIndexOf("/") + 1);
      try {
        filename = decodeURIComponent(filename.replace(/%2f/gi, "%252F").replace(/%5c/gi, "%255C"));
      } catch {
        /* keep the raw filename when its own encoding is malformed */
      }
    } else {
      filename = trimmed.split(/[\\/]/).pop() ?? trimmed;
    }
  } catch {
    filename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  }
  return filename || undefined;
}

/** `getMediaFileExtension` (media-file-extension.ts:47). */
function mediaFileExtension(value: string): string | undefined {
  const filename = mediaFileName(value);
  return filename ? /\.([a-zA-Z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() : undefined;
}

/** `mediaKindFromMime` (packages/media-core/src/constants.ts:14). */
function mediaKindFromMime(mime: string | undefined): FileKind | undefined {
  if (!mime) return undefined;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || mime.startsWith("application/")) return "document";
  return undefined;
}

/** `inferAttachmentKind` (message-normalizer.ts:260). */
export function inferAttachmentKind(url: string): { kind: FileKind; mimeType?: string; label: string } {
  const ext = mediaFileExtension(url);
  const mimeType = ext ? MIME_BY_EXT[ext] : undefined;
  const kind = mediaKindFromMime(mimeType) ?? "document";
  let label: string;
  try {
    if (/^https?:\/\//i.test(url)) {
      const parsed = new URL(url);
      label = parsed.pathname.split("/").pop()?.trim() || parsed.hostname || url;
    } else {
      label = url.split(/[\\/]/).pop()?.trim() || url;
    }
  } catch {
    label = url.split(/[\\/]/).pop()?.trim() || url;
  }
  return { kind, ...(mimeType !== undefined ? { mimeType } : {}), label };
}

/** `isLocalAssistantAttachmentSource` (ui/src/pages/chat/components/chat-message-local-media.ts:7):
 *  the references the gateway's media route serves (the Control UI's `buildAssistantMediaUrl`).
 *  A route URL of the gateway itself (`/api/chat/media/outgoing/…`, `/__openclaw__/…`,
 *  `/media/…`) and a remote URL are NOT local sources. */
function isLocalAttachmentSource(source: string): boolean {
  const trimmed = source.trim();
  if (/^\/(?:__openclaw__|media|api\/chat\/media\/outgoing)\//.test(trimmed)) return false;
  if (/^media:\/\/inbound\/([^/?#]+)$/i.test(trimmed)) return true;
  return (
    /^file:/iu.test(trimmed) ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    (Boolean(trimmed) && !/^[a-z][a-z0-9+.-]*:/iu.test(trimmed))
  );
}

const bounded = (value: string | undefined, max: number): string | undefined =>
  value !== undefined && value.length > 0 && value.length <= max ? value : undefined;

/** How a file is reached, from the url and artifact id the Control UI would read. */
function fileSource(url: string | undefined, artifactId: string | undefined): Partial<RowFileBlock> {
  const managed = bounded(artifactId?.trim(), MAX_ARTIFACT_ID_CHARS);
  if (managed !== undefined) return { artifactId: managed };
  const u = url?.trim();
  if (!u) return {};
  if (/^https:\/\//i.test(u)) {
    const remoteUrl = bounded(u, MAX_REMOTE_URL_CHARS);
    return remoteUrl === undefined ? {} : { remote: true, url: remoteUrl };
  }
  if (isLocalAttachmentSource(u)) {
    const source = bounded(u, MAX_MEDIA_SOURCE_CHARS);
    return source === undefined ? {} : { mediaSource: source };
  }
  // A data: URL, an http: URL, or a gateway route url with no artifact id: nothing Atrium
  // can fetch by identity.
  return {};
}

function fileBlock(
  kind: FileKind,
  source: Partial<RowFileBlock>,
  facts: { mimeType?: string; sizeBytes?: number; label?: string },
): RowFileBlock {
  const mimeType = bounded(facts.mimeType, MAX_MIME_CHARS);
  const label = bounded(facts.label?.trim(), MAX_FILE_LABEL_CHARS);
  const size = facts.sizeBytes;
  return {
    type: "file",
    kind,
    ...source,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(size !== undefined && size >= 0 ? { sizeBytes: size } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

const ATTACHMENT_KINDS: ReadonlySet<string> = new Set(["image", "audio", "video", "document"]);
const ATTACHMENT_ERROR_CODES: ReadonlySet<string> = new Set(["file-not-found", "unsupported-format", "delivery-failed"]);

/** One structured content item as the Control UI's file items (null: not a file). Ports:
 *  `normalizeOmittedMediaContentBlock` (:79), `normalizeImageContentBlock`
 *  (message-normalizer-images.ts:14, `image` only — `image_url`/`input_image` are user
 *  inputs), `coerceManagedMediaContentBlock` (:316) and `coerceAudioContentBlock` (:285)
 *  for an assistant row, `normalizeAttachmentContentBlock` (message-normalizer-attachments.ts:9). */
function structuredFile(item: Record<string, unknown>, assistant: boolean): RowFileBlock | "dropped" | null {
  const type = item.type;
  if (type === "image") {
    const source = asRecord(item.source);
    const artifactId = readString(item, "artifactId");
    const url = readString(item, "url")?.trim() || readString(source, "url")?.trim();
    if (item.omitted === true && !artifactId?.trim() && !url) {
      return { type: "file", kind: "image", omitted: true, ...(finiteNumber(item.bytes) !== undefined && finiteNumber(item.bytes)! >= 0 ? { sizeBytes: finiteNumber(item.bytes)! } : {}) };
    }
    return fileBlock("image", fileSource(url, artifactId), {
      mimeType: readString(item, "mimeType") ?? readString(source, "media_type"),
      sizeBytes: finiteNumber(item.sizeBytes),
      label: readString(item, "fileName") ?? readString(item, "alt") ?? (url ? inferAttachmentKind(url).label : undefined),
    });
  }
  if (assistant && (type === "audio" || type === "video")) {
    const url = readString(item, "url")?.trim();
    if (url) {
      return fileBlock(type, fileSource(url, readString(item, "artifactId")), {
        mimeType: readString(item, "mimeType"),
        sizeBytes: finiteNumber(item.sizeBytes),
        label: readString(item, "fileName")?.trim() || readString(item, "label")?.trim() || (type === "audio" ? "Audio" : "Video"),
      });
    }
    if (type === "audio") {
      const source = asRecord(item.source);
      const sourceType = source?.type;
      const data = readString(source, sourceType === "base64" ? "data" : "url")?.trim();
      if (!source || !data || (sourceType !== "base64" && sourceType !== "url")) return "dropped";
      const rawMediaType = readString(source, "media_type")?.trim();
      const mediaType = rawMediaType?.toLowerCase().startsWith("audio/") ? rawMediaType : "audio/mpeg";
      // Inline base64 audio has no source to fetch by identity.
      return fileBlock("audio", sourceType === "base64" ? {} : fileSource(data, undefined), {
        mimeType: mediaType,
        label: readString(item, "label")?.trim() || "Audio",
      });
    }
    return "dropped";
  }
  if (!assistant && type === "audio") return "dropped";
  if (type === "attachment" || type === "attachment_error") {
    const attachment = asRecord(item.attachment);
    const kind = attachment?.kind;
    if (!attachment || typeof kind !== "string" || !ATTACHMENT_KINDS.has(kind) || typeof attachment.label !== "string") {
      return "dropped";
    }
    const mimeType = readString(attachment, "mimeType");
    if (type === "attachment_error") {
      const code = attachment.code;
      if (typeof code !== "string" || !ATTACHMENT_ERROR_CODES.has(code)) return "dropped";
      return {
        ...fileBlock(kind as FileKind, {}, { mimeType, label: attachment.label }),
        errorCode: code as RowFileBlock["errorCode"],
      };
    }
    if (typeof attachment.url !== "string") return "dropped";
    return fileBlock(kind as FileKind, fileSource(attachment.url, readString(attachment, "artifactId")), {
      mimeType,
      sizeBytes: finiteNumber(attachment.sizeBytes),
      label: attachment.label,
    });
  }
  return null;
}

// ── Tool blocks (src/chat/tool-content.ts:22-31 spellings) ─────────────────────────────

/** The transcript id a message carries (`__openclaw.id`), else a constant: the scope of an
 *  id-less call's card id when the caller did not name the row. */
function rowKeyOf(record: Record<string, unknown>): string {
  const meta = asRecord(record.__openclaw);
  return typeof meta?.id === "string" && meta.id.trim() !== "" ? meta.id.trim() : "row";
}

function toolType(value: unknown): "call" | "result" | null {
  const t = typeof value === "string" ? value.toLowerCase() : "";
  if (t === "toolcall" || t === "tool_call" || t === "tooluse" || t === "tool_use") return "call";
  if (t === "toolresult" || t === "tool_result") return "result";
  return null;
}

function toolBlock(
  id: unknown,
  name: unknown,
  status: RowToolBlock["status"],
  payload: { input?: unknown; output?: unknown } = {},
): RowToolBlock | null {
  const toolCallId = typeof id === "string" ? bounded(id.trim(), MAX_TOOL_ID_CHARS) : undefined;
  if (toolCallId === undefined) return null;
  const n = typeof name === "string" ? bounded(name.trim(), MAX_TOOL_NAME_CHARS) : undefined;
  const input = payload.input === undefined ? undefined : redactPrivateToolArgs(n ?? "", payload.input, "input");
  const output = payload.output === undefined ? undefined : redactPrivateToolArgs(n ?? "", payload.output, "output");
  return {
    type: "tool",
    toolCallId,
    ...(n !== undefined ? { name: n } : {}),
    status,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

/** tool-cards.ts:65 `coerceArgs`: a JSON-looking string argument is parsed. */
function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** A call block's arguments (tool-cards.ts:375). */
const callArgs = (item: Record<string, unknown>): unknown => {
  const raw = item.arguments ?? item.args ?? item.input;
  return raw === undefined ? undefined : coerceArgs(raw);
};

/** A result's payload, in the live `data.result` shape: its content (a bare `text` is its
 *  one text block — tool-cards.ts:87 `extractToolText` reads `text` first) and details. */
const resultOutput = (record: Record<string, unknown>): unknown => {
  const content = record.content !== undefined ? record.content : typeof record.text === "string" ? [{ type: "text", text: record.text }] : undefined;
  return content === undefined && record.details === undefined
    ? undefined
    : { ...(content !== undefined ? { content } : {}), ...(record.details !== undefined ? { details: record.details } : {}) };
};

// ── The row ──────────────────────────────────────────────────────────────────────────

/** `resolveMessageRole` (message-normalizer.ts:117): a row carrying tool content or a tool
 *  envelope is a tool message for the Control UI — its text is not expanded for `MEDIA:`. */
function readsAsAssistant(record: Record<string, unknown>): boolean {
  if (typeof record.role !== "string" || record.role.toLowerCase() !== "assistant") return false;
  for (const key of ["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "toolName", "tool_name"]) {
    if (typeof record[key] === "string") return false;
  }
  return !(Array.isArray(record.content) && record.content.some((b) => toolType(asRecord(b)?.type) !== null));
}

/** `readMessageDelivery` + `resolveDeliveryReplyTarget` (message-normalizer.ts:46, :379):
 *  what decides whether a text that split into nothing still shows its raw text. */
function deliveryFacts(record: Record<string, unknown>): { audioAsVoice: boolean; replyTarget: boolean } {
  const d = asRecord(record.openclawDelivery);
  if (!d || (d.audioAsVoice !== undefined && d.audioAsVoice !== true) || (d.replyToCurrent !== undefined && d.replyToCurrent !== true)) {
    return { audioAsVoice: false, replyTarget: false };
  }
  const replyToId = typeof d.replyToId === "string" ? d.replyToId.trim() : "";
  return { audioAsVoice: d.audioAsVoice === true, replyTarget: replyToId !== "" || d.replyToCurrent === true };
}

/** `expandTextContent` (message-normalizer.ts:390), then `mergeAdjacentTextItems` (:355).
 *  Its canvas previews (`extractCanvasShortcodes`, :398, :423-435) are the row's widget
 *  blocks (`rowBlocks`); the text keeps its `[embed]` shortcode as sent and the SPA hides
 *  it beside the widget part it names (src/chat/widgets/shortcodes.ts). */
function expandText(
  text: string,
  delivery: { audioAsVoice: boolean; replyTarget: boolean },
): Array<{ type: "text"; text: string } | { type: "media"; url: string }> {
  const parsed = splitMediaFromOutput(text);
  const segments = parsed.segments ?? [{ type: "text" as const, text: parsed.text }];
  const parts: Array<{ type: "text"; text: string } | { type: "media"; url: string }> = [];
  for (const segment of segments) {
    if (segment.type === "media") parts.push({ type: "media", url: segment.url });
    else if (segment.text) parts.push({ type: "text", text: segment.text });
  }
  const merged: typeof parts = [];
  for (const item of parts) {
    const previous = merged[merged.length - 1];
    if (item.type === "text" && previous?.type === "text") {
      previous.text = [previous.text, item.text].join("\n");
      continue;
    }
    merged.push({ ...item });
  }
  const content = merged.filter((item) => item.type !== "text" || Boolean(item.text.trim()));
  if (content.length > 0) return content;
  return !delivery.replyTarget && !delivery.audioAsVoice && parsed.text.trim().length > 0
    ? [{ type: "text", text: parsed.text }]
    : [];
}

/**
 * The ordered blocks one row shows (projection `on`). Assistant rows: text (split for
 * `MEDIA:` when the row reads as an assistant message), files and tool blocks in content
 * order. Tool-result rows: their tool block, then the files their content carries. A
 * nested-tool row (`openclaw.nested-tool.v1`): its tool blocks. Other rows: none.
 * Text segments are sanitized like the live stream's text (`sanitizeDisplay`); a text that
 * sanitizes to nothing is not a block (`stripMessageDisplayMetadata`, message-normalizer.ts:368:
 * each text item loses its inbound metadata — strip-inbound-meta.ts — and an item left empty
 * is dropped).
 */
export function rowBlocks(
  message: unknown,
  sessionKey: string,
  /** The row's transcript id: it scopes the card id of a call that names none
   *  (tool-call-id.ts `toolItemCallIds`). Defaults to the message's own `__openclaw.id`. */
  rowKey?: string,
): { blocks: RowBlock[]; truncated: boolean } {
  const record = asRecord(message);
  if (record === null) return { blocks: [], truncated: false };
  const key = rowKey ?? rowKeyOf(record);
  const role = typeof record.role === "string" ? record.role.toLowerCase() : "";
  const out: RowBlock[] = [];
  const pushText = (raw: string): void => {
    const text = sanitizeDisplay(stripInboundMetadata(raw), sessionKey);
    if (text.trim()) out.push({ type: "text", text });
  };
  const widgets: RowWidgetBlock[] = [];
  const pushWidget = (verdict: WidgetVerdict | null, origin: WidgetOrigin): void => {
    if (verdict === null || !verdict.ok) return;
    const w = verdict.widget;
    const block: RowWidgetBlock = {
      type: "widget",
      viewId: w.viewId,
      ...(w.title !== undefined ? { title: w.title } : {}),
      ...(w.preferredHeight !== undefined ? { preferredHeight: w.preferredHeight } : {}),
      origin,
    };
    const at = widgets.findIndex((x) => x.viewId === w.viewId);
    // One widget per view; the canonical canvas block wins over its shortcode copy
    // (message-normalizer.test.ts "keeps the canonical Canvas block instead of its
    // shortcode copy").
    if (at < 0) widgets.push(block);
    else if (widgets[at]!.origin === "shortcode" && origin !== "shortcode") widgets[at] = block;
  };
  const pushFile = (url: string): void => {
    const inferred = inferAttachmentKind(url);
    out.push(
      fileBlock(inferred.kind, fileSource(url, undefined), {
        ...(inferred.mimeType !== undefined ? { mimeType: inferred.mimeType } : {}),
        label: inferred.label,
      }),
    );
  };
  if (role === "toolresult" || role === "tool_result" || role === "tool") {
    const tool = toolBlock(
      // tool-cards.ts:494-500: a tool message naming no call is the card `${name}:0`.
      resolveToolCallId({}, record) ?? `${key}#${resolveToolName({}, record)}:0`,
      record.toolName ?? record.tool_name,
      record.isError === true ? "error" : "result",
      { output: resultOutput(record) },
    );
    if (tool !== null) out.push(tool);
    if (Array.isArray(record.content)) {
      for (const raw of record.content) {
        const item = asRecord(raw);
        if (item === null) continue;
        const file = structuredFile(item, false);
        if (file !== null && file !== "dropped") out.push(file);
      }
    }
    // The `show_widget` result that minted a document (also nested in code mode): the
    // proof the view belongs to THIS session (widgets.ts `widgetFromShowWidgetResult`,
    // the live carrier's reading).
    const toolName = record.toolName ?? record.tool_name;
    const toolCallId = resolveToolCallId({}, record);
    if (
      record.isError !== true &&
      (toolName === SHOW_WIDGET_TOOL || (typeof toolCallId === "string" && isNestedShowWidgetCallId(toolCallId)))
    ) {
      // A history row may carry the tool's JSON text as a bare string
      // (chat-display-projection.canvas.test.ts: `content: JSON.stringify({kind:"canvas",…})`).
      pushWidget(
        widgetFromShowWidgetResult(
          typeof record.content === "string" ? { ...record, content: [{ type: "text", text: record.content }] } : record,
        ),
        "tool",
      );
    }
  } else if (role === "custom") {
    if (record.customType === "openclaw.nested-tool.v1" && Array.isArray(record.content)) {
      const ids = toolItemCallIds(record, record.content, key);
      for (const [index, raw] of record.content.entries()) {
        const item = asRecord(raw);
        const t = item === null ? null : isToolCallItem(item) ? "call" : toolType(item.type);
        if (item === null || t === null) continue;
        const tool = toolBlock(
          ids.get(index),
          item.name ?? item.toolName,
          t === "call" ? "call" : item.isError === true ? "error" : "result",
          t === "call" ? { input: callArgs(item) } : { output: resultOutput(item) },
        );
        if (tool !== null) out.push(tool);
        // A `show_widget` that ran nested in code mode: the history keeps its call and its
        // RESULT in this row (src/gateway/chat-display-projection.core.ts:424-459
        // `prepareChatHistoryRecoveryMessages`, content = `nestedToolActivityContent`,
        // src/sessions/nested-tool-activity.ts:73-87: `{...call, ...result, type:"toolResult"}`).
        // The result is the proof the document belongs to this session, as at top level.
        if (t !== "call" && item.isError !== true && (item.toolName ?? item.name) === SHOW_WIDGET_TOOL) {
          pushWidget(widgetFromShowWidgetResult(item), "tool");
        }
      }
    }
  } else if (role === "assistant") {
    const assistant = readsAsAssistant(record);
    const delivery = deliveryFacts(record);
    const expand = (text: string): void => {
      if (!assistant) {
        pushText(text);
        return;
      }
      for (const preview of extractCanvasShortcodes(text).previews) pushWidget(widgetFromPreview(preview), "shortcode");
      for (const part of expandText(text, delivery)) {
        if (part.type === "media") pushFile(part.url);
        else pushText(part.text);
      }
    };
    const content =
      typeof record.content === "string" || Array.isArray(record.content)
        ? record.content
        : typeof record.text === "string"
          ? record.text
          : undefined;
    if (typeof content === "string") {
      expand(content);
    } else if (Array.isArray(content)) {
      // Every tool item's card id, paired as `extractToolCards` pairs them — an id-less
      // result goes to the earliest open same-name call (tool-call-id.ts).
      const ids = toolItemCallIds(record, content, key);
      for (const [index, raw] of content.entries()) {
        const item = asRecord(raw);
        if (item === null) continue;
        const file = structuredFile(item, assistant);
        if (file === "dropped") continue;
        if (file !== null) {
          out.push(file);
          continue;
        }
        const t = isToolCallItem(item) ? "call" : toolType(item.type);
        if (t !== null) {
          const tool = toolBlock(
            // tool-cards.ts:386/:409 — one identity everywhere (tool-call-id.ts).
            ids.get(index),
            item.name ?? item.toolName,
            t === "call" ? "call" : item.isError === true ? "error" : "result",
            t === "call" ? { input: callArgs(item) } : { output: resultOutput(item) },
          );
          if (tool !== null) out.push(tool);
          continue;
        }
        if (item.type === "canvas") {
          if (assistant) pushWidget(widgetFromPreview(previewFromChatPart(item)), "canvas");
          continue;
        }
        const text = readString(item, "text");
        if (text !== undefined && (item.type === "text" || item.type === "input_text" || item.type === "output_text")) {
          expand(text);
        }
      }
    }
  }
  out.push(...widgets.slice(0, MAX_WIDGET_PARTS_PER_TURN));
  return out.length > MAX_ROW_BLOCKS
    ? { blocks: out.slice(0, MAX_ROW_BLOCKS), truncated: true }
    : { blocks: out, truncated: false };
}

/** What a row's blocks weigh in UTF-8 (their JSON), for the row's content budget. */
export function blocksBytes(blocks: readonly RowBlock[]): number {
  return blocks.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(blocks), "utf8");
}

/** The tool blocks without their payloads, each marked cut with the size it had: what a row
 *  keeps first when its content is over its byte budget (the card stays). */
export function withoutToolPayloads(blocks: readonly RowBlock[]): RowBlock[] {
  return blocks.map((b) => {
    if (b.type !== "tool" || (b.input === undefined && b.output === undefined)) return b;
    const { input, output, ...rest } = b;
    return {
      ...rest,
      ...(input !== undefined ? { inputOmitted: true as const, inputBytes: Buffer.byteLength(JSON.stringify(input) ?? "", "utf8") } : {}),
      ...(output !== undefined ? { outputOmitted: true as const, outputBytes: Buffer.byteLength(JSON.stringify(output) ?? "", "utf8") } : {}),
    };
  });
}

/** The blocks without any text (`omitted`): what a row keeps when its content is over its
 *  byte budget — its files and tool blocks are never dropped for the size of its text. */
export function withoutBlockTexts(blocks: readonly RowBlock[]): RowBlock[] {
  return blocks.map((b) => (b.type === "text" ? { type: "text", omitted: true } : b));
}
