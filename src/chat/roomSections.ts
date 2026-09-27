// THE ROOM CONTROL'S LOWER PART — who could JOIN (agents to add, people to invite) —
// is folded by default: the nominal gesture is addressing who is already here, and a
// long list of everyone else pushed the room itself out of sight.
//
// It unfolds on its own when folding would hide the only thing worth looking at:
//   - the reader is searching (a typed name must find its match wherever it lives);
//   - nobody is here to address (a new conversation: adding is the next step).

export function joinSectionOpen(opts: {
  /** The reader unfolded it with the section's toggle. */
  unfolded: boolean;
  /** A search term is typed in the tab's field. */
  searching: boolean;
  /** How many rows of THIS tab address someone already in the room (the reader
   *  themself excluded: naming yourself notifies nobody). */
  hereCount: number;
}): boolean {
  return opts.unfolded || opts.searching || opts.hereCount === 0;
}

type AgentKey = { instanceName: string; agentId: string };
type AddableAgent = AgentKey & { displayName: string | null };

const keyOf = (a: AgentKey) => `${a.instanceName}\u0000${a.agentId}`;

/**
 * The agents the reader may ADD that the list does not already show (a manager's
 * own agents: their pool is the room), narrowed by the search term. "Not shown"
 * is judged on the WHOLE list, never on the searched one: an agent the search hid
 * from the list is not a different agent to add.
 */
export function addableOutsideList<A extends AddableAgent>(
  listed: readonly AgentKey[],
  addable: readonly A[],
  term: string,
): A[] {
  const shown = new Set(listed.map(keyOf));
  const t = term.trim().toLocaleLowerCase();
  return addable
    .filter((a) => !shown.has(keyOf(a)))
    .filter(
      (a) =>
        t === "" ||
        [a.displayName, a.agentId, a.instanceName]
          .filter((v): v is string => Boolean(v))
          .some((v) => v.toLocaleLowerCase().includes(t)),
    );
}
