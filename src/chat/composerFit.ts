// How the composer's action bar gives way when it runs out of room — measured, never
// guessed. The bar used to collapse on fixed container widths (30rem, 20rem, 17rem,
// 11rem) that knew nothing of the labels' real widths: at 820 px the French labels
// overlapped above the 30rem line, while at 360 px with dictation and Talk on, "+"
// was crushed to 0 px and the agent pill to 2 px. The bar now tries each level below,
// from the most detailed, and keeps the first one whose MEASURED width fits.

/**
 * The controls that may leave the bar for the "More" menu, in the order they leave.
 * The first four are Olivier's arbitration (2026-11): detach, full page, Talk
 * settings, then permissions. The rest only go when those four were not enough — a
 * phone with a coarse pointer, where every control is 44 px wide: the tools toggle,
 * the conversation's settings, then the voice entry points, Talk before the
 * microphone (dictation is the one a phone user reaches for).
 *
 * Never listed, so never moved: "+", the agent pill, send and stop.
 */
export const OVERFLOW_ORDER = [
  "hold",
  "expand",
  "talk-settings",
  "perm",
  "tools",
  "room-settings",
  "talk",
  "mic",
] as const;

export type OverflowKey = (typeof OVERFLOW_ORDER)[number];

/**
 * The order the "More" menu SHOWS them in — not the order they leave. One-line
 * actions first, in the order they sit in the bar, then the two settings sections:
 * on a phone the last controls to leave are the most used ones, and listed by
 * leaving order they landed under the five permission modes, a scroll away.
 */
export const MORE_MENU_ORDER: readonly OverflowKey[] = [
  "tools",
  "room-settings",
  "hold",
  "expand",
  "mic",
  "talk",
  "perm",
  "talk-settings",
];

/** What the composer renders right now, as far as the overflow is concerned. */
export interface ComposerControls {
  /** The detach (pin) slot: the hold button, or the held chip. */
  hold: boolean;
  /** The full-page toggle. */
  expand: boolean;
  /** Talk's settings chevron: idle and available. */
  talkSettings: boolean;
  /** The execution-permissions picker. */
  perm: boolean;
  /** The tools toggle (absent in full-page mode). */
  tools: boolean;
  /** The agent pill's settings chevron. */
  roomSettings: boolean;
  /** Talk's start button: idle and available. */
  talkStart: boolean;
  /** The microphone (dictation). */
  mic: boolean;
  /** Dictation is recording: the microphone is then the only way to stop it. */
  recording: boolean;
}

/** The controls that are present AND allowed to move, in leaving order. */
export function movableControls(c: ComposerControls): OverflowKey[] {
  const present: Record<OverflowKey, boolean> = {
    hold: c.hold,
    expand: c.expand,
    "talk-settings": c.talkSettings,
    perm: c.perm,
    tools: c.tools,
    "room-settings": c.roomSettings,
    talk: c.talkStart,
    // A recording microphone stays where it is: hiding it would leave a live
    // microphone with no visible control.
    mic: c.mic && !c.recording,
  };
  return OVERFLOW_ORDER.filter((key) => present[key]);
}

export interface ComposerFitLevel {
  /** Text labels shown (tools, permissions, the call's wording). */
  labels: boolean;
  /** The controls moved to the "More" menu. */
  moved: OverflowKey[];
}

/**
 * The levels, most detailed first: everything with its label; icons only; then the
 * movable controls step into the "More" menu one at a time.
 */
export function composerFitLevels(movable: readonly OverflowKey[]): ComposerFitLevel[] {
  const levels: ComposerFitLevel[] = [
    { labels: true, moved: [] },
    { labels: false, moved: [] },
  ];
  for (let count = 1; count <= movable.length; count++) {
    levels.push({ labels: false, moved: movable.slice(0, count) });
  }
  return levels;
}

/** The level to render: the measured one, or the most compact when none fits. */
export function levelAt(levels: readonly ComposerFitLevel[], level: number): ComposerFitLevel {
  return levels[Math.min(level, levels.length - 1)];
}

/** The bar's attributes for a level: `data-labels`, and the moved keys in `data-moved`. */
export function fitAttributes(level: ComposerFitLevel): {
  "data-labels": "on" | "off";
  "data-moved": string;
} {
  return {
    "data-labels": level.labels ? "on" : "off",
    "data-moved": level.moved.join(" "),
  };
}
