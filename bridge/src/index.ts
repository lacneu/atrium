// Bridge entrypoint: wire config -> Convex writer -> session registry -> HTTP
// server, then listen. Graceful shutdown closes every live OpenClaw socket and
// the HTTP server so there are no zombie connections.
//
// Run with: npm start   (after `npm run build`) — `start` passes
// `--env-file=.env`, so secrets load from bridge/.env. Equivalent to
// `node --env-file=.env dist/index.js`.

import { loadSharedConfig, findMediaDirCollision } from "./config.js";
import { HttpConvexWriter } from "./convex-writer.js";
import { MediaFetcherProvider } from "./core/media-fetcher-provider.js";
import { CredentialResolver } from "./core/credential-resolver.js";
import { startInboundReaper } from "./core/inbound-reaper.js";
import { scanAndHostOutbound } from "./core/outbound-scan.js";
import type { OutboundScan } from "./core/turn-sink.js";
import { HealthRegistry } from "./core/health.js";
import { SessionRegistry, type InstanceBundle } from "./session.js";
import { createBridgeServer } from "./server.js";
import {
  installProcessSafetyNet,
  installServerFailFast,
} from "./core/safety-net.js";

async function main(): Promise<void> {
  // Gateway config is Convex-only (D1): the bridge reads ONLY the gateway-agnostic
  // shared config + its per-bridge secret list from env, then fetches each served
  // instance's gateway URL + creds from Convex. Fail fast if nothing to serve.
  const shared = loadSharedConfig();
  if (shared.bridgeInstanceSecrets.length === 0) {
    throw new Error(
      "no instances to serve: set BRIDGE_INSTANCE_SECRETS (one per-bridge secret " +
        "per Convex instance) — gateway URL + credentials are configured in Convex",
    );
  }

  // Resolve EVERY served instance from Convex (per-bridge secret -> instance +
  // gateway config + decrypted creds). Partial-failure tolerant (D4): a bad secret
  // is skipped, never blocks the healthy instances.
  const resolver = new CredentialResolver({
    convexHttpActionsUrl: shared.convexHttpActionsUrl,
    bridgeInstanceSecrets: shared.bridgeInstanceSecrets,
    shared,
    onWarn: (msg) => console.warn(`[credentials] ${msg}`),
  });
  const { served: configs, failures } = await resolver.resolveAll();
  if (configs.size === 0) {
    throw new Error(
      `no instances resolved from Convex (${failures.length} secret(s) failed): ` +
        "configure each instance in Convex (gateway URL + credentials + a minted " +
        "per-bridge secret) and set BRIDGE_INSTANCE_SECRETS",
    );
  }

  // Refuse a config where two served instances share a final media dir (a single dir
  // override applied to many, or names normalizing to the same segment) — in shared-fs
  // that cross-attaches files between gateways. Fail fast with a clear, actionable error.
  const collision = findMediaDirCollision(
    [...configs.values()].map((c) => ({
      instanceName: c.instanceName ?? "?",
      mediaOutboundDir: c.mediaOutboundDir,
      inboundMediaDir: c.inboundMediaDir,
    })),
  );
  if (collision) {
    throw new Error(
      `media dir collision: ${collision.a} and ${collision.b} both resolve to ` +
        `"${collision.dir}". For a multi-instance bridge, remove the single ` +
        `OPENCLAW_MEDIA_OUTBOUND_DIR / OPENCLAW_INBOUND_DIR override (per-instance dirs ` +
        `are derived from the instance name) or rename the colliding instances; in ` +
        `shared-fs a shared dir would cross-attach files between gateways.`,
    );
  }

  // Build one self-contained bundle per served instance: its hot media provider, a
  // Convex writer with that instance's media fetcher baked in, and the deterministic
  // outbound scan over that instance's dir. Keeping the per-instance-ness here leaves
  // the Session/RunManager/writer code unchanged.
  const bundles = new Map<string, InstanceBundle>();
  for (const [name, config] of configs) {
    const mediaProvider = new MediaFetcherProvider(config);
    const writer = new HttpConvexWriter({
      convexHttpActionsUrl: config.convexHttpActionsUrl,
      ingestSecret: config.convexIngestSecret,
      getFetcher: () => mediaProvider.current(),
    });
    const outboundScan: OutboundScan = (messageId, sinceMs, hosted) =>
      scanAndHostOutbound(
        {
          writer,
          dir: config.mediaOutboundDir,
          maxBytes: mediaProvider.currentMaxBytes(),
          enabled: () => mediaProvider.currentMode() === "shared-fs",
        },
        messageId,
        sinceMs,
        hosted,
      );
    bundles.set(name, { config, writer, mediaProvider, outboundScan });
    // Reap stale shared-fs inbound files for THIS instance's dir (the bridge owns it).
    startInboundReaper(config.inboundMediaDir, config.inboundTtlMs);
  }
  console.log(
    `bridge serving ${bundles.size} instance(s): [${[...bundles.keys()].join(", ")}]` +
      (failures.length ? ` (${failures.length} secret(s) skipped)` : ""),
  );

  const registry = new SessionRegistry(bundles);
  const health = new HealthRegistry(Date.now());
  const server = createBridgeServer({ shared, served: bundles, registry, health });

  // A listen/bind failure must FAIL FAST so the supervisor restarts and the failure
  // surfaces: an ASYNC `error` event (EADDRINUSE / EACCES) is claimed here and
  // exits; a SYNCHRONOUS server.listen() throw (e.g. an out-of-range port ->
  // ERR_SOCKET_BAD_PORT) propagates uncaught and exits because the process safety
  // net is NOT armed until we are actually listening (below).
  installServerFailFast(server);

  // (Stale shared-fs inbound files are reaped per-instance, started above when each
  // bundle is built — each instance owns its own inbound dir.)

  server.listen(shared.port, () => {
    console.log(`bridge listening on :${shared.port}`);
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
