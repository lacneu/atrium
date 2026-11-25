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
import { findCodeRegions as bridgeCodeRegions } from "../../../bridge/src/providers/openclaw/code-regions";
import { findCodeRegions as spaCodeRegions } from "./codeRegions";
import { findShortcodes, markdownLink, renderablePieces, renderableText } from "./shortcodes";

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

  it("keeps a gateway-path URL shortcode and a non-view ref even when a widget is rendered", () => {
    const text = `See [embed url="/__openclaw__/canvas/documents/${OTHER}/index.html" /] and [embed ref="board-x" /].`;
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

const YT = "AbC123_-xyz";
const video = (startSeconds = 0, title?: string) => ({
  kind: "youtube" as const,
  videoId: YT,
  startSeconds,
  ...(title !== undefined ? { title } : {}),
});
const text = (value: string) => ({ kind: "text" as const, text: value });
/** Every shortcode-shaped thing a text renders as, for the tables below. */
const piecesOf = (value: string, streaming = false) => renderablePieces(value, new Set(), streaming);

describe("a YouTube shortcode becomes a video card (OpenClaw 2026.10.33)", () => {
  it("the form the system prompt teaches: the card stands where the shortcode was", () => {
    expect(
      piecesOf(`Here it is:\n\n[embed url="https://www.youtube.com/watch?v=${YT}" title="Video" /]\n\nEnjoy.`),
    ).toEqual([text("Here it is:\n\n"), video(0, "Video"), text("\n\nEnjoy.")]);
  });

  it.each([
    [`[embed url="https://youtu.be/${YT}?t=1m30s" /]`, video(90)],
    [`[embed url='https://www.youtube.com/shorts/${YT}' title='Short one' /]`, video(0, "Short one")],
    [`[EMBED URL="https://m.youtube.com/watch?v=${YT}" TITLE="Caps" /]`, video(0, "Caps")],
    [`[embed url="https://www.youtube-nocookie.com/embed/${YT}"]fallback[/embed]`, video()],
    [`[embed url="https://www.youtube.com/live/${YT}" target="assistant_message" /]`, video()],
    // Attributes the card does not read change nothing; a title is one line of text.
    [`[embed url="https://youtu.be/${YT}" height="9999" class="x" style="position:fixed" /]`, video()],
    [`[embed url="https://youtu.be/${YT}" title="  two\n lines " /]`, video(0, "two lines")],
    // `url` decides before `ref` (upstream: the preview's address is the url).
    [`[embed ref="${VIEW}" url="https://youtu.be/${YT}" /]`, video()],
  ])("%s", (shortcode, expected) => {
    expect(piecesOf(shortcode)).toEqual([text(""), expected, text("")]);
  });

  it("only an id and a start time leave the parser: nothing the agent wrote is carried", () => {
    const [, piece] = piecesOf(
      `[embed url="https://www.youtube.com/watch?v=${YT}&autoplay=1&origin=https://evil.example#x" title="T" /]`,
    );
    expect(Object.keys(piece!).sort()).toEqual(["kind", "startSeconds", "title", "videoId"]);
  });

  it("several videos, each at its place", () => {
    expect(piecesOf(`a [embed url="https://youtu.be/${YT}" /] b [embed url="https://youtu.be/${YT}?t=5" /] c`)).toEqual([
      text("a "),
      video(),
      text(" b "),
      video(5),
      text(" c"),
    ]);
  });

  it("a literal example in code stays text", () => {
    const fenced = `Use:\n\n\`\`\`\n[embed url="https://youtu.be/${YT}" /]\n\`\`\`\n`;
    const inline = `Write \`[embed url="https://youtu.be/${YT}" /]\` in your reply.`;
    expect(piecesOf(fenced)).toEqual([text(fenced)]);
    expect(piecesOf(inline)).toEqual([text(inline)]);
  });

  it("another surface than the message is not an embed here", () => {
    const side = `[embed url="https://youtu.be/${YT}" target="node_panel" /]`;
    expect(piecesOf(side)).toEqual([text(side)]);
  });

  it("streaming: nothing shows until the tag is whole, then the card appears at once", () => {
    const whole = `Look:\n\n[embed url="https://www.youtube.com/watch?v=${YT}" title="Video" /]`;
    for (let cut = "Look:\n\n".length + 1; cut < whole.length; cut++) {
      expect(piecesOf(whole.slice(0, cut), true), whole.slice(0, cut)).toEqual([text("Look:\n\n")]);
    }
    expect(piecesOf(whole, true)).toEqual([text("Look:\n\n"), video(0, "Video"), text("")]);
    // A block form waits for its closing tag.
    expect(piecesOf(`A [embed url="https://youtu.be/${YT}"]fall`, true)).toEqual([text("A ")]);
  });

  it("a work note cannot hold a card: the video reads as a link to its rebuilt watch page", () => {
    expect(
      renderableText(`See [embed url="https://youtu.be/${YT}?t=5&evil=1" title="Demo (1) *x*" /].`, new Set(), false),
    ).toBe(`See [Demo \\(1\\) \\*x\\*](<https://www.youtube.com/watch?v=${YT}&t=5>).`);
  });
});

describe("a URL the YouTube parser refuses is never framed", () => {
  it.each([
    // An absolute https address reads as a plain link (the serialized URL, the title as label).
    [
      `[embed url="https://example.test/x.html" title="A page" /]`,
      "[A page](<https://example.test/x.html>)",
    ],
    [`[embed url="https://example.test/x.html" /]`, "[https\\:\\/\\/example\\.test\\/x\\.html](<https://example.test/x.html>)"],
    // Look-alike hosts and non-video YouTube pages are links to what they really are.
    [
      `[embed url="https://youtube.com.evil.tld/watch?v=${YT}" title="Video" /]`,
      `[Video](<https://youtube.com.evil.tld/watch?v=${YT}>)`,
    ],
    [
      `[embed url="https://www.youtube.com/playlist?list=PL1" title="List" /]`,
      "[List](<https://www.youtube.com/playlist?list=PL1>)",
    ],
    [
      `[embed url="https://www.youtube.com/watch?v=${YT}toolong" title="Long id" /]`,
      `[Long id](<https://www.youtube.com/watch?v=${YT}toolong>)`,
    ],
    // A title cannot write Markdown or HTML, nor close the link early.
    [
      `[embed url="https://example.test/" title="x)(https://evil.example) <img src=x> **b**" /]`,
      "[x\\)\\(https\\:\\/\\/evil\\.example\\) \\<img src\\=x\\> \\*\\*b\\*\\*](<https://example.test/>)",
    ],
    // A destination cannot close itself: `>` and spaces are percent-encoded, `\` too.
    [
      `[embed url="https://example.test/a b>c?q=<x>&r=\\)" title="T" /]`,
      "[T](<https://example.test/a%20b%3Ec?q=%3Cx%3E&r=%5C)>)",
    ],
  ])("%s", (shortcode, expected) => {
    expect(piecesOf(shortcode)).toEqual([text(expected)]);
  });

  it.each([
    `[embed url="http://www.youtube.com/watch?v=${YT}" /]`,
    `[embed url="http://example.test/x.html" /]`,
    `[embed url="javascript:alert(1)" title="x" /]`,
    `[embed url="javascript://www.youtube.com/watch?v=${YT}" /]`,
    `[embed url="data:text/html,<script>1</script>" /]`,
    `[embed url="file:///etc/passwd" /]`,
    `[embed url="//example.test/x" /]`,
    `[embed url="/local/path" /]`,
    `[embed url="not a url" /]`,
    `[embed url="https://user:pw@example.test/" /]`,
    `[embed url="https://youtube.com@evil.example/watch?v=${YT}" /]`,
    // The gateway's own paths are a widget's, on any host.
    `[embed url="https://gw.example/__openclaw__/canvas/documents/${VIEW}/index.html" /]`,
    `[embed ref="${VIEW}" url="https://evil.test/__openclaw__/canvas/documents/${VIEW}/index.html" /]`,
    // Trapped attributes: unquoted, a quote closing early, a bracket inside, no url at all.
    `[embed url=https://youtu.be/${YT} /]`,
    `[embed url="https://example.test/" target="node_panel" /]`,
    `[embed src="https://youtu.be/${YT}" /]`,
    `[embed data-url="https://youtu.be/${YT}" /]`,
    `[embed title="https://youtu.be/${YT}" /]`,
    `[embed url="" title="x" /]`,
    `[embed /]`,
  ])("stays the text the agent wrote: %s", (shortcode) => {
    expect(piecesOf(shortcode)).toEqual([text(shortcode)]);
    expect(renderableText(shortcode, new Set([VIEW]), false)).toBe(shortcode);
  });

  it("an attribute cannot smuggle a second one past its own quotes", () => {
    // The first `url` closes at its quote; the rest is another attribute, and the LAST
    // `url` wins (upstream grammar) — still parsed, never taken verbatim.
    expect(piecesOf(`[embed url="https://youtu.be/${YT}" onload="x" url="https://evil.example/" /]`)).toEqual([
      text("[https\\:\\/\\/evil\\.example\\/](<https://evil.example/>)"),
    ]);
    // A `]` inside a value ends the tag early: no shortcode at all, the text stays.
    for (const broken of [
      `[embed url="https://youtu.be/${YT}?x=]" /]`,
      `[embed url="https://youtu.be/${YT}" title="x](https://evil.example)" /]`,
    ]) {
      expect(piecesOf(broken)).toEqual([text(broken)]);
    }
  });

  it("markdownLink escapes every ASCII punctuation mark of its label", () => {
    expect(markdownLink("https://e.test/", "a_b*c`d[e]f<g>h\\i!j")).toBe(
      "[a\\_b\\*c\\`d\\[e\\]f\\<g\\>h\\\\i\\!j](<https://e.test/>)",
    );
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
    // Codex review 4, finding 3 — CommonMark containers: a fence inside a block quote, an
    // indented block inside a list item, a tab-indented block. Literal examples all.
    `> ~~~text\n> [embed ref="${VIEW}" /]\n> ~~~`,
    `- Example\n\n      [embed ref="${VIEW}" /]`,
    `\t[embed ref="${VIEW}" /]`,
    `> quoted prose [embed ref="${OTHER}" /]`,
  ];

  it.each(CORPUS)("same code regions: %s", (text) => {
    expect(spaCodeRegions(text)).toEqual(bridgeCodeRegions(text));
  });

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

  it("a YouTube shortcode is a `data-youtube` part between the texts around it", () => {
    const msg = {
      ...base,
      text: `Watch:\n\n[embed url="https://www.youtube.com/watch?v=${YT}&t=90" title="Demo" /]\n\nBye.`,
    } as unknown as ConvexMessageView;
    expect(convertConvexMessage(msg).content).toEqual([
      { type: "text", text: "Watch:\n\n" },
      { type: "data-youtube", data: { videoId: YT, startSeconds: 90, title: "Demo" } },
      { type: "text", text: "\n\nBye." },
    ]);
  });

  it("a reply made only of a video is one part: no blank text around the card", () => {
    const msg = { ...base, text: `[embed url="https://youtu.be/${YT}" /]\n` } as unknown as ConvexMessageView;
    expect(convertConvexMessage(msg).content).toEqual([
      { type: "data-youtube", data: { videoId: YT, startSeconds: 0 } },
    ]);
  });

  it("a streaming reply shows no part for a video until its tag is whole", () => {
    const half = { ...base, status: "streaming", text: `Watch:\n\n[embed url="https://www.youtube.com/watch?v=${YT}` };
    expect(convertConvexMessage(half as unknown as ConvexMessageView).content).toEqual([{ type: "text", text: "Watch:\n\n" }]);
    const whole = { ...half, text: `${half.text}" /]` };
    expect(convertConvexMessage(whole as unknown as ConvexMessageView).content).toEqual([
      { type: "text", text: "Watch:\n\n" },
      { type: "data-youtube", data: { videoId: YT, startSeconds: 0 } },
    ]);
  });

  it("a user's own message keeps the shortcode it typed", () => {
    const typed = `[embed url="https://youtu.be/${YT}" /]`;
    const msg = { ...base, role: "user", text: typed } as unknown as ConvexMessageView;
    expect(convertConvexMessage(msg).content).toEqual([{ type: "text", text: typed }]);
  });

  it("a streaming reply holds back its half-typed tag", () => {
    const msg = { ...base, status: "streaming", text: `Tiny counter:\n\n[embed ref="cv` } as unknown as ConvexMessageView;
    expect(textOf(msg)).toBe("Tiny counter:\n\n");
  });
});
