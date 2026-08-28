// Quote-reply prompt composition (pure): the SINGLE place that turns a stored
// quoted excerpt into the outgoing-prompt preamble, shared by the dispatch
// (convex/bridge.ts) and the rehydration (convex/stream.ts) so both providers
// and the rebuilt history read the exact same text. The user's stored message
// `text` stays clean — the preamble only ever exists on the wire.

import type { Locale } from "./locales";
import {
  PROMPT_INJECTIONS,
  effectiveTemplate,
  fillTemplate,
  resolveInjection,
  type PromptInjectionConfig,
} from "./promptInjections";

/** Server-side cap on a quoted excerpt (the client trims to ~280 already). */
export const QUOTE_EXCERPT_CAP = 500;

/** How many passages ONE turn may quote. A quote is cheap to click and each one
 *  rides the outgoing prompt, so the count is bounded here rather than left to
 *  the composer. */
export const QUOTE_MAX_PER_TURN = 10;

/** Total budget for the excerpts of ONE turn, across all its quotes. Ten quotes
 *  at the per-excerpt cap would add 5 000 characters to every prompt; this is
 *  what actually keeps a heavily-quoted turn away from `context_length`. */
export const QUOTE_TOTAL_EXCERPT_CAP = 1_500;

/** Cap an excerpt WITHOUT splitting a character.
 *
 *  `slice` counts UTF-16 units: 499 ASCII characters followed by an emoji leaves
 *  a lone high surrogate, which is not valid Unicode — and Convex refuses to
 *  store it, so a perfectly good archive batch would fail atomically on an
 *  excerpt that was valid on the way in. Code points, then. */
export function capExcerpt(raw: string): string {
  const trimmed = raw.trim();
  const points = Array.from(trimmed);
  return points.length <= QUOTE_EXCERPT_CAP
    ? trimmed
    : points.slice(0, QUOTE_EXCERPT_CAP).join("");
}

/** One quoted passage. `messageId` is a `messages` id server-side and a plain
 *  string on the wire/client — the shape is otherwise identical. */
export type QuoteRef<Id extends string = string> = {
  /** Absent when the quoted message did not survive a fork or an import — the
   *  excerpt still stands, only the jump-to-source is gone. */
  messageId?: Id;
  /** The block within the quoted message; null = the whole message. */
  blockIndex: number | null;
  excerpt: string;
};

/** Why a passage, or a list of them, does not stand. */
export type QuoteIssue = "too-many" | "too-long" | "bad-item";

/** The BOUNDS AND SHAPE of a turn's quotes, applied in ONE place.
 *
 *  Two callers with two policies, never two implementations: `sendMessage`
 *  normalizes and REFUSES the turn if anything was dropped (the user chose these
 *  passages; sending fewer would answer a question they did not ask), while the
 *  archive import normalizes and KEEPS the remainder (an archive is a value in a
 *  file — it is bounded, not trusted). When only the send enforced them, an
 *  untrusted archive could persist thousands of passages that the rehydration
 *  and the summaries then concatenate into every outgoing prompt.
 *
 *  Applied in order: shape, per-excerpt cap, de-duplication by (message, block),
 *  count bound, total excerpt budget. */
export function normalizeQuoteRefs(raw: unknown): {
  refs: QuoteRef<string>[];
  issues: Set<QuoteIssue>;
} {
  const issues = new Set<QuoteIssue>();
  if (raw === undefined || raw === null) return { refs: [], issues };
  if (!Array.isArray(raw)) {
    issues.add("bad-item");
    return { refs: [], issues };
  }
  const refs: QuoteRef<string>[] = [];
  const seen = new Set<string>();
  let budget = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      issues.add("bad-item");
      continue;
    }
    const cand = item as Record<string, unknown>;
    if (typeof cand.excerpt !== "string") {
      issues.add("bad-item");
      continue;
    }
    const excerpt = capExcerpt(cand.excerpt);
    if (excerpt.length === 0) {
      issues.add("bad-item");
      continue;
    }
    const rawBlock = cand.blockIndex;
    const blockIndex =
      rawBlock === null || rawBlock === undefined ? null : rawBlock;
    if (
      blockIndex !== null &&
      (typeof blockIndex !== "number" ||
        !Number.isInteger(blockIndex) ||
        blockIndex < 0 ||
        blockIndex > 10_000)
    ) {
      issues.add("bad-item");
      continue;
    }
    const messageId =
      typeof cand.messageId === "string" ? cand.messageId : undefined;
    // Quoting the same block twice is a double click, not two passages. WITHOUT
    // an anchor there is no block to compare — two passages whose targets did
    // not survive a fork or an import share `undefined:0` and would collapse
    // into one, losing an excerpt for good — so the excerpt itself identifies
    // them there.
    const key =
      messageId !== undefined
        ? `id:${messageId}:${blockIndex ?? "all"}`
        : `raw:${blockIndex ?? "all"}:${excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (refs.length >= QUOTE_MAX_PER_TURN) {
      issues.add("too-many");
      continue;
    }
    if (budget + excerpt.length > QUOTE_TOTAL_EXCERPT_CAP) {
      issues.add("too-long");
      continue;
    }
    budget += excerpt.length;
    refs.push({
      ...(messageId !== undefined ? { messageId } : {}),
      blockIndex,
      excerpt,
    });
  }
  return { refs, issues };
}

/** The sendMessage policy: normalize, and refuse the turn if ANYTHING was
 *  dropped — with the reason, so the composer can say which. */
export function assertQuoteRefs(raw: unknown): QuoteRef<string>[] {
  const { refs, issues } = normalizeQuoteRefs(raw);
  if (issues.has("too-many")) {
    throw new Error("Invalid: too many quotes in one turn");
  }
  if (issues.has("too-long")) {
    throw new Error("Invalid: quoted excerpts exceed the per-turn budget");
  }
  if (issues.has("bad-item")) {
    throw new Error("Invalid: quote shape (empty or malformed excerpt)");
  }
  return refs;
}

/** The quote fields to WRITE on a message, in BOTH vintages.
 *
 *  ROLLBACK SAFETY, and it is the whole reason the singular fields are still
 *  written. A revision that stores only `quotedRefs` is fine until the deploy is
 *  rolled back: the previous code reads only the singular fields, so every quote
 *  written in between disappears from the thread, from the summaries and from
 *  the forks — and an outbox row still parked would dispatch with no preamble at
 *  all, sending "corrige ceci" with nothing bound to "ceci".
 *
 *  So the array is the truth and the singular fields mirror the FIRST passage:
 *  after a rollback the turn shows and sends ONE quote instead of N, which is
 *  exactly what that revision could do anyway. `quotedRefsOf` prefers the array,
 *  so the two never compete while both are present. */
export function quoteFieldsFor<Id extends string>(
  refs: readonly QuoteRef<Id>[],
): {
  quotedRefs?: QuoteRef<Id>[];
  quotedMessageId?: Id;
  quotedBlockIndex?: number;
  quotedExcerpt?: string;
} {
  const first = refs[0];
  if (first === undefined) return {};
  return {
    quotedRefs: [...refs],
    ...(first.messageId !== undefined
      ? { quotedMessageId: first.messageId }
      : {}),
    ...(first.blockIndex !== null ? { quotedBlockIndex: first.blockIndex } : {}),
    quotedExcerpt: first.excerpt,
  };
}

/** The same, for an OUTBOX row — where a rollback is worse still, because the
 *  row is a pending DISPATCH: read by code that only knows `quotedExcerpt`, a
 *  plural row would go out with no preamble whatsoever. */
export function outboxQuoteFieldsFor(excerpts: readonly string[]): {
  quotedExcerpts?: string[];
  quotedExcerpt?: string;
} {
  if (excerpts.length === 0) return {};
  return { quotedExcerpts: [...excerpts], quotedExcerpt: excerpts[0] };
}

/** A stored row's quotes, whatever its vintage: the SINGLE derivation of "what
 *  does this turn quote". Rows written before the feature carried several
 *  passages only have the singular `quoted*` fields; new rows carry `quotedRefs`
 *  and leave the singular ones absent. Every reader goes through here — the
 *  alternative (each site re-deriving) is exactly the defect this codebase has
 *  already paid for twice. */
export function quotedRefsOf(row: {
  quotedRefs?: readonly QuoteRef<never>[] | readonly QuoteRef<any>[];
  quotedMessageId?: string;
  quotedBlockIndex?: number;
  quotedExcerpt?: string;
}): readonly QuoteRef<any>[] {
  // DEFINED WINS, even empty. Preferring it only when non-empty would let a
  // divergent row — `quotedRefs: []` beside a stale singular mirror, which an
  // untrusted archive can hand us — resurrect a quote the array says is gone.
  if (row.quotedRefs !== undefined) return row.quotedRefs;
  if (row.quotedExcerpt === undefined) return [];
  return [
    {
      ...(row.quotedMessageId !== undefined
        ? { messageId: row.quotedMessageId }
        : {}),
      blockIndex: row.quotedBlockIndex ?? null,
      excerpt: row.quotedExcerpt,
    },
  ];
}

/** An OUTBOX row's excerpts, both vintages — the single derivation on the
 *  dispatch side, mirroring `quotedRefsOf` on the message side. The outbox
 *  carries excerpts only (the display anchors live on the message), because all
 *  the dispatch ever does with them is fill the preamble. */
export function outboxExcerpts(row: {
  quotedExcerpts?: readonly string[];
  quotedExcerpt?: string;
}): readonly string[] {
  // Same rule as `quotedRefsOf`: defined wins, even empty.
  if (row.quotedExcerpts !== undefined) return row.quotedExcerpts;
  return row.quotedExcerpt === undefined ? [] : [row.quotedExcerpt];
}

/** Whether this turn quotes anything — the content-eligibility predicate. A
 *  quoted excerpt IS content (an attachment-only quoted turn must reach the
 *  history), and asking `quotedExcerpt !== undefined` would answer NO for a
 *  multi-quote row. */
export function hasQuotes(row: Parameters<typeof quotedRefsOf>[0]): boolean {
  return quotedRefsOf(row).length > 0;
}

/** The `{excerpt}` fill value for a set of passages. ONE rendering for the three
 *  templates (default, plural default, disabled) — each of them writes
 *  `> {excerpt}`, so this carries only the SEPARATORS between passages: a blank
 *  quote line, which keeps two passages from reading as one continuous quote
 *  while staying a single markdown blockquote. */
export function renderExcerptList(excerpts: readonly string[]): string {
  return excerpts.join("\n>\n> ");
}

/** The resolved quote_reply preamble for an excerpt ("" never happens today:
 *  even disabled keeps the bare markdown quote — but stay total). */
export function quotePreamble(
  excerpt: string,
  config: PromptInjectionConfig | undefined,
  locale: Locale,
): string {
  return quotesPreamble([excerpt], config, locale);
}

/** The preamble for N passages. At N <= 1 this is byte-for-byte the one-quote
 *  composition (same template, same fill) — the plural wording is only ever
 *  reached above it, and only when the admin has NOT set their own template. */
export function quotesPreamble(
  excerpts: readonly string[],
  config: PromptInjectionConfig | undefined,
  locale: Locale,
): string {
  if (excerpts.length === 0) return "";
  return fillQuoteTemplate(
    pickQuoteTemplate(resolveQuoteTemplates(config, locale), excerpts.length),
    excerpts,
  );
}

/** The two effective templates for an instance: the one applied to a single
 *  passage, and the one applied to several. Resolved ONCE (the dispatch caches
 *  them on the routing so it needs no extra read) and picked per turn. */
export type QuoteTemplates = { readonly one: string; readonly many: string };

export function resolveQuoteTemplates(
  config: PromptInjectionConfig | undefined,
  locale: Locale,
): QuoteTemplates {
  const resolved = resolveInjection("quote_reply", config, locale);
  const one = effectiveTemplate("quote_reply", resolved, locale);
  const plural = PROMPT_INJECTIONS.quote_reply.pluralDefaultTemplate?.[locale];
  // An admin override IS the instance's chosen wording: it stays the wording at
  // any count, filled with the joined list. The plural default is only ever
  // reached for an instance that never touched the template.
  const customized =
    resolved.template !== PROMPT_INJECTIONS.quote_reply.defaultTemplate[locale];
  const many =
    !customized && resolved.enabled && plural !== undefined ? plural : one;
  return { one, many };
}

/** Which of the two applies to `count` passages. At count <= 1 this is always
 *  `one` — the single-quote composition is untouched by the widening. */
export function pickQuoteTemplate(t: QuoteTemplates, count: number): string {
  return count > 1 ? t.many : t.one;
}

/** Fill a picked template with the passages. */
export function fillQuoteTemplate(
  template: string,
  excerpts: readonly string[],
): string {
  return template === ""
    ? ""
    : fillTemplate(template, { excerpt: renderExcerptList(excerpts) });
}

/** Prefix `text` with the quote preamble (no-op on an empty preamble; an
 *  attachment-only turn — empty text — carries the bare preamble). */
export function composeQuotedText(preamble: string, text: string): string {
  if (preamble === "") return text;
  return text === "" ? preamble : `${preamble}\n\n${text}`;
}
