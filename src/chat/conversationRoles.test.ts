import { describe, expect, test } from "vitest";

import {
  arrivalRoleFor,
  assignableRoles,
  invitableRoles,
  managesRoom,
  mayRemove,
} from "./conversationRoles";

// Mirrors convex/chatParticipants.ts `mayChangeRole`: a control the panel shows
// must be one the server accepts.

describe("who manages the room", () => {
  test("the owner and a manager; a member and a viewer do not", () => {
    expect(managesRoom("owner")).toBe(true);
    expect(managesRoom("manager")).toBe(true);
    expect(managesRoom("member")).toBe(false);
    expect(managesRoom("viewer")).toBe(false);
    expect(managesRoom(undefined)).toBe(false);
  });
});

describe("which roles a person may give", () => {
  test("the owner gives any role to anyone", () => {
    expect(assignableRoles("owner", "manager", false)).toEqual([
      "viewer",
      "member",
      "manager",
    ]);
  });

  test("a manager re-roles viewers and members, never into manager", () => {
    expect(assignableRoles("manager", "viewer", false)).toEqual(["viewer", "member"]);
  });

  test("a manager never touches another manager, nor themselves", () => {
    expect(assignableRoles("manager", "manager", false)).toEqual([]);
    expect(assignableRoles("manager", "member", true)).toEqual([]);
  });

  test("a member or a viewer changes nobody", () => {
    expect(assignableRoles("member", "viewer", false)).toEqual([]);
    expect(assignableRoles("viewer", "viewer", false)).toEqual([]);
  });
});

describe("who may remove whom", () => {
  test("the owner removes any participant; a manager removes all but managers", () => {
    expect(mayRemove("owner", "manager", false)).toBe(true);
    expect(mayRemove("manager", "member", false)).toBe(true);
    expect(mayRemove("manager", "manager", false)).toBe(false);
    expect(mayRemove("member", "viewer", false)).toBe(false);
  });

  test("removing oneself is leaving, not removing", () => {
    expect(mayRemove("owner", "member", true)).toBe(false);
  });
});

describe("what an invitation may carry", () => {
  test("a manager invites viewers and members only", () => {
    expect(invitableRoles("owner")).toEqual(["viewer", "member", "manager"]);
    expect(invitableRoles("manager")).toEqual(["viewer", "member"]);
    expect(invitableRoles("member")).toEqual([]);
  });
});

describe("the role an invitation carries", () => {
  test("kept when the reader may grant it here, else member", () => {
    expect(arrivalRoleFor("manager", "owner")).toBe("manager");
    // Picked as owner of one room, carried into one the reader only manages.
    expect(arrivalRoleFor("manager", "manager")).toBe("member");
    expect(arrivalRoleFor("viewer", "manager")).toBe("viewer");
    expect(arrivalRoleFor("viewer", "member")).toBe("member");
  });
});
