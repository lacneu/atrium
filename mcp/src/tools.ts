/**
 * Shared tool logic for both the MCP server and the CLI.
 *
 * Each function here maps 1:1 to a PLANNED /api/v1 route (see
 * docs/OBSERVABILITY_PLATFORM_PLAN.md). The package is a thin proxy: it builds
 * against the plan even though some routes only land in increments 4/6. Whether
 * a route is deployed is a *runtime* concern — a not-yet-deployed route returns
 * the API's own response/error (e.g. 404) which we surface, rather than
 * crashing the server.
 *
 * Server-side `requirePermission` enforces the key's scope, so a tool call to a
 * route the key lacks permission for naturally returns 403.
 */

import { z } from "zod";
import { apiFetch, type ApiFetchOptions, type Config } from "./config.js";

export interface ListTracesArgs {
  limit?: number;
  /** Case-insensitive substring over kind/principalId/roleKey/route/correlationId. */
  q?: string;
  /** Lower time bound: epoch ms OR Grafana relative token (e.g. `now-24h`). */
  from?: string;
  /** Upper time bound: epoch ms OR Grafana relative token (e.g. `now`). */
  to?: string;
  kind?: string;
  /** Exact HTTP status code (e.g. 404). */
  status?: number;
  /** HTTP status class. */
  statusClass?: "2xx" | "4xx" | "5xx";
  direction?: string;
  principalType?: string;
  roleKey?: string;
  correlationId?: string;
}

export interface GetKpiArgs {
  metric?: string;
  since?: string;
  /** Lower time bound: epoch ms OR Grafana relative token (e.g. `now-24h`). */
  from?: string;
  /** Upper time bound: epoch ms OR Grafana relative token (e.g. `now`). */
  to?: string;
}

export interface QueryOpenClawArgs {
  /** Matches the server contract: POST /api/v1/openclaw/query reads `question`. */
  question?: string;
  /** Free-form passthrough the route forwards to the bridge action. */
  payload?: unknown;
}

export interface ListAnomaliesArgs {
  limit?: number;
  since?: string;
  /** Case-insensitive substring over message/kind/correlationId. */
  q?: string;
  /** Lower time bound: epoch ms OR Grafana relative token (e.g. `now-24h`). */
  from?: string;
  /** Upper time bound: epoch ms OR Grafana relative token (e.g. `now`). */
  to?: string;
  /** Anomaly status (maps to anomalyStatus, e.g. 'open'|'acknowledged'). */
  status?: string;
  severity?: string;
  source?: string;
  kind?: string;
}

export interface ReportAnomalyArgs {
  kind: string;
  /** Server accepts only info|warn|critical (400 otherwise). */
  severity: "info" | "warn" | "critical";
  message: string;
  correlationId?: string;
  /** Maps to the server's `evidence` field (non-PHI structured context). */
  evidence?: unknown;
}

/**
 * Shared MCP input schemas, kept here (not in server.ts) so they can be unit
 * tested without importing server.ts/cli.ts — both of which call `main()` at
 * module load. server.ts spreads these into `registerTool({ inputSchema })`.
 */

export const queryOpenClawInput = {
  question: z.string().optional().describe("Prompt/query text."),
  payload: z.unknown().optional()
    .describe("Free-form passthrough forwarded to the bridge."),
} as const;

export const reportAnomalyInput = {
  kind: z.string().describe("Anomaly kind/type (required)."),
  severity: z.enum(["info", "warn", "critical"])
    .describe("Severity: 'info' | 'warn' | 'critical' (required)."),
  message: z.string().describe("Human-readable description (required)."),
  correlationId: z.string().optional()
    .describe("Correlation chain this anomaly relates to."),
  evidence: z.unknown().optional()
    .describe("Free-form structured, non-PHI evidence."),
} as const;

/**
 * Time-range token: epoch ms (numeric string) OR a Grafana-style relative
 * token — `now`, or `now-<N><unit>` with unit in s|m|h|d|w (e.g. `now-24h`).
 * Passed through verbatim; the server resolves tokens → ms at request time.
 */
const FROM_DESCRIBE =
  "Lower time bound. Epoch ms (e.g. '1717372800000') OR Grafana relative " +
  "token: 'now' or 'now-<N><unit>' with unit s|m|h|d|w (e.g. 'now-24h').";
const TO_DESCRIBE =
  "Upper time bound. Epoch ms (e.g. '1717459200000') OR Grafana relative " +
  "token: 'now' or 'now-<N><unit>' with unit s|m|h|d|w (e.g. 'now').";

export const listTracesInput = {
  limit: z.number().int().min(1).max(200).optional()
    .describe("Max events to return (1-200)."),
  q: z.string().optional()
    .describe(
      "Case-insensitive substring over kind, principalId, roleKey, route, correlationId.",
    ),
  from: z.string().optional().describe(FROM_DESCRIBE),
  to: z.string().optional().describe(TO_DESCRIBE),
  kind: z.string().optional()
    .describe("Filter by event kind (e.g. 'api.call')."),
  status: z.number().int().optional()
    .describe("Filter by exact HTTP status code (e.g. 404)."),
  statusClass: z.enum(["2xx", "4xx", "5xx"]).optional()
    .describe("Filter by HTTP status class: '2xx' | '4xx' | '5xx'."),
  direction: z.string().optional()
    .describe("Filter by direction (e.g. 'inbound' | 'outbound')."),
  principalType: z.string().optional()
    .describe("Filter by principal type (e.g. 'user' | 'service')."),
  roleKey: z.string().optional().describe("Filter by role key."),
  correlationId: z.string().optional()
    .describe("Filter to one correlation chain."),
} as const;

export const getKpiInput = {
  metric: z.string().optional()
    .describe("Filter to a single metric name."),
  since: z.string().optional()
    .describe("ISO timestamp or bucket lower bound (kept; equivalent to from)."),
  from: z.string().optional().describe(FROM_DESCRIBE),
  to: z.string().optional().describe(TO_DESCRIBE),
} as const;

export const listAnomaliesInput = {
  limit: z.number().int().min(1).max(200).optional()
    .describe("Max anomalies to return (1-200)."),
  since: z.string().optional()
    .describe("ISO timestamp lower bound (kept; equivalent to from)."),
  q: z.string().optional()
    .describe("Case-insensitive substring over message, kind, correlationId."),
  from: z.string().optional().describe(FROM_DESCRIBE),
  to: z.string().optional().describe(TO_DESCRIBE),
  status: z.string().optional()
    .describe("Filter by anomaly status (e.g. 'open' | 'acknowledged')."),
  severity: z.string().optional()
    .describe("Filter by severity (e.g. 'info' | 'warn' | 'critical')."),
  source: z.string().optional().describe("Filter by anomaly source."),
  kind: z.string().optional().describe("Filter by anomaly kind/type."),
} as const;

export const getChatStateInput = {
  chatId: z.string().describe(
    "The chat id (the /chat/<id> path segment) to inspect (required).",
  ),
} as const;

/** Build a query string from defined values only (Bearer is never in the URL). */
function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      sp.set(key, String(value));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** GET /api/v1/health — liveness probe (no auth needed, but we send the key). */
export function health(
  config: Config,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, "/health", {}, options);
}

/**
 * GET /api/v1/compat — the bridge compatibility snapshot (reachable,
 * bridgeVersion, per-instance targets + their gatewayVersion). Requires
 * `bridge.read`. Diagnoses the "version gateway inconnue" gating: empty
 * `targets` (or a `gatewayVersion: null` target) is what gates AgentFiles /
 * ChatDefaults off.
 */
export function getCompat(
  config: Config,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, "/compat", {}, options);
}

/**
 * GET /api/v1/chat-state — per-message lifecycle of one chat (METADATA ONLY: no
 * text). Requires `traces.read`. Exposes the stuck-streaming signal: a message
 * `status:"streaming"` with a large `ageSeconds` (`stuckStreaming:true`) is a
 * turn whose finalize frame the bridge never relayed.
 */
export function getChatState(
  config: Config,
  args: { chatId: string },
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, `/chat-state${qs({ chatId: args.chatId })}`, {}, options);
}

/** GET /api/v1/traces — recent trace events. Requires `traces.read`. */
export function listTraces(
  config: Config,
  args: ListTracesArgs = {},
  options?: ApiFetchOptions,
): Promise<unknown> {
  const query = qs({
    limit: args.limit,
    q: args.q,
    from: args.from,
    to: args.to,
    kind: args.kind,
    status: args.status,
    statusClass: args.statusClass,
    direction: args.direction,
    principalType: args.principalType,
    roleKey: args.roleKey,
    correlationId: args.correlationId,
  });
  return apiFetch(config, `/traces${query}`, {}, options);
}

/** GET /api/v1/kpi — KPI rollups (increment 4). Requires `kpi.read`. */
export function getKpi(
  config: Config,
  args: GetKpiArgs = {},
  options?: ApiFetchOptions,
): Promise<unknown> {
  const query = qs({
    metric: args.metric,
    since: args.since,
    from: args.from,
    to: args.to,
  });
  return apiFetch(config, `/kpi${query}`, {}, options);
}

/**
 * POST /api/v1/openclaw/query — query OpenClaw via the bridge (increment 6).
 * Requires `openclaw.query`. Sends `{ question, payload }` (the only keys the
 * server route reads; it 400s when both are undefined).
 */
export function queryOpenClaw(
  config: Config,
  args: QueryOpenClawArgs = {},
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    "/openclaw/query",
    { method: "POST", body: JSON.stringify(args) },
    options,
  );
}

/** GET /api/v1/anomalies — detected anomalies (increment 6). Requires `anomalies.read`. */
export function listAnomalies(
  config: Config,
  args: ListAnomaliesArgs = {},
  options?: ApiFetchOptions,
): Promise<unknown> {
  const query = qs({
    limit: args.limit,
    since: args.since,
    q: args.q,
    from: args.from,
    to: args.to,
    status: args.status,
    severity: args.severity,
    source: args.source,
    kind: args.kind,
  });
  return apiFetch(config, `/anomalies${query}`, {}, options);
}

/**
 * POST /api/v1/anomalies — report an anomaly (increment 6). Requires
 * `anomalies.report`. Sends `evidence` (the server's field name), not `details`.
 */
export function reportAnomaly(
  config: Config,
  args: ReportAnomalyArgs,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    "/anomalies",
    { method: "POST", body: JSON.stringify(args) },
    options,
  );
}
