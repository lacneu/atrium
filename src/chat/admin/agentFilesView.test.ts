import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  BOOTSTRAP_MAX_CHARS,
  TOTAL_BUDGET_CHARS,
  budgetPct,
  computeMiniDiff,
  formatKb,
  gaugePct,
  isConflictError,
  isDashboardAbsentError,
  totalSize,
} from "./agentFilesView";

// Pure view helpers for the agentFiles tab: gauges, locale size formatting and
// the confirm mini-diff (A4) — every branch tested without a DOM harness.

describe("gaugePct / budgetPct", () => {
  test("scales against the per-file bootstrap budget", () => {
    expect(gaugePct(0)).toBe(0);
    expect(gaugePct(undefined)).toBe(0);
    expect(gaugePct(-5)).toBe(0);
    expect(gaugePct(BOOTSTRAP_MAX_CHARS / 2)).toBe(50);
    expect(gaugePct(BOOTSTRAP_MAX_CHARS)).toBe(100);
    expect(gaugePct(9200)).toBe(46); // the CONF_DESIGN §3 mock row
  });

  test("budgetPct scales against the TOTAL budget", () => {
    expect(budgetPct(0)).toBe(0);
    expect(budgetPct(TOTAL_BUDGET_CHARS / 2)).toBe(50);
    expect(budgetPct(30_800)).toBe(51); // the CONF_DESIGN §3 mock total
  });
});

describe("formatKb (locale-aware, number only — unit is i18n)", () => {
  test("formats with one decimal, per locale", () => {
    expect(formatKb(9200, "fr")).toBe("9,2");
    expect(formatKb(9200, "en")).toBe("9.2");
    expect(formatKb(undefined, "en")).toBe("0.0");
    expect(formatKb(0, "fr")).toBe("0,0");
  });
});

describe("totalSize", () => {
  test("sums sizes, treating missing/size-less entries as 0", () => {
    expect(totalSize([])).toBe(0);
    expect(totalSize([{ size: 100 }, {}, { size: 250 }])).toBe(350);
    expect(totalSize([{ size: -10 }, { size: 5 }])).toBe(5);
  });
});

describe("computeMiniDiff (line multiset)", () => {
  test("no change", () => {
    const d = computeMiniDiff("a\nb", "a\nb");
    expect(d).toEqual({
      added: 0,
      removed: 0,
      sampleAdded: [],
      sampleRemoved: [],
    });
  });

  test("added and removed lines are counted with samples", () => {
    const d = computeMiniDiff("keep\nold1\nold2", "keep\nnew1");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(2);
    expect(d.sampleAdded).toEqual(["new1"]);
    expect(d.sampleRemoved).toEqual(["old1", "old2"]);
  });

  test("duplicate lines count per OCCURRENCE (multiset, not set)", () => {
    const d = computeMiniDiff("x", "x\nx\nx");
    expect(d.added).toBe(2); // two extra occurrences of "x"
    expect(d.removed).toBe(0);
  });

  test("samples cap at 3 while counts stay exact", () => {
    const before = "";
    const after = ["a", "b", "c", "d", "e"].join("\n");
    const d = computeMiniDiff(before, after);
    expect(d.added).toBe(5);
    expect(d.removed).toBe(1); // the original lone empty line
    expect(d.sampleAdded).toHaveLength(3);
  });
});

describe("isConflictError", () => {
  test("detects the stable setAgentFile CAS code, on Errors and non-Errors", () => {
    expect(isConflictError(new Error("conflict: file changed since load"))).toBe(
      true,
    );
    expect(isConflictError("Uncaught conflict: file changed since load")).toBe(
      true,
    );
    expect(isConflictError(new Error("bridge_error: HTTP 500"))).toBe(false);
    expect(isConflictError(undefined)).toBe(false);
  });
});

// ── A cause that stops at the boundary helps nobody ──
//
// Raised in review, twice: the bridge minted `DASHBOARD_NOT_DEPLOYED`, Convex was then fixed
// to forward it, and the TAB still swallowed it — `catch {}` with no variable, one generic
// error state, and a Retry button offered for a server that is not deployed. Recognising the
// code is what turns the diagnosis into something the operator can act on.

describe("the dashboard-absent cause is recognised in the view", () => {
  test("the bridge's stable code is matched wherever it sits in the message", () => {
    // The shape Convex actually throws: `bridge_error: <op> -> HTTP <status> (<code>)`.
    expect(
      isDashboardAbsentError(
        new Error("bridge_error: agent-files list -> HTTP 502 (DASHBOARD_NOT_DEPLOYED)"),
      ),
    ).toBe(true);
  });

  test("a plain bridge failure is NOT — it keeps its retry", () => {
    // The discrimination is the point: a dashboard that is deployed and briefly unwell must
    // still be retryable.
    expect(
      isDashboardAbsentError(new Error("bridge_error: agent-files list -> HTTP 502")),
    ).toBe(false);
    expect(isDashboardAbsentError(new Error("conflict: stale"))).toBe(false);
  });

  test("a non-Error rejection is handled, not thrown on", () => {
    expect(isDashboardAbsentError("DASHBOARD_NOT_DEPLOYED")).toBe(true);
    expect(isDashboardAbsentError(null)).toBe(false);
  });

  test("the tab renders the cause instead of a retry", () => {
    // Read from the source: the defect was an ABSENT binding (`catch {}`) and a button that
    // should not be there — neither is visible to a test of the helper alone, and that is
    // exactly how it survived two review passes.
    const src = readFileSync(
      new URL("./AgentFilesTab.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/catch \(err\) \{\s*setListing\(\{\s*status: "error",\s*dashboardAbsent: isDashboardAbsentError\(err\)/);
    expect(src).toContain("afiles_error_dashboard_absent");
    expect(src).toMatch(/!listing\.dashboardAbsent && \(/);
  });
});
