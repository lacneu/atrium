// Generic OTLP/HTTP-JSON exporter — ship redacted trace events to ANY
// OpenTelemetry backend the operator configures (Grafana Tempo, Jaeger, Datadog,
// an OTEL collector...). Unlike langfuse.ts (Langfuse-flavored, env creds) this is
// vendor-neutral: the operator supplies the full traces ENDPOINT and any auth
// HEADERS via the admin UI; the headers are a SECRET (encrypted at rest, decrypted
// in the flush action and passed in here).
//
// D2 (PHI): metadata-only spans (the mapper in otlpShared.ts never carries raw
// content). D3 (secrets): the auth headers come in already-decrypted from the
// action; they are placed ONLY in the request headers, never in the span body and
// never logged.

import { ShippableEvent, SendResult, SendOptions } from "./shared";
import { mapEventToOtlpSpan, buildOtlpPayload } from "./otlpShared";

/**
 * Resolved generic-OTLP config. `endpoint` is the FULL OTLP/HTTP traces URL the
 * operator entered (e.g. https://otlp.example.com/v1/traces). `headers` are the
 * operator's auth headers, ALREADY DECRYPTED by the caller (empty for an
 * auth-less collector). `configured` is true once an endpoint is set.
 */
export type OtlpConfig = {
  configured: boolean;
  enabled: boolean;
  endpoint: string;
  headers: Record<string, string>;
};

/**
 * POST a batch of redacted events to the operator's OTLP/HTTP endpoint. Mirrors
 * langfuse.send: NEVER throws on a non-2xx or a network error (returns
 * `{ok:false, ...}`) so the cron-driven flush records the outcome and skips
 * advancing the cursor. `fetchImpl` is injectable for deterministic tests.
 */
export async function send(
  config: OtlpConfig,
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

  const spans = await Promise.all(events.map(mapEventToOtlpSpan));
  const payload = buildOtlpPayload(spans);

  try {
    const res = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: withJsonContentType(config.headers),
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, count: events.length, status: res.status };
  } catch (err) {
    // Network failure: best-effort egress must not throw into the cron.
    console.error("otlp.send failed:", redactError(err));
    return { ok: false, count: 0, reason: "network_error" };
  }
}

/**
 * Build the request headers: the operator's auth headers PLUS our own
 * `Content-Type: application/json`. We OWN Content-Type (the body is always JSON),
 * so any operator-supplied `content-type` — in ANY casing — is dropped first.
 *
 * A plain-object spread (`{ ...config.headers, "Content-Type": "application/json" }`)
 * only overrides an EXACT-case `Content-Type`; a differently-cased key such as
 * `content-type` would survive as a SEPARATE property, and `fetch`'s case-
 * insensitive `Headers` constructor then COMBINES the two into
 * `text/plain, application/json` — a value the OTLP collector rejects/misparses.
 * Stripping case-insensitively guarantees ours is the only Content-Type sent.
 */
function withJsonContentType(
  operatorHeaders: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(operatorHeaders)) {
    if (name.toLowerCase() === "content-type") continue; // ours wins (any casing)
    out[name] = value;
  }
  out["Content-Type"] = "application/json";
  return out;
}

/** Stringify an error WITHOUT leaking secrets (we never put secrets in errors). */
function redactError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
