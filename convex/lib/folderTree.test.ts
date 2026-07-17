// The folder-tree invariants: depth / height / cycle / path / flatten, plus the
// defensive behaviors (dangling parent -> root, corrupt chains never loop).

import { describe, expect, test } from "vitest";
import {
  canNest,
  childrenOf,
  depthOf,
  flattenForPicker,
  pathOf,
  rootAncestorOf,
  rootsOf,
  subtreeIds,
  wouldCycle,
  type FolderNode,
} from "./folderTree";

// A / A1 / A11 (3 levels) + B root + B1 child. sortKeys make B sort before A.
const NODES: FolderNode[] = [
  { _id: "A", parentId: null, name: "Client ACME", sortKey: 2 },
  { _id: "A1", parentId: "A", name: "Devis", sortKey: 0 },
  { _id: "A11", parentId: "A1", name: "2026", sortKey: 0 },
  { _id: "B", parentId: null, name: "Perso", sortKey: 1 },
  { _id: "B1", parentId: "B", name: "Sante", sortKey: 0 },
];

describe("roots/children ordering", () => {
  test("roots are sortKey-ordered; children scoped to their parent", () => {
    expect(rootsOf(NODES).map((n) => n._id)).toEqual(["B", "A"]);
    expect(childrenOf(NODES, "A").map((n) => n._id)).toEqual(["A1"]);
    expect(childrenOf(NODES, null).map((n) => n._id)).toEqual(["B", "A"]);
  });
});

describe("depthOf / subtreeIds", () => {
  test("1-based depth, BFS subtree includes self", () => {
    expect(depthOf(NODES, "A")).toBe(1);
    expect(depthOf(NODES, "A1")).toBe(2);
    expect(depthOf(NODES, "A11")).toBe(3);
    expect(depthOf(NODES, "nope")).toBe(0);
    expect(subtreeIds(NODES, "A")).toEqual(["A", "A1", "A11"]);
    expect(subtreeIds(NODES, "B")).toEqual(["B", "B1"]);
  });
});

describe("cycle nesting rules (depth is unlimited)", () => {
  test("self, direct and indirect cycles are refused", () => {
    expect(wouldCycle(NODES, "A", "A")).toBe(true);
    expect(wouldCycle(NODES, "A", "A1")).toBe(true); // child
    expect(wouldCycle(NODES, "A", "A11")).toBe(true); // grandchild
    expect(wouldCycle(NODES, "A1", "B")).toBe(false);
    expect(wouldCycle(NODES, "A", null)).toBe(false);
  });
  test("canNest allows ANY acyclic move (arbitrary depth), refuses cycles + unknown ids", () => {
    // Depth is unlimited: nesting whole subtrees anywhere acyclic is fine.
    expect(canNest(NODES, "A1", "B1")).toBe(true); // 4 levels — allowed
    expect(canNest(NODES, "A", "B1")).toBe(true); // 5 levels — allowed
    expect(canNest(NODES, "A11", "B1")).toBe(true);
    expect(canNest(NODES, "A", null)).toBe(true);
    // Cycles always refused.
    expect(canNest(NODES, "A", "A11")).toBe(false);
    expect(canNest(NODES, "A", "A")).toBe(false);
    // Unknown ids fail closed.
    expect(canNest(NODES, "nope", "B")).toBe(false);
    expect(canNest(NODES, "A11", "nope")).toBe(false);
  });
});

describe("pathOf / rootAncestorOf / flattenForPicker", () => {
  test("path runs root -> id; rootAncestor collapses to the top", () => {
    expect(pathOf(NODES, "A11").map((n) => n._id)).toEqual(["A", "A1", "A11"]);
    expect(pathOf(NODES, "B").map((n) => n._id)).toEqual(["B"]);
    expect(pathOf(NODES, "nope")).toEqual([]);
    expect(rootAncestorOf(NODES, "A11")).toBe("A");
    expect(rootAncestorOf(NODES, "B")).toBe("B");
    expect(rootAncestorOf(NODES, "nope")).toBe("nope");
  });
  test("flatten is DFS with 1-based depth, siblings sortKey-ordered", () => {
    expect(
      flattenForPicker(NODES).map((e) => `${e.depth}:${e.node._id}`),
    ).toEqual(["1:B", "2:B1", "1:A", "2:A1", "3:A11"]);
  });
});

describe("defensive behaviors", () => {
  test("dangling parentId behaves as a root everywhere", () => {
    const dangling: FolderNode[] = [
      { _id: "X", parentId: "GONE", name: "Orphan" },
      { _id: "X1", parentId: "X", name: "Child" },
    ];
    expect(rootsOf(dangling).map((n) => n._id)).toEqual(["X"]);
    expect(depthOf(dangling, "X")).toBe(1);
    expect(depthOf(dangling, "X1")).toBe(2);
    expect(pathOf(dangling, "X1").map((n) => n._id)).toEqual(["X", "X1"]);
    expect(rootAncestorOf(dangling, "X1")).toBe("X");
  });
  test("a corrupt parent cycle in the DATA never loops", () => {
    const corrupt: FolderNode[] = [
      { _id: "P", parentId: "Q", name: "P" },
      { _id: "Q", parentId: "P", name: "Q" },
    ];
    // Walks terminate via the visited-set; exact values matter less than
    // termination, but pin them so a behavior change is visible.
    expect(depthOf(corrupt, "P")).toBe(2);
    expect(pathOf(corrupt, "P").map((n) => n._id)).toEqual(["Q", "P"]);
    expect(subtreeIds(corrupt, "P")).toContain("P");
  });
});
