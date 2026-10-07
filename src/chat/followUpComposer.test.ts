import { describe, expect, it } from "vitest";
import { alternateFollowUp, custodyBadge, primaryFollowUp } from "./followUpComposer";

describe("the composer while the agent works (projection on)", () => {
  it("the preference decides the primary action and what the send carries", () => {
    expect(primaryFollowUp("queue", "steer")).toEqual({ kind: "queue", mode: "queue" });
    expect(primaryFollowUp("steer", "followup")).toEqual({ kind: "steer", mode: "steer" });
  });
  it("no preference: the gateway's mode labels the button, the send carries none", () => {
    expect(primaryFollowUp(null, "steer")).toEqual({ kind: "steer", mode: undefined });
    expect(primaryFollowUp(null, "followup")).toEqual({ kind: "send", mode: undefined });
    expect(primaryFollowUp(null, null)).toEqual({ kind: "send", mode: undefined });
  });
  it("modifier+Enter does the other of queue / steer", () => {
    expect(alternateFollowUp({ kind: "queue", mode: "queue" })).toBe("steer");
    expect(alternateFollowUp({ kind: "steer", mode: undefined })).toBe("queue");
    expect(alternateFollowUp({ kind: "send", mode: undefined })).toBe("queue");
  });
  it("only news gets a badge: accepted / persisted are the ordinary life of a message", () => {
    expect(custodyBadge("accepted")).toBeNull();
    expect(custodyBadge("persisted")).toBeNull();
    expect(custodyBadge(null)).toBeNull();
    for (const c of ["queued", "steered", "cancelled", "interrupted"]) expect(custodyBadge(c)).toBe(c);
  });
});
