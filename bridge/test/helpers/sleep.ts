/** A real-time wait, for the few tests that drive timers and sockets end to end. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
