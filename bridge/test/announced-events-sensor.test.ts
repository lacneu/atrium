/**
 * The ANNOUNCED-event sensor (W9 slice 2b, point 7 — G-70).
 *
 * The in-repo ratchet (events-coverage.test.ts) proves the VENDORED catalogue is fully
 * classified. It cannot say anything about the gateway actually on the other end of the
 * socket — a deployment can run a build newer than anything vendored, and that is exactly
 * when a family nobody has looked at shows up.
 *
 * So the handshake reads `hello-ok.features.events` and counts only what the vendored
 * contract NEVER ANTICIPATED. The discipline that makes this usable rather than noisy:
 * announced-and-classified is silent, including the 25 families classified `ignored` or
 * `gap`. Flooding the ledger with those would leave exit indicator #3 ("shapes in
 * `status:"new"` ⇒ 0") permanently red on known entries, and an indicator that is always
 * red gets ignored, then weakened — the tautological guard of lot 25 by another road.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  CLASSIFIED_EVENTS,
  protocolDrift,
} from "../src/providers/openclaw/protocol-drift.js";

const UNANTICIPATED = "«unanticipated-event».";
const reported = (): string[] =>
  protocolDrift
    .report()
    .filter((e) => e.shape.startsWith(UNANTICIPATED))
    .map((e) => e.shape.slice(UNANTICIPATED.length));

beforeEach(() => {
  protocolDrift.resetForTests();
});

describe("what the gateway announces is compared to what we classified", () => {
  it("a family the vendored contract never anticipated is counted", () => {
    protocolDrift.observeAnnouncedEvents(["chat", "quantum.entangled"]);
    expect(reported()).toEqual(["quantum.entangled"]);
  });

  it("EVERY classified family is silent — including `ignored` and `gap` ones", () => {
    // The whole catalogue at once. 25 of these are not read by Atrium; none of them is
    // news, because a human already wrote down why. Silence here is the feature.
    protocolDrift.observeAnnouncedEvents([...CLASSIFIED_EVENTS]);
    expect(reported()).toEqual([]);
  });

  it("the same unanticipated family across reconnects counts, it does not multiply rows", () => {
    protocolDrift.observeAnnouncedEvents(["quantum.entangled"]);
    protocolDrift.observeAnnouncedEvents(["quantum.entangled"]);
    const rows = protocolDrift
      .report()
      .filter((e) => e.shape.startsWith(UNANTICIPATED));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
  });

  it("it is reported in the RESERVED sensor budget, ahead of field drift", () => {
    // A bounded report keeps a PREFIX. An announcement is a count of one on the day it
    // matters, so a flood of unknown fields must not be able to push it off the end —
    // the failure lot 28 found for the exception sensor, arriving by another door.
    protocolDrift.observeAnnouncedEvents(["quantum.entangled"]);
    // The filler must OUTRANK the announcement on the ordinary sort, or this test passes
    // whatever the budget does: with everything at count 1 the announcement stays first
    // by insertion order alone. A neutralization proved exactly that about the first
    // version of this test — it was green with the sensor classification removed.
    for (let i = 0; i < 50; i += 1) {
      for (let n = 0; n < 3; n += 1) {
        protocolDrift.observe({
          type: "event",
          event: "chat",
          payload: { state: "delta", [`filler${i}`]: 1 },
        });
      }
    }
    const report = protocolDrift.report();
    expect(report[0]?.count, "the filler must outrank it on count").toBeLessThan(
      report.filter((e) => !e.shape.startsWith(UNANTICIPATED))[0]?.count ?? 0,
    );
    expect(report[0]?.shape.startsWith(UNANTICIPATED)).toBe(true);
  });
});

describe("announcements can never starve the reader-exception sensor", () => {
  it("a flood of unknown ANNOUNCEMENTS still leaves a reader exception NAMED", () => {
    // Review pass 5. Announcements shared the 32-slot sensor budget with exceptions and
    // detector failures, so a gateway announcing 32 unknown families at handshake — a
    // newer build, or a hostile one — filled it, and the next reader exception was
    // aggregated into `overflowCount` instead of being named. That inverts lot 28's
    // explicit priority: a reader exception is the most serious signal this registry
    // carries, and it is a count of one on the day it matters.
    protocolDrift.observeAnnouncedEvents(
      Array.from({ length: 64 }, (_, i) => `unknown.family${i}`),
    );
    protocolDrift.observeException({ type: "event", event: "chat" }, new TypeError("boom"), "feed");
    const named = protocolDrift.report().filter((e) => e.shape.startsWith("«exception»."));
    expect(named, "the reader exception must still have a NAME of its own").toHaveLength(1);
  });

  it("the exception is reported AHEAD of the announcements", () => {
    protocolDrift.observeAnnouncedEvents(
      Array.from({ length: 40 }, (_, i) => `unknown.family${i}`),
    );
    protocolDrift.observeException({ type: "event", event: "chat" }, new TypeError("boom"), "feed");
    expect(protocolDrift.report()[0]?.shape.startsWith("«exception».")).toBe(true);
  });
});

describe("the sensor can never break the handshake", () => {
  it("a non-array `features.events` is ignored, not thrown", () => {
    for (const bad of [undefined, null, "chat", 42, {}, true]) {
      expect(() => protocolDrift.observeAnnouncedEvents(bad)).not.toThrow();
    }
    expect(reported()).toEqual([]);
  });

  it("non-string and empty entries are skipped, the rest still counted", () => {
    protocolDrift.observeAnnouncedEvents([null, "", 7, "quantum.entangled", {}]);
    expect(reported()).toEqual(["quantum.entangled"]);
  });

  it("a hostile name is CONTAINED, because this string is stored and travels", () => {
    // Same rule as the exception sensor: the name came off the wire, and it ends up in a
    // Convex row an operator reads. Shape, never verbatim prose.
    protocolDrift.observeAnnouncedEvents(["../../etc/passwd", "a".repeat(200)]);
    expect(reported()).toEqual(["«unprintable»"]);
  });
});

// ── The HERMES half: a published CAPABILITY nobody classified ──────────────────
//
// Review pass 6 found the claim "Atrium already reads /v1/capabilities" was false: the
// method existed and nothing called it. A definition is not a consumption — the exact
// confusion this lot's own classification kept making. The discovery poll now reads it,
// and what it does with the answer is tested here.

describe("a capability the gateway publishes and nobody classified", () => {
  it("is counted, while every classified one stays silent", () => {
    protocolDrift.observeAnnouncedCapabilities(
      { session_chat: true, brand_new_thing: true },
      new Set(["session_chat"]),
    );
    const rows = protocolDrift
      .report()
      .filter((e) => e.shape.startsWith("«unanticipated-capability»."));
    expect(rows.map((r) => r.shape)).toEqual([
      "«unanticipated-capability».brand_new_thing",
    ]);
  });

  it("a capability declared FALSE is not offered, so it is not news", () => {
    protocolDrift.observeAnnouncedCapabilities({ not_offered: false }, new Set());
    expect(
      protocolDrift.report().filter((e) => e.shape.includes("unanticipated-capability")),
    ).toEqual([]);
  });

  it("a malformed payload can never break the discovery poll", () => {
    for (const bad of [undefined, null, "nope", 42, []]) {
      expect(() =>
        protocolDrift.observeAnnouncedCapabilities(bad, new Set()),
      ).not.toThrow();
    }
  });
});
