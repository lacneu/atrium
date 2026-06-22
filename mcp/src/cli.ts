#!/usr/bin/env node
/**
 * atrium CLI — a thin shell client over the same /api/v1 calls the
 * MCP server exposes. Same env-var auth (OPENCLAW_WEBCHAT_API_BASE +
 * OPENCLAW_WEBCHAT_API_KEY); the Bearer key is only ever sent in the
 * Authorization header (never echoed, never in a URL).
 *
 * Usage:
 *   atrium health
 *   atrium traces [--limit N] [--q TEXT] [--from T] [--to T] [--kind K]
 *       [--status CODE] [--status-class 2xx|4xx|5xx] [--direction D]
 *       [--principal-type T] [--role-key K] [--correlation-id ID]
 *   atrium kpi [--metric M] [--since ISO] [--from T] [--to T]
 *   atrium anomalies [--limit N] [--since ISO] [--q TEXT] [--from T]
 *       [--to T] [--status S] [--severity S] [--source S] [--kind K]
 *   atrium query-openclaw [--question TEXT]
 *   atrium report-anomaly --kind K --severity S --message M [--correlation-id ID]
 *   atrium bridge-status
 *   atrium sync --instance NAME
 *
 * --from/--to accept epoch ms OR a Grafana relative token (e.g. now-24h, now).
 */

import { ApiError, resolveConfig, type Config } from "./config.js";
import {
  bridgeStatus,
  getCompat,
  getKpi,
  health,
  listAnomalies,
  listTraces,
  queryOpenClaw,
  reportAnomaly,
  syncInstance,
} from "./tools.js";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Parse `--key value`, `--key=value`, and bare `--flag` arguments. */
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[token.slice(2)] = next;
          i++;
        } else {
          flags[token.slice(2)] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function num(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const USAGE = `atrium — thin CLI over the /api/v1 observability surface

Commands:
  health                              GET  /health
  compat                              GET  /compat            (bridge.read)
  bridge-status                       GET  /bridge-status     (bridge.read)
  sync --instance NAME                POST /instances/sync    (selfheal)
  traces [--limit N] [--q TEXT] [--from T] [--to T] [--kind K] [--status CODE]
         [--status-class 2xx|4xx|5xx] [--direction D] [--principal-type T]
         [--role-key K] [--correlation-id ID]
                                      GET  /traces            (traces.read)
  kpi [--metric M] [--since ISO] [--from T] [--to T]
                                      GET  /kpi               (kpi.read)
  anomalies [--limit N] [--since ISO] [--q TEXT] [--from T] [--to T]
            [--status S] [--severity S] [--source S] [--kind K]
                                      GET  /anomalies         (anomalies.read)
  query-openclaw [--question TEXT]    POST /openclaw/query    (openclaw.query)
  report-anomaly --kind K --severity info|warn|critical --message M [--correlation-id ID]
                                      POST /anomalies         (anomalies.report)

Filters:
  --from / --to accept epoch ms (e.g. 1717372800000) OR a Grafana relative
  token: now, or now-<N><unit> with unit s|m|h|d|w (e.g. --from now-24h --to now).
  Example: traces --from now-24h --to now --status-class 4xx --kind api.call --q foo

Environment:
  OPENCLAW_WEBCHAT_API_BASE  deployment .site origin (default http://127.0.0.1:3213)
  OPENCLAW_WEBCHAT_API_KEY   oc_live_ Bearer key (required)`;

async function dispatch(
  config: Config,
  command: string,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  switch (command) {
    case "health":
      return health(config);
    case "compat":
      return getCompat(config);
    case "bridge-status":
      return bridgeStatus(config);
    case "sync": {
      const instance = str(flags.instance);
      if (!instance) {
        throw new Error("sync requires --instance NAME");
      }
      return syncInstance(config, { instance });
    }
    case "traces": {
      const statusClass = str(flags["status-class"]);
      if (
        statusClass !== undefined &&
        statusClass !== "2xx" &&
        statusClass !== "4xx" &&
        statusClass !== "5xx"
      ) {
        throw new Error("--status-class must be one of 2xx|4xx|5xx");
      }
      return listTraces(config, {
        limit: num(flags.limit),
        q: str(flags.q),
        from: str(flags.from),
        to: str(flags.to),
        kind: str(flags.kind),
        status: num(flags.status),
        statusClass,
        direction: str(flags.direction),
        principalType: str(flags["principal-type"]),
        roleKey: str(flags["role-key"]),
        correlationId: str(flags["correlation-id"]),
      });
    }
    case "kpi":
      return getKpi(config, {
        metric: str(flags.metric),
        since: str(flags.since),
        from: str(flags.from),
        to: str(flags.to),
      });
    case "anomalies":
      return listAnomalies(config, {
        limit: num(flags.limit),
        since: str(flags.since),
        q: str(flags.q),
        from: str(flags.from),
        to: str(flags.to),
        status: str(flags.status),
        severity: str(flags.severity),
        source: str(flags.source),
        kind: str(flags.kind),
      });
    case "query-openclaw":
      return queryOpenClaw(config, {
        question: str(flags.question),
      });
    case "report-anomaly": {
      const kind = str(flags.kind);
      if (!kind) {
        throw new Error("report-anomaly requires --kind");
      }
      const severity = str(flags.severity);
      if (severity !== "info" && severity !== "warn" && severity !== "critical") {
        throw new Error(
          "report-anomaly requires --severity info|warn|critical",
        );
      }
      const message = str(flags.message);
      if (!message) {
        throw new Error("report-anomaly requires --message");
      }
      return reportAnomaly(config, {
        kind,
        severity,
        message,
        correlationId: str(flags["correlation-id"]),
      });
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0];

  if (!command || command === "help" || flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let config: Config;
  try {
    config = resolveConfig();
  } catch (err) {
    // Config error (e.g. missing key). Message names the env var, not its value.
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const result = await dispatch(config, command, flags);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    if (err instanceof ApiError) {
      const bodyText =
        typeof err.body === "string"
          ? err.body
          : JSON.stringify(err.body, null, 2);
      process.stderr.write(`API error ${err.status}: ${bodyText}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

void main();
