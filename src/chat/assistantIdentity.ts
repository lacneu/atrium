import { createContext, useContext } from "react";
import { m } from "@/paraglide/messages.js";

// Identity shown for an assistant turn, resolved ONCE at the ConvexChat root and
// shared via context (the assistant-ui runtime instantiates the message + run
// status itself, so neither can be prop-drilled). Lives in its own module so
// RunStatus can consume it without a circular import back into ConvexChat.
//
//  - The AVATAR comes from the active charte graphique (brand logo / Atrium mark
//    / initials), so the visual identity follows the chart.
//  - The NAME is the responding AGENT's display name when the user has more than
//    one agent (mirrors the header chip's `multiAgent` gate); a single-agent user
//    has no agent to disambiguate, so it falls back to the charte's brand label.
export type AssistantIdentity = {
  // Avatar (charte graphique).
  label: string;
  logoUrl: string | null;
  // True => render logoUrl as a silhouette MASK in --primary-foreground (auto
  // contrast on the --primary tile, both modes); false => plain <img>.
  logoMasked: boolean;
  isDefault: boolean;
  initials: string;
  // Responding agent (null = single-agent → use the brand label as the name).
  agentName: string | null;
  agentEmoji: string | null;
};

export const DEFAULT_IDENTITY: AssistantIdentity = {
  label: "Atrium",
  logoUrl: null,
  logoMasked: false,
  isDefault: true,
  initials: "A",
  agentName: null,
  agentEmoji: null,
};

export const AssistantIdentityContext =
  createContext<AssistantIdentity>(DEFAULT_IDENTITY);

export function useAssistantIdentity(): AssistantIdentity {
  return useContext(AssistantIdentityContext);
}

// The name for an assistant turn: the responding agent's display name when known,
// else the charte graphique's brand label. (No emoji — the caller prepends the
// agent emoji where appropriate; this plain name is what reads in a sentence.)
export function assistantDisplayName(id: AssistantIdentity): string {
  return id.agentName ?? id.label;
}

// The "…is processing your message…" reassurance shown after a long wait. When a
// responding agent is known it reads "L'agent {name} traite…" (the name IS an
// agent); the single-agent fallback uses the brand label WITHOUT the "L'agent"
// prefix (the charte brand is not an agent, so "L'agent Atrium" would be wrong).
export function runWaitingLabel(id: AssistantIdentity): string {
  return id.agentName
    ? m.chat_run_taking_longer_agent({ name: id.agentName })
    : m.chat_run_taking_longer({ name: id.label });
}
