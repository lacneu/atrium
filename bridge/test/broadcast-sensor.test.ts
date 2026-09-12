// The RECEIVED-broadcast sensor: a frame whose family is in neither vocabulary —
// announced (`CLASSIFIED_EVENTS`) or broadcast-only (`BROADCAST_ONLY_EVENTS`) — is
// COUNTED on receipt, under a salted digest, on its own budget. Never NAMED: an
// unclassified family name is by definition the wire string nobody vouched for. Without it, such a family is dropped by the
// normalizer in silence until someone re-vendors and the coverage gate speaks.
import { beforeEach, describe, expect, it } from "vitest";
import {
  BROADCAST_ONLY_EVENTS,
  CLASSIFIED_EVENTS,
  MAX_TRACKED_BROADCAST_SHAPES,
  protocolDrift,
  SAFE_NAME_MAX,
  containName,
} from "../src/providers/openclaw/protocol-drift.js";

const shapes = () => protocolDrift.report().map((r) => r.shape);
// The registry is a process-wide singleton and `report()` does not drain it: isolate.
beforeEach(() => protocolDrift.resetForTests());

describe("a broadcast family outside both vocabularies is COUNTED on receipt", () => {
  // DIGESTED, NOT NAMED — changed 2026-09-12. This used to assert the family name
  // verbatim in the counter, which made the sensor publish a wire value: an
  // UNCLASSIFIED name is by definition the string nobody has vouched for, and
  // `containName` is only a charset filter (`AliceMartin` passes it unchanged). The
  // module already stated that rule for its exception sensor and broke it here.
  // What an operator actually needs survives, and is what these now pin: telling one
  // unknown family apart from another, stably, without disclosing either.
  it("an unknown event frame bumps «unanticipated-broadcast».<digest>, never the name", () => {
    protocolDrift.observe({ type: "event", event: "brand.new.broadcast", payload: {}, seq: 3 });
    const seen = shapes();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^«unanticipated-broadcast»\.[0-9a-f]{8}$/);
    expect(seen.some((x) => x.includes("brand.new.broadcast"))).toBe(false);
  });
  it("two different unknown families stay DISTINGUISHABLE, and one stays stable", () => {
    protocolDrift.observe({ type: "event", event: "family.alpha", payload: {} });
    protocolDrift.observe({ type: "event", event: "family.beta", payload: {} });
    protocolDrift.observe({ type: "event", event: "family.alpha", payload: {} });
    // Two counters, not three and not one: the digest separates families and collapses
    // repeats — the whole reason a digest beats a fixed marker.
    expect(new Set(shapes()).size).toBe(2);
  });
  it("a classified broadcast-only family (config.changed) is NOT drift — it is handled", () => {
    expect(BROADCAST_ONLY_EVENTS.has("config.changed")).toBe(true);
    protocolDrift.observe({ type: "event", event: "config.changed", payload: { path: "/x", hash: "h", ts: 1 } });
    expect(shapes().filter((s) => s.includes("config.changed"))).toEqual([]);
  });
  it("an announced family (health, tick) is not drift either", () => {
    expect(CLASSIFIED_EVENTS.has("health")).toBe(true);
    protocolDrift.observe({ type: "event", event: "health", payload: {} });
    protocolDrift.observe({ type: "event", event: "tick", payload: {} });
    const seen = shapes();
    expect(seen, `unexpected drift: ${seen.join(", ")}`).toEqual([]);
  });
  it("a hostile or unprintable name discloses NOTHING — digest, not containment", () => {
    protocolDrift.observe({ type: "event", event: "<script>alert(1)</script>", payload: {} });
    // A charset filter would have reported «unprintable», which says the name was ugly.
    // The digest says nothing at all about it, which is the point.
    expect(shapes()[0]).toMatch(/^«unanticipated-broadcast»\.[0-9a-f]{8}$/);
    expect(shapes().some((x) => x.includes("script"))).toBe(false);
  });
  it("a plausible PERSON NAME is not published either — the case a charset filter passes", () => {
    protocolDrift.observe({ type: "event", event: "AliceMartin", payload: {} });
    expect(shapes().some((x) => x.includes("AliceMartin"))).toBe(false);
  });
  it("a flood of unknown broadcasts is CAPPED at its own budget, and a reader EXCEPTION is still named", () => {
    for (let i = 0; i < 600; i += 1) {
      protocolDrift.observe({ type: "event", event: `flood${i}`, payload: {} });
    }
    protocolDrift.observeException(null, new TypeError("boom"), "feed");
    const all = shapes();
    const broadcasts = all.filter((s) => s.startsWith("«unanticipated-broadcast»"));
    expect(broadcasts.length, "named up to the broadcast budget, no further").toBe(MAX_TRACKED_BROADCAST_SHAPES);
    expect(protocolDrift.overflowCount(), "the rest is counted, not named").toBeGreaterThanOrEqual(600 - MAX_TRACKED_BROADCAST_SHAPES);
    expect(all.some((s) => s.startsWith("«exception».")), "the exception rides its own budget").toBe(true);
  });
});

describe("the broadcast budget is its own", () => {
  it("a flood of unknown broadcasts leaves an unclassified ANNOUNCEMENT named", () => {
    for (let i = 0; i < 200; i += 1) {
      protocolDrift.observe({ type: "event", event: `flood.${i}`, payload: {} });
    }
    protocolDrift.observeAnnouncedEvents(["brand.new.family"]);
    expect(shapes()).toContain("«unanticipated-event».brand.new.family");
  });
});

describe("name containment is the Convex grammar's bound, exactly", () => {
  it("a name of the bound passes, one over it is «unprintable» — the grammar (convex/compat.ts) admits the same length", () => {
    expect(containName("a".repeat(SAFE_NAME_MAX))).toBe("a".repeat(SAFE_NAME_MAX));
    expect(containName("a".repeat(SAFE_NAME_MAX + 1))).toBe("«unprintable»");
    expect(SAFE_NAME_MAX, "ANNOUNCED_NAME is `[A-Za-z][A-Za-z0-9._-]{0,63}`: 64 characters").toBe(64);
  });
});
