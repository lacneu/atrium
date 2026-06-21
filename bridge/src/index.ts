// Bridge entrypoint: wire config -> Convex writer -> session registry -> HTTP
// server, then listen. Graceful shutdown closes every live OpenClaw socket and
// the HTTP server so there are no zombie connections.
//
// Run with: npm start   (after `npm run build`) — `start` passes
// `--env-file=.env`, so secrets load from bridge/.env. Equivalent to
// `node --env-file=.env dist/index.js`.

import { loadConfig } from "./config.js";
import { HttpConvexWriter } from "./convex-writer.js";
import { MediaFetcherProvider } from "./core/media-fetcher-provider.js";
import { CredentialResolver } from "./core/credential-resolver.js";
import { startInboundReaper } from "./core/inbound-reaper.js";
import { scanAndHostOutbound } from "./core/outbound-scan.js";
import type { OutboundScan } from "./core/turn-sink.js";
import { HealthRegistry } from "./core/health.js";
import { SessionRegistry } from "./session.js";
import { createBridgeServer } from "./server.js";
import {
  installProcessSafetyNet,
  installServerFailFast,
} from "./core/safety-net.js";

async function main(): Promise<void> {
  // Fail fast on missing/invalid env before opening any socket.
  const config = loadConfig();

  // Step 3b: resolve the gateway credentials ONCE at boot — Convex (per-bridge
  // secret) first, env fallback per field — and populate `config`. A rotation takes
  // effect on the next restart (lazy-per-connect is a follow-up). If neither Convex
  // nor env provides a required credential, resolve() throws and the bridge fails to
  // boot (fail-fast) rather than running unauthenticatable.
  const credentialResolver = new CredentialResolver({
    convexHttpActionsUrl: config.convexHttpActionsUrl,
    bridgeInstanceSecret: config.bridgeInstanceSecret,
    // Confirm the secret's PROVEN instance equals the one this bridge serves —
    // a mismatch means a misconfigured secret; its credentials are refused.
    expectedInstanceName: config.instanceName,
    envToken: config.openclawToken,
    envDeviceIdentity: config.deviceIdentity,
    onWarn: (msg) => console.warn(`[credentials] ${msg}`),
  });
  const creds = await credentialResolver.resolve();
  config.openclawToken = creds.token;
  config.deviceIdentity = creds.deviceIdentity;

  // Hot-swappable outbound media fetcher (D-E): the provider holds the current
  // fetcher and rebuilds it when /send applies a per-instance mediaMode/mediaMaxMb
  // change; the writer reads it lazily so async outbound media reflects the change.
  const mediaProvider = new MediaFetcherProvider(config);
  const writer = new HttpConvexWriter({
    convexHttpActionsUrl: config.convexHttpActionsUrl,
    ingestSecret: config.convexIngestSecret,
    getFetcher: () => mediaProvider.current(),
  });
  // DETERMINISTIC outbound media: at each turn's finalize, host any file the agent
  // dropped in the outbound dir — independent of whether it emitted a MEDIA: line
  // (the LLM is unreliable about it). Only active in shared-fs outbound mode (the
  // bridge has a local mount to scan); a no-op otherwise.
  const outboundScan: OutboundScan = (messageId, sinceMs, hosted) =>
    scanAndHostOutbound(
      {
        writer,
        dir: config.mediaOutboundDir,
        // HOT cap (not the boot config.mediaMaxBytes): match what the current fetcher
        // would accept after a per-instance mediaMaxMb change.
        maxBytes: mediaProvider.currentMaxBytes(),
        enabled: () => mediaProvider.currentMode() === "shared-fs",
      },
      messageId,
      sinceMs,
      hosted,
    );
  const registry = new SessionRegistry(config, writer, undefined, outboundScan);
  const health = new HealthRegistry(Date.now());
  const server = createBridgeServer({ config, registry, health, mediaProvider });

  // A listen/bind failure must FAIL FAST so the supervisor restarts and the failure
  // surfaces: an ASYNC `error` event (EADDRINUSE / EACCES) is claimed here and
  // exits; a SYNCHRONOUS server.listen() throw (e.g. an out-of-range port ->
  // ERR_SOCKET_BAD_PORT) propagates uncaught and exits because the process safety
  // net is NOT armed until we are actually listening (below).
  installServerFailFast(server);

  // Reap stale shared-fs inbound files (Phase 3) — the bridge owns this dir's
  // lifecycle. Unref'd, so it never holds the process open during shutdown.
  startInboundReaper(config.inboundMediaDir, config.inboundTtlMs);

  server.listen(config.port, () => {
    console.log(`bridge listening on :${config.port}`);
    // Arm the last-resort net ONLY now, with a live listener: a stray RUNTIME error
    // must never take the bridge down, while every BOOT-phase error above still
    // fails fast (uncaught -> exit -> restart) rather than being swallowed.
    installProcessSafetyNet();
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    registry.closeAll();
    server.close(() => process.exit(0));
    // Hard cap so a stuck close never blocks the process forever.
    const timer = setTimeout(() => process.exit(0), 5_000);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("bridge failed to start:", err);
  process.exit(1);
});
