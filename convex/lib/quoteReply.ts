// Quote-reply prompt composition (pure): the SINGLE place that turns a stored
// quoted excerpt into the outgoing-prompt preamble, shared by the dispatch
// (convex/bridge.ts) and the rehydration (convex/stream.ts) so both providers
// and the rebuilt history read the exact same text. The user's stored message
// `text` stays clean — the preamble only ever exists on the wire.

import type { Locale } from "./locales";
import {
  effectiveTemplate,
  fillTemplate,
  resolveInjection,
  type PromptInjectionConfig,
} from "./promptInjections";

/** Server-side cap on a quoted excerpt (the client trims to ~280 already). */
export const QUOTE_EXCERPT_CAP = 500;

/** The resolved quote_reply preamble for an excerpt ("" never happens today:
 *  even disabled keeps the bare markdown quote — but stay total). */
export function quotePreamble(
  excerpt: string,
  config: PromptInjectionConfig | undefined,
  locale: Locale,
): string {
  const resolved = resolveInjection("quote_reply", config, locale);
  const template = effectiveTemplate("quote_reply", resolved, locale);
  return template === "" ? "" : fillTemplate(template, { excerpt });
}

/** Prefix `text` with the quote preamble (no-op on an empty preamble; an
 *  attachment-only turn — empty text — carries the bare preamble). */
export function composeQuotedText(preamble: string, text: string): string {
  if (preamble === "") return text;
  return text === "" ? preamble : `${preamble}\n\n${text}`;
}
