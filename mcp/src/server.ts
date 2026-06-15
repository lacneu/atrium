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
 * gets a 403 for tools it isn't allowed to call. Tools whose routes are not yet
 * deployed (increments 4/6) return the API's response/error gracefully rather
 * than crashing.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiError, resolveConfig } from "./config.js";
import {
  getChatState,
  getChatStateInput,
  getCompat,
  getKpi,
  getKpiInput,
  health,
  listAnomalies,
  listAnomaliesInput,
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
    "get_chat_state",
    {
      title: "Inspect chat state",
      description:
        "Per-message lifecycle of one chat (GET /chat-state). Key must have " +
        "traces.read. METADATA ONLY (no message text). Exposes a stuck-streaming " +
        "turn: a message with status 'streaming' + large ageSeconds " +
        "(stuckStreaming:true) = the bridge never relayed its finalize frame.",
      inputSchema: getChatStateInput,
    },
    async (args) => run(() => getChatState(config, args)),
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
        "KPI rollups (GET /kpi; increment 4). Key must have kpi.read.",
      inputSchema: getKpiInput,
    },
    async (args) => run(() => getKpi(config, args)),
  );

  server.registerTool(
    "query_openclaw",
    {
      title: "Query OpenClaw",
      description:
        "Query OpenClaw via the bridge (POST /openclaw/query; increment 6). " +
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
        "Detected anomalies (GET /anomalies; increment 6). Key must have anomalies.read.",
      inputSchema: listAnomaliesInput,
    },
    async (args) => run(() => listAnomalies(config, args)),
  );

  server.registerTool(
    "report_anomaly",
    {
      title: "Report an anomaly",
      description:
        "Report an anomaly / self-repair signal (POST /anomalies; increment 6). " +
        "Key must have anomalies.report.",
      inputSchema: reportAnomalyInput,
    },
    async (args) => run(() => reportAnomaly(config, args)),
  );

  const transport = new StdioServerTransport();
  void server.connect(transport);
}

main();
