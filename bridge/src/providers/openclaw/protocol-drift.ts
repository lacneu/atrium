// Protocol DRIFT detector (Inc 2 of docs/design/protocol-contract.md).
//
// Observe-only: classifies inbound chat/agent event frames against the KNOWN
// per-version protocol surface and counts unknown payload fields — the
// early-warning for "the gateway was updated past what this bridge build
// understands" (the NAS updates OpenClaw before the bridge image). NEVER
// rejects or mutates a frame; unknown fields keep flowing exactly as before.
//
// SOC2: only protocol FIELD NAMES are counted/logged (schema vocabulary),
// never values, never conversation content.
//
// The known-field sets below are the vendored schema surface of the bridge's
// maxValidated gateway version. They are NOT hand-trusted: the protocol
// coverage ratchet test asserts a BIJECTION between these sets and the
// per-field entries of protocol/openclaw/coverage.json — which is itself
// ratcheted against the vendored TypeBox schemas. One chain, no drift:
//   vendored schema <-> coverage.json <-> these runtime sets.

export const DRIFT_VENDORED_VERSION = "2026.6.11";

/** Union of the four chat event schemas' top-level payload fields. */
export const KNOWN_CHAT_FIELDS: ReadonlySet<string> = new Set([
  // shared event base
  "runId",
  "sessionKey",
  "agentId",
  "spawnedBy",
  "seq",
  "state",
  // delta
  "message",
  "deltaText",
  "replace",
  "usage",
  // final / aborted / error extras
  "stopReason",
  "errorMessage",
  "errorKind",
]);

/** AgentEventSchema's top-level payload fields. */
export const KNOWN_AGENT_FIELDS: ReadonlySet<string> = new Set([
  "runId",
  "seq",
  "stream",
  "ts",
  "spawnedBy",
  "isHeartbeat",
  "data",
  // NOT in AgentEventSchema but present on every observed wire frame (the
  // gateway stamps the routing envelope onto agent events too — live capture
  // 2026-07-03); listed so a baseline install reports zero drift.
  "sessionKey",
  "sessionId",
  "agentId",
]);

export interface DriftEntry {
  /** `chat.<field>` or `agent.<field>` — schema vocabulary only. */
  shape: string;
  count: number;
}

// Bounds: a pathological gateway must not grow memory or spam logs.
const MAX_TRACKED_SHAPES = 100;

class ProtocolDriftRegistry {
  private counters = new Map<string, number>();
  private overflowed = false;

  /** Observe one raw inbound frame (chat/agent events only; anything else is
   *  outside the vendored surface and deliberately not judged). Never throws. */
  observe(frame: unknown): void {
    try {
      if (typeof frame !== "object" || frame === null) return;
      const f = frame as Record<string, unknown>;
      if (f.type !== "event") return;
      const known =
        f.event === "chat"
          ? KNOWN_CHAT_FIELDS
          : f.event === "agent"
            ? KNOWN_AGENT_FIELDS
            : null;
      if (known === null) return;
      const payload = f.payload;
      if (typeof payload !== "object" || payload === null) return;
      for (const key of Object.keys(payload as Record<string, unknown>)) {
        if (known.has(key)) continue;
        const shape = `${String(f.event)}.${key}`;
        const current = this.counters.get(shape);
        if (current === undefined) {
          if (this.counters.size >= MAX_TRACKED_SHAPES) {
            if (!this.overflowed) {
              this.overflowed = true;
              console.error(
                "[protocol-drift] tracked-shape cap reached — further NEW shapes uncounted (bound, not silence: this line is the signal)",
              );
            }
            continue;
          }
          // One log per NEW shape (field name only — never a value).
          console.log(
            `[protocol-drift] unknown protocol field: ${shape} (gateway newer than vendored ${DRIFT_VENDORED_VERSION}?)`,
          );
          this.counters.set(shape, 1);
        } else {
          this.counters.set(shape, current + 1);
        }
      }
    } catch {
      // Observe-only: a malformed frame must never break the feed path.
    }
  }

  /** Current drift, largest counts first (bounded by MAX_TRACKED_SHAPES). */
  report(): DriftEntry[] {
    return [...this.counters.entries()]
      .map(([shape, count]) => ({ shape, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Test seam. */
  resetForTests(): void {
    this.counters.clear();
    this.overflowed = false;
  }
}

/** Process-wide singleton: drift is a per-build observation, not per-session. */
export const protocolDrift = new ProtocolDriftRegistry();
