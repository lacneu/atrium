// The TYPE of an error whose message carries text a provider SENT — an OpenClaw gateway's
// answered refusal or connect refusal, a Hermes JSON-RPC error, an undecodable response body.
// A LEAF module on purpose (no imports): the provider clients use it, and the log helper
// (core/log-safe-error.ts) recognises it, without either importing the other.
//
// Why a type and not a text rule: whether an error's words may reach the bridge's log is
// decided by WHERE they came from, never by what they say. A provider's text interpolates
// operator- and user-chosen values (session keys, file names, paths) that have no business in
// the bridge's log; the full text stays in the provider's own log, which belongs to its
// operator. An error Atrium builds ITSELF (a refused URL scheme, a local signing failure, a
// local timeout) is NOT of this type: no provider log could explain it, so it keeps its words.
//
// TWO carriers of the same fact, because JavaScript has single inheritance: a standalone class
// (`GatewayTextError`), and the `RECEIVED_PROVIDER_TEXT` brand a received-text SUBCLASS of a
// provider's local error class declares (`GatewayAnsweredError extends OpenClawError`), so
// `instanceof OpenClawError` — what the dispatch classification and the callers test — keeps
// holding for both kinds.

export const RECEIVED_PROVIDER_TEXT: unique symbol = Symbol("atrium.receivedProviderText");

/** What the log helper reads off a received-text error. `logSummary`, when present, is built
 *  by Atrium from constants only (never from the received text) and may be logged. */
export interface ReceivedProviderText {
  readonly [RECEIVED_PROVIDER_TEXT]: true;
  readonly logSummary?: string;
}

export function isReceivedProviderText(err: unknown): err is Error & ReceivedProviderText {
  return (
    err instanceof Error &&
    (err as Partial<ReceivedProviderText>)[RECEIVED_PROVIDER_TEXT] === true
  );
}

/** A standalone error carrying provider text. */
export class GatewayTextError extends Error implements ReceivedProviderText {
  readonly [RECEIVED_PROVIDER_TEXT] = true as const;
}
