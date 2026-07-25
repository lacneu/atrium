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
  contextSource,
  effectiveContextWindow,
} from "./sessionKnobs";
import type { SessionMetaView } from "./sessionKnobs";

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

  // The guard used to cover `totalTokens` ONLY, so an absurd `activeTokens`
  // sailed straight through and was displayed as a percentage. Both counters are
  // the SAME upstream field sampled at two moments (established by reading the
  // gateway sources), so both need it.
  test("REFUSES an absurd ACTIVE stamp too, not just the legacy counter", () => {
    expect(
      effectiveContextUsed({ activeTokens: 3194300, contextTokens: 372000 }),
    ).toBeNull();
  });

  test("falls back to a sane legacy counter when the ACTIVE stamp is absurd", () => {
    // The active stamp is unusable, but totalTokens is plausible: show that
    // rather than nothing — an honest number beats an empty gauge.
    expect(
      effectiveContextUsed({
        activeTokens: 3194300,
        totalTokens: 90000,
        contextTokens: 372000,
      }),
    ).toBe(90000);
  });

  // The gateway tells us when its counter is stale and leaves its OWN reading
  // unknown in that case; freezing a percentage would be a lie with a number on it.
  test("a STALE counter yields unknown when it is the ONLY source", () => {
    expect(
      effectiveContextUsed({
        totalTokens: 112000,
        contextTokens: 372000,
        totalTokensFresh: false,
      }),
    ).toBeNull();
    expect(
      contextSource({ totalTokens: 112000, contextTokens: 372000, totalTokensFresh: false }),
    ).toBe("unknown");
  });

  // The gateway's own estimate accounts for what the counters MISS (tool schemas,
  // injected context) — the production incident of 2026-07-20 showed a
  // comfortable 48% from a counter while the assembled prompt was over budget.
  test("the gateway's prompt ESTIMATE wins over both counters (the 48%-then-wall case)", () => {
    const sm = {
      activeTokens: 179625,
      totalTokens: 179625,
      contextTokens: 372000,
      estimatedPromptTokens: 358960,
      promptBudgetBeforeReserve: 308000,
    };
    expect(effectiveContextUsed(sm)).toBe(358960);
    expect(contextSource(sm)).toBe("budget_estimate");
    // …and the counter alone would have painted a comfortable fill.
    expect(
      effectiveContextUsed({
        activeTokens: 179625,
        totalTokens: 179625,
        contextTokens: 372000,
      }),
    ).toBe(179625);
  });

  test("a stale FLAG never suppresses the estimate (it qualifies the counters)", () => {
    expect(
      effectiveContextUsed({
        estimatedPromptTokens: 200000,
        activeTokens: 10,
        contextTokens: 372000,
        totalTokensFresh: false,
      }),
    ).toBe(200000);
  });

  // An estimate ABOVE the window is the most important reading of all: "the next
  // send does not fit". Rejecting it as absurd would hide an imminent overflow
  // behind a comfortable post-hoc counter (codex P2).
  test("an OVER-BUDGET estimate is kept, not discarded as absurd", () => {
    const sm = {
      estimatedPromptTokens: 420000,
      activeTokens: 110000,
      contextTokens: 372000,
    };
    expect(effectiveContextUsed(sm)).toBe(420000);
    expect(contextSource(sm)).toBe("budget_estimate");
  });

  // The stale flag arrives with a pre-send snapshot; the end-of-turn usage stamp
  // is observed LATER and must not be suppressed by it (codex P2).
  test("a stale flag does NOT suppress a later active stamp (only totalTokens)", () => {
    expect(
      effectiveContextUsed({
        activeTokens: 150000,
        totalTokens: 150000,
        contextTokens: 372000,
        totalTokensFresh: false,
      }),
    ).toBe(150000);
    // With no active stamp, the flag still invalidates the counter it qualifies.
    expect(
      effectiveContextUsed({
        totalTokens: 150000,
        contextTokens: 372000,
        totalTokensFresh: false,
      }),
    ).toBeNull();
  });

  // THE arithmetic of the production incident: the usable prompt budget is the
  // window MINUS the output reserve, and dividing by the window instead made an
  // over-budget prompt read as a comfortable fill (codex P2).
  test("the denominator is the PROMPT BUDGET, not the raw window", () => {
    const sm = {
      estimatedPromptTokens: 358960,
      promptBudgetBeforeReserve: 308000,
      contextTokens: 372000,
    };
    expect(effectiveContextWindow(sm)).toBe(308000);
    const used = effectiveContextUsed(sm) as number;
    // 358960/308000 = 117% (does not fit) — NOT 96% against the window.
    expect(Math.round((used / (effectiveContextWindow(sm) as number)) * 100)).toBe(117);
    expect(Math.round((used / 372000) * 100)).toBe(96); // the misleading figure
  });

  test("falls back to the window when the gateway reports no budget", () => {
    expect(effectiveContextWindow({ contextTokens: 272000 })).toBe(272000);
    expect(effectiveContextWindow({})).toBeNull();
    expect(effectiveContextWindow(null)).toBeNull();
    // A zero/absent budget must not become the denominator.
    expect(
      effectiveContextWindow({ promptBudgetBeforeReserve: 0, contextTokens: 272000 }),
    ).toBe(272000);
  });

  test("contextSource names the counter path and the empty case", () => {
    expect(contextSource({ activeTokens: 5000, contextTokens: 272000 })).toBe(
      "last_call_usage",
    );
    expect(contextSource(null)).toBe("unknown");
    expect(contextSource({ contextTokens: 272000 })).toBe("unknown");
  });

  test("counters invalidated: a window is still known, so the detail row must render", () => {
    // The advanced popover is the ONLY surface that explains the unknown gauge on
    // touch or on a compacted header (no hover title), so its gate keys on the
    // WINDOW — never on a usable figure, which is exactly what is missing here.
    const sm = {
      contextTokens: 372000,
      totalTokens: 250000,
      totalTokensFresh: false,
    } as SessionMetaView;
    expect(effectiveContextUsed(sm)).toBeNull();
    expect(effectiveContextWindow(sm)).toBe(372000);
  });
});
