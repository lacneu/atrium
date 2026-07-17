// Prompt-injection REGISTRY — the single source of truth for the extra instructions
// Atrium injects into a gateway turn, and the rules for adjusting/removing them.
//
// Atrium prepends/appends a few standing instructions so features work out-of-the-box
// without per-agent gateway config (e.g. "emit MEDIA:<path> so a generated file is
// downloadable", or the documentary-fetch brief). But a gateway admin may have ALREADY
// baked these instructions into the agent's system prompt — in which case re-injecting
// them only bloats the turn's context for nothing (this is exactly what overflowed a
// documentary fetch to ~260k tokens). So each injection is configurable per instance:
// an admin can DISABLE it (the load-bearing case) or CUSTOMIZE its text.
//
// This registry is the ONE place an injection is defined (key + where it applies + its
// placeholders + the canonical default text). Adding a future injection = one entry
// here; the Settings UI renders itself from this list, and the resolver/bridge pick it
// up with no extra wiring. The registry is the SOURCE OF TRUTH for the default text:
// Convex resolves (override ?? default) and sends the result; the bridge keeps a copy
// only as an emergency fallback for a pre-feature Convex deployment.

/** Where an injection's text is actually spliced into the gateway message. `bridge`
 *  injections are resolved by Convex and SENT in the dispatch `config.injections` (the
 *  bridge fills placeholders + splices); `convex` injections are applied in Convex. */
import type { Locale } from "./locales";

export type InjectionAppliedIn = "bridge" | "convex";

export interface PromptInjectionDef {
  /** Stable identifier — the config key, the wire key, and the i18n key suffix. */
  readonly key: string;
  readonly appliedIn: InjectionAppliedIn;
  /** Whether the admin may DISABLE it (the UI offers a toggle; the config accepts
   *  `enabled:false`). Disabling an ADD-ON (media_delivery, inbound_files) appends NOTHING;
   *  disabling the documentary_fetch CORE prompt sends only the bare reference list (no
   *  Atrium framing) — never an empty turn — for a gateway whose agent already knows to
   *  fetch references. `false` is reserved for a FUTURE injection that truly can't be off. */
  readonly togglable: boolean;
  /** Placeholder names the template may contain as `{name}`, filled at apply time with
   *  runtime values (e.g. the outbound dir, the reference list). A custom template MUST
   *  keep any placeholder it needs — missingRequiredPlaceholders enforces this. */
  readonly placeholders: readonly string[];
  /** The canonical default instruction text, PER CONTENT LOCALE. The default sent
   *  to the agent follows the instance's content language (contentLocale ->
   *  admin defaultLocale -> base) — an admin override remains a single text that
   *  wins regardless of locale. Keys pinned to SUPPORTED_LOCALES by tests. */
  readonly defaultTemplate: Readonly<Record<Locale, string>>;
  /** What is applied when the injection is DISABLED. Undefined => nothing is injected (the
   *  add-ons just disappear). A CORE prompt that still needs a minimum sets it: documentary
   *  _fetch falls back to the bare `{references}` list. THE single source of truth for the
   *  disabled output — shared by the backend (effectiveTemplate) and the UI Preview. */
  readonly disabledTemplate?: Readonly<Record<Locale, string>>;
}

export const PROMPT_INJECTIONS = {
  // The "[LIVRAISON]" contract: how to make a generated file downloadable in this webchat.
  media_delivery: {
    key: "media_delivery",
    appliedIn: "bridge",
    togglable: true,
    placeholders: ["outboundDir"],
    defaultTemplate: {
      fr:
        "[LIVRAISON]\n" +
        "Pour qu'un fichier que tu génères soit téléchargeable par l'utilisateur dans ce " +
        "webchat : écris-le sous {outboundDir}/ puis ajoute, dans ta réponse finale, une " +
        "ligne dédiée EXACTEMENT au format MEDIA:<chemin absolu du fichier>. N'utilise PAS " +
        "de lien markdown vers un chemin local — il ne serait pas cliquable.",
      en:
        "[DELIVERY]\n" +
        "To make a file you generate downloadable by the user in this webchat: write it " +
        "under {outboundDir}/ then add, in your final reply, a dedicated line EXACTLY in " +
        "the format MEDIA:<absolute file path>. Do NOT use a markdown link to a local " +
        "path — it would not be clickable.",
    },
  },
  // The documentary "attach source documents" brief sent to the documentary agent.
  documentary_fetch: {
    key: "documentary_fetch",
    appliedIn: "convex",
    togglable: true,
    placeholders: ["references"],
    defaultTemplate: {
      fr:
        "Fournis les fichiers source téléchargeables correspondant EXACTEMENT à ces " +
        "références de documents (un fichier par référence, nommé d'après la référence). " +
        "Réponds uniquement avec les fichiers, sans commentaire :\n{references}",
      en:
        "Provide the downloadable source files matching EXACTLY these document " +
        "references (one file per reference, named after the reference). " +
        "Reply only with the files, no commentary:\n{references}",
    },
    // Disabled → send ONLY the bare reference list (the agent supplies the task itself).
    disabledTemplate: { fr: "{references}", en: "{references}" },
  },
  // The "[FICHIERS REÇUS]" preamble before the list of inbound files staged for the agent.
  inbound_files: {
    key: "inbound_files",
    appliedIn: "bridge",
    togglable: true,
    placeholders: ["files"],
    defaultTemplate: {
      fr: "[FICHIERS REÇUS]\n{files}",
      en: "[RECEIVED FILES]\n{files}",
    },
  },
  // Hybrid rehydration: the brief sent (in a hidden summarizer chat, to the DEDICATED
  // summarizer agent when the admin granted one — agent type "summarizer" — else the
  // target chat's own agent) to maintain the rolling conversation summary. DISABLING
  // it removes ONLY Atrium's framing (the CORE-prompt pattern, like documentary_fetch):
  // the job still dispatches with the bare material, for an agent whose own system
  // prompt/briefing carries the summarization instructions. The FEATURE switch is the
  // instance's `rehydration` config (Bridge settings) — no rehydration, no summaries.
  history_summary: {
    key: "history_summary",
    appliedIn: "convex",
    togglable: true,
    placeholders: ["previous_summary", "new_messages", "max_chars"],
    defaultTemplate: {
      fr:
        "[SYNTHÈSE DE CONVERSATION]\n" +
        "Tu maintiens le résumé cumulatif d'une conversation entre un utilisateur et " +
        "un assistant. Mets à jour le résumé existant en y intégrant les nouveaux " +
        "messages. Conserve : décisions, faits, chiffres, engagements, préférences " +
        "exprimées, questions ouvertes. Style : factuel, compact, même langue que la " +
        "conversation. Réponds UNIQUEMENT avec le résumé mis à jour, sans commentaire, " +
        "en {max_chars} caractères au maximum.\n\n" +
        "[RÉSUMÉ EXISTANT]\n{previous_summary}\n\n" +
        "[NOUVEAUX MESSAGES]\n{new_messages}",
      en:
        "[CONVERSATION SUMMARY]\n" +
        "You maintain the cumulative summary of a conversation between a user and " +
        "an assistant. Update the existing summary by folding in the new messages. " +
        "Keep: decisions, facts, figures, commitments, stated preferences, open " +
        "questions. Style: factual, compact, same language as the conversation. " +
        "Reply ONLY with the updated summary, no commentary, in at most {max_chars} " +
        "characters.\n\n" +
        "[EXISTING SUMMARY]\n{previous_summary}\n\n" +
        "[NEW MESSAGES]\n{new_messages}",
    },
    // Disabled → bare material only (the dedicated agent supplies the task itself).
    disabledTemplate: {
      fr:
        "[RÉSUMÉ EXISTANT]\n{previous_summary}\n\n" +
        "[NOUVEAUX MESSAGES]\n{new_messages}",
      en:
        "[EXISTING SUMMARY]\n{previous_summary}\n\n" +
        "[NEW MESSAGES]\n{new_messages}",
    },
  },
  // Quote-reply preamble: when the user REPLIES TO A BLOCK of a previous
  // assistant answer ("here is what I am responding to" — the ChatGPT-mobile
  // reply affordance), this preamble carries the quoted excerpt ahead of the
  // user's instruction. Composed Convex-side at dispatch AND rehydration, so
  // it reaches OpenClaw and Hermes identically as plain prompt text.
  // DISABLING keeps the bare markdown quote (the anchor itself must never be
  // silently dropped while the UI shows a quote chip).
  quote_reply: {
    key: "quote_reply",
    appliedIn: "convex",
    togglable: true,
    placeholders: ["excerpt"],
    // "a previous assistant answer", NOT "your previous answer": on a
    // multi-agent chat the quoted passage may come from ANOTHER agent than
    // the one receiving this turn — the framing must not misattribute it.
    defaultTemplate: {
      fr:
        "[EN RÉPONSE À]\n" +
        "L'utilisateur répond à ce passage précis d'une réponse précédente " +
        "de l'assistant :\n" +
        "> {excerpt}\n" +
        "Traite sa consigne comme portant spécifiquement sur ce passage.",
      en:
        "[IN REPLY TO]\n" +
        "The user is replying to this specific passage of a previous " +
        "assistant answer:\n" +
        "> {excerpt}\n" +
        "Treat their instruction as targeting that passage specifically.",
    },
    // Disabled → the bare markdown quote (anchor preserved, framing removed).
    disabledTemplate: { fr: "> {excerpt}", en: "> {excerpt}" },
  },
  // The agent-file CURATION briefing: how the curator specialist rationalizes an
  // over-budget agent file. Per-instance so the admin adapts it to the gateway
  // type (OpenClaw today, Hermes later) and to local conventions; a DEDICATED
  // curator agent may carry its own briefing -> disable to send bare material.
  file_curation: {
    key: "file_curation",
    appliedIn: "convex",
    togglable: true,
    placeholders: ["file_name", "budget_chars", "feedback", "content"],
    defaultTemplate: {
      fr:
        "[CURATION DE FICHIER D'AGENT]\n" +
        "Tu es le CURATEUR des fichiers d'agent de cette passerelle. Rationalise le " +
        "fichier {file_name} ci-dessous pour le ramener SOUS {budget_chars} caractères " +
        "en PRÉSERVANT toutes les informations pertinentes : supprime les redondances " +
        "et les doublons, fusionne les entrées équivalentes, condense sans perdre un " +
        "fait porteur, restructure pour la clarté. La QUALITÉ prime sur la quantité. " +
        "N'invente rien, ne suppose rien.\n\n" +
        "Rôle du fichier (adapte la curation à ce rôle) :\n" +
        "- MEMORY.md : index de la mémoire durable de l'agent — chaque entrée pointe " +
        "vers un souvenir ; conserve les références et leur sens, fusionne les doublons.\n" +
        "- AGENTS.md : règles et consignes de travail — conserve chaque règle distincte ; " +
        "condense les explications, jamais les interdictions.\n" +
        "- SOUL.md : personnalité et ton — conserve l'intention, condense les exemples.\n" +
        "- IDENTITY.md : identité (nom, rôle, langue) — quasi incompressible, ne retire " +
        "que les répétitions.\n" +
        "- TOOLS.md : notes d'usage des outils — conserve chaque outil et ses pièges connus.\n" +
        "- USER.md : contexte sur l'utilisateur — conserve les faits et préférences, " +
        "fusionne les redites.\n\n" +
        "[RETOUR DE L'ADMINISTRATEUR SUR LA PROPOSITION PRÉCÉDENTE]\n{feedback}\n\n" +
        "RÈGLES DE SORTIE STRICTES :\n" +
        "- Réponds UNIQUEMENT avec le contenu réécrit du fichier (markdown brut).\n" +
        "- AUCUN préambule, AUCUN commentaire, AUCUNE ligne MEDIA:, AUCUN bloc de code " +
        "englobant.\n\n" +
        "--- CONTENU ACTUEL DE {file_name} ---\n{content}",
      en:
        "[AGENT-FILE CURATION]\n" +
        "You are the CURATOR of this gateway's agent files. Rationalize the file " +
        "{file_name} below to bring it UNDER {budget_chars} characters while " +
        "PRESERVING all relevant information: remove redundancies and duplicates, " +
        "merge equivalent entries, condense without losing a load-bearing fact, " +
        "restructure for clarity. QUALITY over quantity. Never invent, never assume.\n\n" +
        "Role of the file (adapt the curation to it):\n" +
        "- MEMORY.md: the agent's durable memory index — each entry points to a " +
        "memory; keep the references and their meaning, merge duplicates.\n" +
        "- AGENTS.md: working rules and instructions — keep every distinct rule; " +
        "condense explanations, never prohibitions.\n" +
        "- SOUL.md: personality and tone — keep the intent, condense the examples.\n" +
        "- IDENTITY.md: identity (name, role, language) — nearly incompressible, only " +
        "remove repetitions.\n" +
        "- TOOLS.md: tool-usage notes — keep every tool and its known pitfalls.\n" +
        "- USER.md: context about the user — keep facts and preferences, merge " +
        "restatements.\n\n" +
        "[ADMINISTRATOR FEEDBACK ON THE PREVIOUS PROPOSAL]\n{feedback}\n\n" +
        "STRICT OUTPUT RULES:\n" +
        "- Reply ONLY with the rewritten file content (raw markdown).\n" +
        "- NO preamble, NO commentary, NO MEDIA: line, NO wrapping code fence.\n\n" +
        "--- CURRENT CONTENT OF {file_name} ---\n{content}",
    },
    // Disabled -> bare material only (the dedicated curator agent carries the task).
    disabledTemplate: {
      fr:
        "[FICHIER {file_name} — budget {budget_chars} caractères]\n" +
        "[RETOUR ADMIN]\n{feedback}\n\n{content}",
      en:
        "[FILE {file_name} — budget {budget_chars} characters]\n" +
        "[ADMIN FEEDBACK]\n{feedback}\n\n{content}",
    },
  },
} as const satisfies Record<string, PromptInjectionDef>;

export type PromptInjectionKey = keyof typeof PROMPT_INJECTIONS;

export const PROMPT_INJECTION_KEYS = Object.keys(
  PROMPT_INJECTIONS,
) as PromptInjectionKey[];

/** Per-injection admin override stored on the instance config. Both fields optional: an
 *  admin may only flip `enabled` (the common "the gateway already says this" case) and
 *  leave the text at its default. */
export interface PromptInjectionOverride {
  enabled?: boolean;
  template?: string;
}

/** The stored config: a sparse map of key -> override (only configured injections).
 *  A plain `Record` (not `Partial`) to match the Convex `v.record` validator; absent keys
 *  are handled by callers reading `config?.[key]` (undefined => registry default). */
export type PromptInjectionConfig = Record<string, PromptInjectionOverride>;

export interface ResolvedInjection {
  enabled: boolean;
  template: string;
}

/** Effective injection = the admin override folded onto the registry default. Enabled by
 *  default (the injection ships ON); a custom template wins over the default text. */
export function resolveInjection(
  key: PromptInjectionKey,
  config: PromptInjectionConfig | undefined,
  // The CONTENT locale (instance contentLocale -> admin defaultLocale -> base):
  // picks which language's DEFAULT text is used. An admin override is a single
  // text that wins regardless of locale (it IS the instance's chosen wording).
  locale: Locale,
): ResolvedInjection {
  const def = PROMPT_INJECTIONS[key];
  const override = config?.[key];
  return {
    enabled: override?.enabled ?? true,
    template:
      typeof override?.template === "string" && override.template.length > 0
        ? override.template
        : def.defaultTemplate[locale],
  };
}

/** The template ACTUALLY applied for a resolved injection: the configured text when
 *  enabled, else the injection's disabled fallback (documentary_fetch → bare `{references}`;
 *  an add-on → `""`, i.e. nothing injected). One source for "what the agent really gets",
 *  used by the backend AND the Settings Preview so the preview never lies on the disable
 *  path. (Bridge add-ons are SKIPPED at the bridge when disabled — same `""` outcome.) */
export function effectiveTemplate(
  key: PromptInjectionKey,
  resolved: { enabled: boolean; template: string },
  locale: Locale,
): string {
  if (resolved.enabled) return resolved.template;
  // Widen to the interface: `as const` keeps `disabledTemplate` off the members that omit it.
  const def: PromptInjectionDef = PROMPT_INJECTIONS[key];
  return def.disabledTemplate?.[locale] ?? "";
}

/** The resolved bridge-applied injections Convex SENDS in the dispatch (`config.injections`).
 *  The bridge tri-states on presence: absent key -> bridge's own fallback default; present
 *  + `enabled:false` -> skip; present + `enabled:true` -> fill placeholders + splice. */
export function resolveBridgeInjections(
  config: PromptInjectionConfig | undefined,
  locale: Locale,
): Record<string, ResolvedInjection> {
  const out: Record<string, ResolvedInjection> = {};
  for (const key of PROMPT_INJECTION_KEYS) {
    if (PROMPT_INJECTIONS[key].appliedIn === "bridge") {
      out[key] = resolveInjection(key, config, locale);
    }
  }
  return out;
}

/** Substitute `{name}` placeholders. An unknown `{name}` is left as-is (never throws), so
 *  a template stays inert rather than emitting a half-rendered instruction. */
export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const val = vars[name];
    return val !== undefined ? val : whole;
  });
}

/** Reject a custom template that dropped a placeholder the injection NEEDS to function
 *  (e.g. media_delivery without `{outboundDir}` would tell the agent to write "under /").
 *  Returns the missing placeholder names (empty => valid). */
export function missingRequiredPlaceholders(
  key: PromptInjectionKey,
  template: string,
): string[] {
  return PROMPT_INJECTIONS[key].placeholders.filter(
    (p) => !template.includes(`{${p}}`),
  );
}
