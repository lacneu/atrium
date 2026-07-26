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

// ── The pre-send guard's report on the trace (W2) ───────────────────────────
//
// This projection is the INGEST trust boundary. The bridge already buckets the
// gateway's free-text compaction reason; doing it again here is not redundancy —
// a divergent, older, or forged bridge is not a trusted source, and this trace is
// contractually content-free.

const baseTrace = {
  decision: "skip_full",
  freshSession: false,
  routedSwitch: false,
  prependedTurns: 0,
  routedAgentId: "alice",
  routedInstanceName: "primary",
  switchedFromAgentId: null,
  switchedFromInstanceName: null,
};

describe("presend fields on the rehydrate trace", () => {
  it("carries the decision, the measured fill and its provenance", () => {
    const meta = rehydrateTraceMeta({
      ...baseTrace,
      presendAction: "compact_or_block",
      presendFillPct: 97,
      presendFillSource: "gateway_estimate",
      presendCompaction: "refused",
      presendBlocked: true,
      presendCompactReasonClass: "no transcript",
    });
    expect(meta.presendAction).toBe("compact_or_block");
    expect(meta.presendFillPct).toBe(97);
    expect(meta.presendFillSource).toBe("gateway_estimate");
    expect(meta.presendCompaction).toBe("refused");
    expect(meta.presendBlocked).toBe(true);
    expect(meta.presendCompactReasonClass).toBe("no transcript");
  });

  it("DROPS anything off the allowlist instead of passing it through", () => {
    // The failure this prevents: a gateway sentence reaching a trace because a
    // bridge forgot to bucket it.
    const meta = rehydrateTraceMeta({
      ...baseTrace,
      presendAction: "obliterate",
      presendFillSource: "vibes",
      presendCompaction: "probably fine",
      presendCompactReasonClass:
        "reply session initialization conflicted for agent:alice:...",
    });
    expect(meta.presendAction).toBeUndefined();
    expect(meta.presendFillSource).toBeUndefined();
    expect(meta.presendCompaction).toBeUndefined();
    expect(meta.presendCompactReasonClass).toBeUndefined();
  });

  it("a non-numeric or absent fill leaves the field OFF, never 0", () => {
    // 0 % would read as "measured, and the session was empty" — the opposite of
    // "we could not measure it".
    expect(
      rehydrateTraceMeta({ ...baseTrace, presendFillPct: null }).presendFillPct,
    ).toBeUndefined();
    expect(
      rehydrateTraceMeta({ ...baseTrace, presendFillPct: Number.NaN })
        .presendFillPct,
    ).toBeUndefined();
    expect(rehydrateTraceMeta(baseTrace).presendFillPct).toBeUndefined();
  });

  it("records `blocked` only when it is TRUE", () => {
    expect(
      rehydrateTraceMeta({ ...baseTrace, presendBlocked: false })
        .presendBlocked,
    ).toBeUndefined();
  });

  it("a normal turn adds no presend fields at all", () => {
    const meta = rehydrateTraceMeta(baseTrace);
    expect(Object.keys(meta).filter((k) => k.startsWith("presend"))).toEqual([]);
  });
});
