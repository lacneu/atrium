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
  /** The canonical default instruction text (French — the injection text is sent to the
   *  agent verbatim and is not localized; only the Settings UI labels/tooltips are). */
  readonly defaultTemplate: string;
  /** What is applied when the injection is DISABLED. Undefined => nothing is injected (the
   *  add-ons just disappear). A CORE prompt that still needs a minimum sets it: documentary
   *  _fetch falls back to the bare `{references}` list. THE single source of truth for the
   *  disabled output — shared by the backend (effectiveTemplate) and the UI Preview. */
  readonly disabledTemplate?: string;
}

export const PROMPT_INJECTIONS = {
  // The "[LIVRAISON]" contract: how to make a generated file downloadable in this webchat.
  media_delivery: {
    key: "media_delivery",
    appliedIn: "bridge",
    togglable: true,
    placeholders: ["outboundDir"],
    defaultTemplate:
      "[LIVRAISON]\n" +
      "Pour qu'un fichier que tu génères soit téléchargeable par l'utilisateur dans ce " +
      "webchat : écris-le sous {outboundDir}/ puis ajoute, dans ta réponse finale, une " +
      "ligne dédiée EXACTEMENT au format MEDIA:<chemin absolu du fichier>. N'utilise PAS " +
      "de lien markdown vers un chemin local — il ne serait pas cliquable.",
  },
  // The documentary "attach source documents" brief sent to the documentary agent.
  documentary_fetch: {
    key: "documentary_fetch",
    appliedIn: "convex",
    togglable: true,
    placeholders: ["references"],
    defaultTemplate:
      "Fournis les fichiers source téléchargeables correspondant EXACTEMENT à ces " +
      "références de documents (un fichier par référence, nommé d'après la référence). " +
      "Réponds uniquement avec les fichiers, sans commentaire :\n{references}",
    // Disabled → send ONLY the bare reference list (the agent supplies the task itself).
    disabledTemplate: "{references}",
  },
  // The "[FICHIERS REÇUS]" preamble before the list of inbound files staged for the agent.
  inbound_files: {
    key: "inbound_files",
    appliedIn: "bridge",
    togglable: true,
    placeholders: ["files"],
    defaultTemplate: "[FICHIERS REÇUS]\n{files}",
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
    defaultTemplate:
      "[SYNTHÈSE DE CONVERSATION]\n" +
      "Tu maintiens le résumé cumulatif d'une conversation entre un utilisateur et " +
      "un assistant. Mets à jour le résumé existant en y intégrant les nouveaux " +
      "messages. Conserve : décisions, faits, chiffres, engagements, préférences " +
      "exprimées, questions ouvertes. Style : factuel, compact, même langue que la " +
      "conversation. Réponds UNIQUEMENT avec le résumé mis à jour, sans commentaire, " +
      "en {max_chars} caractères au maximum.\n\n" +
      "[RÉSUMÉ EXISTANT]\n{previous_summary}\n\n" +
      "[NOUVEAUX MESSAGES]\n{new_messages}",
    // Disabled → bare material only (the dedicated agent supplies the task itself).
    disabledTemplate:
      "[RÉSUMÉ EXISTANT]\n{previous_summary}\n\n" +
      "[NOUVEAUX MESSAGES]\n{new_messages}",
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
): ResolvedInjection {
  const def = PROMPT_INJECTIONS[key];
  const override = config?.[key];
  return {
    enabled: override?.enabled ?? true,
    template:
      typeof override?.template === "string" && override.template.length > 0
        ? override.template
        : def.defaultTemplate,
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
): string {
  if (resolved.enabled) return resolved.template;
  // Widen to the interface: `as const` keeps `disabledTemplate` off the members that omit it.
  const def: PromptInjectionDef = PROMPT_INJECTIONS[key];
  return def.disabledTemplate ?? "";
}

/** The resolved bridge-applied injections Convex SENDS in the dispatch (`config.injections`).
 *  The bridge tri-states on presence: absent key -> bridge's own fallback default; present
 *  + `enabled:false` -> skip; present + `enabled:true` -> fill placeholders + splice. */
export function resolveBridgeInjections(
  config: PromptInjectionConfig | undefined,
): Record<string, ResolvedInjection> {
  const out: Record<string, ResolvedInjection> = {};
  for (const key of PROMPT_INJECTION_KEYS) {
    if (PROMPT_INJECTIONS[key].appliedIn === "bridge") {
      out[key] = resolveInjection(key, config);
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
