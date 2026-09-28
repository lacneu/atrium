// THE ONE PLACE A `chat.send` REQUEST IS ISSUED.
//
// Three review findings in a row had the same shape: a decision about the turn was
// checked, then something was awaited (attachment staging, a run, the participant's
// socket opening, a fresh ownership proof), then `chat.send` went out — and a change
// made during the wait (a newer knowledge choice whose apply failed) was never seen.
// The class is closed here: every `chat.send` goes through `issueChatSend`, which runs
// the caller's gate — its last read (`refresh`) as the final await, then its check
// SYNCHRONOUSLY — and issues the request in the same tick: the request's frame is
// written inside `request()`'s own executor, so nothing can run in between. A source test (chat-send-gate.test.ts) fails if any other bridge file
// issues `chat.send` itself.
//
// The permission mode needs no gate of this kind: its "still current" check is the
// gateway's own, atomic with the send (`chat.send.expectedPermissionMode`).

/**
 * What a send must still hold, re-checked right before the request.
 *  - `refresh` (optional): the LAST await before the send — a fresh read of what the
 *    check needs (the session's knowledge override). Nothing else runs between it and
 *    the request but the synchronous `check`.
 *  - `check`: synchronous; throws to withhold the send.
 */
export interface ChatSendGate {
  refresh?: () => Promise<void>;
  check: () => void;
}

/** For sends into a session no conversation choice governs (a lossless-claw command
 *  session, a sub-agent's child session): nothing to re-check. Named, so a reader sees
 *  the decision instead of a missing argument. */
export const NO_CONVERSATION_CHOICE: ChatSendGate = { check: () => {} };

const WITHHELD = Symbol("chat-send-withheld");

/** Was this error thrown by the gate — i.e. was the request NEVER issued? */
export function wasWithheldBeforeSend(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { [WITHHELD]?: true })[WITHHELD] === true;
}

interface ChatSendTransport {
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ payload?: Record<string, unknown> }>;
}

function withheld(err: unknown): unknown {
  if (typeof err === "object" && err !== null) {
    (err as { [WITHHELD]?: true })[WITHHELD] = true;
  }
  return err;
}

export async function issueChatSend(
  via: ChatSendTransport,
  params: Record<string, unknown>,
  timeoutMs: number,
  gate: ChatSendGate,
): Promise<{ payload?: Record<string, unknown> }> {
  if (gate.refresh !== undefined) {
    try {
      await gate.refresh();
    } catch (err) {
      throw withheld(err);
    }
  }
  // From here to the request: synchronous. The frame is written inside `request()`'s
  // own executor, so the check and the send are one step.
  try {
    gate.check();
  } catch (err) {
    throw withheld(err);
  }
  return via.request("chat.send", params, timeoutMs);
}
