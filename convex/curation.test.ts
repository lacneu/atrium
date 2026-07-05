import { describe, expect, test } from "vitest";
import {
  effectiveTemplate,
  fillTemplate,
  resolveInjection,
} from "./lib/promptInjections";
import {
  clampCurationBudget,
  CURATION_BUDGET_MAX,
  CURATION_BUDGET_MIN,
  extractCuratedContent,
  isCurationCandidate,
  validateCuration,
} from "./lib/curation";

// The write-back is the fragile seam: the specialist reply is free-form. These
// pin the defense (advisor 2026-07-05) — a reply that is commentary, wrapped,
// or carries a MEDIA: line must NEVER become a proposed file body.
describe("extractCuratedContent (write-back defense)", () => {
  test("clean markdown passes through unchanged", () => {
    const body = "# Memory\n\n- fact 1\n- fact 2\n";
    expect(extractCuratedContent(body)).toBe(body.trim());
  });

  test("a single whole-reply fenced block is unwrapped", () => {
    const reply = "```markdown\n# Memory\n\n- fact\n```";
    expect(extractCuratedContent(reply)).toBe("# Memory\n\n- fact");
  });

  test("a plain ``` fence (no lang) is unwrapped", () => {
    expect(extractCuratedContent("```\n# T\nx\n```")).toBe("# T\nx");
  });

  test("a conversational preamble line is REJECTED (would corrupt the file)", () => {
    expect(
      extractCuratedContent("Voici le fichier rationalisé :\n# Memory\n- fact"),
    ).toBeNull();
    expect(
      extractCuratedContent("Here is the cleaned file:\n# Memory"),
    ).toBeNull();
    expect(extractCuratedContent("Sure! # Memory\n- fact")).toBeNull();
  });

  test("a MEDIA: delivery line anywhere is REJECTED (with or without a space)", () => {
    expect(
      extractCuratedContent("# Memory\n- fact\nMEDIA:/home/node/x.md"),
    ).toBeNull();
    expect(
      extractCuratedContent("# Memory\n- fact\nMEDIA: /tmp/file.md"),
    ).toBeNull();
  });

  test("a valid markdown file with an INTERNAL code fence is KEPT (rules files have examples)", () => {
    const body = "# Rules\n\nExample:\n```bash\nopenclaw status\n```\nDone.";
    expect(extractCuratedContent(body)).toBe(body.trim());
  });

  test("an outer ```markdown wrapper around a file that itself has fences is unwrapped once", () => {
    const inner = "# Rules\n```bash\nls\n```";
    expect(extractCuratedContent("```markdown\n" + inner + "\n```")).toBe(inner);
  });

  test("empty / whitespace-only replies are null", () => {
    expect(extractCuratedContent("")).toBeNull();
    expect(extractCuratedContent("   \n  ")).toBeNull();
    expect(extractCuratedContent("```markdown\n\n```")).toBeNull();
  });
});

describe("validateCuration (gross-failure gate)", () => {
  const before = "x".repeat(20_000);
  test("a smaller, in-budget rewrite passes", () => {
    expect(validateCuration(before, "y".repeat(8_000), 12_000)).toEqual({
      ok: true,
    });
  });
  test("empty is rejected", () => {
    expect(validateCuration(before, "   ", 12_000)).toEqual({
      ok: false,
      reason: "empty",
    });
  });
  test("a rewrite that GREW (or equal) is rejected", () => {
    expect(validateCuration(before, "y".repeat(20_000), 12_000).ok).toBe(false);
    expect(validateCuration(before, "y".repeat(25_000), 12_000).reason).toBe(
      "not_smaller",
    );
  });
  test("a suspiciously tiny rewrite (< 5%) is rejected as truncation/refusal", () => {
    expect(validateCuration(before, "y".repeat(500), 12_000)).toEqual({
      ok: false,
      reason: "suspiciously_short",
    });
  });
  test("smaller but STILL over budget passes with an over_budget flag", () => {
    expect(validateCuration(before, "y".repeat(15_000), 12_000)).toEqual({
      ok: true,
      reason: "over_budget",
    });
  });
  test("a proposal above the bridge write cap is REJECTED (unappliable)", () => {
    const huge = "x".repeat(200_000);
    expect(validateCuration(huge, "y".repeat(70_000), 20_000)).toEqual({
      ok: false,
      reason: "exceeds_write_cap",
    });
  });
});

describe("isCurationCandidate + clampCurationBudget", () => {
  test("candidate only at/over 90% of budget", () => {
    expect(isCurationCandidate(19_000, 20_000)).toBe(true); // 95%
    expect(isCurationCandidate(17_000, 20_000)).toBe(false); // 85%
    expect(isCurationCandidate(0, 20_000)).toBe(false);
  });
  test("budget clamps into the sane band", () => {
    expect(clampCurationBudget(999)).toBe(CURATION_BUDGET_MIN);
    expect(clampCurationBudget(999_999)).toBe(CURATION_BUDGET_MAX);
    expect(clampCurationBudget(undefined)).toBe(20_000);
    expect(clampCurationBudget(12_345)).toBe(12_345);
  });
});

describe("file_curation prompt injection (the curator briefing)", () => {
  test("default template names the file, the budget, the feedback, and the content", () => {
    const resolved = resolveInjection("file_curation", undefined, "fr");
    const filled = fillTemplate(effectiveTemplate("file_curation", resolved, "fr"), {
      file_name: "MEMORY.md",
      budget_chars: "16000",
      feedback: "Trop agressif : conserve les références.",
      content: "# Memory index\n- fait",
    });
    expect(filled).toContain("MEMORY.md");
    expect(filled).toContain("16000");
    expect(filled).toContain("Trop agressif : conserve les références.");
    expect(filled).toContain("# Memory index");
    // The role table (how the curator recognizes each file) is present.
    expect(filled).toContain("AGENTS.md : règles");
    // No unfilled placeholder leaks into the agent prompt.
    expect(filled).not.toMatch(/\{(file_name|budget_chars|feedback|content)\}/);
  });

  test("disabled -> bare material (a dedicated curator agent carries its own brief)", () => {
    const filled = fillTemplate(
      effectiveTemplate("file_curation", { enabled: false, template: "ignored" }, "fr"),
      { file_name: "MEMORY.md", budget_chars: "16000", feedback: "(aucun)", content: "X" },
    );
    expect(filled).toContain("MEMORY.md");
    expect(filled).toContain("X");
    expect(filled).not.toContain("CURATEUR"); // no framing
  });
});
