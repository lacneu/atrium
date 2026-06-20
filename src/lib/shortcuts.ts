// Keyboard shortcuts, defined ONCE so the displayed badge and the keydown
// matcher can never drift. A `Shortcut` is the single source of truth: both
// `shortcutLabel` (what the user sees) and `matchesShortcut` (what fires) are
// derived from the same object.
//
// `mod` is the platform "primary" modifier: Command (⌘) on macOS, Control (Ctrl)
// elsewhere. We never hardcode ⌘ — labels and matching are platform-aware so the
// badge reads `⌘K` on a Mac and `Ctrl+K` on Windows/Linux for the SAME shortcut.

/** A platform-agnostic shortcut definition. */
export interface Shortcut {
  /** Primary modifier: Command on macOS, Control on Windows/Linux. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Single character, case-insensitive (e.g. "k", "o"). */
  key: string;
}

/** Global conversation search palette. */
export const SHORTCUT_SEARCH: Shortcut = { mod: true, key: "k" };
/** Start a new chat (ChatGPT-style ⌘⇧O / Ctrl+Shift+O convention). */
export const SHORTCUT_NEW_CHAT: Shortcut = { mod: true, shift: true, key: "o" };

/**
 * True when `source` (a platform/userAgent string) denotes a Mac-family device.
 * Pure so it can be unit-tested without a real `navigator`. Note "MacIntel"
 * (iPad/Mac) matches → treated as Mac (⌘); "iPhone" does not → Ctrl.
 */
export function detectIsMac(source: string): boolean {
  return /mac/i.test(source);
}

function platformSource(): string {
  if (typeof navigator === "undefined") return "";
  // `userAgentData.platform` is the modern, non-deprecated signal; fall back to
  // the legacy `platform` then the full UA string for older browsers.
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
}

let cachedIsMac: boolean | null = null;

/** Runtime Mac detection (cached — the platform does not change mid-session). */
export function isMac(): boolean {
  if (cachedIsMac === null) cachedIsMac = detectIsMac(platformSource());
  return cachedIsMac;
}

/**
 * Human-readable badge for a shortcut. macOS uses tight symbol notation ordered
 * per Apple HIG (⌥ ⇧ ⌘, Command last) e.g. `⌘K`, `⇧⌘O`; other platforms use
 * `+`-joined words e.g. `Ctrl+K`, `Ctrl+Shift+O`.
 */
export function shortcutLabel(sc: Shortcut, mac: boolean): string {
  const key = sc.key.toUpperCase();
  if (mac) {
    let prefix = "";
    if (sc.alt) prefix += "⌥";
    if (sc.shift) prefix += "⇧";
    if (sc.mod) prefix += "⌘";
    return prefix + key;
  }
  const parts: string[] = [];
  if (sc.mod) parts.push("Ctrl");
  if (sc.shift) parts.push("Shift");
  if (sc.alt) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

/**
 * Does a keyboard event satisfy a shortcut? `mod` matches Command OR Control so
 * the same definition works on both platforms; the other modifiers must match
 * exactly so `⌘K` and `⇧⌘O` never collide (a Shift press fails the search match).
 */
export function matchesShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  sc: Shortcut,
): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (Boolean(sc.mod) !== mod) return false;
  if (Boolean(sc.shift) !== e.shiftKey) return false;
  if (Boolean(sc.alt) !== e.altKey) return false;
  return e.key.toLowerCase() === sc.key.toLowerCase();
}
