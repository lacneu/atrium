// The work zones of a bubble (workZoneView.ts): what is work, where a zone ends, which
// part carries its header, and that a zone is ON VIEW unless the reader folded it.
//
// THE DEFECT THIS LOT ANSWERS. Every reasoning block was folded as soon as the answer
// began and on every settled bubble, each behind its own "Réflexion" header: a reader who
// had asked to see the reasoning had to open each one, in every reply.

import { describe, expect, it } from "vitest";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";
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
  args?: { parts?: unknown[]; zone?: WorkZoneMark };
  data?: { key: string; live?: boolean; text?: string; row?: unknown; zone?: WorkZoneMark };
};

const thought = (key: string, live = false): Part => ({ type: "data-thinking", data: { key, live, text: "Je compare." } });
const note = (key: string, body = "Je relis."): Part => ({ type: "data-commentary", data: { key, text: body } });
const action = (id: string): Part => ({ type: "tool-call", toolName: "__turn_flow__", toolCallId: id, args: { parts: [{}] } });
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
    const a = { thoughtIds: ["store:a"] };
    chooseZone(a, false);
    stop();
    chooseZone(a, false);
    expect(told).toBe(1);
    expect(zoneChoice(a)).toBe(false);
    expect(zoneChoice({ thoughtIds: ["store:b"] })).toBeUndefined();
  });
});

describe("what a zone is made of", () => {
  it("thoughts, notes and activity groups up to the answer: one zone, headed by its first part", () => {
    const c = marked([action("f1"), thought("t1"), action("f2"), note("n1"), thought("t2"), text("La réponse.")]);
    const zones = c.slice(0, 5).map(zoneOf);
    expect(new Set(zones.map((z) => z?.key))).toEqual(new Set(["m1:t1"]));
    expect(zones[0]?.thoughtIds).toEqual(["m1:t1", "m1:t2"]);
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
    expect(c.map((p) => zoneOf(p)?.key)).toEqual(["m1:t1", "m1:t1", undefined, "m1:t2", "m1:t2", undefined]);
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

// THE READER'S FOLD FOLLOWS THE REASONING IT FOLDED (review after 0.104.2). A zone was
// named by its first part: a part arriving before it renamed it and the fold was lost, and
// two zones whose first parts shared a key (a row's note pieces around a file) shared one.
// Each case below is the reported shape, converted as the app converts it.

const bubble = (id: string, extra: Record<string, unknown>): ConvexMessageView =>
  ({ _id: id, _creationTime: 0, chatId: "c1", role: "assistant", status: "streaming", text: "", updatedAt: 1, parts: [], ...extra }) as unknown as ConvexMessageView;
const zonesOf = (message: ConvexMessageView): Array<WorkZoneMark | undefined> =>
  (convertConvexMessage(message).content as unknown as Part[]).map(zoneOf);
const some = <T,>(xs: Array<T | undefined>): T[] => xs.filter((x): x is T => x !== undefined);

describe("a zone keeps the reader's fold while the turn is written", () => {
  it("an action row arriving BEFORE the thought leaves the zone folded", () => {
    const before = some(zonesOf(bubble("mA", { rowLayout: [{ entryId: "r2", start: 0, end: 0, thinking: true, blocks: true }] })));
    expect(before).toHaveLength(1);
    chooseZone(before[0]!, false);
    const after = some(
      zonesOf(
        bubble("mA", {
          rowLayout: [
            { entryId: "r1", start: 0, end: 0, tools: [{ toolCallId: "c1", name: "read", status: "result" }], blocks: true },
            { entryId: "r2", start: 0, end: 0, thinking: true, blocks: true },
          ],
          parts: [{ kind: "tool", name: "read", phase: "completed", toolCallId: "c1" }],
        }),
      ),
    );
    // The zone now opens on the action, and it is the same zone to the reader.
    expect(after.map((z) => [z.head, z.actions, z.thoughts])).toEqual([[true, 1, 1], [false, 1, 1]]);
    expect(zoneChoice(after[0]!)).toBe(false);
    expect(zoneExpanded(zoneChoice(after[1]!))).toBe(false);
  });

  it("an earlier thought, a part inside, a piece of answer that splits it: still folded", () => {
    const [zone] = some(marked([thought("x2")]).map(zoneOf));
    chooseZone({ thoughtIds: zone!.thoughtIds.map((id) => `mB:${id}`) }, false);
    const fold = (parts: Part[]) => {
      const c = [...parts];
      markWorkZones(c, "mB:m1");
      return some(c.map(zoneOf)).map((z) => zoneChoice(z));
    };
    expect(fold([thought("x1"), action("f1"), note("n1"), thought("x2")])).toEqual([false, false, false, false]);
    expect(fold([thought("x2"), action("f1"), thought("x3")])).toEqual([false, false, false]);
    // Split by the answer: the half that holds the folded thought stays folded.
    expect(fold([thought("x1"), text("Constat."), thought("x2")])).toEqual([undefined, false]);
  });

  it("two zones that become one take the later choice", () => {
    chooseZone({ thoughtIds: ["mC:a"] }, false);
    chooseZone({ thoughtIds: ["mC:b"] }, true);
    expect(zoneChoice({ thoughtIds: ["mC:a", "mC:b"] })).toBe(true);
  });
});

describe("two zones never share a fold", () => {
  it("a row's thought and its note cut in two by a file, then another row's thought", () => {
    const a = "Je regarde.";
    const b = "Je continue.";
    const content = convertConvexMessage(
      bubble("mD", {
        text: `${a}\n\n${b}`,
        rowLayout: [
          {
            entryId: "r1",
            start: 0,
            end: a.length + 2 + b.length,
            thinking: true,
            commentary: true,
            blocks: true,
            items: [
              { kind: "text", start: 0, end: a.length },
              { kind: "file", blockIndex: 1 },
              { kind: "text", start: a.length + 2, end: a.length + 2 + b.length },
            ],
          },
          { entryId: "r2", start: 0, end: 0, thinking: true, blocks: true },
        ],
      }),
    ).content as unknown as Part[];
    // The shape of the report: thought r1, note r1 | file | note r1, thought r2.
    expect(content.map((p) => p.type)).toEqual(["data-thinking", "data-commentary", "file", "data-commentary", "data-thinking"]);
    expect(content[1]!.data!.key).toBe(content[3]!.data!.key);
    const [first, , , second] = content.map(zoneOf);
    expect(first!.key).not.toBe(second!.key);
    expect(first!.thoughtIds.some((id) => second!.thoughtIds.includes(id))).toBe(false);
    chooseZone(first!, false);
    expect(zoneChoice(first!)).toBe(false);
    expect(zoneChoice(second!)).toBeUndefined();
    expect(zoneExpanded(zoneChoice(zoneOf(content[4]!)!))).toBe(true);
  });
});

describe("the header is carried by a part that shows", () => {
  it("a note emptied of its embed shortcode carries none: the thought after it does", () => {
    const shortcode = '[embed ref="cv_demo" /]';
    const content = convertConvexMessage(
      bubble("mE", {
        status: "complete",
        text: shortcode,
        rowLayout: [
          { entryId: "r1", start: 0, end: shortcode.length, commentary: true, blocks: true },
          { entryId: "r2", start: 0, end: 0, thinking: true, blocks: true },
        ],
        parts: [{ kind: "widget", viewId: "cv_demo" }],
      }),
    ).content as unknown as Part[];
    // The shape of the report: the note is there, and shows nothing (CommentaryNote).
    expect(content.slice(0, 2).map((p) => [p.type, p.data?.text])).toEqual([["data-commentary", ""], ["data-thinking", undefined]]);
    expect(zoneOf(content[0]!)).toBeUndefined();
    const zone = zoneOf(content[1]!)!;
    expect(zoneHeadedBy(zone, true)).toBe(true);
    expect(zoneHeadedBy(zone, false)).toBe(true);
    expect(zone).toMatchObject({ thoughts: 1, notes: 0 });
  });

  it("an empty part of any kind ends no zone and counts for no step", () => {
    const c = marked([thought("t1"), note("n0", " "), { type: "tool-call", toolName: "__turn_flow__", toolCallId: "f0", args: { parts: [] } }, thought("t2")]);
    expect(c.map((p) => zoneOf(p)?.key)).toEqual(["m1:t1", undefined, undefined, "m1:t1"]);
    expect(zoneSteps(zoneOf(c[0]!)!, true)).toBe(2);
  });
});
