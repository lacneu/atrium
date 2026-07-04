# atrium-mcp

A thin, dependency-light **MCP server + CLI** that proxy the atrium
`/api/v1` observability surface using an `oc_live_` Bearer API key.

It speaks **HTTP only** — it imports nothing from the Convex app. Each tool maps
to one `/api/v1` route and one permission, which is enforced **server-side** by the
deployment (`requirePermission`). A scoped key (e.g. an `observer`) therefore simply
gets a `403` for routes it isn't allowed to call.

Runtime dependencies: `@modelcontextprotocol/sdk` and `zod` only.

## Configuration (environment)

| Variable                     | Required | Default                  | Meaning                                                  |
| ---------------------------- | -------- | ------------------------ | -------------------------------------------------------- |
| `OPENCLAW_WEBCHAT_API_BASE`  | no       | `http://127.0.0.1:3213`  | Deployment `.site` origin, **without** `/api/v1`.        |
| `OPENCLAW_WEBCHAT_API_KEY`   | **yes**  | —                        | The `oc_live_...` Bearer key.                            |

The `/api/v1` prefix is added internally; you point `API_BASE` at the bare
`.site` origin. The key is only ever sent in the `Authorization` header — never
in a URL/query string and never logged.

## Install (released artifact)

Published on every tagged release as **`@lacneu/atrium-mcp`** (npm, OIDC +
provenance), at the same lockstep version as the app images. Being HTTP-only and
provider-neutral, the same package serves any MCP-capable gateway (OpenClaw,
Hermes, Claude Code, …).

```bash
# ad hoc (any MCP client with stdio command support)
npx -y @lacneu/atrium-mcp

# pinned, baked into a gateway image
npm install -g @lacneu/atrium-mcp@<version>   # provides `atrium-mcp` + `atrium` (CLI)
```

Example OpenClaw declaration (`mcp.servers`, stdio) — one server per deployment,
credentials injected via a wrapper or the process environment, never in config:

```json
{
  "mcp": {
    "servers": {
      "atrium-prod": { "command": "atrium-mcp-prod" }
    }
  }
}
```

## Build (from source)

```bash
cd mcp
npm install
npm run build      # emits dist/ (with shebangs preserved)
```

Other scripts: `npm run typecheck`, `npm test`.

## Tools (MCP) / Commands (CLI)

| MCP tool               | CLI command      | Route                         | Permission         | Purpose |
| ---------------------- | ---------------- | ----------------------------- | ------------------ | ------- |
| `health`               | `health`         | `GET  /api/v1/health`         | none               | Liveness probe for the API surface. |
| `get_compat`           | `compat`         | `GET  /api/v1/compat`         | `bridge.read`      | Bridge version + per-instance gateway versions/capabilities. |
| `get_integrations`     | —                | `GET  /api/v1/integrations`   | `traces.read`      | Opik/Langfuse configured/enabled + shipping cursors. No keys. |
| `get_chat_state`       | —                | `GET  /api/v1/chat-state`     | `traces.read`      | Per-message lifecycle of one chat (metadata only). |
| `get_trace_enrichment` | —                | `GET  /api/v1/trace-enrichment` | `traces.read`    | SOC2-safe span structure from Opik/Langfuse, keyed by `correlationId`. |
| `diagnose_chat`        | —                | `GET  /api/v1/diagnose`       | `traces.read`      | One assessment of a chat + a suggested action/tool. |
| `reconcile_chat`       | —                | `POST /api/v1/reconcile-chat` | `selfheal`         | Release a chat's stuck `streaming` message (text preserved). Audited. |
| `list_traces`          | `traces`         | `GET  /api/v1/traces`         | `traces.read`      | Recent trace events, with filtering. |
| `get_kpi`              | `kpi`            | `GET  /api/v1/kpi`            | `kpi.read`         | KPI rollups. |
| `query_openclaw`       | `query-openclaw` | `POST /api/v1/openclaw/query` | `openclaw.query`   | Query OpenClaw via the bridge. |
| `list_anomalies`       | `anomalies`      | `GET  /api/v1/anomalies`      | `anomalies.read`   | Detected anomalies, with status/severity/source filtering. |
| `report_anomaly`       | `report-anomaly` | `POST /api/v1/anomalies`      | `anomalies.report` | Record an anomaly / self-repair signal. |

Tools without a CLI command are MCP-only. Every tool's permission is enforced by
the deployment: a key lacking a tool's permission gets a `403` the tool surfaces
as an error.

The four read-only diagnostic tools (`get_integrations`, `diagnose_chat`,
`get_chat_state`, `get_trace_enrichment`) plus the bounded corrective
`reconcile_chat` compose into a closed loop an agent can drive from a single user
report. See **[the self-correction loop](../docs/SELF_CORRECTION_LOOP.md)** for how
they fit together and the SOC2-safe trace catalog (including the `documentary.*`
document-fetch traces). The whole surface is metadata-only — never message text,
filenames, URLs, or keys.

## CLI usage

```bash
export OPENCLAW_WEBCHAT_API_BASE=http://127.0.0.1:3213
export OPENCLAW_WEBCHAT_API_KEY=oc_live_xxxxxxxxxxxx

node dist/cli.js health
node dist/cli.js compat
node dist/cli.js traces --limit 20
node dist/cli.js traces --kind api.call --correlation-id abc123

# filtering (traces): --q substring, time range, structured fields
#   --from/--to accept epoch ms OR a Grafana relative token (now, now-<N><unit>)
node dist/cli.js traces --from now-24h --to now --status-class 4xx --kind api.call --q foo
node dist/cli.js traces --status 404 --principal-type service --role-key admin

node dist/cli.js kpi --metric api.calls --since 2026-06-01T00:00
node dist/cli.js kpi --metric api.calls --from now-24h --to now
node dist/cli.js anomalies --limit 50 --status open
node dist/cli.js anomalies --from now-1h --severity critical --source detector --q spike
node dist/cli.js query-openclaw --prompt "summarize last run" --chat-id c1
node dist/cli.js report-anomaly --kind latency.spike --severity warn --message "p99 > 5s"
```

If installed/published, the same is available as the `atrium` bin
(e.g. `atrium traces --limit 20`).

## OpenClaw MCP wiring

Register the stdio server in `~/.openclaw/openclaw.json`. Because this package
is not published, run the built file directly:

```json
{
  "mcpServers": {
    "atrium": {
      "command": "node",
      "args": ["/absolute/path/to/atrium/mcp/dist/server.js"],
      "env": {
        "OPENCLAW_WEBCHAT_API_BASE": "http://127.0.0.1:3213",
        "OPENCLAW_WEBCHAT_API_KEY": "oc_live_..."
      }
    }
  }
}
```

After publishing to a registry, the `npx` form works too:

```json
{
  "mcpServers": {
    "atrium": {
      "command": "npx",
      "args": ["-y", "atrium-mcp"],
      "env": {
        "OPENCLAW_WEBCHAT_API_BASE": "https://<deployment>.convex.site",
        "OPENCLAW_WEBCHAT_API_KEY": "oc_live_..."
      }
    }
  }
}
```

## Security

- The API key lives in env only — never committed, never logged, never in a URL.
- Stdio transport avoids the DNS-rebinding surface of local HTTP MCP servers.
- Permission scoping is enforced by the deployment, not the client: a key that
  lacks a tool's permission gets a `403` that the tool surfaces as an error.
