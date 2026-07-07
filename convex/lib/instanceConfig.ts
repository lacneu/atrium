// Per-instance NON-SECRET bridge configuration: the validator (shared by the
// schema column AND the upsertInstanceConfig mutation arg so the two never
// drift), a strict semantic parser, the default-filling resolver, and a stable
// signature. SECRETS (gateway token, device identity, shared secrets) are NEVER
// here — they stay bridge-env only. See the plan + docs/MULTI_AGENT_REDESIGN.md.

import { v } from "convex/values";
import { CURATION_BUDGET_MIN, CURATION_BUDGET_MAX } from "./curation";
import { isSupportedLocale, type Locale } from "./locales";

import {
  missingRequiredPlaceholders,
  PROMPT_INJECTION_KEYS,
  PROMPT_INJECTIONS,
  resolveBridgeInjections,
  type PromptInjectionConfig,
  type PromptInjectionKey,
  type ResolvedInjection,
} from "./promptInjections";

/** Outbound media transport for a turn's agent-produced files. */
export const MEDIA_MODES = ["gateway-http", "shared-fs", "off"] as const;
export type MediaMode = (typeof MEDIA_MODES)[number];

/** Inbound (user→agent) attachment transport for tool-read files. */
export const INBOUND_MEDIA_MODES = ["inline", "shared-fs"] as const;
export type InboundMediaMode = (typeof INBOUND_MEDIA_MODES)[number];

/** Live-stream transport (frontend↔Convex) for an instance's chats: the reactive query
 *  push (default) or the SSE / streamable-HTTP endpoint. A FRONTEND display choice — it is
 *  a TOP-LEVEL instance property (`instances.streamTransport`), NOT part of this bridge
 *  config blob (it is never dispatched to the bridge). See
 *  openclaw-notes/docs/atrium/convex-http-streaming-transport.md. */
export const STREAM_TRANSPORTS = ["reactive", "sse"] as const;
export type StreamTransport = (typeof STREAM_TRANSPORTS)[number];
export const DEFAULT_STREAM_TRANSPORT: StreamTransport = "reactive";

/** Sanity bounds for the per-file media cap (MiB). 1 MiB .. 4 GiB. */
export const MEDIA_MAX_MB_MIN = 1;
export const MEDIA_MAX_MB_MAX = 4096;

/**
 * Closed validator for the per-instance config blob. Reused by `instances.config`
 * (schema) AND `admin.upsertInstanceConfig` (mutation arg). All fields OPTIONAL
 * (a row may carry a partial override); `resolveInstanceConfig` fills the rest.
 */
export const instanceConfigValidator = v.object({
  mediaMode: v.optional(
    v.union(v.literal("gateway-http"), v.literal("shared-fs"), v.literal("off")),
  ),
  inboundMediaMode: v.optional(
    v.union(v.literal("inline"), v.literal("shared-fs")),
  ),
  rehydration: v.optional(v.boolean()),
  mediaMaxMb: v.optional(v.number()),
  // Hybrid rehydration: unsummarized-content size (chars) that triggers an
  // AUTOMATIC summarize job (the manual trigger ignores it). Bounds below.
  summarizeThresholdChars: v.optional(v.number()),
  // Agent-file CURATION (auto-management of over-budget agent files). DEFAULT OFF:
  // a lossy LLM rewrite of a memory/rules file only runs when an admin opts in
  // per instance. `curationBudgetChars` = the per-file target the curator rewrites
  // toward (bounded below). Every curation is a REVIEWABLE proposal, never a live
  // auto-write.
  curationEnabled: v.optional(v.boolean()),
  curationBudgetChars: v.optional(v.number()),
  // Voice (browser Web Speech): per-instance read-aloud settings. `voiceLang`
  // is a BCP-47 tag ("fr-FR") or "auto" (follow the UI locale); `voiceRate`
  // 0.5..2 (1 = normal). `voiceAutoRead` reads each completed reply aloud
  // (the per-user preference still gates it client-side).
  voiceEnabled: v.optional(v.boolean()),
  voiceLang: v.optional(v.string()),
  voiceRate: v.optional(v.number()),
  voiceAutoRead: v.optional(v.boolean()),
  // CONTENT language override for this instance's server-generated, agent-facing
  // material (prompt injections, rehydration framing, briefs). Unset -> the
  // app's admin default language -> base locale. Validated against
  // lib/locales.SUPPORTED_LOCALES.
  contentLocale: v.optional(v.string()),
  // GATEWAY/AGENT-visible shared-fs paths (where the AGENT reads inbound files /
  // writes outbound files — i.e. the gateway container's mount of the shared
  // volume). Used only in shared-fs mode. Non-secret.
  inboundAgentMount: v.optional(v.string()),
  outboundAgentMount: v.optional(v.string()),
  // Per-injection admin overrides (disable / customize the standing instructions Atrium
  // splices into a turn — see lib/promptInjections). Sparse: only configured keys. The
  // key set is validated against the registry in parseInstanceConfig.
  promptInjections: v.optional(
    v.record(
      v.string(),
      v.object({
        enabled: v.optional(v.boolean()),
        template: v.optional(v.string()),
      }),
    ),
  ),
});

/** Upper bound on a custom injection template (defense against absurd input bloating the
 *  very context this feature exists to keep small). */
export const INJECTION_TEMPLATE_MAX_LEN = 4000;

/** Max length for a configured path (defense against absurd input). */
export const PATH_MAX_LEN = 512;

/**
 * Whether a string is an acceptable ABSOLUTE container path (the shared-fs mount
 * the agent uses). Must start with `/`, be non-empty, within length, and contain
 * no `..` traversal segment. (The agent runs in a container; a relative or `..`
 * path is a misconfig — e.g. the host path `/Users/...` is absolute and accepted
 * here but is a deploy concern the bridge-side validation surfaces.)
 */
export function isValidAgentMountPath(p: string): boolean {
  if (typeof p !== "string") return false;
  const s = p.trim();
  if (s.length === 0 || s.length > PATH_MAX_LEN) return false;
  if (!s.startsWith("/")) return false;
  if (s.split("/").includes("..")) return false;
  return true;
}

/** The stored (partial) shape — every field optional. */
export type InstanceConfig = {
  mediaMode?: MediaMode;
  inboundMediaMode?: InboundMediaMode;
  rehydration?: boolean;
  mediaMaxMb?: number;
  summarizeThresholdChars?: number;
  curationEnabled?: boolean;
  curationBudgetChars?: number;
  voiceEnabled?: boolean;
  voiceLang?: string;
  voiceRate?: number;
  voiceAutoRead?: boolean;
  contentLocale?: string;
  inboundAgentMount?: string;
  outboundAgentMount?: string;
  promptInjections?: PromptInjectionConfig;
};

/** The complete, dispatch-ready shape (every field present). */
export type ResolvedInstanceConfig = {
  mediaMode: MediaMode;
  inboundMediaMode: InboundMediaMode;
  rehydration: boolean;
  mediaMaxMb: number;
  inboundAgentMount: string;
  outboundAgentMount: string;
};

/** Bounds for the summarize trigger threshold (chars). The floor keeps the engine
 *  from spamming a model call per turn; the cap keeps a typo from disabling it. */
export const SUMMARIZE_THRESHOLD_MIN = 1_000;
export const SUMMARIZE_THRESHOLD_MAX = 200_000;

/** Single source of the per-instance config defaults (the legacy env behaviour). */
export const DEFAULT_INSTANCE_CONFIG: ResolvedInstanceConfig = {
  mediaMode: "gateway-http",
  inboundMediaMode: "inline",
  rehydration: true,
  mediaMaxMb: 1024,
  inboundAgentMount: "/home/node/.openclaw/media/inbound",
  outboundAgentMount: "/home/node/.openclaw/media/outbound",
};

/**
 * Strict semantic parse of a candidate config object. Returns the cleaned
 * (partial) config, or the sentinel `"invalid"` so a caller (the mutation)
 * rejects the WHOLE body rather than silently dropping a bad field. An UNKNOWN
 * key, a bad enum, or an out-of-range `mediaMaxMb` is invalid. `undefined`/`null`
 * is a valid "no override" (returns `{}`).
 */
export function parseInstanceConfig(raw: unknown): InstanceConfig | "invalid" {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const o = raw as Record<string, unknown>;
  const allowed = new Set([
    "mediaMode",
    "inboundMediaMode",
    "rehydration",
    "mediaMaxMb",
    "summarizeThresholdChars",
    "curationEnabled",
    "curationBudgetChars",
    "voiceEnabled",
    "voiceLang",
    "voiceRate",
    "voiceAutoRead",
    "contentLocale",
    "inboundAgentMount",
    "outboundAgentMount",
    "promptInjections",
  ]);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) return "invalid";
  }
  const out: InstanceConfig = {};
  if (o.mediaMode !== undefined) {
    if (!(MEDIA_MODES as readonly string[]).includes(o.mediaMode as string)) {
      return "invalid";
    }
    out.mediaMode = o.mediaMode as MediaMode;
  }
  if (o.inboundMediaMode !== undefined) {
    if (
      !(INBOUND_MEDIA_MODES as readonly string[]).includes(
        o.inboundMediaMode as string,
      )
    ) {
      return "invalid";
    }
    out.inboundMediaMode = o.inboundMediaMode as InboundMediaMode;
  }
  if (o.rehydration !== undefined) {
    if (typeof o.rehydration !== "boolean") return "invalid";
    out.rehydration = o.rehydration;
  }
  if (o.summarizeThresholdChars !== undefined) {
    const n = o.summarizeThresholdChars;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < SUMMARIZE_THRESHOLD_MIN ||
      n > SUMMARIZE_THRESHOLD_MAX
    ) {
      return "invalid";
    }
    out.summarizeThresholdChars = n;
  }
  if (o.curationEnabled !== undefined) {
    if (typeof o.curationEnabled !== "boolean") return "invalid";
    out.curationEnabled = o.curationEnabled;
  }
  if (o.contentLocale !== undefined) {
    if (typeof o.contentLocale !== "string" || !isSupportedLocale(o.contentLocale)) {
      return "invalid";
    }
    out.contentLocale = o.contentLocale;
  }
  if (o.curationBudgetChars !== undefined) {
    const n = o.curationBudgetChars;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < CURATION_BUDGET_MIN ||
      n > CURATION_BUDGET_MAX
    ) {
      return "invalid";
    }
    out.curationBudgetChars = n;
  }
  if (o.voiceEnabled !== undefined) {
    if (typeof o.voiceEnabled !== "boolean") return "invalid";
    out.voiceEnabled = o.voiceEnabled;
  }
  if (o.voiceLang !== undefined) {
    // "auto" or a plausible BCP-47 tag ("fr", "fr-FR") — a display hint for the
    // browser speech engines, not a security boundary; bound the shape anyway.
    if (
      typeof o.voiceLang !== "string" ||
      !/^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/.test(o.voiceLang)
    ) {
      return "invalid";
    }
    out.voiceLang = o.voiceLang;
  }
  if (o.voiceRate !== undefined) {
    const r = o.voiceRate;
    if (typeof r !== "number" || !Number.isFinite(r) || r < 0.5 || r > 2) {
      return "invalid";
    }
    out.voiceRate = r;
  }
  if (o.voiceAutoRead !== undefined) {
    if (typeof o.voiceAutoRead !== "boolean") return "invalid";
    out.voiceAutoRead = o.voiceAutoRead;
  }
  if (o.mediaMaxMb !== undefined) {
    const n = o.mediaMaxMb;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < MEDIA_MAX_MB_MIN ||
      n > MEDIA_MAX_MB_MAX
    ) {
      return "invalid";
    }
    out.mediaMaxMb = n;
  }
  for (const key of ["inboundAgentMount", "outboundAgentMount"] as const) {
    if (o[key] !== undefined) {
      if (typeof o[key] !== "string" || !isValidAgentMountPath(o[key] as string)) {
        return "invalid";
      }
      out[key] = (o[key] as string).trim();
    }
  }
  if (o.promptInjections !== undefined) {
    const parsed = parsePromptInjections(o.promptInjections);
    if (parsed === "invalid") return "invalid";
    // Drop an empty map so a cleared config doesn't persist `{}`.
    if (Object.keys(parsed).length > 0) out.promptInjections = parsed;
  }
  return out;
}

/** Strict parse of the per-injection overrides: keys MUST be registry injections; each
 *  value carries an optional boolean `enabled` and an optional `template` (bounded, and —
 *  when present — required to keep the injection's placeholders, else a custom edit could
 *  silently break the instruction). Unknown key / bad type / dropped placeholder = invalid. */
function parsePromptInjections(
  raw: unknown,
): PromptInjectionConfig | "invalid" {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "invalid";
  }
  const known = new Set<string>(PROMPT_INJECTION_KEYS);
  const out: PromptInjectionConfig = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) return "invalid";
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      return "invalid";
    }
    const o = val as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (k !== "enabled" && k !== "template") return "invalid";
    }
    const entry: { enabled?: boolean; template?: string } = {};
    if (o.enabled !== undefined) {
      if (typeof o.enabled !== "boolean") return "invalid";
      // A non-togglable (core-prompt) injection cannot be disabled — that would leave no
      // task at all. Only `enabled:true` is a harmless no-op; `false` is rejected.
      if (!PROMPT_INJECTIONS[key as PromptInjectionKey].togglable && o.enabled === false) {
        return "invalid";
      }
      entry.enabled = o.enabled;
    }
    if (o.template !== undefined) {
      if (
        typeof o.template !== "string" ||
        o.template.length > INJECTION_TEMPLATE_MAX_LEN
      ) {
        return "invalid";
      }
      const t = o.template.trim();
      // An empty template means "no custom text" (fall back to the default); only a
      // non-empty custom template must keep its required placeholders.
      if (t.length > 0) {
        if (missingRequiredPlaceholders(key as PromptInjectionKey, t).length > 0) {
          return "invalid";
        }
        entry.template = t;
      }
    }
    // Skip an entry that ended up empty (neither a flip nor a custom template).
    if (entry.enabled !== undefined || entry.template !== undefined) {
      out[key] = entry;
    }
  }
  return out;
}

/** Fill defaults so dispatch always sends a COMPLETE config to the bridge. */
export function resolveInstanceConfig(
  cfg: InstanceConfig | undefined | null,
): ResolvedInstanceConfig {
  return {
    mediaMode: cfg?.mediaMode ?? DEFAULT_INSTANCE_CONFIG.mediaMode,
    inboundMediaMode:
      cfg?.inboundMediaMode ?? DEFAULT_INSTANCE_CONFIG.inboundMediaMode,
    rehydration: cfg?.rehydration ?? DEFAULT_INSTANCE_CONFIG.rehydration,
    mediaMaxMb: cfg?.mediaMaxMb ?? DEFAULT_INSTANCE_CONFIG.mediaMaxMb,
    inboundAgentMount:
      cfg?.inboundAgentMount ?? DEFAULT_INSTANCE_CONFIG.inboundAgentMount,
    outboundAgentMount:
      cfg?.outboundAgentMount ?? DEFAULT_INSTANCE_CONFIG.outboundAgentMount,
  };
}

/** The config Convex SENDS to the bridge on dispatch: the raw transport overrides
 *  (partial — the bridge fills its OWN env default for any absent field, so a Convex
 *  default never shadows an env-configured bridge) PLUS the RESOLVED bridge-applied
 *  prompt injections (full — the bridge cannot resolve them, it lacks the registry). The
 *  stored sparse `promptInjections` itself is never sent, only its resolution. */
export type BridgeDispatchConfig = Omit<InstanceConfig, "promptInjections"> & {
  injections: Record<string, ResolvedInjection>;
  /** Set by getChatRouting ONLY on an actual per-turn agent SWITCH (codex P2). The
   *  bridge uses it to re-ground a freshly-routed agent's brand-new session; absent on
   *  a same-agent follow-up so a warm gateway session is kept (no duplicate). */
  routedSwitch?: boolean;
};

export function bridgeDispatchConfig(
  cfg: InstanceConfig | undefined | null,
  // The instance's CONTENT locale — picks the language of default injection texts.
  contentLocale: Locale,
): BridgeDispatchConfig {
  const { promptInjections, ...transport } = cfg ?? {};
  return { ...transport, injections: resolveBridgeInjections(promptInjections, contentLocale) };
}

/** Stable signature (fixed key order) — for "did the applied config change?". */
export function configSignature(c: ResolvedInstanceConfig): string {
  return JSON.stringify([
    c.mediaMode,
    c.inboundMediaMode,
    c.rehydration,
    c.mediaMaxMb,
    c.inboundAgentMount,
    c.outboundAgentMount,
  ]);
}
