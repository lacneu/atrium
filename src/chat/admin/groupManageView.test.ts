/// <reference types="vite/client" />
//
// The group "Manage" dialog filter/sort/hide logic. typecheck + build never run
// it and the dialog needs live admin data to reach, so these pin the branches
// the advisor flagged: members-first ordering off a FROZEN snapshot, the
// case-insensitive query across email/name/canonical, and the discovered-only
// agent filter.

import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import {
  filterSortMembers,
  filterInstanceAgents,
  paginate,
  roleLabel,
  selectionState,
  userDisplayParts,
} from "./groupManageView";

const USERS = [
  { userId: "u1", email: "alice@example.com", name: "Alice", canonical: "alice" },
  { userId: "u2", email: null, name: null, canonical: "bob-canon" },
  { userId: "u3", email: "carol@example.com", name: "Carol", canonical: "carol" },
  { userId: "u4", email: "dave@example.com", name: "Dave", canonical: "dave" },
];

describe("filterSortMembers", () => {
  test("empty query lists snapshot-members first, ties keep server order", () => {
    const snapshot = new Set(["u3"]); // only Carol is a member
    const out = filterSortMembers(USERS, "", snapshot);
    expect(out.map((u) => u.userId)).toEqual(["u3", "u1", "u2", "u4"]);
  });

  test("multiple members keep their relative server order", () => {
    const snapshot = new Set(["u4", "u1"]);
    const out = filterSortMembers(USERS, "", snapshot);
    // members first (u1 before u4 = server order), then non-members (u2, u3).
    expect(out.map((u) => u.userId)).toEqual(["u1", "u4", "u2", "u3"]);
  });

  test("query filters by email, name or canonical (case-insensitive)", () => {
    const snapshot = new Set<string>();
    expect(filterSortMembers(USERS, "ALICE", snapshot).map((u) => u.userId)).toEqual([
      "u1",
    ]);
    // matches canonical even when email/name are null.
    expect(filterSortMembers(USERS, "bob", snapshot).map((u) => u.userId)).toEqual([
      "u2",
    ]);
    // email-domain match returns everyone with that domain.
    expect(
      filterSortMembers(USERS, "example.com", snapshot).map((u) => u.userId),
    ).toEqual(["u1", "u3", "u4"]);
  });

  test("query still orders members first within the matches", () => {
    const snapshot = new Set(["u3"]);
    const out = filterSortMembers(USERS, "example.com", snapshot);
    expect(out.map((u) => u.userId)).toEqual(["u3", "u1", "u4"]);
  });

  test("no match returns empty (drives the 'Aucun resultat' branch)", () => {
    expect(filterSortMembers(USERS, "zzz", new Set()).length).toBe(0);
  });

  test("does not mutate the input array", () => {
    const snapshot = new Set(["u4"]);
    const copy = USERS.slice();
    filterSortMembers(USERS, "", snapshot);
    expect(USERS).toEqual(copy);
  });
});

const AGENTS = [
  { agentId: "main", displayName: "Main", source: "discovered" },
  { agentId: "olivier", displayName: "Olivier", source: "discovered" },
  { agentId: "ghost", displayName: "Ghost", source: "configured" },
];

describe("filterInstanceAgents", () => {
  test("empty query returns only discovered agents", () => {
    expect(filterInstanceAgents(AGENTS, "").map((a) => a.agentId)).toEqual([
      "main",
      "olivier",
    ]);
  });

  test("query matches displayName (case-insensitive)", () => {
    expect(filterInstanceAgents(AGENTS, "oliv").map((a) => a.agentId)).toEqual([
      "olivier",
    ]);
  });

  test("query matches the raw agentId too", () => {
    expect(filterInstanceAgents(AGENTS, "MAIN").map((a) => a.agentId)).toEqual([
      "main",
    ]);
  });

  test("a configured (non-discovered) agent never matches", () => {
    expect(filterInstanceAgents(AGENTS, "ghost")).toEqual([]);
  });

  test("no match returns empty (drives the hide-instance branch)", () => {
    expect(filterInstanceAgents(AGENTS, "zzz")).toEqual([]);
  });

  test("falls back to agentId when displayName is missing", () => {
    const agents = [{ agentId: "kappa", displayName: null, source: "discovered" }];
    expect(filterInstanceAgents(agents, "kap").map((a) => a.agentId)).toEqual([
      "kappa",
    ]);
  });
});

describe("userDisplayParts", () => {
  test("name wins, email becomes the secondary line", () => {
    expect(
      userDisplayParts({
        userId: "u1",
        name: "Alice",
        email: "alice@example.com",
        canonical: "alice",
      }),
    ).toEqual({ primary: "Alice", secondary: "alice@example.com" });
  });

  test("name with no email falls back to the @handle as secondary", () => {
    expect(
      userDisplayParts({
        userId: "u1",
        name: "Bob",
        email: null,
        canonical: "bobby",
      }),
    ).toEqual({ primary: "Bob", secondary: "@bobby" });
  });

  test("email-only user shows the email, no secondary", () => {
    expect(
      userDisplayParts({
        userId: "u1",
        name: null,
        email: "carol@example.com",
        canonical: null,
      }),
    ).toEqual({ primary: "carol@example.com", secondary: null });
  });

  test("nameless/email-less user shows the canonical as an @handle (the fix)", () => {
    const parts = userDisplayParts({
      userId: "u1",
      name: null,
      email: null,
      canonical: "u-q576vvxyqp",
    });
    // The whole point: NOT a bare raw id — it reads as an identity.
    expect(parts).toEqual({ primary: "@u-q576vvxyqp", secondary: null });
  });

  test("no canonical at all derives a handle from the userId tail", () => {
    expect(
      userDisplayParts({
        userId: "abcdef0123456789",
        name: null,
        email: null,
        canonical: null,
      }),
    ).toEqual({ primary: "@u-abcdef01", secondary: null });
  });
});

describe("roleLabel", () => {
  test("maps the built-in roles to their localized label", () => {
    expect(roleLabel("admin")).toBe(m.role_admin());
    expect(roleLabel("user")).toBe(m.role_user());
    expect(roleLabel("pending")).toBe(m.role_pending());
  });

  test("a custom role renders its raw key", () => {
    expect(roleLabel("auditor")).toBe("auditor");
  });
});

describe("selectionState", () => {
  const has = (s: Set<string>) => (x: string) => s.has(x);
  test("none / some / all over a filtered set", () => {
    expect(selectionState(["a", "b"], has(new Set()))).toBe("none");
    expect(selectionState(["a", "b"], has(new Set(["a"])))).toBe("some");
    expect(selectionState(["a", "b"], has(new Set(["a", "b"])))).toBe("all");
  });

  test("an empty set is 'none' (not vacuously 'all')", () => {
    // Guards the select-all checkbox from showing checked on an empty list.
    expect(selectionState([], has(new Set()))).toBe("none");
  });
});

describe("paginate", () => {
  const items = [1, 2, 3, 4, 5, 6, 7];

  test("returns the requested page slice", () => {
    expect(paginate(items, 1, 3)).toEqual({
      pageItems: [1, 2, 3],
      page: 1,
      pageCount: 3,
    });
    expect(paginate(items, 2, 3).pageItems).toEqual([4, 5, 6]);
    expect(paginate(items, 3, 3).pageItems).toEqual([7]);
  });

  test("clamps a too-high page to the last page (shrink-safe)", () => {
    const p = paginate(items, 99, 3);
    expect(p.page).toBe(3);
    expect(p.pageItems).toEqual([7]);
  });

  test("clamps a non-positive page to 1", () => {
    expect(paginate(items, 0, 3).page).toBe(1);
    expect(paginate(items, -5, 3).page).toBe(1);
  });

  test("an empty list is page 1 of 1 with no items (never page 0)", () => {
    expect(paginate([], 1, 8)).toEqual({
      pageItems: [],
      page: 1,
      pageCount: 1,
    });
  });

  test("does not mutate the input", () => {
    const copy = items.slice();
    paginate(items, 2, 3);
    expect(items).toEqual(copy);
  });
});
