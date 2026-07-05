/// <reference types="vite/client" />
//
// THE anti-drift lock for the multi-language foundation. The locale list is
// declared in TWO places by construction (project.inlang/settings.json compiles
// the catalogs; convex/lib/locales.ts drives schema validation, pickers, and
// server-side content language) — these tests pin them EQUAL so forgetting one
// is a loud CI failure instead of a silently unchecked language. Adding a
// language = settings.json + messages/<locale>.json + SUPPORTED_LOCALES + its
// endonym; every one of those four is asserted here.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BASE_LOCALE,
  LOCALE_ENDONYMS,
  SUPPORTED_LOCALES,
  asSupportedLocale,
  isSupportedLocale,
  resolveContentLocale,
  resolveLocale,
} from "./lib/locales";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const inlang = JSON.parse(
  readFileSync(resolve(repoRoot, "project.inlang", "settings.json"), "utf8"),
) as { baseLocale: string; locales: string[] };

describe("locales single-source sync", () => {
  test("SUPPORTED_LOCALES === project.inlang/settings.json locales (both directions)", () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual([...inlang.locales].sort());
  });

  test("BASE_LOCALE === project.inlang/settings.json baseLocale", () => {
    expect(BASE_LOCALE).toBe(inlang.baseLocale);
  });

  test("every supported locale has its messages/<locale>.json catalog, and no orphan catalog exists", () => {
    const catalogs = readdirSync(resolve(repoRoot, "messages"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(catalogs).toEqual([...SUPPORTED_LOCALES].sort());
  });

  test("every supported locale has an endonym (picker label source)", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(
        LOCALE_ENDONYMS[locale],
        `missing endonym for "${locale}"`,
      ).toBeTruthy();
    }
    // No stale endonym for a removed locale either.
    expect(Object.keys(LOCALE_ENDONYMS).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
  });

  test("the parity gate derives its locale list from settings.json (no hardcoded copy)", () => {
    const script = readFileSync(
      resolve(repoRoot, "scripts", "i18n-check-parity.mjs"),
      "utf8",
    );
    // The old failure mode: `const LOCALES = ["fr", "en"]` — a manual copy that
    // silently skipped new languages. Pin its absence + the derivation.
    expect(script).not.toMatch(/const LOCALES = \[\s*"/);
    expect(script).toContain("project.inlang");
  });

  test("index.html seeds <html lang> by SHAPE, not by locale whitelist", () => {
    const html = readFileSync(resolve(repoRoot, "index.html"), "utf8");
    expect(html).not.toContain('l === "fr"');
  });
});

describe("locale narrowing + resolution chains", () => {
  test("isSupportedLocale / asSupportedLocale reject unknown codes", () => {
    expect(isSupportedLocale("fr")).toBe(true);
    expect(isSupportedLocale("de")).toBe(false);
    expect(asSupportedLocale("en")).toBe("en");
    expect(asSupportedLocale("xx")).toBeUndefined();
    expect(asSupportedLocale(undefined)).toBeUndefined();
    expect(asSupportedLocale(null)).toBeUndefined();
  });

  test("resolveLocale: user pref > admin default > base; unsupported stored values fall through", () => {
    expect(resolveLocale("en", "fr")).toBe("en");
    expect(resolveLocale(undefined, "en")).toBe("en");
    expect(resolveLocale(undefined, undefined)).toBe(BASE_LOCALE);
    // A language that was removed after being stored must not crash or leak.
    expect(resolveLocale("removed-locale", "en")).toBe("en");
    expect(resolveLocale("removed-locale", "also-removed")).toBe(BASE_LOCALE);
  });

  test("resolveContentLocale: instance override > admin default > base", () => {
    expect(resolveContentLocale("en", "fr")).toBe("en");
    expect(resolveContentLocale(undefined, "en")).toBe("en");
    expect(resolveContentLocale(undefined, undefined)).toBe(BASE_LOCALE);
    expect(resolveContentLocale("bogus", undefined)).toBe(BASE_LOCALE);
  });
});
