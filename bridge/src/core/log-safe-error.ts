// What the bridge may WRITE TO ITS LOG about a failure.
//
// A provider's refusal is built from the text it sent (`<CODE>: <message>`, a close reason, a
// Hermes reply), and that text carries whatever the provider interpolated: session keys, file
// names, paths, operator-chosen codes. The bridge's log is not the place for it — the provider
// keeps the full sentence in ITS log, which belongs to its operator; the bridge keeps the
// SHAPE: the error's class and, for an answered refusal, the closed-vocabulary shape
// (`answeredRefusalShape`); the call sites that classify a failure print its dispatch code
// beside it. An error raised by Atrium itself, with no provider text in
// its cause chain, keeps its message.
//
// The decision is made on the TYPE of the errors in the cause chain (core/gateway-text-error.ts:
// only the classes built FROM received text carry the mark), never on the text: a text rule
// would have to recognise every way a provider can phrase a path.

import { answeredRefusalShape } from "./answered-refusal-shape.js";
import { isReceivedProviderText } from "./gateway-text-error.js";

/** True when `err` or a cause behind it carries text a provider sent. */
export function carriesGatewayText(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (isReceivedProviderText(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The loggable description of a failure: the message of an internal error; for an error
 *  carrying provider text, its class name and the filtered shape —
 *  never its message, never its `details`. */
export function errForLog(err: unknown): string {
  if (!carriesGatewayText(err)) {
    return err instanceof Error ? err.message : String(err);
  }
  const name = err instanceof Error ? err.constructor.name : "Error";
  // A summary Atrium composed from constants (e.g. which response failed to decode).
  let summary: string | undefined;
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error && summary === undefined; depth++) {
    if (isReceivedProviderText(current)) summary = current.logSummary;
    current = (current as { cause?: unknown }).cause;
  }
  const shape = answeredRefusalShape(err);
  return (
    name +
    (summary === undefined ? "" : ` ${summary}`) +
    (shape === null ? "" : ` answered=${JSON.stringify(shape)}`) +
    " (provider text withheld; see the provider's own log)"
  );
}
