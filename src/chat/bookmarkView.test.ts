import { describe, expect, it } from "vitest";
import {
  anchorElement,
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
