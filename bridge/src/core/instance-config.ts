// Per-instance NON-SECRET config the bridge receives IN-BAND on `POST /send`
// (Convex resolves it from `instances.config` and sends a COMPLETE object). The
// bridge mirror of convex/lib/instanceConfig: a lenient defensive parser (a bad
// or absent field is dropped, never throws — a malformed config must NEVER fail a
// send) and the runtime shape the media provider + rehydration consume. Secrets
// are NEVER here. See the plan (D-B: process-global, last-write-wins).

/** Outbound media transport (mirrors convex MEDIA_MODES). */
export type MediaMode = "gateway-http" | "shared-fs" | "off";
/** Inbound (user→agent) attachment transport (mirrors convex INBOUND_MEDIA_MODES). */
export type InboundMediaMode = "inline" | "shared-fs";

const MEDIA_MODES: readonly MediaMode[] = ["gateway-http", "shared-fs", "off"];
const INBOUND_MEDIA_MODES: readonly InboundMediaMode[] = ["inline", "shared-fs"];

/**
 * The in-band per-instance overrides, already coerced to the bridge's units
 * (`mediaMaxMb` → `mediaMaxBytes`). Every field optional: a field the caller
 * cares about falls back to the bridge's boot env default when absent here.
 */
export interface InboundInstanceConfig {
  mediaMode?: MediaMode;
  inboundMediaMode?: InboundMediaMode;
  rehydration?: boolean;
  /** Set by Convex ONLY for a per-turn ROUTED dispatch (the multi-agent switch path) —
   *  a DISTINCT signal from the generic `rehydration` enable knob. Lets the bridge
   *  re-ground a freshly-routed agent's brand-new session without an admin
   *  `rehydration:true` setting forcing the same on ordinary single-agent sends. */
  routedSwitch?: boolean;
  /** Per-file media cap in BYTES (converted from the wire `mediaMaxMb`). */
  mediaMaxBytes?: number;
  /** Agent-visible inbound mount (where the agent READS staged files). */
  inboundAgentMount?: string;
  /** Agent-visible outbound mount (where the agent WRITES deliverables). */
  outboundAgentMount?: string;
  /** RESOLVED prompt injections Convex sends (key -> enabled+template). Convex owns the
   *  registry + defaults; the bridge only fills placeholders + splices. Tri-state at the
   *  consumer: a key ABSENT here -> the bridge's own fallback default (pre-feature Convex);
   *  present + `enabled:false` -> skip; present + `enabled:true` -> use `template`. */
  injections?: Record<string, InboundInjection>;
}

/** One resolved injection as received from Convex. */
export interface InboundInjection {
  enabled: boolean;
  template: string;
}

/** Substitute `{name}` placeholders (mirror of convex lib/promptInjections.fillTemplate).
 *  An unknown `{name}` is left verbatim so a template never half-renders. */
export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const val = vars[name];
    return val !== undefined ? val : whole;
  });
}

/**
 * Defensively parse the optional `config` field of a `/send` body. Returns the
 * coerced overrides, or `null` when absent/non-object (caller uses full env
 * defaults). NEVER throws and NEVER rejects the whole config over one bad field —
 * an unknown/malformed field is simply ignored (Convex already validated; this is
 * only a robustness backstop, and a future field must not break an old bridge).
 */
export function parseInboundConfig(raw: unknown): InboundInstanceConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: InboundInstanceConfig = {};
  if (
    typeof o.mediaMode === "string" &&
    (MEDIA_MODES as readonly string[]).includes(o.mediaMode)
  ) {
    out.mediaMode = o.mediaMode as MediaMode;
  }
  if (
    typeof o.inboundMediaMode === "string" &&
    (INBOUND_MEDIA_MODES as readonly string[]).includes(o.inboundMediaMode)
  ) {
    out.inboundMediaMode = o.inboundMediaMode as InboundMediaMode;
  }
  if (typeof o.rehydration === "boolean") {
    out.rehydration = o.rehydration;
  }
  if (typeof o.routedSwitch === "boolean") {
    out.routedSwitch = o.routedSwitch;
  }
  if (
    typeof o.mediaMaxMb === "number" &&
    Number.isFinite(o.mediaMaxMb) &&
    o.mediaMaxMb > 0
  ) {
    out.mediaMaxBytes = Math.floor(o.mediaMaxMb * 1024 * 1024);
  }
  if (typeof o.inboundAgentMount === "string" && o.inboundAgentMount.startsWith("/")) {
    out.inboundAgentMount = o.inboundAgentMount;
  }
  if (typeof o.outboundAgentMount === "string" && o.outboundAgentMount.startsWith("/")) {
    out.outboundAgentMount = o.outboundAgentMount;
  }
  if (
    typeof o.injections === "object" &&
    o.injections !== null &&
    !Array.isArray(o.injections)
  ) {
    const inj: Record<string, InboundInjection> = {};
    for (const [k, val] of Object.entries(o.injections as Record<string, unknown>)) {
      if (typeof val !== "object" || val === null || Array.isArray(val)) continue;
      const e = (val as Record<string, unknown>).enabled;
      const t = (val as Record<string, unknown>).template;
      // Default enabled:true so a malformed entry never silently suppresses an injection;
      // a missing template -> "" so the consumer falls through to its own default.
      inj[k] = {
        enabled: typeof e === "boolean" ? e : true,
        template: typeof t === "string" ? t : "",
      };
    }
    if (Object.keys(inj).length > 0) out.injections = inj;
  }
  return out;
}
