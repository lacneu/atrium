// Hot-swappable OUTBOUND media fetcher (D-E). The fetcher is consumed ASYNC by
// the consume loop on gateway events, DECOUPLED from the `/send` that delivered
// the per-instance config — so a frozen boot fetcher could never reflect a hot
// `mediaMode`/`mediaMaxMb` change. The provider holds the current fetcher and
// rebuilds it ONLY when the (mode, maxBytes) signature changes; the writer reads
// it lazily via `getFetcher: () => provider.current()`. Process-global,
// last-write-wins (Model M: one bridge serves one instance).

import type { BridgeConfig } from "../config.js";
import { LocalDirMediaFetcher, type MediaFetcher } from "./media-fetcher.js";
import { GatewayHttpMediaFetcher } from "./gateway-http-media-fetcher.js";
import type { InboundInstanceConfig, MediaMode } from "./instance-config.js";

/**
 * Build the outbound-media fetcher for a (mode, maxBytes) pair. DEFAULT
 * "gateway-http" needs NO shared filesystem; "shared-fs" reads the mounted
 * outbound dir; "off" → undefined (the writer records `dropped:no_fetcher` and
 * the turn's text/tools still land). Boot params (token, dir, http base, timeout)
 * come from the bridge's own env — only mode + cap are hot.
 */
export function buildMediaFetcher(
  config: BridgeConfig,
  mode: MediaMode,
  maxBytes: number,
): MediaFetcher | undefined {
  switch (mode) {
    case "gateway-http":
      return new GatewayHttpMediaFetcher({
        httpBase: config.gatewayHttpBase,
        token: config.openclawToken,
        maxBytes,
        timeoutMs: config.mediaFetchTimeoutMs,
      });
    case "shared-fs":
      return new LocalDirMediaFetcher({
        baseDir: config.mediaOutboundDir,
        maxBytes,
      });
    case "off":
      return undefined;
  }
}

export class MediaFetcherProvider {
  private readonly config: BridgeConfig;
  private mode: MediaMode;
  private maxBytes: number;
  private signature: string;
  private fetcher: MediaFetcher | undefined;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.mode = config.mediaMode;
    this.maxBytes = config.mediaMaxBytes;
    this.signature = `${this.mode}:${this.maxBytes}`;
    this.fetcher = buildMediaFetcher(config, this.mode, this.maxBytes);
    console.log(`[media] outbound mode: ${this.mode} (maxBytes=${this.maxBytes})`);
  }

  /** The current fetcher (undefined in "off" mode). Read lazily by the writer. */
  current(): MediaFetcher | undefined {
    return this.fetcher;
  }

  /** The currently applied mode (for diagnostics/tests). */
  currentMode(): MediaMode {
    return this.mode;
  }

  /**
   * The currently applied byte cap (hot). The finalize-time outbound scan reads
   * this — NOT the boot `config.mediaMaxBytes` — so a file whose size sits between
   * the boot cap and a hot-raised `mediaMaxMb` is hosted by the scan exactly as the
   * current fetcher would accept it (no stale-cap mismatch).
   */
  currentMaxBytes(): number {
    return this.maxBytes;
  }

  /**
   * Apply the in-band per-instance config. A field absent from `partial` falls
   * back to the bridge's BOOT env default (stateless — never the previously
   * applied value), so a malformed/partial config can never strand a stale mode.
   * Rebuilds the fetcher ONLY when the (mode, maxBytes) signature actually changes.
   */
  applyConfig(partial: InboundInstanceConfig | null): void {
    const mode = partial?.mediaMode ?? this.config.mediaMode;
    const maxBytes = partial?.mediaMaxBytes ?? this.config.mediaMaxBytes;
    const signature = `${mode}:${maxBytes}`;
    if (signature === this.signature) return;
    this.mode = mode;
    this.maxBytes = maxBytes;
    this.signature = signature;
    this.fetcher = buildMediaFetcher(this.config, mode, maxBytes);
    console.log(`[media] outbound mode: ${mode} (maxBytes=${maxBytes})`);
  }
}
