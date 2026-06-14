import { describe, expect, test } from "vitest";
import { applyGroupReorder, mergeOrder } from "./SettingsNav";
import { TABS, type Tab } from "../AdminSettings";

// mergeOrder is the load-bearing merge for the per-user tab order: saved (valid,
// de-duped) keys first, then any tab NOT yet saved (new tabs), unknown/stale keys
// dropped. It must always return exactly the full TABS set, in a stable order.

describe("mergeOrder", () => {
  test("no saved order -> the default code order, unchanged", () => {
    expect(mergeOrder(null)).toEqual([...TABS]);
    expect(mergeOrder(undefined)).toEqual([...TABS]);
    expect(mergeOrder([])).toEqual([...TABS]);
  });

  test("a saved order is honored, with NEW (unsaved) tabs appended after", () => {
    // Pretend only two tabs were ever saved (in reverse): they lead, the rest
    // follow in code order.
    const out = mergeOrder(["bridge", "users"]);
    expect(out.slice(0, 2)).toEqual(["bridge", "users"]);
    // every other tab still present, exactly once
    expect(new Set(out)).toEqual(new Set(TABS));
    expect(out).toHaveLength(TABS.length);
  });

  test("unknown / stale keys are dropped; duplicates collapse", () => {
    const out = mergeOrder(["users", "ghost-tab", "users", "bridge"]);
    expect(out).not.toContain("ghost-tab");
    expect(out.filter((t) => t === "users")).toHaveLength(1);
    expect(new Set(out)).toEqual(new Set(TABS)); // still the full set
  });

  test("a saved order from before the uiprefs merge drops the retired key", () => {
    // Users who reordered tabs while `uiprefs` existed have it persisted in
    // me.settingsTabOrder; the merge must silently drop it (no ghost tab, no
    // crash) while keeping their order intact.
    const out = mergeOrder(["uiprefs", "preferences", "users"]);
    expect(out).not.toContain("uiprefs");
    expect(out.slice(0, 2)).toEqual(["preferences", "users"]);
    expect(new Set(out)).toEqual(new Set(TABS));
  });

  test("a fully-specified saved order round-trips exactly", () => {
    const reversed = [...TABS].reverse();
    expect(mergeOrder(reversed)).toEqual(reversed);
  });

  test("the CONF-4c/4d tabs exist and surface for a stale saved order", () => {
    // A user whose order was saved BEFORE the new tabs shipped still gets them,
    // appended after the saved keys (the "new tabs appended" contract).
    expect(TABS).toContain("agentFiles");
    expect(TABS).toContain("chatDefaults");
    const out = mergeOrder(["audit", "users"]);
    expect(out).toContain("agentFiles");
    expect(out).toContain("chatDefaults");
  });
});

// applyGroupReorder splices a within-group drag back into the FULL per-user
// order: the dragged group's tabs take the new arrangement IN the positions the
// group already occupied; every other tab (other groups, hidden tabs) stays put.

describe("applyGroupReorder", () => {
  test("reorders only the group's positions; everything else keeps its slot", () => {
    const full: Tab[] = ["users", "traces", "kpi", "groups", "anomalies"];
    // Drag within the observability subset: traces/kpi/anomalies → kpi first.
    const out = applyGroupReorder(full, ["kpi", "anomalies", "traces"]);
    expect(out).toEqual(["users", "kpi", "anomalies", "groups", "traces"]);
  });

  test("an empty or single-tab reorder is the identity", () => {
    const full = [...TABS];
    expect(applyGroupReorder(full, [])).toEqual(full);
    expect(applyGroupReorder(full, ["bridge"])).toEqual(full);
  });

  test("the result is still a permutation of the input order", () => {
    const full = mergeOrder(null);
    const out = applyGroupReorder(full, ["anomalies", "traces", "kpi"]);
    expect(new Set(out)).toEqual(new Set(full));
    expect(out).toHaveLength(full.length);
  });
});
