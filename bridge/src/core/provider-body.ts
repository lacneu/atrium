// DECODING a body a provider sent, through one door.
//
// `JSON.parse` and `Response.json()` throw a SyntaxError that QUOTES the body
// ("Unexpected token 'P', \"PRIVATE…\" is not valid JSON"), and a SyntaxError is an ordinary
// local-looking error: the log helper would have printed it whole. Every decode of a provider
// response goes through here instead, and an undecodable body becomes a
// `ProviderBadResponseError` whose message names only WHICH response (a constant chosen by the
// caller) — never a byte of the body — and whose type tells the log helper it stems from
// received text. The SyntaxError is deliberately NOT kept as `cause`: it would carry the body
// to any reader that walks the chain.

import { GatewayTextError } from "./gateway-text-error.js";

export class ProviderBadResponseError extends GatewayTextError {
  readonly code = "BAD_RESPONSE";
  readonly logSummary: string;
  /** `source` names the response ("Hermes ws-ticket"): a constant, never received text. */
  constructor(readonly source: string) {
    super(`${source}: the response body could not be decoded [BAD_RESPONSE]`);
    this.name = "ProviderBadResponseError";
    this.logSummary = `${source} [BAD_RESPONSE]`;
  }
}

/** `JSON.parse` of a provider's text. */
export function parseProviderJson<T = unknown>(text: string, source: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderBadResponseError(source);
  }
}

/** The JSON body of a provider's HTTP response (in place of a bare `res.json()`). Only a
 *  DECODE failure (`SyntaxError`, which quotes the body) is replaced; a body that cannot even
 *  be READ (a cut stream, an abort) is a transport failure and propagates as such. */
export async function readProviderJson<T = unknown>(
  res: { json(): Promise<unknown> },
  source: string,
): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof SyntaxError) throw new ProviderBadResponseError(source);
    throw err;
  }
}
