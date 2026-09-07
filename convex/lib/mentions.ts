// Mentioning somebody in a conversation.
//
// A mention is a SPAN of the message text plus the person it names. Storing the
// span rather than re-finding "@Name" later is what keeps the highlight honest:
// two people can share a display name, a name can contain another name, and a
// person can be renamed after the fact — none of which may change what a message
// meant when it was sent.
//
// THE RULES BELOW MIRROR THE GATEWAY'S. Atrium forwards mentions to OpenClaw when
// the instance can carry them, and upstream rejects the WHOLE send if the spans do
// not re-anchor on the text (`INVALID_MENTIONS`). A mention Atrium accepts but the
// gateway refuses would cost the person their turn, so the stricter of the two
// rules is applied here, at the source: offsets are UTF-16 code units, spans are
// ordered and disjoint, each one starts with "@", none splits a surrogate pair,
// and there are at most ten.

/** Upstream's ceiling (`MAX_HUMAN_MENTIONS`, 2026.9.2). Mirrored, not guessed. */
export const MAX_MENTIONS = 10;

/** Upstream's per-token ceiling: "@" plus at most 256 characters. */
export const MAX_MENTION_TOKEN_LENGTH = 257;

export interface MentionSpan {
  /** Offsets into the message text, in UTF-16 code units — the unit both
   *  JavaScript's `String.length` and the gateway's normalizer count in. */
  start: number;
  end: number;
}

export type MentionRejection =
  | "too_many"
  | "out_of_bounds"
  | "empty_span"
  | "overlapping"
  | "not_a_mention_token"
  | "token_too_long"
  | "control_character"
  | "splits_a_character";

/**
 * Validate spans against the text they were computed on. Returns the first reason
 * a span is unusable, or null when every span is sound.
 *
 * Returns a REASON rather than throwing: the caller decides whether an unusable
 * mention drops the mention or refuses the message, and those are different
 * answers on the send path and on the forward path.
 */
export function rejectMentionSpans(
  text: string,
  spans: readonly MentionSpan[],
): MentionRejection | null {
  if (spans.length > MAX_MENTIONS) return "too_many";
  let previousEnd = -1;
  for (const span of spans) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) {
      return "out_of_bounds";
    }
    if (span.start < 0 || span.end > text.length) return "out_of_bounds";
    if (span.end <= span.start) return "empty_span";
    // Ordered AND disjoint: upstream walks the spans once, in order, so an
    // out-of-order pair is not merely untidy — it re-anchors against the wrong
    // offset and the whole send is refused.
    if (span.start < previousEnd) return "overlapping";
    previousEnd = span.end;

    const token = text.slice(span.start, span.end);
    if (token.length > MAX_MENTION_TOKEN_LENGTH) return "token_too_long";
    if (!token.startsWith("@")) return "not_a_mention_token";
    // eslint-disable-next-line no-control-regex -- the point is to find them
    if (/[\u0000-\u001f\u007f]/.test(token)) return "control_character";
    // A span must not cut a character in half: slicing between a high and a low
    // surrogate yields a lone half, which no renderer and no normalizer can put
    // back together.
    if (splitsSurrogatePair(text, span.start) || splitsSurrogatePair(text, span.end)) {
      return "splits_a_character";
    }
  }
  return null;
}

/** True when `index` falls BETWEEN the two halves of one character. */
function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Shift every span by a prefix the sender never typed.
 *
 * The bridge prepends conversation history when it re-hydrates a session, so the
 * text the gateway sees is not the text the offsets were computed on. Shifting is
 * exact because the prefix is PREPENDED — nothing is inserted inside the message —
 * and because both sides count UTF-16 code units.
 */
export function shiftMentionSpans<T extends MentionSpan>(
  spans: readonly T[],
  prefixLength: number,
): T[] {
  if (prefixLength === 0) return [...spans];
  return spans.map((s) => ({ ...s, start: s.start + prefixLength, end: s.end + prefixLength }));
}

/**
 * How many code units a composition PREPENDED, given the text before and after.
 *
 * Used where a preamble is composed rather than passed around: the quoted-reply
 * preamble is built in one expression, and the honest way to learn its length is
 * to measure it. Returns null when `after` does not END with `before` — that is
 * not a prepend, and shifting by a difference would move the spans somewhere
 * arbitrary. A null means "do not send mentions for this turn", which costs the
 * mention; guessing would cost the whole turn.
 */
export function prependedLength(before: string, after: string): number | null {
  if (after === before) return 0;
  if (!after.endsWith(before)) return null;
  return after.length - before.length;
}
