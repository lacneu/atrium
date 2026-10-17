// THE WIDGETS A ROW NAMES (projection `on`): the Control UI's reading of a history row's
// canvas content, ported test by test (v2026.9.33), mapped onto Atrium's widget blocks.
//   upstream `{type:"canvas", preview:{viewId, url:"/__openclaw__/canvas/documents/<id>/…"}}`
//     → `{type:"widget", viewId, title?, preferredHeight?, origin}` — origin = the carrier.
// Atrium keeps the text as sent: the `[embed]` shortcode is hidden by the SPA beside the
// widget part (src/chat/widgets/shortcodes.ts), where upstream strips it from the text item.
// What Atrium does not render (widgets.ts `widgetFromPreview`: MCP Apps, strict previews,
// node panels, unmanaged URLs) is no widget block.

import { describe, expect, it } from "vitest";

import { rowBlocks } from "../src/providers/openclaw/row-blocks.js";

const SK = "agent:main:main";
const blocks = (message: unknown) => rowBlocks(message, SK).blocks;
const widgetsOf = (message: unknown) => blocks(message).filter((b) => b.type === "widget");
const doc = (id: string) => `/__openclaw__/canvas/documents/${id}/index.html`;

describe("ui/src/lib/chat/message-normalizer.test.ts (v2026.9.33) — canvas", () => {
  // :364
  it("expands [embed] shortcodes into canvas blocks", () => {
    expect(blocks({ role: "assistant", content: 'Here.\n[embed ref="cv_status" title="Status" height="320" /]' })).toEqual([
      { type: "text", text: 'Here.\n[embed ref="cv_status" title="Status" height="320" /]' },
      { type: "widget", viewId: "cv_status", title: "Status", preferredHeight: 320, origin: "shortcode" },
    ]);
  });

  // :410 — with a `scripts` preview: a `strict` one is never served by `canvas.document.view`
  // (widgets.ts), so Atrium shows none.
  it("keeps the canonical Canvas block instead of its shortcode copy", () => {
    const out = widgetsOf({
      role: "assistant",
      content: [
        { type: "text", text: 'Ready.\n[embed ref="cv_widget" title="Widget" /]' },
        {
          type: "canvas",
          preview: { kind: "canvas", surface: "assistant_message", render: "url", viewId: "cv_widget", url: doc("cv_widget"), title: "Canonical", sandbox: "scripts" },
          rawText: "original tool result",
        },
      ],
    });
    expect(out).toEqual([{ type: "widget", viewId: "cv_widget", title: "Canonical", origin: "canvas" }]);
  });

  // :473
  it("ignores [embed] shortcodes inside fenced code blocks", () => {
    expect(widgetsOf({ role: "assistant", content: '```text\n[embed ref="cv_status" /]\n```' })).toEqual([]);
  });

  // :487
  it("leaves block-form inline html embed shortcodes as plain text", () => {
    const content = '[embed content_type="html" title="Status"]\n<div>Ready</div>\n[/embed]';
    expect(blocks({ role: "assistant", content })).toEqual([{ type: "text", text: content }]);
  });
});

describe("src/gateway/chat-display-projection.canvas.test.ts (v2026.9.33) — what the history row carries", () => {
  // The canvas blocks `augmentChatHistoryWithCanvasBlocks` appends to the assistant row: a
  // managed document is a widget (origin `canvas`); an unmanaged URL and an MCP App are not.
  it("the appended canvas blocks of a history row", () => {
    const out = widgetsOf({
      role: "assistant",
      content: [
        { type: "text", text: "Canvas results" },
        { type: "canvas", preview: { kind: "canvas", surface: "assistant_message", render: "url", viewId: "cv_first", url: doc("cv_first") }, rawText: "{}" },
        { type: "canvas", preview: { kind: "canvas", surface: "assistant_message", render: "url", url: "/url-only" }, rawText: "{}" },
        { type: "canvas", preview: { kind: "canvas", surface: "assistant_message", render: "url", viewId: "app", mcpApp: { viewId: "app" } }, rawText: null },
      ],
    });
    expect(out).toEqual([{ type: "widget", viewId: "cv_first", origin: "canvas" }]);
  });

  // The tool result the blocks come from (`content: JSON.stringify({kind:"canvas", view})`):
  // only a `show_widget` result is the PROOF (origin `tool`); any other tool's canvas-shaped
  // text — upstream projects it all the same — names no widget here.
  it("a show_widget result row is the proof; another tool's canvas-shaped text is none", () => {
    const result = (toolName: string) => ({
      role: "toolResult",
      toolCallId: "c1",
      toolName,
      content: JSON.stringify({ kind: "canvas", view: { id: "cv_made", url: doc("cv_made") }, presentation: { target: "assistant_message", title: "Made", sandbox: "scripts" } }),
    });
    expect(widgetsOf(result("show_widget"))).toEqual([{ type: "widget", viewId: "cv_made", title: "Made", origin: "tool" }]);
    expect(widgetsOf(result("canvas"))).toEqual([]);
    expect(widgetsOf(result("exec"))).toEqual([]);
    expect(widgetsOf({ ...result("show_widget"), isError: true })).toEqual([]);
  });

  it("a nested code-mode show_widget result is the proof too; widget blocks come last (file indexes keep)", () => {
    const out = blocks({
      role: "toolResult",
      toolCallId: "tool_search_code:outer:show_widget:1",
      toolName: "tool_search_code",
      content: [
        { type: "text", text: JSON.stringify({ kind: "canvas", view: { id: "cv_nested", url: doc("cv_nested") } }) },
        { type: "image", artifactId: "artifact_managed_image_1", url: "/x/full", mimeType: "image/png" },
      ],
    });
    expect(out.map((b) => b.type)).toEqual(["tool", "file", "widget"]);
    expect(out[2]).toMatchObject({ viewId: "cv_nested", origin: "tool" });
  });
});

// A `show_widget` run nested in code mode, in the exact shape chat.history returns it at
// v2026.9.33: `prepareChatHistoryRecoveryMessages` (src/gateway/chat-display-projection.core.ts
// :424-459) keeps the `custom` / `openclaw.nested-tool.v1` row and replaces its content with
// `[call, sanitized result]` (`nestedToolActivityContent`, src/sessions/nested-tool-activity.ts
// :73-87: the call's fields spread into the result, `type:"toolResult"`).
const nestedShowWidgetRow = (viewId: string, runId = "run-code") => ({
  role: "custom",
  customType: "openclaw.nested-tool.v1",
  display: true,
  excludeFromContext: true,
  runId,
  details: {
    runId,
    scopeId: "scope-1",
    afterEntryId: null,
    startOrder: 0,
    parentToolCallId: "tool_search_code:outer",
    toolCallId: "tool_search_code:outer:show_widget:1",
    toolName: "show_widget",
    input: { html: "<p>x</p>" },
    result: { content: [{ type: "text", text: JSON.stringify({ kind: "canvas", view: { id: viewId, url: doc(viewId) }, presentation: { target: "assistant_message", title: "Code", sandbox: "scripts" } }) }] },
    isError: false,
    startedAt: 1,
    timestamp: 2,
  },
  timestamp: 1,
  content: [
    { type: "toolCall", id: "tool_search_code:outer:show_widget:1", runId, name: "show_widget", arguments: { html: "<p>x</p>" }, parentToolCallId: "tool_search_code:outer", timestamp: 1 },
    {
      runId,
      scopeId: "scope-1",
      afterEntryId: null,
      startOrder: 0,
      parentToolCallId: "tool_search_code:outer",
      toolCallId: "tool_search_code:outer:show_widget:1",
      toolName: "show_widget",
      isError: false,
      startedAt: 1,
      timestamp: 2,
      content: [{ type: "text", text: JSON.stringify({ kind: "canvas", view: { id: viewId, url: doc(viewId) }, presentation: { target: "assistant_message", title: "Code", sandbox: "scripts" } }) }],
      type: "toolResult",
      role: "toolResult",
    },
  ],
  __openclaw: { id: "nested-1", seq: 4, runId },
});

describe("a show_widget nested in code mode (codex review 4, finding 1)", () => {
  it("its history row is the proof: tool cards, then the widget (origin tool)", () => {
    expect(blocks(nestedShowWidgetRow("cv_code"))).toEqual([
      expect.objectContaining({ type: "tool", toolCallId: "tool_search_code:outer:show_widget:1", name: "show_widget", status: "call", input: { html: "<p>x</p>" } }),
      expect.objectContaining({ type: "tool", toolCallId: "tool_search_code:outer:show_widget:1", name: "show_widget", status: "result", output: expect.objectContaining({ content: expect.any(Array) }) }),
      { type: "widget", viewId: "cv_code", title: "Code", origin: "tool" },
    ]);
  });
  it("an erroring nested call, or another nested tool, names no widget", () => {
    const row = nestedShowWidgetRow("cv_code");
    const failed = { ...row, content: [row.content[0], { ...row.content[1], isError: true }] };
    expect(widgetsOf(failed)).toEqual([]);
    const other = { ...row, content: [row.content[0], { ...row.content[1], toolName: "exec" }] };
    expect(widgetsOf(other)).toEqual([]);
  });
});
