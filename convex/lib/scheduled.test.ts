// The scheduled-jobs policy: a user sees ONLY the jobs of their entitled
// agents; a null-agent job resolves to the instance default; unknown default
// FAILS CLOSED (never guess another user's automation). Plus the defensive
// parse of the bridge /cron-list body.

import { describe, expect, test } from "vitest";
import {
  filterJobsForAgents,
  parseCronListResponse,
  type CronJobSummary,
} from "./scheduled";

function job(over: Partial<CronJobSummary>): CronJobSummary {
  return {
    id: "j1",
    name: "daily",
    enabled: true,
    schedule: "0 9 * * 1",
    nextRunAtMs: 1_800_000_000_000,
    lastRunStatus: "ok",
    agentId: null,
    ...over,
  };
}

describe("filterJobsForAgents", () => {
  test("keeps only jobs whose agent is in the user's entitlements", () => {
    const jobs = [
      job({ id: "a", agentId: "alice" }),
      job({ id: "b", agentId: "bob" }),
      job({ id: "c", agentId: "files" }),
    ];
    const mine = filterJobsForAgents(jobs, ["alice", "files"], "alice");
    expect(mine.map((j) => j.id)).toEqual(["a", "c"]);
  });

  test("null agentId resolves to the instance default agent", () => {
    const jobs = [job({ id: "d", agentId: null })];
    expect(
      filterJobsForAgents(jobs, ["alice"], "alice").map((j) => j.id),
    ).toEqual(["d"]);
    // default agent NOT entitled -> hidden
    expect(filterJobsForAgents(jobs, ["bob"], "alice")).toEqual([]);
  });

  test("fails closed: unknown default + null-agent job is NOT shown", () => {
    const jobs = [job({ id: "d", agentId: null })];
    expect(filterJobsForAgents(jobs, ["alice"], null)).toEqual([]);
  });

  test("stamps effectiveAgentId (explicit and defaulted)", () => {
    const jobs = [
      job({ id: "a", agentId: "files" }),
      job({ id: "b", agentId: null }),
    ];
    const mine = filterJobsForAgents(jobs, ["files", "alice"], "alice");
    expect(mine.map((j) => [j.id, j.effectiveAgentId])).toEqual([
      ["a", "files"],
      ["b", "alice"],
    ]);
  });
});

describe("parseCronListResponse", () => {
  test("maps a well-formed bridge body", () => {
    const parsed = parseCronListResponse({
      ok: true,
      jobs: [
        {
          id: "x",
          name: "weekly",
          enabled: false,
          schedule: "0 9 * * 1",
          nextRunAtMs: 123,
          lastRunStatus: "ok",
          agentId: "alice",
        },
      ],
    });
    expect(parsed).toEqual([
      {
        id: "x",
        name: "weekly",
        enabled: false,
        schedule: "0 9 * * 1",
        nextRunAtMs: 123,
        lastRunStatus: "ok",
        agentId: "alice",
      },
    ]);
  });

  test("normalizes missing / wrong-typed fields to null (agent ABSENT)", () => {
    const parsed = parseCronListResponse({
      jobs: [{ id: 42, enabled: "yes", nextRunAtMs: "soon" }],
    });
    expect(parsed).toEqual([
      {
        id: null,
        name: null,
        enabled: null,
        schedule: null,
        nextRunAtMs: null,
        lastRunStatus: null,
        agentId: null,
      },
    ]);
  });

  test("fails closed on a PRESENT-but-malformed agentId (never 'default')", () => {
    // null downstream means "the gateway default agent" — a malformed pin must
    // DROP the job, or it would be re-attributed to the default agent's users.
    const parsed = parseCronListResponse({
      jobs: [
        { id: "bad-empty", agentId: "" },
        { id: "bad-number", agentId: 7 },
        { id: "ok-null", agentId: null },
        { id: "ok-named", agentId: "alice" },
      ],
    });
    expect(parsed?.map((j) => [j.id, j.agentId])).toEqual([
      ["ok-null", null],
      ["ok-named", "alice"],
    ]);
  });

  test("rejects non-object bodies and missing jobs array", () => {
    expect(parseCronListResponse(null)).toBeNull();
    expect(parseCronListResponse("oops")).toBeNull();
    expect(parseCronListResponse({ jobs: "none" })).toBeNull();
  });

  test("drops non-object entries inside jobs", () => {
    const parsed = parseCronListResponse({ jobs: [null, "x", job({})] });
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.id).toBe("j1");
  });
});
