// A BUBBLE THE WATCHDOG CLOSED IS NOT ENDED (0.102.1).
//
// The stuck-stream watchdog (stuckStreams.reconcileStuckStreams) closes a bubble on
// Atrium's own clock. The Control UI never does: a run ends client-side only on the
// gateway's terminal (ui/src/pages/chat/chat-gateway.ts:128-200 at v2026.9.33) or on a
// read of the gateway's state that finds it over (chat-history-stream.ts:187-215 — a
// terminal status AND `hasActiveRun !== true`). Since 0.102.1 the watchdog leaves a
// projected (`on`) OpenClaw bubble alone; a bubble it closed BEFORE that (prod
// 2026-10-25), or one of a conversation it still covers, is corrected by the end of its
// own run: stream.finalizeMessageCore reopens it under the run's generation, and the
// projection settles it from the run's rows like a streaming one.
import type { Doc } from "../_generated/dataModel";

/** The watchdog's own error code — never a gateway's (stuckStreams writes it, the
 *  frontend maps it). Kept in sync with lib/chatRenderState's copy. */
export const STUCK_STREAM_ERROR_CODE = "stream_orphaned";

/** The code a SWEEP close writes (stuckStreams `closeSweptStream`: a bridge boot, or a
 *  reconnection question answered without the bubble being settled). Written there with
 *  no finalize — the bridge's own `connection_lost` terminal goes through finalize and is
 *  stamped. Kept in sync with lib/chatRenderState's copy. */
export const SWEEP_ERROR_CODE = "connection_lost";

/**
 * A bubble ATRIUM closed — no terminal of anyone's: the watchdog's `stream_orphaned`, or a
 * sweep's `connection_lost`, on a message no finalize ever stamped. A gateway error, a user
 * Stop, a delivery that brought nothing and a transcript settle all go through `finalize`,
 * which stamps `finalizedAt`; an announce merge that reopens a bubble clears it, and that
 * reopened generation is then the run that may close it. (Codex pass 1: a sweep's close is
 * the same guess as the watchdog's, and the end of the same run corrects it the same way.)
 */
export function isWatchdogOrphan(
  m: Pick<Doc<"messages">, "role" | "status" | "error" | "finalizedAt">,
): boolean {
  return (
    m.role === "assistant" &&
    m.status === "error" &&
    (m.error === STUCK_STREAM_ERROR_CODE || m.error === SWEEP_ERROR_CODE) &&
    m.finalizedAt === undefined
  );
}
