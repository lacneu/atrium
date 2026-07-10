// Pure form-state helpers for the per-instance bridge config editor (BridgeTab).
// Extracted so the load-bearing "persist ONLY explicit overrides" rule is
// unit-tested without mounting React (mirrors bridgeProviderView).

import {
  DEFAULT_INSTANCE_CONFIG,
  type InboundMediaMode,
  type MediaMode,
} from "../../../convex/lib/instanceConfig";
import { type Locale } from "../../../convex/lib/locales";
import {
  PROMPT_INJECTION_KEYS,
  PROMPT_INJECTIONS,
  type PromptInjectionConfig,
} from "../../../convex/lib/promptInjections";

/** Editor row for one prompt injection: the displayed toggle + the displayed template
 *  (the custom text, or the registry default when not customized). */
export type InjectionForm = { enabled: boolean; template: string };

/** The complete editor form shape (every field has a displayed value). */
export type ConfigForm = {
  mediaMode: MediaMode;
  inboundMediaMode: InboundMediaMode;
  rehydration: boolean;
  mediaMaxMb: number;
  inboundAgentMount: string;
  outboundAgentMount: string;
  /** Per-injection editor rows, one per registry key (always all present for display). */
  promptInjections: Record<string, InjectionForm>;
};

/** Editor rows seeded from the stored (sparse) overrides — every injection shows its
 *  effective enabled state + its effective text (custom, else the registry default). */
export function injectionsFromConfig(
  stored: PromptInjectionConfig | undefined,
  // The instance's CONTENT locale: which language's DEFAULT text fills an
  // un-overridden row (must match what the backend actually sends).
  contentLocale: Locale,
): Record<string, InjectionForm> {
  const out: Record<string, InjectionForm> = {};
  for (const key of PROMPT_INJECTION_KEYS) {
    const ov = stored?.[key];
    out[key] = {
      enabled: ov?.enabled ?? true,
      template:
        typeof ov?.template === "string" && ov.template.length > 0
          ? ov.template
          : PROMPT_INJECTIONS[key].defaultTemplate[contentLocale],
    };
  }
  return out;
}

/** Build the sparse injections OVERRIDE to persist: per injection, keep `enabled:false`
 *  only for a togglable injection actually turned off, and `template` only when it is a
 *  non-empty CUSTOM value (differs from the registry default). An injection at its
 *  defaults contributes nothing — so a bare Save never freezes the defaults as overrides. */
export function buildInjectionsOverride(
  rows: Record<string, InjectionForm>,
  // The ACTIVE content locale: only ITS default is "untouched" — an admin who
  // deliberately pastes another language's built-in text IS overriding (codex
  // P3: comparing against every locale's default silently dropped that intent).
  contentLocale: Locale,
): PromptInjectionConfig {
  const out: PromptInjectionConfig = {};
  for (const key of PROMPT_INJECTION_KEYS) {
    const def = PROMPT_INJECTIONS[key];
    const row = rows[key];
    if (!row) continue;
    const entry: { enabled?: boolean; template?: string } = {};
    if (def.togglable && row.enabled === false) entry.enabled = false;
    const t = row.template.trim();
    if (t.length > 0 && t !== def.defaultTemplate[contentLocale]) {
      entry.template = t;
    }
    if (entry.enabled !== undefined || entry.template !== undefined) {
      out[key] = entry;
    }
  }
  return out;
}

/**
 * Fill the editor form from an instance's STORED (partial) config — every unset
 * field shows its env/Convex default for display. The inverse of
 * `buildConfigOverride` (which strips the unset defaults back out on save).
 */
export function formFromConfig(
  stored: Partial<ConfigForm>,
  contentLocale: Locale,
): ConfigForm {
  return {
    mediaMode: stored.mediaMode ?? DEFAULT_INSTANCE_CONFIG.mediaMode,
    inboundMediaMode:
      stored.inboundMediaMode ?? DEFAULT_INSTANCE_CONFIG.inboundMediaMode,
    rehydration: stored.rehydration ?? DEFAULT_INSTANCE_CONFIG.rehydration,
    mediaMaxMb: stored.mediaMaxMb ?? DEFAULT_INSTANCE_CONFIG.mediaMaxMb,
    inboundAgentMount:
      stored.inboundAgentMount ?? DEFAULT_INSTANCE_CONFIG.inboundAgentMount,
    outboundAgentMount:
      stored.outboundAgentMount ?? DEFAULT_INSTANCE_CONFIG.outboundAgentMount,
    promptInjections: injectionsFromConfig(stored.promptInjections, contentLocale),
  };
}

/**
 * Build the per-instance config OVERRIDE to persist: ONLY fields the admin
 * explicitly set. The editor fills unset fields with `DEFAULT_INSTANCE_CONFIG` for
 * display, but persisting those would turn an env-configured bridge's defaults into
 * explicit overrides that shadow its OWN env on every dispatch (a bare "Save" must
 * NOT flip a shared-fs/off bridge back to gateway-http). So a field is kept only
 * when it DIFFERS from the default OR was ALREADY stored (preserve prior overrides);
 * an untouched default is omitted so the bridge keeps its env value.
 *
 * Known limit: there is no per-field "clear back to inherit" control yet, and
 * forcing a value EQUAL to the default as an explicit override is the one case this
 * can't express — rare under Model M, where the bridge env IS the instance's config.
 */
/** The persisted override: the flat transport fields (sparse) + the sparse prompt-
 *  injection overrides. Matches the `upsertInstanceConfig` mutation arg / InstanceConfig. */
export type ConfigOverride = Partial<
  Omit<ConfigForm, "promptInjections">
> & {
  promptInjections?: PromptInjectionConfig;
  /** Passthrough (owned by the Chat-defaults tab, not this form). */
  summarizeThresholdChars?: number;
  curationEnabled?: boolean;
  curationBudgetChars?: number;
  contentLocale?: string;
  converterAgentId?: string;
};

/** Config keys OWNED BY OTHER admin surfaces (the Chat-defaults tab's summarize
 *  threshold today) that share the same `instance.config` blob: they must ride
 *  through this form's rebuild UNCHANGED, or a Bridge/injections save would
 *  silently erase them (codex P2). Explicit list — never a blind spread (the
 *  closed server validator rejects unknown keys; stale junk must not resurrect). */
const PASSTHROUGH_KEYS = [
  "summarizeThresholdChars",
  "curationEnabled",
  "curationBudgetChars",
  "contentLocale",
  "converterAgentId",
] as const;

export function buildConfigOverride(
  form: ConfigForm,
  stored: Partial<ConfigForm>,
  contentLocale: Locale,
): ConfigOverride {
  const out: ConfigOverride = {};
  type FlatKey = keyof Omit<ConfigForm, "promptInjections">;
  const keep = <K extends FlatKey>(k: K): void => {
    if (form[k] !== DEFAULT_INSTANCE_CONFIG[k] || stored[k] !== undefined) {
      out[k] = form[k];
    }
  };
  keep("mediaMode");
  keep("inboundMediaMode");
  keep("rehydration");
  keep("mediaMaxMb");
  keep("inboundAgentMount");
  keep("outboundAgentMount");
  const injections = buildInjectionsOverride(form.promptInjections, contentLocale);
  if (Object.keys(injections).length > 0) out.promptInjections = injections;
  // Carry the other surfaces' fields through (see PASSTHROUGH_KEYS). `stored` is
  // the RAW instance.config at both call sites, so the values are present even
  // though ConfigForm does not type them.
  const raw = stored as Record<string, unknown>;
  for (const k of PASSTHROUGH_KEYS) {
    const val = raw[k];
    if (
      typeof val === "number" ||
      typeof val === "boolean" ||
      typeof val === "string"
    ) {
      (out as Record<string, unknown>)[k] = val;
    }
  }
  return out;
}
