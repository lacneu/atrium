// Process-level safety net: a SINGLE unhandled error must NEVER take the bridge
// down. The design target is "imagine the bridge is on Mars" — there is no
// operator standing by to restart it, so the process has to survive anything that
// slips past a local guard and keep serving every other chat.
//
// What's already isolated WITHOUT this net (so the net is a last resort, not the
// primary defense):
//   - per-request errors  -> the HTTP dispatcher wraps `handle()` in `.catch()`
//     and answers 500 (server.ts), so one bad request never wedges the server;
//   - per-session errors   -> the inbound consume loop catches feed/tick/endTurn
//     and a crashed loop closes its connection so the next send reconnects;
//   - Convex writer ops     -> the serialization chain swallows-and-continues and
//     the delta-flush timer has its own `.catch()`.
// This net catches whatever still escapes (a stray rejection, a throw inside a
// timer/event callback) and KEEPS THE PROCESS ALIVE.
//
// Tradeoff acknowledged: after an `uncaughtException` Node considers process state
// possibly-undefined. We still keep running, because exiting on one stray error is
// EXACTLY the "a single error invalidates the bridge" failure we are removing, and
// the bridge's state is per-session (isolated) rather than a shared mutable graph.
// `restart: unless-stopped` in compose remains the backstop for the truly
// unrecoverable death Node cannot catch anyway (OOM, segfault).

export interface SafetyNetLogger {
  error: (...args: unknown[]) => void;
}

/** Render any thrown value for a log line: full stack when available, else String(). */
export function formatReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  try {
    return typeof reason === "string" ? reason : JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/**
 * Register the last-resort handlers. Returns a disposer that removes exactly the
 * handlers this call added (used by tests; production installs once and never
 * disposes). The handlers LOG with a greppable, alertable prefix and deliberately
 * do NOT call `process.exit` — surviving the error is the whole point.
 */
export function installProcessSafetyNet(
  log: SafetyNetLogger = console,
): () => void {
  const onUnhandledRejection = (reason: unknown): void => {
    log.error(
      `[bridge:safety-net] unhandledRejection — process kept alive: ${formatReason(reason)}`,
    );
  };
  const onUncaughtException = (err: unknown): void => {
    log.error(
      `[bridge:safety-net] uncaughtException — process kept alive: ${formatReason(err)}`,
    );
  };

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  return () => {
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
  };
}

/** Minimal shape of the bits of `http.Server` we need (testable). */
type ErrorEmitter = {
  on(event: "error", listener: (err: Error) => void): unknown;
};

/**
 * Make a startup/bind failure FAIL FAST. The process safety net keeps the bridge
 * alive through stray RUNTIME errors, but that is exactly wrong for a server that
 * cannot bind its port (EADDRINUSE / EACCES): without an explicit handler the
 * server's `error` event surfaces as an uncaughtException, which the net would
 * SWALLOW -- leaving the bridge alive but with NO listening HTTP server (deaf), and
 * the supervisor/container never gets the non-zero exit it needs to restart and
 * surface the failure. This claims the `error` event (so the net never sees it) and
 * exits. A server-level `error` essentially only fires for bind failures, so
 * exiting is the correct recovery (the container restart policy takes over).
 */
export function installServerFailFast(
  server: ErrorEmitter,
  opts: { log?: SafetyNetLogger; exit?: (code: number) => void } = {},
): void {
  const log = opts.log ?? console;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  server.on("error", (err) => {
    log.error(
      `[bridge:safety-net] fatal HTTP server error — exiting for restart: ${formatReason(err)}`,
    );
    exit(1);
  });
}
