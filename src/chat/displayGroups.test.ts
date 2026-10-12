import { describe, expect, test } from "vitest";
import { displayGroupPlaces, groupInputsChanged, groupInputsOf, writeTargetId, type GroupedMessage } from "./displayGroups";

const user = (id: string): GroupedMessage => ({ _id: id, role: "user", text: "q" });
const reply = (id: string, text: string, displayGroupId?: string): GroupedMessage => ({
  _id: id,
  role: "assistant",
  text,
  ...(displayGroupId !== undefined ? { displayGroupId } : {}),
});

describe("displayGroupPlaces — a delegation chain reads as one answer", () => {
  test("consecutive members: the first heads, the others follow, the last copies the whole", () => {
    const places = displayGroupPlaces([user("u"), reply("p", "Je délègue.", "p"), reply("a", "Résultat.", "p"), reply("w", "Fini.", "p")]);
    const groupText = "Je délègue.\n\nRésultat.\n\nFini.";
    expect(Object.fromEntries(places)).toEqual({
      p: { follows: false, continues: true, firstId: "p", groupText },
      a: { follows: true, continues: true, firstId: "p", groupText },
      w: { follows: true, continues: false, firstId: "p", groupText },
    });
  });

  test("a message in between splits the cache's group: each side reads alone (never spans a message)", () => {
    const places = displayGroupPlaces([user("u"), reply("p", "Je délègue.", "p"), user("u2"), reply("a", "Résultat.", "p")]);
    expect(places.size).toBe(0);
  });

  test("a bubble alone, or without a group, is untouched", () => {
    expect(displayGroupPlaces([user("u"), reply("p", "x", "p"), reply("q", "y")]).size).toBe(0);
  });

  test("two different groups side by side stay apart", () => {
    const places = displayGroupPlaces([reply("p", "1", "p"), reply("a", "2", "p"), reply("q", "3", "q"), reply("b", "4", "q")]);
    expect(places.get("a")).toEqual({ follows: true, continues: false, firstId: "p", groupText: "1\n\n2" });
    expect(places.get("q")).toEqual({ follows: false, continues: true, firstId: "q", groupText: "3\n\n4" });
  });

  test("an empty member adds nothing to the copied text", () => {
    const places = displayGroupPlaces([reply("p", "", "p"), reply("a", "Résultat.", "p")]);
    expect(places.get("a")?.groupText).toBe("Résultat.");
  });
});

describe("groupInputsChanged — the groups follow the real text (codex phase 5 pass 4 #3)", () => {
  const list = (last: string, status = "complete") => [
    { ...user("u"), status: "complete" },
    { ...reply("p", "Je délègue.", "p"), status: "complete" },
    { ...reply("a", last, "p"), status },
  ];
  test("a same-length terminal correction recomputes (\"Oui.\" → \"Non.\")", () => {
    const before = groupInputsOf(list("Oui."));
    const after = groupInputsOf(list("Non."));
    expect(groupInputsChanged(before, after)).toBe(true);
    expect(displayGroupPlaces(list("Non.")).get("a")?.groupText).toBe("Je délègue.\n\nNon.");
  });
  test("nothing changed: no recompute; a streaming member's tokens never recompute", () => {
    expect(groupInputsChanged(groupInputsOf(list("Oui.")), groupInputsOf(list("Oui.")))).toBe(false);
    expect(groupInputsChanged(groupInputsOf(list("Ou", "streaming")), groupInputsOf(list("Oui", "streaming")))).toBe(false);
    expect(groupInputsChanged(groupInputsOf(list("Oui", "streaming")), groupInputsOf(list("Oui.")))).toBe(true);
  });
});

describe("writeTargetId — an action that writes sends the bubble acted on (codex phase 5 pass 9 #1)", () => {
  test("never the group's head, which only the server can prove", () => {
    expect(writeTargetId({ messageId: "d", groupFirstId: "p" })).toBe("d");
    expect(writeTargetId({ messageId: "x" })).toBe("x");
  });
});
