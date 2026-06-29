// Admin-only status + NON-SECRET config of the integrations (increment 5 + the
// editable-config increment).
//
// NEVER exposes secret values — only `configured` booleans (derived from env key
// presence), the non-secret knobs an admin set (host/baseUrl/workspace/enabled +
// the stored tts/talk config), and the per-vendor cursors. API KEYS live in the
// deployment env (D3) and never cross this boundary.

import { internalQuery, query, QueryCtx } from "../_generated/server";
import { requireAdmin } from "../lib/access";
import {
  langfuseConfig,
  opikConfig,
  otlpConfig,
  readIntegrationConfig,
} from "./config";

// The API/MCP-safe integration status: configured/enabled + the NON-SECRET
// effective endpoints + the shipping cursors (vendor/lastAt/failureCount/error
// code+status). NEVER a key or a raw admin override. This is what an AI agent
// reads over /api/v1 to learn "is Opik/Langfuse wired, and is shipping healthy".
export type IntegrationsStatusPublic = {
  langfuse: { configured: boolean; enabled: boolean; host: string };
  opik: {
    configured: boolean;
    enabled: boolean;
    baseUrl: string;
    workspace: string;
  };
  // Generic OTLP exporter. `headersSet` is a boolean PRESENCE flag — the encrypted
  // headers envelope NEVER crosses this boundary. `endpoint` is the non-secret URL.
  otlp: {
    configured: boolean;
    enabled: boolean;
    endpoint: string;
    headersSet: boolean;
  };
  cursors: Array<{
    vendor: string;
    lastAt: number;
    failureCount: number;
    lastError: string | null;
    lastErrorStatus: number | null;
  }>;
};

/** Compute the API/MCP-safe status (no auth, no secrets). Shared by the admin
 *  `status` query and the key-authed `/api/v1/integrations` route. */
export async function loadIntegrationsStatusPublic(
  ctx: QueryCtx,
): Promise<IntegrationsStatusPublic> {
  const cfg = await readIntegrationConfig(ctx);
  const lf = langfuseConfig(cfg?.langfuse ?? undefined);
  const op = opikConfig(cfg?.opik ?? undefined);
  const ot = otlpConfig(cfg?.otlp ?? undefined);
  const cursorRows = await ctx.db.query("integrationCursors").take(50);
  return {
    langfuse: { configured: lf.configured, enabled: lf.enabled, host: lf.host },
    opik: {
      configured: op.configured,
      enabled: op.enabled,
      baseUrl: op.baseUrl,
      workspace: op.workspace,
    },
    otlp: {
      configured: ot.configured,
      enabled: ot.enabled,
      endpoint: ot.endpoint,
      headersSet: cfg?.otlp?.headersSecret !== undefined,
    },
    cursors: cursorRows.map((r) => ({
      vendor: r.vendor,
      lastAt: r.lastAt,
      failureCount: r.failureCount ?? 0,
      lastError: r.lastError ?? null,
      lastErrorStatus: r.lastErrorStatus ?? null,
    })),
  };
}

type VendorKnobs = { host?: string; baseUrl?: string; workspace?: string; enabled?: boolean };
type VoiceKnobs = Record<string, string | number | boolean | undefined>;

export type OtlpKnobs = { endpoint?: string; enabled?: boolean };

/**
 * Project the stored OTLP override to the NON-SECRET knobs the admin form reads
 * (endpoint/enabled). Built ADDITIVELY so an unset field is OMITTED, never present
 * with an explicit `undefined` value (mirrors how langfuse/opik return their raw
 * knobs via `cfg?.x ?? {}`), and the encrypted `headersSecret` envelope is NEVER
 * copied (status exposes a presence boolean only). Pure + exported so the shape is
 * unit-testable pre-serialization. (Convex's `convexToJson` strips undefined object
 * props at the wire, so a present-but-undefined key is harmless TODAY — but it is a
 * smell and would break under a future `returns` validator; omit it at the source.)
 */
export function projectOtlpKnobs(
  otlp: { endpoint?: string; enabled?: boolean; headersSecret?: unknown } | undefined,
): OtlpKnobs {
  const knobs: OtlpKnobs = {};
  if (otlp?.endpoint !== undefined) knobs.endpoint = otlp.endpoint;
  if (otlp?.enabled !== undefined) knobs.enabled = otlp.enabled;
  return knobs;
}

type IntegrationsStatus = {
  langfuse: { configured: boolean; enabled: boolean; effectiveHost: string };
  opik: {
    configured: boolean;
    enabled: boolean;
    effectiveBaseUrl: string;
    effectiveWorkspace: string;
  };
  // Generic OTLP. `headersSet` is presence-only (the envelope never crosses here).
  otlp: {
    configured: boolean;
    enabled: boolean;
    effectiveEndpoint: string;
    headersSet: boolean;
  };
  // The RAW stored overrides (what the admin set; per-field may be undefined) so
  // the forms populate their inputs; the effective* values above are placeholders.
  config: {
    langfuse: VendorKnobs;
    opik: VendorKnobs;
    otlp: OtlpKnobs; // endpoint/enabled ONLY — never the headers envelope
    tts: VoiceKnobs;
    talk: VoiceKnobs;
  };
  // Secret PRESENCE only (env), so a form can show "clé configurée via env".
  secrets: { openai: boolean };
  cursors: Array<{
    vendor: string;
    lastAt: number;
    failureCount: number;
    lastError: string | null;
    lastErrorStatus: number | null;
  }>;
};

/** API/MCP-safe integration status (no auth — the /api/v1 route runs the key
 *  permission check first; httpActions cannot run it themselves). */
export const statusInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<IntegrationsStatusPublic> =>
    loadIntegrationsStatusPublic(ctx),
});

export const status = query({
  args: {},
  handler: async (ctx: QueryCtx): Promise<IntegrationsStatus> => {
    await requireAdmin(ctx);

    const cfg = await readIntegrationConfig(ctx);
    const lf = langfuseConfig(cfg?.langfuse ?? undefined);
    const op = opikConfig(cfg?.opik ?? undefined);
    const ot = otlpConfig(cfg?.otlp ?? undefined);
    // Project the OTLP override to endpoint/enabled ONLY — the encrypted headers
    // envelope must NEVER reach the browser (status exposes a presence flag only).
    // Additive projection: unset knobs are OMITTED (never present-but-undefined).
    const otlpKnobs: OtlpKnobs = projectOtlpKnobs(cfg?.otlp);

    const cursorRows = await ctx.db.query("integrationCursors").take(50);
    const cursors = cursorRows.map((r) => ({
      vendor: r.vendor,
      lastAt: r.lastAt,
      failureCount: r.failureCount ?? 0,
      lastError: r.lastError ?? null,
      lastErrorStatus: r.lastErrorStatus ?? null,
    }));

    return {
      langfuse: {
        configured: lf.configured,
        enabled: lf.enabled,
        effectiveHost: lf.host,
      },
      opik: {
        configured: op.configured,
        enabled: op.enabled,
        effectiveBaseUrl: op.baseUrl,
        effectiveWorkspace: op.workspace,
      },
      otlp: {
        configured: ot.configured,
        enabled: ot.enabled,
        effectiveEndpoint: ot.endpoint,
        headersSet: cfg?.otlp?.headersSecret !== undefined,
      },
      config: {
        langfuse: cfg?.langfuse ?? {},
        opik: cfg?.opik ?? {},
        otlp: otlpKnobs,
        tts: cfg?.tts ?? {},
        talk: cfg?.talk ?? {},
      },
      secrets: {
        openai: (process.env.OPENAI_API_KEY ?? "").trim().length > 0,
      },
      cursors,
    };
  },
});
