// Builtin chart registry (P3) — a PURE TypeScript module: types + constants
// only, NO Convex runtime. It imports nothing from convex/server, convex/values
// or ./_generated, so it is importable by BOTH the Convex backend (charts.ts,
// me.ts) AND the frontend (src/ reaches it the same way it reaches the generated
// api, via a relative import). This single-source design keeps the backend's
// "is this a known chart key?" check and the frontend's "key -> tokens" mapping
// from ever drifting.
//
// A "chart" (charte graphique) is a named palette that overrides the BASE CSS
// vars in src/index.css (`--background`, `--radius`, `--ui-font-sans`, ...) at
// runtime via documentElement.style.setProperty. It NEVER touches the
// `@theme inline` mappings (`--color-*`, `--radius-md`). Because every builtin
// is defined ENTIRELY here as code constants, there is ZERO untrusted input in
// P3 — no validator, no CSP, no @property is needed (those belong to P4, when
// user-supplied custom charts arrive). See docs/GROUPS_CHARTS_P3_SPEC.md.

// ===========================================================================
// Token vocabulary (FIGE par la probe — see spec section 1)
// ===========================================================================

/**
 * The mode-scoped color tokens a chart may override. These are exactly the base
 * CSS custom properties declared in src/index.css `:root` (light) and `.dark`
 * (dark). A chart sets `--<token>`; an unset token falls back to index.css
 * (the frontend calls removeProperty for it).
 */
export const COLOR_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  // Jump-target highlight (deep-link `?m=` flash, fork landing glow). Falls
  // back to the chart's primary when unset (index.css default).
  "highlight",
  // Conversation-bookmark accent (markers, rail, anchor flash). Amber by
  // default (index.css); a chart may re-tint the whole bookmark language.
  "bookmark",
  // Voice/dictation accent (composer morph ring, mic pulse, live-transcript
  // ghost, held-dictation dock). Follows the chart's primary unless set.
  "voice",
] as const;

/** A single mode-scoped color token name (closed set). */
export type ColorToken = (typeof COLOR_TOKENS)[number];

/**
 * The shape of a chart's tokens. A chart may define a SUBSET of color tokens per
 * mode; unset tokens fall back to index.css. `radius` maps to `--radius`,
 * `fontSans` to `--ui-font-sans`, `fontMono` to `--ui-font-mono` (all
 * mode-independent). Color VALUES are full CSS color strings (e.g.
 * "oklch(0.97 0.02 240)"), since they are assigned verbatim via setProperty.
 */
export type ChartTokens = {
  colors: {
    light: Partial<Record<ColorToken, string>>;
    dark: Partial<Record<ColorToken, string>>;
  };
  radius?: string;
  fontSans?: string;
  fontMono?: string;
  // Heartbeat ambient pulse, beats/min. 0 or absent = static (no pulse); a set
  // value (resting range) drives `--heart-period` (= 60s / bpm) so the chart's
  // ambient aura beats at its own tempo. Part of the tokens => exported/imported.
  bpm?: number;
};

/** A registry entry: a stable `key`, a display `name`, and its tokens. */
export type BuiltinChart = {
  key: string;
  name: string;
  tokens: ChartTokens;
};

// ===========================================================================
// Builtin charts — 2-3 GENERIC demo palettes (NOT a client-brand chart; that is a later,
// separate task). Each defines a light + dark color set in oklch, plus radius
// and a font, so the picker is real and the live effect is unmistakable in BOTH
// modes. A subset of COLOR_TOKENS is enough — unset tokens inherit index.css.
// ===========================================================================

/** Ocean — cool blue/teal, slightly rounder corners. */
const OCEAN: ChartTokens = {
  colors: {
    light: {
      background: "oklch(0.985 0.012 230)",
      foreground: "oklch(0.22 0.04 245)",
      card: "oklch(0.995 0.008 230)",
      "card-foreground": "oklch(0.22 0.04 245)",
      popover: "oklch(0.995 0.008 230)",
      "popover-foreground": "oklch(0.22 0.04 245)",
      primary: "oklch(0.55 0.13 235)",
      "primary-foreground": "oklch(0.99 0.01 230)",
      secondary: "oklch(0.93 0.03 220)",
      "secondary-foreground": "oklch(0.28 0.05 240)",
      muted: "oklch(0.94 0.02 225)",
      "muted-foreground": "oklch(0.5 0.04 235)",
      accent: "oklch(0.9 0.05 200)",
      "accent-foreground": "oklch(0.28 0.06 230)",
      border: "oklch(0.88 0.03 225)",
      input: "oklch(0.88 0.03 225)",
      ring: "oklch(0.55 0.13 235)",
      "chart-1": "oklch(0.6 0.13 235)",
      "chart-2": "oklch(0.65 0.12 200)",
      "chart-3": "oklch(0.55 0.1 260)",
      "chart-4": "oklch(0.7 0.11 180)",
      "chart-5": "oklch(0.5 0.12 215)",
      sidebar: "oklch(0.96 0.02 228)",
      "sidebar-foreground": "oklch(0.24 0.04 245)",
      "sidebar-primary": "oklch(0.55 0.13 235)",
      "sidebar-primary-foreground": "oklch(0.99 0.01 230)",
      "sidebar-accent": "oklch(0.9 0.05 200)",
      "sidebar-accent-foreground": "oklch(0.28 0.06 230)",
      "sidebar-border": "oklch(0.87 0.03 225)",
      "sidebar-ring": "oklch(0.55 0.13 235)",
    },
    dark: {
      background: "oklch(0.2 0.03 245)",
      foreground: "oklch(0.95 0.02 225)",
      card: "oklch(0.25 0.04 245)",
      "card-foreground": "oklch(0.95 0.02 225)",
      popover: "oklch(0.25 0.04 245)",
      "popover-foreground": "oklch(0.95 0.02 225)",
      primary: "oklch(0.7 0.12 230)",
      "primary-foreground": "oklch(0.18 0.04 245)",
      secondary: "oklch(0.3 0.04 240)",
      "secondary-foreground": "oklch(0.95 0.02 225)",
      muted: "oklch(0.3 0.03 242)",
      "muted-foreground": "oklch(0.72 0.04 228)",
      accent: "oklch(0.4 0.07 210)",
      "accent-foreground": "oklch(0.96 0.02 220)",
      border: "oklch(0.35 0.03 242)",
      input: "oklch(0.35 0.03 242)",
      ring: "oklch(0.7 0.12 230)",
      "chart-1": "oklch(0.7 0.13 230)",
      "chart-2": "oklch(0.72 0.12 195)",
      "chart-3": "oklch(0.65 0.11 260)",
      "chart-4": "oklch(0.76 0.1 180)",
      "chart-5": "oklch(0.62 0.12 215)",
      sidebar: "oklch(0.23 0.04 246)",
      "sidebar-foreground": "oklch(0.95 0.02 225)",
      "sidebar-primary": "oklch(0.7 0.12 230)",
      "sidebar-primary-foreground": "oklch(0.18 0.04 245)",
      "sidebar-accent": "oklch(0.4 0.07 210)",
      "sidebar-accent-foreground": "oklch(0.96 0.02 220)",
      "sidebar-border": "oklch(0.34 0.03 242)",
      "sidebar-ring": "oklch(0.7 0.12 230)",
    },
  },
  radius: "0.75rem",
  fontSans:
    "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};

/** Forest — warm green, tighter corners, a serif display. */
const FOREST: ChartTokens = {
  colors: {
    light: {
      background: "oklch(0.985 0.012 130)",
      foreground: "oklch(0.24 0.04 145)",
      card: "oklch(0.995 0.008 130)",
      "card-foreground": "oklch(0.24 0.04 145)",
      popover: "oklch(0.995 0.008 130)",
      "popover-foreground": "oklch(0.24 0.04 145)",
      primary: "oklch(0.52 0.12 150)",
      "primary-foreground": "oklch(0.99 0.01 130)",
      secondary: "oklch(0.93 0.04 130)",
      "secondary-foreground": "oklch(0.3 0.05 150)",
      muted: "oklch(0.94 0.03 135)",
      "muted-foreground": "oklch(0.5 0.04 145)",
      accent: "oklch(0.9 0.06 115)",
      "accent-foreground": "oklch(0.3 0.06 150)",
      border: "oklch(0.88 0.03 135)",
      input: "oklch(0.88 0.03 135)",
      ring: "oklch(0.52 0.12 150)",
      "chart-1": "oklch(0.58 0.13 150)",
      "chart-2": "oklch(0.68 0.12 120)",
      "chart-3": "oklch(0.6 0.11 95)",
      "chart-4": "oklch(0.55 0.1 175)",
      "chart-5": "oklch(0.5 0.12 140)",
      sidebar: "oklch(0.96 0.02 132)",
      "sidebar-foreground": "oklch(0.26 0.04 145)",
      "sidebar-primary": "oklch(0.52 0.12 150)",
      "sidebar-primary-foreground": "oklch(0.99 0.01 130)",
      "sidebar-accent": "oklch(0.9 0.06 115)",
      "sidebar-accent-foreground": "oklch(0.3 0.06 150)",
      "sidebar-border": "oklch(0.87 0.03 135)",
      "sidebar-ring": "oklch(0.52 0.12 150)",
    },
    dark: {
      background: "oklch(0.2 0.03 150)",
      foreground: "oklch(0.95 0.02 130)",
      card: "oklch(0.25 0.04 150)",
      "card-foreground": "oklch(0.95 0.02 130)",
      popover: "oklch(0.25 0.04 150)",
      "popover-foreground": "oklch(0.95 0.02 130)",
      primary: "oklch(0.68 0.13 145)",
      "primary-foreground": "oklch(0.18 0.04 150)",
      secondary: "oklch(0.3 0.04 148)",
      "secondary-foreground": "oklch(0.95 0.02 130)",
      muted: "oklch(0.3 0.03 150)",
      "muted-foreground": "oklch(0.72 0.04 135)",
      accent: "oklch(0.4 0.07 120)",
      "accent-foreground": "oklch(0.96 0.02 125)",
      border: "oklch(0.35 0.03 148)",
      input: "oklch(0.35 0.03 148)",
      ring: "oklch(0.68 0.13 145)",
      "chart-1": "oklch(0.68 0.14 148)",
      "chart-2": "oklch(0.74 0.12 120)",
      "chart-3": "oklch(0.68 0.11 95)",
      "chart-4": "oklch(0.62 0.1 175)",
      "chart-5": "oklch(0.6 0.12 140)",
      sidebar: "oklch(0.23 0.04 150)",
      "sidebar-foreground": "oklch(0.95 0.02 130)",
      "sidebar-primary": "oklch(0.68 0.13 145)",
      "sidebar-primary-foreground": "oklch(0.18 0.04 150)",
      "sidebar-accent": "oklch(0.4 0.07 120)",
      "sidebar-accent-foreground": "oklch(0.96 0.02 125)",
      "sidebar-border": "oklch(0.34 0.03 148)",
      "sidebar-ring": "oklch(0.68 0.13 145)",
    },
  },
  radius: "0.375rem",
  fontSans: "Georgia, Cambria, 'Times New Roman', Times, serif",
};

/** Dusk — violet/amber, pill-rounded, monospace display. */
const DUSK: ChartTokens = {
  colors: {
    light: {
      background: "oklch(0.985 0.012 300)",
      foreground: "oklch(0.24 0.05 300)",
      card: "oklch(0.995 0.008 300)",
      "card-foreground": "oklch(0.24 0.05 300)",
      popover: "oklch(0.995 0.008 300)",
      "popover-foreground": "oklch(0.24 0.05 300)",
      primary: "oklch(0.55 0.16 300)",
      "primary-foreground": "oklch(0.99 0.01 300)",
      secondary: "oklch(0.93 0.04 310)",
      "secondary-foreground": "oklch(0.3 0.06 300)",
      muted: "oklch(0.94 0.03 305)",
      "muted-foreground": "oklch(0.5 0.05 300)",
      accent: "oklch(0.9 0.07 70)",
      "accent-foreground": "oklch(0.32 0.08 60)",
      border: "oklch(0.88 0.03 305)",
      input: "oklch(0.88 0.03 305)",
      ring: "oklch(0.55 0.16 300)",
      "chart-1": "oklch(0.58 0.17 300)",
      "chart-2": "oklch(0.7 0.15 70)",
      "chart-3": "oklch(0.55 0.15 330)",
      "chart-4": "oklch(0.65 0.14 35)",
      "chart-5": "oklch(0.5 0.16 280)",
      sidebar: "oklch(0.96 0.02 303)",
      "sidebar-foreground": "oklch(0.26 0.05 300)",
      "sidebar-primary": "oklch(0.55 0.16 300)",
      "sidebar-primary-foreground": "oklch(0.99 0.01 300)",
      "sidebar-accent": "oklch(0.9 0.07 70)",
      "sidebar-accent-foreground": "oklch(0.32 0.08 60)",
      "sidebar-border": "oklch(0.87 0.03 305)",
      "sidebar-ring": "oklch(0.55 0.16 300)",
    },
    dark: {
      background: "oklch(0.2 0.04 300)",
      foreground: "oklch(0.95 0.02 305)",
      card: "oklch(0.25 0.05 300)",
      "card-foreground": "oklch(0.95 0.02 305)",
      popover: "oklch(0.25 0.05 300)",
      "popover-foreground": "oklch(0.95 0.02 305)",
      primary: "oklch(0.72 0.15 300)",
      "primary-foreground": "oklch(0.18 0.04 300)",
      secondary: "oklch(0.3 0.05 305)",
      "secondary-foreground": "oklch(0.95 0.02 305)",
      muted: "oklch(0.3 0.04 303)",
      "muted-foreground": "oklch(0.72 0.05 305)",
      accent: "oklch(0.45 0.1 65)",
      "accent-foreground": "oklch(0.96 0.02 70)",
      border: "oklch(0.35 0.04 303)",
      input: "oklch(0.35 0.04 303)",
      ring: "oklch(0.72 0.15 300)",
      "chart-1": "oklch(0.72 0.16 300)",
      "chart-2": "oklch(0.78 0.14 70)",
      "chart-3": "oklch(0.68 0.15 330)",
      "chart-4": "oklch(0.72 0.13 35)",
      "chart-5": "oklch(0.64 0.16 280)",
      sidebar: "oklch(0.23 0.05 300)",
      "sidebar-foreground": "oklch(0.95 0.02 305)",
      "sidebar-primary": "oklch(0.72 0.15 300)",
      "sidebar-primary-foreground": "oklch(0.18 0.04 300)",
      "sidebar-accent": "oklch(0.45 0.1 65)",
      "sidebar-accent-foreground": "oklch(0.96 0.02 70)",
      "sidebar-border": "oklch(0.34 0.04 303)",
      "sidebar-ring": "oklch(0.72 0.15 300)",
    },
  },
  radius: "1rem",
  fontSans:
    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
};

/**
 * The builtin chart registry. There is deliberately NO "Default" entry — a null
 * selection means the NATIVE index.css look (the frontend calls removeProperty
 * everywhere), so a registry entry would only drift from index.css.
 */
export const BUILTIN_CHARTS: ReadonlyArray<BuiltinChart> = [
  { key: "ocean", name: "Ocean", tokens: OCEAN },
  { key: "forest", name: "Forest", tokens: FOREST },
  { key: "dusk", name: "Dusk", tokens: DUSK },
];

/** Fast membership set for "is this a known builtin chart key?" checks. */
export const BUILTIN_CHART_KEYS: ReadonlySet<string> = new Set(
  BUILTIN_CHARTS.map((c) => c.key),
);

/** Look up a builtin by key, or undefined if unknown. */
export function builtinChart(key: string): BuiltinChart | undefined {
  return BUILTIN_CHARTS.find((c) => c.key === key);
}

// ===========================================================================
// Pure resolution (shared by getMe and the frontend)
// ===========================================================================

/** Where a resolved chart key came from. "code" = native index.css default. */
export type ChartSource = "user" | "group" | "domain" | "common/admin" | "code";

/** The outcome of resolving the effective chart for a user. */
export type ResolvedChart = {
  chartKey: string | null;
  source: ChartSource;
};

/**
 * Resolve the EFFECTIVE chart key with precedence (3-tier charts model):
 *   1. the user's own pick, IF it is still available to them -> "user";
 *   2. else the user's GROUP default (a chart their group SELECTED + flagged
 *      default) -> "group";
 *   3. else the DOMAIN default (charte par domaine), IF it is available to the
 *      user (the domain×group junction) -> "domain";
 *   4. else the admin global default, if set -> "common/admin";
 *   5. else null (native look) -> "code".
 *
 * Precedence (user decision, 2026-06-20): the GROUP default BEATS the domain/host
 * default — a chart a user's group chose for them is more specific than the host
 * brand. `availableKeys` is the set offered to the user (from group memberships);
 * the user's pick is dropped when no longer available. `groupDefault` is already
 * derived from the user's OWN group memberships (groupDefaultChartForUser), so it
 * is available to them by construction -> applied WITHOUT a separate check.
 * `domainAvailable` is the pre-computed junction for the domain default. The admin
 * GLOBAL default is applied WITHOUT an availability check (a deliberate global choice).
 */
export function resolveChart(
  userKey: string | null | undefined,
  groupDefault: string | null | undefined,
  domainDefault: string | null | undefined,
  adminDefault: string | null | undefined,
  availableKeys: ReadonlySet<string>,
  domainAvailable: boolean,
): ResolvedChart {
  if (userKey && availableKeys.has(userKey)) {
    return { chartKey: userKey, source: "user" };
  }
  if (groupDefault) {
    return { chartKey: groupDefault, source: "group" };
  }
  if (domainDefault && domainAvailable) {
    return { chartKey: domainDefault, source: "domain" };
  }
  if (adminDefault) {
    return { chartKey: adminDefault, source: "common/admin" };
  }
  return { chartKey: null, source: "code" };
}
