// What a hover reveals, a finger must find in place (lot 4, 2026-11). The CSS half is
// the `.oc-reveal` class of convexChat.css; this is the half that lives in props.

/**
 * The message action bars (copy, read aloud, report, delete, ⋯) show on hover for
 * every message but the last. Where a finger can be used there is no hover to wait
 * for: every message keeps its bar. Nothing moves when it shows — the bar sits in
 * room the message already reserves.
 */
export function messageActionsAutohide(touch: boolean): "never" | "not-last" {
  return touch ? "never" : "not-last";
}

/**
 * Whether the composer takes the focus by itself (on opening a chat, a run
 * starting, a jump to the bottom). Under a mouse, yes: the reader types next.
 * Under a coarse pointer, never: the focus raises the virtual keyboard, which
 * covered half the thread after a tap in the drawer (lot 8, G14).
 */
export function composerAutoFocus(coarsePointer: boolean): boolean {
  return !coarsePointer;
}
