// Pure folder-tree helpers for the sidebar projects hierarchy (no ctx, no DB).
// ONE source of truth for depth / cycle / path decisions, shared by the Convex
// mutations (server invariants) AND the frontend (picker, sidebar, breadcrumb)
// — same import pattern as lib/envLabel. All functions are total and defensive:
// a dangling parentId (parent deleted concurrently) is treated as a root, and
// every walk is guarded by a visited-set so a corrupt chain can never loop.

// Nesting depth is UNLIMITED (user decision) — the only structural invariant
// is acyclicity (canNest). Every walk stays terminating via visited-sets, and
// reads stay bounded by the user's own folder count.

/** Structural node type — matches the listProjects projection without binding
 *  to Convex Id types (kept string-generic so the frontend can pass its rows). */
export type FolderNode = {
  _id: string;
  parentId?: string | null;
  name: string;
  sortKey?: number;
};

// Generic over the caller's row type (the sidebar passes its full Project
// rows and gets them back untouched) — T only needs the FolderNode fields.

function byId<T extends FolderNode>(nodes: T[]): Map<string, T> {
  return new Map(nodes.map((n) => [n._id, n]));
}

/** The node's parent id, normalized: undefined/null/dangling -> null (root). */
function parentOf(map: Map<string, FolderNode>, node: FolderNode): string | null {
  const pid = node.parentId ?? null;
  if (pid === null) return null;
  return map.has(pid) ? pid : null; // dangling parent -> behave as a root
}

function sortSiblings<T extends FolderNode>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.sortKey ?? 0) - (b.sortKey ?? 0));
}

/** Root folders (no parent or dangling parent), in sortKey order. */
export function rootsOf<T extends FolderNode>(nodes: T[]): T[] {
  const map = byId(nodes);
  return sortSiblings(nodes.filter((n) => parentOf(map, n) === null));
}

/** Direct children of `parentId` (null = roots), in sortKey order. */
export function childrenOf<T extends FolderNode>(
  nodes: T[],
  parentId: string | null,
): T[] {
  const map = byId(nodes);
  return sortSiblings(nodes.filter((n) => parentOf(map, n) === parentId));
}

/** 1-based depth of a folder (root = 1). Unknown id -> 0. */
export function depthOf(nodes: FolderNode[], id: string): number {
  const map = byId(nodes);
  let node = map.get(id);
  if (node === undefined) return 0;
  const seen = new Set<string>([id]);
  let depth = 1;
  for (;;) {
    const pid = parentOf(map, node);
    if (pid === null || seen.has(pid)) return depth;
    seen.add(pid);
    node = map.get(pid)!;
    depth++;
  }
}

/** All ids of the subtree rooted at `id` (id INCLUDED), BFS order. */
export function subtreeIds(nodes: FolderNode[], id: string): string[] {
  const map = byId(nodes);
  if (!map.has(id)) return [];
  // children adjacency, dangling-normalized
  const kids = new Map<string, string[]>();
  for (const n of nodes) {
    const pid = parentOf(map, n);
    if (pid === null) continue;
    const list = kids.get(pid);
    if (list === undefined) kids.set(pid, [n._id]);
    else list.push(n._id);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const k of kids.get(cur) ?? []) queue.push(k);
  }
  return out;
}

/** Would re-parenting `movedId` under `newParentId` create a cycle?
 *  True when the new parent is the moved folder itself or any descendant. */
export function wouldCycle(
  nodes: FolderNode[],
  movedId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === movedId) return true;
  return subtreeIds(nodes, movedId).includes(newParentId);
}

/** Can `movedId` be nested under `newParentId`? Depth is unlimited — the only
 *  rules are acyclicity and that both ids exist (unknown ids fail closed). */
export function canNest(
  nodes: FolderNode[],
  movedId: string,
  newParentId: string | null,
): boolean {
  if (wouldCycle(nodes, movedId, newParentId)) return false;
  if (!nodes.some((n) => n._id === movedId)) return false; // unknown folder
  if (newParentId !== null && !nodes.some((n) => n._id === newParentId)) {
    return false; // unknown parent
  }
  return true;
}

/** Path from the root ancestor down to `id` (id INCLUDED). Unknown id -> []. */
export function pathOf<T extends FolderNode>(nodes: T[], id: string): T[] {
  const map = byId(nodes);
  let node = map.get(id);
  if (node === undefined) return [];
  const seen = new Set<string>([id]);
  const path = [node];
  for (;;) {
    const pid = parentOf(map, node);
    if (pid === null || seen.has(pid)) return path.reverse();
    seen.add(pid);
    node = map.get(pid)!;
    path.push(node);
  }
}

/** The root ancestor's id of `id` (itself when already a root). Unknown -> id. */
export function rootAncestorOf(nodes: FolderNode[], id: string): string {
  const path = pathOf(nodes, id);
  return path.length > 0 ? path[0]._id : id;
}

/** DFS flatten of the whole forest for the "Move to..." picker: every folder
 *  with its 1-based depth, siblings in sortKey order. */
export function flattenForPicker<T extends FolderNode>(
  nodes: T[],
): { node: T; depth: number }[] {
  const out: { node: T; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const child of childrenOf(nodes, parentId)) {
      out.push({ node: child, depth });
      walk(child._id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}
