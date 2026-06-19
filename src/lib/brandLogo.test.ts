import { describe, it, expect } from "vitest";
import { pickLogoUrl, brandInitials } from "./brandLogo";

describe("pickLogoUrl", () => {
  const both = { logoLightUrl: "L", logoDarkUrl: "D" };

  it("picks the RESOLVED mode's own logo when both are uploaded", () => {
    // Discriminates the mode→slot mapping: a flipped branch returns the other URL.
    expect(pickLogoUrl(both, "light")).toBe("L");
    expect(pickLogoUrl(both, "dark")).toBe("D");
  });

  it("falls back to the OTHER mode's logo when only one is uploaded", () => {
    expect(pickLogoUrl({ logoLightUrl: "L", logoDarkUrl: null }, "dark")).toBe(
      "L",
    );
    expect(pickLogoUrl({ logoLightUrl: null, logoDarkUrl: "D" }, "light")).toBe(
      "D",
    );
  });

  it("returns null when NO logo is uploaded (so the caller shows the mark/label)", () => {
    expect(
      pickLogoUrl({ logoLightUrl: null, logoDarkUrl: null }, "light"),
    ).toBeNull();
    expect(pickLogoUrl({}, "dark")).toBeNull();
  });

  it("returns null for an undefined brand", () => {
    expect(pickLogoUrl(undefined, "light")).toBeNull();
  });
});

describe("brandInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(brandInitials("Acme Corp")).toBe("AC");
    expect(brandInitials("Ataraxis Coaching")).toBe("AC");
  });

  it("takes the first two letters of a single word", () => {
    expect(brandInitials("Ataraxis")).toBe("AT");
  });

  it("uppercases and ignores surrounding / extra whitespace", () => {
    expect(brandInitials("  ataraxis  ")).toBe("AT");
    expect(brandInitials("acme   corp")).toBe("AC");
  });

  it("handles a one-character label", () => {
    expect(brandInitials("x")).toBe("X");
  });

  it("falls back to '?' for an empty label", () => {
    expect(brandInitials("   ")).toBe("?");
  });
});
