// The hot-swap seam (D-E): the provider rebuilds the outbound fetcher ONLY when
// the (mode, maxBytes) signature changes, falls back to the BOOT env default for
// any field a hot config omits, and "off" yields no fetcher. The writer reads
// current() lazily, so these guarantees are what make a mid-run mediaMode change
// real rather than frozen at boot.

import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  MediaFetcherProvider,
  buildMediaFetcher,
} from "../src/core/media-fetcher-provider.js";
import { LocalDirMediaFetcher } from "../src/core/media-fetcher.js";
import { GatewayHttpMediaFetcher } from "../src/core/gateway-http-media-fetcher.js";

const baseEnv = {
  OPENCLAW_GATEWAY_URL: "ws://gw.invalid:18790",
  OPENCLAW_TOKEN: "tkn",
  OPENCLAW_DEVICE_IDENTITY: JSON.stringify({
    id: "d",
    publicKey: "p",
    privateKey: "k",
  }),
  CONVEX_HTTP_ACTIONS_URL: "http://convex.invalid",
  BRIDGE_INGEST_SECRET: "i",
  BRIDGE_SHARED_SECRET: "s",
} as NodeJS.ProcessEnv;

describe("MediaFetcherProvider", () => {
  it("starts in the boot mediaMode (gateway-http by default)", () => {
    const p = new MediaFetcherProvider(loadConfig({ ...baseEnv }));
    expect(p.currentMode()).toBe("gateway-http");
    expect(p.current()).toBeInstanceOf(GatewayHttpMediaFetcher);
  });

  it("applyConfig switches mode and rebuilds the fetcher", () => {
    const p = new MediaFetcherProvider(loadConfig({ ...baseEnv }));
    p.applyConfig({ mediaMode: "shared-fs" });
    expect(p.currentMode()).toBe("shared-fs");
    expect(p.current()).toBeInstanceOf(LocalDirMediaFetcher);

    p.applyConfig({ mediaMode: "off" });
    expect(p.currentMode()).toBe("off");
    expect(p.current()).toBeUndefined();
  });

  it("REBUILDS only when the signature changes (same config → same instance)", () => {
    const p = new MediaFetcherProvider(loadConfig({ ...baseEnv }));
    const first = p.current();
    p.applyConfig({ mediaMode: "gateway-http" }); // same as boot
    expect(p.current()).toBe(first); // not rebuilt
    p.applyConfig({ mediaMode: "shared-fs" });
    const sharedA = p.current();
    p.applyConfig({ mediaMode: "shared-fs" }); // same again
    expect(p.current()).toBe(sharedA); // not rebuilt
  });

  it("rebuilds when only the byte cap changes (caps are hot too)", () => {
    const p = new MediaFetcherProvider(loadConfig({ ...baseEnv }));
    const first = p.current();
    p.applyConfig({ mediaMaxBytes: 7 * 1024 * 1024 });
    expect(p.current()).not.toBe(first); // signature changed → rebuilt
    expect(p.currentMode()).toBe("gateway-http");
  });

  it("currentMaxBytes() tracks the HOT cap (so the outbound scan matches the fetcher)", () => {
    const p = new MediaFetcherProvider(loadConfig({ ...baseEnv }));
    const boot = p.currentMaxBytes();
    p.applyConfig({ mediaMode: "shared-fs", mediaMaxBytes: 50 * 1024 * 1024 });
    // The scan reads currentMaxBytes(); had it kept config.mediaMaxBytes (boot), a
    // file between boot and the raised cap would be skipped while the fetcher accepts.
    expect(p.currentMaxBytes()).toBe(50 * 1024 * 1024);
    expect(p.currentMaxBytes()).not.toBe(boot);
  });

  it("falls back to the BOOT default for any field the hot config omits", () => {
    const p = new MediaFetcherProvider(
      loadConfig({ ...baseEnv, OPENCLAW_MEDIA_MODE: "shared-fs" }),
    );
    expect(p.currentMode()).toBe("shared-fs");
    // A null/empty config must NOT strand the previous mode — it resolves back to
    // the boot env (shared-fs), stateless.
    p.applyConfig({ mediaMode: "off" });
    expect(p.currentMode()).toBe("off");
    p.applyConfig(null);
    expect(p.currentMode()).toBe("shared-fs"); // boot default, not "off"
  });
});

describe("the media fetcher describes the origin IT is authorized on", () => {
  /**
   * Drives the REAL `buildMediaFetcher` and captures what it actually sends.
   *
   * An earlier version of these tests rebuilt the header composition inline and
   * asserted on that — so reverting the production wiring left them green. A test
   * that cannot fail is worse than no test: it reports coverage it does not have.
   * `GatewayHttpMediaFetcher` takes its `fetch` from the global, so intercepting
   * there is what puts the production path under the assertion.
   */
  async function headersSentBy(
    config: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const seen: Record<string, string>[] = [];
    const realFetch = globalThis.fetch;
    // BEFORE building: the fetcher captures `fetch` in its constructor
    // (`opts.fetchImpl ?? fetch`), so a later swap would never be seen.
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ ...((init?.headers ?? {}) as Record<string, string>) });
      // A 404 ends `open()` on its shortest path; the headers are already sent.
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;
    const fetcher = buildMediaFetcher(config as never, "gateway-http", 1024);
    expect(fetcher, "gateway-http must build a fetcher").toBeDefined();
    try {
      await fetcher!.open("/tmp/x").catch(() => undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen.length, "the meta probe must have been attempted").toBeGreaterThan(0);
    return seen[0]!;
  }

  const TRUSTED = {
    openclawAuthMode: "trusted-proxy",
    instanceName: "alpha",
    openclawForwardedClientIp: "10.7.7.7",
    mediaFetchTimeoutMs: 5000,
    openclawToken: "tkn",
  };

  it("uses the HTTP base, not the socket's URL, when they differ", async () => {
    // `gatewayHttpBase` derives from `instances.gatewayHttpUrl` when set, so the
    // media route can live somewhere other than the operator socket. A gateway
    // whose `requiredHeaders` lists x-forwarded-host would then be told about the
    // socket's host while authorizing a request to a different one.
    const headers = await headersSentBy({
      ...TRUSTED,
      openclawGatewayUrl: "wss://socket.example.org:18789",
      gatewayHttpBase: "https://media.example.org",
    });
    expect(headers["x-forwarded-host"]).toBe("media.example.org");
    expect(headers["x-forwarded-proto"]).toBe("https");
    expect(headers["x-forwarded-user"]).toBe("atrium-bridge:alpha");
  });

  it("describes the socket's host when no separate media URL is configured", async () => {
    // The ordinary case: `gatewayHttpBase` is derived FROM the gateway URL, so the
    // two agree and the header names the one host there is. Written with the value
    // a loader actually produces — an empty base is a config no path can build,
    // and a test pinning one proves only that the stub never parsed it.
    const headers = await headersSentBy({
      ...TRUSTED,
      openclawGatewayUrl: "ws://127.0.0.1:18790",
      gatewayHttpBase: "http://127.0.0.1:18790",
    });
    expect(headers["x-forwarded-host"]).toBe("127.0.0.1:18790");
    expect(headers["x-forwarded-proto"]).toBe("http");
  });

  it("token mode sends the Bearer and NO forwarded header", async () => {
    // The additions must not leak into the mode that presents no identity.
    const headers = await headersSentBy({
      openclawAuthMode: "token",
      instanceName: "alpha",
      openclawGatewayUrl: "ws://127.0.0.1:18790",
      gatewayHttpBase: "http://127.0.0.1:18790",
      mediaFetchTimeoutMs: 5000,
      openclawToken: "tkn",
    });
    expect(headers["Authorization"]).toBe("Bearer tkn");
    expect(headers["x-forwarded-host"]).toBeUndefined();
  });
});
