// Wiring for the thread landing (see `threadLanding.ts` for what it does and why).

import { useEffect } from "react";

import { useBookmarks } from "./Bookmarks";
import { chooseLanding, landThread } from "./threadLanding";

/**
 * Position the thread the moment a conversation becomes visible, without the scroll being
 * seen.
 *
 * Runs per chat, once the messages are in. Two cases deliberately do NOTHING:
 *
 *  * a `?m=` deep link (`focusMessageId`) — the URL already says where to go, and
 *    `useFocusMessage` is taking the thread there; landing as well would be two scrolls
 *    fighting over the same viewport;
 *  * a chat still loading — its viewport is `display: none`, so `scrollHeight` is 0 and
 *    any position taken now would be discarded on reveal.
 */
export function useThreadLanding(opts: {
  chatId: string;
  ready: boolean;
  focusMessageId: string | null;
}): void {
  const bookmarks = useBookmarks();
  const rows = bookmarks?.rows;
  useEffect(() => {
    if (!opts.ready || opts.focusMessageId) return;
    const viewport = document.querySelector<HTMLElement>(".oc-thread__viewport");
    if (!viewport) return;
    // Marked BEFORE the first frame: the attribute is what suppresses the smooth scroll,
    // so setting it after a position was taken would already have shown the journey.
    viewport.setAttribute("data-oc-landing", "");
    const cancel = landThread(viewport, chooseLanding(rows ?? []));
    return () => {
      cancel();
    };
    // `rows` is read once per chat on purpose: a bookmark placed later must not re-land a
    // thread the user is reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.chatId, opts.ready, opts.focusMessageId]);
}
