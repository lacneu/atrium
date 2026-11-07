// When an admin table stacks its rows (DataTableShell) — measured, never guessed.
import type { FitInput } from "@/lib/useFitLevel";

/**
 * The fit input for an admin table: level 0 is the table, which needs its narrowest
 * width (`needed`, read off a clone at min-content: below it, it scrolls sideways);
 * level 1, stacked rows, needs nothing. No hysteresis is needed: stacking only makes the page taller, so
 * a scrollbar it brings can only keep the rows stacked, and the one unstacking
 * removes can only give the table more room.
 */
export function tableLayoutFit(available: number, needed: number): FitInput {
  return { available, required: [needed] };
}
