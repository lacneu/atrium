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
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "\u2026";
}
