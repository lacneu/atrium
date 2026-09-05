/// <reference types="vitest" />
//
// A job the SCHEDULER switched off must not read as running.
//
// Gateway 2026.8.1 introduced `CronJobState.autoDisabled`
// (`{reason: "consecutive-failures" | "schedule-errors", atMs, consecutiveErrors}`):
// after repeated failures the gateway stops running a job by itself. Nothing like it
// existed at 2026.7.1, which is why `enabled` alone used to tell the whole story.
//
// It no longer does. `enabled` is the CONFIGURED flag and the gateway leaves it `true`
// through an auto-disable, so a job that will never fire again renders exactly like a
// healthy one — the same silent-failure shape as a run reported `ok` whose report was
// delivered nowhere (see cron-delivery-facts.test.ts). This test fails if the fact stops
// crossing the bridge.

import { describe, expect, it } from "vitest";

import { fetchCronJobs } from "../src/server.js";

/** Minimal connection stub: `cron.list` is the only call fetchCronJobs makes. */
function connWith(jobs: unknown[]) {
  return {
    request: async () => ({ payload: { jobs } }),
  } as never;
}

const BASE = {
  id: "job-1",
  name: "weekly cycle",
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * 1" },
  agentId: "olivier",
};

describe("cron auto-disable crosses the bridge", () => {
  it("surfaces the scheduler's own reason while `enabled` still says true", async () => {
    const jobs = await fetchCronJobs(
      connWith([
        {
          ...BASE,
          state: {
            lastRunStatus: "error",
            autoDisabled: {
              reason: "consecutive-failures",
              atMs: 1785359319540,
              consecutiveErrors: 5,
            },
          },
        },
      ]),
    );
    const job = jobs[0]!;
    // The trap this exists for: the configured flag is untouched by the gateway.
    expect(job.enabled).toBe(true);
    expect(job.autoDisabledReason).toBe("consecutive-failures");
    expect(job.autoDisabledAtMs).toBe(1785359319540);
  });

  it("says nothing when the gateway said nothing (pre-2026.8.1 shape)", async () => {
    const jobs = await fetchCronJobs(
      connWith([{ ...BASE, state: { lastRunStatus: "ok" } }]),
    );
    const job = jobs[0]!;
    // `null`, never `false`: an older gateway makes no claim either way, and
    // reporting "not auto-disabled" would be a fact it never stated.
    expect(job.autoDisabledReason).toBeNull();
    expect(job.autoDisabledAtMs).toBeNull();
  });

  it("refuses to invent an auto-disable from a malformed shape", async () => {
    const jobs = await fetchCronJobs(
      connWith([{ ...BASE, state: { autoDisabled: "consecutive-failures" } }]),
    );
    const job = jobs[0]!;
    expect(job.autoDisabledReason).toBeNull();
    expect(job.autoDisabledAtMs).toBeNull();
  });
});
