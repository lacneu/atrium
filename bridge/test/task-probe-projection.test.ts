/// <reference types="vitest" />
//
// The BRIDGE hop of `TaskSummary.progressSummary` (2026-07-31).
//
// Review caught the coverage manifest certifying this field with a proof that never
// touched the bridge: the referenced test called Convex's mutation directly with an
// already-built value, so deleting the probe projection in server.ts would have
// stayed green — a proof that does not prove, inside the very machinery built to
// forbid those. This test IS the bridge hop: the projection that turns a gateway
// `tasks.get` payload into what the probe ships to Convex.

import { describe, expect, it } from "vitest";

import { projectTaskProbe } from "../src/server.js";

describe("projectTaskProbe — the probe's projection of one gateway task", () => {
  it("keeps the running task's progress line", () => {
    const p = projectTaskProbe({
      status: "running",
      progressSummary: "Veille 3/8 — analyse en cours",
    });
    expect(p.progressSummary).toBe("Veille 3/8 — analyse en cours");
    expect(p.status).toBe("running");
    expect(p.summary, "no terminal summary while running").toBeNull();
  });

  it("caps every model-authored string — prose cannot reach chat chrome unbounded", () => {
    const p = projectTaskProbe({
      status: "x".repeat(100),
      terminalSummary: "y".repeat(5000),
      progressSummary: "z".repeat(5000),
      error: "e".repeat(5000),
    });
    expect(p.status?.length).toBe(40);
    expect(p.summary?.length).toBe(600);
    expect(p.progressSummary?.length).toBe(600);
    expect(p.error?.length).toBe(400);
  });

  it("absence and non-strings project to null, never to a lie", () => {
    // A gateway that says nothing about progress must not make the indicator
    // blink between text and nothing — Convex's absence-does-not-erase rule
    // (convex/taskProgress.test.ts) starts from this null.
    expect(projectTaskProbe({ status: "running" }).progressSummary).toBeNull();
    expect(projectTaskProbe({ progressSummary: 42 }).progressSummary).toBeNull();
    expect(projectTaskProbe(undefined)).toEqual({
      status: null,
      summary: null,
      progressSummary: null,
      error: null,
    });
  });
});
