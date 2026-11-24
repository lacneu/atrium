// A WORK ZONE of an assistant bubble: a run of the turn's work — the model's thoughts, the
// agent's work notes, its activity groups — between two pieces of the answer. No render
// needed, so the rules are tested without one.
//
// WHAT IS WORK IS READ FROM THE PART'S TYPE, never guessed from its place: a thought is a
// `data-thinking` part and a work note a `data-commentary` part (the nature the bridge
// stored, or the row's own — convertMessage.ts), an activity group is the `__turn_flow__`
// tool-call. A `text` part is the answer, wherever it sits: text between two actions is an
// answer segment, it ends the zone before it and a new one starts after it.
//
// A zone that holds a thought is headed ONCE (WorkZone.tsx) and that header
// folds the whole zone. A zone without one (reasoning not shown: actions and notes only)
// has no header and never folds: its lines are already one line each.

export type WorkZoneMark = {
  /** The zone's name: the bubble and the zone's first thought. */
  key: string;
  /** What the reader's fold is kept under: the bubble and each thought of the zone (see
   *  the store below). */
  thoughtIds: readonly string[];
  /** This part opens the zone… */
  head: boolean;
  /** …or is its first thought or note, which opens it when the actions are hidden. */
  proseHead: boolean;
  thoughts: number;
  notes: number;
  /** Activity groups: one line each. */
  actions: number;
  /** One of its thoughts may still be being written. */
  live: boolean;
};

type Part = {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: { parts?: readonly unknown[] } & Record<string, unknown>;
  data?: { key?: string; live?: boolean; text?: string; capped?: boolean; row?: unknown } & Record<string, unknown>;
};

type Kind = "thinking" | "note" | "action";

/** Does a thought show a block: it names a row to read, holds a text, or says it was cut.
 *  The one rule of ThinkingBlock and of the zones. */
export function thoughtShown(data: { text?: string; capped?: boolean; row?: unknown } | undefined): boolean {
  return data?.row !== undefined || (data?.text ?? "").trim() !== "" || data?.capped === true;
}

/** Does a work note show a block: it has a text left (an `[embed]` shortcode beside its
 *  widget is taken out of it, widgets/shortcodes.ts). The one rule of CommentaryNote and
 *  of the zones. */
export function noteShown(text: string | undefined): boolean {
  return (text ?? "").trim() !== "";
}

/** A part of the turn's work, `nothing` for a part that shows nothing, null for anything
 *  else (the answer, a file). A part that shows nothing is no member of a zone — it can
 *  carry no header, and counts for no step — and ends none. */
function workKind(part: Part): Kind | "nothing" | null {
  if (part.type === "data-thinking") return thoughtShown(part.data) ? "thinking" : "nothing";
  if (part.type === "data-commentary") return noteShown(part.data?.text) ? "note" : "nothing";
  if (part.type === "tool-call" && part.toolName === "__turn_flow__") {
    return (part.args?.parts ?? []).length > 0 ? "action" : "nothing";
  }
  if (part.type === "text" && (part.text ?? "").trim() === "") return "nothing";
  return null;
}

/** Stamp each part of a zone that holds a thought with its zone (`data.zone` on a thought
 *  or a note, `args.zone` on an activity group). A part that shows nothing (an empty text,
 *  a note emptied of its shortcode) ends no zone and is not stamped: the header is always
 *  carried by a part that renders. Run once the parts' `live` is settled.
 *
 *  A ZONE IS NAMED BY ITS THOUGHTS, never by its place or by its first part: what arrives
 *  before a thought or between two (an action row the transcript delivers late, a note)
 *  changes neither, and a thought's key is its own within the bubble (one per row,
 *  `row:<entryId>`; one per stored part, `p<index>`) where a note's is not (a row's text
 *  pieces around a file share theirs). */
export function markWorkZones<T extends { type: string }>(content: T[], messageId: string): void {
  const parts = content as unknown as Part[];
  let run: Array<{ at: number; kind: Kind }> = [];
  const close = () => {
    const members = run;
    run = [];
    const thinking = members.filter((x) => x.kind === "thinking");
    if (thinking.length === 0) return;
    const thoughtIds = thinking.map((x) => `${messageId}:${parts[x.at]!.data?.key ?? x.at}`);
    inheritZoneChoice(thoughtIds);
    const proseHeadAt = members.find((x) => x.kind !== "action")!.at;
    const zone = {
      key: thoughtIds[0]!,
      thoughtIds,
      thoughts: thinking.length,
      notes: members.filter((x) => x.kind === "note").length,
      actions: members.filter((x) => x.kind === "action").length,
      live: members.some((x) => parts[x.at]!.data?.live === true),
    };
    members.forEach(({ at, kind }, i) => {
      const part = parts[at]!;
      const mark: WorkZoneMark = { ...zone, head: i === 0, proseHead: at === proseHeadAt };
      parts[at] =
        kind === "action" ? { ...part, args: { ...part.args, zone: mark } } : { ...part, data: { ...part.data, zone: mark } };
    });
  };
  parts.forEach((part, at) => {
    const kind = workKind(part);
    if (kind === null) close();
    else if (kind !== "nothing") run.push({ at, kind });
  });
  close();
}

/** Does this part carry its zone's header: the zone's first part the reader sees. */
export function zoneHeadedBy(zone: WorkZoneMark | undefined, showTools: boolean): boolean {
  return zone !== undefined && (showTools ? zone.head : zone.proseHead);
}

/** The steps a folded zone stands for: what it would show, one per line or thought. */
export function zoneSteps(zone: WorkZoneMark, showTools: boolean): number {
  return zone.thoughts + zone.notes + (showTools ? zone.actions : 0);
}

/** Is a zone unfolded. Reasoning reaches the view only where the conversation shows it
 *  (convex/lib/reasoningDisplay.ts), so a zone that has some is on view — during the turn
 *  and after it. Only the reader folds one. */
export function zoneExpanded(chosen: boolean | undefined): boolean {
  return chosen ?? true;
}

// THE READER'S FOLD, shared by the parts of the zone (each is its own component under
// MessagePrimitive.Parts) and kept while the page lives.
//
// Kept under EACH THOUGHT of the zone, and read back as the latest choice made on any
// thought the zone holds now. So the fold follows the reasoning the reader folded, whatever
// the zone becomes while the turn is written or its rows replace its live parts: a part
// arriving before or inside it, an earlier thought, a piece of answer that splits it in two
// (both halves keep the fold), two zones becoming one (the later choice). And two zones
// never share a fold: no thought is in both.
// A THOUGHT THAT JOINS A ZONE THE READER CHOSE ON TAKES THAT CHOICE, when the zone is
// composed (`markWorkZones`, at each conversion — not at the click alone, nor at a render
// that may not happen): a thought that arrived folded with its zone stays folded when a
// piece of answer later sets it apart. It takes the choice as it stands (same turn), so the
// zone reads the same before and after, no listener is told, and nothing re-renders. The
// store holds one entry per thought of a zone the reader chose on, and no more.
// What it does not survive, declared: a thought whose own key changes — a live reasoning
// part (`p<index>`) replaced by the transcript row that persists it (`row:<entryId>`), or
// a stored part inserted before it — and a reload of the page.
const chosenByThought = new Map<string, { open: boolean; turn: number }>();
let turns = 0;
const listeners = new Set<() => void>();

export function zoneChoice(zone: Pick<WorkZoneMark, "thoughtIds">): boolean | undefined {
  let last: { open: boolean; turn: number } | undefined;
  for (const id of zone.thoughtIds) {
    const c = chosenByThought.get(id);
    if (c !== undefined && (last === undefined || c.turn > last.turn)) last = c;
  }
  return last?.open;
}
function inheritZoneChoice(thoughtIds: readonly string[]): void {
  let last: { open: boolean; turn: number } | undefined;
  for (const id of thoughtIds) {
    const c = chosenByThought.get(id);
    if (c !== undefined && (last === undefined || c.turn > last.turn)) last = c;
  }
  if (last === undefined) return;
  for (const id of thoughtIds) if (!chosenByThought.has(id)) chosenByThought.set(id, last);
}
export function chooseZone(zone: Pick<WorkZoneMark, "thoughtIds">, open: boolean): void {
  turns += 1;
  for (const id of zone.thoughtIds) chosenByThought.set(id, { open, turn: turns });
  for (const l of listeners) l();
}
export function subscribeZones(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
