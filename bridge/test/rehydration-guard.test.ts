// Re-hydration guard — the PROD INCIDENT fix. After a redeploy rolled the OpenClaw
// session "fresh", the bridge re-hydrated prior turns onto a chat.send; when that
// turn ALSO carried an attachment, the gateway stack-overflowed (RangeError ->
// INVALID_REQUEST) assembling prepended-history + attachment. Re-hydration alone
// and attachment alone both work — only the COMBINATION crashes. `rehydrationDecision`
// is the pure guard: on a fresh-session attachment turn it ships the bare message
// (a KNOWN best-effort gap, strictly better than crashing — no cross-turn debt state).

import { describe, expect, it } from "vitest";
import { computeFreshSession, rehydrationDecision } from "../src/server.js";
import { readFileSync } from "node:fs";
import {
  CHARS_PER_TOKEN,
  REHYDRATION_MAX_FILL,
  TOKEN_ESTIMATE_MARGIN,
  composedPromptFits,
  sessionFill,
} from "../src/core/context-budget.js";

const D = (freshSession: boolean, hasAttachments: boolean, enabled: boolean) =>
  rehydrationDecision({ freshSession, hasAttachments, enabled });

describe("rehydrationDecision — gateway-crash guard", () => {
  it("rehydrates on a fresh, attachment-free, enabled turn", () => {
    expect(D(true, false, true)).toBe("rehydrate");
  });

  it("SKIPS on a fresh attachment turn (the live crash) — ships the bare message", () => {
    expect(D(true, true, true)).toBe("skip_attachment");
  });

  it("the kill-switch disables re-hydration entirely (no crash risk either way)", () => {
    expect(D(true, false, false)).toBe("skip_disabled");
    expect(D(true, true, false)).toBe("skip_disabled"); // disabled wins (no prepend)
  });

  it("a warm session never re-hydrates — attachment or not", () => {
    expect(D(false, false, true)).toBe("skip_warm");
    expect(D(false, true, true)).toBe("skip_warm");
  });
});

// computeFreshSession — the MULTI-AGENT context-carryover fix. An agent SWITCH
// re-keys the gateway session (epoch segment + new agentId), so the bridge builds a
// brand-new Session (firstSendPending=true). The gateway reports a freshly-created
// webchat session's `systemSent` as TRUTHY, so the systemSent heuristic ALONE misread
// the switch as "warm" and skipped re-hydration → the new agent answered with ZERO
// context (live-reproduced: "oui" → the switched agent: "je viens d'arriver…").
describe("computeFreshSession — switch (new key) counts as fresh", () => {
  it("a RESET/rolled session (systemSent=false) is fresh — the original trigger", () => {
    expect(computeFreshSession({ systemSent: false }, false, false)).toBe(true);
    expect(computeFreshSession(undefined, false, false)).toBe(true); // no session row
  });

  it("THE FIX: a freshly-routed agent (firstSendPending) on a ROUTED switch is fresh EVEN when the gateway reports systemSent truthy", () => {
    expect(computeFreshSession({ systemSent: true }, true, /*routedSwitch*/ true)).toBe(true);
    // The gateway may even omit systemSent for a brand-new session — still fresh.
    expect(computeFreshSession({}, true, true)).toBe(true);
  });

  it("a WARM same-agent follow-up (session reused, firstSendPending already false) is NOT fresh — no wasteful re-prepend", () => {
    expect(computeFreshSession({ systemSent: true }, false, true)).toBe(false);
  });

  it("CODEX P2: a SAME-AGENT routed follow-up whose Session was REBUILT by a bridge restart (firstSendPending true) but is NOT a switch (routedSwitch false) on a warm gateway session is NOT fresh — keeps the warm session, no duplicate re-inject", () => {
    expect(
      computeFreshSession({ systemSent: true }, /*firstSendPending*/ true, /*routedSwitch*/ false),
    ).toBe(false);
  });

  it("DISCRIMINATING: drop the (firstSendPending && routedSwitch) term => the switch case regresses to NOT-fresh (the shipped bug)", () => {
    const systemSentOnly = (sess: { systemSent?: unknown } | undefined) =>
      !sess || sess.systemSent === false;
    expect(systemSentOnly({ systemSent: true })).toBe(false); // <- the regression
    expect(computeFreshSession({ systemSent: true }, true, true)).toBe(true); // <- fixed
  });
});

// --- W2 / G-10: an almost-full session refuses the injection -----------------
describe("rehydrationDecision: the fill gate", () => {
  const base = { freshSession: true, hasAttachments: false, enabled: true };

  it("REFUSES beyond 70% fill — the gateway already holds this history", () => {
    expect(rehydrationDecision({ ...base, fill: 0.71 })).toBe("skip_full");
    expect(rehydrationDecision({ ...base, fill: 1.4 })).toBe("skip_full");
  });

  it("allows it below the threshold (the feature must keep working)", () => {
    expect(rehydrationDecision({ ...base, fill: 0.69 })).toBe("rehydrate");
    expect(rehydrationDecision({ ...base, fill: 0 })).toBe("rehydrate");
  });

  it("an UNKNOWN fill never refuses (P6 — a guard must not cost a turn)", () => {
    expect(rehydrationDecision({ ...base, fill: null })).toBe("rehydrate");
    expect(rehydrationDecision({ ...base })).toBe("rehydrate");
    expect(rehydrationDecision({ ...base, fill: Number.NaN })).toBe("rehydrate");
  });

  it("the EARLIER gates still win (a full session does not mask them)", () => {
    expect(rehydrationDecision({ ...base, enabled: false, fill: 0.9 })).toBe(
      "skip_disabled",
    );
    expect(rehydrationDecision({ ...base, freshSession: false, fill: 0.9 })).toBe(
      "skip_warm",
    );
    expect(rehydrationDecision({ ...base, hasAttachments: true, fill: 0.9 })).toBe(
      "skip_attachment",
    );
  });
});

// --- W2: the fill measure itself --------------------------------------------
describe("sessionFill", () => {
  it("prefers the gateway's OWN estimate over its budget, not the raw window", () => {
    // 358 960 against a 372 000 window reads comfortable; against the 308 000
    // budget the gateway actually had, it does not fit — the 2026-07-20 session.
    expect(
      sessionFill({
        estimatedPromptTokens: 358_960,
        promptBudgetBeforeReserve: 308_000,
        contextTokens: 372_000,
      })!,
    ).toBeGreaterThan(1);
  });

  it("a counter ABOVE the window is a cumulative total, not a fill → unknown", () => {
    // The 859% production report: dividing a run-cumulative counter by the window.
    expect(
      sessionFill({ totalTokens: 3_000_000, contextTokens: 272_000 }),
    ).toBeNull();
  });

  it("a counter the gateway STATES is stale is unknown, never 0", () => {
    expect(
      sessionFill({
        totalTokens: 100,
        contextTokens: 272_000,
        totalTokensFresh: false,
      }),
    ).toBeNull();
  });

  it("no budget at all is unknown (nothing to divide by)", () => {
    expect(sessionFill({ estimatedPromptTokens: 1_000 })).toBeNull();
    expect(sessionFill({})).toBeNull();
  });
});

// --- W2: the two copies of the thresholds must never drift -------------------
// The bridge is a separate npm package from `convex/`, so it cannot import
// `convex/lib/rehydration.ts`. The numbers therefore live twice — and a silent
// divergence would change WHEN a turn is refused on one side only. This reads the
// other copy as TEXT and compares, so a drift fails here instead of shipping.
describe("context-budget constants: no drift with convex/lib/rehydration.ts", () => {
  it("the ratio, the margin and the fill ceiling are identical on both sides", () => {
    const convexSrc = readFileSync(
      new URL("../../convex/lib/rehydration.ts", import.meta.url),
      "utf-8",
    );
    const read = (name: string): string => {
      const m = new RegExp(`export const ${name} = ([0-9.]+);`).exec(convexSrc);
      expect(m, `${name} not found in convex/lib/rehydration.ts`).not.toBeNull();
      return m![1]!;
    };
    expect(Number(read("CHARS_PER_TOKEN"))).toBe(CHARS_PER_TOKEN);
    expect(Number(read("TOKEN_ESTIMATE_MARGIN"))).toBe(TOKEN_ESTIMATE_MARGIN);
    expect(Number(read("REHYDRATION_MAX_FILL"))).toBe(REHYDRATION_MAX_FILL);
  });
});

// --- W2 / G-10: the composed prompt, at the bridge -------------------------
describe("composedPromptFits (bridge copy)", () => {
  it("bounds history + separator + the USER's text, not the history alone", () => {
    const w = 32_000;
    expect(
      composedPromptFits({
        historyChars: 20_000,
        userChars: 500,
        separatorChars: 2,
        windowTokens: w,
      }),
    ).toBe(true);
    expect(
      composedPromptFits({
        historyChars: 20_000,
        userChars: 20_000,
        separatorChars: 2,
        windowTokens: w,
      }),
    ).toBe(false);
  });

  it("an UNKNOWN window never refuses (P6)", () => {
    for (const w of [null, undefined, 0, -1, Number.NaN]) {
      expect(
        composedPromptFits({
          historyChars: 10 ** 6,
          userChars: 10 ** 6,
          separatorChars: 2,
          windowTokens: w,
        }),
      ).toBe(true);
    }
  });
});
