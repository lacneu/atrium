import { useEffect, useState } from "react";

/** The device's PRIMARY pointer is coarse (a finger): a phone or a tablet. A laptop
 *  with a touchscreen keeps a fine primary pointer, and keeps its desktop density. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

/** Reactive `window.matchMedia(query).matches`. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** The primary pointer is coarse — see COARSE_POINTER_QUERY. */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY);
}

/** A finger CAN be used: the primary pointer cannot hover, or a coarse pointer
 *  exists at all (a tablet with a mouse attached still takes touch). What is only
 *  revealed on hover must then simply be there. Its CSS twin is the `.oc-reveal`
 *  rule of convexChat.css, kept on the same query by touchReveal.test.ts. */
export const TOUCH_REVEAL_QUERY = "(hover: none), (any-pointer: coarse)";

/** See TOUCH_REVEAL_QUERY. */
export function useTouchReveal(): boolean {
  return useMediaQuery(TOUCH_REVEAL_QUERY);
}
