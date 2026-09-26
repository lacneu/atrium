// Naming somebody in a group conversation, from the composer (the People tab of
// the room control, ConvexChat.tsx).
//
// A LIST, not an "@"-triggered autocomplete. The composer is a rich
// text surface whose caret this component does not own, and an autocomplete that
// mis-reads the caret inserts the name in the wrong place — a mention whose
// offsets do not match what was sent is refused by the gateway for the whole
// message, not just the mention. A click appends "@Name " at the end, which is
// where a writer is anyway, and the writer can then move it wherever they like:
// the span is located at SEND time, not now (see pendingMention).

/**
 * The token inserted for a person, and the key their mention is staged under.
 *
 * Display names are not unique and may contain spaces, so the token is the name
 * with its inner whitespace collapsed to a dot — stable, readable, and a single
 * word the writer can delete in one gesture. Two people who share a name get the
 * same BASE token; the composer makes it unique per message (nameInComposer adds
 * a suffix), so an occurrence can never be attributed to the wrong one.
 */
export function mentionTokenFor(name: string): string {
  const slug = name.trim().replace(/\s+/g, ".");
  return `@${slug.length > 0 ? slug : "?"}`;
}
