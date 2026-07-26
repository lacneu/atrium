// The GRADUATED pre-send guard (W2 / G-04, G-06).
//
// The tests that matter are NOT "it blocks at 97%". They are the three that prove
// the guard cannot cost a turn that would have succeeded (P6) — because the worst
// possible outcome of this lot is refusing a send the gateway would have answered.

import { describe, expect, it } from "vitest";
import {
  classifyGatewayError,
  faultDomain,
} from "../src/core/dispatch-errors.js";
import {
  isPermanentCompactionRefusal,
  isTransientCompactionRefusal,
} from "../src/core/compaction-verdict.js";
import {
  ContextBlockedError,
  FILL_BLOCK,
  FILL_COMPACT,
  FILL_INFORM,
  presendAction,
  requiresCompaction,
  sendAfterCompaction,
} from "../src/core/presend-guard.js";

const at = (fill: number | null, extra: Record<string, unknown> = {}) =>
  presendAction({ fill, alreadyCompacted: false, ...extra });

describe("presendAction: the graduated ladder", () => {
  it("says nothing below the information threshold", () => {
    expect(at(0)).toBe("send");
    expect(at(FILL_INFORM)).toBe("send");
  });

  it("informs between 70% and 85%, and still SENDS", () => {
    expect(at(0.8)).toBe("send_warn");
    expect(requiresCompaction(at(0.8))).toBe(false);
  });

  it("compacts pre-emptively between 85% and 95%, and still SENDS", () => {
    expect(at(0.9)).toBe("compact_then_send");
    expect(requiresCompaction(at(0.9))).toBe(true);
    // The distinction that matters: this tier can never withhold the send.
    expect(
      sendAfterCompaction({
        action: at(0.9),
        compacted: false,
        attemptFailed: false,
      }),
    ).toBe(true);
  });

  it("beyond 95%, a compaction is MANDATORY and its failure withholds the send", () => {
    expect(at(0.97)).toBe("compact_or_block");
    expect(
      sendAfterCompaction({
        action: at(0.97),
        compacted: false,
        attemptFailed: false,
      }),
    ).toBe(false);
  });

  it("the gateway's overflow figure stands ALONE, with no fill at all", () => {
    // Reviewed and kept: this is the explicit positive measurement, computed by the
    // gateway against its own budget. Requiring our derived ratio to corroborate it
    // would disarm the guard on precisely the sessions whose counters are missing.
    expect(at(null, { overflowTokens: 4_000 })).toBe("compact_or_block");
  });

  it("the gateway's OWN overflow figure outranks the computed ratio", () => {
    // A comfortable-looking fill with `overflowTokens > 0` is the 2026-07-20
    // case: the counters said 96% of the window while the assembled prompt was
    // at 117% of the budget the gateway actually had.
    expect(at(0.4, { overflowTokens: 50_960 })).toBe("compact_or_block");
  });
});

describe("P6: the guard can never cost a turn that would have succeeded", () => {
  it("a SUCCESSFUL compaction lets the send through", () => {
    expect(
      sendAfterCompaction({
        action: "compact_or_block",
        compacted: true,
        attemptFailed: false,
      }),
    ).toBe(true);
  });

  it("a compaction attempt that ERRORS lets the send through (unknown ⇒ send)", () => {
    // We do not know the session did not shrink. Paying for our own uncertainty
    // with the user's turn is exactly the failure this rule forbids.
    expect(
      sendAfterCompaction({
        action: "compact_or_block",
        compacted: false,
        attemptFailed: true,
      }),
    ).toBe(true);
  });

  it("an UNKNOWN fill never blocks and never compacts", () => {
    for (const f of [null, Number.NaN]) {
      expect(at(f)).toBe("send");
      expect(requiresCompaction(at(f))).toBe(false);
    }
  });

  it("an absurd or absent overflow figure never blocks", () => {
    expect(at(0.1, { overflowTokens: Number.NaN })).toBe("send");
    expect(at(0.1, { overflowTokens: 0 })).toBe("send");
    expect(at(0.1, { overflowTokens: null })).toBe("send");
    expect(at(0.1, { overflowTokens: -5 })).toBe("send");
  });

  it("ONE attempt per turn: after a compaction, the turn always sends", () => {
    // Otherwise a still-overfull session becomes a dead end: the user's message
    // could never leave, however many times they tried.
    expect(
      presendAction({ fill: 0.99, alreadyCompacted: true }),
    ).toBe("send");
    expect(
      presendAction({ fill: 0.99, overflowTokens: 90_000, alreadyCompacted: true }),
    ).toBe("send");
  });

  it("the thresholds are ordered (a misordered ladder would block early)", () => {
    expect(FILL_INFORM).toBeLessThan(FILL_COMPACT);
    expect(FILL_COMPACT).toBeLessThan(FILL_BLOCK);
    expect(FILL_BLOCK).toBeLessThan(1);
  });
});

describe("the withheld send is a classified dispatch failure", () => {
  it("classifies by TYPE, to a code distinct from the gateway's own overflow", () => {
    // By type, never by text: a decision we made must not depend on how we phrased
    // it. And a DISTINCT code, because "we did not send it" is a different fact
    // from "the gateway overflowed mid-turn" — nothing ran and nothing was billed.
    expect(classifyGatewayError(new ContextBlockedError(97))).toBe(
      "context_length_presend",
    );
    expect(classifyGatewayError(new ContextBlockedError(null))).toBe(
      "context_length_presend",
    );
  });

  it("never paints the BRIDGE unhealthy: the link and the credentials worked", () => {
    expect(faultDomain("context_length_presend")).toBe("downstream");
  });

  it("says the fill when it has one, and stays silent when it does not", () => {
    expect(new ContextBlockedError(97).message).toContain("97%");
    expect(new ContextBlockedError(null).message).not.toContain("%");
  });
});

describe("a BUSY session never withholds the send (the snapshot race)", () => {
  it("a transient refusal sends; a structural one withholds", () => {
    // `busy` is read BEFORE the compaction's await, so a run can start inside that
    // window and the gateway answers "already active". Blocking there would
    // withhold a turn on a fact about to stop being true — and the running thing
    // may itself be a compaction that is shrinking the session.
    const base = {
      action: "compact_or_block" as const,
      compacted: false,
      attemptFailed: false,
    };
    expect(sendAfterCompaction({ ...base, transientRefusal: true })).toBe(true);
    expect(sendAfterCompaction({ ...base, transientRefusal: false })).toBe(false);
  });

  it("only 'already active/in flight' is transient", () => {
    // An unsupported harness or a missing transcript are refusals too, but they are
    // not "not right now" — treating them as transient would never withhold at all.
    expect(isTransientCompactionRefusal("already_active")).toBe(true);
    expect(isTransientCompactionRefusal("already_in_flight")).toBe(true);
    for (const r of [
      "no transcript",
      "no sessionId",
      "unsupported_harness_compaction",
      "deferred_compaction_not_scheduled",
      "other",
      null,
    ]) {
      expect(isTransientCompactionRefusal(r), String(r)).toBe(false);
    }
  });

  it("only an unsupported HARNESS is remembered across turns", () => {
    expect(isPermanentCompactionRefusal("unsupported_harness_compaction")).toBe(
      true,
    );
    for (const r of [
      "already_active",
      "no transcript",
      "no sessionId",
      "deferred_compaction_not_scheduled",
      "other",
      null,
    ]) {
      expect(isPermanentCompactionRefusal(r), String(r)).toBe(false);
    }
  });
});
