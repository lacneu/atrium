// Opik adapter — outbound trace shipping via the Opik REST API (no SDK).
//
// D1 (linking): each redacted `traceEvent` maps to one Opik `TraceWrite`. The
// trace id is a deterministic UUID DERIVED from our `correlationId` so the
// Convex recent window and the Opik firehose link by the same seed. `threadId`
// carries the chat id for multi-turn grouping.
//
// D2 (PHI): METADATA ONLY. We populate `metadata`/`tags` with non-PHI fields
// (kind/direction/status/latency/principal/roleKey/route/method + the non-PHI
// `meta` JSON). We NEVER set `input`/`output` to raw message text — the events
// are already redacted and this adapter does not enrich them with content.
//
// D3 (secrets): credentials come from OpikConfig (deployment env), used ONLY to
// build the auth headers; never in the body, never logged.
//
// Endpoint: POST {baseUrl}/v1/private/traces/batch   body { traces: [...] }
// NOTE: baseUrl already ends in the API root (cloud default `.../opik/api`; OSS
// convention `.../api`), so the path is `/v1/private/...` — NOT `/api/v1/...`
// (a doubled `/api` 404s; caught by the live shipping probe 2026-06-06).
// Auth:     Authorization: Bearer <apiKey>   (+ optional Comet-Workspace header)

import { OpikConfig } from "./config";
import {
  ShippableEvent,
  SendResult,
  SendOptions,
  sha256Hex,
  uuidV7FromHex,
  msToIso,
  fallbackCorrelationId,
} from "./shared";

// The Opik `TraceWrite` subset we emit. snake_case — the Opik REST API field
// names (camelCase 422s: `start_time` is the only REQUIRED field and was missing
// when we sent `startTime`; caught live 2026-06-06). `metadata` holds only
// non-PHI fields.
export type OpikTrace = {
  id: string; // deterministic UUID from correlationId
  name: string; // = event.kind
  start_time: string; // ISO (required)
  end_time: string; // ISO (start + latency, or start)
  metadata: Record<string, string | number>;
  tags: string[];
  thread_id?: string; // chat id for multi-turn grouping (non-PHI id)
};

export type OpikBatchPayload = {
  traces: OpikTrace[];
};

/**
 * Map ONE redacted trace event to a single Opik `TraceWrite` (pure aside from
 * the crypto digest used to derive the deterministic id). Metadata only — no
 * secret and no raw content ever enters the payload.
 */
export async function mapEventToVendor(
  event: ShippableEvent,
): Promise<OpikTrace> {
  const correlationId = fallbackCorrelationId(event);
  // Opik requires a v7 (time-ordered) trace id; use event.at as the timestamp so
  // the id stays deterministic (idempotent retries) AND valid.
  const id = uuidV7FromHex(
    await sha256Hex(`opik:trace:${correlationId}`),
    event.at,
  );

  const startMs = event.at;
  const endMs = startMs + (event.latencyMs !== undefined ? event.latencyMs : 0);

  // Non-PHI metadata. Only defined fields are included.
  const metadata: Record<string, string | number> = {
    correlationId,
    kind: event.kind,
    principalType: event.principalType,
  };
  if (event.direction !== undefined) metadata.direction = event.direction;
  if (event.principalId !== undefined) metadata.principalId = event.principalId;
  if (event.roleKey !== undefined) metadata.roleKey = event.roleKey;
  if (event.route !== undefined) metadata.route = event.route;
  if (event.method !== undefined) metadata.method = event.method;
  if (event.status !== undefined) metadata.status = event.status;
  if (event.latencyMs !== undefined) metadata.latencyMs = event.latencyMs;
  if (event.runId !== undefined) metadata.runId = event.runId;
  // Non-PHI JSON blob written by the trace producers (D2) — shipped verbatim.
  if (event.meta !== undefined) metadata.meta = event.meta;

  // Tags for cheap filtering in the Opik UI (kind/direction/principal).
  const tags: string[] = [event.kind, `principal:${event.principalType}`];
  if (event.direction !== undefined) tags.push(`direction:${event.direction}`);

  const trace: OpikTrace = {
    id,
    name: event.kind,
    start_time: msToIso(startMs),
    end_time: msToIso(endMs),
    metadata,
    tags,
  };
  if (event.chatId !== undefined) trace.thread_id = event.chatId;
  return trace;
}

/** Wrap a batch of traces into the Opik batch-ingestion envelope. */
export function buildPayload(traces: OpikTrace[]): OpikBatchPayload {
  return { traces };
}

/**
 * POST a batch of redacted events to Opik. Returns a small outcome object;
 * NEVER throws on a non-2xx (returns `{ok:false, status}`) so the caller can
 * record the outcome and skip advancing the cursor. `fetchImpl` is injectable
 * for deterministic tests.
 */
export async function send(
  config: OpikConfig,
  events: ShippableEvent[],
  opts: SendOptions = {},
): Promise<SendResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!config.configured) {
    return { ok: false, count: 0, skipped: true, reason: "unconfigured" };
  }
  if (events.length === 0) {
    return { ok: true, count: 0 };
  }

  const traces = await Promise.all(events.map(mapEventToVendor));
  const payload = buildPayload(traces);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  // Workspace is optional: when omitted, Opik maps the token to its default
  // workspace server-side.
  if (config.workspace.length > 0) {
    headers["Comet-Workspace"] = config.workspace;
  }

  try {
    const res = await fetchImpl(
      `${config.baseUrl}/v1/private/traces/batch`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
    );
    return { ok: res.ok, count: events.length, status: res.status };
  } catch (err) {
    console.error("opik.send failed:", redactError(err));
    return { ok: false, count: 0, reason: "network_error" };
  }
}

/** Stringify an error WITHOUT leaking secrets (we never put secrets in errors). */
function redactError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
