import { describe, expect, test } from "vitest";
import {
  filterChatsByTitle,
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

