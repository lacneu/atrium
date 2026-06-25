// Bridge entrypoint: wire shared config -> HTTP server -> listen, then run the boot
// self-heal loop that resolves every per-bridge secret from Convex and registers each
// instance as it becomes valid. The bridge ALWAYS starts (Mars robustness): an
// unconfigured/misconfigured instance is retried, never a crash — so a fix in Convex
// (creds, gateway URL) is picked up WITHOUT recreating the bridge. Graceful shutdown
// stops the loop and closes every live OpenClaw socket + the HTTP server.
//
// Run with: npm start   (after `npm run build`) — `start` passes
// `--env-file=.env`, so secrets load from bridge/.env. Equivalent to
// `node --env-file=.env dist/index.js`.

import {
  loadSharedConfig,
  buildInstanceConfig,
  findMediaDirCollision,
  type SharedConfig,
  type BridgeConfig,
  type InstanceData,
} from "./config.js";
import { HttpConvexWriter } from "./convex-writer.js";
import { MediaFetcherProvider } from "./core/media-fetcher-provider.js";
import {
  CredentialResolver,
  type ConfigIssue,
} from "./core/credential-resolver.js";
import {
  startCredentialRefresh,
  type RegisterOutcome,
  type CredentialRefresh,
} from "./core/credential-refresh.js";
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

/**
 * Build one self-contained bundle for an instance: its hot media provider, a Convex
 * writer with that instance's media fetcher baked in, and the deterministic outbound
 * scan over that instance's dir. Keeping the per-instance-ness here leaves the
 * Session/RunManager/writer code unchanged.
 */
function buildBundle(config: BridgeConfig): InstanceBundle {
  const mediaProvider = new MediaFetcherProvider(config);
  const writer = new HttpConvexWriter({
    convexHttpActionsUrl: config.convexHttpActionsUrl,
    ingestSecret: config.convexIngestSecret,
    deltaFlushMs: config.deltaFlushMs,
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
  return { config, writer, mediaProvider, outboundScan };
}

/** Max time the boot waits on the FIRST credential pass before listening anyway, so a
 *  slow/unreachable Convex never blocks startup (the self-heal loop keeps retrying). */
const BOOT_RESOLVE_BUDGET_MS = 3_000;

async function main(): Promise<void> {
  // Gateway config is Convex-only (D1): the bridge reads ONLY the gateway-agnostic
  // shared config + its per-bridge secret list from env. The shared requirements
  // (Convex URL, ingest+shared secrets, port) are env-only and the bridge genuinely
  // cannot function without them, so loadSharedConfig STILL fails fast on a missing one
  // (the deliberate fatal boundary). Everything instance-specific is non-fatal below.
  const shared = loadSharedConfig();

  // The served instances, keyed by instanceName. STARTS EMPTY: the bridge binds + serves
  // /health regardless, and the self-heal loop fills this map as instances resolve. The
  // SessionRegistry and the HTTP server hold this SAME reference, so a runtime register()
  // makes an instance routable immediately — no restart.
  const served = new Map<string, InstanceBundle>();
  const registry = new SessionRegistry(served);
  const health = new HealthRegistry(Date.now());
  // Mutable so the self-heal loop can refresh it; the server reads it live for /health.
  let configIssues: ConfigIssue[] = [];
  // Declared before the server so `triggerRefresh` can close over it (assigned below);
  // the closure reads the live value at call time (when /refresh-credentials is hit).
  let refresh: CredentialRefresh | null = null;
  const server = createBridgeServer({
    shared,
    served,
    registry,
    health,
    getConfigIssues: () => configIssues,
    // Convex pokes POST /refresh-credentials to make the bridge pick up a just-saved
    // credential NOW (resolve + connect -> pairing) instead of waiting for the poll.
    triggerRefresh: () => refresh?.tick() ?? Promise.resolve(),
  });

  // A listen/bind failure must FAIL FAST so the supervisor restarts and the failure
  // surfaces: an ASYNC `error` event (EADDRINUSE / EACCES) is claimed here and exits; a
  // SYNCHRONOUS server.listen() throw (e.g. an out-of-range port) propagates uncaught
  // and exits because the process safety net is NOT armed until we are actually
  // listening (below).
  installServerFailFast(server);

  // Build + register a resolved instance. Returns 'collision' (kept pending) without
  // building anything, 'duplicate' if already served, else 'registered'.
  const register = (data: InstanceData): RegisterOutcome => {
    // Already served: a redundant duplicate secret (or an unchanged re-resolve). Rotating
    // a SERVED instance's credentials hot is deliberately NOT handled here (it is racy with
    // in-flight connections) — it takes effect on the next bridge recreate. See README.
    if (served.has(data.instanceName)) return "duplicate";
    const config = buildInstanceConfig(shared, data);
    // A new instance must not share a final media dir with an already-served one (in
    // shared-fs that cross-attaches files between gateways). The existing set is
    // collision-free by induction, so any collision here involves THIS candidate.
    const candidate = {
      instanceName: data.instanceName,
      mediaOutboundDir: config.mediaOutboundDir,
      inboundMediaDir: config.inboundMediaDir,
    };
    const existing = [...served.values()].map((b) => ({
      instanceName: b.config.instanceName ?? "?",
      mediaOutboundDir: b.config.mediaOutboundDir,
      inboundMediaDir: b.config.inboundMediaDir,
    }));
    if (findMediaDirCollision([...existing, candidate]) !== null) return "collision";
    registry.register(data.instanceName, buildBundle(config));
    // Reap stale shared-fs inbound files for THIS instance's dir (the bridge owns it).
    startInboundReaper(config.inboundMediaDir, config.inboundTtlMs);
    console.log(
      `bridge: instance "${data.instanceName}" now serving (${served.size} total)`,
    );
    return "registered";
  };

  // The self-heal loop OWNS all credential resolution (boot + retry are one path). With
  // no secrets there is nothing to resolve — the bridge still serves /health, surfacing
  // the misconfig (a missing BRIDGE_INSTANCE_SECRETS is an env change → needs a restart).
  if (shared.bridgeInstanceSecrets.length === 0) {
    configIssues = [{ reason: "no_secrets" }];
    console.warn(
      "bridge: no per-bridge secrets configured (BRIDGE_INSTANCE_SECRETS empty) — " +
        "serving 0 instances. Set it + recreate the bridge.",
    );
  } else {
    const resolver = new CredentialResolver({
      convexHttpActionsUrl: shared.convexHttpActionsUrl,
      bridgeInstanceSecrets: shared.bridgeInstanceSecrets,
      shared,
      onWarn: (msg) => console.warn(`[credentials] ${msg}`),
    });
    refresh = startCredentialRefresh({
      pending: shared.bridgeInstanceSecrets,
      resolveOne: (secret) => resolver.resolveOne(secret),
      register,
      intervalMs: shared.credentialRetryMs,
      onIssues: (issues) => {
        configIssues = issues;
      },
      log: (msg) => console.log(`[credentials] ${msg}`),
    });
    // Run the FIRST pass BEFORE listening so a normal restart (Convex reachable) serves a
    // populated /capabilities + /send from the first request — no empty-state window where
    // the compat poller would overwrite its last-good snapshot or a dispatch would 409.
    // BOUNDED: after the budget we listen anyway (boot is never blocked); the loop keeps
    // retrying in the background. While not yet listening the bridge is simply unreachable,
    // which the compat/health pollers treat as last-good-preserving and dispatch as
    // retryable — strictly better than publishing an empty state as authoritative.
    await Promise.race([
      refresh.tick(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, BOOT_RESOLVE_BUDGET_MS);
        if (typeof t.unref === "function") t.unref();
      }),
    ]);
  }

  server.listen(shared.port, () => {
    console.log(`bridge listening on :${shared.port}`);
    // Arm the last-resort net ONLY now, with a live listener: a stray RUNTIME error must
    // never take the bridge down, while every BOOT-phase error above still fails fast
    // (uncaught -> exit -> restart) rather than being swallowed.
    installProcessSafetyNet();
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    refresh?.stop();
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
