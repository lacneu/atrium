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

// An `error` state only clears on the next SUCCESSFUL send (recordOk). If an agent
// errors once and is never retried, it would otherwise show `error` forever — a
// stale, misleading signal (and, before the Convex gate was scoped to bridge
// reachability, the source of a global-readonly deadlock). Decay a stale error to
// `idle` after this much inactivity (no new attempt) so the last-known state stops
// lying once the failing turn is well in the past. Read-time only — the underlying
// `lastError`/counters are preserved for history.
export const ERROR_DECAY_MS = 5 * 60 * 1000;

/** Project a target's reported state at read time: a stale `error` (no attempt for
 *  ERROR_DECAY_MS) decays to `idle`. Pure + exported for unit tests. */
export function decayedState(state: TargetState, lastAttemptAt: number | null, now: number): TargetState {
  if (state === "error" && lastAttemptAt !== null && now - lastAttemptAt > ERROR_DECAY_MS) {
    return "idle";
  }
  return state;
}

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
  /** Last BRIDGE-domain failure (curated non-PHI code) + when — the bridge could
   *  not reach/authenticate its gateway. This is what drives the `error` state. */
  lastError: { code: string; at: number } | null;
  /** Last DOWNSTREAM rejection (the gateway received + refused the request) + when.
   *  NOT a bridge-health failure: recorded for the health view's neutral note, but
   *  it NEVER sets `state` to `error` (Traces + Anomalies carry the detail/alert). */
  lastDownstreamReject: { code: string; at: number } | null;
  lastAttemptAt: number | null;
  attempts: number;
  okCount: number;
  errorCount: number;
  /** Count of downstream rejections (distinct from errorCount = bridge-domain). */
  downstreamRejectCount: number;
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
        lastDownstreamReject: null,
        lastAttemptAt: null,
        attempts: 0,
        okCount: 0,
        errorCount: 0,
        downstreamRejectCount: 0,
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
      h.lastDownstreamReject = null;
      h.lastAttemptAt = null;
      h.attempts = 0;
      h.okCount = 0;
      h.errorCount = 0;
      h.downstreamRejectCount = 0;
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
    // The latest outcome is a clean success, so any prior downstream-reject note
    // is stale — clear it (the durable history belongs to Traces, not here).
    h.lastDownstreamReject = null;
    h.lastAttemptAt = now;
    h.attempts += 1;
    h.okCount += 1;
  }

  /** A send failed because the BRIDGE could not reach/authenticate its gateway
   *  (`code` is a bridge-domain classification). Flips the target to `error`. */
  recordError(ref: TargetRef, code: string): void {
    const h = this.ensure(ref);
    const now = this.clock();
    h.state = "error";
    h.lastError = { code, at: now };
    // The latest outcome is a bridge-domain failure, not a downstream reject —
    // clear the stale note so the card shows one current truth.
    h.lastDownstreamReject = null;
    h.lastAttemptAt = now;
    h.attempts += 1;
    h.errorCount += 1;
  }

  /** A send reached the gateway, which REJECTED the request downstream (a missing
   *  agent, a bad/oversized attachment, a refused request shape, an upstream agent
   *  error). The bridge's link worked, so this PROVES connectivity: the target
   *  becomes `connected` and bridge health stays green. The rejection is recorded
   *  for the health view's neutral note + counter, but is NEVER a bridge `error`
   *  and does NOT touch `lastError`/`errorCount` (Traces + Anomalies own the
   *  detail/alerting). See `faultDomain` in dispatch-errors. */
  recordDownstreamReject(ref: TargetRef, code: string): void {
    const h = this.ensure(ref);
    const now = this.clock();
    h.state = "connected";
    h.lastDownstreamReject = { code, at: now };
    h.lastAttemptAt = now;
    h.attempts += 1;
    h.downstreamRejectCount += 1;
  }

  /** A TURN failed AFTER its send was accepted (the gateway ACKed chat.send —
   *  recordOk already counted the attempt — then the run errored: a session-init
   *  conflict, a provider failure, an empty response…). Downstream-domain like
   *  recordDownstreamReject (connectivity was PROVEN by the ack, so `state` and
   *  the bridge-error counters stay untouched — the anti-deadlock rule), but it
   *  bumps NO attempt (the send was already counted once). Without this, a user's
   *  errored turns were invisible in the admin stats line ("0 échec(s)" while the
   *  chat showed two error cards — report 2026-07-09). Takes the full ref (same
   *  trust as recordOk/recordDownstreamReject): a Hermes turn can finalize its
   *  error BEFORE the /send handler's recordOk creates the row (codex P2), so
   *  the row is ensured here — state is left as-is (ensure() creates it idle;
   *  only an ACKed send may claim `connected`). */
  recordTurnError(ref: TargetRef, code: string): void {
    const h = this.ensure(ref);
    h.lastDownstreamReject = { code, at: this.clock() };
    h.downstreamRejectCount += 1;
  }

  snapshot(): HealthSnapshot {
    const now = this.clock();
    return {
      status: "ok",
      startedAt: this.startedAt,
      now,
      // Project a stale `error` down to `idle` so a long-past one-off failure stops
      // being reported as a current error (read-time only; history is preserved).
      targets: [...this.targets.values()].map((h) => ({
        ...h,
        state: decayedState(h.state, h.lastAttemptAt, now),
      })),
    };
  }
}
