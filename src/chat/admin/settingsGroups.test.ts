import { describe, expect, test } from "vitest";
import {
  ALL_GROUPED_TABS,
  SETTINGS_GROUPS,
  groupOfTab,
  visibleGroups,
} from "./settingsGroups";
import { TABS } from "../AdminSettings";
import { PERMISSIONS } from "../../../convex/lib/rbac";

// Lockstep between the tab universe (TABS) and the navigation groups: every
// tab belongs to EXACTLY one group. Adding a tab without assigning it a group
// (or to two groups) must fail HERE with an actionable message.

describe("SETTINGS_GROUPS ↔ TABS (lockstep)", () => {
  test("every tab belongs to exactly one group", () => {
    const grouped = new Set(ALL_GROUPED_TABS);
    for (const t of TABS) {
      expect(
        grouped.has(t),
        `Tab "${t}" is missing from SETTINGS_GROUPS — assign it to exactly one group in settingsGroups.ts`,
      ).toBe(true);
    }
    expect(
      ALL_GROUPED_TABS.length,
      "A tab appears in MORE than one group (or a grouped tab is not in TABS) — groups must partition TABS",
    ).toBe(TABS.length);
  });

  test("no group references an unknown tab", () => {
    const known = new Set<string>(TABS);
    for (const g of SETTINGS_GROUPS) {
      for (const t of g.tabs) {
        expect(known.has(t), `Group "${g.id}" references unknown tab "${t}"`).toBe(
          true,
        );
      }
    }
  });

  test("groupOfTab is total and matches the declaration", () => {
    for (const g of SETTINGS_GROUPS) {
      for (const t of g.tabs) {
        expect(groupOfTab(t)).toBe(g.id);
      }
    }
  });

  test("group ids are unique and in the designed order", () => {
    expect(SETTINGS_GROUPS.map((g) => g.id)).toEqual([
      "personal",
      "agents",
      "access",
      "observability",
    ]);
  });
});

describe("visibleGroups (RBAC)", () => {
  test("a full-permission holder (admin) sees every group, in order", () => {
    expect(visibleGroups(Object.values(PERMISSIONS))).toEqual([
      "personal",
      "agents",
      "access",
      "observability",
    ]);
  });

  test("a group is visible only when it contains >=1 allowed tab", () => {
    // traces.read → only the observability group surfaces.
    expect(visibleGroups(["traces.read"])).toEqual(["observability"]);
    // chats.read (base user) → only personal (files/preferences/theme).
    expect(visibleGroups(["chats.read"])).toEqual(["personal"]);
    // agents.files.read → only agents (agentFiles).
    expect(visibleGroups(["agents.files.read"])).toEqual(["agents"]);
    expect(visibleGroups([])).toEqual([]);
  });
});
