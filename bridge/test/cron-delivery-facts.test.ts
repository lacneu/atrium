/// <reference types="vitest" />
//
// A scheduled run that reached NOBODY must not read as a success.
//
// PRODUCTION REPORT, 2026-07-30. A user launched a weekly cycle, was told he could close
// his laptop, and then got silence — he asked three times where it was. What had actually
// happened: the cycle stopped on its own after ~80s for a stated reason, and its failure
// report was resolved to a channel with no target, so it was delivered NOWHERE. Every
// surface still said `status: "ok"`, because `normalizeCronRunEntries` kept `status` and
// threw the whole `delivery` block away — the gateway had computed the answer and Atrium
// discarded it.
//
// The fixture below is that run's payload, taken verbatim from the feedback report rather
// than invented: a test written from the real failure cannot be wrong about its shape.

import { describe, expect, it } from "vitest";

import {
  normalizeCronJobDetail,
  normalizeCronRunEntries,
} from "../src/core/cron-manage.js";

/** The failing run, as the gateway sent it. */
const REAL_RUN = {
  entries: [
    {
      ts: 1785359319540,
      jobId: "abcfe3bd-c0b3-4407-b801-3d29c874bf4c",
      action: "finished",
      status: "ok",
      summary:
        "Cycle incomplet.\n\nBlocage exact : les 4 supports obligatoires à lire avant exécution sont inaccessibles.",
      runAtMs: 1785359238866,
      durationMs: 80661,
      model: "gpt-5.4-mini",
      deliveryStatus: "unknown",
      delivery: {
        intended: { channel: "last", to: null, source: "last" },
        resolved: {
          ok: false,
          channel: "telegram",
          to: null,
          source: "last",
          error: "Delivering to Telegram requires target <chatId>",
        },
        fallbackUsed: false,
        delivered: false,
      },
    },
  ],
};

describe("a run's delivery verdict survives normalization", () => {
  it("the real failing run is marked UNDELIVERED, not ok-and-nothing-else", () => {
    const [run] = normalizeCronRunEntries(REAL_RUN);
    expect(run?.status, "the gateway's own run status is unchanged").toBe("ok");
    expect(
      run?.delivered,
      "this is the fact that was thrown away — the report reached nobody",
    ).toBe(false);
  });

  it("it says WHERE it went and WHY it failed, in the gateway's own words", () => {
    // Without these an operator sees "not delivered" and has no idea what to fix.
    const [run] = normalizeCronRunEntries(REAL_RUN);
    expect(run?.deliveryChannel).toBe("telegram");
    expect(run?.deliveryError).toContain("requires target");
  });

  it("the summary is kept — it is the report the user never received", () => {
    const [run] = normalizeCronRunEntries(REAL_RUN);
    expect(run?.summary).toContain("Cycle incomplet");
  });
});

describe("what is NOT an undelivered run", () => {
  it("a job that delivers nowhere ON PURPOSE is not flagged", () => {
    // The same report contained a diagnostic job with `delivery: {mode: "none"}`.
    // Flagging those would fill the surface with non-events, and a signal that is always
    // on gets ignored — then weakened.
    const [run] = normalizeCronRunEntries({
      entries: [
        {
          ts: 1,
          status: "ok",
          summary: "diagnostic",
          delivery: {
            intended: { channel: "none", to: null, source: "job" },
            delivered: false,
          },
        },
      ],
    });
    expect(run?.delivered, "a deliberate no-delivery is not a failure").toBeNull();
  });

  it("a payload that says NOTHING about delivery yields null, never false", () => {
    // Silence is not a verdict. Reading absence as failure would invent a defect on every
    // gateway build that does not report delivery at all.
    const [run] = normalizeCronRunEntries({
      entries: [{ ts: 1, status: "ok", summary: "s" }],
    });
    expect(run?.delivered).toBeNull();
    expect(run?.deliveryChannel).toBeNull();
  });

  it("a DELIVERED run is marked delivered", () => {
    const [run] = normalizeCronRunEntries({
      entries: [
        {
          ts: 1,
          status: "ok",
          summary: "s",
          delivery: {
            intended: { channel: "announce" },
            resolved: { ok: true, channel: "announce" },
            delivered: true,
          },
        },
      ],
    });
    expect(run?.delivered).toBe(true);
  });
});

describe("a job knows which conversation created it", () => {
  it("the owner session key is carried, not dropped", () => {
    // The only thing that can answer "where should this report have landed?". The gateway
    // sends it on every job; Atrium used to discard it, which is why an undelivered
    // report had nowhere to go.
    const job = normalizeCronJobDetail({
      id: "abcfe3bd",
      name: "Cycle hebdomadaire complet",
      owner: {
        agentId: "fabien",
        sessionKey: "agent:fabien:atrium:chat:fabien.lacombe:mh76frkhrejs92f9dnckzmjhfn8ake4b",
      },
      delivery: { mode: "none" },
    });
    expect(job.ownerSessionKey).toContain("mh76frkhrejs92f9dnckzmjhfn8ake4b");
  });

  it("a job with no owner reports null rather than a guess", () => {
    expect(normalizeCronJobDetail({ id: "x" }).ownerSessionKey).toBeNull();
  });
});

// ONE `cron.list` must answer "which jobs failed to deliver their last report".
//
// The scheduler maintains that verdict on the JOB (`state.lastDelivered`), not only
// inside the run history — so detecting an undelivered report costs one call per
// instance instead of walking every job's runs. Atrium kept `lastRunStatus` from that
// same state block and dropped the delivery fields sitting next to it, which is why
// the only way to notice Fabien's lost report was to open the run history by hand.
describe("a job carries its LAST run's delivery outcome", () => {
  it("an undelivered last run is readable from the job alone", () => {
    const job = normalizeCronJobDetail({
      id: "abcfe3bd",
      name: "Cycle hebdomadaire complet",
      state: {
        lastRunAtMs: 1785359238866,
        lastRunStatus: "ok",
        lastDelivered: false,
        lastDeliveryStatus: "unknown",
        lastDeliveryError: "Delivering to Telegram requires target <chatId>",
      },
    });
    expect(job.lastDelivered).toBe(false);
    expect(job.lastRunAtMs).toBe(1785359238866);
    expect(job.lastDeliveryError).toContain("requires target");
    expect(job.lastRunStatus, "the run itself still reads ok").toBe("ok");
  });

  it("SILENCE stays null — it is not a failure", () => {
    // A gateway build that reports nothing about delivery must not make every job
    // look broken. Same rule as CronRunEntry.delivered, same reason.
    const job = normalizeCronJobDetail({ id: "x", state: { lastRunStatus: "ok" } });
    expect(job.lastDelivered).toBeNull();
    expect(job.lastDeliveryError).toBeNull();
    expect(job.lastRunAtMs).toBeNull();
  });

  it("a non-boolean lastDelivered is refused, not coerced", () => {
    // `"false"`, `0` and `null` are all truthiness traps; only a real boolean is a
    // verdict. Coercing would flag a delivered run as lost.
    for (const bogus of ["false", 0, null, {}]) {
      expect(
        normalizeCronJobDetail({ id: "x", state: { lastDelivered: bogus } })
          .lastDelivered,
      ).toBeNull();
    }
  });

  it("a DELIVERED last run says so", () => {
    expect(
      normalizeCronJobDetail({ id: "x", state: { lastDelivered: true } })
        .lastDelivered,
    ).toBe(true);
  });
});
