import { describe, it, expect } from "vitest";
import {
  pickLogoUrl,
  pickAvatarLogo,
  avatarLogoMode,
  oklchLightness,
  brandInitials,
} from "./brandLogo";

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

describe("oklchLightness", () => {
  it("parses the L of a re-serialized oklch (0..1 form)", () => {
    expect(oklchLightness("oklch(0.55 0.105 34)")).toBeCloseTo(0.55);
    expect(oklchLightness("oklch(0.99 0.01 230)")).toBeCloseTo(0.99);
  });

  it("parses a leading-dot and a percentage L", () => {
    expect(oklchLightness("oklch(.32 0.012 45)")).toBeCloseTo(0.32);
    expect(oklchLightness("oklch(55% 0.1 34)")).toBeCloseTo(0.55);
  });

  it("tolerates an alpha suffix", () => {
    expect(oklchLightness("oklch(0.22 0.01 45 / 50%)")).toBeCloseTo(0.22);
  });

  it("returns null for missing / non-oklch / unparseable input", () => {
    expect(oklchLightness(undefined)).toBeNull();
    expect(oklchLightness("#112233")).toBeNull();
    expect(oklchLightness("rgb(1,2,3)")).toBeNull();
  });
});

describe("avatarLogoMode", () => {
  // The avatar tile paints the logo on `--primary` (not the page background), so
  // the variant must follow --primary's polarity, NOT the page mode.
  it("picks the DARK logo on a dark --primary even while the PAGE is light", () => {
    // The reported bug: Ataraxis terracotta primary (L 0.55) + near-white
    // foreground (L 0.98), page in LIGHT mode. Must be "dark" (not "light").
    expect(
      avatarLogoMode("oklch(0.55 0.105 34)", "oklch(0.98 0.012 78)", "light"),
    ).toBe("dark");
  });

  it("picks the LIGHT logo on a light --primary with a dark foreground", () => {
    expect(
      avatarLogoMode("oklch(0.95 0.02 78)", "oklch(0.2 0.01 45)", "dark"),
    ).toBe("light");
  });

  it("derives from the tokens, not the page mode (the whole point of the fix)", () => {
    // SAME dark primary, BOTH page modes -> always "dark". A page-mode-driven
    // selection (the old bug) would return "light" for the light page.
    const dark = ["oklch(0.5 0.1 34)", "oklch(0.97 0.01 78)"] as const;
    expect(avatarLogoMode(dark[0], dark[1], "light")).toBe("dark");
    expect(avatarLogoMode(dark[0], dark[1], "dark")).toBe("dark");
  });

  it("feeds pickLogoUrl so the on-primary logo wins end-to-end", () => {
    const brand = { logoLightUrl: "L", logoDarkUrl: "D" };
    const mode = avatarLogoMode(
      "oklch(0.55 0.105 34)",
      "oklch(0.98 0.012 78)",
      "light",
    );
    expect(pickLogoUrl(brand, mode)).toBe("D");
  });

  it("falls back to the page mode when tokens are missing/unparseable", () => {
    expect(avatarLogoMode(undefined, undefined, "light")).toBe("light");
    expect(avatarLogoMode(undefined, undefined, "dark")).toBe("dark");
    expect(avatarLogoMode("oklch(0.5 0.1 34)", "#fff", "light")).toBe("light");
  });
});

describe("pickAvatarLogo", () => {
  it("MASKS an alpha-defined logo (guaranteed contrast, color-agnostic)", () => {
    const brand = {
      logoLightUrl: "L",
      logoDarkUrl: "D",
      logoLightHasAlpha: true,
      logoDarkHasAlpha: true,
    };
    // Masked in both polarities; URL is color-agnostic (prefers light).
    expect(pickAvatarLogo(brand, "light")).toEqual({ url: "L", masked: true });
    expect(pickAvatarLogo(brand, "dark")).toEqual({ url: "L", masked: true });
  });

  it("prefers an alpha variant even if the OTHER mode's logo lacks alpha", () => {
    const brand = {
      logoLightUrl: "L",
      logoDarkUrl: "D",
      logoLightHasAlpha: false,
      logoDarkHasAlpha: true,
    };
    expect(pickAvatarLogo(brand, "light")).toEqual({ url: "D", masked: true });
  });

  it("falls back to a plain <img> (polarity-picked) for an OPAQUE logo — the guard", () => {
    // No alpha anywhere: masking would paint a solid block, so we must NOT mask.
    const brand = {
      logoLightUrl: "L",
      logoDarkUrl: "D",
      logoLightHasAlpha: false,
      logoDarkHasAlpha: false,
    };
    expect(pickAvatarLogo(brand, "light")).toEqual({ url: "L", masked: false });
    expect(pickAvatarLogo(brand, "dark")).toEqual({ url: "D", masked: false });
  });

  it("returns null when no logo is uploaded (caller shows mark/initials)", () => {
    expect(pickAvatarLogo(undefined, "light")).toBeNull();
    expect(
      pickAvatarLogo({ logoLightUrl: null, logoDarkUrl: null }, "dark"),
    ).toBeNull();
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
