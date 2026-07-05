// Fixed, NON-administrable catalogue of agent TYPES. An agent's type tells Atrium
// HOW it may be used: a "conversational" agent backs normal chat; a "documentary"
// (source documentaire) agent is invoked by a specific Atrium action for a dedicated
// treatment (wired separately); a "summarizer" agent is invoked by the hybrid-
// rehydration engine to maintain conversation summaries (falls back to the chat's
// own agent when none is granted on the chat's instance). An agent may hold SEVERAL
// types (e.g. conversational AND documentary) or just one.
//
// The `code` is the STABLE, non-visible identifier — stored on `agents.types` and
// referenced by Atrium actions; it is NEVER shown to users and never changes. The
// human LABEL is internationalised and lives in the frontend messages, keyed
// `agent_type_<code>` (see src — the catalogue here is the single source of the
// CODES; labels are resolved per-locale in the UI). This list is code-defined and
// not editable from any admin screen.

export const AGENT_TYPE_CODES = [
  "conversational",
  "documentary",
  "summarizer",
  "curator",
] as const;
export type AgentTypeCode = (typeof AGENT_TYPE_CODES)[number];

/** Membership guard for validating a stored / incoming code. */
export const AGENT_TYPE_CODE_SET: ReadonlySet<string> = new Set(AGENT_TYPE_CODES);

/** An ENABLED agent with no explicit types is CONVERSATIONAL by default. */
export const DEFAULT_AGENT_TYPE: AgentTypeCode = "conversational";

/**
 * Resolve the EFFECTIVE types of an agent: the stored explicit list filtered to
 * KNOWN codes + de-duplicated, falling back to the default (conversational) when it
 * is unset / empty / all-unknown. NEVER returns empty — an agent always carries at
 * least one type. Order follows AGENT_TYPE_CODES for a stable display.
 */
export function resolveAgentTypes(
  types: readonly string[] | undefined | null,
): AgentTypeCode[] {
  const present = new Set((types ?? []).filter((c) => AGENT_TYPE_CODE_SET.has(c)));
  if (present.size === 0) return [DEFAULT_AGENT_TYPE];
  return AGENT_TYPE_CODES.filter((c) => present.has(c));
}

/**
 * Validate + normalise an incoming types array for storage: every code MUST be in
 * the catalogue (throws on an unknown one — never silently dropped), de-duplicated,
 * ordered by the catalogue. An empty result is allowed at the storage layer
 * (resolveAgentTypes turns it back into the default on read).
 */
export function normalizeAgentTypes(types: readonly string[]): AgentTypeCode[] {
  for (const c of types) {
    if (!AGENT_TYPE_CODE_SET.has(c)) {
      throw new Error(`Unknown agent type: ${c}`);
    }
  }
  const present = new Set(types);
  return AGENT_TYPE_CODES.filter((c) => present.has(c));
}
