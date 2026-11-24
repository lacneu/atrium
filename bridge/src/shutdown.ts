// The last step of the bridge's shutdown: exit once the inbound server has closed AND
// the writes still waiting to leave have left.
//
// A sub-agent row write waits behind the one in flight for its child
// (HttpConvexWriter.upsertSubAgent). Exiting on the server's close alone dropped a
// record that had been received and not yet sent — a terminal among them, which leaves
// its row `running` until the reaper. Nothing here adds time to a shutdown with nothing
// waiting, and the caller's hard cap still bounds one that cannot finish.

export interface ShutdownSteps {
  /** Close the inbound server; the callback fires when it has closed. */
  close: (onClosed: () => void) => void;
  /** Resolves when no write is waiting any more. A rejection counts as done. */
  drain: () => Promise<void>;
  exit: () => void;
}

export function closeThenExit(steps: ShutdownSteps): void {
  let closed = false;
  let drained = false;
  const settle = (): void => {
    if (closed && drained) steps.exit();
  };
  steps.close(() => {
    closed = true;
    settle();
  });
  const onDrained = (): void => {
    drained = true;
    settle();
  };
  void steps.drain().then(onDrained, onDrained);
}
