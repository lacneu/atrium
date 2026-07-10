/// <reference types="vite/client" />
//
// Traces listing — the WINDOWED read path. The discriminating property: a
// from/to window must be served FROM THE INDEX (by_at range), not post-filtered
// out of the newest-N rows of the whole table. The old shape read `take(scan)`
// newest rows THEN applied from/to — so any window buried under more than
// ~MAX_LIST_LIMIT newer events returned SILENTLY EMPTY, which mis-steered a
// live incident investigation (2026-07-09: a few-hours-old anomaly window read
// as "no traces"). These tests seed MORE noise than the scan cap and assert the
// old window is still fully addressable.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seedAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "admin" as const,
      canonical: "boss",
    });
    return userId;
  });
  return t.withIdentity({ subject: `${userId}|session` });
}

describe("listEvents — windowed reads are index-ranged, not newest-N post-filtered", () => {
  test("a window buried under 600 newer events is still fully served (old code: silently empty)", async () => {
    const t = convexTest(schema, modules);
    const as = await seedAdmin(t);
    const W0 = 1_000_000; // the incident window (old)
    await t.run(async (ctx) => {
      // 4 events INSIDE the old window — the incident being investigated.
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("traceEvents", {
          at: W0 + i * 1000,
          kind: "assistant.stream",
          principalType: "system" as const,
          redacted: true,
          meta: JSON.stringify({ phase: "finalize", streamStatus: "error" }),
        });
      }
      // 600 NEWER noise events (> MAX_LIST_LIMIT = 500): the old newest-N scan
      // could never reach past these down to the window.
      for (let i = 0; i < 600; i++) {
        await ctx.db.insert("traceEvents", {
          at: W0 + 100_000 + i * 1000,
          kind: "convex.probe",
          principalType: "system" as const,
          redacted: true,
        });
      }
    });
    const events = await as.query(api.observability.listEvents, {
      filter: { from: W0 - 1, to: W0 + 60_000 },
      limit: 50,
    });
    expect(events.length).toBe(4); // the WHOLE window, despite 600 newer rows
    expect(events.every((e) => e.kind === "assistant.stream")).toBe(true);
    // With the kind filter on top: same result (kind is post-filtered WITHIN
    // the ranged window, not within the global newest-N).
    const byKind = await as.query(api.observability.listEvents, {
      kind: "assistant.stream",
      filter: { from: W0 - 1, to: W0 + 60_000 },
      limit: 50,
    });
    expect(byKind.length).toBe(4);
  });

  test("an un-windowed query still returns the newest rows (unchanged fast path)", async () => {
    const t = convexTest(schema, modules);
    const as = await seedAdmin(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("traceEvents", {
          at: 2_000_000 + i * 1000,
          kind: "api.call",
          principalType: "system" as const,
          redacted: true,
        });
      }
    });
    const events = await as.query(api.observability.listEvents, { limit: 3 });
    expect(events.length).toBe(3);
    expect(events[0]!.at).toBe(2_004_000); // newest first
  });
});
