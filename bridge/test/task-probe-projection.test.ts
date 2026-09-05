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

import { MAX_DISCOVERY_KEYS, projectTaskProbe } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";

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
      ledgerDimensions: true,
      terminalOutcome: null,
      deliveryStatus: null,
      summary: null,
      progressSummary: null,
      error: null,
    });
  });

  it("the probe asks about EVERY session key the registry keeps (codex)", () => {
    // The registry retains N recent keys per chat so a chain that outlived a re-key can
    // still be found. Asking for fewer left the OLDEST retained key unqueried — exactly
    // where such a chain lives — so its next link was never adopted and the delivery
    // lost its anchor. Pinned to ONE number so the two cannot drift apart again.
    expect(MAX_DISCOVERY_KEYS).toBe(SessionRegistry.MAX_RECENT_CHAT_KEYS);
    expect(MAX_DISCOVERY_KEYS).toBeGreaterThan(0);
  });

  it("carries the OTHER TWO dimensions of a finished task (codex)", () => {
    // `status` alone says a task ended; it does not say whether the work SUCCEEDED
    // (`terminalOutcome`) nor whether its report reached the chat (`deliveryStatus`).
    // Dropping them made Convex read every `completed` as a delivered success —
    // settling a blocked task as done, and draining the next queued message while the
    // report was still in flight.
    const projected = projectTaskProbe({
      status: "completed",
      terminalOutcome: "blocked",
      deliveryStatus: "session_queued",
    });
    // …and the FLAG that says this bridge knows about them at all: Convex reads its
    // absence as "an older bridge answered", not as "the registry said nothing".
    expect(projected.ledgerDimensions).toBe(true);
    expect(projectTaskProbe(undefined).ledgerDimensions).toBe(true);
    expect(projected.terminalOutcome).toBe("blocked");
    expect(projected.deliveryStatus).toBe("session_queued");
    // Non-strings project to null like every other field here, never to a lie.
    expect(
      projectTaskProbe({ status: "completed", terminalOutcome: 7, deliveryStatus: {} })
        .terminalOutcome,
    ).toBeNull();
    expect(
      projectTaskProbe({ status: "completed", deliveryStatus: {} }).deliveryStatus,
    ).toBeNull();
  });
});
