// Typed-token chart validator (P4) -- a PURE server-side ALLOWLIST.
//
// THREAT MODEL (weighted): a user IMPORTS a custom chart (paste/read JSON). The
// tokens are eventually applied to `documentElement.style.setProperty("--<token>",
// value)` in the browser. Even though we never concat into a `<style>` string,
// an attacker-controlled value could still try to break out via `url()` (exfil),
// `@import`, `expression()` (legacy IE), `;}{` breakout, `var(--x)` redirection,
// or `image-set()`. The defense is a CLOSED VOCABULARY allowlist with a NARROW,
// ANCHORED grammar per token type, and RE-SERIALIZATION of every color from its
// parsed numeric components (the stored value is REBUILT, never the raw string).
//
// This module is PURE: types + allowlist consts + pure functions only. It imports
// NOTHING from convex/server, convex/values or ./_generated, so it is unit-testable
// in isolation and reusable by both the import and the update mutations. The Convex
// `v.object` column shape lives in schema.ts; this file owns the RUNTIME allowlist
// (the schema cannot express "only COLOR_TOKENS keys" / "only oklch values").

import { COLOR_TOKENS, type ChartTokens, type ColorToken } from "./charts";

// ===========================================================================
// Allowlist vocabulary (closed)
// ===========================================================================

/** Fast membership set for the closed color-token vocabulary. */
const COLOR_TOKEN_SET: ReadonlySet<string> = new Set(COLOR_TOKENS);

/**
 * The CLOSED set of font stacks a custom chart may select for fontSans/fontMono.
 * NO free text -- a chart picks one of these server-defined stacks by exact value,
 * which is why a font value can never carry `url()`/`@import`/a breakout char.
 * Mirrors the stacks the builtin charts already use (system sans / serif / mono).
 */
export const ALLOWED_FONT_STACKS: ReadonlySet<string> = new Set([
  // Sans
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  // Serif
  "Georgia, Cambria, 'Times New Roman', Times, serif",
  // Mono
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
]);

// ===========================================================================
// Bounds (defense in depth -- the closed vocabulary already bounds key COUNT)
// ===========================================================================

/** Max characters for the chart display `name` (stored verbatim, so bounded). */
const MAX_NAME_LEN = 60;
/** Max characters for ANY single token value (a serialized oklch is well under). */
const MAX_VALUE_LEN = 64;

// ===========================================================================
// Grammars
// ===========================================================================

// A numeric component. No sign, no exponent, no leading `+` -- the narrowest
// grammar that fits oklch. Two variants by slot:
//   NUM_PCT -- a number OPTIONALLY suffixed `%`, used for L, C and alpha (CSS
//     Color 4 accepts a <percentage> in each of those slots).
//   NUM_PLAIN -- a bare number (NO `%`), used for the HUE slot, which is a
//     <hue> = <number>|<angle> and never takes `%`. A `%` hue is a CSS-invalid
//     color the browser silently drops, so we narrow it out at validation time.
const NUM_PCT = "[0-9]+(?:\\.[0-9]+)?%?";
const NUM_PLAIN = "[0-9]+(?:\\.[0-9]+)?";

// Anchored oklch grammar: `oklch( L C H )` or `oklch( L C H / A )`. Whitespace
// between components is a single run of spaces; NOTHING is allowed after the
// close paren (the anchor `$` is the breakout guard). L/C/alpha may carry `%`;
// the hue slot uses NUM_PLAIN (no `%`).
const OKLCH_RE = new RegExp(
  "^oklch\\(\\s*(" +
    NUM_PCT +
    ")\\s+(" +
    NUM_PCT +
    ")\\s+(" +
    NUM_PLAIN +
    ")(?:\\s*/\\s*(" +
    NUM_PCT +
    "))?\\s*\\)$",
);

// Bounded radius: a non-negative number with an allowed length unit. Anchored.
const RADIUS_RE = /^[0-9]+(?:\.[0-9]+)?(?:rem|px|em)$/;

// Forbidden substrings/chars -- breakout matters AS MUCH as url(). Checked on the
// RAW value BEFORE any grammar match so a malicious payload never reaches parsing.
// Note: `(` is intentionally NOT in this list (the oklch grammar needs it); the
// ANCHORED OKLCH_RE is the only place `(` is permitted, and it allows nothing
// after the matching `)`.
const FORBIDDEN_SUBSTRINGS = [
  ";",
  "{",
  "}",
  "/*",
  "*/",
  "url",
  "@",
  "var",
  "image-set",
  "expression",
  "\\", // backslash (CSS escapes)
];

/** True if `s` contains a control character (incl. NUL, newlines, tabs). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // C0 controls (0x00-0x1F) and DEL (0x7F).
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** True if `s` contains any forbidden breakout substring/char. */
function hasForbidden(s: string): boolean {
  if (hasControlChar(s)) return true;
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    if (s.includes(bad)) return true;
  }
  return false;
}

// ===========================================================================
// Per-value validators (each returns the RE-SERIALIZED value or null)
// ===========================================================================

/**
 * Validate + RE-SERIALIZE a color value. Returns a freshly rebuilt
 * `oklch(L C H)` / `oklch(L C H / A)` string from the parsed components, so the
 * stored value is NEVER the raw user string. Rejects hex/rgb/hsl/named (only the
 * anchored oklch grammar matches) and anything oversized or carrying a breakout.
 */
function reserializeColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_VALUE_LEN) return null;
  if (hasForbidden(raw)) return null;
  const m = OKLCH_RE.exec(raw.trim());
  if (m === null) return null;
  const [, l, c, h, a] = m;
  // Rebuild from the captured components (never echo the raw string).
  return a === undefined
    ? `oklch(${l} ${c} ${h})`
    : `oklch(${l} ${c} ${h} / ${a})`;
}

/** Validate a radius value (returned as-is when it matches the bounded grammar). */
function validateRadius(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_VALUE_LEN) return null;
  if (hasForbidden(raw)) return null;
  return RADIUS_RE.test(raw.trim()) ? raw.trim() : null;
}

/** Validate a font value against the CLOSED stack set (exact membership). */
function validateFont(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Membership in the closed set is the whole check -- no grammar, no free text.
  return ALLOWED_FONT_STACKS.has(raw) ? raw : null;
}

/** Validate + bound the chart display name (stored verbatim). */
function validateName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LEN) return null;
  if (hasControlChar(trimmed)) return null;
  return trimmed;
}

// ===========================================================================
// Public API
// ===========================================================================

/** A validated import: the cleaned name + the RE-SERIALIZED tokens. */
export type ValidatedChart = { name: string; tokens: ChartTokens };

/** Discriminated result so callers branch on `ok` (never trust raw input). */
export type ChartValidationResult =
  | { ok: true; name: string; tokens: ChartTokens }
  | { ok: false; error: string };

const COLOR_MODES = ["light", "dark"] as const;

/**
 * Validate one mode's color map: every KEY must be in COLOR_TOKENS (unknown key
 * => REJECT) and every VALUE must re-serialize as oklch. Returns the rebuilt map
 * or an error string.
 */
function validateColorMap(
  modeLabel: string,
  raw: unknown,
): { ok: true; map: Partial<Record<ColorToken, string>> } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `colors.${modeLabel} must be an object` };
  }
  const out: Partial<Record<ColorToken, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!COLOR_TOKEN_SET.has(key)) {
      return { ok: false, error: `Unknown color token: ${key}` };
    }
    const serialized = reserializeColor(value);
    if (serialized === null) {
      return {
        ok: false,
        error: `Invalid color for ${modeLabel}.${key} (must be oklch)`,
      };
    }
    out[key as ColorToken] = serialized;
  }
  return { ok: true, map: out };
}

/**
 * The single PURE allowlist entry point. Validates an imported
 * `{ name, tokens: { colors:{light,dark}, radius?, fontSans?, fontMono? } }`:
 *   - name => bounded, control-char-free;
 *   - every colors.light/dark KEY in COLOR_TOKENS, every VALUE re-serialized oklch;
 *   - radius (optional) => bounded `<num>(rem|px|em)`;
 *   - fontSans/fontMono (optional) => a value in ALLOWED_FONT_STACKS;
 *   - ANY unknown top-level key, unknown token key, bad type, oversized value, or
 *     breakout substring (`;{}` `/*` `url` `@` `var` `image-set` `expression`
 *     `\` control-chars) => REJECT.
 * Returns the RE-SERIALIZED tokens -- callers store THIS, never the raw input.
 */
export function validateChartImport(input: unknown): ChartValidationResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Chart must be an object" };
  }
  const obj = input as Record<string, unknown>;

  // Closed top-level shape: only `name` and `tokens`.
  for (const key of Object.keys(obj)) {
    if (key !== "name" && key !== "tokens") {
      return { ok: false, error: `Unknown field: ${key}` };
    }
  }

  const name = validateName(obj.name);
  if (name === null) {
    return { ok: false, error: "Invalid chart name" };
  }

  const tokens = obj.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    return { ok: false, error: "tokens must be an object" };
  }
  const t = tokens as Record<string, unknown>;

  // Closed tokens shape: only `colors`, `radius`, `fontSans`, `fontMono`.
  for (const key of Object.keys(t)) {
    if (
      key !== "colors" &&
      key !== "radius" &&
      key !== "fontSans" &&
      key !== "fontMono" &&
      key !== "bpm"
    ) {
      return { ok: false, error: `Unknown token field: ${key}` };
    }
  }

  const colors = t.colors;
  if (colors === null || typeof colors !== "object" || Array.isArray(colors)) {
    return { ok: false, error: "tokens.colors must be an object" };
  }
  const c = colors as Record<string, unknown>;
  // Closed colors shape: only `light` and `dark`.
  for (const key of Object.keys(c)) {
    if (key !== "light" && key !== "dark") {
      return { ok: false, error: `Unknown colors mode: ${key}` };
    }
  }

  const built: ChartTokens = { colors: { light: {}, dark: {} } };
  for (const mode of COLOR_MODES) {
    // A mode may be absent (partial chart); default to empty.
    const rawMap = c[mode] ?? {};
    const res = validateColorMap(mode, rawMap);
    if (!res.ok) return res;
    built.colors[mode] = res.map;
  }

  if (t.radius !== undefined) {
    const radius = validateRadius(t.radius);
    if (radius === null) return { ok: false, error: "Invalid radius" };
    built.radius = radius;
  }
  if (t.fontSans !== undefined) {
    const font = validateFont(t.fontSans);
    if (font === null) return { ok: false, error: "Invalid fontSans" };
    built.fontSans = font;
  }
  if (t.fontMono !== undefined) {
    const font = validateFont(t.fontMono);
    if (font === null) return { ok: false, error: "Invalid fontMono" };
    built.fontMono = font;
  }
  if (t.bpm !== undefined) {
    const bpm = t.bpm;
    if (
      typeof bpm !== "number" ||
      !Number.isInteger(bpm) ||
      bpm < 0 ||
      bpm > 90
    ) {
      return { ok: false, error: "Invalid bpm (expected an integer 0-90)" };
    }
    built.bpm = bpm;
  }

  return { ok: true, name, tokens: built };
}

/**
 * Re-validate ONLY the tokens (for updateChart, which may change tokens without a
 * name). Same allowlist as validateChartImport's token half. Returns the rebuilt
 * tokens or an error.
 */
export function validateChartTokens(
  input: unknown,
): { ok: true; tokens: ChartTokens } | { ok: false; error: string } {
  const res = validateChartImport({ name: "x", tokens: input });
  if (!res.ok) return res;
  return { ok: true, tokens: res.tokens };
}
