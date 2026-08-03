import { createContext } from "react";

// Where the thread-level "still working" indicator should ANCHOR: under the
// bubble whose sub-agent row carries the live work. Null = bottom-of-thread
// fallback (no anchor, or the anchor's bubble is not mounted). Without this a
// QUEUED follow-up sits between the working bubble and the indicator, and the
// signal reads as belonging to the WAITING user message (user report).
//
// It lives in its OWN module so both the thread (which computes it) and the
// per-message clock (which must not compute a second opinion of it) can read
// it without importing each other.
export interface TurnActivityAnchor {
  messageId: string;
  running: boolean;
  workingSince: number | null;
  /** The running work's own progress line, when it publishes one. */
  progressSummary: string | null;
}

export const TurnActivityAnchorContext =
  createContext<TurnActivityAnchor | null>(null);

/** Is a message of this thread actively STREAMING?
 *
 *  The thread's activity pill stands down while one is, because that bubble
 *  already shows its own dots. The question is answered from the messages'
 *  own status: a live-text row is not the same fact — one can outlive its
 *  message's terminal status until the stuck-stream watchdog sweeps it, and
 *  reading the row instead reported a stream that had ended, which stood the
 *  whole signal down while delegated work was still running.
 *
 *  `undefined` (not loaded yet) is NOT "streaming": an unknown thread must not
 *  suppress the signal. */
export function threadStreaming(
  messages: ReadonlyArray<{ status?: string }> | undefined,
): boolean {
  return messages !== undefined && messages.some((m) => m.status === "streaming");
}

/** Is a reply currently being COMPOSED — the window between a sub-agent
 *  finishing and its answer reaching the thread?
 *
 *  The freshness is the SERVER's answer (`deliveringTtlRemainingMs`), never a
 *  comparison of a server timestamp to the browser clock, which skew breaks.
 *  Because the server answers it, the value seen at the FIRST observation is
 *  usable as-is: reopening a conversation during a real delivery shows the
 *  indicator, and a long-stale value (a NO_REPLY announce that will never
 *  arrive) arrives already exhausted and shows nothing. The client used to have
 *  to choose between those two, and chose to miss the first.
 *
 *  `expired` is the LOCAL timer's verdict: the remaining time is not a reactive
 *  dependency, so a subscribed client that receives no further write must close
 *  the window itself — the same arrangement the running signal uses.
 *
 *  That verdict names WHICH delivery it closed, rather than being a flag. A flag
 *  outlives the delivery it was raised for: after one window elapsed (a NO_REPLY
 *  announce), the next sub-agent's fresh delivery arrived to find it still
 *  raised, and the signal cut out for the frame it took an effect to lower it —
 *  the same after-paint defect this whole change removes, one level down. A
 *  delivery that was never marked cannot be expired, so a new one is live on the
 *  render that first sees it. */
export interface DeliveryExpiry {
  chatId: string;
  key: number;
}

export function deliveryWindowOpen(
  chatId: string,
  deliveringSince: number | null,
  ttlRemainingMs: number | null,
  expired: DeliveryExpiry | null,
): boolean {
  if (deliveringSince === null || ttlRemainingMs === null) return false;
  if (ttlRemainingMs <= 0) return false;
  return !(expired?.chatId === chatId && expired.key === deliveringSince);
}
