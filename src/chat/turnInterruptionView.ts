// WHAT A BUBBLE SAYS OF A TURN THE GATEWAY CUT (a restart, a stop).
//
// Facts only, as Convex holds them (`messages.interruption`). ONE fact states the
// interruption: the gateway's own recovery run resumed the turn (`recoveryRunId`, read
// from the transcript row right before the recovery entry). The shutdown the gateway
// announced on the turn's socket only chooses the words (a restart, a stop): alone it
// states nothing — the turn may have answered, or its end may not have been read. The
// Control UI shows the recovery as a notice between the interrupted work and the
// recovery's answer ("System · restart recovery — Turn interrupted by a gateway restart —
// asked the agent to resume and finish the response",
// ui/src/pages/chat/system-notice-kinds.ts at v2026.9.36); this is that notice, under the
// interrupted bubble's work, in the gateway vocabulary the rest of Atrium uses.
//
// Never an error of the reader's making, and never an invitation to send again: when the
// recovery answered, the answer is right below.

import { m } from "@/paraglide/messages.js";

export type TurnInterruption = {
  shutdown?: "restart" | "stop";
  recoveryRunId?: string;
  /** The tool calls the cut left without a result, proven by the rows right before the
   *  recovery entry (convex/lib/restartRecovery.ts `cutCallsBefore`). */
  cutCallIds?: readonly string[];
};

/** Is the interruption something to SAY: the gateway resumed the turn by itself. Never
 *  while the bubble still streams (its run may yet go on). */
export function turnInterrupted(
  interruption: TurnInterruption | null | undefined,
  status: string | undefined,
): boolean {
  if (interruption === null || interruption === undefined) return false;
  if (status === undefined || status === "streaming") return false;
  return interruption.recoveryRunId !== undefined;
}

/** The calls of this bubble the cut interrupted: exactly the ones Convex proved, and none
 *  while nothing is said of an interruption. A call the bubble shows without a result
 *  that is not among them keeps the state of any call of a settled turn. */
export function interruptedCalls(
  interruption: TurnInterruption | null | undefined,
  status: string | undefined,
): ReadonlySet<string> {
  return new Set(turnInterrupted(interruption, status) ? (interruption?.cutCallIds ?? []) : []);
}

/** Does a block of calls hold one the cut interrupted: a proven call that has neither a
 *  result nor an outcome of its own (the card's own reading, ToolCard `toolCardPhase`).
 *  The block's collapsed header then cannot read as all done. */
export function blockInterrupted(
  parts: readonly { toolCallId?: string; phase?: string; result?: unknown }[],
  cut: ReadonlySet<string>,
): boolean {
  return parts.some(
    (p) =>
      p.toolCallId !== undefined &&
      cut.has(p.toolCallId) &&
      p.phase !== "error" &&
      p.phase !== "completed" &&
      (p.result === undefined || p.result === null),
  );
}

/** The sentence, or null when there is nothing to say. */
export function turnInterruptionText(
  interruption: TurnInterruption | null | undefined,
  status: string | undefined,
): string | null {
  if (!turnInterrupted(interruption, status)) return null;
  const { shutdown } = interruption!;
  if (shutdown === "restart") return m.turn_interrupted_restart_recovered();
  if (shutdown === "stop") return m.turn_interrupted_stop_recovered();
  return m.turn_interrupted_recovered();
}
