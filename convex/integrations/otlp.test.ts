/// <reference types="vite/client" />
//
// Generic OTLP exporter — PURE unit tests (no convex-test harness): the header
// validation (the robustness chokepoint — a malformed blob must be rejected at SET
// time, not silently wedge the vendor forever), the NEUTRAL span mapper (no
// langfuse.* attributes leak into the generic exporter), and the best-effort send
// (never throws; the operator's headers are applied; OUR Content-Type wins). Each
// test fails if its target regresses.

import { describe, expect, test, vi } from "vitest";
import {
  parseOtlpHeaders,
  OtlpHeaderError,
  mapEventToOtlpSpan,
  validateEndpointUrl,
  EndpointUrlError,
} from "./otlpShared";
import { send, type OtlpConfig } from "./otlp";
import type { ShippableEvent } from "./shared";

const EVENT: ShippableEvent = {
  _id: "evt1",
  at: 1_700_000_000_000,
  kind: "openclaw.ingest",
  principalType: "system",
  direction: "inbound",
  latencyMs: 42,
  chatId: "chatABC",
  correlationId: "corr-1",
};

describe("parseOtlpHeaders (SET-time shape validation)", () => {
  test("valid object → cleaned record", () => {
    expect(parseOtlpHeaders('{"Authorization":"Bearer abc def"}')).toEqual({
      Authorization: "Bearer abc def", // a SPACE in the value is legal (Bearer <token>)
    });
  });

  test("empty string → {} (an auth-less collector is allowed)", () => {
    expect(parseOtlpHeaders("")).toEqual({});
    expect(parseOtlpHeaders("   ")).toEqual({});
  });

  test("rejects non-JSON", () => {
    expect(() => parseOtlpHeaders("not json")).toThrow(OtlpHeaderError);
  });

  test("rejects a JSON array (must be an object)", () => {
    expect(() => parseOtlpHeaders('["a","b"]')).toThrow(OtlpHeaderError);
  });

  test("rejects a non-string value", () => {
    expect(() => parseOtlpHeaders('{"X-Count": 3}')).toThrow(OtlpHeaderError);
  });

  test("rejects an illegal header NAME", () => {
    expect(() => parseOtlpHeaders('{"Bad Name": "v"}')).toThrow(OtlpHeaderError);
  });

  test("rejects CR/LF in a value (header injection / fetch throw)", () => {
    // The load-bearing guard: without it, this blob would be stored + then make
    // fetch throw on EVERY flush forever (silently-wedged vendor).
    expect(() => parseOtlpHeaders('{"X-Evil":"a\\r\\nInjected: 1"}')).toThrow(
      OtlpHeaderError,
    );
    expect(() => parseOtlpHeaders('{"X-Evil":"a\\nb"}')).toThrow(OtlpHeaderError);
  });
});

describe("validateEndpointUrl (SET-time, non-secret guard; vendor-neutral)", () => {
  test("accepts a clean http(s) URL (returned trimmed)", () => {
    expect(validateEndpointUrl("https://otlp.example.com/v1/traces")).toBe(
      "https://otlp.example.com/v1/traces",
    );
    // A port must NOT be misread as a password (the one real parser footgun).
    expect(validateEndpointUrl("  http://collector:4318/v1/traces  ")).toBe(
      "http://collector:4318/v1/traces",
    );
  });

  test("empty / whitespace → '' (clears the field)", () => {
    expect(validateEndpointUrl("")).toBe("");
    expect(validateEndpointUrl("   ")).toBe("");
  });

  test("REJECTS a URL carrying userinfo credentials (the leak this guards)", () => {
    // The load-bearing guard: the URL is exposed to traces.read readers, so a
    // `user:pass@host` URL would leak credentials stored in clear.
    expect(() =>
      validateEndpointUrl("https://user:pass@host/v1/traces"),
    ).toThrow(EndpointUrlError);
    // A username alone is still a credential.
    expect(() => validateEndpointUrl("https://user@host/v1/traces")).toThrow(
      EndpointUrlError,
    );
    // A password alone too.
    expect(() => validateEndpointUrl("https://:pass@host/v1/traces")).toThrow(
      EndpointUrlError,
    );
  });

  test("rejects a malformed / non-http(s) URL", () => {
    expect(() => validateEndpointUrl("not a url")).toThrow(EndpointUrlError);
    expect(() => validateEndpointUrl("/v1/traces")).toThrow(EndpointUrlError);
    expect(() => validateEndpointUrl("ftp://host/v1/traces")).toThrow(
      EndpointUrlError,
    );
  });

  test("the field label appears in the error message (per-vendor clarity)", () => {
    expect(() =>
      validateEndpointUrl("https://u:p@host", "Langfuse host"),
    ).toThrow(/Langfuse host/);
  });
});

describe("mapEventToOtlpSpan (neutral, metadata-only)", () => {
  test("emits standard ids + attributes, NO langfuse.* keys", async () => {
    const span = await mapEventToOtlpSpan(EVENT);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.name).toBe("openclaw.ingest");
    const keys = span.attributes.map((a) => a.key);
    expect(keys).toContain("correlation.id");
    expect(keys).toContain("trace.kind");
    expect(keys).toContain("session.id"); // neutral key (NOT langfuse.session.id)
    // The generic exporter must NEVER leak vendor-specific attribute names.
    expect(keys.some((k) => k.startsWith("langfuse."))).toBe(false);
  });

  test("deterministic trace id from correlationId (stable linking)", async () => {
    const a = await mapEventToOtlpSpan(EVENT);
    const b = await mapEventToOtlpSpan({ ...EVENT, _id: "evt2" });
    expect(a.traceId).toBe(b.traceId); // same correlationId → same trace
    expect(a.spanId).not.toBe(b.spanId); // different event → different span
  });

  test("endTime = start + latency", async () => {
    const span = await mapEventToOtlpSpan(EVENT);
    expect(span.startTimeUnixNano).toBe("1700000000000000000");
    expect(span.endTimeUnixNano).toBe("1700000000042000000"); // +42ms
  });
});

const CONFIG: OtlpConfig = {
  configured: true,
  enabled: true,
  endpoint: "https://otlp.example.com/v1/traces",
  headers: { Authorization: "Bearer k" },
};

describe("send (best-effort, never throws)", () => {
  test("unconfigured → skipped, no fetch", async () => {
    const fetchImpl = vi.fn();
    const r = await send({ ...CONFIG, configured: false }, [EVENT], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, count: 0, skipped: true, reason: "unconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("no events → ok, no fetch", async () => {
    const fetchImpl = vi.fn();
    const r = await send(CONFIG, [], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true, count: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("success → POSTs to the endpoint with operator headers; OUR Content-Type wins", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const r = await send(
      { ...CONFIG, headers: { Authorization: "Bearer k", "Content-Type": "text/plain" } },
      [EVENT],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r).toEqual({ ok: true, count: 1, status: 200 });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://otlp.example.com/v1/traces");
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer k");
    // Operator's bogus Content-Type must NOT win (the body is JSON).
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("operator's LOWER/MIXED-case content-type cannot survive into a combined header", async () => {
    // The actual failure mode (codex P2): a plain-object spread only overrides an
    // EXACT-case "Content-Type"; a differently-cased operator key survives as a
    // separate property and `fetch`'s case-insensitive Headers COMBINES the two
    // into "text/plain, application/json" — which the OTLP collector misparses.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await send(
      {
        ...CONFIG,
        headers: {
          Authorization: "Bearer k",
          "content-type": "text/plain", // lower-case
          "CONTENT-TYPE": "application/xml", // another casing
        },
      },
      [EVENT],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const outgoing = call[1].headers as Record<string, string>;
    // No case-variant of content-type must remain on the raw object besides ours.
    const ctKeys = Object.keys(outgoing).filter(
      (k) => k.toLowerCase() === "content-type",
    );
    expect(ctKeys).toEqual(["Content-Type"]);
    // The load-bearing assertion: routed through `Headers` (what `fetch` does),
    // the collector sees a SINGLE application/json — never the combined value.
    const asSent = new Headers(outgoing);
    expect(asSent.get("content-type")).toBe("application/json");
    expect(outgoing["Authorization"]).toBe("Bearer k");
  });

  test("non-2xx → ok:false with status (cursor must not advance)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const r = await send(CONFIG, [EVENT], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  test("network throw → caught, ok:false (never propagates to the cron)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await send(CONFIG, [EVENT], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, count: 0, reason: "network_error" });
  });
});
