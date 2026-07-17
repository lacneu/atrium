// Pure decisions for the folder page (ProjectPage.tsx renders these): the
// instant title filter and the unread computation (same rule as the sidebar).
// No React, no i18n.

export type PageChat = {
  _id: string;
  title: string | null;
  lastAssistantAt: number | null;
};

/** Case-insensitive instant filter on chat titles ("" = everything). An
 *  untitled chat only matches the empty term (its display name is a localized
 *  fallback the server never sees). */
export function filterChatsByTitle<T extends { title: string | null }>(
  chats: T[],
  term: string,
): T[] {
  const q = term.trim().toLowerCase();
  if (q === "") return chats;
  return chats.filter((c) => (c.title ?? "").toLowerCase().includes(q));
}

/** Fractional-key neighbours for a drop-between-items slot: the moved item
 *  lands AT the target's position (its own former slot removed first, like
 *  the sidebar's reorder); a FOREIGN item (other container) inserts BEFORE
 *  the target. Returns null when the target is not in the list. Pure. */
export function reorderSlot<T>(
  list: T[],
  getId: (t: T) => string,
  getKey: (t: T) => number,
  movedId: string,
  targetId: string,
): { prevKey: number | null; nextKey: number | null } | null {
  const ids = list.map(getId);
  const to = ids.indexOf(targetId);
  if (to < 0) return null;
  const from = ids.indexOf(movedId);
  if (from >= 0) {
    const work = [...list];
    const [item] = work.splice(from, 1);
    work.splice(to, 0, item);
    const prev = work[to - 1];
    const next = work[to + 1];
    return {
      prevKey: prev !== undefined ? getKey(prev) : null,
      nextKey: next !== undefined ? getKey(next) : null,
    };
  }
  const prev = list[to - 1];
  return {
    prevKey: prev !== undefined ? getKey(prev) : null,
    nextKey: getKey(list[to]!),
  };
}

/** Unread rule, identical to the sidebar's: a read row exists AND the last
 *  assistant activity is beyond it. No read row = no dot (quiet adoption). */
export function unreadChatIds(
  chats: PageChat[],
  reads: { chatId: string; lastSeenAt: number }[],
): Set<string> {
  const seen = new Map(reads.map((r) => [r.chatId, r.lastSeenAt]));
  const out = new Set<string>();
  for (const c of chats) {
    const at = seen.get(c._id);
    if (at !== undefined && c.lastAssistantAt !== null && c.lastAssistantAt > at) {
      out.add(c._id);
    }
  }
  return out;
}

