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

export function useWorkspaceRoom(): number {
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
      const taken =
        sidebar === null ? 0 : sidebar.getBoundingClientRect().width;
      const room = row.getBoundingClientRect().width - taken;
      // A width of zero is a layout that has not happened yet, not a room of
      // zero: taking it as fact is what made the column disappear.
      if (room > 0) setAvailable(room);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    // The sidebar resizes on its own AND comes and goes — collapsing removes the
    // element, expanding creates another one, which no ResizeObserver would ever
    // hear about. The child watch re-attaches to whichever element exists now
    // and re-measures on the spot.
    const watched = new Set<Element>();
    const attach = () => {
      const row = document.querySelector(".oc-workspace");
      const wanted = new Set<Element>();
      if (row !== null) {
        const sidebar = row.querySelector(".oc-sidebar-col");
        if (sidebar !== null) wanted.add(sidebar);
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
  }, []);
  return available;
}
