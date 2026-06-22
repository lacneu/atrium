// Test helpers for the multi-instance bridge: build a 1-instance served map + a
// SharedConfig from a single BridgeConfig fixture, so tests written against the old
// single-config SessionRegistry/createBridgeServer API adapt with one call.

import type { BridgeConfig, SharedConfig } from "../../src/config.js";
import type { ConvexWriter } from "../../src/convex-writer.js";
import type { InstanceBundle } from "../../src/session.js";
import { MediaFetcherProvider } from "../../src/core/media-fetcher-provider.js";
import type { OutboundScan } from "../../src/core/turn-sink.js";

/** A 1-instance served map keyed by `config.instanceName` (default "primary"). Builds a
 *  REAL MediaFetcherProvider (no I/O at construction) so /send tests exercise the
 *  in-band applyConfig path honestly. */
export function servedMap(
  config: BridgeConfig,
  writer: ConvexWriter = {} as ConvexWriter,
  outboundScan?: OutboundScan,
): Map<string, InstanceBundle> {
  const name = config.instanceName ?? "primary";
  const cfg = { ...config, instanceName: name };
  const bundle: InstanceBundle = {
    config: cfg,
    writer,
    mediaProvider: new MediaFetcherProvider(cfg),
    outboundScan,
  };
  return new Map([[name, bundle]]);
}

/** Derive the gateway-agnostic SharedConfig the server needs (auth secret, body cap,
 *  + the rest filled from the fixture). */
export function sharedFromConfig(config: BridgeConfig): SharedConfig {
  return {
    convexHttpActionsUrl: config.convexHttpActionsUrl,
    convexIngestSecret: config.convexIngestSecret,
    bridgeSharedSecret: config.bridgeSharedSecret,
    port: config.port,
    maxBodyBytes: config.maxBodyBytes,
    inboundTtlMs: config.inboundTtlMs,
    mediaFetchTimeoutMs: config.mediaFetchTimeoutMs,
    mediaModeDefault: config.mediaMode,
    mediaMaxBytesDefault: config.mediaMaxBytes,
    mediaOutboundAgentMount: config.mediaOutboundAgentMount,
    inboundAgentMount: config.inboundAgentMount,
    mediaOutboundDirOverride: null,
    inboundMediaDirOverride: null,
    bridgeInstanceSecrets: [],
    credentialRetryMs: 30_000,
  };
}
