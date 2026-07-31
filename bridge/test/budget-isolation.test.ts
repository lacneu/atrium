/**
 * The bounded ledger's budgets must not compete (G-70, review pass 8).
 *
 * `protocolDrift` keeps four kinds of finding under caps: reader exceptions and detector
 * failures, announced-but-unclassified EVENT families (OpenClaw), announced-but-
 * unclassified CAPABILITIES (Hermes), and ordinary field drift. Prefixes keep their KEYS
 * apart; that is not the same as keeping their CAPACITY apart, and the difference is what
 * this file exists to hold.
 *
 * The bridge explicitly serves several gateways. With one shared announce budget, a single
 * Hermes instance declaring 32 unknown capabilities filled it, and a brand-new OpenClaw
 * event on ANOTHER instance fell into the anonymous overflow — the operator would see a
 * count and no name, on the one signal that was supposed to arrive before a user did.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { protocolDrift } from "../src/providers/openclaw/protocol-drift.js";

beforeEach(() => {
  protocolDrift.resetForTests();
});

const shapes = (): string[] => protocolDrift.report().map((e) => e.shape);

describe("one provider's flood cannot silence another's", () => {
  it("a Hermes capability flood leaves an OpenClaw announcement NAMED", () => {
    const caps: Record<string, boolean> = {};
    for (let i = 0; i < 40; i += 1) caps[`cap${i}`] = true;
    protocolDrift.observeAnnouncedCapabilities(caps, new Set());
    protocolDrift.observeAnnouncedEvents(["brand.new.family"]);
    expect(shapes()).toContain("«unanticipated-event».brand.new.family");
  });

  it("an OpenClaw event flood leaves a Hermes capability NAMED", () => {
    protocolDrift.observeAnnouncedEvents(
      Array.from({ length: 40 }, (_, i) => `family${i}`),
    );
    protocolDrift.observeAnnouncedCapabilities({ brand_new_cap: true }, new Set());
    expect(shapes()).toContain("«unanticipated-capability».brand_new_cap");
  });

  it("neither flood can silence a reader EXCEPTION", () => {
    // The signal lot 28 called the most serious of the eighteen silent failure paths. It
    // outranks everything here, and nothing a gateway announces may take its slot.
    const caps: Record<string, boolean> = {};
    for (let i = 0; i < 40; i += 1) caps[`cap${i}`] = true;
    protocolDrift.observeAnnouncedCapabilities(caps, new Set());
    protocolDrift.observeAnnouncedEvents(
      Array.from({ length: 40 }, (_, i) => `family${i}`),
    );
    protocolDrift.observeException(
      { type: "event", event: "chat" },
      new TypeError("boom"),
      "feed",
    );
    expect(shapes()[0]?.startsWith("«exception».")).toBe(true);
  });
});
