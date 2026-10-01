// The pure widget rules (providers/openclaw/widgets.ts): ports of upstream
// coerceCanvasPreview / extractCanvasShortcodes / isManagedCanvasDocumentPreview
// (v2026.9.6), and the one decision — is this preview an inline widget Atrium renders?
// Shapes are the ones captured live on the 2026.9.6 bench.
import { describe, expect, it } from "vitest";

import {
  coerceCanvasPreview,
  extractCanvasShortcodes,
  findCodeRegions,
  isNestedShowWidgetCallId,
  previewFromChatPart,
  widgetFromPreview,
  widgetFromShowWidgetResult,
} from "../src/providers/openclaw/widgets.js";

const VIEW = "cv_87c3b1326a2c47028d93b4c38e242832";
const URL = `/__openclaw__/canvas/documents/${VIEW}/index.html`;

/** The chat part, as captured (probe-widgets, S_cap, final of the capability turn). */
const CHAT_PART = {
  type: "canvas",
  preview: {
    kind: "canvas",
    surface: "assistant_message",
    render: "url",
    url: URL,
    viewId: VIEW,
    title: "Counter",
    sandbox: "scripts",
  },
  rawText: null,
};

/** The `show_widget` result, as captured (`details` + the JSON text twin). */
const DETAILS = {
  kind: "canvas",
  presentation: { target: "assistant_message", title: "Counter", sandbox: "scripts" },
  view: { id: VIEW, url: URL },
  text: `Widget hosted at ${URL}`,
};

describe("the chat part and the tool result carry the same widget", () => {
  it("chat part -> widget", () => {
    expect(widgetFromPreview(previewFromChatPart(CHAT_PART))).toEqual({
      ok: true,
      widget: { viewId: VIEW, title: "Counter", sandbox: "scripts" },
    });
  });

  it("tool result details -> the same widget", () => {
    expect(widgetFromShowWidgetResult({ content: [], details: DETAILS })).toEqual({
      ok: true,
      widget: { viewId: VIEW, title: "Counter", sandbox: "scripts" },
    });
  });

  it("tool result WITHOUT details falls back to its JSON text (upstream extractCanvasFromText)", () => {
    const result = { content: [{ type: "text", text: JSON.stringify(DETAILS) }] };
    expect(widgetFromShowWidgetResult(result)).toMatchObject({ ok: true, widget: { viewId: VIEW } });
  });

  it("a result with no canvas at all is not a verdict", () => {
    expect(widgetFromShowWidgetResult({ content: [{ type: "text", text: "done" }] })).toBeNull();
  });

  it("the nested code-mode call id shape is recognised", () => {
    expect(isNestedShowWidgetCallId("tool_search_code:call_x_fc_y:show_widget:1")).toBe(true);
    expect(isNestedShowWidgetCallId("call_x|fc_y")).toBe(false);
  });
});

describe("what is NOT rendered, by name", () => {
  const withPreview = (patch: Record<string, unknown>) =>
    widgetFromPreview(previewFromChatPart({ ...CHAT_PART, preview: { ...CHAT_PART.preview, ...patch } }));

  it("an MCP App preview (out of scope)", () => {
    expect(withPreview({ mcpApp: { viewId: VIEW } })).toEqual({ ok: false, reason: "mcp-app" });
  });
  it("a node-panel surface", () => {
    expect(withPreview({ surface: "node_panel" })).toEqual({ ok: false, reason: "surface" });
  });
  it("a strict (no-script) preview", () => {
    expect(withPreview({ sandbox: "strict" })).toEqual({ ok: false, reason: "strict" });
  });
  it("an external URL", () => {
    expect(withPreview({ url: "https://example.test/x.html" })).toEqual({ ok: false, reason: "unmanaged" });
  });
  it("a document whose id is not the view id", () => {
    expect(withPreview({ url: "/__openclaw__/canvas/documents/cv_other/index.html" })).toEqual({
      ok: false,
      reason: "unmanaged",
    });
  });
  it("a managed document that is not a `cv_` view", () => {
    expect(
      withPreview({ viewId: "board-x", url: "/__openclaw__/canvas/documents/board-x/index.html" }),
    ).toEqual({ ok: false, reason: "unmanaged" });
  });
  it("a path-traversal-looking id", () => {
    expect(
      withPreview({ viewId: "cv_..%2F..", url: "/__openclaw__/canvas/documents/cv_..%2F../index.html" }),
    ).toEqual({ ok: false, reason: "unmanaged" });
  });
});

describe("coerceCanvasPreview (port)", () => {
  it("clamps the preferred height to 160–1200, and drops a smaller hint", () => {
    expect(coerceCanvasPreview({ ...DETAILS, presentation: { preferred_height: 5000 } })?.preferredHeight).toBe(1200);
    expect(coerceCanvasPreview({ ...DETAILS, presentation: { preferredHeight: 90 } })?.preferredHeight).toBeUndefined();
    expect(coerceCanvasPreview({ ...DETAILS, view: { ...DETAILS.view, preferredHeight: "320.9" } })?.preferredHeight).toBe(320);
  });
  it("refuses an unknown surface and a non-canvas kind", () => {
    expect(coerceCanvasPreview({ ...DETAILS, presentation: { target: "sidebar" } })).toBeUndefined();
    expect(coerceCanvasPreview({ ...DETAILS, kind: "image" })).toBeUndefined();
  });
  it("bounds the title", () => {
    const w = widgetFromPreview(coerceCanvasPreview({ ...DETAILS, presentation: { title: "t".repeat(500) } }));
    expect(w.ok && w.widget.title?.length).toBe(200);
  });
});

describe("[embed] shortcodes (port of extractCanvasShortcodes)", () => {
  const FINAL = `Tiny counter:\n\n[embed ref="${VIEW}" title="Counter" height="90" /]\n\nTOOLS: show_widget, canvas`;

  it("the captured final: one preview (the faithful upstream port strips it from ITS text; the bridge does not use that text)", () => {
    const { text, previews } = extractCanvasShortcodes(FINAL);
    expect(text).toBe("Tiny counter:\n\n\n\nTOOLS: show_widget, canvas");
    expect(previews.map((p) => widgetFromPreview(p))).toEqual([
      { ok: true, widget: { viewId: VIEW, title: "Counter", sandbox: "scripts" } },
    ]);
  });

  it("a literal example inside code stays visible text", () => {
    const fenced = `Use it like this:\n\n\`\`\`\n[embed ref="${VIEW}" /]\n\`\`\`\n`;
    expect(extractCanvasShortcodes(fenced)).toEqual({ text: fenced, previews: [] });
    const inline = `Write \`[embed ref="${VIEW}" /]\` in a reply.`;
    expect(extractCanvasShortcodes(inline)).toEqual({ text: inline, previews: [] });
    const indented = `Example:\n\n    [embed ref="${VIEW}" /]\n`;
    expect(extractCanvasShortcodes(indented)).toEqual({ text: indented, previews: [] });
  });

  it("the block form, and a non-assistant target left in place", () => {
    expect(extractCanvasShortcodes(`a [embed ref="${VIEW}"]body[/embed] b`).text).toBe("a  b");
    const other = `a [embed ref="${VIEW}" target="node_panel" /] b`;
    expect(extractCanvasShortcodes(other)).toEqual({ text: other, previews: [] });
  });

  it("findCodeRegions covers fences, inline spans and indented blocks", () => {
    expect(findCodeRegions("no code")).toEqual([]);
    expect(findCodeRegions("a `x` b")).toEqual([{ start: 2, end: 5 }]);
  });
});
