/**
 * Shared tool logic for both the MCP server and the CLI.
 *
 * Each function here maps 1:1 to one /api/v1 route. The package is a thin proxy:
 * whether a route is deployed is a *runtime* concern — a not-yet-deployed route
 * returns the API's own response/error (e.g. 404) which we surface, rather than
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

export const getDeliveryReportInput = {
  sessionId: z.string().optional()
    .describe("Recording session id; omit for the active (or most recent) session."),
} as const;

export const deleteDeliverySessionsInput = {
  sessionIds: z.array(z.string()).min(1)
    .describe("Recording session ids to delete (along with their timing rows)."),
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

export const getSchemaInput = {
  id: z.string().describe(
    "The schema registry id (from list_schemas), e.g. \"provenance.v1\" (required).",
  ),
} as const;

export const getTraceEnrichmentInput = {
  correlationId: z
    .string()
    .describe(
      "The Atrium correlationId of the turn (from a trace/anomaly via list_traces/list_anomalies) — the deterministic key to the Opik/Langfuse trace (required).",
    ),
  chatId: z
    .string()
    .optional()
    .describe(
      "Optional chat id. Enables the Langfuse session augmentation: surfaces OTHER traces on the same chat session (incl. any OpenClaw-emitted one), content-free. Omit for this turn's deterministic trace only.",
    ),
  at: z
    .number()
    .optional()
    .describe(
      "The ORIGINAL trace timestamp (epoch ms), from the same trace/anomaly row as " +
        "the correlationId. REQUIRED to resolve an Opik trace (its id bakes the " +
        "timestamp in); omit only for a Langfuse-only lookup. Without it, Opik " +
        "reports `needs_timestamp` rather than silently returning nothing.",
    ),
} as const;

export interface GetTraceEnrichmentArgs {
  correlationId: string;
  chatId?: string;
  at?: number;
}

export const diagnoseChatInput = {
  chatId: z.string().describe("The chat id to diagnose (required)."),
} as const;

export const reconcileChatInput = {
  chatId: z
    .string()
    .describe("The chat id whose stuck stream to reconcile (required)."),
} as const;

export const syncInstanceInput = {
  instance: z
    .string()
    .describe("The instance NAME to force-sync (required)."),
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
 * GET /api/v1/bridge-status — a CLEAR per-instance bridge<->gateway health view: per
 * instance `bridgeUrlConfigured`, `available`/`degraded` + `reason`, `gatewayVersion` +
 * `gatewayState`/`lastErrorCode`, `agentCount` + discovery freshness. Requires
 * `bridge.read`. The fast "what's wrong with my instances" check — e.g. an instance with
 * `bridgeUrlConfigured:false` is exactly why a sync returns `no_bridge_url`.
 */
export function bridgeStatus(
  config: Config,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, "/bridge-status", {}, options);
}

/**
 * GET /api/v1/integrations — Opik/Langfuse integration status: per vendor
 * `configured`/`enabled` + the NON-SECRET effective endpoints + the shipping
 * cursors (lastAt/failureCount/error code). NEVER a key. Requires `traces.read`.
 * The self-correction loop's first step: an agent learns whether enriched
 * observability data is available (and shipping is healthy) before asking for it.
 */
export function getIntegrations(
  config: Config,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, "/integrations", {}, options);
}

/**
 * GET /api/v1/chat-state — per-message lifecycle of one chat (METADATA ONLY: no
 * text). Requires `traces.read`. Exposes the stuck-streaming signal: a message
 * `status:"streaming"` with a large `ageSeconds` (`stuckStreaming:true`) is a
 * turn whose finalize frame the bridge never relayed. A provenance part also
 * carries a SOC2-safe `structure` (per-item kind + hasFileName/hasScore booleans,
 * counts, allowlisted source/route) for diagnosing the Sources panel content-free.
 *
 * TURN RECONSTRUCTION (content-free): per message, `outbox:{outboxId,status}` is
 * the dispatch JOIN KEY — `chatId:outboxId` is the correlationId of that turn's
 * chat.send / openclaw.dispatch (and openclaw.rehydrate) traces, so list_traces
 * stitches a message to its dispatch chain. NOTE on `outbox:null`: it means EITHER
 * no outbox row (an assistant message — only user turns dispatch) OR a user message
 * older than the per-status read cap; when top-level `outboxTruncated` is true, read
 * null on an OLDER user message as "beyond the cap", NOT as "never dispatched". The
 * most-recent user turns are always covered. Per message, `routedInstanceName` /
 * `routedAgentId` give the per-turn routed agent (null = the chat's primary).
 * Chat-level `routing` (perTurnRouting + lastRouted* + the opaque `routingSegment`)
 * shows whether/where the chat fans turns to specialists. `subAgents` is the
 * content-free delegation summary: `byStatus` counts + capped `failedSample` /
 * `runningSample` (each = childIdShort + status enum + errorCategory enum +
 * hasTaskName bool + ageSeconds — NEVER the task/result/error text or phase).
 */
export function getChatState(
  config: Config,
  args: { chatId: string },
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, `/chat-state${qs({ chatId: args.chatId })}`, {}, options);
}

/**
 * GET /api/v1/schemas — the published CONTRACT schemas an integration author can
 * conform to (provenance/v1 today; more as the surface grows). Metadata list (id,
 * title, version, category). PUBLIC (no key required). The discovery step before
 * fetching one schema with get_schema.
 */
export function listSchemas(
  config: Config,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, "/schemas", {}, options);
}

/**
 * GET /api/v1/schemas/:id — one published contract schema's JSON (e.g.
 * "provenance.v1"), to validate a plugin's emitted reports against. PUBLIC (no key
 * required). 404 for an unknown id.
 */
export function getSchema(
  config: Config,
  args: { id: string },
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, `/schemas/${encodeURIComponent(args.id)}`, {}, options);
}

/**
 * GET /api/v1/trace-enrichment — the SOC2-safe STRUCTURE of a turn's trace (keyed
 * by its correlationId) from the configured Opik/Langfuse: span
 * names/types/lifecycle/timing/parent tree, NEVER input/output/message
 * text/metadata. Requires `traces.read`. The self-correction loop's deep read: an
 * agent sees the REAL OpenClaw message structure behind an anomaly without ever
 * seeing regulated data.
 */
export function getTraceEnrichment(
  config: Config,
  args: GetTraceEnrichmentArgs,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    `/trace-enrichment${qs({ correlationId: args.correlationId, chatId: args.chatId, at: args.at })}`,
    {},
    options,
  );
}

/**
 * GET /api/v1/diagnose — ONE actionable assessment of a chat for the
 * self-correction loop: SOC2-safe chat-state + bridge availability, classified
 * (stuck_stream | dispatch_error | attachment_problem | subagent_stuck |
 * subagent_failure | bridge_unavailable | bridge_degraded | healthy) with a
 * `suggestedAction` and, when a safe corrective exists, a `suggestedTool`.
 * `subagent_stuck` (a delegated sub-agent running far too long — a main turn
 * awaiting it can hang) and `subagent_failure` (a recent failed delegation) read
 * the new chat-state `subAgents` summary. Requires `traces.read`. Read-only. Call
 * FIRST on a user report, then act on the suggestion.
 */
export function diagnoseChat(
  config: Config,
  args: { chatId: string },
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, `/diagnose${qs({ chatId: args.chatId })}`, {}, options);
}

/**
 * POST /api/v1/reconcile-chat — the BOUNDED corrective `diagnose` may recommend:
 * flip this chat's stuck 'streaming' message(s) to error (preserving text),
 * releasing the hung UI so the user can retry. Requires `selfheal` (a sensitive
 * write). Audited. Only touches messages already streaming past a short cutoff.
 */
export function reconcileChat(
  config: Config,
  args: { chatId: string },
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    "/reconcile-chat",
    { method: "POST", body: JSON.stringify({ chatId: args.chatId }) },
    options,
  );
}

/**
 * POST /api/v1/instances/sync — force an instance sync: poke the bridge (resolve creds +
 * connect -> pairing) then pull THAT instance's agents into Atrium NOW, instead of waiting
 * for the discovery cron. Requires `selfheal` (the admin + agent service-account roles).
 * Returns `{ status, agents, detail }` — `status` is the exact outcome (synced | no_agents
 * | no_bridge_url | unreachable | unauthorized | not_served | deploy_misconfigured) and
 * `detail` is a plain-English explanation an agent can act on.
 */
export function syncInstance(
  config: Config,
  args: { instance: string },
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    "/instances/sync",
    { method: "POST", body: JSON.stringify({ instance: args.instance }) },
    options,
  );
}

/**
 * POST /api/v1/delivery-record/start — start a delivery-latency recording session
 * (measures the bridge->Convex->frontend streaming pipeline, per delta, content-free).
 * Requires `selfheal` (activation is a privileged write). Returns { sessionId,
 * autoStopAt }; the session auto-stops after ~10 min.
 */
export function startDeliveryRecord(
  config: Config,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    "/delivery-record/start",
    { method: "POST", body: "{}" },
    options,
  );
}

/** POST /api/v1/delivery-record/stop — stop the active recording. Requires `selfheal`. */
export function stopDeliveryRecord(
  config: Config,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    "/delivery-record/stop",
    { method: "POST", body: "{}" },
    options,
  );
}

/**
 * GET /api/v1/delivery-report — skew-corrected per-segment latency for a recording
 * session: A=bridge->Convex, B=Convex exec, C=Convex->frontend (p50/p95/max + counts;
 * C.count <= A.count by design, since the client only observes coalesced states).
 * Requires `traces.read`. Omit sessionId for the active (or most recent) session.
 */
export function getDeliveryReport(
  config: Config,
  args: { sessionId?: string },
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    `/delivery-report${qs({ sessionId: args.sessionId })}`,
    {},
    options,
  );
}

/**
 * GET /api/v1/delivery-sessions — list recent recording sessions (sessionId,
 * startedAt, stoppedAt, startedBy, active). Requires `traces.read`. Use to pick a
 * sessionId for get_delivery_report or delete_delivery_sessions.
 */
export function listDeliverySessions(
  config: Config,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, "/delivery-sessions", {}, options);
}

/**
 * POST /api/v1/delivery-record/delete — delete recording sessions and their timing
 * rows. Requires `selfheal`. Deleting the active session also stops recording.
 */
export function deleteDeliverySessions(
  config: Config,
  args: { sessionIds: string[] },
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    "/delivery-record/delete",
    { method: "POST", body: JSON.stringify({ sessionIds: args.sessionIds }) },
    options,
  );
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

/** GET /api/v1/kpi — KPI rollups. Requires `kpi.read`. */
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
 * POST /api/v1/openclaw/query — query OpenClaw via the bridge.
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

/** GET /api/v1/anomalies — detected anomalies. Requires `anomalies.read`. */
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
 * POST /api/v1/anomalies — report an anomaly. Requires
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
