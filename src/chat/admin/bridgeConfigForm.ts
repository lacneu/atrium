// Pure form-state helpers for the per-instance bridge config editor (BridgeTab).
// Extracted so the load-bearing "persist ONLY explicit overrides" rule is
// unit-tested without mounting React (mirrors bridgeProviderView).

import {
  DEFAULT_INSTANCE_CONFIG,
  type InboundMediaMode,
  type MediaMode,
} from "../../../convex/lib/instanceConfig";

/** The complete editor form shape (every field has a displayed value). */
export type ConfigForm = {
  mediaMode: MediaMode;
  inboundMediaMode: InboundMediaMode;
  rehydration: boolean;
  mediaMaxMb: number;
  inboundAgentMount: string;
  outboundAgentMount: string;
};

/**
 * Fill the editor form from an instance's STORED (partial) config — every unset
 * field shows its env/Convex default for display. The inverse of
 * `buildConfigOverride` (which strips the unset defaults back out on save).
 */
export function formFromConfig(stored: Partial<ConfigForm>): ConfigForm {
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
export function buildConfigOverride(
  form: ConfigForm,
  stored: Partial<ConfigForm>,
): Partial<ConfigForm> {
  const out: Partial<ConfigForm> = {};
  const keep = <K extends keyof ConfigForm>(k: K): void => {
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
  return out;
}
