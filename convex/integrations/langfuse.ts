// Langfuse adapter — outbound trace shipping via OTLP/HTTP JSON (no SDK).
//
// D1 (linking): each redacted `traceEvent` maps to one OTLP span. The vendor
// trace id is DERIVED from our `correlationId` (sha256 → first 16 bytes) so the
// Convex recent window and the Langfuse firehose link bidirectionally by the
// same seed. The span id is derived from the event's own identity (sha256 → 8
// bytes) so it is stable and unique.
//
// D2 (PHI): we ship METADATA ONLY (kind/direction/status/latency/principal/
// roleKey/route/method + the non-PHI `meta` JSON). We NEVER populate the OTLP
// span with raw message text — `traceEvents` are already redacted by design and
// this adapter does not enrich them with content.
//
// D3 (secrets): credentials come from LangfuseConfig (deployment env). They are
// used ONLY to build the Authorization header; they are never placed in the
// span body and never logged.
//
// Endpoint: POST {host}/api/public/otel/v1/traces
// Auth:     Authorization: Basic base64(publicKey:secretKey)

import { LangfuseConfig } from "./config";
import {
  ShippableEvent,
  SendResult,
  SendOptions,
  sha256Hex,
  fallbackCorrelationId,
} from "./shared";

// OTLP/HTTP JSON span shape (the subset we emit). Attributes use the OTLP
// key/value encoding so each value is a typed scalar.
type OtlpAttribute = {
  key: string;
  value: { stringValue: string } | { intValue: string };
};

type OtlpSpan = {
  traceId: string; // 32 hex chars (16 bytes)
  spanId: string; // 16 hex chars (8 bytes)
  name: string; // = event.kind (the span name)
  // Single root span per event: no parent.
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
};

// OTLP resource + scope (D-5). Both are optional per the OTLP spec, but without
// a `service.name` resource attribute shipped spans land under a default/empty
// service in Langfuse, degrading grouping. Constant + non-secret.
type OtlpResource = { attributes: OtlpAttribute[] };
type OtlpScope = { name: string; version?: string };

const OTLP_RESOURCE: OtlpResource = {
  attributes: [{ key: "service.name", value: { stringValue: "atrium" } }],
};
const OTLP_SCOPE: OtlpScope = { name: "openclaw-convex" };

export type LangfusePayload = {
  resourceSpans: Array<{
    resource: OtlpResource;
    scopeSpans: Array<{ scope: OtlpScope; spans: OtlpSpan[] }>;
  }>;
};

function attrString(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function attrInt(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

/**
 * Map ONE redacted trace event to a single OTLP span (pure; no I/O beyond the
 * crypto digest used to derive the deterministic ids). Metadata only — no secret
 * and no raw content ever enters the payload.
 */
export async function mapEventToVendor(
  event: ShippableEvent,
): Promise<OtlpSpan> {
  const correlationId = fallbackCorrelationId(event);
  // Deterministic ids from stable seeds (same correlationId → same trace).
  const traceId = (await sha256Hex(`lf:trace:${correlationId}`)).slice(0, 32);
  const spanId = (await sha256Hex(`lf:span:${event._id}`)).slice(0, 16);

  const atMs = event.at;
  const startNano = msToUnixNano(atMs);
  // End = start + latency (if known); otherwise a zero-duration span.
  const endNano = msToUnixNano(
    atMs + (event.latencyMs !== undefined ? event.latencyMs : 0),
  );

  const attributes: OtlpAttribute[] = [
    // Langfuse semantic attributes for grouping in its UI.
    attrString("langfuse.trace.name", event.kind),
    attrString("correlation.id", correlationId),
    attrString("trace.kind", event.kind),
    attrString("principal.type", event.principalType),
  ];
  // Optional metadata fields — all non-PHI.
  if (event.direction !== undefined)
    attributes.push(attrString("trace.direction", event.direction));
  if (event.principalId !== undefined)
    attributes.push(attrString("principal.id", event.principalId));
  if (event.roleKey !== undefined)
    attributes.push(attrString("principal.role", event.roleKey));
  if (event.route !== undefined)
    attributes.push(attrString("http.route", event.route));
  if (event.method !== undefined)
    attributes.push(attrString("http.method", event.method));
  if (event.status !== undefined)
    attributes.push(attrInt("http.status_code", event.status));
  if (event.latencyMs !== undefined)
    attributes.push(attrInt("latency.ms", event.latencyMs));
  if (event.chatId !== undefined)
    attributes.push(attrString("langfuse.session.id", event.chatId));
  if (event.runId !== undefined)
    attributes.push(attrString("run.id", event.runId));
  // `meta` is a non-PHI JSON blob written by the trace producers (D2); ship it
  // verbatim as a string attribute (the adapter does not introspect it).
  if (event.meta !== undefined)
    attributes.push(attrString("trace.meta", event.meta));

  return {
    traceId,
    spanId,
    name: event.kind,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes,
  };
}

/** Wrap a batch of spans into the OTLP ExportTraceServiceRequest envelope. */
export function buildPayload(spans: OtlpSpan[]): LangfusePayload {
  // D-5: attribute the spans to a named service + instrumentation scope. The
  // resourceSpans[0].scopeSpans[0].spans path is preserved (downstream + tests).
  return {
    resourceSpans: [
      { resource: OTLP_RESOURCE, scopeSpans: [{ scope: OTLP_SCOPE, spans }] },
    ],
  };
}

/**
 * POST a batch of redacted events to Langfuse via OTLP/HTTP. Returns a small
 * outcome object; NEVER throws on a non-2xx (returns `{ok:false, status}`) so
 * the caller (the cron-driven action) can record the outcome and skip advancing
 * the cursor. `fetchImpl` is injectable for deterministic tests.
 */
export async function send(
  config: LangfuseConfig,
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

  const spans = await Promise.all(events.map(mapEventToVendor));
  const payload = buildPayload(spans);
  const auth = base64(`${config.publicKey}:${config.secretKey}`);

  try {
    const res = await fetchImpl(`${config.host}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, count: events.length, status: res.status };
  } catch (err) {
    // Network failure: best-effort egress must not throw into the cron.
    console.error("langfuse.send failed:", redactError(err));
    return { ok: false, count: 0, reason: "network_error" };
  }
}

/** ms epoch → OTLP unix-nanos string (avoids Number precision loss). */
function msToUnixNano(ms: number): string {
  return `${Math.trunc(ms)}000000`;
}

/** base64 of an ASCII/UTF-8 string, runtime-portable (edge + Convex V8). */
function base64(s: string): string {
  // `btoa` is available in the Convex/edge runtimes; fall back to Buffer for
  // any Node-only test context.
  if (typeof btoa === "function") return btoa(s);
  return Buffer.from(s, "utf-8").toString("base64");
}

/** Stringify an error WITHOUT leaking secrets (we never put secrets in errors). */
function redactError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
