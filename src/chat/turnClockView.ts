import { formatDurationShort } from "@/lib/format";

// Pure derivation for the live "Working for 5 min 21 s" turn clock shown above
// an in-flight assistant message (ChatGPT/Codex-style).
//
// ANTI-SKEW (repo convention, cf. deliveringSince in ConvexChat): the SERVER
// timestamp is compared to the local clock ONCE — at the first client
// observation of the streaming message — and clamped at 0. From then on the
// clock ticks purely LOCALLY, so a skewed client is off by a small constant
// instead of accumulating drift, and a turn already minutes old when the page
// loads still shows its honest age.

/** Baseline age of the turn at first observation: how old the server-created
 *  message already is on the local clock, clamped ≥ 0 under skew. */
export function turnBaselineMs(
  creationTimeMs: number,
  observedAtLocalMs: number,
): number {
  return Math.max(0, observedAtLocalMs - creationTimeMs);
}

/** Elapsed time of the in-flight turn: the frozen baseline plus purely local
 *  ticking since the first observation. */
export function turnElapsedMs(
  baselineMs: number,
  firstObservedLocalMs: number,
  nowLocalMs: number,
): number {
  return baselineMs + Math.max(0, nowLocalMs - firstObservedLocalMs);
}

/** WHEN the clock runs, as a pure decision.
 *
 *  A turn is "still being treated" in exactly two shapes, and the clock must
 *  cover both: the message is STREAMING, or the thread's activity signal is
 *  ANCHORED on this very message — the delegated shape, which stays true both
 *  while a sub-agent runs AND while its reply is being composed.
 *
 *  It takes the anchored message id rather than deriving one: the thread
 *  already decides where the "still working" indicator belongs, and this must
 *  be the SAME verdict. A second derivation is how the clock came to switch off
 *  off at "the agent is finalising its reply" while the pill below stayed on —
 *  running window and the delivering window are not the same window, and only
 *  one place should know that.
 *
 *  `anchoredMessageId` null = no delegated work is anchored anywhere.
 *  `messageId` undefined = the bubble has no identity yet (optimistic, not yet
 *  persisted). The guard is on THAT side, not on the anchor's: an absent
 *  identity must never match, whatever absent value the anchor happens to
 *  carry — a `!== null` guard on the anchor reads like the same protection and
 *  gives none. */
export function turnClockActive(
  streaming: boolean,
  anchoredMessageId: string | null,
  messageId: string | undefined,
): boolean {
  if (streaming) return true;
  return messageId !== undefined && anchoredMessageId === messageId;
}

/** Human label for the clock ("42 s", "5 min 21 s"); null hides the clock
 *  (formatDurationShort contract on non-finite input). A sub-second elapsed
 *  reads "< 1 s" — shown as-is (the clock appears immediately, like Codex). */
export function turnClockLabel(elapsedMs: number): string | null {
  return formatDurationShort(elapsedMs);
}
