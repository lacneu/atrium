#!/usr/bin/env node
/**
 * atrium MCP server (stdio).
 *
 * A thin proxy over our /api/v1 observability surface. It carries an `oc_live_`
 * Bearer key (from OPENCLAW_WEBCHAT_API_KEY) against the deployment `.site`
 * origin (OPENCLAW_WEBCHAT_API_BASE) and exposes traces/KPIs/OpenClaw queries/
 * anomalies as MCP tools for OpenClaw agents.
 *
 * It imports NOTHING from the Convex app — HTTP only. Each tool maps 1:1 to a
 * permission enforced server-side (`requirePermission`), so a scoped key simply
 * gets a 403 for tools it isn't allowed to call. A tool whose route is not yet
 * deployed returns the API's response/error gracefully rather than crashing.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiError, resolveConfig } from "./config.js";
import {
  getChatState,
  getChatStateInput,
  getTraceEnrichment,
  getTraceEnrichmentInput,
  diagnoseChat,
  diagnoseChatInput,
  reconcileChat,
  reconcileChatInput,
  getCompat,
  bridgeStatus,
  syncInstance,
  syncInstanceInput,
  getIntegrations,
  getKpi,
  getKpiInput,
  getSchema,
  getSchemaInput,
  health,
  listAnomalies,
  listAnomaliesInput,
  listSchemas,
  listTraces,
  listTracesInput,
  queryOpenClaw,
  queryOpenClawInput,
  reportAnomaly,
  reportAnomalyInput,
} from "./tools.js";

// The MCP server's own version, read from package.json at startup. createRequire
// (not a static JSON import) because tsconfig.build.json roots at src/ and a
// static import of ../package.json would escape rootDir — same idiom as the bridge
// (bridge/src/compat.ts). Lockstep with the repo's single version, stamped from the
// git tag at release time (scripts/set-version.mjs); "0.0.0" only as a last resort.
const pkg = createRequire(import.meta.url)("../package.json") as {
  version?: unknown;
};
const MCP_VERSION: string =
  typeof pkg.version === "string" && pkg.version.length > 0
    ? pkg.version
    : "0.0.0";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Wrap a tool call: stringify JSON on success, surface ApiError as text. */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
  } catch (err) {
    if (err instanceof ApiError) {
      const bodyText =
        typeof err.body === "string"
          ? err.body
          : JSON.stringify(err.body, null, 2);
      return {
        content: [
          { type: "text", text: `API error ${err.status}: ${bodyText}` },
        ],
        isError: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}

function main(): void {
  // Resolve config up front so a missing key fails fast with a clear message
  // (the message names the env var, never its value).
  const config = resolveConfig();

  const server = new McpServer({
    name: "atrium-observability",
    version: MCP_VERSION,
  });

  server.registerTool(
    "health",
    {
      title: "API health",
      description: "Liveness probe for the /api/v1 surface (GET /health).",
      inputSchema: {},
    },
    async () => run(() => health(config)),
  );

  server.registerTool(
    "get_compat",
    {
      title: "Bridge compatibility snapshot",
      description:
        "Bridge version + per-instance gateway versions/capabilities (GET /compat). " +
        "Requires bridge.read. Diagnoses 'version gateway inconnue': empty targets " +
        "or a null gatewayVersion gates AgentFiles/ChatDefaults off.",
      inputSchema: {},
    },
    async () => run(() => getCompat(config)),
  );

  server.registerTool(
    "bridge_status",
    {
      title: "Per-instance bridge/gateway health",
      description:
        "A CLEAR per-instance bridge<->gateway health view (GET /bridge-status). " +
        "Requires bridge.read. Per instance: bridgeUrlConfigured, a health verdict " +
        "(ok|error|stale|unknown|no_bridge_url, from THIS instance's own signals — not the " +
        "global bridge state) + degraded, gatewayVersion + gatewayState/lastErrorCode, " +
        "agentCount + discovery freshness. The fast 'what's wrong with my instances' check " +
        "— e.g. bridgeUrlConfigured:false is exactly why a sync returns no_bridge_url.",
      inputSchema: {},
    },
    async () => run(() => bridgeStatus(config)),
  );

  server.registerTool(
    "get_integrations",
    {
      title: "Observability integration status (Opik / Langfuse)",
      description:
        "Per-vendor configured/enabled + non-secret effective endpoints + shipping " +
        "cursors (lastAt/failureCount/error code), NEVER a key (GET /integrations). " +
        "Requires traces.read. Use FIRST when self-diagnosing: it tells an agent " +
        "whether enriched Opik/Langfuse trace data is available and shipping is healthy.",
      inputSchema: {},
    },
    async () => run(() => getIntegrations(config)),
  );

  server.registerTool(
    "get_chat_state",
    {
      title: "Inspect chat state",
      description:
        "Per-message lifecycle of one chat (GET /chat-state). Key must have " +
        "traces.read. METADATA ONLY (no message text). Exposes a stuck-streaming " +
        "turn: a message with status 'streaming' + large ageSeconds " +
        "(stuckStreaming:true) = the bridge never relayed its finalize frame. Each " +
        "provenance part carries a SOC2-safe `structure` (per-item kind " +
        "document|context|memory + hasFileName/hasScore booleans, itemCount, " +
        "hasExcerpts, allowlisted source/retrievalRoute) — diagnose a Sources panel " +
        "issue ('documents show no score/excerpt' = a bare lightrag attribution turn: " +
        "kind document + hasScore:false) without any content.",
      inputSchema: getChatStateInput,
    },
    async (args) => run(() => getChatState(config, args)),
  );

  server.registerTool(
    "list_schemas",
    {
      title: "List published contract schemas",
      description:
        "The machine-readable CONTRACT schemas an integration author can conform to " +
        "(GET /schemas). Metadata only (id, title, version, category) — provenance/v1 " +
        "today, more as the surface grows. PUBLIC (no key required). Use get_schema to " +
        "fetch one.",
      inputSchema: {},
    },
    async () => run(() => listSchemas(config)),
  );

  server.registerTool(
    "get_schema",
    {
      title: "Get a published contract schema",
      description:
        "One contract schema's JSON by registry id (GET /schemas/:id), e.g. " +
        "\"provenance.v1\" — validate a plugin's emitted reports against it. PUBLIC " +
        "(no key required). 404 for an unknown id.",
      inputSchema: getSchemaInput,
    },
    async (args) => run(() => getSchema(config, args)),
  );

  server.registerTool(
    "get_trace_enrichment",
    {
      title: "Enriched trace structure (Opik / Langfuse)",
      description:
        "SOC2-safe STRUCTURE of a turn's trace (keyed by its correlationId) " +
        "fetched from the configured Opik/Langfuse: span " +
        "names/types/lifecycle/timing/parent tree, NEVER input/output/message " +
        "text (GET /trace-enrichment). Requires traces.read. Get the correlationId " +
        "from list_traces/list_anomalies, then use this to see the REAL OpenClaw " +
        "message structure behind an anomaly without seeing regulated data. Pass " +
        "chatId too to also surface OTHER traces on the same chat session " +
        "(content-free). Call get_integrations first to confirm a vendor is wired.",
      inputSchema: getTraceEnrichmentInput,
    },
    async (args) => run(() => getTraceEnrichment(config, args)),
  );

  server.registerTool(
    "diagnose_chat",
    {
      title: "Diagnose a chat (assessment + suggested fix)",
      description:
        "ONE actionable assessment of a chat (GET /diagnose): SOC2-safe chat-state " +
        "+ bridge availability, classified (stuck_stream | dispatch_error | " +
        "attachment_problem | bridge_unavailable | bridge_degraded | healthy) with a " +
        "`suggestedAction` and, when safe, a `suggestedTool` (e.g. reconcile_chat). " +
        "Requires traces.read. Read-only. CALL THIS FIRST on a user report, then act " +
        "on the suggestion.",
      inputSchema: diagnoseChatInput,
    },
    async (args) => run(() => diagnoseChat(config, args)),
  );

  server.registerTool(
    "reconcile_chat",
    {
      title: "Self-correct: release a chat's stuck stream",
      description:
        "BOUNDED corrective (POST /reconcile-chat): flip this chat's stuck " +
        "'streaming' message(s) to error (preserving text) so the hung UI releases " +
        "and the user can retry. Requires `selfheal` (a sensitive write). Audited. " +
        "Only touches messages already streaming past a short cutoff. Use when " +
        "diagnose_chat returns class 'stuck_stream' / suggestedTool 'reconcile_chat'.",
      inputSchema: reconcileChatInput,
    },
    async (args) => run(() => reconcileChat(config, args)),
  );

  server.registerTool(
    "sync_instance",
    {
      title: "Force an instance sync (resolve creds + pull agents)",
      description:
        "Force-sync ONE instance (POST /instances/sync): poke the bridge (resolve creds " +
        "+ connect -> pairing) then pull that instance's agents into Atrium NOW, instead " +
        "of waiting for the discovery cron. Requires `selfheal` (admin + agent service " +
        "roles). Returns { status, agents, detail }: status is the exact outcome (synced " +
        "| no_agents | no_bridge_url | unreachable | unauthorized | not_served | " +
        "deploy_misconfigured) and detail is a plain-English explanation to act on.",
      inputSchema: syncInstanceInput,
    },
    async (args) => run(() => syncInstance(config, args)),
  );

  server.registerTool(
    "list_traces",
    {
      title: "List recent traces",
      description:
        "Recent trace events (GET /traces). Key must have traces.read.",
      inputSchema: listTracesInput,
    },
    async (args) => run(() => listTraces(config, args)),
  );

  server.registerTool(
    "get_kpi",
    {
      title: "Get KPI rollups",
      description:
        "KPI rollups (GET /kpi). Key must have kpi.read.",
      inputSchema: getKpiInput,
    },
    async (args) => run(() => getKpi(config, args)),
  );

  server.registerTool(
    "query_openclaw",
    {
      title: "Query OpenClaw",
      description:
        "Query OpenClaw via the bridge (POST /openclaw/query). " +
        "Key must have openclaw.query.",
      inputSchema: queryOpenClawInput,
    },
    async (args) => run(() => queryOpenClaw(config, args)),
  );

  server.registerTool(
    "list_anomalies",
    {
      title: "List anomalies",
      description:
        "Detected anomalies (GET /anomalies). Key must have anomalies.read.",
      inputSchema: listAnomaliesInput,
    },
    async (args) => run(() => listAnomalies(config, args)),
  );

  server.registerTool(
    "report_anomaly",
    {
      title: "Report an anomaly",
      description:
        "Report an anomaly / self-repair signal (POST /anomalies). " +
        "Key must have anomalies.report.",
      inputSchema: reportAnomalyInput,
    },
    async (args) => run(() => reportAnomaly(config, args)),
  );

  const transport = new StdioServerTransport();
  void server.connect(transport);
}

main();
