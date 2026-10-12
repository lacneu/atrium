import { describe, expect, test } from "vitest";
import { deletionStart, type HeadCandidate } from "./displayGroupHead";

const u = (id: string): HeadCandidate => ({ _id: id, role: "user" });
const a = (id: string, g?: string): HeadCandidate => ({ _id: id, role: "assistant", ...(g !== undefined ? { displayGroupId: g } : {}) });

describe("deletionStart — a delegation's answer is deleted from its first bubble (codex phase 5 pass 1 #4)", () => {
  test("a later member: the group's head", () => {
    const list = [u("q"), a("p", "p"), a("d", "p"), a("w", "p")];
    expect(deletionStart(list, list[3]!)._id).toBe("p");
    expect(deletionStart(list, list[2]!)._id).toBe("p");
  });
  test("the head itself, a bubble alone, a user message: unchanged", () => {
    const list = [u("q"), a("p", "p"), a("d", "p"), a("x")];
    expect(deletionStart(list, list[1]!)._id).toBe("p");
    expect(deletionStart(list, list[3]!)._id).toBe("x");
    expect(deletionStart(list, list[0]!)._id).toBe("q");
  });
  test("a stale cache across a message of the user: never widened past it", () => {
    const list = [u("q"), a("p", "p"), u("q2"), a("d", "p")];
    expect(deletionStart(list, list[3]!)._id).toBe("d");
  });
  test("a head not in the list, or after the target: unchanged", () => {
    expect(deletionStart([a("d", "gone")], a("d", "gone"))._id).toBe("d");
    const list = [a("d", "p"), a("p", "p")];
    expect(deletionStart(list, list[0]!)._id).toBe("d");
  });
});

describe("deletionStart on a partial list (codex phase 5 pass 8 #3)", () => {
  test("a head displayed before what the list is proven to hold: the target stays", () => {
    const p = { _id: "p", role: "assistant", displayGroupId: "p", _creationTime: 10 };
    const d = { _id: "d", role: "assistant", displayGroupId: "p", _creationTime: 20 };
    expect(deletionStart([p, d], d, 5)._id).toBe("p");
    expect(deletionStart([p, d], d, 15)._id).toBe("d");
    // A recovered head placed earlier than its creation: judged by its display position.
    const recovered = { _id: "p", role: "assistant", displayGroupId: "p", _creationTime: 30, orderTime: 12 };
    expect(deletionStart([recovered, d], d, 15)._id).toBe("d");
  });
});
