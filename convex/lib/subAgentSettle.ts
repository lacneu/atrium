// The ONE rule for a frame- or announce-derived END on a sub-agent row (0.101.4).
//
// Once the bridge has read the child's gateway session row (`gatewayRow`), the row holds
// the status, as the Control UI shows it (convex/lib/sessionRowStatus.ts). An end learnt
// another way — the child's final frame (subAgents.upsertSubAgent), its announce
// (subAgents.settleAnnouncedChild, the announce branch of stream.startAssistant), a task
// delivery — may describe an EARLIER run than the one the row speaks for (a late
// announce of run A while "Interagir" runs B). It is then kept as `frameTerminal` — the
// end Atrium knows of should the row disappear (applyRowAbsent) — and the displayed
// status is left to the row. Without a row read, the end applies as it always did.
//
// Task rows (`task:<id>`) never hold a row (applySubAgentRowStatus refuses them): for
// them the rule is the old behaviour.

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type ChildEnd = "done" | "error" | "aborted";

/** Settle `row` with an end learnt from frames or an announce. Returns whether the
 *  displayed STATUS changed (the caller runs its post-settle hooks only then). */
export async function settleChildEnd(
  ctx: MutationCtx,
  row: Doc<"subAgents">,
  status: ChildEnd,
  fields: { errorMessage?: string; updatedAt: number },
): Promise<boolean> {
  if (row.gatewayRow !== undefined) {
    await ctx.db.patch(row._id, {
      frameTerminal: { status },
      updatedAt: fields.updatedAt,
    });
    return false;
  }
  await ctx.db.patch(row._id, { status, ...fields });
  return true;
}
