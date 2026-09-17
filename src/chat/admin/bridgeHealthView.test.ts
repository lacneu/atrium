import { describe, expect, test } from "vitest";
import {
  bridgeErrorTargets,
  isBridgeHealthy,
  showsBridgeErrorDetail,
  showsDownstreamReject,
  showsDetailRow,
  showsLocalRefusal,
  type BridgeTargetView,
  bridgeVerdict,
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
// The BRIDGE refused the request itself, before sending (an attachment it could
// not place on the instance's shared volume). Live prod 2026-09-17.
const localRefusal: BridgeTargetView = {
  state: "connected",
  lastErrorCode: null,
  lastDownstreamRejectCode: null,
  lastLocalRefusalCode: "attachment_path_refused",
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

describe("bridgeVerdict (three-state header)", () => {
  const t = (state: string) => ({ state, lastErrorCode: null });
  test("ok: bridge reachable, no target error, all gateways polling fine", () => {
    expect(
      bridgeVerdict({ reachable: true, targets: [t("connected")], unreachableInstances: [] }),
    ).toBe("ok");
  });
  test("gateways_unreachable: the bridge process is fine but a gateway is transport-down (backup) — must NOT read operational", () => {
    expect(
      bridgeVerdict({
        reachable: true,
        targets: [],
        unreachableInstances: ["primary"],
      }),
    ).toBe("gateways_unreachable");
  });
  test("error wins over gateway state (bridge down / target error)", () => {
    expect(
      bridgeVerdict({ reachable: false, targets: [], unreachableInstances: ["a"] }),
    ).toBe("error");
    expect(
      bridgeVerdict({ reachable: true, targets: [t("error")], unreachableInstances: [] }),
    ).toBe("error");
  });
  test("a pre-this-release payload (no field) degrades to the two-state verdict", () => {
    expect(bridgeVerdict({ reachable: true, targets: [] })).toBe("ok");
  });
});

describe("a LOCAL refusal is not a gateway rejection", () => {
  test("it shows its own note and never the gateway's", () => {
    // The card's downstream line reads "rejected by the gateway". Folded in
    // there, a refusal the bridge took itself — before any send — would put that
    // sentence under a gateway that never saw the request (codex).
    expect(showsLocalRefusal(localRefusal)).toBe(true);
    expect(showsDownstreamReject(localRefusal)).toBe(false);
    expect(showsBridgeErrorDetail(localRefusal)).toBe(false);
    // And the reverse: a real gateway rejection is not a local refusal.
    expect(showsLocalRefusal(downstreamReject)).toBe(false);
    expect(showsDownstreamReject(downstreamReject)).toBe(true);
  });

  test("and the row that CARRIES it is actually rendered", () => {
    // The note was computed from the helper and then dropped with the sub-row,
    // whose condition asked only for an error or a downstream reject — so a lone
    // local refusal rendered nothing at all (codex P1). The helper alone could
    // not see that; the enclosing question has to be asked here too.
    expect(showsDetailRow(localRefusal)).toBe(true);
    expect(showsDetailRow(bridgeError)).toBe(true);
    expect(showsDetailRow(downstreamReject)).toBe(true);
    expect(showsDetailRow(decayedToIdle)).toBe(false);
  });

  test("and it leaves bridge health alone", () => {
    expect(bridgeErrorTargets([localRefusal])).toHaveLength(0);
    expect(isBridgeHealthy({ reachable: true, targets: [localRefusal] })).toBe(
      true,
    );
  });
});
