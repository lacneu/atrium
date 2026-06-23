import { describe, it, expect } from "vitest";
import {
  alphaBoundingBox,
  transparentRatio,
  silhouetteIsAlphaDefined,
  recolorToInk,
  invertRgb,
  LIGHT_INK,
  DARK_INK,
} from "./logoPixels";

// Build a width*height RGBA buffer; `fill(x,y)` decides each pixel's [r,g,b,a].
function buf(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a;
    }
  }
  return px;
}

const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];

describe("alphaBoundingBox", () => {
  it("bounds the opaque region inside a transparent field (the trim rect)", () => {
    // 4x4 transparent, a single opaque pixel at (2,1): bbox is exactly that pixel.
    const px = buf(4, 4, (x, y) =>
      x === 2 && y === 1 ? [10, 20, 30, 255] : TRANSPARENT,
    );
    expect(alphaBoundingBox(px, 4, 4)).toEqual({ x: 2, y: 1, width: 1, height: 1 });
  });

  it("ignores the near-transparent antialiasing fringe (alpha <= cutoff)", () => {
    // An alpha=5 pixel must NOT widen the box (cutoff is 8).
    const px = buf(4, 4, (x, y) => {
      if (x === 1 && y === 1) return [0, 0, 0, 255];
      if (x === 3 && y === 3) return [0, 0, 0, 5];
      return TRANSPARENT;
    });
    expect(alphaBoundingBox(px, 4, 4)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });

  it("returns null for a fully transparent image", () => {
    expect(alphaBoundingBox(buf(3, 3, () => TRANSPARENT), 3, 3)).toBeNull();
  });

  it("returns the full rect for a fully opaque image (nothing to trim)", () => {
    const px = buf(3, 2, () => [1, 2, 3, 255]);
    expect(alphaBoundingBox(px, 3, 2)).toEqual({ x: 0, y: 0, width: 3, height: 2 });
  });
});

describe("transparentRatio / silhouetteIsAlphaDefined", () => {
  it("is ~1 for a transparent-background logo and triggers recolor", () => {
    // One opaque pixel out of 16 -> 15/16 transparent.
    const px = buf(4, 4, (x, y) =>
      x === 0 && y === 0 ? [0, 0, 0, 255] : TRANSPARENT,
    );
    expect(transparentRatio(px, 4, 4)).toBeCloseTo(15 / 16);
    expect(silhouetteIsAlphaDefined(px, 4, 4)).toBe(true);
  });

  it("is 0 for a fully opaque image -> recolor MUST fall back (the guard)", () => {
    // The advisor's blocking case: an opaque-background logo. A flat recolor here
    // would paint a solid block, so the silhouette check must return false.
    const px = buf(4, 4, () => [120, 60, 40, 255]);
    expect(transparentRatio(px, 4, 4)).toBe(0);
    expect(silhouetteIsAlphaDefined(px, 4, 4)).toBe(false);
  });
});

describe("recolorToInk", () => {
  it("paints RGB to the ink while PRESERVING alpha (so edges stay antialiased)", () => {
    const px = buf(2, 1, (x) =>
      x === 0 ? [200, 100, 50, 255] : [200, 100, 50, 128],
    );
    recolorToInk(px, LIGHT_INK);
    // Opaque pixel -> ink at full alpha.
    expect([px[0], px[1], px[2], px[3]]).toEqual([...LIGHT_INK, 255]);
    // Half-transparent edge pixel -> ink, alpha UNCHANGED. The discriminator: a
    // version that flattened alpha to 255 would break the antialiased silhouette.
    expect([px[4], px[5], px[6], px[7]]).toEqual([...LIGHT_INK, 128]);
  });

  it("dark variant uses LIGHT_INK, light variant uses DARK_INK (high contrast)", () => {
    const a = buf(1, 1, () => [120, 60, 40, 255]);
    recolorToInk(a, LIGHT_INK);
    expect([a[0], a[1], a[2]]).toEqual([...LIGHT_INK]);
    const b = buf(1, 1, () => [220, 220, 220, 255]);
    recolorToInk(b, DARK_INK);
    expect([b[0], b[1], b[2]]).toEqual([...DARK_INK]);
  });
});

describe("invertRgb", () => {
  it("inverts RGB (255 - c) and preserves alpha", () => {
    const px = buf(1, 1, () => [10, 20, 30, 200]);
    invertRgb(px);
    expect([px[0], px[1], px[2], px[3]]).toEqual([245, 235, 225, 200]);
  });
});
