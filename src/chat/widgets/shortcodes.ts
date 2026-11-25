// Render-time handling of OpenClaw `[embed …]` shortcodes in an assistant reply.
//
// The bridge stores the reply text EXACTLY as the gateway sent it, shortcode included:
// a reply that is only a shortcode is a real reply, and a shortcode Atrium refuses
// must stay readable. The shortcode is hidden here, at render time, and ONLY when the
// message carries the widget part it names — the widget then stands where the
// shortcode was meant to be. Every other shortcode (unregistered view, refused URL,
// widgets off, literal example in code) stays visible text.
//
// Since OpenClaw 2026.10.33 a shortcode may also name a YouTube video by `url`. The gateway
// transforms nothing (the text is the same live and in history), so this is decided here too,
// on any gateway version: a URL the YouTube parser accepts becomes a video card
// (YouTubeVideoPart); a URL it refuses is never framed — it reads as a plain link when it is
// an absolute https address, and stays text otherwise.
//
// Matching mirrors the bridge port of upstream `extractCanvasShortcodes`
// (bridge/src/providers/openclaw/widgets.ts): same code-region rule, same two tag
// forms, same attribute grammar, same managed-document check. A parity test runs both
// on one corpus (widgets/shortcodes.test.ts).

// The code regions are the upstream CommonMark parser's (./codeRegions.ts, the SPA copy of
// the bridge port): a shortcode starting inside fenced, indented, quoted or inline code is a
// literal example, never hidden (codex review 4, finding 3).
import { findCodeRegions, isInsideCode } from "./codeRegions";
import { parseYouTubeVideoUrl, youTubeVideoAddresses, type YouTubeVideoRef } from "./youtubeVideo";

const CANVAS_DOCUMENT_PREFIX = "/__openclaw__/canvas/documents/";
/** Same grammar as the bridge's `WIDGET_VIEW_ID_RE` and Convex's widget descriptor. */
const WIDGET_VIEW_ID_RE = /^cv_[A-Za-z0-9._-]{1,253}$/;

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const key = match[1]?.trim().toLowerCase();
    const value = (match[2] ?? match[3] ?? "").trim();
    if (key && value) attrs[key] = value;
  }
  return attrs;
}

/** The view a shortcode names, by the bridge's own rule (inline surface, managed
 *  same-gateway document whose id IS the ref), or null when it names none. */
function shortcodeViewId(attrs: Record<string, string>): string | null {
  if (attrs.target && attrs.target !== "assistant_message") return null;
  const ref = attrs.ref?.trim();
  if (!ref || !WIDGET_VIEW_ID_RE.test(ref)) return null;
  const url = attrs.url?.trim() || `${CANVAS_DOCUMENT_PREFIX}${encodeURIComponent(ref)}/index.html`;
  try {
    const entry = new URL(url, "http://localhost");
    if (entry.origin !== "http://localhost" || !entry.pathname.startsWith(CANVAS_DOCUMENT_PREFIX)) {
      return null;
    }
    const [encodedDocumentId, entrypoint] = entry.pathname
      .slice(CANVAS_DOCUMENT_PREFIX.length)
      .split("/", 2);
    if (!encodedDocumentId || !entrypoint) return null;
    const documentId = decodeURIComponent(encodedDocumentId);
    return /^[A-Za-z0-9._-]+$/u.test(documentId) && documentId === ref ? ref : null;
  } catch {
    return null;
  }
}

/** What a `url` shortcode shows when it names no widget: a video card, or a plain link. */
export type ShortcodeEmbed =
  | ({ kind: "youtube"; title?: string } & YouTubeVideoRef)
  | { kind: "link"; href: string; title?: string };

/** Paths the gateway serves itself: a shortcode naming one is a widget's, never a link. */
const GATEWAY_PATH_PREFIX = "/__openclaw__/";

/** The embed a shortcode's `url` stands for, by upstream's order (canvas-render.ts
 *  `previewFromShortcode`, then widget-card.ts:506-523): the inline surface only, and the
 *  YouTube parser before anything else. A refused URL is NEVER framed (upstream leaves an
 *  empty frame there): absolute https without credentials reads as a link, the rest is text. */
function shortcodeEmbed(attrs: Record<string, string>): ShortcodeEmbed | null {
  if (attrs.target && attrs.target !== "assistant_message") return null;
  const raw = attrs.url;
  if (!raw) return null;
  const title = attrs.title?.replace(/\s+/g, " ").trim() || undefined;
  const video = parseYouTubeVideoUrl(raw);
  if (video) {
    return { kind: "youtube", videoId: video.videoId, startSeconds: video.startSeconds, ...(title ? { title } : {}) };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.pathname.startsWith(GATEWAY_PATH_PREFIX)) return null;
  return { kind: "link", href: url.href, ...(title ? { title } : {}) };
}

/** A Markdown link to `href` labelled `label`, neither of which can break out of it: every
 *  ASCII punctuation mark of the label is escaped (no emphasis, no nested link, no HTML),
 *  and the destination is the `<…>` form, where a serialized URL can only be misread at a
 *  backslash (`<`, `>` and spaces are already percent-encoded by the URL serializer). */
export function markdownLink(href: string, label: string): string {
  const text = label.replace(/\s+/g, " ").replace(/[!-/:-@[-`{-~]/g, "\\$&");
  return `[${text}](<${href.replace(/\\/g, "%5C")}>)`;
}

type Shortcode = { start: number; end: number; viewId: string | null; embed: ShortcodeEmbed | null };

/** Every shortcode outside code, in text order, with the view it names (null when
 *  it names none Atrium could render) and the embed its `url` stands for (null when none). */
export function findShortcodes(text: string): Shortcode[] {
  if (!text.trim() || !text.toLowerCase().includes("[embed")) return [];
  const codeRegions = findCodeRegions(text);
  const matches: Shortcode[] = [];
  const blockRe = /\[embed\s+([^\]]*?[^\]/]|)\]([\s\S]*?)\[\/embed\]/gi;
  const selfClosingRe = /\[embed\s+([^\]]*?)\/\]/gi;
  for (const re of [blockRe, selfClosingRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const start = match.index;
      if (isInsideCode(start, codeRegions)) continue;
      const attrs = parseAttributes(match[1] ?? "");
      const viewId = shortcodeViewId(attrs);
      matches.push({
        start,
        end: start + match[0].length,
        viewId,
        // A managed document is a widget's business alone (shown, or left as text).
        embed: viewId === null ? shortcodeEmbed(attrs) : null,
      });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  const kept: typeof matches = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue;
    kept.push(m);
    cursor = m.end;
  }
  return kept;
}

/** A streaming tail that is still becoming a shortcode: a trailing `[`…`[embe`, an
 *  unfinished `[embed …` tag, or a block whose `[/embed]` has not arrived. Cut so the
 *  half-typed tag never flashes; the settled text decides for good. */
function holdBackOpenShortcode(text: string): string {
  const lower = text.toLowerCase();
  const cut = (pos: number): string =>
    isInsideCode(pos, findCodeRegions(text)) ? text : text.slice(0, pos);
  const lastBracket = text.lastIndexOf("[");
  if (lastBracket !== -1) {
    const tail = lower.slice(lastBracket);
    if (tail.length < "[embed".length && "[embed".startsWith(tail)) return cut(lastBracket);
  }
  const openAt = lower.lastIndexOf("[embed");
  if (openAt === -1) return text;
  const after = text.slice(openAt);
  if (!/^\[embed(?:\s|$)/i.test(after)) return text;
  const close = after.indexOf("]");
  if (close === -1) return cut(openAt);
  if (after[close - 1] === "/") return text;
  if (/\[\/embed\]/i.test(after)) return text;
  return cut(openAt);
}

/** One piece of a body segment as it renders: Markdown text, or a video card. */
export type BodyPiece =
  | { kind: "text"; text: string }
  | ({ kind: "youtube"; title?: string } & YouTubeVideoRef);

/** The pieces to RENDER for one body segment, in order: shortcodes naming a view this
 *  message renders are removed; a YouTube shortcode is its own piece (the card stands
 *  where the shortcode was); a refused https URL is rewritten as a link inside the text;
 *  every other shortcode stays. `streamingTail` = this segment is the growing end of a
 *  reply still being written — the half-typed tag is cut FIRST, so a tag is only ever
 *  decided whole and the links written here are never mistaken for an open one. */
export function renderablePieces(
  text: string,
  renderedViewIds: ReadonlySet<string>,
  streamingTail: boolean,
): BodyPiece[] {
  const source = streamingTail ? holdBackOpenShortcode(text) : text;
  const pieces: BodyPiece[] = [];
  let pending = "";
  let cursor = 0;
  for (const hit of findShortcodes(source)) {
    const hidden = hit.viewId !== null && renderedViewIds.has(hit.viewId);
    if (!hidden && hit.embed === null) continue;
    pending += source.slice(cursor, hit.start);
    cursor = hit.end;
    if (hidden) continue;
    if (hit.embed!.kind === "link") {
      pending += markdownLink(hit.embed!.href, hit.embed!.title ?? hit.embed!.href);
      continue;
    }
    const { kind: _kind, ...video } = hit.embed!;
    pieces.push({ kind: "text", text: pending }, { kind: "youtube", ...video });
    pending = "";
  }
  pieces.push({ kind: "text", text: pending + source.slice(cursor) });
  return pieces;
}

/** The text to RENDER for a segment that can hold no card (a work note): the same
 *  decisions, a video reading as a link to its rebuilt watch page. */
export function renderableText(
  text: string,
  renderedViewIds: ReadonlySet<string>,
  streamingTail: boolean,
): string {
  return renderablePieces(text, renderedViewIds, streamingTail)
    .map((piece) => {
      if (piece.kind === "text") return piece.text;
      const video = youTubeVideoAddresses(piece);
      return video ? markdownLink(video.watchUrl, piece.title ?? video.watchUrl) : "";
    })
    .join("");
}
