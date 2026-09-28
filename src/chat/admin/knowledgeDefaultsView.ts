// The admin card "Connaissances par agent" (Settings ▸ chat defaults): an agent's DEFAULT
// knowledge policy on its gateway — injection mode + default sources among those the
// operator allows (convex/knowledge.ts setAgentKnowledgeDefault). Pure: every decision is
// here and unit-tested; the card only renders it.

import { m } from "@/paraglide/messages.js";

export const KNOWLEDGE_INJECTION_OPTIONS = ["auto", "hybrid", "tool", "off"] as const;
export type KnowledgeInjectionOption = (typeof KNOWLEDGE_INJECTION_OPTIONS)[number];

export function injectionLabel(v: KnowledgeInjectionOption): string {
  switch (v) {
    case "auto":
      return m.cdefaults_knowledge_injection_auto();
    case "hybrid":
      return m.cdefaults_knowledge_injection_hybrid();
    case "tool":
      return m.cdefaults_knowledge_injection_tool();
    default:
      return m.cdefaults_knowledge_injection_off();
  }
}

/** One row of `api.knowledge.agentKnowledgePage`. */
export interface AgentKnowledgeRow {
  agentId: string;
  available: boolean;
  reason: string | null;
  injection: string | null;
  defaultSources: string[];
  overridesAllowed: boolean;
  sources: Array<{ id: string; label: string; description: string }>;
  defaultWriteRefused: string | null;
  /** The raw config view (the baseline the write is checked against), when known. */
  config?: { injection: string | null; sources: string[] | null } | null;
  /** The plugin's contract level (1 = openclaw-knowledge 4.0.x). */
  contract?: number;
  /** The agent has its OWN `allowedSources` in the config (null = not known). */
  ownAllowlist?: boolean | null;
}

/** What the admin was shown — the effective default AND the raw view it rests on. */
export function expectedOf(row: AgentKnowledgeRow): {
  injection: string;
  defaultSources: string[];
  config?: { injection: string | null; sources: string[] | null };
} {
  return {
    injection: row.injection ?? "auto",
    defaultSources: row.defaultSources,
    ...(row.config ? { config: row.config } : {}),
  };
}

export interface AgentDefaultDraft {
  injection: KnowledgeInjectionOption;
  sources: string[];
}

export function isInjectionOption(v: unknown): v is KnowledgeInjectionOption {
  return typeof v === "string" && (KNOWLEDGE_INJECTION_OPTIONS as readonly string[]).includes(v);
}

/** The draft an agent row starts from: exactly its stored default. */
export function draftOf(row: AgentKnowledgeRow): AgentDefaultDraft {
  return {
    injection: isInjectionOption(row.injection) ? row.injection : "auto",
    sources: row.defaultSources.filter((id) => row.sources.some((s) => s.id === id)),
  };
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  return sa.size === new Set(b).size && b.every((x) => sa.has(x));
}

export interface AgentDefaultForm {
  /** Why the default cannot be edited here (null = it can). */
  readOnlyReason: string | null;
  dirty: boolean;
  /** At least one source: "off" is the injection mode, never an empty selection. */
  valid: boolean;
  invalidReason: string | null;
}

export function agentDefaultForm(
  row: AgentKnowledgeRow,
  draft: AgentDefaultDraft,
  supported: boolean,
): AgentDefaultForm {
  const readOnlyReason = !supported
    ? m.cdefaults_knowledge_unsupported()
    : row.defaultWriteRefused === "scope_refused"
      ? m.cdefaults_knowledge_readonly_scope()
      : defaultTooOld(row)
        ? m.cdefaults_knowledge_plugin_too_old()
        : null;
  const stored = draftOf(row);
  const dirty =
    draft.injection !== stored.injection || !sameSet(draft.sources, stored.sources);
  const allowed = new Set(row.sources.map((s) => s.id));
  const valid =
    draft.sources.length > 0 &&
    draft.sources.length <= 16 &&
    draft.sources.every((id) => allowed.has(id));
  return {
    readOnlyReason,
    dirty,
    valid,
    invalidReason: valid ? null : m.cdefaults_knowledge_pick_one(),
  };
}

/**
 * openclaw-knowledge 4.0.x and an agent KNOWN to have no allowlist of its own: its
 * default cannot be written from Atrium without narrowing its allowlist (the bridge
 * refuses it, `plugin_too_old` — codex pass 18). Unknown (no raw view) is not assumed:
 * the bridge decides at the write.
 */
export function defaultTooOld(row: AgentKnowledgeRow): boolean {
  return (row.contract ?? 1) < 2 && row.ownAllowlist === false;
}

/** The toggled draft (keeps the plugin's allowlist order). */
export function toggleDraftSource(
  row: AgentKnowledgeRow,
  draft: AgentDefaultDraft,
  id: string,
): AgentDefaultDraft {
  const next = draft.sources.includes(id)
    ? draft.sources.filter((x) => x !== id)
    : [...draft.sources, id];
  return {
    ...draft,
    sources: row.sources.map((s) => s.id).filter((x) => next.includes(x)),
  };
}

/** The outcome of a save, in the admin's words (null = saved). */
export function saveOutcomeText(
  out: { ok: true } | { ok: false; code: string; reason?: string },
): string | null {
  if (out.ok) return null;
  if (out.code === "scope_refused") return m.cdefaults_knowledge_readonly_scope();
  if (out.code === "stale_default") return m.cdefaults_knowledge_stale();
  // The answer was lost and could not be read back: neither saved nor refused.
  // …and so is a write the config carries but the plugin had not shown in time.
  if (out.code === "write_unknown" || out.code === "not_confirmed") {
    return m.cdefaults_knowledge_unknown();
  }
  if (out.code === "not_applied") return m.cdefaults_knowledge_not_applied();
  if (out.code === "default_too_large") return m.cdefaults_knowledge_too_large();
  if (out.code === "allowlist_too_large") return m.cdefaults_knowledge_allowlist_too_large();
  if (out.code === "plugin_too_old") return m.cdefaults_knowledge_plugin_too_old();
  if (out.code === "source_not_allowed") return m.cdefaults_knowledge_source_not_allowed();
  if (out.code === "plugin_config_lag") return m.cdefaults_knowledge_config_lag();
  if (out.code === "knowledge_unavailable" && out.reason === "plugin_absent") {
    return m.cdefaults_knowledge_absent();
  }
  return m.cdefaults_knowledge_error({ code: out.code });
}

/**
 * Has the live row moved away from the one the admin opened? Compared like the bridge
 * compares the write: the raw config view EXACTLY (order and nulls included), the
 * effective default by content, the injection mode.
 */
export function baselineDiverged(base: AgentKnowledgeRow, live: AgentKnowledgeRow): boolean {
  const a = expectedOf(base);
  const b = expectedOf(live);
  if (a.injection !== b.injection || !sameSet(a.defaultSources, b.defaultSources)) return true;
  const ca = a.config;
  const cb = b.config;
  if (ca === undefined || cb === undefined) return ca !== cb;
  const sameRaw = (x: string[] | null, y: string[] | null) =>
    x === null || y === null ? x === y : x.length === y.length && x.every((v, i) => v === y[i]);
  return ca.injection !== cb.injection || !sameRaw(ca.sources, cb.sources);
}
