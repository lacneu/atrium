// Markdown tables in a reply (lot 7, G1, 2026-11). Streamdown frames a table in a box
// that scrolls past 300 px of height — a scroll INSIDE the thread's scroll. On a
// short screen (a phone held sideways: a thread of about 180 px) the box was taller
// than the thread itself: the table runs at its full height there, the thread
// scrolling it like any other content. Elsewhere Streamdown's default stays.

/** The `tableMaxHeight` Streamdown gets: none on a short screen, its default else. */
export function markdownTableMaxHeight(shortScreen: boolean): "none" | undefined {
  return shortScreen ? "none" : undefined;
}
