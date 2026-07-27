// WHICH notice sits above the composer, if any.
//
// Four conditions can want the same strip of screen, and the order between them is a
// judgement, not an accident — so it lives here as a pure function with a test rather
// than as the shape of a JSX ternary chain nobody can assert.
//
// The order is by URGENCY TO THE PERSON TYPING:
//   1. read_only    — you cannot send at all, and it is about your permissions;
//   2. unavailable  — you cannot send right now, the gateway is down;
//   3. degraded     — you can send, but this turn may fail;
//   4. beyond_validated — you can send and it will work; your gateway is simply newer
//      than anything we have benched.
//
// The first three are about THIS send. The fourth is a standing condition that will
// still be true tomorrow, which is exactly why it yields to the others: a person whose
// send is blocked does not need to hear about version validation.

export type ChatBannerKind =
  | "read_only"
  | "unavailable"
  | "degraded"
  | "beyond_validated"
  | null;

export function chatBannerKind(state: {
  /** The chat is bound to an agent the user is no longer entitled to. */
  readOnly: boolean;
  /** The instance the NEXT send would target is down. */
  unavailable: boolean;
  /** That instance answers, but reports itself degraded. */
  degraded: boolean;
  /** The gateway is newer than `maxValidated`; capabilities are frozen at the last
   *  validated profile (W10 / G7). */
  beyondValidated: boolean;
}): ChatBannerKind {
  if (state.readOnly) return "read_only";
  if (state.unavailable) return "unavailable";
  if (state.degraded) return "degraded";
  if (state.beyondValidated) return "beyond_validated";
  return null;
}
