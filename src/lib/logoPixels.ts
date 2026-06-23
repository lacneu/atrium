// Pure pixel operations for logo normalization, over a flat RGBA buffer in the
// canvas ImageData layout ([r,g,b,a, r,g,b,a, ...]). Extracted from the canvas
// plumbing in processLogoImage so the math is unit-testable — canvas /
// createImageBitmap do not run under vitest, but these array transforms do.

// Alpha at or below this (out of 255) counts as "transparent". Ignoring the
// near-zero antialiasing fringe keeps a trimmed bbox / transparency ratio stable.
export const ALPHA_TRANSPARENT_MAX = 8;

// A derived opposite-mode variant is recolored to a flat high-contrast ink ONLY
// when the silhouette is defined by ALPHA (a transparent-background logo). If too
// few pixels are transparent the image is its own opaque rectangle, and a flat
// recolor would emit a solid block — so we fall back to RGB inversion. This is the
// minimum transparent fraction that makes the recolor safe.
export const RECOLOR_MIN_TRANSPARENT_RATIO = 0.1;

// Near-white / near-black flat inks for the derived variants. Generic (NOT chart-
// bound): the dark-mode variant must read on BOTH the dark page background AND the
// (often mid-tone) `--primary` avatar tile, so a near-white silhouette is the safe
// universal choice; the light-mode variant is its near-black counterpart.
export const LIGHT_INK: readonly [number, number, number] = [248, 248, 248];
export const DARK_INK: readonly [number, number, number] = [24, 24, 24];

export type BBox = { x: number; y: number; width: number; height: number };

/**
 * Bounding box of the pixels with alpha above the transparent cutoff. Returns
 * null when the image is fully transparent (no content to bound).
 */
export function alphaBoundingBox(
  px: Uint8ClampedArray,
  width: number,
  height: number,
): BBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] > ALPHA_TRANSPARENT_MAX) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Fraction (0..1) of pixels at/below the transparent cutoff. */
export function transparentRatio(
  px: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  const total = width * height;
  if (total === 0) return 0;
  let transparent = 0;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] <= ALPHA_TRANSPARENT_MAX) transparent++;
  }
  return transparent / total;
}

/**
 * True when an alpha silhouette is present, so a flat ink recolor is safe; false
 * for a (near-)opaque image, where the caller should invert instead of producing
 * a solid block.
 */
export function silhouetteIsAlphaDefined(
  px: Uint8ClampedArray,
  width: number,
  height: number,
): boolean {
  return transparentRatio(px, width, height) >= RECOLOR_MIN_TRANSPARENT_RATIO;
}

/**
 * Set every pixel's RGB to `ink`, preserving alpha. The original alpha keeps the
 * antialiased edges, so the result is a clean ink silhouette of the same shape.
 * Mutates in place.
 */
export function recolorToInk(
  px: Uint8ClampedArray,
  ink: readonly [number, number, number],
): void {
  for (let i = 0; i < px.length; i += 4) {
    px[i] = ink[0];
    px[i + 1] = ink[1];
    px[i + 2] = ink[2];
  }
}

/** Invert RGB (255 - c), preserving alpha. Mutates in place. */
export function invertRgb(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 255 - px[i];
    px[i + 1] = 255 - px[i + 1];
    px[i + 2] = 255 - px[i + 2];
  }
}
