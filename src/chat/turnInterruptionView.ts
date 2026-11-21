// WHAT A BUBBLE SAYS OF A TURN THE GATEWAY CUT (a restart, a stop).
//
// Facts only, as Convex holds them (`messages.interruption`): the shutdown the gateway
// announced on the turn's socket, the gateway's own recovery run, a transcript that stops
// before an answer. The Control UI shows the recovery as a notice between the interrupted
// work and the recovery's answer ("System · restart recovery — Turn interrupted by a
// gateway restart — asked the agent to resume and finish the response",
// ui/src/pages/chat/system-notice-kinds.ts at v2026.9.36); this is that notice, under the
// interrupted bubble's work, in the gateway vocabulary the rest of Atrium uses.
//
// Never an error of the reader's making, and never an invitation to send again: when the
// recovery answered, the answer is right below.

import { m } from "@/paraglide/messages.js";

export type TurnInterruption = {
  shutdown?: "restart" | "stop";
  recoveryRunId?: string;
  unanswered?: true;
};

/** Is the interruption something to SAY: the gateway resumed the turn by itself, or it
 *  announced a shutdown and the turn's transcript stops before an answer. Never while the
 *  bubble still streams (its run may yet go on). */
export function turnInterrupted(
  interruption: TurnInterruption | null | undefined,
  status: string | undefined,
): boolean {
  if (interruption === null || interruption === undefined) return false;
  if (status === undefined || status === "streaming") return false;
  if (interruption.recoveryRunId !== undefined) return true;
  return interruption.shutdown !== undefined && interruption.unanswered === true;
}

/** The sentence, or null when there is nothing to say. */
export function turnInterruptionText(
  interruption: TurnInterruption | null | undefined,
  status: string | undefined,
): string | null {
  if (!turnInterrupted(interruption, status)) return null;
  const { shutdown, recoveryRunId } = interruption!;
  if (recoveryRunId !== undefined) {
    if (shutdown === "restart") return m.turn_interrupted_restart_recovered();
    if (shutdown === "stop") return m.turn_interrupted_stop_recovered();
    return m.turn_interrupted_recovered();
  }
  return shutdown === "restart" ? m.turn_interrupted_restart() : m.turn_interrupted_stop();
}
