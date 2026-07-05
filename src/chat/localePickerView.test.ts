import { describe, expect, test } from "vitest";
import { localeOptions } from "./localePickerView";
import {
  LOCALE_ENDONYMS,
  SUPPORTED_LOCALES,
} from "../../convex/lib/locales";

// Both language pickers (user pref + admin default) render THIS list — pin the
// derivation so a new language automatically appears, correctly labeled.
describe("localeOptions", () => {
  test("exposes exactly SUPPORTED_LOCALES, in order, labeled by endonym", () => {
    const opts = localeOptions();
    expect(opts.map((o) => o.value)).toEqual([...SUPPORTED_LOCALES]);
    for (const o of opts) {
      expect(o.label).toBe(LOCALE_ENDONYMS[o.value]);
      expect(o.label.length).toBeGreaterThan(0);
    }
  });
});
