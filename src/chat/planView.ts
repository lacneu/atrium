import { currentPlanIndex } from "../../convex/lib/planOrder";

/** The plan a thread currently shows, or null when there is none to show.
 *
 *  WHICH update is current is decided by ONE rule, shared with the server so the
 *  two tiers cannot drift: `convex/lib/planOrder.ts` — cause order (the stamp the
 *  bridge put on the frame), not arrival order. Read its comment for why, and for
 *  the stated limits.
 *
 *  A plan with NO steps is how the bridge materializes a cleared / steps-less
 *  progress card (gateway 2026.8.1+ replaces the card on every put, so a
 *  markdown-only update drops the checklist): it must hide the previous
 *  checklist, not render as "0/0 done". */
export function resolveCurrentPlan<
  T extends { steps: unknown[]; stamp?: number },
>(planParts: readonly T[]): T | null {
  const winner = planParts[currentPlanIndex(planParts)];
  if (winner === undefined || winner.steps.length === 0) return null;
  return winner;
}
