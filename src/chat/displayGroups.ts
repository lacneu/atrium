// DISPLAY GROUPS (transcript redesign, phase 5): consecutive bubbles of one delegation
// chain read as ONE answer. Convex computes the group of each bubble from the transcript's
// identities (convex/lib/delegationChain.ts) and stores it as `displayGroupId`; this helper
// only decides how the DISPLAYED list joins them. Consecutive only: a bubble whose cached
// group is not the one shown just above it stands alone, so a group never spans a message
// in between — whatever the cache says.

export type GroupedMessage = {
  _id: string;
  role: string;
  text: string;
  displayGroupId?: string;
};

export type GroupPlace = {
  /** Continues the bubble shown just above (no header of its own). */
  follows: boolean;
  /** Continued by the bubble shown just below (no action bar of its own). */
  continues: boolean;
  /** The group's FIRST bubble: what the group's Delete / Regenerate and Report act on —
   *  the answer starts there (codex phase 5 pass 1 #4). */
  firstId: string;
  /** Every member's text, in order: what Copy, Read aloud and the whole-answer quote take. */
  groupText: string;
};

/** Where each displayed message sits in its display group (absent: alone). */
export function displayGroupPlaces(list: readonly GroupedMessage[]): Map<string, GroupPlace> {
  const out = new Map<string, GroupPlace>();
  let run: GroupedMessage[] = [];
  const flush = () => {
    if (run.length > 1) {
      const groupText = run
        .map((r) => r.text.trim())
        .filter((t) => t !== "")
        .join("\n\n");
      const firstId = run[0]!._id;
      run.forEach((m, i) => {
        out.set(m._id, { follows: i > 0, continues: i < run.length - 1, firstId, groupText });
      });
    }
    run = [];
  };
  for (const m of list) {
    const joins =
      m.role === "assistant" &&
      m.displayGroupId !== undefined &&
      run.length > 0 &&
      run[run.length - 1]!.displayGroupId === m.displayGroupId;
    if (!joins) flush();
    if (m.role === "assistant" && m.displayGroupId !== undefined) run.push(m);
  }
  flush();
  return out;
}

/** What the display groups of a list depend on: the positions (ids, cached groups, which
 *  bubble streams) and the TEXT of every settled grouped bubble — its real content, never a
 *  proxy (codex phase 5 pass 4 #3: a same-length correction kept the old text behind Copy,
 *  Quote, Read aloud and Report). A streaming bubble's text is left out: it changes per
 *  token and the actions are hidden while it streams. */
export type GroupInputs = { key: string; texts: ReadonlyArray<string | null> };

export function groupInputsOf(list: readonly (GroupedMessage & { status?: string })[]): GroupInputs {
  const grouped = list.filter((m) => m.displayGroupId !== undefined);
  return {
    key: list
      .map((m) => (m.displayGroupId !== undefined ? `${m._id}:${m.displayGroupId}:${m.status === "streaming" ? "live" : ""}` : m._id))
      .join("|"),
    texts: grouped.map((m) => (m.status === "streaming" ? null : m.text)),
  };
}

/** Whether the groups must be recomputed. Texts compare by value — cheap when unchanged:
 *  the same string objects come back between renders. */
export function groupInputsChanged(prev: GroupInputs | null, next: GroupInputs): boolean {
  if (prev === null || prev.key !== next.key || prev.texts.length !== next.texts.length) return true;
  for (let i = 0; i < next.texts.length; i++) if (prev.texts[i] !== next.texts[i]) return true;
  return false;
}

/** The message an action that WRITES or DELETES sends: always the bubble the reader acted
 *  on — never the group's head (codex phase 5 pass 9 #1). The server resolves where the
 *  group starts (`deletionStart`, `groupOfReported`) from what it can prove; a head the
 *  client substituted could cross a message the client cannot see. Read-only displays may
 *  use `groupFirstId` / `groupText`. */
export function writeTargetId(custom: { messageId?: string; groupFirstId?: string | null } | undefined): string | undefined {
  return custom?.messageId;
}
