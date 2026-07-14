/// <reference types="vite/client" />
//
// CONF-4 session-knob helpers: binary intent-based provenance (amendment A1)
// and EVERY branch of the parameterized/branchful label functions (GC-P5
// lesson: parity + tsc alone never verify that each branch renders the right
// message — one un-rendered branch shipped broken in the introspection screen).

import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import {
  SPEED_OPTIONS,
  agentLine,
  capitalize,
  contextLine,
  contextPct,
  costLine,
  formatTokens,
  isOverridden,
  speedKnobValue,
  speedOptionLabel,
  speedSelection,
  verbosityLine,
  effectiveContextUsed,
} from "./sessionKnobs";

describe("isOverridden — binary, intent-based provenance (A1)", () => {
  test("true exactly when the field's key is present in sessionSettings", () => {
    expect(isOverridden({ thinkingLevel: "high" }, "thinkingLevel")).toBe(true);
    expect(isOverridden({ model: "gpt-5.5" }, "model")).toBe(true);
    expect(isOverridden({ fastMode: false }, "fastMode")).toBe(true);
  });

  test("false when the key is absent — even if other keys are set", () => {
    expect(isOverridden({ model: "gpt-5.5" }, "thinkingLevel")).toBe(false);
    expect(isOverridden({}, "fastMode")).toBe(false);
  });

  test("false for a null/undefined settings object", () => {
    expect(isOverridden(null, "thinkingLevel")).toBe(false);
    expect(isOverridden(undefined, "model")).toBe(false);
  });

  test("an override TO the inherited value is still an override (the old header heuristic was wrong here)", () => {
    // The user explicitly set thinkingLevel to what happens to be the default:
    // the key is present, so provenance must say "overridden".
    expect(isOverridden({ thinkingLevel: "medium" }, "thinkingLevel")).toBe(true);
  });

  test("fastMode: false (a real value) is an override, not 'inherited'", () => {
    expect(isOverridden({ fastMode: false }, "fastMode")).toBe(true);
  });
});

describe("speedSelection — segment derived from the intent", () => {
  test("no settings / no fastMode key -> inherit", () => {
    expect(speedSelection(null)).toBe("inherit");
    expect(speedSelection(undefined)).toBe("inherit");
    expect(speedSelection({ model: "gpt-5.5" })).toBe("inherit");
  });

  test("fastMode true -> fast; false -> standard", () => {
    expect(speedSelection({ fastMode: true })).toBe("fast");
    expect(speedSelection({ fastMode: false })).toBe("standard");
  });
});

describe("speedKnobValue — mutation value per segment", () => {
  test("inherit -> null (gateway unset), fast -> true, standard -> false", () => {
    expect(speedKnobValue("inherit")).toBeNull();
    expect(speedKnobValue("fast")).toBe(true);
    expect(speedKnobValue("standard")).toBe(false);
  });
});

describe("speedOptionLabel — every segment branch", () => {
  test("each option maps to its own message (no branch inversion)", () => {
    expect(speedOptionLabel("inherit")).toBe(m.conf_speed_inherit());
    expect(speedOptionLabel("fast")).toBe(m.conf_speed_fast());
    expect(speedOptionLabel("standard")).toBe(m.conf_speed_standard());
    const labels = SPEED_OPTIONS.map(speedOptionLabel);
    expect(new Set(labels).size).toBe(3);
  });
});

describe("contextLine — parameterized context meter line", () => {
  test("interpolates pct + compact token counts", () => {
    const line = contextLine(145_100, 272_000);
    expect(line).toBe(
      m.spanel_context_value({ pct: 53, used: "145.1k", total: "272.0k" }),
    );
    expect(line).toContain("53");
    expect(line).toContain("145.1k");
    expect(line).toContain("272.0k");
  });

  test("null when unusable (missing used, missing/zero window)", () => {
    expect(contextLine(undefined, 272_000)).toBeNull();
    expect(contextLine(1000, undefined)).toBeNull();
    expect(contextLine(1000, 0)).toBeNull();
  });
});

describe("contextPct", () => {
  test("rounds the usage ratio", () => {
    expect(contextPct(145_100, 272_000)).toBe(53);
    expect(contextPct(0, 1000)).toBe(0);
  });
  test("null when the meta is unusable", () => {
    expect(contextPct(undefined, 1000)).toBeNull();
    expect(contextPct(1000, 0)).toBeNull();
  });
});

describe("verbosityLine — both branches of the pinned-verbosity row", () => {
  test("uses the reported level when present", () => {
    expect(verbosityLine("full")).toBe(m.spanel_verbosity_value({ level: "full" }));
    // Full `.toBe` (not `.toContain`): pins the whole rendered line incl. the
    // " · fixée" suffix, so a dropped suffix/template regression is caught.
    expect(verbosityLine("low")).toBe(m.spanel_verbosity_value({ level: "low" }));
  });
  test("falls back to 'full' when the gateway has not reported one", () => {
    expect(verbosityLine(undefined)).toBe(
      m.spanel_verbosity_value({ level: "full" }),
    );
  });
});

describe("costLine — every presence combination", () => {
  test("cost + tokens", () => {
    const line = costLine(0.0042, 26_000);
    expect(line).toBe(m.spanel_cost_both({ cost: "0.00", tokens: "26.0k" }));
    expect(line).toContain("26.0k");
  });
  test("cost only", () => {
    expect(costLine(1.5, undefined)).toBe(m.spanel_cost_only({ cost: "1.50" }));
  });
  test("tokens only", () => {
    expect(costLine(undefined, 980)).toBe(m.spanel_tokens_only({ tokens: "980" }));
  });
  test("neither -> null (row hidden)", () => {
    expect(costLine(undefined, undefined)).toBeNull();
  });
});

describe("agentLine", () => {
  test("joins the present parts with a separator", () => {
    expect(agentLine(["Alice", "codex", "gpt-5.5"])).toBe(
      "Alice · codex · gpt-5.5",
    );
  });
  test("skips missing/empty parts", () => {
    expect(agentLine([null, "codex", undefined, "gpt-5.5", ""])).toBe(
      "codex · gpt-5.5",
    );
  });
  test("null when everything is missing (section hidden)", () => {
    expect(agentLine([null, undefined, ""])).toBeNull();
  });
});

describe("formatTokens / capitalize (moved from ConvexChat — header parity)", () => {
  test("formatTokens compacts thousands", () => {
    expect(formatTokens(62_226)).toBe("62.2k");
    expect(formatTokens(980)).toBe("980");
  });
  test("capitalize uppercases the first letter only", () => {
    expect(capitalize("high")).toBe("High");
    expect(capitalize("")).toBe("");
  });
});

describe("effectiveContextUsed (context gauge source)", () => {
  test("prefers the per-turn active stamp over the legacy counter", () => {
    expect(
      effectiveContextUsed({
        activeTokens: 112000,
        totalTokens: 3194300,
        contextTokens: 372000,
      }),
    ).toBe(112000);
  });
  test("keeps a sane legacy counter (no stamp yet)", () => {
    expect(
      effectiveContextUsed({ totalTokens: 90000, contextTokens: 272000 }),
    ).toBe(90000);
  });
  test("REFUSES a cumulative legacy counter larger than the window (859% prod report)", () => {
    expect(
      effectiveContextUsed({ totalTokens: 3194300, contextTokens: 372000 }),
    ).toBeNull();
  });
  test("null on missing data", () => {
    expect(effectiveContextUsed(null)).toBeNull();
    expect(effectiveContextUsed({})).toBeNull();
  });
});
