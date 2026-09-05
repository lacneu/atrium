/// <reference types="vitest" />
//
// The plan card must survive the tool being RENAMED under it.
//
// Gateway 2026.8.1 REPLACED the builtin `update_plan` with `progress_card`:
// `src/agents/tools` carries update_plan in 1 file at 2026.7.1 and 0 at 2026.8.1,
// progress_card 0 -> 1, and a live 2026.8.1 turn on the bench was observed
// choosing it ("Planning update using progress_card tool"). Reading only the old
// name leaves Atrium's plan card permanently EMPTY on 2026.8.1 — with every gate
// green, because the drift detector is observe-only and no schema went missing.
//
// The two tools are interchangeable for this reader: the argument is
// `plan: [{step, status}]` either way, and the status vocabulary is the same three
// values. `progress_card`'s RESULT carries only a {completed,total} count, never
// the steps, so the INPUT is the sole source of the list on that version.

import { describe, expect, it } from "vitest";

import { planPartFromPlanStream, planPartFromTool } from "../src/core/plan-part.js";

const STEPS = [
  { step: "read the spec", status: "completed" },
  { step: "write the code", status: "in_progress" },
  { step: "prove it", status: "pending" },
];

describe("plan card reads both plan tools", () => {
  it("does NOT read progress_card (gateway 2026.8.1) from the tool path — the native plan stream is its source", () => {
    // The gateway emits the normalized plan stream for every successful call
    // (steps or `[]`), before the count-only result: reading the raw input again
    // appended a second, unnormalized plan (codex P2).
    expect(
      planPartFromTool(
        "progress_card",
        "completed",
        { plan: STEPS },
        { details: { revision: 3, steps: { completed: 1, total: 3 } } },
      ),
    ).toBeNull();
    expect(
      planPartFromTool("progress_card", "completed", { markdown: "x" }, { details: { revision: 4, steps: null } }),
    ).toBeNull();
  });

  it("the native plan STREAM with zero steps is a cleared plan too (delivery runs — codex P2)", () => {
    // 2026.8.x: `steps: normalize(input).steps ?? []` — markdown-only and
    // clearing calls reach the wire as an empty update, tool frame or not.
    expect(
      planPartFromPlanStream({ phase: "update", title: "Plan updated", source: "openclaw", steps: [] }),
    ).toEqual({ kind: "plan", steps: [] });
    // Not an array = not a plan statement at all.
    expect(planPartFromPlanStream({ phase: "update" })).toBeNull();
  });

  it("still reads update_plan (gateway <= 2026.7.x)", () => {
    // compat.ts validates BOTH generations from one bridge binary.
    const part = planPartFromTool(
      "update_plan",
      "completed",
      { plan: STEPS },
      { details: { status: "updated", plan: STEPS } },
    );
    expect(part?.steps).toHaveLength(3);
  });

  it("ignores a tool that is neither, and a non-completed phase", () => {
    expect(planPartFromTool("message", "completed", { plan: STEPS }, {})).toBeNull();
    expect(planPartFromTool("progress_card", "start", { plan: STEPS }, {})).toBeNull();
  });
});
