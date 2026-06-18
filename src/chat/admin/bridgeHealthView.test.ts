import { describe, expect, test } from "vitest";
import {
  bridgeErrorTargets,
  isBridgeHealthy,
  showsBridgeErrorDetail,
  showsDownstreamReject,
  type BridgeTargetView,
} from "./bridgeHealthView";

// Render decisions for the Bridge tab. The whole point of the fix is DISPLAY
// honesty: the bridge must look green when it works (even if a message was
// rejected downstream) and red only when the bridge itself can't reach its
// gateway. These tests pin that mapping so the JSX can't silently regress.

// A current bridge-domain failure (the bridge can't reach/auth its gateway).
const bridgeError: BridgeTargetView = {
  state: "error",
  lastErrorCode: "GATEWAY_DISCONNECTED",
  lastDownstreamRejectCode: null,
};
// The PRODUCTION incident: the gateway refused an attachment; the bridge stayed
// connected. Must read as healthy + a neutral note, NOT red.
const downstreamReject: BridgeTargetView = {
  state: "connected",
  lastErrorCode: null,
  lastDownstreamRejectCode: "ATTACHMENT_REJECTED",
};
// A recovered target that still carries a STALE bridge error in history.
const recoveredWithStaleError: BridgeTargetView = {
  state: "connected",
  lastErrorCode: "GATEWAY_TIMEOUT",
  lastDownstreamRejectCode: null,
};
// A stale error that decayed to idle (no recent attempt).
const decayedToIdle: BridgeTargetView = {
  state: "idle",
  lastErrorCode: "GATEWAY_TIMEOUT",
  lastDownstreamRejectCode: null,
};

describe("bridgeErrorTargets / isBridgeHealthy", () => {
  test("a current bridge-domain error counts (red banner)", () => {
    expect(bridgeErrorTargets([bridgeError])).toHaveLength(1);
    expect(isBridgeHealthy({ reachable: true, targets: [bridgeError] })).toBe(false);
  });

  test("the production case: a downstream reject does NOT count — bridge stays healthy", () => {
    expect(bridgeErrorTargets([downstreamReject])).toHaveLength(0);
    expect(isBridgeHealthy({ reachable: true, targets: [downstreamReject] })).toBe(true);
  });

  test("a recovered target with a STALE error code does NOT count (not red)", () => {
    expect(bridgeErrorTargets([recoveredWithStaleError])).toHaveLength(0);
    expect(
      isBridgeHealthy({ reachable: true, targets: [recoveredWithStaleError] }),
    ).toBe(true);
  });

  test("a decayed (idle) target does NOT count", () => {
    expect(bridgeErrorTargets([decayedToIdle])).toHaveLength(0);
  });

  test("unreachable bridge is never healthy, even with zero error targets", () => {
    expect(isBridgeHealthy({ reachable: false, targets: [] })).toBe(false);
    expect(isBridgeHealthy({ reachable: false, targets: [downstreamReject] })).toBe(false);
  });

  test("counts only the bridge-domain errors among a mix", () => {
    const targets = [bridgeError, downstreamReject, recoveredWithStaleError, decayedToIdle];
    expect(bridgeErrorTargets(targets)).toEqual([bridgeError]);
    expect(isBridgeHealthy({ reachable: true, targets })).toBe(false);
  });
});

describe("showsBridgeErrorDetail (the red block gate)", () => {
  test("true only for a CURRENT bridge-domain error", () => {
    expect(showsBridgeErrorDetail(bridgeError)).toBe(true);
  });

  // The advisor-flagged regression: a connected target carrying a stale error
  // must NOT render the red block. Gating on lastErrorCode alone would break this.
  test("DISCRIMINATING: a recovered target with a stale error code shows NO red block", () => {
    expect(showsBridgeErrorDetail(recoveredWithStaleError)).toBe(false);
    // Sanity: it DOES still carry the code (history) — we just don't render it red.
    expect(recoveredWithStaleError.lastErrorCode).not.toBeNull();
  });

  test("a downstream reject shows NO red block", () => {
    expect(showsBridgeErrorDetail(downstreamReject)).toBe(false);
  });

  test("an idle (decayed) target shows NO red block", () => {
    expect(showsBridgeErrorDetail(decayedToIdle)).toBe(false);
  });
});

describe("showsDownstreamReject (the neutral note)", () => {
  test("true for a downstream reject, false for a bridge error", () => {
    expect(showsDownstreamReject(downstreamReject)).toBe(true);
    expect(showsDownstreamReject(bridgeError)).toBe(false);
  });

  // OPPOSITE outcomes from the same render: the reject is neutral, the error is red.
  test("DISCRIMINATING: a reject and a bridge error never both render red", () => {
    expect(showsBridgeErrorDetail(downstreamReject)).toBe(false);
    expect(showsDownstreamReject(downstreamReject)).toBe(true);
    expect(showsBridgeErrorDetail(bridgeError)).toBe(true);
    expect(showsDownstreamReject(bridgeError)).toBe(false);
  });

  test("absent field (pre-this-release bridge) -> no note", () => {
    expect(showsDownstreamReject({ state: "connected", lastErrorCode: null })).toBe(false);
  });
});
