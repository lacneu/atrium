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
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & {
    code?: string;
  },
  sc: Shortcut,
): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (Boolean(sc.mod) !== mod) return false;
  if (Boolean(sc.shift) !== e.shiftKey) return false;
  if (Boolean(sc.alt) !== e.altKey) return false;
  if (e.key.toLowerCase() === sc.key.toLowerCase()) return true;
  // Modifiers compose characters (macOS Alt+D -> "∂", Shift+5 -> "%"), so a
  // custom shortcut also matches on the PHYSICAL key (KeyD/Digit5). Safe: the
  // modifier equality checks above already passed.
  return physicalKey(e.code) === sc.key.toLowerCase();
}

/** "KeyD" -> "d", "Digit5" -> "5"; null for anything else. */
function physicalKey(code: string | undefined): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit?.[1]) return digit[1];
  return null;
}

// ---------------------------------------------------------------------------
// User-defined shortcuts (e.g. the dictation toggle): capture + validation.
// ---------------------------------------------------------------------------

/**
 * A user-recordable shortcut is valid when its key is ONE alphanumeric char and
 * at least one of mod/alt is held — a bare letter (or shift+letter) would fire
 * while typing normally in the composer. Mirrors the server-side validation.
 */
export function isValidCustomShortcut(sc: Shortcut): boolean {
  if (!/^[a-z0-9]$/i.test(sc.key)) return false;
  if (!sc.mod && !sc.alt) return false;
  // Never allow recording the app's built-in shortcuts — one combination must
  // never fire two actions.
  const sameAs = (b: Shortcut) =>
    Boolean(sc.mod) === Boolean(b.mod) &&
    Boolean(sc.shift) === Boolean(b.shift) &&
    Boolean(sc.alt) === Boolean(b.alt) &&
    sc.key.toLowerCase() === b.key.toLowerCase();
  return !sameAs(SHORTCUT_SEARCH) && !sameAs(SHORTCUT_NEW_CHAT);
}

/**
 * Build a Shortcut from a capture-mode keydown, or null when the event is not
 * a recordable combination (pure modifier press, non-alphanumeric key, or a
 * combination isValidCustomShortcut rejects). The caller preventDefaults.
 */
export function shortcutFromEvent(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & {
    code?: string;
  },
): Shortcut | null {
  // Ignore pure modifier presses while the user is still building the combo.
  if (["Shift", "Control", "Meta", "Alt"].includes(e.key)) return null;
  // With Alt held, macOS reports the composed character ("∂" for Alt+D) — fall
  // back to the physical key (e.code "KeyD") so the recorded shortcut stores
  // the letter the user actually pressed.
  const key = /^[a-z0-9]$/i.test(e.key)
    ? e.key.toLowerCase()
    : (physicalKey(e.code) ?? e.key.toLowerCase());
  const sc: Shortcut = {
    ...(e.metaKey || e.ctrlKey ? { mod: true } : {}),
    ...(e.shiftKey ? { shift: true } : {}),
    ...(e.altKey ? { alt: true } : {}),
    key,
  };
  return isValidCustomShortcut(sc) ? sc : null;
}

