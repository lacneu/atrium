// Pure decision for the composer's send-vs-queue affordance AND the reason it is
// holding, so the held state is VISIBLE. A held follow-up the user cannot see is
// worse than the bug it fixes (the original "stuck, no feedback" confusion): the
// user types, presses send, and nothing visibly happens until a later drain.
//
// Two independent busy sources serialize a chat (the bridge is one-turn-per
// -session), and BOTH route the follow-up through the SAME server-side queue
// (queueSend, parked as a `queued` outbox row, auto-dispatched on drain):
//   - an in-flight assistant turn (assistant-ui's running state), and
//   - a sub-agent the chat spawned that is still running -- the parent turn has
//     already finalized (often empty: "I'll wait for the sub-agent"), so a normal
//     send would look idle while the message is actually parked.
//
// This helper only PICKS the affordance + the localized reason; the queueing
// itself is unchanged. Pure so every branch is unit-tested without a DOM.

export type ComposerQueueReason = "turn" | "subagent";

export type ComposerQueueState =
  | { mode: "send"; reason: null }
  | { mode: "queue"; reason: ComposerQueueReason };

export function composerQueueState(input: {
  /** An assistant turn is in flight (assistant-ui isRunning = streaming|pending). */
  turnRunning: boolean;
  /** A sub-agent spawned by this chat is still running. */
  hasRunningSubAgent: boolean;
}): ComposerQueueState {
  // An in-flight turn is the more immediate blocker, so it wins the attribution
  // when both are true (the sub-agent hint would be misleading mid-turn).
  if (input.turnRunning) return { mode: "queue", reason: "turn" };
  if (input.hasRunningSubAgent) return { mode: "queue", reason: "subagent" };
  return { mode: "send", reason: null };
}
