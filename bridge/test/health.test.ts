import { describe, expect, test } from "vitest";
import {
  HealthRegistry,
  gatewayHostOf,
  decayedState,
  ERROR_DECAY_MS,
  type TargetRef,
} from "../src/core/health.js";
import { BRIDGE_VERSION, PROTOCOL_VERSION } from "../src/compat.js";
import { enrichHealthSnapshot } from "../src/server.js";

const REF: TargetRef = {
  key: "u-testuser01",
  canonical: "u-testuser01",
  agentId: "main",
  gatewayHost: "192.0.2.10:18789",
};

describe("gatewayHostOf", () => {
  test("extracts host:port from a ws/wss/http url (no token)", () => {
    expect(gatewayHostOf("ws://192.0.2.10:18789")).toBe("192.0.2.10:18789");
    expect(gatewayHostOf("wss://gateway.example.org")).toBe("gateway.example.org");
  });
  test("degrades gracefully on a non-url", () => {
    expect(gatewayHostOf("not a url")).toBe("not a url");
  });
});

describe("HealthRegistry", () => {
  test("starts idle (no work attempted yet)", () => {
    const h = new HealthRegistry(1000, () => 2000);
    const snap = h.snapshot();
    expect(snap.status).toBe("ok");
    expect(snap.startedAt).toBe(1000);
    expect(snap.targets).toHaveLength(0); // nothing recorded -> no targets
  });

  test("recordOk -> connected with lastOkAt + counters", () => {
    let t = 5000;
    const h = new HealthRegistry(1000, () => t);
    h.recordOk(REF);
    const target = h.snapshot().targets[0]!;
    expect(target.state).toBe("connected");
    expect(target.lastOkAt).toBe(5000);
    expect(target.lastError).toBeNull();
    expect(target.okCount).toBe(1);
    expect(target.agentId).toBe("main"); // the REAL env agent, not a body claim
    expect(target.gatewayHost).toBe("192.0.2.10:18789");
  });

  test("recordError -> error with the curated code + when", () => {
    let t = 7000;
    const h = new HealthRegistry(1000, () => t);
    h.recordError(REF, "GATEWAY_DISCONNECTED");
    const target = h.snapshot().targets[0]!;
    expect(target.state).toBe("error");
    expect(target.lastError).toEqual({ code: "GATEWAY_DISCONNECTED", at: 7000 });
    expect(target.errorCount).toBe(1);
  });

  test("recordDownstreamReject -> stays connected (proves the bridge reached its gateway)", () => {
    const h = new HealthRegistry(1000, () => 8000);
    h.recordDownstreamReject(REF, "ATTACHMENT_REJECTED");
    const target = h.snapshot().targets[0]!;
    // The bridge link worked, so the target is healthy (green), NOT an error.
    expect(target.state).toBe("connected");
    expect(target.lastError).toBeNull(); // never a bridge error
    expect(target.errorCount).toBe(0); // and NOT counted as a bridge failure
    expect(target.lastDownstreamReject).toEqual({ code: "ATTACHMENT_REJECTED", at: 8000 });
    expect(target.downstreamRejectCount).toBe(1);
    expect(target.attempts).toBe(1);
    expect(target.okCount).toBe(0); // the message was not accepted, only attempted
  });

  // The exact production incident: re-sending the gateway's unparseable attachment
  // must leave the bridge GREEN, not paint it red.
  test("DISCRIMINATING: a downstream reject does NOT flip the bridge to error", () => {
    const h = new HealthRegistry(0, () => 1);
    h.recordDownstreamReject(REF, "ATTACHMENT_REJECTED");
    const reject = h.snapshot().targets[0]!;
    // Contrast with a real bridge-domain failure on a fresh target:
    const h2 = new HealthRegistry(0, () => 1);
    h2.recordError(REF, "GATEWAY_DISCONNECTED");
    const fail = h2.snapshot().targets[0]!;
    // Same input shape, OPPOSITE health outcome — the split must hold. If
    // recordDownstreamReject ever set state="error" this assertion would fail.
    expect(reject.state).toBe("connected");
    expect(fail.state).toBe("error");
    expect(reject.state).not.toBe(fail.state);
  });

  test("a downstream reject after a stale bridge error reflects RECOVERY (reached gateway again)", () => {
    let t = 1;
    const h = new HealthRegistry(0, () => t);
    h.recordError(REF, "GATEWAY_DISCONNECTED"); // the link was down
    t = 2;
    h.recordDownstreamReject(REF, "ATTACHMENT_REJECTED"); // now it reached the gateway
    const target = h.snapshot().targets[0]!;
    expect(target.state).toBe("connected"); // no longer red — the bridge recovered
    expect(target.lastError).toEqual({ code: "GATEWAY_DISCONNECTED", at: 1 }); // history kept
    expect(target.errorCount).toBe(1);
    expect(target.downstreamRejectCount).toBe(1);
    expect(target.attempts).toBe(2);
  });

  test("a later clean send CLEARS the downstream note (it is not a stale log)", () => {
    let t = 1;
    const h = new HealthRegistry(0, () => t);
    h.recordDownstreamReject(REF, "ATTACHMENT_REJECTED");
    expect(h.snapshot().targets[0]!.lastDownstreamReject).not.toBeNull();
    t = 2;
    h.recordOk(REF); // the next send succeeds -> the note is stale
    const target = h.snapshot().targets[0]!;
    expect(target.lastDownstreamReject).toBeNull(); // cleared, not lingering
    expect(target.downstreamRejectCount).toBe(1); // cumulative count is history, kept
    expect(target.okCount).toBe(1);
  });

  test("a later BRIDGE error also clears the downstream note (one current truth)", () => {
    let t = 1;
    const h = new HealthRegistry(0, () => t);
    h.recordDownstreamReject(REF, "ATTACHMENT_REJECTED");
    t = 2;
    h.recordError(REF, "GATEWAY_DISCONNECTED"); // now the link itself fails
    const target = h.snapshot().targets[0]!;
    expect(target.state).toBe("error");
    expect(target.lastDownstreamReject).toBeNull(); // the reject note is no longer the truth
    expect(target.lastError).toEqual({ code: "GATEWAY_DISCONNECTED", at: 2 });
  });

  test("a later OK clears the state to connected (recovery), keeping history counts", () => {
    let t = 1;
    const h = new HealthRegistry(0, () => t);
    h.recordError(REF, "GATEWAY_TIMEOUT");
    t = 2;
    h.recordOk(REF);
    const target = h.snapshot().targets[0]!;
    expect(target.state).toBe("connected");
    expect(target.lastOkAt).toBe(2);
    expect(target.lastError).toEqual({ code: "GATEWAY_TIMEOUT", at: 1 }); // history kept
    expect(target.attempts).toBe(2);
    expect(target.okCount).toBe(1);
    expect(target.errorCount).toBe(1);
  });

  test("one target per key (mono-tenant collapses to a single row)", () => {
    const h = new HealthRegistry(0, () => 1);
    h.recordError(REF, "X");
    h.recordError(REF, "Y");
    h.recordOk(REF);
    expect(h.snapshot().targets).toHaveLength(1);
    expect(h.snapshot().targets[0]!.attempts).toBe(3);
  });

  test("a rebind (same canonical key, NEW agentId) resets the target's per-agent state", () => {
    let t = 1;
    const h = new HealthRegistry(0, () => t);
    // Agent "main" fails (e.g. deleted -> AGENT_NOT_FOUND) a few times.
    h.recordError(REF, "AGENT_NOT_FOUND");
    t = 2;
    h.recordError(REF, "AGENT_NOT_FOUND");
    // The chat is rebound to a new default agent: same per-user canonical key,
    // different agentId. The stale "main" + its errors must NOT carry over.
    t = 3;
    h.recordOk({ ...REF, agentId: "assistant" });
    const target = h.snapshot().targets[0]!;
    expect(h.snapshot().targets).toHaveLength(1); // still keyed by canonical
    expect(target.agentId).toBe("assistant"); // label refreshed to the new agent
    expect(target.state).toBe("connected");
    expect(target.lastError).toBeNull(); // old agent's error cleared
    expect(target.okCount).toBe(1); // fresh window for the new agent
    expect(target.errorCount).toBe(0); // "main"'s 2 errors did NOT carry over
    expect(target.attempts).toBe(1);
  });

  test("the same agentId does NOT reset counters (only a real rebind does)", () => {
    const h = new HealthRegistry(0, () => 1);
    h.recordError(REF, "X");
    h.recordOk(REF); // same agentId -> history preserved
    const target = h.snapshot().targets[0]!;
    expect(target.attempts).toBe(2);
    expect(target.errorCount).toBe(1);
    expect(target.okCount).toBe(1);
  });

  // A stale one-off error must not be reported as a current error forever.
  test("snapshot decays a stale 'error' to 'idle' after ERROR_DECAY_MS of inactivity", () => {
    let t = 1000;
    const h = new HealthRegistry(0, () => t);
    h.recordError(REF, "INVALID_REQUEST"); // errors at t=1000
    // Just before the decay window: still error.
    t = 1000 + ERROR_DECAY_MS;
    expect(h.snapshot().targets[0]!.state).toBe("error");
    // Past the window with no new attempt: decays to idle (history preserved).
    t = 1000 + ERROR_DECAY_MS + 1;
    const decayed = h.snapshot().targets[0]!;
    expect(decayed.state).toBe("idle");
    expect(decayed.lastError).toEqual({ code: "INVALID_REQUEST", at: 1000 }); // history kept
    expect(decayed.errorCount).toBe(1);
  });

  test("a fresh attempt resets the decay clock (an actively-failing agent stays 'error')", () => {
    let t = 0;
    const h = new HealthRegistry(0, () => t);
    h.recordError(REF, "X");
    t = ERROR_DECAY_MS - 1;
    h.recordError(REF, "X"); // re-exercised just before decay -> clock resets
    t = ERROR_DECAY_MS + 1; // would have decayed off the FIRST error, but not the second
    expect(h.snapshot().targets[0]!.state).toBe("error");
  });
});

describe("decayedState (pure)", () => {
  const NOW = 1_000_000;
  test("non-error states are returned unchanged", () => {
    expect(decayedState("connected", NOW - 10 * ERROR_DECAY_MS, NOW)).toBe("connected");
    expect(decayedState("idle", null, NOW)).toBe("idle");
  });
  test("error within the window stays error; past it decays to idle", () => {
    expect(decayedState("error", NOW - (ERROR_DECAY_MS - 1), NOW)).toBe("error");
    expect(decayedState("error", NOW - (ERROR_DECAY_MS + 1), NOW)).toBe("idle");
  });
  test("error with no recorded attempt time is left as error (cannot age it)", () => {
    expect(decayedState("error", null, NOW)).toBe("error");
  });
});

describe("enrichHealthSnapshot (additive compat fields)", () => {
  test("preserves every legacy field and adds bridge/protocol versions", () => {
    const h = new HealthRegistry(1000, () => 2000);
    h.recordOk(REF);
    const plain = h.snapshot();
    const enriched = enrichHealthSnapshot(plain, []);
    // Top-level legacy fields are untouched (the Convex poller's contract).
    expect(enriched.status).toBe(plain.status);
    expect(enriched.startedAt).toBe(plain.startedAt);
    expect(enriched.now).toBe(plain.now);
    expect(enriched.bridgeVersion).toBe(BRIDGE_VERSION);
    expect(enriched.protocolVersion).toBe(PROTOCOL_VERSION);
    // Per-target: every legacy field intact + the additive gatewayVersion.
    const before = plain.targets[0]!;
    const after = enriched.targets[0]!;
    expect(after).toEqual({ ...before, gatewayVersion: null });
  });

  test("maps gatewayVersion from the live session sharing the canonical", () => {
    const h = new HealthRegistry(0, () => 1);
    h.recordOk(REF);
    h.recordOk({ ...REF, key: "u-bob", canonical: "u-bob" });
    const enriched = enrichHealthSnapshot(h.snapshot(), [
      { canonical: "u-testuser01", agentId: "main", gatewayVersion: "2026.6.5" },
    ]);
    const byKey = new Map(enriched.targets.map((t) => [t.key, t]));
    expect(byKey.get("u-testuser01")!.gatewayVersion).toBe("2026.6.5");
    // No live session for that canonical -> honestly unknown.
    expect(byKey.get("u-bob")!.gatewayVersion).toBeNull();
  });
});
