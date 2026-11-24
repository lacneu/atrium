import { describe, expect, test } from "vitest";
import { pickFitLevel, SCROLLBAR_HYSTERESIS } from "@/lib/useFitLevel";
import {
  filterChatsByTitle,
  projectBarState,
  projectColumnsFit,
  reorderSlot,
  unreadChatIds,
} from "./projectPageView";

describe("reorderSlot (drop-between-items keys)", () => {
  const list = [
    { id: "a", key: 1 },
    { id: "b", key: 2 },
    { id: "c", key: 3 },
  ];
  const getId = (t: (typeof list)[number]) => t.id;
  const getKey = (t: (typeof list)[number]) => t.key;
  test("same-container move lands AT the target position", () => {
    // c dropped on a -> [c, a, b]: between nothing and a.
    expect(reorderSlot(list, getId, getKey, "c", "a")).toEqual({
      prevKey: null,
      nextKey: 1,
    });
    // a dropped on b -> [b, a, c].
    expect(reorderSlot(list, getId, getKey, "a", "b")).toEqual({
      prevKey: 2,
      nextKey: 3,
    });
  });
  test("foreign item inserts BEFORE the target", () => {
    expect(reorderSlot(list, getId, getKey, "zz", "b")).toEqual({
      prevKey: 1,
      nextKey: 2,
    });
    expect(reorderSlot(list, getId, getKey, "zz", "a")).toEqual({
      prevKey: null,
      nextKey: 1,
    });
  });
  test("unknown target -> null", () => {
    expect(reorderSlot(list, getId, getKey, "a", "nope")).toBeNull();
  });
});

describe("filterChatsByTitle", () => {
  const chats = [
    { _id: "1", title: "Migration DB" },
    { _id: "2", title: "Question facture" },
    { _id: "3", title: null }, // untitled
  ];
  test("empty term keeps everything (untitled included)", () => {
    expect(filterChatsByTitle(chats, "  ")).toHaveLength(3);
  });
  test("case-insensitive substring; untitled never matches a term", () => {
    expect(filterChatsByTitle(chats, "MIGRATION").map((c) => c._id)).toEqual(["1"]);
    expect(filterChatsByTitle(chats, "facture").map((c) => c._id)).toEqual(["2"]);
    expect(filterChatsByTitle(chats, "zzz")).toHaveLength(0);
  });
});

describe("unreadChatIds (sidebar parity)", () => {
  test("unread = read row exists AND lastAssistantAt beyond it; no row = quiet", () => {
    const chats = [
      { _id: "a", title: null, lastAssistantAt: 100 },
      { _id: "b", title: null, lastAssistantAt: 100 },
      { _id: "c", title: null, lastAssistantAt: null },
      { _id: "d", title: null, lastAssistantAt: 100 }, // no read row
    ];
    const reads = [
      { chatId: "a", lastSeenAt: 50 }, // unread
      { chatId: "b", lastSeenAt: 150 }, // seen after
      { chatId: "c", lastSeenAt: 50 }, // nothing from assistant
    ];
    expect(unreadChatIds(chats, reads)).toEqual(new Set(["a"]));
  });
});


// Lot 6 (2026-11): on a phone the columns view came down to columns of one to three
// characters and the bar asked 509 px of 324 — both now follow MEASURED widths.
describe("columns view or one level (arbitration n°5)", () => {
  // A parent column (220 px) and the current one (240 px), as their probes measure.
  const TWO = 461;
  test("room for two readable columns: the columns view", () => {
    expect(pickFitLevel(projectColumnsFit(980, TWO))).toBe(0);
    expect(pickFitLevel(projectColumnsFit(TWO, TWO))).toBe(0);
  });
  test("short of it (a phone, 312 px): the current folder alone", () => {
    expect(pickFitLevel(projectColumnsFit(TWO - 1, TWO))).toBe(1);
    expect(pickFitLevel(projectColumnsFit(312, TWO))).toBe(1);
  });
  test("the probes not laid out yet (0): no verdict, the columns stay", () => {
    expect(pickFitLevel(projectColumnsFit(312, 0))).toBe(0);
  });
});

describe("the project bar's levels: labels, icons, then the ⋯ menu", () => {
  test("level 0 keeps every label; 1 drops them; 2 moves the new-item actions", () => {
    expect(projectBarState(0)).toEqual({ labels: true, moved: false });
    expect(projectBarState(1)).toEqual({ labels: false, moved: false });
    expect(projectBarState(2)).toEqual({ labels: false, moved: true });
  });
  test("measured: the level is the first one whose clone fits the header", () => {
    // Labels 509 px, icons 230 px (the bar at 360 px, French), header 312 px.
    expect(projectBarState(pickFitLevel({ available: 312, required: [509, 230] }))).toEqual({
      labels: false,
      moved: false,
    });
    expect(projectBarState(pickFitLevel({ available: 200, required: [509, 230] })).moved).toBe(true);
    expect(projectBarState(pickFitLevel({ available: 860, required: [509, 230] })).labels).toBe(true);
  });
});

describe("the columns' own scrollbar cannot swap the two views forever (lot 11)", () => {
  // A parent column longer than the current folder makes the columns view the
  // TALLER one: it brings the page's scrollbar, and a classic one takes its width
  // from the view. Seen live: 468 px without it, 453 px with it, around a 460 px
  // threshold — 18 swaps in seconds.
  const TWO = 460;
  const SCROLLBAR = 17;
  function run(free: number, band: number): number[] {
    let level = 0;
    const seen: number[] = [];
    for (let frame = 0; frame < 8; frame++) {
      const width = level === 0 ? free - SCROLLBAR : free;
      level = pickFitLevel(projectColumnsFit(width, TWO), level, band);
      seen.push(level);
    }
    return seen;
  }

  test("without a band, it flickers within one scrollbar of the threshold", () => {
    for (let free = TWO; free < TWO + SCROLLBAR; free++) {
      expect(new Set(run(free, 0).slice(2)).size, `at ${free} px`).toBe(2);
    }
  });

  test("with the band, it settles after one step", () => {
    for (let free = TWO - 4; free < TWO + 2 * SCROLLBAR; free++) {
      expect(new Set(run(free, SCROLLBAR_HYSTERESIS).slice(1)).size, `at ${free} px`).toBe(1);
    }
  });
});
