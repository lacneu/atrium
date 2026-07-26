// planPartFromTool contract, pinned against REAL update_plan frames captured
// live on OpenClaw 2026.7.1-beta.2 (2026-07-12): the coalesced tool.status of
// the builtin plan tool (input = start args, output = result).

import { describe, expect, it } from "vitest";
import { planPartFromPlanStream, planPartFromTool } from "../src/core/plan-part.js";

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

// --- G-22: the NATIVE `stream:"plan"` event --------------------------------
// The gateway maintains the same plan on its own stream. Two shapes, both read
// from the deployed 2026.7.1 build: `handleTurnPlanUpdated` sends the structured
// entries the tool result also carries, `splitPlanText` sends plain lines.
describe("planPartFromPlanStream (native plan stream)", () => {
  it("the STRUCTURED shape yields a part IDENTICAL to the tool path", () => {
    // The program's own acceptance criterion: the two paths must never diverge.
    const fromTool = planPartFromTool("update_plan", "completed", INPUT, OUTPUT);
    const fromStream = planPartFromPlanStream({
      phase: "update",
      title: "Plan updated",
      source: "codex-app-server",
      explanation: INPUT.explanation,
      steps: INPUT.plan,
    });
    expect(fromStream).toEqual(fromTool);
  });

  it("the PLAIN-LINE shape reads every line as a step, status `pending`", () => {
    // The gateway stated no status: showing progress it never reported would be
    // an invention the reader cannot tell from a real one.
    const p = planPartFromPlanStream({
      phase: "update",
      steps: ["Lire le fichier", "Corriger la fonction", "Lancer les tests"],
    });
    expect(p).toEqual({
      kind: "plan",
      steps: [
        { step: "Lire le fichier", status: "pending" },
        { step: "Corriger la fonction", status: "pending" },
        { step: "Lancer les tests", status: "pending" },
      ],
    });
  });

  it("an empty or malformed payload yields nothing (never an empty plan card)", () => {
    expect(planPartFromPlanStream({ phase: "update", steps: [] })).toBeNull();
    expect(planPartFromPlanStream({ phase: "update" })).toBeNull();
    expect(planPartFromPlanStream(null)).toBeNull();
    expect(planPartFromPlanStream({ steps: [{ nope: 1 }] })).toBeNull();
  });
});
