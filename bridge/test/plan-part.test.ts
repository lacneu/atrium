// planPartFromTool contract, pinned against REAL update_plan frames captured
// live on OpenClaw 2026.7.1-beta.2 (2026-07-12): the coalesced tool.status of
// the builtin plan tool (input = start args, output = result).

import { describe, expect, it } from "vitest";
import { planPartFromTool } from "../src/core/plan-part.js";

// Verbatim (trimmed) from the capture: the 2nd update of a 4-step plan.
const INPUT = {
  explanation: "La liste actuelle est vide.",
  plan: [
    { step: "Lister les cron jobs actuels", status: "completed" },
    { step: "Calculer 17 x 23", status: "in_progress" },
    { step: "Determiner la date de demain", status: "pending" },
    { step: "Resumer les operations", status: "pending" },
  ],
};
const OUTPUT = {
  content: [],
  details: {
    status: "updated",
    explanation: "La liste actuelle est vide.",
    plan: INPUT.plan,
  },
};

describe("planPartFromTool (real captured shapes)", () => {
  it("a successful update becomes a plan part (details authoritative)", () => {
    const p = planPartFromTool("update_plan", "completed", INPUT, OUTPUT);
    expect(p).toEqual({
      kind: "plan",
      steps: [
        { step: "Lister les cron jobs actuels", status: "completed" },
        { step: "Calculer 17 x 23", status: "in_progress" },
        { step: "Determiner la date de demain", status: "pending" },
        { step: "Resumer les operations", status: "pending" },
      ],
      explanation: "La liste actuelle est vide.",
    });
  });

  it("falls back to the INPUT plan when the result omits details", () => {
    const p = planPartFromTool("update_plan", "completed", INPUT, { content: [] });
    expect(p?.steps).toHaveLength(4);
    expect(p?.explanation).toBe("La liste actuelle est vide.");
  });

  it("an errored call yields null; other tools yield null", () => {
    expect(planPartFromTool("update_plan", "error", INPUT, OUTPUT)).toBeNull();
    expect(planPartFromTool("cron", "completed", INPUT, OUTPUT)).toBeNull();
  });

  it("bounds: caps step text/explanation, drops malformed rows, unknown status -> pending", () => {
    const p = planPartFromTool(
      "update_plan",
      "completed",
      {
        plan: [
          { step: "s".repeat(1000), status: "weird" },
          { notAStep: true },
          { step: "ok", status: "completed" },
        ],
        explanation: "e".repeat(2000),
      },
      {},
    );
    expect(p?.steps).toHaveLength(2);
    expect(p?.steps[0]).toEqual({ step: "s".repeat(300), status: "pending" });
    expect(p?.steps[1]?.status).toBe("completed");
    expect(p?.explanation?.length).toBe(500);
  });

  it("an empty or missing plan yields null (no empty cards)", () => {
    expect(
      planPartFromTool("update_plan", "completed", { plan: [] }, {}),
    ).toBeNull();
    expect(planPartFromTool("update_plan", "completed", {}, {})).toBeNull();
  });
});
