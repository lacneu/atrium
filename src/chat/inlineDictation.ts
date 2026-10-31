// THE INLINE COMPOSER'S DICTATION RULES (0.103.1), out of the React controller so the exact
// code the controller runs is also what the property tests drive (sendWhileDictating.test.ts).
// The controller (ConvexChat.tsx `useDictationController`) keeps the pinned-panel routing;
// everything that writes the INLINE draft, decides what a send carries, or retires a local
// session goes through here.

import { appendDictated, visibleDictationText } from "./dictationHold";
import {
  localDictationEventAllowed,
  retireForNewSession,
  type ComposerDictationSession,
} from "./dictationSessionGuard";
import type { DictationHandle } from "./speech";

/** The composer as these rules read and write it. */
export type InlineHost = {
  /** The conversation the (shared) composer shows now. */
  chatId: () => string;
  getText: () => string;
  setText: (text: string) => void;
};

export type InlineSession = ComposerDictationSession & {
  h: DictationHandle | null;
  boundToHold: boolean;
  holdGen?: number;
  /** The engine is listening (the mic shows live). */
  recording: boolean;
  /** The engine reported its end: nothing more will come from it. */
  ended?: boolean;
};

/** A final of `session`: appended to the inline draft when it may write it. */
export function inlineFinal(
  session: InlineSession,
  live: InlineSession | null,
  host: InlineHost,
  text: string,
  paragraph: boolean,
): boolean {
  // A session that belonged to a pin never writes the inline draft once the pin is gone.
  if (session.stale || session.boundToHold) return false;
  if (!localDictationEventAllowed(session, live, host.chatId())) return false;
  host.setText(appendDictated(host.getText(), text, paragraph));
  return true;
}

/** May `session`'s hypothesis be shown under the composer (and so join a send)? */
export function inlineHypothesisShown(
  session: InlineSession,
  live: InlineSession | null,
  host: InlineHost,
): boolean {
  return !session.boundToHold && localDictationEventAllowed(session, live, host.chatId());
}

/** A new session starts: the previous local one is retired, and the words it was still
 *  finalizing after the user's Stop join the draft once (retireForNewSession). */
export function retirePreviousForStart(prev: InlineSession | null, host: InlineHost): void {
  if (prev === null) return;
  if (prev.boundToHold) {
    prev.stale = true;
    return;
  }
  const folded = retireForNewSession(prev);
  if (folded !== null && host.chatId() === prev.startedChatId) {
    host.setText(appendDictated(host.getText(), folded, false));
  }
  prev.h?.discard();
}

/** Does the live local session still own words that a send must carry — listening, or
 *  stopped but still finalizing? Once it does, the send goes through takeComposerForSend. */
export function sessionOwnsWords(live: InlineSession | null): boolean {
  return (
    live !== null &&
    !live.stale &&
    !live.boundToHold &&
    (live.recording || live.finalizing === true)
  );
}

/** The composer's text is about to be SENT (or pinned): the live local session — listening
 *  OR stopped but still finalizing (0.103.1, Codex pass 8) — is retired now, in the same
 *  step, and the text returned is exactly what the composer showed: its text plus the
 *  session's hypothesis (the ghost stays shown while it finalizes). Nothing the session
 *  says afterwards reaches any draft. */
export function takeComposerForSend(live: InlineSession | null, host: InlineHost): string {
  let text = host.getText();
  if (sessionOwnsWords(live)) {
    const s = live as InlineSession;
    if (s.startedChatId === host.chatId()) text = visibleDictationText(text, s.lastInterim ?? "");
    s.stale = true;
    s.recording = false;
    s.finalizing = false;
    s.h?.discard();
  }
  host.setText(text);
  return text;
}
