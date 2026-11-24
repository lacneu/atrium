import { describe, expect, test } from "vitest";
import { pickFitLevel } from "@/lib/useFitLevel";
import {
  MORE_MENU_ORDER,
  OVERFLOW_ORDER,
  composerFitLevels,
  fitAttributes,
  levelAt,
  movableControls,
  type ComposerControls,
} from "./composerFit";

// Everything a composer can show: dictation on, Talk available, the permission
// picker visible, a room with agents (the chat used for the anchors below).
const ALL: ComposerControls = {
  hold: true,
  expand: true,
  talkSettings: true,
  perm: true,
  tools: true,
  roomSettings: true,
  talkStart: true,
  mic: true,
  recording: false,
};

describe("what may leave the composer's bar, and in which order", () => {
  test("Olivier's four first — detach, full page, Talk settings, permissions — then the rest", () => {
    expect(OVERFLOW_ORDER.slice(0, 4)).toEqual(["hold", "expand", "talk-settings", "perm"]);
    expect(movableControls(ALL)).toEqual([
      "hold",
      "expand",
      "talk-settings",
      "perm",
      "tools",
      "room-settings",
      "talk",
      "mic",
    ]);
  });

  test("never '+', the agent, send or stop: they have no key to move by", () => {
    const keys: readonly string[] = OVERFLOW_ORDER;
    for (const never of ["add", "agent", "room", "send", "stop"]) {
      expect(keys).not.toContain(never);
    }
  });

  test("a RECORDING microphone stays in the bar", () => {
    expect(movableControls({ ...ALL, recording: true })).not.toContain("mic");
    expect(movableControls({ ...ALL, recording: false })).toContain("mic");
  });

  test("an absent control takes no step (a Hermes chat: no Talk, no permissions)", () => {
    expect(
      movableControls({ ...ALL, talkSettings: false, talkStart: false, perm: false }),
    ).toEqual(["hold", "expand", "tools", "room-settings", "mic"]);
  });
});

describe("the order the More menu SHOWS them in", () => {
  test("one-line actions first, in bar order, then the two settings sections", () => {
    expect(MORE_MENU_ORDER).toEqual([
      "tools",
      "room-settings",
      "hold",
      "expand",
      "mic",
      "talk",
      "perm",
      "talk-settings",
    ]);
  });

  test("it shows every control that can leave, each once", () => {
    expect([...MORE_MENU_ORDER].sort()).toEqual([...OVERFLOW_ORDER].sort());
  });

  test("at 360 px the most used ones come before the permission modes", () => {
    const moved = new Set(movableControls(ALL).slice(0, 7));
    const shown = MORE_MENU_ORDER.filter((key) => moved.has(key));
    expect(shown.indexOf("talk")).toBeLessThan(shown.indexOf("perm"));
    expect(shown.indexOf("tools")).toBeLessThan(shown.indexOf("perm"));
  });
});

describe("the levels, most detailed first", () => {
  test("labels, then icons only, then one more control moved per level", () => {
    const levels = composerFitLevels(["hold", "expand", "perm"]);
    expect(levels).toEqual([
      { labels: true, moved: [] },
      { labels: false, moved: [] },
      { labels: false, moved: ["hold"] },
      { labels: false, moved: ["hold", "expand"] },
      { labels: false, moved: ["hold", "expand", "perm"] },
    ]);
  });

  test("the attributes the CSS keys on", () => {
    expect(fitAttributes({ labels: true, moved: [] })).toEqual({
      "data-labels": "on",
      "data-moved": "",
    });
    expect(fitAttributes({ labels: false, moved: ["hold", "talk-settings"] })).toEqual({
      "data-labels": "off",
      "data-moved": "hold talk-settings",
    });
  });

  test("past the last level, the most compact one is rendered", () => {
    const levels = composerFitLevels(["hold"]);
    expect(levelAt(levels, 99)).toEqual({ labels: false, moved: ["hold"] });
  });
});

// ANCHORS, measured in the browser on the app's own off-screen clone (French; chat
// "Préparation du rapport trimestriel 2026": OpenClaw, Alice, dictation and Talk on,
// permissions visible). One width per level but the last, which is never measured.
// Moving "hold" alone frees nothing: the More button takes its place (536 twice).
describe("the measured choice at real widths", () => {
  const levels = composerFitLevels(movableControls(ALL));

  test("360 x 740, coarse pointer (44 px controls), a 305.2 px bar: +, the agent, More, the microphone and send stay", () => {
    const required = [656.4, 536, 536, 485.6, 449.6, 399.2, 348.8, 316.8, 264.4];
    const level = pickFitLevel({ available: 305.2, required });
    expect(level).toBe(8);
    expect(levelAt(levels, level)).toEqual({
      labels: false,
      moved: ["hold", "expand", "talk-settings", "perm", "tools", "room-settings", "talk"],
    });
  });

  test("1280 x 800, fine pointer, a 745.2 px bar: everything stays, labels included", () => {
    const required = [564.6, 425.4, 425.4, 387, 367, 326, 285, 264, 220.4];
    expect(pickFitLevel({ available: 745.2, required })).toBe(0);
  });
});
