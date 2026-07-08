import { describe, it, expect } from "vitest";
import {
  isValidCustomShortcut,
  shortcutFromEvent,
  detectIsMac,
  shortcutLabel,
  matchesShortcut,
  SHORTCUT_SEARCH,
  SHORTCUT_NEW_CHAT,
  type Shortcut,
} from "./shortcuts";

describe("detectIsMac", () => {
  it("matches Mac platform strings", () => {
    expect(detectIsMac("MacIntel")).toBe(true);
    expect(detectIsMac("macOS")).toBe(true);
    expect(detectIsMac("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
      true,
    );
  });
  it("rejects non-Mac platform strings", () => {
    expect(detectIsMac("Win32")).toBe(false);
    expect(detectIsMac("Windows")).toBe(false);
    expect(detectIsMac("Linux x86_64")).toBe(false);
    expect(detectIsMac("iPhone")).toBe(false);
    expect(detectIsMac("")).toBe(false);
  });
});

describe("shortcutLabel", () => {
  it("renders the mod-only search shortcut per platform", () => {
    expect(shortcutLabel(SHORTCUT_SEARCH, true)).toBe("⌘K");
    expect(shortcutLabel(SHORTCUT_SEARCH, false)).toBe("Ctrl+K");
  });
  it("renders mod+shift per platform with Apple HIG order (Command last)", () => {
    expect(shortcutLabel(SHORTCUT_NEW_CHAT, true)).toBe("⇧⌘O");
    expect(shortcutLabel(SHORTCUT_NEW_CHAT, false)).toBe("Ctrl+Shift+O");
  });
  it("orders alt before shift before command on mac", () => {
    const sc: Shortcut = { mod: true, shift: true, alt: true, key: "p" };
    expect(shortcutLabel(sc, true)).toBe("⌥⇧⌘P");
    expect(shortcutLabel(sc, false)).toBe("Ctrl+Shift+Alt+P");
  });
});

function ev(
  over: Partial<
    Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">
  >,
): Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
> {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  };
}

describe("matchesShortcut", () => {
  it("fires search on Cmd+K (mac) and Ctrl+K (win)", () => {
    expect(matchesShortcut(ev({ key: "k", metaKey: true }), SHORTCUT_SEARCH)).toBe(
      true,
    );
    expect(matchesShortcut(ev({ key: "k", ctrlKey: true }), SHORTCUT_SEARCH)).toBe(
      true,
    );
  });
  it("requires the modifier", () => {
    expect(matchesShortcut(ev({ key: "k" }), SHORTCUT_SEARCH)).toBe(false);
  });
  it("does NOT fire search when shift is also held (no collision)", () => {
    expect(
      matchesShortcut(ev({ key: "k", metaKey: true, shiftKey: true }), SHORTCUT_SEARCH),
    ).toBe(false);
  });
  it("fires new-chat only with the shift modifier", () => {
    expect(
      matchesShortcut(
        ev({ key: "O", metaKey: true, shiftKey: true }),
        SHORTCUT_NEW_CHAT,
      ),
    ).toBe(true);
    // Same key without shift must NOT trigger new-chat.
    expect(
      matchesShortcut(ev({ key: "o", metaKey: true }), SHORTCUT_NEW_CHAT),
    ).toBe(false);
  });
  it("rejects an extra unwanted modifier (alt)", () => {
    expect(
      matchesShortcut(ev({ key: "k", metaKey: true, altKey: true }), SHORTCUT_SEARCH),
    ).toBe(false);
  });
});

describe("custom shortcuts (dictation toggle)", () => {
  it("requires a real modifier and one alphanumeric key", () => {
    expect(isValidCustomShortcut({ alt: true, key: "d" })).toBe(true);
    expect(isValidCustomShortcut({ mod: true, shift: true, key: "5" })).toBe(true);
    expect(isValidCustomShortcut({ key: "d" })).toBe(false);
    expect(isValidCustomShortcut({ shift: true, key: "d" })).toBe(false);
    expect(isValidCustomShortcut({ alt: true, key: "Enter" })).toBe(false);
    // the app's built-ins are reserved
    expect(isValidCustomShortcut({ mod: true, key: "k" })).toBe(false);
    expect(isValidCustomShortcut({ mod: true, shift: true, key: "o" })).toBe(false);
  });

  it("captures a combo from a keydown, ignoring pure modifier presses", () => {
    expect(
      shortcutFromEvent({ key: "Alt", metaKey: false, ctrlKey: false, shiftKey: false, altKey: true }),
    ).toBeNull();
    expect(
      shortcutFromEvent({ key: "d", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }),
    ).toEqual({ mod: true, key: "d" });
  });

  it("falls back to the physical key when macOS composes Alt+letter", () => {
    // Alt+D on macOS: key="∂", code="KeyD"
    expect(
      shortcutFromEvent({ key: "∂", code: "KeyD", metaKey: false, ctrlKey: false, shiftKey: false, altKey: true }),
    ).toEqual({ alt: true, key: "d" });
    // Shift composes digits too (Shift+5 -> "%"): physical fallback matches.
    expect(
      matchesShortcut(
        { key: "%", code: "Digit5", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
        { mod: true, shift: true, key: "5" },
      ),
    ).toBe(true);
    // and the MATCHER accepts the composed event against the stored shortcut
    expect(
      matchesShortcut(
        { key: "∂", code: "KeyD", metaKey: false, ctrlKey: false, shiftKey: false, altKey: true },
        { alt: true, key: "d" },
      ),
    ).toBe(true);
  });
});
