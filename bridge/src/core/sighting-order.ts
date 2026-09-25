// The order in which THIS bridge process saw agent requests — the tie-break Convex uses
// when a provider reuses a request id and its own creation time does not advance
// (convex/agentRequests.ts `upsertFromBridge`). Kept out of core/agent-requests.ts, which
// is pure (no clock, no I/O).

import { randomUUID } from "node:crypto";

/** This bridge process — PROVENANCE of a sighting (which process saw it), never an order:
 *  two processes run side by side during a rolling deploy, so another process's sighting
 *  is not later by construction (codex P2, 0.21.5 pass 19). */
export const SIGHTING_EPOCH: string = randomUUID();
let lastSightingSeq = 0;
/**
 * The order in which requests were SEEN: the wall clock (×1000), strictly increasing within
 * this process — the one order two bridge processes share. A late, retried write carries
 * the seq of its own sighting, so it can never pass for a newer one; a request seen later
 * always can, whatever its provider clock says.
 */
export function nextSightingSeq(): number {
  lastSightingSeq = Math.max(lastSightingSeq + 1, Date.now() * 1000);
  return lastSightingSeq;
}
