// Cross-conversation reference detection for the composer (pure, testable).
//
// A conversation reference is the env-labeled identifier family the app
// already hands out (`<label>-<chatId>`, e.g. `dev-m97…`, or the bare id):
// when the WHOLE pasted text is one candidate, the composer asks the server
// to resolve it into an attached markdown export. Anything else pastes as
// plain text — and so does a candidate the server does not recognize (the
// shape below is deliberately loose; the server is the actual validator).

const REFERENCE_SHAPE = /^(?:[a-z0-9][a-z0-9_.]{0,15}-)?[a-z0-9]{25,40}$/;

/** The trimmed paste when it LOOKS like a conversation reference, else null. */
export function parseChatReferenceCandidate(text: string): string | null {
  const trimmed = text.trim();
  return REFERENCE_SHAPE.test(trimmed) ? trimmed : null;
}
