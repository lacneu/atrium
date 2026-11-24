// What a hover reveals, a finger must find in place (lot 4, 2026-11). The CSS half is
// the `.oc-reveal` class of convexChat.css; this is the half that lives in props.

/**
 * How a message's action bar (copy, read aloud, report, delete, ⋯) shows. It is
 * RENDERED for every message — hidden, not absent (lot 22): assistant-ui's own autohide
 * rendered nothing for an older message's bar without a mouse over it, so a keyboard
 * could never reach its ⋯, nor the block lists behind it. An older message's bar shows
 * on hover, on keyboard focus within the message and while one of its menus is open
 * ("hover", convexChat.css); the last message's always; where a finger can be used
 * there is no hover to wait for, every bar always. Nothing moves when it shows — the
 * bar sits in room the message already reserves.
 */
export function messageActionsReveal(touch: boolean, isLast: boolean): "always" | "hover" {
  return touch || isLast ? "always" : "hover";
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
