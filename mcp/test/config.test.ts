import { describe, it, expect } from "vitest";
import {
  ApiError,
  apiFetch,
  buildUrl,
  resolveConfig,
  type Config,
} from "../src/config.js";

const CONFIG: Config = {
  base: "http://127.0.0.1:3213",
  apiKey: "oc_live_TESTKEY1234",
};

/** Build a fake `fetch` that records its inputs and returns a canned Response. */
function fakeFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveConfig", () => {
  it("reads base + key from the injected env and strips trailing slashes", () => {
    const cfg = resolveConfig({
      OPENCLAW_WEBCHAT_API_BASE: "http://example.test:9999/",
      OPENCLAW_WEBCHAT_API_KEY: "oc_live_abc",
    });
    expect(cfg.base).toBe("http://example.test:9999");
    expect(cfg.apiKey).toBe("oc_live_abc");
  });

  it("falls back to the default local base when not set", () => {
    const cfg = resolveConfig({ OPENCLAW_WEBCHAT_API_KEY: "oc_live_abc" });
    expect(cfg.base).toBe("http://127.0.0.1:3213");
  });

  it("throws naming the env var (never the value) when the key is missing", () => {
    expect(() =>
      resolveConfig({ OPENCLAW_WEBCHAT_API_BASE: "http://x" }),
    ).toThrowError(/OPENCLAW_WEBCHAT_API_KEY is required/);
  });
});

describe("buildUrl", () => {
  it("prepends /api/v1 to the path", () => {
    expect(buildUrl("http://127.0.0.1:3213", "/traces")).toBe(
      "http://127.0.0.1:3213/api/v1/traces",
    );
  });

  it("tolerates a path without a leading slash and a base with a trailing slash", () => {
    expect(buildUrl("http://127.0.0.1:3213/", "health")).toBe(
      "http://127.0.0.1:3213/api/v1/health",
    );
  });
});

describe("apiFetch", () => {
  it("builds the right URL and attaches the Bearer Authorization header", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ ok: true, ts: 1 }));

    const result = await apiFetch<{ ok: boolean }>(
      CONFIG,
      "/health",
      {},
      { fetchImpl: impl },
    );

    expect(result).toEqual({ ok: true, ts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3213/api/v1/health");

    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get("Authorization")).toBe("Bearer oc_live_TESTKEY1234");
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("appends query strings the caller passes in the path", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ ok: true, events: [] }));
    await apiFetch(CONFIG, "/traces?limit=20&kind=api.call", {}, { fetchImpl: impl });
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3213/api/v1/traces?limit=20&kind=api.call",
    );
  });

  it("sets Content-Type only when a body is sent", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ ok: true }));
    await apiFetch(
      CONFIG,
      "/openclaw/query",
      { method: "POST", body: JSON.stringify({ q: "x" }) },
      { fetchImpl: impl },
    );
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("maps a 403 to a structured ApiError (status + body)", async () => {
    const { impl } = fakeFetch(
      jsonResponse({ ok: false, error: "missing permission: traces.read" }, 403),
    );

    await expect(
      apiFetch(CONFIG, "/traces", {}, { fetchImpl: impl }),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      body: { ok: false, error: "missing permission: traces.read" },
    });
  });

  it("maps a 401 to a structured ApiError (status + body)", async () => {
    const { impl } = fakeFetch(
      jsonResponse({ ok: false, error: "invalid api key" }, 401),
    );

    let caught: unknown;
    try {
      await apiFetch(CONFIG, "/traces", {}, { fetchImpl: impl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(401);
    expect((caught as ApiError).body).toEqual({
      ok: false,
      error: "invalid api key",
    });
  });

  it("falls back to raw text when an error body is not JSON", async () => {
    const { impl } = fakeFetch(
      new Response("Internal Server Error", { status: 500 }),
    );
    const err = await apiFetch(CONFIG, "/traces", {}, { fetchImpl: impl }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).body).toBe("Internal Server Error");
  });

  it("surfaces a transport failure as ApiError status 0", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await apiFetch(CONFIG, "/health", {}, { fetchImpl: impl }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
  });

  it("never leaks the API key in the ApiError message", async () => {
    const { impl } = fakeFetch(jsonResponse({ ok: false }, 403));
    const err = (await apiFetch(CONFIG, "/traces", {}, { fetchImpl: impl }).catch(
      (e) => e,
    )) as ApiError;
    expect(err.message).not.toContain(CONFIG.apiKey);
  });
});
