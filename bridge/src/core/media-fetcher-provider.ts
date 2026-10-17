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
import { CompositeMediaFetcher } from "./composite-media-fetcher.js";
import {
  connectUserHeader,
  systemConnectIdentity,
  mediaForwardedOrigin,
} from "../providers/openclaw/connect-identity.js";
import { buildIdentityHeaders } from "../providers/openclaw/gateway-identity.js";
import type { InboundInstanceConfig, MediaMode } from "./instance-config.js";

/**
 * The identity a request to the gateway's HTTP media routes presents: the bridge's SYSTEM
 * identity headers in trusted-proxy mode (empty in token mode). Shared by the media
 * fetcher and the transcript file copier (core/artifact-copier.ts) — one definition of
 * the authorization contract.
 */
export function mediaIdentityHeaders(config: BridgeConfig): Record<string, string> {
  // The forwarded ORIGIN must describe the request being authorized. The
  // socket's identity carries the operator URL, and `gatewayHttpBase` can
  // differ from it (`instances.gatewayHttpUrl`) — a gateway whose
  // `requiredHeaders` lists the host would then be told about the wrong one.
  const identity = systemConnectIdentity(config);
  return buildIdentityHeaders(
    identity === undefined
      ? undefined
      : { ...identity, ...mediaForwardedOrigin(config) },
    connectUserHeader(config),
  );
}

/** The gateway's own media route, built once and used by TWO modes: as the whole
 *  fetcher in `gateway-http`, and as the sibling-directory fallback under
 *  `shared-fs`. Extracted verbatim rather than duplicated — the identity and
 *  origin rules below are the authorization contract, and a second copy is a
 *  second thing to get wrong. */
function buildGatewayHttpFetcher(
  config: BridgeConfig,
  maxBytes: number,
): GatewayHttpMediaFetcher {
  return new GatewayHttpMediaFetcher({
    httpBase: config.gatewayHttpBase,
    // Boot-resolved (index.ts) — non-null by construction; the same operator
    // token the WS connect uses.
    token: () => config.openclawToken!,
    // Trusted-proxy: the HTTP media route is behind the SAME header-based
    // authorization as the WebSocket, so the probe must state an identity or
    // it is refused. Empty in token mode ⇒ the Bearer path is untouched.
    identityHeaders: () => mediaIdentityHeaders(config),
    maxBytes,
    timeoutMs: config.mediaFetchTimeoutMs,
  });
}

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
      return buildGatewayHttpFetcher(config, maxBytes);
    case "shared-fs": {
      const local = new LocalDirMediaFetcher({
        baseDir: config.mediaOutboundDir,
        maxBytes,
      });
      // The mount holds `media/outbound` ONLY; upstream's generation tools write
      // to sibling directories the normalizer also accepts. Without this, every
      // generated image on a shared-fs instance was announced and then dropped.
      // The gateway serves them on the same route `gateway-http` mode uses, so we
      // ask IT rather than asking the operator to re-mount (2026-09-20 report).
      const httpBase = config.gatewayHttpBase;
      const token = config.openclawToken;
      // No HTTP base ⇒ no fallback, and the skip reason stays `not_in_this_mount`:
      // an honest "this fetcher cannot see it", never a silent pretence that the
      // file was missing.
      //
      // The TOKEN requirement is scoped to the mode that uses one. A trusted-proxy
      // instance has NO shared token BY CONSTRUCTION — upstream refuses to run that
      // mode with one configured, which is why `credential-resolver.ts:265` writes
      // exactly this condition to decide whether a missing token is an error. A
      // flat `!token` here read that correct configuration as "unauthenticated" and
      // silently returned the local fetcher, so every generated image on a
      // trusted-proxy deployment kept being announced and dropped — the very defect
      // this composite exists to fix, disabled on one whole class of instance with
      // no log and no reason code.
      //
      // The fallback itself already knows: it presents identity headers instead of
      // a Bearer when there is no token (gateway-http-media-fetcher.ts:130-138),
      // which is the same authorization the WebSocket uses. Nothing downstream
      // needed changing — only this gate disagreed with it.
      const trustedProxy = config.openclawAuthMode === "trusted-proxy";
      if (!httpBase || (!token && !trustedProxy)) return local;
      return new CompositeMediaFetcher({
        primary: local,
        fallback: buildGatewayHttpFetcher(config, maxBytes),
      });
    }
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
  private routeFetcher: { maxBytes: number; fetcher: GatewayHttpMediaFetcher } | undefined;

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

  /**
   * THE GATEWAY'S MEDIA ROUTE, and nothing else — what a transcript `MEDIA:` reference is
   * copied through (core/artifact-copier.ts). The Control UI resolves every such reference
   * through `/__openclaw__/assistant-media?source=…&sessionKey=…` (meta, then a ticket;
   * src/gateway/control-ui.ts:429 at v2026.9.33), under the policy of the SESSION that
   * names it (control-ui-assistant-media-policy.test.ts:157, :441). A local outbound mount
   * is never consulted for it, even under `shared-fs`: it is keyed by base name and knows
   * no session, so a homonym written by another conversation would be read instead.
   * Undefined in `off`, or when the route cannot be authenticated (no HTTP base; no token
   * outside trusted-proxy).
   */
  mediaRoute(): GatewayHttpMediaFetcher | undefined {
    if (this.mode === "off") return undefined;
    const httpBase = this.config.gatewayHttpBase;
    const trustedProxy = this.config.openclawAuthMode === "trusted-proxy";
    if (!httpBase || (!this.config.openclawToken && !trustedProxy)) return undefined;
    if (this.routeFetcher?.maxBytes !== this.maxBytes) {
      this.routeFetcher = { maxBytes: this.maxBytes, fetcher: buildGatewayHttpFetcher(this.config, this.maxBytes) };
    }
    return this.routeFetcher.fetcher;
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
