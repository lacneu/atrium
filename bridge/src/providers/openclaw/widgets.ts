// Inline widgets — the OpenClaw half of Atrium's `widget` message part.
//
// An OpenClaw agent shows an inline widget with its core `show_widget` tool: the
// gateway stores a self-contained HTML document (a "managed canvas document",
// `cv_<id>`) and points the reply at it. Atrium never receives the bytes on the chat
// stream — only a DESCRIPTOR (view id, title, preferred height). The bytes are
// fetched later, per view, through `canvas.document.view` (bridge route
// `/canvas-view`), after Convex has checked that the view belongs to the chat.
//
// The descriptor reaches the bridge by three carriers, all ported from the pinned
// upstream (v2026.9.6):
//   (a) a `{type:"canvas", preview}` part in a `chat` frame's `message.content`
//       (src/gateway/chat-display-projection.canvas.ts), normalized by
//       `coerceCanvasPreview` (src/chat/canvas-render.ts);
//   (b) the `show_widget` tool RESULT (`result.details`, src/canvas/widget-tool.ts),
//       also when the tool runs nested in code mode (`toolCallId`
//       `tool_search_code:<call>:show_widget:<n>`);
//   (c) an `[embed ref="cv_…" …/]` shortcode in the assistant text
//       (`extractCanvasShortcodes`, same file). The bridge leaves the text as sent;
//       the SPA hides a shortcode at render time only when the message carries the
//       widget it names (src/chat/widgets/shortcodes.ts).
//
// Only what Atrium renders is kept: a managed canvas document shown in the assistant
// message (upstream `isManagedCanvasDocumentPreview`, ui/src/pages/chat/components/
// widget-card.ts). MCP-App previews (`preview.mcpApp`), `node_panel` surfaces, strict
// (no-script) previews and external URLs are refused with a named reason.
//
// PURE module: no I/O, every rule unit-tested (bridge/test/widgets.test.ts).

/** The connect capability that makes the gateway offer `show_widget` to the agent
 *  (packages/gateway-protocol/src/client-info.ts `GATEWAY_CLIENT_CAPS.INLINE_WIDGETS`). */
export const INLINE_WIDGETS_CAP = "inline-widgets";

/** The tool whose result carries a widget (src/canvas/widget-tool.ts). */
export const SHOW_WIDGET_TOOL = "show_widget";

/** upstream `normalizePreferredHeight`: below the floor the hint is dropped, above the
 *  ceiling it is clamped. */
export const WIDGET_PREFERRED_HEIGHT_MIN = 160;
export const WIDGET_PREFERRED_HEIGHT_MAX = 1200;
/** Display bound for a title — a label, never a payload channel. */
export const WIDGET_TITLE_MAX_CHARS = 200;
/** Per-turn bound on widget parts (dedup is by view id; this caps a runaway turn). */
export const MAX_WIDGET_PARTS_PER_TURN = 16;

/** The `canvas.document.view` param contract (packages/gateway-protocol/src/schema/
 *  canvas.ts `CanvasDocumentViewParamsSchema.docId`) narrowed to the managed-document
 *  prefix `show_widget` mints. The same grammar is re-checked by Convex before any
 *  fetch, so a view id that could not be fetched is never stored. */
export const WIDGET_VIEW_ID_RE = /^cv_[A-Za-z0-9._-]{1,253}$/;

const CANVAS_DOCUMENT_PREFIX = "/__openclaw__/canvas/documents/";

type CanvasSurface = "assistant_message" | "node_panel";
type CanvasSandbox = "strict" | "scripts";

/** upstream `CanvasPreview` (src/chat/canvas-render.ts), minus the presentation
 *  fields Atrium does not render (`className`, `style`). */
export interface CanvasPreview {
  kind: "canvas";
  surface: CanvasSurface;
  render: "url";
  title?: string;
  preferredHeight?: number;
  url?: string;
  viewId?: string;
  sandbox?: CanvasSandbox;
  /** Present when the preview is an MCP App view — out of scope, refused. */
  mcpApp?: { viewId: string };
}

/** The stable descriptor Atrium stores as a `widget` message part. */
export interface WidgetDescriptor {
  viewId: string;
  title?: string;
  preferredHeight?: number;
  sandbox: "scripts";
}

/** Which carrier named a widget. Only `tool` is authoritative: the `show_widget` tool
 *  itself minted the document and reported it on the socket that sent the turn. A
 *  `canvas` chat part is projected by the gateway from ANY tool result whose JSON text
 *  has the canvas shape (upstream server-chat.ts `extractChatToolResultCanvasPreview` →
 *  `extractCanvasFromText`), and a shortcode is model text — both can name a document
 *  of another conversation. Convex registers a view to a conversation from `tool` only
 *  and stores the other two only for a view already registered to it. */
export type WidgetOrigin = "tool" | "canvas" | "shortcode";

/** Why a canvas preview is not rendered. Named so the refusal can be counted. */
export type WidgetRefusal =
  | "not-canvas"
  | "surface"
  | "mcp-app"
  | "strict"
  | "unmanaged";

export type WidgetVerdict =
  | { ok: true; widget: WidgetDescriptor }
  | { ok: false; reason: WidgetRefusal };

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function getString(record: Rec | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getNumber(record: Rec | undefined, key: string): number | undefined {
  const value = record?.[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  // upstream `asFiniteNumber` also admits a numeric string.
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normalizeSurface(value: string | undefined): CanvasSurface | undefined {
  return value === "assistant_message" || value === "node_panel" ? value : undefined;
}

function normalizeSandbox(value: string | undefined): CanvasSandbox | undefined {
  return value === "strict" || value === "scripts" ? value : undefined;
}

export function normalizePreferredHeight(value: number | undefined): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= WIDGET_PREFERRED_HEIGHT_MIN
    ? Math.min(Math.trunc(value), WIDGET_PREFERRED_HEIGHT_MAX)
    : undefined;
}

/** Port of upstream `coerceCanvasPreview` (v2026.9.6 src/chat/canvas-render.ts). The
 *  MCP-App descriptor is reduced to its view id: its presence alone decides the
 *  refusal. */
export function coerceCanvasPreview(value: unknown): CanvasPreview | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kind = getString(record, "kind")?.trim().toLowerCase();
  if (kind !== "canvas") return undefined;
  const presentation = asRecord(record.presentation);
  const view = asRecord(record.view);
  const source = asRecord(record.source);
  const mcpAppViewIdRaw = getString(asRecord(record.mcpApp), "viewId");
  const mcpApp =
    mcpAppViewIdRaw && mcpAppViewIdRaw.length <= 128 ? { viewId: mcpAppViewIdRaw } : undefined;
  const requestedSurface = getString(presentation, "target") ?? getString(record, "target");
  const surface = requestedSurface ? normalizeSurface(requestedSurface) : "assistant_message";
  if (!surface) return undefined;
  const title = getString(presentation, "title") ?? getString(view, "title");
  const preferredHeight = normalizePreferredHeight(
    getNumber(presentation, "preferred_height") ??
      getNumber(presentation, "preferredHeight") ??
      getNumber(view, "preferred_height") ??
      getNumber(view, "preferredHeight"),
  );
  const sandbox = normalizeSandbox(getString(presentation, "sandbox"));
  const viewUrl = getString(view, "url") ?? getString(view, "entryUrl");
  const viewId = getString(view, "id") ?? getString(view, "docId");
  const base = {
    kind: "canvas" as const,
    surface,
    render: "url" as const,
    ...(title ? { title } : {}),
    ...(preferredHeight ? { preferredHeight } : {}),
    ...(sandbox ? { sandbox } : {}),
  };
  if (mcpApp && viewId === mcpApp.viewId) {
    return { ...base, viewId, mcpApp };
  }
  if (viewUrl) {
    return { ...base, url: viewUrl, ...(viewId ? { viewId } : {}), ...(mcpApp ? { mcpApp } : {}) };
  }
  if (getString(source, "type")?.trim().toLowerCase() === "url") {
    const url = getString(source, "url");
    if (!url) return undefined;
    return { ...base, url, ...(mcpApp ? { mcpApp } : {}) };
  }
  return undefined;
}

/** The chat projection already carries a coerced preview (`{type:"canvas", preview}`,
 *  chat-display-projection.canvas.ts); it is re-coerced from its flat shape. */
export function previewFromChatPart(part: unknown): CanvasPreview | undefined {
  const record = asRecord(part);
  const preview = asRecord(record?.preview);
  if (!preview) return undefined;
  if (getString(preview, "kind")?.trim().toLowerCase() !== "canvas") return undefined;
  const surface = normalizeSurface(getString(preview, "surface"));
  if (!surface) return undefined;
  const title = getString(preview, "title");
  const preferredHeight = normalizePreferredHeight(getNumber(preview, "preferredHeight"));
  const sandbox = normalizeSandbox(getString(preview, "sandbox"));
  const url = getString(preview, "url");
  const viewId = getString(preview, "viewId");
  const mcpAppViewId = getString(asRecord(preview.mcpApp), "viewId");
  return {
    kind: "canvas",
    surface,
    render: "url",
    ...(title ? { title } : {}),
    ...(preferredHeight ? { preferredHeight } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(url ? { url } : {}),
    ...(viewId ? { viewId } : {}),
    ...(mcpAppViewId ? { mcpApp: { viewId: mcpAppViewId } } : {}),
  };
}

/** Port of upstream `isManagedCanvasDocumentPreview` (widget-card.ts): the entry URL
 *  is a same-gateway canvas document path whose id IS the view id. */
export function isManagedCanvasDocumentPreview(preview: CanvasPreview): boolean {
  const viewId = preview.viewId?.trim();
  const entryUrl = preview.url?.trim();
  if (!viewId || !entryUrl) return false;
  try {
    const entry = new URL(entryUrl, "http://localhost");
    if (entry.origin !== "http://localhost" || !entry.pathname.startsWith(CANVAS_DOCUMENT_PREFIX)) {
      return false;
    }
    const [encodedDocumentId, entrypoint] = entry.pathname
      .slice(CANVAS_DOCUMENT_PREFIX.length)
      .split("/", 2);
    if (!encodedDocumentId || !entrypoint) return false;
    const documentId = decodeURIComponent(encodedDocumentId);
    return /^[A-Za-z0-9._-]+$/u.test(documentId) && documentId === viewId;
  } catch {
    return false;
  }
}

/** The one decision: is this preview an inline widget Atrium renders? */
export function widgetFromPreview(preview: CanvasPreview | undefined): WidgetVerdict {
  if (!preview) return { ok: false, reason: "not-canvas" };
  if (preview.surface !== "assistant_message") return { ok: false, reason: "surface" };
  // MCP Apps render through a different host protocol (AppBridge) — not this part.
  if (preview.mcpApp) return { ok: false, reason: "mcp-app" };
  // A strict preview is a no-script artifact upstream serves by URL, never through
  // `canvas.document.view` (which refuses anything but `cspSandbox: "scripts"`).
  if (preview.sandbox === "strict") return { ok: false, reason: "strict" };
  if (!isManagedCanvasDocumentPreview(preview)) return { ok: false, reason: "unmanaged" };
  const viewId = preview.viewId!.trim();
  if (!WIDGET_VIEW_ID_RE.test(viewId)) return { ok: false, reason: "unmanaged" };
  const title = preview.title?.trim().slice(0, WIDGET_TITLE_MAX_CHARS) || undefined;
  return {
    ok: true,
    widget: {
      viewId,
      ...(title ? { title } : {}),
      ...(preview.preferredHeight ? { preferredHeight: preview.preferredHeight } : {}),
      sandbox: "scripts",
    },
  };
}

/** The `show_widget` result: `details` first (the structured channel), then the
 *  JSON text the tool also returns (upstream `extractCanvasFromText`). Null when the
 *  result carries no canvas at all. */
export function widgetFromShowWidgetResult(result: unknown): WidgetVerdict | null {
  const record = asRecord(result);
  const fromDetails = coerceCanvasPreview(record?.details);
  if (fromDetails) return widgetFromPreview(fromDetails);
  const content = record?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const text = getString(asRecord(part), "text");
      if (!text) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      const preview = coerceCanvasPreview(parsed);
      if (preview) return widgetFromPreview(preview);
    }
  }
  return null;
}

/** A nested code-mode call names the inner tool in its id:
 *  `tool_search_code:<outer call>:show_widget:<n>` (captured live on 2026.9.6). The
 *  frame's own `name` is authoritative; this only recognises the id shape. */
export function isNestedShowWidgetCallId(toolCallId: string | undefined): boolean {
  return typeof toolCallId === "string" && /:show_widget:\d+$/.test(toolCallId);
}

// --- [embed …] shortcodes -----------------------------------------------------

/** Code ranges of a Markdown text: fenced blocks (``` / ~~~, up to 3 spaces of
 *  indent, closed by a fence of the same character at least as long), indented
 *  blocks (4 spaces or a tab after a blank line or at the start), and inline code
 *  spans (a backtick run closed by a run of the same length). Upstream parses
 *  CommonMark with a full parser (packages/markdown-core findMarkdownCodeRegions);
 *  this covers the constructs an agent writes a literal example in. */
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

function parseCanvasAttributes(raw: string): Record<string, string> {
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

function previewFromShortcode(attrs: Record<string, string>): CanvasPreview | undefined {
  if (attrs.target && normalizeSurface(attrs.target) !== "assistant_message") return undefined;
  const title = attrs.title?.trim() || undefined;
  const preferredHeight =
    attrs.height && Number.isFinite(Number(attrs.height))
      ? normalizePreferredHeight(Number(attrs.height))
      : undefined;
  const ref = attrs.ref?.trim();
  const url = attrs.url?.trim();
  if (!url && !ref) return undefined;
  return {
    kind: "canvas",
    surface: "assistant_message",
    render: "url",
    url: url ?? `${CANVAS_DOCUMENT_PREFIX}${encodeURIComponent(ref!)}/index.html`,
    ...(ref ? { viewId: ref } : {}),
    ...(title ? { title } : {}),
    ...(preferredHeight ? { preferredHeight } : {}),
  };
}

/** Port of upstream `extractCanvasShortcodes`: `[embed …/]` and `[embed …]…[/embed]`
 *  outside Markdown code become previews and leave the text; a literal example in
 *  code stays visible. A shortcode that yields no preview stays in the text. */
export function extractCanvasShortcodes(text: string): {
  text: string;
  previews: CanvasPreview[];
} {
  if (!text.trim() || !text.toLowerCase().includes("[embed")) return { text, previews: [] };
  const codeRegions = findCodeRegions(text);
  const matches: Array<{ start: number; end: number; attrs: Record<string, string> }> = [];
  const blockRe = /\[embed\s+([^\]]*?[^\]/]|)\]([\s\S]*?)\[\/embed\]/gi;
  const selfClosingRe = /\[embed\s+([^\]]*?)\/\]/gi;
  for (const re of [blockRe, selfClosingRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const start = match.index;
      if (isInsideCode(start, codeRegions)) continue;
      matches.push({ start, end: start + match[0].length, attrs: parseCanvasAttributes(match[1] ?? "") });
    }
  }
  if (matches.length === 0) return { text, previews: [] };
  matches.sort((a, b) => a.start - b.start);
  const previews: CanvasPreview[] = [];
  let cursor = 0;
  let stripped = "";
  for (const match of matches) {
    if (match.start < cursor) continue;
    stripped += text.slice(cursor, match.start);
    const preview = previewFromShortcode(match.attrs);
    if (!preview) stripped += text.slice(match.start, match.end);
    else previews.push(preview);
    cursor = match.end;
  }
  stripped += text.slice(cursor);
  return { text: stripped, previews };
}
