// Pure view logic for conversation bookmarks (IntelliJ-style): ordering,
// wrap-around navigation and DOM anchor resolution. Kept out of the components
// so the rules are unit-testable (repo pure-helper pattern).
//
// The anchor pair (messageId, blockIndex) is shared with the backend rows:
// blockIndex = index of a top-level markdown block inside the message body
// (null = the whole message). A finished message only APPENDS blocks (chain
// merges), so indexes are stable; a vanished index falls back to the message.

export interface BookmarkView {
  id: string;
  messageId: string;
  blockIndex: number | null;
  label: string | null;
  createdAt: number;
}

/**
 * Order bookmarks by THREAD position (the visible message order), then by
 * block position inside the message (message-level anchor first), then by
 * creation time as a stable tie-break. Bookmarks whose message is not in the
 * visible window (no order entry — older than the loaded window) are NOT
 * navigable: they are returned separately as a count, never silently dropped.
 */
export function orderBookmarks(
  rows: readonly BookmarkView[],
  messageOrder: ReadonlyMap<string, number>,
): { ordered: BookmarkView[]; unreachableCount: number } {
  const reachable: BookmarkView[] = [];
  let unreachableCount = 0;
  for (const row of rows) {
    if (messageOrder.has(row.messageId)) reachable.push(row);
    else unreachableCount++;
  }
  reachable.sort((a, b) => {
    const pa = messageOrder.get(a.messageId)!;
    const pb = messageOrder.get(b.messageId)!;
    if (pa !== pb) return pa - pb;
    const ba = a.blockIndex ?? -1;
    const bb = b.blockIndex ?? -1;
    if (ba !== bb) return ba - bb;
    return a.createdAt - b.createdAt;
  });
  return { ordered: reachable, unreachableCount };
}

/**
 * The next/previous bookmark id in the ordered ring (wrap-around). With no
 * current bookmark (or one that vanished), "next" enters at the FIRST and
 * "previous" at the LAST — the IntelliJ F3-ring feel.
 */
export function nextBookmarkId(
  orderedIds: readonly string[],
  currentId: string | null,
  dir: 1 | -1,
): string | null {
  if (orderedIds.length === 0) return null;
  const at = currentId === null ? -1 : orderedIds.indexOf(currentId);
  if (at === -1) {
    return dir === 1 ? orderedIds[0]! : orderedIds[orderedIds.length - 1]!;
  }
  const next = (at + dir + orderedIds.length) % orderedIds.length;
  return orderedIds[next]!;
}

/**
 * The top-level markdown blocks of a message bubble = the direct children of
 * its `.oc-md` container(s), EXCLUDING containers inside the turn's meta
 * chrome (`.oc-msg__meta` holds sub-agent/tool/source cards, which render
 * agent markdown of their own). DOM-order across containers.
 */
export function collectAnchorBlocks(bubble: Element): Element[] {
  const blocks: Element[] = [];
  for (const md of bubble.querySelectorAll(".oc-md")) {
    if (md.closest(".oc-msg__meta") !== null) continue;
    for (const child of md.children) {
      // A LIST renders as ONE top-level element, but a long numbered answer
      // (10 news items…) needs anchors on the ITEMS — descend one level so
      // each top-level <li> is a bookmarkable block (nested lists stay part
      // of their item).
      if (child.tagName === "OL" || child.tagName === "UL") {
        blocks.push(...child.children);
      } else {
        blocks.push(child);
      }
    }
  }
  return blocks;
}

/** What a block shows a reader (lot 21): its text, and — for a block that shows
 *  media (an image, a video, a drawing) — the media's alt text. A rule or an empty
 *  block shows nothing. The gutter and the block lists both read blocks through it;
 *  `print` is what tells the block apart from any other (`blockPrint`, lot 23). */
export type BlockFace = { text: string; alt: string; media: boolean; print: string };

const MEDIA = "img, picture, video, audio, canvas, svg, iframe";

export function blockFace(block: Element): BlockFace {
  const images = block.matches("img") ? [block] : [...block.querySelectorAll("img")];
  return {
    text: block.textContent ?? "",
    alt: images
      .map((img) => img.getAttribute("alt")?.trim() ?? "")
      .filter((alt) => alt !== "")
      .join(", "),
    media: block.matches(MEDIA) || block.querySelector(MEDIA) !== null,
    print: blockPrint(block),
  };
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Attributes that are presentation, state or plumbing — never what a block says, and
 *  each can change while the block does not (`blockPrint`). */
const PRINT_IGNORED = new Set(["class", "style", "id", "role", "tabindex", "open", "data-incomplete"]);

/** The parts of a block the renderer adds around what it says: its controls (copy,
 *  download, full screen — their icons, labels and states change with a click) and
 *  an image's load-failure notice. */
function isChrome(el: Element): boolean {
  return el.tagName === "BUTTON" || el.getAttribute("data-streamdown") === "image-fallback";
}

function printOf(el: Element): unknown[] {
  const attributes: [string, string][] = [];
  for (const name of el.getAttributeNames().sort()) {
    if (PRINT_IGNORED.has(name) || name.startsWith("aria-")) continue;
    attributes.push([name, el.getAttribute(name) ?? ""]);
  }
  const children: unknown[] = [];
  for (const node of el.childNodes) {
    if (node.nodeType === TEXT_NODE) {
      // The same text split into other nodes is the same text.
      const last = children.length - 1;
      if (typeof children[last] === "string") children[last] += node.nodeValue ?? "";
      else children.push(node.nodeValue ?? "");
    } else if (node.nodeType === ELEMENT_NODE && !isChrome(node as Element)) {
      children.push(printOf(node as Element));
    }
  }
  // A task box ticked or not is its property: the attribute says how it was created.
  return el.tagName === "INPUT"
    ? [el.tagName, attributes, children, (el as HTMLInputElement).checked]
    : [el.tagName, attributes, children];
}

/**
 * A block's EXACT print (lot 23): what tells it apart from every other block, so that a
 * block action never lands on a block other than the one the person saw
 * (`resolveChosen`). Two blocks share a print only when the page renders them alike.
 * It covers:
 *  - the kind of block: the tag of every element in it — a heading's level, bold or
 *    struck-through text, inline code, a link, a table's cells, each line of a code
 *    block —, the renderer's own name for what it drew (`data-streamdown`), and for a
 *    list item, its list (numbered or not);
 *  - every text exactly as rendered: no whitespace collapsed — a code line's
 *    indentation is its meaning —, no case or Unicode folding;
 *  - every attribute that says what is shown: a link's target and title, an image's
 *    source, alt text and size, a code block's language (`data-language`), a list
 *    item's number when the reply sets it, a cell's span; and whether a task box is
 *    ticked.
 * It leaves out what is not what the block says, each of which changes while the block
 * does not: `class` and `style` (the renderer's presentation — a table column's
 * alignment is written as a style: where words sit, not what they say —, and the
 * app's states — a jump's flash, an image that failed to load, heights that follow
 * the screen), `id`, `role`, `tabindex` and `aria-*` (identity and interaction
 * plumbing), `open` (a details block the reader opened), `data-incomplete` (a block
 * still being written, which no list or gutter reads), the renderer's controls and
 * load notices (`isChrome`), and how a text is split into nodes. What the page does
 * not render cannot tell blocks apart either: the numbers a list or a code block's
 * gutter draws from the position (which the block's index and uniqueness already
 * account for), the target of a link the app shows as plain text (AgentAnchor), the
 * pixels behind an image's address.
 */
export function blockPrint(block: Element): string {
  const list = block.tagName === "LI" ? (block.parentElement?.tagName ?? "") : "";
  return JSON.stringify([list, printOf(block)]);
}

/**
 * Resolve a bookmark anchor to the DOM element the UI scrolls to / marks:
 * the block at blockIndex, falling back to the BUBBLE when the index is gone
 * (regenerated shorter message) or the anchor is message-level.
 */
export function anchorElement(
  bubble: Element,
  blockIndex: number | null,
): Element {
  if (blockIndex === null) return bubble;
  return collectAnchorBlocks(bubble)[blockIndex] ?? bubble;
}

/**
 * The bookmark whose anchor center is CLOSEST to `target` (the viewport
 * center while scrolling). Pure argmin so the scroll-follow rule is testable.
 */
export function nearestBookmarkId(
  items: readonly { id: string; center: number }[],
  target: number,
): string | null {
  let bestId: string | null = null;
  let bestD = Infinity;
  for (const it of items) {
    const d = Math.abs(it.center - target);
    if (d < bestD) {
      bestD = d;
      bestId = it.id;
    }
  }
  return bestId;
}

/**
 * Normalize a block's text into a short list entry: collapse whitespace,
 * cut at a word boundary under `max` chars (ellipsis when truncated).
 */
export function previewFromText(raw: string, max = 48): string {
  const text = raw.replace(/\s+/g, " ").trim();
  // CODE POINTS, not UTF-16 units: cutting between a surrogate pair leaves a
  // lone surrogate, which is not valid Unicode — the backend refuses to store
  // it, so a preview ending on an emoji would fail the write it feeds.
  const points = Array.from(text);
  if (points.length <= max) return text;
  const cut = points.slice(0, max).join("");
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "\u2026";
}
