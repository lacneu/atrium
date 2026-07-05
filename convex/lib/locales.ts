// SINGLE SOURCE OF TRUTH for the app's supported locales.
//
// Everything derives from this module: the Convex schema stores locales as
// plain strings validated at the setters against `isSupportedLocale`; the UI
// pickers map SUPPORTED_LOCALES + LOCALE_ENDONYMS; the resolution chain
// (me.ts) narrows stored values through it; the parity gate reads
// project.inlang/settings.json which locales.sync.test.ts pins EQUAL to this
// list. Adding a language = (1) add it to project.inlang/settings.json +
// create messages/<locale>.json, (2) add it here + its endonym. Every other
// touch point is derived or guarded by a failing test.
//
// Pure module: importable from both Convex functions and the frontend
// (the same pattern as convex/lib/curation.ts).

export const SUPPORTED_LOCALES = ["fr", "en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Mirror of project.inlang/settings.json `baseLocale` — pinned equal by
 *  locales.sync.test.ts. The final fallback of every resolution chain. */
export const BASE_LOCALE: Locale = "fr";

/** Each locale's ENDONYM (its name in itself — "Français", not "French").
 *  Deliberately NOT translated: an endonym is what a speaker scans a language
 *  picker for, so it needs exactly one form. Replaces the per-language
 *  `language_xx` i18n keys (which cost one key x every catalog per language). */
export const LOCALE_ENDONYMS: Record<Locale, string> = {
  fr: "Français",
  en: "English",
};

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_LOCALES);

/** Runtime membership guard — the validation layer now that the schema stores
 *  locales as plain strings (no more per-language schema migration). */
export function isSupportedLocale(value: string): value is Locale {
  return SUPPORTED.has(value);
}

/** Narrow an arbitrary stored/persisted value to a supported locale, or
 *  undefined. A stored locale can become unsupported if a language is ever
 *  REMOVED — the resolution chain then falls through to the next tier instead
 *  of crashing or leaking an unknown code to Paraglide. */
export function asSupportedLocale(
  value: string | undefined | null,
): Locale | undefined {
  return typeof value === "string" && isSupportedLocale(value)
    ? value
    : undefined;
}

/** The effective UI language: user pref -> admin default -> base locale.
 *  (Moved from me.ts so notification/localization call sites share it.) */
export function resolveLocale(
  userLocale: string | undefined,
  adminDefault: string | undefined,
): Locale {
  return (
    asSupportedLocale(userLocale) ??
    asSupportedLocale(adminDefault) ??
    BASE_LOCALE
  );
}

/** The CONTENT language for server-generated, agent-facing material (prompt
 *  injections, rehydration framing, curation briefs): a per-instance override,
 *  else the app's admin-defined default language, else the base locale. This is
 *  deliberately NOT the chat user's locale — prompts are instance
 *  configuration (the Settings preview must show exactly what is sent), and a
 *  chat's framing must not flip per reader. */
export function resolveContentLocale(
  instanceContentLocale: string | undefined,
  adminDefault: string | undefined,
): Locale {
  return (
    asSupportedLocale(instanceContentLocale) ??
    asSupportedLocale(adminDefault) ??
    BASE_LOCALE
  );
}
