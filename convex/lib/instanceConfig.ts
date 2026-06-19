// Per-instance NON-SECRET bridge configuration: the validator (shared by the
// schema column AND the upsertInstanceConfig mutation arg so the two never
// drift), a strict semantic parser, the default-filling resolver, and a stable
// signature. SECRETS (gateway token, device identity, shared secrets) are NEVER
// here — they stay bridge-env only. See the plan + docs/MULTI_AGENT_REDESIGN.md.

import { v } from "convex/values";

/** Outbound media transport for a turn's agent-produced files. */
export const MEDIA_MODES = ["gateway-http", "shared-fs", "off"] as const;
export type MediaMode = (typeof MEDIA_MODES)[number];

/** Inbound (user→agent) attachment transport for tool-read files. */
export const INBOUND_MEDIA_MODES = ["inline", "shared-fs"] as const;
export type InboundMediaMode = (typeof INBOUND_MEDIA_MODES)[number];

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
  // GATEWAY/AGENT-visible shared-fs paths (where the AGENT reads inbound files /
  // writes outbound files — i.e. the gateway container's mount of the shared
  // volume). Used only in shared-fs mode. Non-secret.
  inboundAgentMount: v.optional(v.string()),
  outboundAgentMount: v.optional(v.string()),
});

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
  inboundAgentMount?: string;
  outboundAgentMount?: string;
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
    "inboundAgentMount",
    "outboundAgentMount",
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
