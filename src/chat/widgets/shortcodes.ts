// Render-time handling of OpenClaw `[embed …]` shortcodes in an assistant reply.
//
// The bridge stores the reply text EXACTLY as the gateway sent it, shortcode included:
// a reply that is only a shortcode is a real reply, and a shortcode Atrium refuses
// must stay readable. The shortcode is hidden here, at render time, and ONLY when the
// message carries the widget part it names — the widget then stands where the
// shortcode was meant to be. Every other shortcode (unregistered view, refused URL,
// widgets off, literal example in code) stays visible text.
//
// Matching mirrors the bridge port of upstream `extractCanvasShortcodes`
// (bridge/src/providers/openclaw/widgets.ts): same code-region rule, same two tag
// forms, same attribute grammar, same managed-document check. A parity test runs both
// on one corpus (widgets/shortcodes.test.ts).

// The code regions are the upstream CommonMark parser's (./codeRegions.ts, the SPA copy of
// the bridge port): a shortcode starting inside fenced, indented, quoted or inline code is a
// literal example, never hidden (codex review 4, finding 3).
import { findCodeRegions, isInsideCode } from "./codeRegions";

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

/** Every shortcode outside code, in text order, with the view it names (null when
 *  it names none Atrium could render). */
export function findShortcodes(
  text: string,
): Array<{ start: number; end: number; viewId: string | null }> {
  if (!text.trim() || !text.toLowerCase().includes("[embed")) return [];
  const codeRegions = findCodeRegions(text);
  const matches: Array<{ start: number; end: number; viewId: string | null }> = [];
  const blockRe = /\[embed\s+([^\]]*?[^\]/]|)\]([\s\S]*?)\[\/embed\]/gi;
  const selfClosingRe = /\[embed\s+([^\]]*?)\/\]/gi;
  for (const re of [blockRe, selfClosingRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const start = match.index;
      if (isInsideCode(start, codeRegions)) continue;
      matches.push({
        start,
        end: start + match[0].length,
        viewId: shortcodeViewId(parseAttributes(match[1] ?? "")),
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

/** The text to RENDER for one body segment: shortcodes naming a view this message
 *  renders are removed; every other shortcode stays. `streamingTail` = this segment
 *  is the growing end of a reply still being written. */
export function renderableText(
  text: string,
  renderedViewIds: ReadonlySet<string>,
  streamingTail: boolean,
): string {
  let out = text;
  if (renderedViewIds.size > 0) {
    const hits = findShortcodes(text).filter((s) => s.viewId !== null && renderedViewIds.has(s.viewId));
    if (hits.length > 0) {
      out = "";
      let cursor = 0;
      for (const hit of hits) {
        out += text.slice(cursor, hit.start);
        cursor = hit.end;
      }
      out += text.slice(cursor);
    }
  }
  return streamingTail ? holdBackOpenShortcode(out) : out;
}
