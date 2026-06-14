// Bridge entrypoint: wire config -> Convex writer -> session registry -> HTTP
// server, then listen. Graceful shutdown closes every live OpenClaw socket and
// the HTTP server so there are no zombie connections.
//
// Run with: npm start   (after `npm run build`) — `start` passes
// `--env-file=.env`, so secrets load from bridge/.env. Equivalent to
// `node --env-file=.env dist/index.js`.

import { loadConfig } from "./config.js";
import { HttpConvexWriter } from "./convex-writer.js";
import { LocalDirMediaFetcher } from "./core/media-fetcher.js";
import { HealthRegistry } from "./core/health.js";
import { SessionRegistry } from "./session.js";
import { createBridgeServer } from "./server.js";

function main(): void {
  // Fail fast on missing/invalid env before opening any socket.
  const config = loadConfig();

  // Outbound media is read from the gateway's `media/outbound` dir mounted into
  // the bridge (`:ro` in prod, a synced/SSHFS dir in dev) — there is no remote
  // media RPC on the gateway (see core/media-fetcher.ts).
  const mediaFetcher = new LocalDirMediaFetcher({
    baseDir: config.mediaOutboundDir,
    maxBytes: config.mediaMaxBytes,
  });
  const writer = new HttpConvexWriter({
    convexHttpActionsUrl: config.convexHttpActionsUrl,
    ingestSecret: config.convexIngestSecret,
    mediaFetcher,
  });
  const registry = new SessionRegistry(config, writer);
  const health = new HealthRegistry(Date.now());
  const server = createBridgeServer({ config, registry, health });

  server.listen(config.port, () => {
    console.log(`bridge listening on :${config.port}`);
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

main();
