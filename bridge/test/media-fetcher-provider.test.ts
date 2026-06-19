// The hot-swap seam (D-E): the provider rebuilds the outbound fetcher ONLY when
// the (mode, maxBytes) signature changes, falls back to the BOOT env default for
// any field a hot config omits, and "off" yields no fetcher. The writer reads
// current() lazily, so these guarantees are what make a mid-run mediaMode change
// real rather than frozen at boot.

import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { MediaFetcherProvider } from "../src/core/media-fetcher-provider.js";
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
