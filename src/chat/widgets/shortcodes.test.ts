// Render-time `[embed]` handling: a shortcode is hidden only beside the widget part it
// names, everything else stays readable, and the SPA reads shortcodes exactly as the
// bridge does (parity with the bridge port of upstream `extractCanvasShortcodes`).
import { describe, expect, it } from "vitest";

import {
  extractCanvasShortcodes,
  widgetFromPreview,
} from "../../../bridge/src/providers/openclaw/widgets";
import { convertConvexMessage } from "../convertMessage";
import type { ConvexMessageView } from "../convexTypes";
import { findShortcodes, renderableText } from "./shortcodes";

const VIEW = "cv_87c3b1326a2c47028d93b4c38e242832";
const OTHER = "cv_0000000000000000000000000000000a";
const FINAL = `Tiny counter:\n\n[embed ref="${VIEW}" title="Counter" height="90" /]\n\nTOOLS: show_widget, canvas`;

describe("renderableText", () => {
  it("hides the shortcode of a view the message renders", () => {
    expect(renderableText(FINAL, new Set([VIEW]), false)).toBe(
      "Tiny counter:\n\n\n\nTOOLS: show_widget, canvas",
    );
  });

  it("keeps a shortcode whose view the message does NOT render (unregistered, refused, widgets off)", () => {
    expect(renderableText(FINAL, new Set(), false)).toBe(FINAL);
    expect(renderableText(FINAL, new Set([OTHER]), false)).toBe(FINAL);
  });

  it("keeps a URL shortcode and a non-view ref even when a widget is rendered", () => {
    const text = `See [embed url="https://example.test/x.html" /] and [embed ref="board-x" /].`;
    expect(renderableText(text, new Set([VIEW, "board-x"]), false)).toBe(text);
  });

  it("keeps a literal example in code", () => {
    const fenced = `Use it like this:\n\n\`\`\`\n[embed ref="${VIEW}" /]\n\`\`\`\n`;
    const inline = `Write \`[embed ref="${VIEW}" /]\` in your reply.`;
    expect(renderableText(fenced, new Set([VIEW]), false)).toBe(fenced);
    expect(renderableText(inline, new Set([VIEW]), false)).toBe(inline);
  });

  it("hides a block shortcode whole", () => {
    const text = `A [embed ref="${VIEW}"]fallback[/embed] B`;
    expect(renderableText(text, new Set([VIEW]), false)).toBe("A  B");
  });

  it("streaming: a half-typed tag is held back, then the finished one is decided by the part", () => {
    const partial = `Tiny counter:\n\n[embed ref="cv`;
    expect(renderableText(partial, new Set(), true)).toBe("Tiny counter:\n\n");
    expect(renderableText("Tiny counter:\n\n[emb", new Set(), true)).toBe("Tiny counter:\n\n");
    expect(renderableText(`A [embed ref="${VIEW}"]fallb`, new Set(), true)).toBe("A ");
    // Settled, or a complete tag: nothing held back.
    expect(renderableText(partial, new Set(), false)).toBe(partial);
    expect(renderableText(FINAL, new Set(), true)).toBe(FINAL);
    expect(renderableText(FINAL, new Set([VIEW]), true)).toBe(
      "Tiny counter:\n\n\n\nTOOLS: show_widget, canvas",
    );
  });

  it("streaming never holds back a bracket inside code", () => {
    // An unclosed backtick is not (yet) code: the tail is held back.
    expect(renderableText("Use `[emb", new Set(), true)).toBe("Use `");
    const closed = "Example:\n\n```\n[emb";
    expect(renderableText(closed, new Set(), true)).toBe(closed);
  });
});

describe("parity with the bridge (the SPA reads the shortcodes the bridge reads)", () => {
  const CORPUS = [
    FINAL,
    `[embed ref="${VIEW}" /]`,
    `A [embed ref="${VIEW}"]x[/embed] and [embed ref="${OTHER}" target="assistant_message" /]`,
    `[embed ref="${VIEW}" target="node_panel" /]`,
    `[embed ref="${VIEW}" url="https://evil.test/__openclaw__/canvas/documents/${VIEW}/index.html" /]`,
    `[embed ref="${VIEW}" url="/__openclaw__/canvas/documents/${OTHER}/index.html" /]`,
    `[embed ref="${VIEW}" url="/__openclaw__/canvas/documents/${VIEW}/index.html" /]`,
    `[embed url="https://example.test/x.html" /]`,
    `[embed ref="board-x" /]`,
    `\`\`\`\n[embed ref="${VIEW}" /]\n\`\`\`\n[embed ref="${OTHER}" /]`,
    `    [embed ref="${VIEW}" /]`,
    `para\n\n    [embed ref="${VIEW}" /]\n\nafter [embed ref='${OTHER}' /]`,
    `[EMBED REF="${VIEW}" /]`,
    `[embed ref="${VIEW}" /][embed ref="${VIEW}" /]`,
    `no shortcode at all`,
  ];

  it.each(CORPUS)("same views named: %s", (text) => {
    const bridge = extractCanvasShortcodes(text)
      .previews.map((p) => widgetFromPreview(p))
      .flatMap((v) => (v.ok ? [v.widget.viewId] : []));
    const spa = findShortcodes(text).flatMap((s) => (s.viewId ? [s.viewId] : []));
    expect(spa).toEqual(bridge);
  });
});

describe("convertConvexMessage applies the rule per message", () => {
  const base = {
    _id: "m1",
    _creationTime: 1,
    chatId: "c1",
    role: "assistant",
    text: FINAL,
    status: "complete",
    parts: [],
  } as unknown as ConvexMessageView;
  const textOf = (msg: ConvexMessageView) =>
    (convertConvexMessage(msg).content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

  it("with the matching widget part: shortcode hidden, widget rendered", () => {
    const msg = { ...base, parts: [{ kind: "widget", viewId: VIEW, order: 1 }] } as unknown as ConvexMessageView;
    expect(textOf(msg)).toBe("Tiny counter:\n\n\n\nTOOLS: show_widget, canvas");
  });

  it("without it: the shortcode stays visible text", () => {
    expect(textOf(base)).toBe(FINAL);
  });

  it("a user message is never touched", () => {
    const msg = { ...base, role: "user", parts: [{ kind: "widget", viewId: VIEW, order: 1 }] } as unknown as ConvexMessageView;
    expect(textOf(msg)).toBe(FINAL);
  });

  it("a streaming reply holds back its half-typed tag", () => {
    const msg = { ...base, status: "streaming", text: `Tiny counter:\n\n[embed ref="cv` } as unknown as ConvexMessageView;
    expect(textOf(msg)).toBe("Tiny counter:\n\n");
  });
});
