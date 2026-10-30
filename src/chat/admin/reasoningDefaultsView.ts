// The admin card "Raisonnement" (Settings ▸ chat defaults, 0.103.0): the instance's
// reasoning DEFAULT and the agents that are EXCEPTIONS to it (convex/lib/reasoningDisplay.ts —
// the conversation's own choice comes first, then the agent's exception, then the instance).
// Pure: every decision the card shows is here and unit-tested; the card only renders it.
// Built to hold a hundred agents and more: the card lists only the exceptions, and a new one
// is picked from a searchable list.

/** One agent of `api.agents.listAgentsForInstance`, as the card reads it. */
export interface ReasoningAgentRow {
  agentId: string;
  displayName: string | null;
  enabled: boolean;
  /** The agent's exception: true shown, false hidden, null none (the instance decides). */
  showReasoningDefault: boolean | null;
  /** false = gone from the gateway (hidden everywhere in the UI). */
  presentInLastOk?: boolean;
}

/** Beyond this many exceptions the list gets a filter field above it. */
export const EXCEPTION_FILTER_THRESHOLD = 8;

export function agentName(a: Pick<ReasoningAgentRow, "agentId" | "displayName">): string {
  return a.displayName ?? a.agentId;
}

/** The id is shown beside the name only when it tells two agents apart (a name that is the
 *  id in another case says nothing more). */
export function showsAgentId(a: Pick<ReasoningAgentRow, "agentId" | "displayName">): boolean {
  return a.displayName !== null && a.displayName.toLowerCase() !== a.agentId.toLowerCase();
}

/** Search key: case- and accent-insensitive, surrounding spaces ignored. */
export function foldForSearch(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/** Does `a` match `query` by its name or its id (empty query: everything)? */
export function matchesAgent(a: Pick<ReasoningAgentRow, "agentId" | "displayName">, query: string): boolean {
  const q = foldForSearch(query);
  if (q === "") return true;
  return foldForSearch(agentName(a)).includes(q) || foldForSearch(a.agentId).includes(q);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural order by name ("agent-2" before "agent-10"), the id breaking ties. */
export function compareAgents(
  a: Pick<ReasoningAgentRow, "agentId" | "displayName">,
  b: Pick<ReasoningAgentRow, "agentId" | "displayName">,
): number {
  return collator.compare(agentName(a), agentName(b)) || collator.compare(a.agentId, b.agentId);
}

export interface ExceptionRow {
  agent: ReasoningAgentRow;
  /** The exception's value: shown or hidden. */
  show: boolean;
  /** The exception says what the instance says (kept: it is explicit, and survives a
   *  later change of the instance's default). */
  sameAsDefault: boolean;
}

/** Every agent with an exception, in natural order. */
export function exceptionsOf(agents: readonly ReasoningAgentRow[], instanceDefault: boolean): ExceptionRow[] {
  return agents
    .filter((a): a is ReasoningAgentRow & { showReasoningDefault: boolean } => a.showReasoningDefault !== null)
    .sort(compareAgents)
    .map((agent) => ({ agent, show: agent.showReasoningDefault, sameAsDefault: agent.showReasoningDefault === instanceDefault }));
}

/** The exceptions the list shows under its filter (no filter below the threshold). */
export function visibleExceptions(rows: readonly ExceptionRow[], filter: string): ExceptionRow[] {
  if (!exceptionFilterShown(rows.length)) return [...rows];
  return rows.filter((r) => matchesAgent(r.agent, filter));
}

export function exceptionFilterShown(count: number): boolean {
  return count > EXCEPTION_FILTER_THRESHOLD;
}

/** The agents "Ajouter une exception" offers for `query`: only those WITHOUT an exception,
 *  never one gone from the gateway; enabled agents first, then disabled ones, each in
 *  natural order. */
export function addCandidates(agents: readonly ReasoningAgentRow[], query: string): ReasoningAgentRow[] {
  const open = agents.filter(
    (a) => a.showReasoningDefault === null && a.presentInLastOk !== false && matchesAgent(a, query),
  );
  return [...open.filter((a) => a.enabled).sort(compareAgents), ...open.filter((a) => !a.enabled).sort(compareAgents)];
}

/** The value a NEW exception starts with: the opposite of the instance's default — the only
 *  exception that changes anything. Editable afterwards. */
export function newExceptionValue(instanceDefault: boolean): boolean {
  return !instanceDefault;
}

/** The position of the keyboard's chosen agent in the list (−1 = none, or no longer offered).
 *  The choice is held by AGENT ID, never by position: the list is recomputed whenever the
 *  agents change — a save landing while it is open — and a position would then name another
 *  agent (codex pass 4 on 0.103.0). */
export function activeCandidateIndex(candidates: readonly ReasoningAgentRow[], activeId: string | null): number {
  return activeId === null ? -1 : candidates.findIndex((a) => a.agentId === activeId);
}

/** What Enter adds: the chosen agent while it is still offered; with none chosen, the first
 *  match; NOTHING when the chosen one has left the list (never another agent in its place). */
export function enterPick(candidates: readonly ReasoningAgentRow[], activeId: string | null): ReasoningAgentRow | null {
  if (activeId === null) return candidates[0] ?? null;
  return candidates.find((a) => a.agentId === activeId) ?? null;
}

/** The option the keyboard moves to in a list of `length` options (−1 = none active). */
export function nextActiveIndex(current: number, key: string, length: number): number {
  if (length === 0) return -1;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(current + 1, length - 1);
    case "ArrowUp":
      return current <= 0 ? 0 : current - 1;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return Math.min(current, length - 1);
  }
}
