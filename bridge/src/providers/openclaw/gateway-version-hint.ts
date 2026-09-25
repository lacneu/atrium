// Which gateway version a NEW conversation socket may assume, before its handshake.
//
// A connection declares its client capabilities in `connect`, before `hello-ok` says
// which gateway answered. One of them — `approvals` — makes Atrium a reviewer surface
// the gateway routes approvals to (server-request-context.ts canDeliverApprovals), so
// it must be declared only where Atrium actually shows them (AGENT_REQUESTS_MIN_VERSION).
//
// A version is trusted only while a conversation socket to the instance has stayed
// open since it was read: changing the gateway's version means restarting it, and a
// restart closes every socket. So a downgrade can never be hidden behind a remembered
// version (codex P2) — with no live socket there is nothing to trust, and the session
// connects without the capability and re-opens once the real version allows it.

interface Held {
  version: string;
  sockets: number;
}

const held = new Map<string, Held>();

/** The version a live socket to `instanceName` proves, or null. */
export function trustedGatewayVersion(instanceName: string): string | null {
  const h = held.get(instanceName);
  return h !== undefined && h.sockets > 0 ? h.version : null;
}

/**
 * A conversation socket to `instanceName` is open on `version`. Returns its release,
 * to call when that socket closes (idempotent). A different version replaces what was
 * held: the older sockets' releases then touch nothing.
 */
export function holdGatewayVersion(instanceName: string, version: string | null): () => void {
  if (typeof version !== "string" || version === "") return () => {};
  let h = held.get(instanceName);
  if (h === undefined || h.version !== version) {
    h = { version, sockets: 0 };
    held.set(instanceName, h);
  }
  const entry = h;
  entry.sockets += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.sockets -= 1;
    if (entry.sockets <= 0 && held.get(instanceName) === entry) held.delete(instanceName);
  };
}
