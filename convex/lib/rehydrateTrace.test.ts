import { describe, expect, it } from "vitest";
import {
  rehydrateTraceMeta,
  shouldReportRehydrateMissed,
  type RehydrateTraceInput,
} from "./rehydrateTrace";

const base: RehydrateTraceInput = {
  decision: "rehydrate",
  freshSession: true,
  routedSwitch: true,
  prependedTurns: 2,
  routedAgentId: "denis",
  routedInstanceName: "ataraxis",
  switchedFromAgentId: "jerome",
  switchedFromInstanceName: "ataraxis",
};

describe("rehydrateTraceMeta — content-free", () => {
  it("carries ONLY enums/scalars/agent names — never free text", () => {
    const meta = rehydrateTraceMeta(base);
    // The exact allowlisted key set — a content-free contract. If someone adds a
    // free-text field (prompt/history), this fails.
    expect(new Set(Object.keys(meta))).toEqual(
      new Set([
        "op",
        "decision",
        "freshSession",
        "routedSwitch",
        "prependedTurns",
        "routedAgentId",
        "routedInstanceName",
        "switchedFromAgentId",
        "switchedFromInstanceName",
      ]),
    );
    // Every value is a primitive (string | number | boolean | null) — no nested
    // object/array that could smuggle content.
    for (const v of Object.values(meta)) {
      expect(["string", "number", "boolean"]).toContain(typeof v);
    }
  });

  it("omits switchedFrom* when there was no switch (null) — no empty keys", () => {
    const meta = rehydrateTraceMeta({
      ...base,
      switchedFromAgentId: null,
      switchedFromInstanceName: null,
    });
    expect("switchedFromAgentId" in meta).toBe(false);
    expect("switchedFromInstanceName" in meta).toBe(false);
  });
});

describe("shouldReportRehydrateMissed — fires ONLY on the bug condition", () => {
  it("fires: a routed switch whose FRESH session did NOT rehydrate (the bug)", () => {
    expect(
      shouldReportRehydrateMissed({
        routedSwitch: true,
        freshSession: true,
        decision: "skip_warm",
      }),
    ).toBe(true);
    // attachment-on-switch is the same gap (history can't be prepended).
    expect(
      shouldReportRehydrateMissed({
        routedSwitch: true,
        freshSession: true,
        decision: "skip_attachment",
      }),
    ).toBe(true);
  });

  it("does NOT fire when the switch DID rehydrate (the fixed happy path)", () => {
    expect(
      shouldReportRehydrateMissed({
        routedSwitch: true,
        freshSession: true,
        decision: "rehydrate",
      }),
    ).toBe(false);
  });

  it("does NOT fire on a NON-routed send, or a non-fresh (warm) session", () => {
    expect(
      shouldReportRehydrateMissed({
        routedSwitch: false,
        freshSession: true,
        decision: "skip_warm",
      }),
    ).toBe(false);
    expect(
      shouldReportRehydrateMissed({
        routedSwitch: true,
        freshSession: false,
        decision: "skip_warm",
      }),
    ).toBe(false);
  });
});
