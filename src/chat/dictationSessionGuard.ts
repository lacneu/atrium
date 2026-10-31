// WHICH DICTATION A CALLBACK BELONGS TO (0.103.1).
//
// The composer's dictation controller is reused across conversations, and an engine keeps
// talking for a moment after it is told to stop (its last final, its `end`). A callback of
// a session that is no longer the live one — retired by a navigation, a send, or a newer
// session — must touch NOTHING the reader now sees: not the draft, not the hypothesis
// shown under it (an hypothesis of conversation A once rode B's send). Pure, so the rule
// is tested without a render.

export type ComposerDictationSession = {
  /** The conversation the session started in. */
  startedChatId: string;
  /** Retired: a navigation or a send ended it; anything it still says is dropped. */
  stale: boolean;
  /** The user stopped it and the engine is still settling its last words (its stop grace). */
  finalizing?: boolean;
  /** The hypothesis it last showed ("" once a final settled it). */
  lastInterim?: string;
};

/** May this LOCAL (un-pinned) session's callback write the composer's draft or its
 *  hypothesis? Only while it is THE live session, not retired, and its conversation is
 *  the one shown. */
export function localDictationEventAllowed(
  session: ComposerDictationSession,
  live: ComposerDictationSession | null,
  currentChatId: string,
): boolean {
  return !session.stale && live === session && currentChatId === session.startedChatId;
}

/** A new session starts: the previous one is RETIRED (whatever it says later is dropped)
 *  and, if the user had stopped it and its last words were still being finalized, the
 *  hypothesis it showed is returned to be folded into the draft — once, here, in the same
 *  synchronous step as the retirement, so its late final can never add them twice. */
export function retireForNewSession(prev: ComposerDictationSession | null): string | null {
  if (prev === null || prev.stale) return null;
  const pending = prev.finalizing === true ? (prev.lastInterim ?? "") : "";
  prev.stale = true;
  prev.lastInterim = "";
  return pending.trim() !== "" ? pending : null;
}
