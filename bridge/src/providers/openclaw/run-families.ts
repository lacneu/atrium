// Run FAMILIES the gateway mints itself, recognized by their runId alone.
//
// None of these is ever the continuation of a user's turn: each is an
// independent piece of work the gateway started on the same session. They
// matter to the normalizer's admission policy (G-12) because they arrive on the
// SAME `sessionKey` and, inside a grace window, used to be adopted as the
// current turn's run — becoming the user's answer and closing their turn.
//
// Evidence (deployed 2026.7.1 build):
//   - `announce:…`      sub-agent announce turns (run-manager spontaneous turns)
//   - `<tool>:<taskId>:ok`  background-task deliveries (async-task.ts)
//   - `talk-<callId>-…` realtime-voice agent consults (talk-consult.ts)
//   - `inject-<messageId>`  `chat.inject` broadcasts a `chat` FINAL on the
//     session with this synthetic runId (gateway `chat.ts`), i.e. an operator or
//     plugin injection that would otherwise terminate an unrelated live turn.
//
// The run-manager owns the first three as spontaneous turns of their own; the
// fourth belongs to nobody's turn. Keeping the test here — one pure function,
// no state — lets both the run-manager and the normalizer share it without the
// normalizer having to import the run-manager (which imports the normalizer).

import { taskDeliveryRunFromRunId } from "../../core/async-task.js";
import { isTalkConsultRunId } from "../../core/talk-consult.js";

/** Synthetic runId prefix of a `chat.inject` broadcast. */
const INJECT_RUN_PREFIX = "inject-";

/**
 * True when `runId` belongs to a gateway-minted family — never the continuation
 * of the caller's turn, whatever grace window happens to be open.
 */
export function isGatewayInitiatedRunId(runId: string): boolean {
  if (runId.startsWith("announce:")) return true;
  if (runId.startsWith(INJECT_RUN_PREFIX)) return true;
  if (taskDeliveryRunFromRunId(runId) !== null) return true;
  // Ownership (relay-claimed or not) does not matter here: either way the
  // consult is its own turn, not this one's.
  if (isTalkConsultRunId(runId)) return true;
  return false;
}
