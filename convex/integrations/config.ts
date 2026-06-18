// Vendor configuration for outbound trace shipping (increment 5).
//
// D3 (secrets): vendor credentials live in the Convex DEPLOYMENT environment
// ONLY — never in a table, never returned to a client, never logged. These pure
// helpers read `process.env` and return a small config object that the adapters
// (langfuse.ts / opik.ts) use to build the outbound request. The `configured`
// boolean is the ONLY thing that may safely cross a public boundary (the admin
// status query projects it); the secret fields are for the send() call alone.
//
// Set these on the live deployment with `npx convex env set <KEY> <value>`:
//   - Langfuse: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST
//   - Opik:     OPIK_API_KEY, OPIK_WORKSPACE, OPIK_BASE_URL

import type { QueryCtx } from "../_generated/server";

// Default vendor hosts when the *_HOST / *_BASE_URL env is unset.
const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";
// Comet-hosted Opik cloud API base (self-host overrides via OPIK_BASE_URL).
const DEFAULT_OPIK_BASE_URL = "https://www.comet.com/opik/api";

// Admin-set NON-SECRET overrides from the integrationConfig singleton. Resolution
// precedence everywhere below: override (Convex) -> env -> built-in default. This
// preserves deployments that set LANGFUSE_HOST/OPIK_BASE_URL in env (an empty
// form field must NOT clobber them — only a non-empty Convex value overrides).
export type LangfuseOverride = { host?: string; enabled?: boolean };
export type OpikOverride = {
  baseUrl?: string;
  workspace?: string;
  enabled?: boolean;
  projectName?: string;
  openclawProjectName?: string;
};

/** Read the integrationConfig singleton (non-secret overrides) or null. */
export async function readIntegrationConfig(ctx: QueryCtx) {
  return await ctx.db
    .query("integrationConfig")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .unique();
}

function pick(override: string | undefined, env: string | undefined, dflt: string): string {
  const o = (override ?? "").trim();
  if (o.length > 0) return o;
  const e = (env ?? "").trim();
  return e.length > 0 ? e : dflt;
}

/**
 * Langfuse config. `configured` is true only when BOTH keys are present (the
 * host always has a default). Returns the secret material for send()'s use —
 * NEVER expose this object over a public boundary; the status query reads only
 * `configured`.
 */
export type LangfuseConfig = {
  configured: boolean;
  enabled: boolean; // admin master switch (default true); ship only when enabled
  host: string;
  publicKey: string;
  secretKey: string;
};

export function langfuseConfig(override?: LangfuseOverride): LangfuseConfig {
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const secretKey = (process.env.LANGFUSE_SECRET_KEY ?? "").trim();
  const host = stripTrailingSlash(
    pick(override?.host, process.env.LANGFUSE_HOST, DEFAULT_LANGFUSE_HOST),
  );
  return {
    configured: publicKey.length > 0 && secretKey.length > 0,
    enabled: override?.enabled !== false, // undefined => enabled
    host,
    publicKey,
    secretKey,
  };
}

/**
 * Opik config. `configured` is true only when the API key is present (the base
 * URL always has a default; the workspace is optional — Opik maps the token to a
 * default workspace server-side when omitted).
 */
export type OpikConfig = {
  configured: boolean;
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  workspace: string;
  /** Opik project ATRIUM's OWN traces live in. REQUIRED by the read API (`GET
   *  /v1/private/spans` 400s without `project_name`), and the WRITE batch lands
   *  traces here so ship + enrich stay consistent. Default "Default Project"
   *  (Opik's own default when a trace omits it). */
  projectName: string;
  /** SEPARATE project Atrium READS OpenClaw's OWN traces from (the plugins ship
   *  there, e.g. "openclaw-<canonical>"). Empty = no OpenClaw thread-search (only
   *  Atrium's own deterministic trace). Kept distinct from `projectName` so
   *  Atrium's metadata traces never mix with OpenClaw's rich span trees. */
  openclawProjectName: string;
};

// Opik's default project name when a trace is ingested without `project_name`.
const DEFAULT_OPIK_PROJECT = "Default Project";

export function opikConfig(override?: OpikOverride): OpikConfig {
  const apiKey = (process.env.OPIK_API_KEY ?? "").trim();
  const workspace = pick(override?.workspace, process.env.OPIK_WORKSPACE, "");
  const baseUrl = stripTrailingSlash(
    pick(override?.baseUrl, process.env.OPIK_BASE_URL, DEFAULT_OPIK_BASE_URL),
  );
  const projectName = pick(
    override?.projectName,
    process.env.OPIK_PROJECT_NAME,
    DEFAULT_OPIK_PROJECT,
  );
  const openclawProjectName = pick(
    override?.openclawProjectName,
    process.env.OPIK_OPENCLAW_PROJECT,
    "",
  );
  return {
    configured: apiKey.length > 0,
    enabled: override?.enabled !== false,
    baseUrl,
    apiKey,
    workspace,
    projectName,
    openclawProjectName,
  };
}

/** Normalize a base URL so adapters can append paths without double slashes. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
