// The presence strip's MAGNIFICATION, the way the macOS Dock does it: the face under the
// pointer grows most, its neighbours less the farther they are, the rest not at all —
// a smooth bump that follows the pointer rather than one face jumping on hover. Pure (no
// React, no DOM) so the curve is unit-tested; the component measures and applies it.

/** The scale of the face right under the pointer. */
export const DOCK_MAX_SCALE = 2.4;
/** How far (px, from a face's centre) the bump reaches; beyond it a face keeps size 1. */
export const DOCK_RANGE_PX = 56;

/**
 * One scale per face, from the faces' RESTING centres and the pointer's position, both
 * in the same coordinate space (px along the strip). `null` pointer = not hovering: all 1.
 * Cosine falloff: the maximum at distance 0, exactly 1 at the range, never below 1.
 */
export function dockScales(
  centers: readonly number[],
  pointerX: number | null,
  max: number = DOCK_MAX_SCALE,
  range: number = DOCK_RANGE_PX,
): number[] {
  if (pointerX === null || !Number.isFinite(pointerX)) return centers.map(() => 1);
  return centers.map((c) => {
    const d = Math.abs(c - pointerX);
    if (d >= range) return 1;
    return 1 + (max - 1) * Math.cos((d / range) * (Math.PI / 2));
  });
}

/** The face that carries the name label: the most magnified one, if any is. */
export function dockFocus(scales: readonly number[]): number | null {
  let best = -1;
  let bestScale = 1;
  scales.forEach((s, i) => {
    if (s > bestScale) {
      best = i;
      bestScale = s;
    }
  });
  return best === -1 ? null : best;
}

/**
 * How far (px) each face moves sideways so the magnified ones make room — SYMMETRICALLY:
 * a face that grows by `e` px pushes every face on its left by e/2 to the left and every
 * face on its right by e/2 to the right. The face under the pointer is pushed equally from
 * both sides, so it stays under the pointer — the Dock's defining property. (Growing the
 * layout with margins instead pushed everything to the right, and the magnified face slid
 * away from the cursor.)
 */
export function dockOffsets(
  centers: readonly number[],
  scales: readonly number[],
  restWidth: number,
): number[] {
  return centers.map((ci, i) => {
    let d = 0;
    centers.forEach((cj, j) => {
      if (j === i) return;
      const grow = ((scales[j] ?? 1) - 1) * restWidth;
      d += (ci > cj ? 1 : ci < cj ? -1 : 0) * (grow / 2);
    });
    return d;
  });
}
