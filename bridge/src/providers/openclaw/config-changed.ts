// `config.changed` — the gateway's notice that a config revision was persisted.
//
// Pure reader, the shape of `readShutdownNotice` (connection-end.ts): the receive loop
// holds one line, and the payload coercion lives here where a test can pin it against
// the frame the gateway really sends. Broadcast on EVERY persisted config change —
// RPC writes, `config_set`, doctor repairs, hand edits of the file alike — from one
// upstream site (server-reload-managed.ts, onConfigCandidateCommitted), present since
// v2026.7.2-beta.5, READ-scoped, and sent with `dropIfSlow: true`: a client whose
// socket buffer is over the limit does not receive it, and its envelope `seq` is
// consumed so the client's gap detector fires. Observed on the wire at v2026.9.1:
//   {type:"event",event:"config.changed",payload:{path:"<file>",hash:"hmac-sha256:v1:…",ts:<ms>},seq:n}
// NOT announced in `hello-ok.features.events` (absent from GATEWAY_EVENTS) — it is a
// broadcast-only family, classified under `broadcastOnly` in the events manifest.

import { eventPayload } from "./connection-end.js";

/** What Atrium reads of the notice: the revision hash, for the log line that names a
 *  refresh. `path` (a host filesystem path) and `ts` (the gateway's clock) are on the
 *  wire and read by nobody — not carried. */
export interface ConfigChangedNotice {
  /** The projected revision hash — differs for every persisted revision (null when
   *  the gateway could not project one). */
  hash: string | null;
}

/** The notice carried by an inbound frame, or null for any other frame. Shape-checked,
 *  never trusted: the gateway version is not consulted, because the emitter is the same
 *  from v2026.7.2-beta.5 through v2026.9.1 and a gateway older than that never sends it. */
export function readConfigChanged(frame: unknown): ConfigChangedNotice | null {
  const payload = eventPayload(frame, "config.changed");
  if (payload === null) return null;
  return { hash: typeof payload.hash === "string" ? payload.hash : null };
}
