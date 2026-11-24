// The work zones of a bubble (workZoneView.ts): what is work, where a zone ends, which
// part carries its header, and that a zone is ON VIEW unless the reader folded it.
//
// THE DEFECT THIS LOT ANSWERS. Every reasoning block was folded as soon as the answer
// began and on every settled bubble, each behind its own "Réflexion" header: a reader who
// had asked to see the reasoning had to open each one, in every reply.

import { describe, expect, it } from "vitest";
import {
  chooseZone,
  markWorkZones,
  subscribeZones,
  zoneChoice,
  zoneExpanded,
  zoneHeadedBy,
  zoneSteps,
  type WorkZoneMark,
} from "./workZoneView";

type Part = {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: { zone?: WorkZoneMark };
  data?: { key: string; live?: boolean; zone?: WorkZoneMark };
};

const thought = (key: string, live = false): Part => ({ type: "data-thinking", data: { key, live } });
const note = (key: string): Part => ({ type: "data-commentary", data: { key } });
const action = (id: string): Part => ({ type: "tool-call", toolName: "__turn_flow__", toolCallId: id, args: {} });
const text = (t: string): Part => ({ type: "text", text: t });
const zoneOf = (p: Part): WorkZoneMark | undefined => p.data?.zone ?? p.args?.zone;

function marked(parts: Part[]): Part[] {
  const content = [...parts];
  markWorkZones(content, "m1");
  return content;
}

describe("a zone is on view unless the reader folded it", () => {
  it("unfolded by default, during the turn and after it", () => {
    expect(zoneExpanded(undefined)).toBe(true);
  });

  it("the reader's choice is kept, either way", () => {
    expect(zoneExpanded(false)).toBe(false);
    expect(zoneExpanded(true)).toBe(true);
  });

  it("a choice is told to every part of the zone, and only that zone's", () => {
    let told = 0;
    const stop = subscribeZones(() => told++);
    chooseZone("m1:a", false);
    stop();
    chooseZone("m1:a", false);
    expect(told).toBe(1);
    expect(zoneChoice("m1:a")).toBe(false);
    expect(zoneChoice("m1:b")).toBeUndefined();
  });
});

describe("what a zone is made of", () => {
  it("thoughts, notes and activity groups up to the answer: one zone, headed by its first part", () => {
    const c = marked([action("f1"), thought("t1"), action("f2"), note("n1"), thought("t2"), text("La réponse.")]);
    const zones = c.slice(0, 5).map(zoneOf);
    expect(new Set(zones.map((z) => z?.key))).toEqual(new Set(["m1:f1"]));
    expect(zones.map((z) => z?.head)).toEqual([true, false, false, false, false]);
    expect(zones[0]).toMatchObject({ thoughts: 2, notes: 1, actions: 2, live: false });
    expect(zoneOf(c[5]!)).toBeUndefined();
  });

  it("with the actions hidden, the first thought or note carries the header", () => {
    const c = marked([action("f1"), thought("t1"), action("f2"), thought("t2")]);
    expect(c.map((p) => zoneOf(p)?.proseHead)).toEqual([false, true, false, false]);
    expect(c.map((p) => zoneHeadedBy(zoneOf(p), true))).toEqual([true, false, false, false]);
    expect(c.map((p) => zoneHeadedBy(zoneOf(p), false))).toEqual([false, true, false, false]);
  });

  it("text between two actions is the answer: it ends the zone, and the next work starts another", () => {
    // Told by the part's TYPE (`text`), never by its place: a thought is `data-thinking`.
    const c = marked([thought("t1"), action("f1"), text("Premier constat."), action("f2"), thought("t2"), text("Fin.")]);
    expect(c.map((p) => zoneOf(p)?.key)).toEqual(["m1:t1", "m1:t1", undefined, "m1:f2", "m1:f2", undefined]);
    expect(c.map((p) => zoneOf(p)?.head)).toEqual([true, false, undefined, true, false, undefined]);
  });

  it("an empty text part shows nothing and ends no zone", () => {
    const c = marked([thought("t1"), text("  "), action("f1")]);
    expect(zoneOf(c[2]!)).toMatchObject({ key: "m1:t1", head: false, thoughts: 1, actions: 1 });
  });

  it("work without a thought (reasoning not shown) is no zone: no header, nothing to fold", () => {
    const c = marked([action("f1"), note("n1"), action("f2"), text("La réponse.")]);
    expect(c.map(zoneOf)).toEqual([undefined, undefined, undefined, undefined]);
    expect(zoneHeadedBy(undefined, true)).toBe(false);
  });

  it("a bubble with no work is left as it is", () => {
    const parts = [text("La réponse.")];
    expect(marked(parts)).toEqual(parts);
  });

  it("a zone is live while one of its thoughts is", () => {
    const c = marked([thought("t1"), action("f1"), thought("t2", true)]);
    expect(zoneOf(c[0]!)?.live).toBe(true);
  });

  it("a folded zone counts what it would show", () => {
    const zone = zoneOf(marked([action("f1"), thought("t1"), note("n1"), action("f2")])[0]!)!;
    expect(zoneSteps(zone, true)).toBe(4);
    expect(zoneSteps(zone, false)).toBe(2);
  });
});
