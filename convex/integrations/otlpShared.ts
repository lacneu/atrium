// Shared OTLP/HTTP-JSON span primitives for the GENERIC OpenTelemetry exporter
// (otlp.ts). Deliberately self-contained (a ~25-line duplicate of the OTLP shape
// also used by langfuse.ts): keeping the working+tested Langfuse adapter untouched
// is worth a little duplication (advisor-endorsed) — langfuse.ts emits a
// vendor-flavored payload that MUST stay byte-identical to its own test.
//
// D2 (PHI): the mapper ships METADATA ONLY (kind/direction/status/latency/
// principal/role/route/method + the non-PHI `meta` JSON). It NEVER puts raw
// message text into a span — `traceEvents` are already redacted by design.

import {
  ShippableEvent,
  sha256Hex,
  fallbackCorrelationId,
} from "./shared";

// OTLP/HTTP JSON span shape (the subset we emit). Attributes use the OTLP
// key/value encoding so each value is a typed scalar.
export type OtlpAttribute = {
  key: string;
  value: { stringValue: string } | { intValue: string };
};

export type OtlpSpan = {
  traceId: string; // 32 hex chars (16 bytes)
  spanId: string; // 16 hex chars (8 bytes)
  name: string; // = event.kind (the span name)
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
};

type OtlpResource = { attributes: OtlpAttribute[] };
type OtlpScope = { name: string; version?: string };

// Attribute the spans to a named service + instrumentation scope (same
// `service.name` as the Langfuse adapter so both land under "atrium").
const OTLP_RESOURCE: OtlpResource = {
  attributes: [{ key: "service.name", value: { stringValue: "atrium" } }],
};
const OTLP_SCOPE: OtlpScope = { name: "openclaw-convex" };

export type OtlpPayload = {
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

/** ms epoch -> OTLP unix-nanos string (avoids Number precision loss). */
function msToUnixNano(ms: number): string {
  return `${Math.trunc(ms)}000000`;
}

/**
 * Map ONE redacted trace event to a single OTLP span with NEUTRAL, vendor-agnostic
 * attributes (no `langfuse.*` keys) — this is the generic exporter, so any OTLP
 * backend (Grafana Tempo, Jaeger, Datadog, a collector) gets standard semantics.
 * Pure (only the crypto digest used to derive the deterministic ids). Metadata
 * only — no secret, no raw content.
 */
export async function mapEventToOtlpSpan(
  event: ShippableEvent,
): Promise<OtlpSpan> {
  const correlationId = fallbackCorrelationId(event);
  // Deterministic ids from stable seeds (same correlationId -> same trace), so the
  // Convex recent window and the operator's OTLP backend link by the same seed.
  const traceId = (await sha256Hex(`otlp:trace:${correlationId}`)).slice(0, 32);
  const spanId = (await sha256Hex(`otlp:span:${event._id}`)).slice(0, 16);

  const atMs = event.at;
  const startNano = msToUnixNano(atMs);
  const endNano = msToUnixNano(
    atMs + (event.latencyMs !== undefined ? event.latencyMs : 0),
  );

  const attributes: OtlpAttribute[] = [
    attrString("correlation.id", correlationId),
    attrString("trace.kind", event.kind),
    attrString("principal.type", event.principalType),
  ];
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
    attributes.push(attrString("session.id", event.chatId));
  if (event.runId !== undefined)
    attributes.push(attrString("run.id", event.runId));
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
export function buildOtlpPayload(spans: OtlpSpan[]): OtlpPayload {
  return {
    resourceSpans: [
      { resource: OTLP_RESOURCE, scopeSpans: [{ scope: OTLP_SCOPE, spans }] },
    ],
  };
}

// --- Header validation (the operator's auth headers; a SECRET) ---------------
//
// The headers are entered in the UI as JSON and encrypted at rest. Validate the
// SHAPE at SET time (here, called by the setter action), NOT only at send: a
// malformed blob that slips through would make `fetch`/`Headers` throw on EVERY
// flush forever (a silently-wedged vendor). Reject anything that is not a flat
// object of string->string with legal header names/values.

export class OtlpHeaderError extends Error {}

// RFC 7230 token chars for a header field-name.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Control chars that are illegal in a header field-value. ALLOW space (0x20) and
// HTAB (0x09) — both legal in a field-value (e.g. "Bearer <token>"); reject CR/LF
// (header injection) and every other C0 control + DEL.
// eslint-disable-next-line no-control-regex
const HEADER_VALUE_BAD = /[\x00-\x08\x0a-\x1f\x7f]/;

/**
 * Parse + validate the operator's OTLP auth headers from a JSON string. Returns a
 * clean `Record<string,string>`. Throws `OtlpHeaderError` (a clear, secret-free
 * message) on any malformed input so the admin gets immediate feedback at SET
 * time. An empty object is allowed (an auth-less collector) and returns `{}`.
 */
export function parseOtlpHeaders(json: string): Record<string, string> {
  const trimmed = json.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new OtlpHeaderError(
      "Headers must be valid JSON (an object of string -> string).",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OtlpHeaderError(
      'Headers must be a JSON object (e.g. {"Authorization": "Bearer ..."}).',
    );
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new OtlpHeaderError(`Header "${name}" must have a string value.`);
    }
    if (!HEADER_NAME_RE.test(name)) {
      throw new OtlpHeaderError(`Illegal header name "${name}".`);
    }
    if (HEADER_VALUE_BAD.test(value)) {
      throw new OtlpHeaderError(
        `Header "${name}" value contains an illegal control character.`,
      );
    }
    out[name] = value;
  }
  return out;
}

// --- Endpoint URL validation (a NON-secret vendor URL) ------------------------
//
// Vendor URL knobs (the OTLP traces endpoint, the Langfuse host, the Opik base
// URL) are treated as NON-secret: they are exposed via integrations.status + the
// key-authed /api/v1/integrations route (readable by `traces.read`). So none of
// them may be allowed to CARRY a secret. A URL with userinfo
// (`https://user:pass@host/...`) would store credentials in clear and leak them to
// every traces.read reader. Reject that form (and any non-http(s) / malformed URL)
// at SET time, mirroring parseOtlpHeaders' set-time discipline. Vendor-neutral so
// ONE guard covers every non-secret URL field.

export class EndpointUrlError extends Error {}

/**
 * Validate a NON-secret vendor URL at SET time. Returns the trimmed URL on
 * success. An empty/whitespace string is allowed and returns "" (clears the field).
 * Throws `EndpointUrlError` (a clear, secret-free message; `label` names the field)
 * for: a malformed/relative URL, a non-http(s) scheme, or a URL carrying userinfo
 * credentials (the credential-leak guard). The accepted shape — an absolute http(s)
 * URL — is what every caller already requires at send time (`${url}/path` in fetch),
 * so this rejects only forms that never functioned, never a working config.
 */
export function validateEndpointUrl(url: string, label = "Endpoint URL"): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return ""; // clearing the field
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new EndpointUrlError(
      `${label} must be a valid absolute URL (e.g. https://example.com).`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EndpointUrlError(`${label} must use http or https.`);
  }
  // Non-secret + surfaced to traces.read readers — it must not carry credentials.
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new EndpointUrlError(
      `${label} must not contain credentials in the URL (user:pass@host). Configure authentication separately (encrypted headers / secret env).`,
    );
  }
  return trimmed;
}
