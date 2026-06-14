// Bridge health registry — the source of truth for "can the bridge actually
// reach its gateway, and if not, why".
//
// The bridge is LAZY + mono-tenant: at rest it holds zero sockets, so a probe
// that only does a connect `hello-ok` would report "connected" even when the
// configured agent does not exist (that surfaces only at `chat.send`). So instead
// of probing, we track the outcome of the REAL work: every `/send` records ok or
// a classified error CODE against the target. `/health` reports that last-known
// state per target — which is exactly "the connections it was given that it is
// having trouble with". Non-PHI: codes + non-secret host only, never tokens.

export type TargetState = "idle" | "connected" | "error";

export interface TargetHealth {
  /** Stable key for the target (mono-tenant: the operator canonical). */
  key: string;
  /** Convex routing instance name, learned from the /send body (label only). */
  instanceName: string | null;
  /** Operator canonical the bridge actually sends as (from bridge env). */
  canonical: string;
  /** Agent id the bridge ACTUALLY uses (bridge env) — not the body's claim. */
  agentId: string;
  /** Non-secret gateway host:port (never the token / device identity). */
  gatewayHost: string;
  state: TargetState;
  lastOkAt: number | null;
  /** Last classified failure (curated non-PHI code) + when. */
  lastError: { code: string; at: number } | null;
  lastAttemptAt: number | null;
  attempts: number;
  okCount: number;
  errorCount: number;
}

export interface HealthSnapshot {
  /** The process answered, so it is at least up. */
  status: "ok";
  startedAt: number;
  now: number;
  targets: TargetHealth[];
}

export interface TargetRef {
  key: string;
  canonical: string;
  agentId: string;
  gatewayHost: string;
  instanceName?: string | null;
}

/** Extract a non-secret host:port from a gateway URL (ws/wss/http/https). */
export function gatewayHostOf(gatewayUrl: string): string {
  try {
    return new URL(gatewayUrl).host || gatewayUrl;
  } catch {
    return gatewayUrl;
  }
}

export class HealthRegistry {
  private readonly targets = new Map<string, TargetHealth>();

  constructor(
    private readonly startedAt: number,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private ensure(ref: TargetRef): TargetHealth {
    let h = this.targets.get(ref.key);
    if (h === undefined) {
      h = {
        key: ref.key,
        instanceName: ref.instanceName ?? null,
        canonical: ref.canonical,
        agentId: ref.agentId,
        gatewayHost: ref.gatewayHost,
        state: "idle",
        lastOkAt: null,
        lastError: null,
        lastAttemptAt: null,
        attempts: 0,
        okCount: 0,
        errorCount: 0,
      };
      this.targets.set(ref.key, h);
      return h;
    }
    // The key is the per-user operator `canonical` (mono-tenant), but the AGENT
    // bound to it can change (a rebind: the bound agent was deleted -> the next
    // send routes to a new default agentId). When that happens the health story
    // is a DIFFERENT agent's: refresh the label AND reset the per-agent
    // counters/state/lastError, so /health + the admin tab don't attribute the
    // new agent's outcomes to the old id (or show the old agent's error against
    // an agent that now works). Safe: these counters are in-memory and already
    // reset on a bridge restart, so no consumer depends on cross-rebind
    // monotonicity (bridgeHealth gating keys on `state`, not the counts).
    if (ref.agentId !== h.agentId) {
      h.agentId = ref.agentId;
      h.gatewayHost = ref.gatewayHost;
      h.state = "idle";
      h.lastOkAt = null;
      h.lastError = null;
      h.lastAttemptAt = null;
      h.attempts = 0;
      h.okCount = 0;
      h.errorCount = 0;
    }
    // Keep the (non-secret) label fresh if a later send learned the instance name.
    if (ref.instanceName) h.instanceName = ref.instanceName;
    return h;
  }

  /** A send (or connect) succeeded against this target. */
  recordOk(ref: TargetRef): void {
    const h = this.ensure(ref);
    const now = this.clock();
    h.state = "connected";
    h.lastOkAt = now;
    h.lastAttemptAt = now;
    h.attempts += 1;
    h.okCount += 1;
  }

  /** A send (or connect) failed; `code` is the curated classification. */
  recordError(ref: TargetRef, code: string): void {
    const h = this.ensure(ref);
    const now = this.clock();
    h.state = "error";
    h.lastError = { code, at: now };
    h.lastAttemptAt = now;
    h.attempts += 1;
    h.errorCount += 1;
  }

  snapshot(): HealthSnapshot {
    return {
      status: "ok",
      startedAt: this.startedAt,
      now: this.clock(),
      targets: [...this.targets.values()],
    };
  }
}
