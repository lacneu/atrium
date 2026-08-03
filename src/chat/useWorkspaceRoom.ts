// HOW MUCH ROOM the conversation and a right-hand column actually share.
//
// The workspace holds three things: the sidebar, the conversation, and possibly
// a side panel. Only the last two share; counting the sidebar's width as
// available room left the thread at a sliver. And it cannot be assumed — the
// sidebar is resizable AND collapsible, so a viewport fraction is wrong half the
// time.
//
// Measured from the WORKSPACE, never from a panel: when there is no room the
// panel does not render, and a measurement hanging off it could never learn that
// the room came back.

import { useLayoutEffect, useState } from "react";

export function useWorkspaceRoom(opts?: {
  /** Also subtract the PERSISTENT column when one is on screen.
   *
   *  The two right-hand columns can coexist: a reading pinned in one
   *  conversation stays in the persistent column while a different one is opened
   *  in the conversation you are now in. Each measuring the full room meant each
   *  believed the other's width was free, and the thread between them was
   *  crushed by the pair. The persistent column is served first — it was there
   *  first — and the in-chat one measures what is actually left. */
  minusPinnedColumn?: boolean;
}): number {
  const minusPinned = opts?.minusPinnedColumn ?? false;
  const [available, setAvailable] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    // The workspace element is RE-QUERIED at every measurement, never captured.
    // It is replaced when the authenticated chrome mounts, and a hook that had
    // kept a reference went on measuring a node detached from the document —
    // reporting nought room forever, which hid the pinned column on a screen
    // that had plenty. Observing the documentElement, which is never replaced,
    // is what guarantees the measurement keeps being taken at all.
    const measure = () => {
      const row = document.querySelector(".oc-workspace");
      if (row === null) return;
      const sidebar = row.querySelector(".oc-sidebar-col");
      let taken = sidebar === null ? 0 : sidebar.getBoundingClientRect().width;
      if (minusPinned) {
        const pinned = row.querySelector(".oc-pinpanel");
        taken += pinned === null ? 0 : pinned.getBoundingClientRect().width;
      }
      const room = row.getBoundingClientRect().width - taken;
      // A width of zero is a layout that has not happened yet, not a room of
      // zero: taking it as fact is what made the column disappear.
      if (room > 0) setAvailable(room);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    // The sidebar and the pinned column resize on their own AND come and go —
    // collapsing removes the element, expanding creates another one, which no
    // ResizeObserver would ever hear about. The child watch re-attaches to
    // whichever elements exist now and re-measures on the spot.
    const watched = new Set<Element>();
    const attach = () => {
      const row = document.querySelector(".oc-workspace");
      const wanted = new Set<Element>();
      if (row !== null) {
        const sidebar = row.querySelector(".oc-sidebar-col");
        if (sidebar !== null) wanted.add(sidebar);
        if (minusPinned) {
          const pinned = row.querySelector(".oc-pinpanel");
          if (pinned !== null) wanted.add(pinned);
        }
      }
      for (const el of watched) if (!wanted.has(el)) ro.unobserve(el);
      for (const el of wanted) if (!watched.has(el)) ro.observe(el);
      watched.clear();
      for (const el of wanted) watched.add(el);
      measure();
    };
    attach();
    const mo = new MutationObserver(attach);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [minusPinned]);
  return available;
}
