import { describe, expect, test } from "vitest";
import { groupAndFilterPrefs, PREF_META } from "./prefsMeta";

// The pure group/filter helper for the UI-preferences listing. These target the
// blind spots, not the happy path: a category-less key must NOT vanish, the
// filter must fold accents (FR default), and an empty query must return all.

describe("groupAndFilterPrefs", () => {
  test("empty query → ALL keys, grouped in category order, none dropped", () => {
    const keys = Object.keys(PREF_META);
    const groups = groupAndFilterPrefs(keys, "");
    // Non-empty categories in display order (no pref is "other" today).
    expect(groups.map((g) => g.id)).toEqual([
      "messages",
      "composer",
      "sidebar",
      "notifications",
    ]);
    const flat = groups.flatMap((g) => g.keys);
    expect(flat.slice().sort()).toEqual(keys.slice().sort());
  });

  test("an UNKNOWN key (no metadata) lands in 'other' — never dropped", () => {
    const groups = groupAndFilterPrefs(["showSource", "futurePref"], "");
    const other = groups.find((g) => g.id === "other");
    expect(other).toBeDefined();
    expect(other!.keys).toContain("futurePref");
    // The known key still sits in its own category.
    expect(groups.find((g) => g.id === "messages")!.keys).toContain(
      "showSource",
    );
  });

  test("filter is accent-insensitive ('anciennete' matches 'ancienneté')", () => {
    // showChatAge's help contains "ancienneté"; query the un-accented form.
    const groups = groupAndFilterPrefs(["showChatAge", "showSource"], "anciennete");
    const flat = groups.flatMap((g) => g.keys);
    expect(flat).toContain("showChatAge");
    expect(flat).not.toContain("showSource"); // no "anciennete" anywhere in it
  });

  test("filter also matches the CATEGORY name ('laterale' → sidebar prefs)", () => {
    const groups = groupAndFilterPrefs(Object.keys(PREF_META), "laterale");
    const flat = groups.flatMap((g) => g.keys);
    expect(flat).toContain("showChatAge");
    expect(flat).not.toContain("showSource"); // a Messages-category pref
  });

  test("no match → empty array (drives the 'no preference matches' state)", () => {
    expect(groupAndFilterPrefs(Object.keys(PREF_META), "zzzznope")).toEqual([]);
  });
});
