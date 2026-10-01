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

const CANVAS_DOCUMENT_PREFIX = "/__openclaw__/canvas/documents/";
/** Same grammar as the bridge's `WIDGET_VIEW_ID_RE` and Convex's widget descriptor. */
const WIDGET_VIEW_ID_RE = /^cv_[A-Za-z0-9._-]{1,253}$/;

/** Code ranges of a Markdown text: fenced blocks, indented blocks after a blank line,
 *  and inline code spans. A shortcode starting inside one is a literal example. */
export function findCodeRegions(text: string): Array<{ start: number; end: number }> {
  if (!/[`~\t]| {4}/u.test(text)) return [];
  const regions: Array<{ start: number; end: number }> = [];
  const lines: Array<{ start: number; end: number; body: string }> = [];
  {
    let start = 0;
    while (start <= text.length) {
      const nl = text.indexOf("\n", start);
      const end = nl === -1 ? text.length : nl + 1;
      lines.push({ start, end, body: text.slice(start, nl === -1 ? text.length : nl) });
      if (nl === -1) break;
      start = end;
    }
  }
  const blockCovered: Array<{ start: number; end: number }> = [];
  let prevBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line.body);
    if (fence && !(fence[1]![0] === "`" && line.body.slice(fence[0].length).includes("`"))) {
      const ch = fence[1]![0]!;
      const len = fence[1]!.length;
      const closeRe = new RegExp(`^ {0,3}\\${ch}{${len},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j]!.body)) j++;
      const end = j < lines.length ? lines[j]!.end : text.length;
      blockCovered.push({ start: line.start, end });
      i = j;
      prevBlank = false;
      continue;
    }
    if (prevBlank && /^(?: {4}|\t)/.test(line.body) && line.body.trim() !== "") {
      let j = i;
      while (
        j + 1 < lines.length &&
        (/^(?: {4}|\t)/.test(lines[j + 1]!.body) || lines[j + 1]!.body.trim() === "")
      ) {
        j++;
      }
      blockCovered.push({ start: line.start, end: lines[j]!.end });
      i = j;
      prevBlank = lines[j]!.body.trim() === "";
      continue;
    }
    prevBlank = line.body.trim() === "";
  }
  regions.push(...blockCovered);
  const inBlock = (pos: number) => blockCovered.some((r) => pos >= r.start && pos < r.end);
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`" || inBlock(i)) {
      i++;
      continue;
    }
    let run = 0;
    while (text[i + run] === "`") run++;
    let j = i + run;
    let closed = -1;
    while (j < text.length) {
      if (text[j] === "`") {
        let r = 0;
        while (text[j + r] === "`") r++;
        if (r === run) {
          closed = j + r;
          break;
        }
        j += r;
      } else {
        j++;
      }
    }
    if (closed === -1) {
      i += run;
      continue;
    }
    regions.push({ start: i, end: closed });
    i = closed;
  }
  return regions.sort((a, b) => a.start - b.start);
}

function isInsideCode(pos: number, regions: Array<{ start: number; end: number }>): boolean {
  return regions.some((region) => pos >= region.start && pos < region.end);
}

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
