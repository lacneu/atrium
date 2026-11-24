// What a `chat.send` ACK says about CUSTODY of the input it answers.
//
// The gateway answers a send it took with `{runId, status}`:
//   - `started`   — the first ACK of an admitted send (chat-send-input-dispatch.ts);
//   - `in_flight` — a repeated key whose run is active, reserved or queued
//                   (chat-send-pre-admission.ts `respondChatSendRetry`);
//   - `accepted`  — from 2026.10.33 on, a repeated key whose turn was put in the
//                   follow-up queue: the queue admission stores `{runId, status:
//                   "accepted"}` as the key's replayable response
//                   (chat-send-turn-adoption.ts, `setGatewayDedupeEntry`), and a
//                   cached response is replayed before the `in_flight` branch is
//                   reached. Up to 2026.9.36 nothing was stored there and the same
//                   repeat read `in_flight`.
// All three mean the same thing here: the gateway HOLDS the input. The Control UI
// draws the same line from the other side — every status but `in_flight`, `ok`,
// `timeout` and `error` is read as `started` (ui chat-send-ack.ts
// `normalizeChatSendAckStatus`). `ok` is not custody: the reply is already in the
// transcript. `timeout` / `error` are terminal failures.

/** The ACK statuses under which the gateway holds the input for a run to come. */
export function chatSendAckHoldsInput(status: unknown): boolean {
  return status === "started" || status === "in_flight" || status === "accepted";
}

/** The two things a held input's ACK can do to its entry. */
export interface HeldInputLedger {
  noteInputAckRun(sendId: string, ackRunId: string | null): void;
  forgetHeldInput(sendId: string): void;
}

/** Settle a held input on its ACK: kept under the run the gateway named while the
 *  gateway holds it, forgotten otherwise (an input the gateway does not hold is not one
 *  whose answer may be adopted later). */
export function settleHeldInputAck(
  ledger: HeldInputLedger,
  sendId: string,
  status: unknown,
  ackRunId: string | null,
): void {
  if (chatSendAckHoldsInput(status)) ledger.noteInputAckRun(sendId, ackRunId);
  else ledger.forgetHeldInput(sendId);
}
