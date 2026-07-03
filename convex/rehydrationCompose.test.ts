// Hybrid rehydration — PURE composer tests (convex/lib/rehydration.ts).
// Every case pins an observable behavior of the composed history block: layout,
// budget arithmetic, marker honesty, and the sizing helpers the engine shares.

import { describe, expect, test } from "vitest";
import {
  freshTailCount,
  KEEP_RECENT_MAX_MESSAGES,
  KEEP_RECENT_MIN_MESSAGES,
  gatewaySafeSessionPart,
  summarizeSessionNonce,
  HARD_MAX_HISTORY_CHARS,
  SUMMARY_BUDGET_SHARE,
  SUMMARY_MAX_CHARS,
  SUMMARY_BACKOFF_BASE_MS,
  SUMMARY_BACKOFF_CAP_MS,
  clampSummary,
  composeRehydration,
  rehydrationBudgetChars,
  summaryBackoffMs,
  type RehydrationTurn,
} from "./lib/rehydration";

const T = (n: number, len = 20): RehydrationTurn[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `t${i} ${"x".repeat(len)}`,
  }));

describe("composeRehydration", () => {
  test("verbatim only, fits: header + lines + footer, no marker", () => {
    const r = composeRehydration({
      turns: T(4),
      summary: null,
      readWindowClipped: false,
      budgetChars: 10_000,
    });
    expect(r.history).toContain("Reprise d’une conversation antérieure");
    expect(r.history).toContain("Utilisateur : t0");
    expect(r.history).toContain("Assistant : t3");
    expect(r.history).not.toContain("omis");
    expect(r.turnCount).toBe(4);
    expect(r.summaryUsed).toBe(false);
    expect(r.omitted).toBe(false);
    // Chronological order preserved.
    const h = r.history!;
    expect(h.indexOf("t0")).toBeLessThan(h.indexOf("t3"));
  });

  test("budget cut without summary: legacy omission marker, newest turns kept", () => {
    const r = composeRehydration({
      turns: T(10, 200),
      summary: null,
      readWindowClipped: false,
      budgetChars: 700,
    });
    expect(r.omitted).toBe(true);
    expect(r.history).toContain("[…début de la conversation plus ancien, omis…]");
    // Newest turn survives; oldest is cut.
    expect(r.history).toContain("t9");
    expect(r.history).not.toContain("t0 ");
  });

  test("the newest turn is ALWAYS kept but TRUNCATED to the budget (never unbounded)", () => {
    const r = composeRehydration({
      turns: T(1, 5_000),
      summary: null,
      readWindowClipped: false,
      budgetChars: 100,
    });
    expect(r.turnCount).toBe(1);
    expect(r.history).toContain("t0");
    // A multi-child turn cannot blow the ceiling: its render is budget-bounded.
    expect(r.history!.length).toBeLessThan(400); // header+markers+capped line
    expect(r.omitted).toBe(true);
  });

  test("summary + full tail: summary intro with count, no marker", () => {
    const r = composeRehydration({
      turns: T(3),
      summary: { text: "Résumé du début.", coveredCount: 12 },
      readWindowClipped: false,
      budgetChars: 10_000,
    });
    expect(r.summaryUsed).toBe(true);
    expect(r.history).toContain(
      "[Résumé de la partie antérieure de la conversation (12 messages) :]",
    );
    expect(r.history).toContain("Résumé du début.");
    expect(r.history).not.toContain("omis");
    // Summary comes BEFORE the verbatim lines.
    const h = r.history!;
    expect(h.indexOf("Résumé du début.")).toBeLessThan(h.indexOf("t0"));
  });

  test("summary + budget cut: the WITH-summary gap marker", () => {
    const r = composeRehydration({
      turns: T(10, 300),
      summary: { text: "Résumé.", coveredCount: 4 },
      readWindowClipped: false,
      budgetChars: 900,
    });
    expect(r.omitted).toBe(true);
    expect(r.history).toContain("[…messages intermédiaires omis…]");
    expect(r.history).not.toContain("début de la conversation plus ancien");
  });

  test("readWindowClipped alone renders the marker (bounded read honesty)", () => {
    const r = composeRehydration({
      turns: T(2),
      summary: { text: "Résumé.", coveredCount: 4 },
      readWindowClipped: true,
      budgetChars: 10_000,
    });
    expect(r.omitted).toBe(true);
    expect(r.history).toContain("[…messages intermédiaires omis…]");
  });

  test("summary-only (no verbatim turns) still produces a history", () => {
    const r = composeRehydration({
      turns: [],
      summary: { text: "Tout le contexte tient dans le résumé.", coveredCount: 30 },
      readWindowClipped: false,
      budgetChars: 10_000,
    });
    expect(r.history).not.toBeNull();
    expect(r.turnCount).toBe(0);
    expect(r.summaryUsed).toBe(true);
  });

  test("no summary + no turns -> null history (nothing to inject)", () => {
    const r = composeRehydration({
      turns: [],
      summary: null,
      readWindowClipped: false,
      budgetChars: 10_000,
    });
    expect(r).toEqual({
      history: null,
      turnCount: 0,
      summaryUsed: false,
      summaryChars: 0,
      omitted: false,
    });
  });

  test("an over-long summary is capped to its budget share (verbatim keeps the rest)", () => {
    const budget = 10_000;
    const r = composeRehydration({
      turns: T(6, 100),
      summary: { text: "s".repeat(9_000), coveredCount: 40 },
      readWindowClipped: false,
      budgetChars: budget,
    });
    expect(r.summaryChars).toBeLessThanOrEqual(
      Math.floor(budget * SUMMARY_BUDGET_SHARE),
    );
    expect(r.history).toContain("…"); // the cap mark
    // Verbatim still present despite the huge summary.
    expect(r.turnCount).toBe(6);
  });

  test("a whitespace-only summary counts as none", () => {
    const r = composeRehydration({
      turns: T(2),
      summary: { text: "   ", coveredCount: 3 },
      readWindowClipped: false,
      budgetChars: 10_000,
    });
    expect(r.summaryUsed).toBe(false);
    expect(r.history).not.toContain("Résumé de la partie antérieure");
  });
});

describe("sizing helpers", () => {
  test("rehydrationBudgetChars: legacy formula under the cap, hard-capped above", () => {
    // 32k window -> 48k chars (legacy) — under the 60k cap.
    expect(rehydrationBudgetChars(32_000)).toBe(48_000);
    // 200k window -> would be 300k chars — capped.
    expect(rehydrationBudgetChars(200_000)).toBe(HARD_MAX_HISTORY_CHARS);
    // Tiny window -> the 2k floor.
    expect(rehydrationBudgetChars(1_000)).toBe(2_000);
  });

  test("clampSummary: under cap unchanged; over cap cut at a word boundary + mark", () => {
    expect(clampSummary("court résumé")).toBe("court résumé");
    const clamped = clampSummary("mot ".repeat(3_000));
    expect(clamped.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 1);
    expect(clamped.endsWith("…")).toBe(true);
    expect(clamped).not.toMatch(/mo…$/); // no mid-word cut (boundary found)
  });

  test("summaryBackoffMs: exponential growth, capped, negative-safe", () => {
    expect(summaryBackoffMs(0)).toBe(SUMMARY_BACKOFF_BASE_MS);
    expect(summaryBackoffMs(1)).toBe(SUMMARY_BACKOFF_BASE_MS * 2);
    expect(summaryBackoffMs(3)).toBe(SUMMARY_BACKOFF_BASE_MS * 8);
    expect(summaryBackoffMs(50)).toBe(SUMMARY_BACKOFF_CAP_MS);
    expect(summaryBackoffMs(-2)).toBe(SUMMARY_BACKOFF_BASE_MS);
  });
});

describe("gateway session-part mirror (pinned against the bridge)", () => {
  // SHARED VECTORS with bridge/src/providers/openclaw/session-keys.ts —
  // safeSessionPart's behavior; any drift between the two breaks this test.
  test("sanitization vectors", () => {
    expect(gatewaySafeSessionPart("summarize:abc123:1782960000000")).toBe(
      "summarize-abc123-1782960000000",
    );
    expect(gatewaySafeSessionPart("  weird value!  ")).toBe("weird-value");
    expect(gatewaySafeSessionPart("--dots.kept.--")).toBe("dots.kept");
    expect(gatewaySafeSessionPart("///")).toBe("unknown");
  });

  test("the summarize nonce is the sanitized rotated openclawChatId", () => {
    expect(summarizeSessionNonce("jd7abc", 42)).toBe("summarize-jd7abc-42");
  });
});

describe("freshTailCount (size-based fresh tail)", () => {
  const T = (n: number, len: number) =>
    Array.from({ length: n }, () => ({ text: "x".repeat(len) }));

  test("few HUGE messages: the tail stops at the MINIMUM count (the rest is summarizable)", () => {
    // The user-reported starvation: 8 × 10k-char digests under a 12-message tail
    // meant NOTHING was ever summarizable.
    expect(freshTailCount(T(8, 10_000))).toBe(KEEP_RECENT_MIN_MESSAGES);
  });

  test("a giant turn among SMALL newest turns stays OUT of the tail (check-before-add)", () => {
    // The report's exact shape: small follow-ups + one 30k digest close to the
    // end. The digest must be summarizable, not locked in by crossing the target.
    const turnsDesc = [
      { text: "s".repeat(300) }, // newest
      { text: "s".repeat(300) },
      { text: "g".repeat(30_000) }, // the digest
      { text: "s".repeat(300) }, // oldest
    ];
    expect(freshTailCount(turnsDesc)).toBe(2);
  });

  test("many tiny messages: the tail is capped at the MAXIMUM count", () => {
    expect(freshTailCount(T(100, 50))).toBe(KEEP_RECENT_MAX_MESSAGES);
  });

  test("medium messages: the tail stops once the char target is reached", () => {
    // 2k chars each: target 12k reached after 6 -> tail 6 (between min and max).
    const tail = freshTailCount(T(20, 2_000));
    expect(tail).toBe(6);
  });

  test("fewer messages than the minimum: everything is tail", () => {
    expect(freshTailCount(T(2, 50_000))).toBe(2);
  });
});
