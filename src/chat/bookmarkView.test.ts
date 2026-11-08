import { describe, expect, it } from "vitest";
import {
  anchorElement,
  blockFace,
  blockPrint,
  collectAnchorBlocks,
  nearestBookmarkId,
  previewFromText,
  nextBookmarkId,
  orderBookmarks,
  type BookmarkView,
} from "./bookmarkView";

// Pure-logic tests for the bookmark navigation rules. Discriminating
// properties: thread-position ordering (NOT creation order), the wrap-around
// ring, out-of-window bookmarks counted (never silently dropped), and the
// meta-chrome exclusion in DOM block collection.

function bm(overrides: Partial<BookmarkView> = {}): BookmarkView {
  return {
    id: "b1",
    messageId: "m1",
    blockIndex: null,
    label: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("orderBookmarks", () => {
  it("orders by thread position, then block index (message-level first), then createdAt", () => {
    const order = new Map([
      ["mA", 0],
      ["mB", 5],
    ]);
    const rows = [
      bm({ id: "late-block", messageId: "mB", blockIndex: 7, createdAt: 1 }),
      bm({ id: "msg-level", messageId: "mB", blockIndex: null, createdAt: 9 }),
      bm({ id: "early-block", messageId: "mB", blockIndex: 2, createdAt: 5 }),
      bm({ id: "first-msg", messageId: "mA", blockIndex: 40, createdAt: 99 }),
    ];
    const { ordered, unreachableCount } = orderBookmarks(rows, order);
    expect(ordered.map((r) => r.id)).toEqual([
      "first-msg", // thread position wins over every block index
      "msg-level", // whole-message anchor before any block of the same message
      "early-block",
      "late-block",
    ]);
    expect(unreachableCount).toBe(0);
  });

  it("counts bookmarks whose message left the visible window instead of dropping them silently", () => {
    const order = new Map([["mA", 0]]);
    const rows = [
      bm({ id: "in", messageId: "mA" }),
      bm({ id: "out", messageId: "evicted" }),
    ];
    const { ordered, unreachableCount } = orderBookmarks(rows, order);
    expect(ordered.map((r) => r.id)).toEqual(["in"]);
    expect(unreachableCount).toBe(1);
  });
});

describe("nextBookmarkId", () => {
  const ids = ["a", "b", "c"];
  it("wraps around in both directions", () => {
    expect(nextBookmarkId(ids, "c", 1)).toBe("a");
    expect(nextBookmarkId(ids, "a", -1)).toBe("c");
    expect(nextBookmarkId(ids, "a", 1)).toBe("b");
  });
  it("enters the ring at first/last when there is no current bookmark", () => {
    expect(nextBookmarkId(ids, null, 1)).toBe("a");
    expect(nextBookmarkId(ids, null, -1)).toBe("c");
  });
  it("re-enters the ring when the current bookmark vanished (deleted)", () => {
    expect(nextBookmarkId(ids, "deleted", 1)).toBe("a");
  });
  it("returns null on an empty ring", () => {
    expect(nextBookmarkId([], null, 1)).toBeNull();
  });
});

describe("collectAnchorBlocks / anchorElement", () => {
  // The repo test env is edge-runtime (no DOM): a minimal structural stub of
  // the THREE Element APIs the helpers use (querySelectorAll(".oc-md"),
  // closest(".oc-msg__meta"), children) keeps the logic testable without
  // adding jsdom. Selectors are fixed strings in the helpers, so the stub
  // matches by class name only.
  interface FakeEl {
    tagName: string;
    className: string;
    children: FakeEl[];
    parent: FakeEl | null;
    textContent: string;
    querySelectorAll(sel: string): FakeEl[];
    closest(sel: string): FakeEl | null;
  }
  function el(
    tagName: string,
    className: string,
    children: FakeEl[] = [],
    textContent = "",
  ): FakeEl {
    const node: FakeEl = {
      tagName,
      className,
      children,
      parent: null,
      textContent,
      querySelectorAll(sel: string) {
        const cls = sel.slice(1);
        const found: FakeEl[] = [];
        const walk = (n: FakeEl) => {
          for (const c of n.children) {
            if (c.className.split(" ").includes(cls)) found.push(c);
            walk(c);
          }
        };
        walk(node);
        return found;
      },
      closest(sel: string) {
        const cls = sel.slice(1);
        let cur: FakeEl | null = node;
        while (cur !== null) {
          if (cur.className.split(" ").includes(cls)) return cur;
          cur = cur.parent;
        }
        return null;
      },
    };
    for (const c of children) c.parent = node;
    return node;
  }
  const asEl = (n: FakeEl) => n as unknown as Element;

  it("collects top-level markdown blocks and EXCLUDES the meta chrome's own markdown", () => {
    const bubble = el("DIV", "oc-msg__body", [
      el("DIV", "oc-msg__meta", [
        el("DIV", "oc-md", [el("P", "", [], "sub-agent result")]),
      ]),
      el("DIV", "oc-md", [
        el("H2", "", [], "title"),
        el("P", "", [], "para"),
        el("PRE", "", [], "code"),
      ]),
    ]);
    const blocks = collectAnchorBlocks(asEl(bubble));
    expect(blocks.map((b) => b.tagName)).toEqual(["H2", "P", "PRE"]);
  });

  it("descends ONE level into lists: each top-level <li> is an anchorable block", () => {
    const bubble = el("DIV", "oc-msg__body", [
      el("DIV", "oc-md", [
        el("P", "", [], "intro"),
        el("OL", "", [
          el("LI", "", [], "item 1"),
          el("LI", "", [el("UL", "", [el("LI", "", [], "nested")])], "item 2"),
          el("LI", "", [], "item 3"),
        ]),
        el("P", "", [], "outro"),
      ]),
    ]);
    const blocks = collectAnchorBlocks(asEl(bubble));
    // intro, the 3 top-level items (nested list stays inside its item), outro.
    expect(blocks.map((b) => b.textContent)).toEqual([
      "intro",
      "item 1",
      "item 2",
      "item 3",
      "outro",
    ]);
  });

  it("anchorElement resolves the block, falls back to the bubble on a vanished index or message-level anchor", () => {
    const bubble = el("DIV", "oc-msg__body", [
      el("DIV", "oc-md", [el("P", "", [], "one"), el("P", "", [], "two")]),
    ]);
    expect(anchorElement(asEl(bubble), 1).textContent).toBe("two");
    expect(anchorElement(asEl(bubble), null)).toBe(asEl(bubble));
    expect(anchorElement(asEl(bubble), 99)).toBe(asEl(bubble)); // regenerated shorter message
  });
});

describe("nearestBookmarkId", () => {
  it("picks the anchor closest to the viewport center, null when empty", () => {
    const items = [
      { id: "a", center: 100 },
      { id: "b", center: 480 },
      { id: "c", center: 900 },
    ];
    expect(nearestBookmarkId(items, 500)).toBe("b");
    expect(nearestBookmarkId(items, 60)).toBe("a");
    expect(nearestBookmarkId(items, 5000)).toBe("c");
    expect(nearestBookmarkId([], 500)).toBeNull();
  });
});

describe("previewFromText", () => {
  it("collapses whitespace and truncates at a word boundary with an ellipsis", () => {
    expect(previewFromText("Microsoft   lance\n\u201cFrontier Company\u201d")).toBe(
      "Microsoft lance \u201cFrontier Company\u201d",
    );
    const long = "Anthropic discuterait avec Samsung pour fabriquer une puce IA maison";
    const out = previewFromText(long, 48);
    expect(out.length).toBeLessThanOrEqual(49);
    expect(out.endsWith("\u2026")).toBe(true);
    expect(out).toBe("Anthropic discuterait avec Samsung pour\u2026");
  });
});

// A structural stand-in for the DOM the renderer (Streamdown) produces — the APIs
// blockFace and blockPrint read: the tag, the attributes, the child nodes (elements
// and texts), the parent, the text, matches()/querySelector(All)() by a list of TAGS,
// and an input's `checked` property. The repo test env is edge-runtime (no DOM).
type Spec = { tag: string; attrs: Record<string, string>; kids: Array<Spec | string>; checked?: boolean };
const h = (tag: string, attrs: Record<string, string> = {}, ...kids: Array<Spec | string>): Spec => ({ tag, attrs, kids });
const tagList = (sel: string) => sel.split(",").map((t) => t.trim().toUpperCase());
class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: Array<FakeElement | { nodeType: 3; nodeValue: string }>;
  constructor(
    private readonly spec: Spec,
    readonly parentElement: FakeElement | null = null,
  ) {
    this.tagName = spec.tag.toUpperCase();
    this.childNodes = spec.kids.map((k) =>
      typeof k === "string" ? { nodeType: 3 as const, nodeValue: k } : new FakeElement(k, this),
    );
  }
  get checked() {
    return this.spec.checked ?? false;
  }
  get textContent(): string {
    return this.childNodes.map((n) => (n instanceof FakeElement ? n.textContent : n.nodeValue)).join("");
  }
  getAttributeNames() {
    return Object.keys(this.spec.attrs);
  }
  getAttribute(name: string) {
    return this.spec.attrs[name] ?? null;
  }
  private descendants(): FakeElement[] {
    return this.childNodes.flatMap((n) => (n instanceof FakeElement ? [n, ...n.descendants()] : []));
  }
  matches(sel: string) {
    return tagList(sel).includes(this.tagName);
  }
  querySelectorAll(sel: string) {
    return this.descendants().filter((n) => n.matches(sel));
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}
const dom = (spec: Spec) => new FakeElement(spec) as unknown as Element;
/** A list's items, each a block of its own (collectAnchorBlocks descends lists). */
const items = (list: Spec) => (new FakeElement(list).childNodes as unknown as Element[]).filter((n) => n.nodeType === 1);
const look = (face: ReturnType<typeof blockFace>) => ({ text: face.text, alt: face.alt, media: face.media });

describe("blockFace — what a block shows a reader (lot 21)", () => {
  it("a text block: its text, no media", () => {
    expect(look(blockFace(dom(h("p", {}, "Bonjour."))))).toEqual({ text: "Bonjour.", alt: "", media: false });
  });

  it("a loaded image: no text, its alt text, media", () => {
    const wrapper = h("div", {}, h("img", { alt: "Schéma du scénario B" }), h("button"));
    expect(look(blockFace(dom(wrapper)))).toEqual({ text: "", alt: "Schéma du scénario B", media: true });
  });

  it("an image without alt text is still media; an image block itself reads its own alt", () => {
    expect(look(blockFace(dom(h("div", {}, h("img", { alt: "" })))))).toEqual({ text: "", alt: "", media: true });
    expect(look(blockFace(dom(h("img", { alt: "Logo" }))))).toEqual({ text: "", alt: "Logo", media: true });
  });

  it("several images: their alt texts joined, the empty ones left out", () => {
    const row = h("p", {}, h("img", { alt: "Un" }), h("img", { alt: " " }), h("img", { alt: "Deux" }));
    expect(blockFace(dom(row)).alt).toBe("Un, Deux");
  });

  it("a rule shows nothing", () => {
    expect(look(blockFace(dom(h("hr"))))).toEqual({ text: "", alt: "", media: false });
  });

  it("its print is the block's exact print (lot 23)", () => {
    const block = dom(h("p", {}, "Conclusion : le scénario retenu est B."));
    expect(blockFace(block).print).toBe(blockPrint(block));
  });
});

// LOT 23: the block a person chose is found again by its print (resolveChosen), so two
// blocks that differ must never share one. The two collisions Codex named are pinned
// first, then every field the print covers, then every field it leaves out — each with
// its reason, in blockPrint's own comment.
describe("blockPrint — a block's exact identity (lot 23)", () => {
  // The blocks as Streamdown renders them (its markers, classes, styles and controls).
  const imageBlock = (src: string, alt = "", extra: Array<Spec | string> = []) =>
    h(
      "div",
      { class: "group relative my-4 inline-block", "data-streamdown": "image-wrapper" },
      h("img", { alt, class: "max-w-full rounded-lg", "data-streamdown": "image", src }),
      ...extra,
      h("div", { class: "pointer-events-none absolute inset-0", "data-streamdown": "image-overlay" }),
      h("button", { class: "absolute right-2 bottom-2", title: "Download image", type: "button" }, h("svg", { "aria-hidden": "true" }, h("path", { d: "M8 1v9" }))),
    );
  const codeBlock = (language: string, lines: string[], copy = "Copy Code") =>
    h(
      "div",
      { "data-language": language, "data-streamdown": "code-block", dir: "ltr", style: "content-visibility: auto;" },
      h("div", { "data-language": language, "data-streamdown": "code-block-header" }, h("span", { class: "ml-1 font-mono" }, language)),
      h("div", {}, h("div", { "data-streamdown": "code-block-actions" }, h("button", { "aria-label": copy, title: copy, type: "button" }, h("svg", {})))),
      h(
        "div",
        { "data-language": language, "data-streamdown": "code-block-body", style: "max-height: 400px;" },
        h("pre", { style: "--sdm-bg: transparent;" }, h("code", {}, ...lines.map((line) => h("span", { class: "block" }, h("span", { style: "--sdm-c: inherit;" }, line))))),
      ),
    );
  const print = (spec: Spec) => blockPrint(dom(spec));
  /** The print lot 22 used: the text with its whitespace collapsed, or the alt text. */
  const lot22 = (spec: Spec) => {
    const face = blockFace(dom(spec));
    const text = face.text.replace(/\s+/g, " ").trim();
    return text !== "" ? `text:${text}` : face.media ? `media:${face.alt.trim()}` : "";
  };

  it("an image without alt text replaced by another: another block — the address is the image's identity", () => {
    const schema = imageBlock("https://cdn.example/schema-b.png");
    const other = imageBlock("https://cdn.example/organigramme.png");
    expect(lot22(schema)).toBe(lot22(other)); // the collision: "media:" for both
    expect(print(schema)).not.toBe(print(other));
    expect(print(schema)).toBe(print(imageBlock("https://cdn.example/schema-b.png")));
  });

  it("a code line's indentation is its meaning: send(x) taken out of the if is another block", () => {
    const inside = codeBlock("python", ["for x in items:", "    if ok(x):", "        log(x)", "        send(x)"]);
    const outside = codeBlock("python", ["for x in items:", "    if ok(x):", "        log(x)", "    send(x)"]);
    expect(lot22(inside)).toBe(lot22(outside)); // the collision: spaces collapsed
    expect(print(inside)).not.toBe(print(outside));
  });

  it("a code's lines are its lines: the same characters on other lines are another code", () => {
    // The renderer draws each line as an element, with no newline between them: the
    // text alone reads "ab" for both.
    expect(dom(codeBlock("txt", ["ab"])).textContent).toBe(dom(codeBlock("txt", ["a", "b"])).textContent);
    expect(print(codeBlock("txt", ["ab"]))).not.toBe(print(codeBlock("txt", ["a", "b"])));
  });

  const strong = (t: string) => h("span", { class: "font-semibold", "data-streamdown": "strong" }, t);
  const link = (href: string, t: string, title?: string) =>
    h("a", { class: "font-medium text-primary underline", href, rel: "noopener noreferrer", target: "_blank", ...(title ? { title } : {}) }, t);
  const table = (...rows: Spec[]) =>
    h("div", { "data-streamdown": "table-wrapper" }, h("table", { "data-streamdown": "table" }, h("tbody", { "data-streamdown": "table-body" }, ...rows)));
  const tr = (...cells: Spec[]) => h("tr", { "data-streamdown": "table-row" }, ...cells);
  const td = (t: string, attrs: Record<string, string> = {}) => h("td", { "data-streamdown": "table-cell", ...attrs }, t);
  const task = (checked: boolean) => ({ ...h("input", { disabled: "", type: "checkbox" }), checked });

  // [what differs, one block, the other]: the print tells them apart.
  const covered: Array<[string, Element, Element]> = [
    ["whitespace inside a text, exactly", dom(h("p", {}, "Deux espaces")), dom(h("p", {}, "Deux  espaces"))],
    ["a line break inside a text", dom(h("p", {}, "Deux\nlignes")), dom(h("p", {}, "Deux lignes"))],
    ["case", dom(h("p", {}, "Scénario B")), dom(h("p", {}, "scénario B"))],
    ["the Unicode form of a letter", dom(h("p", {}, "Scénario")), dom(h("p", {}, "Scénario"))],
    ["a heading or a paragraph", dom(h("h2", { "data-streamdown": "heading-2" }, "Conclusion")), dom(h("p", {}, "Conclusion"))],
    ["a heading's level", dom(h("h2", { "data-streamdown": "heading-2" }, "Conclusion")), dom(h("h3", { "data-streamdown": "heading-3" }, "Conclusion"))],
    ["a list item's list, numbered or not", items(h("ol", {}, h("li", {}, "Valider")))[0]!, items(h("ul", {}, h("li", {}, "Valider")))[0]!],
    ["a list item's number, when the reply sets it", items(h("ol", {}, h("li", { value: "5" }, "Valider")))[0]!, items(h("ol", {}, h("li", {}, "Valider")))[0]!],
    ["bold", dom(h("p", {}, "B est ", strong("retenu"))), dom(h("p", {}, "B est retenu"))],
    // The renderer's own name for what it drew: bold and a file name the app shows as
    // plain text (AgentAnchor) are both a span.
    ["bold, or a file name shown as text", dom(h("p", {}, "Voir ", strong("rapport.pdf"))), dom(h("p", {}, "Voir ", h("span", {}, "rapport.pdf")))],
    ["struck through", dom(h("p", {}, "B est ", h("del", {}, "retenu"))), dom(h("p", {}, "B est retenu"))],
    ["inline code", dom(h("p", {}, h("code", { "data-streamdown": "inline-code" }, "send"))), dom(h("p", {}, "send"))],
    ["a hard line break", dom(h("p", {}, "a", h("br"), "b")), dom(h("p", {}, "ab"))],
    ["a link's target", dom(h("p", {}, link("https://a.example/doc", "la doc"))), dom(h("p", {}, link("https://b.example/doc", "la doc")))],
    ["a link's title", dom(h("p", {}, link("https://a.example/doc", "la doc", "v1"))), dom(h("p", {}, link("https://a.example/doc", "la doc", "v2")))],
    ["an image's alt text", dom(imageBlock("https://cdn.example/a.png", "Schéma")), dom(imageBlock("https://cdn.example/a.png", "Plan"))],
    ["an image's size, when the reply sets it", dom(h("p", {}, h("img", { src: "a.png", width: "120" }))), dom(h("p", {}, h("img", { src: "a.png", width: "480" })))],
    ["a picture's other sources", dom(h("picture", {}, h("source", { srcset: "a.webp" }), h("img", { src: "a.png" }))), dom(h("picture", {}, h("source", { srcset: "b.webp" }), h("img", { src: "a.png" })))],
    ["a code block's language", dom(codeBlock("js", ["send();"])), dom(codeBlock("ts", ["send();"]))],
    ["a task box ticked or not", items(h("ul", {}, h("li", {}, task(true), " Valider")))[0]!, items(h("ul", {}, h("li", {}, task(false), " Valider")))[0]!],
    ["the cell a text sits in", dom(table(tr(td("a"), td("b")))), dom(table(tr(td("ab"))))],
    ["a cell's span", dom(table(tr(td("total", { colspan: "2" })))), dom(table(tr(td("total"))))],
    ["a header cell or a cell", dom(table(tr(h("th", {}, "Coût")))), dom(table(tr(h("td", {}, "Coût"))))],
  ];
  it.each(covered)("covered — %s: two prints", (_what, one, other) => {
    expect(blockPrint(one)).not.toBe(blockPrint(other));
  });

  // [what differs, one block, the other]: the same print — none of it is what the block
  // says, and each changes while the block does not.
  const ignored: Array<[string, Element, Element]> = [
    ["class: a jump's flash on the block", dom(h("p", { class: "oc-anchor--flash" }, "Conclusion")), dom(h("p", {}, "Conclusion"))],
    ["style: a height that follows the screen", dom(h("div", { style: "max-height: 400px;" }, "x")), dom(h("div", { style: "max-height: 220px;" }, "x"))],
    // A GFM column's alignment (`---:`) reaches the page as a style on its cells.
    ["style: a column's alignment, where words sit, not what they say", dom(table(tr(td("12", { style: "text-align: right;" })))), dom(table(tr(td("12", { style: "text-align: left;" }))))],
    ["id", dom(h("p", { id: "fn-1" }, "Note")), dom(h("p", {}, "Note"))],
    ["aria-* and role", dom(h("div", { "aria-describedby": "n", role: "presentation" }, "x")), dom(h("div", {}, "x"))],
    ["tabindex", dom(h("p", { tabindex: "-1" }, "x")), dom(h("p", {}, "x"))],
    ["a details block opened or closed by the reader", dom(h("details", { open: "" }, h("summary", {}, "Plus"), "x")), dom(h("details", {}, h("summary", {}, "Plus"), "x"))],
    ["a block still being written", dom(h("div", { "data-incomplete": "true" }, "x")), dom(h("div", {}, "x"))],
    ["a control's state: the copy button after a copy", dom(codeBlock("js", ["send();"], "Copied")), dom(codeBlock("js", ["send();"]))],
    [
      "an image that failed to load: its notice, its hidden class",
      dom(imageBlock("https://cdn.example/a.png", "", [h("span", { "data-streamdown": "image-fallback" }, "Image non disponible")])),
      dom(imageBlock("https://cdn.example/a.png")),
    ],
    ["a text split into other nodes", dom(h("p", {}, "Conclu", "sion")), dom(h("p", {}, "Conclusion"))],
    ["the order attributes were set in", dom(h("p", { lang: "fr", title: "t" }, "x")), dom(h("p", { title: "t", lang: "fr" }, "x"))],
  ];
  it.each(ignored)("ignored — %s: the same print", (_what, one, other) => {
    expect(blockPrint(one)).toBe(blockPrint(other));
  });

  it("what the page does not render cannot tell blocks apart: two items alike are homonyms whatever their number", () => {
    // Their numbers are the list's counter (the position): the uniqueness rule of
    // resolveChosen, not the print, keeps them apart.
    const [first, , third] = items(h("ol", {}, h("li", {}, "Relancer"), h("li", {}, "Valider"), h("li", {}, "Relancer")));
    expect(blockPrint(first!)).toBe(blockPrint(third!));
  });
});
