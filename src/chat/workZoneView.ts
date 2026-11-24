// A WORK ZONE of an assistant bubble: a run of the turn's work — the model's thoughts, the
// agent's work notes, its activity groups — between two pieces of the answer. Pure, so the
// rules are tested without a render.
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
  /** Stable for the zone: the bubble and the zone's first part. */
  key: string;
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
  args?: Record<string, unknown>;
  data?: { key?: string; live?: boolean } & Record<string, unknown>;
};

type Kind = "thinking" | "note" | "action";

function workKind(part: Part): Kind | null {
  if (part.type === "data-thinking") return "thinking";
  if (part.type === "data-commentary") return "note";
  if (part.type === "tool-call" && part.toolName === "__turn_flow__") return "action";
  return null;
}

/** Stamp each part of a zone that holds a thought with its zone (`data.zone` on a thought
 *  or a note, `args.zone` on an activity group). An empty text part renders nothing and
 *  ends no zone. Run once the parts' `live` is settled. */
export function markWorkZones<T extends { type: string }>(content: T[], messageId: string): void {
  const parts = content as unknown as Part[];
  let run: Array<{ at: number; kind: Kind }> = [];
  const close = () => {
    const members = run;
    run = [];
    const thoughts = members.filter((x) => x.kind === "thinking").length;
    if (thoughts === 0) return;
    const first = parts[members[0]!.at]!;
    const proseHeadAt = members.find((x) => x.kind !== "action")!.at;
    const zone = {
      key: `${messageId}:${first.toolCallId ?? first.data?.key ?? members[0]!.at}`,
      thoughts,
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
    if (kind !== null) run.push({ at, kind });
    else if (!(part.type === "text" && (part.text ?? "").trim() === "")) close();
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

// The reader's choice per zone, shared by the parts of the zone (each is its own component
// under MessagePrimitive.Parts) and kept while the page lives.
const chosenByZone = new Map<string, boolean>();
const listeners = new Set<() => void>();

export function zoneChoice(key: string): boolean | undefined {
  return chosenByZone.get(key);
}
export function chooseZone(key: string, open: boolean): void {
  chosenByZone.set(key, open);
  for (const l of listeners) l();
}
export function subscribeZones(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
