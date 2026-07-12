import { describe, expect, test } from "vitest";
import { autoProjectHue } from "./ChatSidebar";

describe("autoProjectHue (stable folder tint)", () => {
  test("same id always maps to the same hue", () => {
    expect(autoProjectHue("k17abc")).toBe(autoProjectHue("k17abc"));
  });
  test("returns a charte-var hue from the preset palette", () => {
    expect(autoProjectHue("anything")).toMatch(/^var\(--oc-accent-/);
  });
  test("different ids spread across the palette (no single-bucket collapse)", () => {
    const hues = new Set(
      Array.from({ length: 24 }, (_, i) => autoProjectHue(`project-${i}`)),
    );
    expect(hues.size).toBeGreaterThan(3);
  });
});
