// Pure view helpers for the language pickers (Preferences user pref + Appearance
// admin default). BOTH pickers derive from the single-source locale module —
// adding a language never edits a picker again (the former hardcoded
// ["fr","en"] arrays + per-language label ternaries silently drifted).
// Labels are ENDONYMS (a language's name in itself): that is what a speaker
// scans a picker for, and it needs no translation — so no per-language i18n key.

import {
  LOCALE_ENDONYMS,
  SUPPORTED_LOCALES,
  type Locale,
} from "../../convex/lib/locales";

export interface LocaleOption {
  value: Locale;
  label: string;
}

/** The selectable languages, in declaration order, labeled by endonym. */
export function localeOptions(): LocaleOption[] {
  return SUPPORTED_LOCALES.map((value) => ({
    value,
    label: LOCALE_ENDONYMS[value],
  }));
}
