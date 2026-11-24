// The last step of the bridge's shutdown: exit once the inbound server has closed AND
// the writes still waiting to leave have left.
//
// A sub-agent row write waits behind the one in flight for its child
// (HttpConvexWriter.upsertSubAgent). Exiting on the server's close alone dropped a
// record that had been received and not yet sent — a terminal among them, which leaves
// its row `running` until the reaper. Nothing here adds time to a shutdown with nothing
// waiting, and the caller's hard cap still bounds one that cannot finish.

// A drain that ended is not proof nothing is left: a producer that AWAITED the write the
// drain was waiting for sends its next record right after (Session.flushSubAgentObserved
// awaits a child's first record, then sends its terminal). So the end of a drain is
// followed by one turn of the event loop — the producers' continuations run — and by a
// fresh look: anything in flight or waiting is drained again. The exit happens only at a
// moment when nothing is.

export interface ShutdownSteps {
  /** Close the inbound server; the callback fires when it has closed. */
  close: (onClosed: () => void) => void;
  /** Resolves when no write is waiting any more. A rejection counts as done. */
  drain: () => Promise<void>;
  /** Is anything in flight or waiting right now? */
  pending: () => boolean;
  exit: () => void;
}

export function closeThenExit(steps: ShutdownSteps): void {
  let closed = false;
  let draining = false;
  const drainThenLook = (): void => {
    draining = true;
    const look = (): void => {
      // Let the callers answered by that drain run before looking again.
      setImmediate(() => {
        draining = false;
        settle();
      });
    };
    void steps.drain().then(look, look);
  };
  const settle = (): void => {
    if (!closed || draining) return;
    if (steps.pending()) drainThenLook();
    else steps.exit();
  };
  steps.close(() => {
    closed = true;
    settle();
  });
  drainThenLook();
}
