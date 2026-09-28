// WHICH KNOWLEDGE SOURCES THE NEXT AGENT SEARCHES — the composer "+" menu's
// "Connaissances" section, decided here and only rendered by React.
//
// Rules (convex/knowledge.ts, lib/knowledge.ts): the plugin lists what an agent MAY
// search (its allowlist); the agent has a default; the conversation OWNER may choose
// otherwise for this conversation and this agent; everyone else sees the choice. Turning
// every source off means "no knowledge" (`off`), since the plugin needs at least one
// source in a selection.
//
// Pure module (no React): every branch — parameterized messages included — is unit-tested
// without a DOM.

import { m } from "@/paraglide/messages.js";
import type { KnowledgeChoice } from "../../convex/lib/knowledge";
import { effectiveSelection } from "../../convex/lib/knowledge";

/** What `api.knowledge.knowledgeControl` returns. */
export interface KnowledgeControlData {
  target: { instanceName: string; agentId: string };
  provider: string;
  viewerRole: string;
  supported: boolean;
  facts: {
    available: boolean;
    reason: string | null;
    injection: string | null;
    defaultSources: string[];
    overridesAllowed: boolean;
    sources: Array<{ id: string; label: string; description: string }>;
  } | null;
  choice: KnowledgeChoice | null;
  apply: { status: string; reason?: string; dropped?: string[] } | null;
}

export interface KnowledgeItem {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  /** Chosen, but the operator took it out of the agent's allowlist since: not searched,
   *  not selectable (codex pass 15). */
  unavailable: boolean;
}

export interface KnowledgeView {
  /** Nothing to show: no plugin, Hermes, a bridge that cannot apply it, no source. */
  hidden: boolean;
  items: KnowledgeItem[];
  /** Why the toggles are not the viewer's to change (null = they are). */
  readOnlyReason: string | null;
  /** Where the effective selection comes from. */
  origin: "agent" | "conversation";
  originLabel: string;
  /** No source is searched (the owner turned all off, or the agent's default is off). */
  allOff: boolean;
  /** The way back to the agent default is offered (an owner with a conversation choice). */
  canReset: boolean;
  status: string | null;
  statusIsError: boolean;
  /** The agent has no selectable source any more, while a conversation choice stands:
   *  the section stays for the way back (codex pass 17). */
  emptyNote: string | null;
}

const HIDDEN: KnowledgeView = {
  hidden: true,
  items: [],
  readOnlyReason: null,
  origin: "agent",
  originLabel: "",
  allOff: false,
  canReset: false,
  emptyNote: null,
  status: null,
  statusIsError: false,
};

/** A refusal reason (closed vocabulary from the bridge / Convex), in the reader's words. */
export function knowledgeReasonText(reason: string | undefined): string {
  switch (reason) {
    case "plugin_absent":
      return m.chat_knowledge_reason_plugin_absent();
    case "overrides_disabled":
      return m.chat_knowledge_reason_overrides_disabled();
    case "source_not_allowed":
    case "unknown_source":
      return m.chat_knowledge_reason_source_not_allowed();
    case "unsupported_gateway":
      return m.chat_knowledge_reason_unsupported();
    case "scope_refused":
      return m.chat_knowledge_reason_scope();
    default:
      return m.chat_knowledge_reason_other();
  }
}

export function knowledgeView(d: KnowledgeControlData | null | undefined): KnowledgeView {
  if (d === null || d === undefined) return HIDDEN;
  // Feature detection: no plugin (or an unreadable one), Hermes, or a bridge that cannot
  // put a choice on a session — nothing is offered.
  if (d.provider !== "openclaw" || !d.supported) return HIDDEN;
  const facts = d.facts;
  if (facts === null || !facts.available) return HIDDEN;
  const choice = d.choice;
  const conversation = choice !== null && choice.kind !== "default";
  // No source left to offer: nothing to show — UNLESS a conversation choice stands, whose
  // way back to the agent default (always allowed) must stay reachable (codex pass 17).
  if (facts.sources.length === 0 && !conversation) return HIDDEN;
  const selection = effectiveSelection(choice, {
    injection: facts.injection,
    defaultSources: facts.defaultSources,
  });
  const readOnlyReason =
    d.viewerRole !== "owner"
      ? m.chat_knowledge_readonly_participant()
      : !facts.overridesAllowed
        ? m.chat_knowledge_readonly_overrides()
        : null;
  let status: string | null = null;
  let statusIsError = false;
  // The chosen ids the operator's allowlist clamped out, as the last turn reported them.
  const dropped =
    d.apply?.status === "clamped" && choice !== null && Array.isArray(d.apply.dropped)
      ? d.apply.dropped
      : [];
  if (d.apply !== null && choice !== null) {
    if (d.apply.status === "pending") status = m.chat_knowledge_pending();
    else if (d.apply.status === "deferred") status = m.chat_knowledge_deferred();
    else if (d.apply.status === "failed") {
      status = m.chat_knowledge_failed({ reason: knowledgeReasonText(d.apply.reason) });
      statusIsError = true;
    } else if (d.apply.status === "clamped" && dropped.length > 0) {
      // The turn went, searching fewer of the chosen sources: said, by name.
      const names = dropped.map((id) => facts.sources.find((s) => s.id === id)?.label ?? id);
      status =
        names.length === 1
          ? m.chat_knowledge_clamped_one({ source: names[0]! })
          : m.chat_knowledge_clamped_many({ sources: names.join(", ") });
    }
  }
  return {
    hidden: false,
    items: facts.sources.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      checked: !selection.off && selection.sources.includes(s.id) && !dropped.includes(s.id),
      unavailable: dropped.includes(s.id),
    })),
    readOnlyReason,
    origin: conversation ? "conversation" : "agent",
    originLabel: conversation
      ? // Ticked sources are SEARCHED (codex pass 13): over an agent default that is
        // off, the bridge turns retrieval on for them — said, not implied.
        choice.kind === "sources" && facts.injection === "off"
        ? m.chat_knowledge_origin_conversation_over_off()
        : m.chat_knowledge_origin_conversation()
      : m.chat_knowledge_origin_agent(),
    allOff: selection.off || selection.sources.length === 0,
    // Offered to the owner whenever a conversation choice stands — even when overrides
    // are disabled: it removes Atrium's choice and never adds an override, and it is the
    // owner's way out of a choice the operator no longer allows (the bridge counts the
    // plugin's `overrides_disabled` refusal of the reset as satisfied).
    canReset: d.viewerRole === "owner" && conversation,
    status,
    statusIsError,
    emptyNote: facts.sources.length === 0 ? m.chat_knowledge_no_sources() : null,
  };
}

/**
 * The owner's choice after toggling one source, from what is effective now. Every source
 * off is `off`; selecting sources over an agent whose default injection is `off` turns
 * retrieval on (`auto`) — otherwise the selection would change nothing.
 */
export function toggledChoice(
  d: KnowledgeControlData,
  sourceId: string,
): KnowledgeChoice {
  const facts = d.facts;
  const selection = effectiveSelection(d.choice, {
    injection: facts?.injection ?? null,
    defaultSources: facts?.defaultSources ?? [],
  });
  const current = selection.off ? [] : selection.sources;
  const allowed = new Set((facts?.sources ?? []).map((s) => s.id));
  const next = current.includes(sourceId)
    ? current.filter((id) => id !== sourceId)
    : [...current, sourceId];
  const kept = next.filter((id) => allowed.has(id));
  if (kept.length === 0) return { kind: "off" };
  // Keep the plugin's own order: the allowlist's.
  const ordered = (facts?.sources ?? []).map((s) => s.id).filter((id) => kept.includes(id));
  return {
    kind: "sources",
    sources: ordered,
    ...(facts?.injection === "off" ? { injection: "auto" as const } : {}),
  };
}

// --- Quick toggles (codex P2) -----------------------------------------------------------
//
// Two toggles faster than the server's answer used to compute BOTH from the same Convex
// state, so the second undid the first (graph+docs, untick graph, untick docs → graph
// left on instead of off). The composer keeps the owner's latest choice locally until the
// server reflects it: every toggle starts from it, and the section shows it at once.
// Mutations from one client are applied in order, so the last one sent is the one kept.

export function sameKnowledgeChoice(a: KnowledgeChoice | null, b: KnowledgeChoice | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind !== "sources" || b.kind !== "sources") return true;
  return (
    a.injection === b.injection &&
    a.sources.length === b.sources.length &&
    a.sources.every((id) => b.sources.includes(id))
  );
}

/** What a toggle starts from and the section shows: the pending local choice, if any. */
export function withPending(
  d: KnowledgeControlData,
  pending: KnowledgeChoice | null,
): KnowledgeControlData {
  return pending === null ? d : { ...d, choice: pending };
}

// --- Pending choices, per target agent (codex pass 12) ---------------------------------
//
// A per-turn chat moves between agents: ONE pending slot, dropped on every switch, lost
// A's choice when the owner went A → B → A before the server answered (the next click on
// A started from the old selection and undid the first), and a failed mutation for A
// could clear B's. Each target keeps its own entry; a mutation settles only its own.

/** One target's pending choice: the owner's latest pick, how many of its mutations are
 *  still in flight, and the generation of the latest pick. */
export interface PendingKnowledgeEntry {
  choice: KnowledgeChoice;
  inFlight: number;
  gen: number;
}
export type PendingKnowledgeChoices = Readonly<Record<string, PendingKnowledgeEntry>>;

export function knowledgeTargetKey(t: { instanceName: string; agentId: string }): string {
  return `${t.instanceName}\u0000${t.agentId}`;
}

/** This target's pending choice, if any. */
export function pendingChoiceFor(
  m: PendingKnowledgeChoices,
  key: string,
): KnowledgeChoice | null {
  return m[key]?.choice ?? null;
}

/** The owner picked `choice` for `key` (pick number `gen` for that target, strictly
 *  increasing): it becomes that target's pending choice. */
export function pendingOnPick(
  m: PendingKnowledgeChoices,
  key: string,
  choice: KnowledgeChoice,
  gen: number,
): PendingKnowledgeChoices {
  const prev = m[key];
  return { ...m, [key]: { choice, inFlight: (prev?.inFlight ?? 0) + 1, gen } };
}

/** One of `key`'s mutations answered. A refusal of its LATEST pick drops the entry (the
 *  server kept its state); an older pick's refusal leaves the newer one pending. A
 *  target no longer shown whose last mutation succeeded is dropped too: when it is shown
 *  again, the server's state (which carries it) is read afresh. Other targets are never
 *  touched. */
export function pendingOnDone(
  m: PendingKnowledgeChoices,
  key: string,
  gen: number,
  ok: boolean,
  visibleKey: string,
): PendingKnowledgeChoices {
  const entry = m[key];
  if (entry === undefined) return m;
  const inFlight = Math.max(0, entry.inFlight - 1);
  if (!ok && entry.gen === gen) return withoutKey(m, key);
  if (ok && inFlight === 0 && key !== visibleKey) return withoutKey(m, key);
  return { ...m, [key]: { ...entry, inFlight } };
}

/** The shown target's server state arrived: its entry is dropped once the server shows
 *  it and nothing of it is in flight (`settlePending`). */
export function pendingOnServer(
  m: PendingKnowledgeChoices,
  key: string,
  server: KnowledgeChoice | null,
): PendingKnowledgeChoices {
  const entry = m[key];
  if (entry === undefined) return m;
  if (settlePending(server, entry.choice, entry.inFlight) !== null) return m;
  return withoutKey(m, key);
}

function withoutKey(m: PendingKnowledgeChoices, key: string): PendingKnowledgeChoices {
  const out: Record<string, PendingKnowledgeEntry> = {};
  for (const [k, v] of Object.entries(m)) if (k !== key) out[k] = v;
  return out;
}

/** The pending choice once the server answered: kept while mutations are in flight or
 *  the server does not show it yet; dropped (null) once it does. */
export function settlePending(
  server: KnowledgeChoice | null,
  pending: KnowledgeChoice | null,
  inFlight: number,
): KnowledgeChoice | null {
  if (pending === null) return null;
  if (inFlight > 0) return pending;
  return sameKnowledgeChoice(server, pending) ? null : pending;
}
