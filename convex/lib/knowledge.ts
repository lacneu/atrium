/**
 * WHICH KNOWLEDGE SOURCES AN AGENT SEARCHES — who may choose, and what a turn carries.
 *
 * The `openclaw-knowledge` plugin (>= 4.0) resolves a turn's policy as: session override
 * > agent default > global default. Atrium drives the first two (convex/knowledge.ts):
 * the conversation OWNER chooses per agent; everyone else in the room sees the choice.
 * An administrator edits the agent default. Atrium never offers a source the plugin does
 * not list for the agent (its allowlist, read by discovery) — the plugin re-validates on
 * every write and every read anyway.
 *
 * Pure (no Convex runtime import).
 */

export const KNOWLEDGE_INJECTIONS = ["auto", "hybrid", "tool", "off"] as const;
export type KnowledgeInjection = (typeof KNOWLEDGE_INJECTIONS)[number];

export function isKnowledgeInjection(v: unknown): v is KnowledgeInjection {
  return typeof v === "string" && (KNOWLEDGE_INJECTIONS as readonly string[]).includes(v);
}

/** At most this many agents carry a knowledge choice in one conversation — enforced at
 *  WRITE time, and exactly what a fork copies (convex/chatFork.ts): a fork can never
 *  drop an `off` the origin holds (codex pass 6). */
export const MAX_KNOWLEDGE_CHOICES_PER_CHAT = 50;

/** The plugin's own bound on a selection (1..16 ids, contract §4.1). */
export const MAX_KNOWLEDGE_SOURCES = 16;

export type KnowledgeChoice =
  | { kind: "default" }
  | { kind: "off" }
  | { kind: "sources"; sources: string[]; injection?: "auto" | "hybrid" | "tool" };

/** The discovery row the rules read (`agentKnowledge`). */
export interface AgentKnowledgeFacts {
  available: boolean;
  overridesAllowed?: boolean;
  injection?: string;
  sources?: Array<{ id: string }>;
}

export type KnowledgeChoiceRefusal =
  | "not_owner"
  | "not_openclaw"
  | "unavailable"
  | "overrides_disabled"
  | "source_not_allowed"
  | "invalid";

/** Why this choice is refused to this person, or null when they may make it. */
export function knowledgeChoiceRefusal(input: {
  isOwner: boolean;
  provider: string;
  facts: AgentKnowledgeFacts | null;
  choice: KnowledgeChoice;
}): KnowledgeChoiceRefusal | null {
  if (!input.isOwner) return "not_owner";
  if (input.provider !== "openclaw") return "not_openclaw";
  if (input.facts === null || !input.facts.available) return "unavailable";
  // Back to the agent default is always possible, overrides disabled included: it
  // removes Atrium's choice, never adds an override — the owner's way out of a choice
  // the operator no longer allows (the bridge counts the plugin's refusal of that
  // reset as satisfied: with overrides disabled it ignores session state anyway).
  if (input.choice.kind === "default") return null;
  if (input.facts.overridesAllowed !== true) return "overrides_disabled";
  if (input.choice.kind === "off") return null;
  const { sources } = input.choice;
  if (sources.length === 0 || sources.length > MAX_KNOWLEDGE_SOURCES) return "invalid";
  if (new Set(sources).size !== sources.length) return "invalid";
  const allowed = new Set((input.facts.sources ?? []).map((s) => s.id));
  if (!sources.every((id) => allowed.has(id))) return "source_not_allowed";
  return null;
}

/**
 * What a /send carries of the conversation's choice for this turn's agent:
 *  - nothing, when nobody chose for that agent or it is not an OpenClaw instance;
 *  - `refuse`, when a non-default choice would reach a bridge not CONFIRMED to apply it
 *    (an older bridge ignores the field and the turn would search sources the owner
 *    turned off) — the turn is withheld by name instead;
 *  - the choice and its revision otherwise. "default" on an unconfirmed bridge is not
 *    refused while no override was ever left on a session (it asks nothing beyond the
 *    operator's own configuration) — and is, while one may still be there.
 */
export function dispatchKnowledgeChoice(input: {
  stored: { choice: KnowledgeChoice; revision: number; overrideEver?: boolean } | null;
  provider: string;
  confirmed: boolean;
}): { send: { choice: KnowledgeChoice; revision: number } } | { refuse: true } | null {
  if (input.stored === null || input.provider !== "openclaw") return null;
  if (!input.confirmed) {
    if (input.stored.choice.kind !== "default") return { refuse: true };
    // `default` asks nothing of the gateway — UNLESS an override Atrium put on a session
    // may still be there: such a bridge cannot reset it, so the turn would run under
    // it (codex P2, a rollback). Withheld until a reset is confirmed. A legacy row
    // (flag unknown) is treated as "may be there".
    return input.stored.overrideEver === false ? null : { refuse: true };
  }
  return { send: { choice: input.stored.choice, revision: input.stored.revision } };
}

/** The sources a choice selects, given the agent's default (for display). */
export function effectiveSelection(
  choice: KnowledgeChoice | null,
  agentDefault: { injection: string | null; defaultSources: string[] },
): { off: boolean; sources: string[] } {
  if (choice === null || choice.kind === "default") {
    return {
      off: agentDefault.injection === "off",
      sources: agentDefault.injection === "off" ? [] : [...agentDefault.defaultSources],
    };
  }
  if (choice.kind === "off") return { off: true, sources: [] };
  return { off: false, sources: [...choice.sources] };
}

/** Bounded, defensive copy of the bridge's `knowledge.sources` projection. */
export function normalizeKnowledgeFacts(raw: unknown):
  | {
      available: true;
      config?: { injection: string | null; sources: string[] | null };
      ownAllowlist?: boolean;
      contract?: number;
      observedAt?: number;
      configured: boolean;
      injection: KnowledgeInjection;
      defaultSources: string[];
      overridesAllowed: boolean;
      sources: Array<{ id: string; type: string; label: string; description: string; default: boolean }>;
    }
  | { available: false; reason: string; observedAt?: number }
  | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const observedAt =
    typeof r.observedAt === "number" && Number.isFinite(r.observedAt) ? r.observedAt : undefined;
  if (r.available === false) {
    const reason =
      typeof r.reason === "string" && /^[a-z_]{1,32}$/.test(r.reason) ? r.reason : "unreadable";
    return { available: false, reason, ...(observedAt === undefined ? {} : { observedAt }) };
  }
  if (r.available !== true) return null;
  const info = (r.info ?? r) as Record<string, unknown>;
  if (!isKnowledgeInjection(info.injection)) return null;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const isId = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 64;
  const sources = Array.isArray(info.sources)
    ? info.sources
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
        .filter((s) => isId(s.id))
        .slice(0, 64)
        .map((s) => ({
          id: s.id as string,
          type: str(s.type, 32) || "unknown",
          label: str(s.label, 200) || (s.id as string),
          description: str(s.description, 1_000),
          default: s.default === true,
        }))
    : [];
  // The raw config view, when the bridge read it: kept only if well-formed.
  const c = r.config as { injection?: unknown; sources?: unknown } | undefined;
  const config =
    c !== undefined &&
    c !== null &&
    (c.injection === null || (typeof c.injection === "string" && c.injection.length <= 32)) &&
    (c.sources === null ||
      (Array.isArray(c.sources) &&
        // Past the bound the view is DROPPED, never cut (codex pass 14): a cut baseline
        // would miss a change in the part it lost.
        c.sources.length <= 64 &&
        c.sources.every((x) => typeof x === "string" && x.length <= 64)))
      ? {
          injection: c.injection as string | null,
          sources: c.sources === null ? null : [...(c.sources as string[])],
        }
      : undefined;
  // Rides with the raw view (same config snapshot), never without it.
  const ownAllowlist =
    config !== undefined && typeof r.ownAllowlist === "boolean" ? r.ownAllowlist : undefined;
  const contract =
    typeof info.contract === "number" && Number.isInteger(info.contract) && info.contract >= 2 && info.contract <= 1_000
      ? info.contract
      : undefined;
  return {
    available: true,
    ...(config === undefined ? {} : { config }),
    ...(ownAllowlist === undefined ? {} : { ownAllowlist }),
    ...(contract === undefined ? {} : { contract }),
    ...(observedAt === undefined ? {} : { observedAt }),
    configured: info.configured === true,
    injection: info.injection,
    defaultSources: Array.isArray(info.defaultSources)
      ? info.defaultSources.filter(isId).slice(0, 64)
      : [],
    overridesAllowed: info.overridesAllowed === true,
    sources,
  };
}
