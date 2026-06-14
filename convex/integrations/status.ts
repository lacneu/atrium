// Admin-only status + NON-SECRET config of the integrations (increment 5 + the
// editable-config increment).
//
// NEVER exposes secret values — only `configured` booleans (derived from env key
// presence), the non-secret knobs an admin set (host/baseUrl/workspace/enabled +
// the stored tts/talk config), and the per-vendor cursors. API KEYS live in the
// deployment env (D3) and never cross this boundary.

import { query, QueryCtx } from "../_generated/server";
import { requireAdmin } from "../lib/access";
import { langfuseConfig, opikConfig, readIntegrationConfig } from "./config";

type VendorKnobs = { host?: string; baseUrl?: string; workspace?: string; enabled?: boolean };
type VoiceKnobs = Record<string, string | number | boolean | undefined>;

type IntegrationsStatus = {
  langfuse: { configured: boolean; enabled: boolean; effectiveHost: string };
  opik: {
    configured: boolean;
    enabled: boolean;
    effectiveBaseUrl: string;
    effectiveWorkspace: string;
  };
  // The RAW stored overrides (what the admin set; per-field may be undefined) so
  // the forms populate their inputs; the effective* values above are placeholders.
  config: {
    langfuse: VendorKnobs;
    opik: VendorKnobs;
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

export const status = query({
  args: {},
  handler: async (ctx: QueryCtx): Promise<IntegrationsStatus> => {
    await requireAdmin(ctx);

    const cfg = await readIntegrationConfig(ctx);
    const lf = langfuseConfig(cfg?.langfuse ?? undefined);
    const op = opikConfig(cfg?.opik ?? undefined);

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
      config: {
        langfuse: cfg?.langfuse ?? {},
        opik: cfg?.opik ?? {},
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
