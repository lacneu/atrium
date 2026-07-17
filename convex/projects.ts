// Per-user projects: named groupings of chats in the sidebar. Active-user scoped.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireActive } from "./lib/access";
import { auditImpersonated } from "./lib/audit";
import { cascadeDeleteChat } from "./chats";
import {
  canNest,
  childrenOf,
  pathOf,
  subtreeIds,
  type FolderNode,
} from "./lib/folderTree";

/** All of the user's project rows, shaped for the pure folderTree helpers,
 *  plus the raw docs (for fields the tree does not carry, e.g. color).
 *  Bounded by the user's own folder count (the by_user index). */
async function userFolderNodes(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<{
  rows: FolderNode[];
  docs: Map<string, Doc<"projects">>;
}> {
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return {
    rows: projects.map((p) => ({
      _id: p._id as string,
      parentId: (p.parentId ?? null) as string | null,
      name: p.name,
      sortKey: p.sortKey ?? 0,
    })),
    docs: new Map(projects.map((p) => [p._id as string, p])),
  };
}

/** New-sibling sort key: above the current minimum among the SAME parent's
 *  children (fractional keys only compare between siblings). */
function minSiblingKey(rows: FolderNode[], parentId: string | null): number {
  const keys = rows
    .filter((r) => (r.parentId ?? null) === parentId)
    .map((r) => r.sortKey ?? 0);
  return keys.length > 0 ? Math.min(...keys) : 0;
}

export async function requireOwnedProject(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  projectId: Id<"projects">,
) {
  const project = await ctx.db.get(projectId);
  if (project === null) throw new Error("Not found: project");
  if (project.userId !== userId) throw new Error("Forbidden: project not owned");
  return project;
}

export const listProjects = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActive(ctx);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    projects.sort((a, b) => (a.sortKey ?? 0) - (b.sortKey ?? 0));
    return projects.map((p) => ({
      _id: p._id,
      name: p.name,
      color: p.color ?? null,
      collapsed: p.collapsed ?? false,
      sortKey: p.sortKey ?? 0,
      parentId: p.parentId ?? null,
    }));
  },
});

export const createProject = mutation({
  args: {
    name: v.string(),
    // Optional parent folder (absent = root). Depth is UNLIMITED — ownership
    // of the parent is the only gate.
    parentId: v.optional(v.id("projects")),
  },
  handler: async (ctx, { name, parentId }) => {
    const { userId, actor } = await requireActive(ctx);
    if (parentId !== undefined) {
      await requireOwnedProject(ctx, userId, parentId);
    }
    const { rows } = await userFolderNodes(ctx, userId);
    const projectId = await ctx.db.insert("projects", {
      userId,
      name,
      sortKey: minSiblingKey(rows, parentId ?? null) - 1,
      parentId,
    });
    await auditImpersonated(ctx, actor, "project.create", {
      resource: "project",
      resourceId: projectId,
    });
    return projectId;
  },
});

/** Re-parent a folder in the hierarchy (null = make it a root). Depth is
 *  unlimited — only CYCLES are refused (a folder can never move into its own
 *  subtree). */
export const moveProject = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("projects"), v.null()),
  },
  handler: async (ctx, { projectId, parentId }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedProject(ctx, userId, projectId);
    if (parentId !== null) await requireOwnedProject(ctx, userId, parentId);
    const { rows } = await userFolderNodes(ctx, userId);
    if (!canNest(rows, projectId, parentId)) {
      throw new Error("Invalid: folder move would create a cycle");
    }
    await ctx.db.patch(projectId, {
      parentId: parentId ?? undefined,
      // Drop at the TOP of the destination's children (same model as
      // moveChatToProject).
      sortKey: minSiblingKey(rows, parentId) - 1,
    });
    await auditImpersonated(ctx, actor, "project.move", {
      resource: "project",
      resourceId: projectId,
    });
  },
});

/** Move a project in the sidebar's folder order — fractional key between the
 *  drop slot's neighbours (same model as chats.reorderChat). */
export const reorderProject = mutation({
  args: {
    projectId: v.id("projects"),
    prevKey: v.union(v.number(), v.null()),
    nextKey: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { projectId, prevKey, nextKey }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedProject(ctx, userId, projectId);
    let key: number;
    if (prevKey === null && nextKey === null) key = 0;
    else if (prevKey === null) key = nextKey! - 1;
    else if (nextKey === null) key = prevKey + 1;
    else key = (prevKey + nextKey) / 2;
    await ctx.db.patch(projectId, { sortKey: key });
  },
});

export const renameProject = mutation({
  args: { projectId: v.id("projects"), name: v.string() },
  handler: async (ctx, { projectId, name }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedProject(ctx, userId, projectId);
    await ctx.db.patch(projectId, { name });
    await auditImpersonated(ctx, actor, "project.rename", {
      resource: "project",
      resourceId: projectId,
    });
  },
});

// Same preset palette as chats (see chats.CHAT_COLORS) — one vocabulary for
// every sidebar tint so the charte can theme them together.
const PROJECT_COLORS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;
const projectColorValidator = v.union(
  ...PROJECT_COLORS.map((c) => v.literal(c)),
  v.null(),
);

/** The project's sidebar tint (rail + header dot). null clears back to the
 *  AUTO hue (a stable per-project hue derived client-side). */
export const setProjectColor = mutation({
  args: { projectId: v.id("projects"), color: projectColorValidator },
  handler: async (ctx, { projectId, color }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedProject(ctx, userId, projectId);
    await ctx.db.patch(projectId, { color: color ?? undefined });
  },
});

export const setProjectCollapsed = mutation({
  args: { projectId: v.id("projects"), collapsed: v.boolean() },
  handler: async (ctx, { projectId, collapsed }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedProject(ctx, userId, projectId);
    await ctx.db.patch(projectId, { collapsed });
  },
});

// Count the chats inside a project (for the delete-confirmation message).
// DEPRECATED in favor of projectTreeCount (recursive) — kept so a client
// deployed against the previous bundle keeps working; remove later.
export const projectChatCount = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedProject(ctx, userId, projectId);
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    return chats.filter((c) => !c.archived).length;
  },
});

// Per-folder read bound for tree-wide counts/deletes. Depth <= 3 keeps the
// subtree small; the residual (a folder holding more) is documented on
// deleteProject below.
const TREE_CHAT_CAP = 1000;

/** Recursive counts for the delete-confirmation message: every folder of the
 *  subtree (the folder itself EXCLUDED from `folders`) + their non-archived
 *  chats. */
export const projectTreeCount = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedProject(ctx, userId, projectId);
    const { rows } = await userFolderNodes(ctx, userId);
    const ids = subtreeIds(rows, projectId);
    let chats = 0;
    for (const id of ids) {
      const inFolder = await ctx.db
        .query("chats")
        .withIndex("by_project", (q) =>
          q.eq("projectId", id as Id<"projects">),
        )
        .take(TREE_CHAT_CAP);
      chats += inFolder.filter((c) => !c.archived).length;
    }
    return { folders: ids.length - 1, chats };
  },
});

// The folder page reads at most this many DIRECT chats (the sidebar's own
// window is far smaller; a folder holding more keeps working, the tail is
// reachable via search).
const PAGE_CHAT_CAP = 500;

/** Everything the folder page renders, in ONE reactive query: breadcrumb,
 *  sub-folder cards (with recursive counts + last activity) and the folder's
 *  direct conversations. Args are a raw string (pattern getSessionMeta): a
 *  malformed/deleted id returns null so the page renders its own "not found"
 *  state instead of the router error screen. Owner-scoped. */
export const projectPage = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("projects", projectId);
    if (id === null) return null;
    const project = await ctx.db.get(id);
    if (project === null) return null;
    if (project.userId !== userId) {
      throw new Error("Forbidden: project not owned");
    }
    const { rows, docs } = await userFolderNodes(ctx, userId);

    // Reads a folder's direct chats, hidden kinds/archived filtered out —
    // the same visibility rules as the sidebar's listChats.
    const chatsOf = async (folderId: Id<"projects">, cap: number) => {
      const raw = await ctx.db
        .query("chats")
        .withIndex("by_project", (q) => q.eq("projectId", folderId))
        .take(cap);
      return raw.filter((c) => !c.archived && c.kind === undefined);
    };

    // Sub-folder cards: direct counts + recursive chat count + last activity
    // over the card's whole subtree. Bounded by the user's own folder count
    // and TREE_CHAT_CAP per folder.
    const children = [];
    for (const child of childrenOf(rows, id)) {
      const ids = subtreeIds(rows, child._id);
      let chatCount = 0;
      let recursiveChatCount = 0;
      let lastActivityAt: number | null = null;
      for (const fid of ids) {
        const inFolder = await chatsOf(fid as Id<"projects">, TREE_CHAT_CAP);
        recursiveChatCount += inFolder.length;
        if (fid === child._id) chatCount = inFolder.length;
        for (const c of inFolder) {
          if (lastActivityAt === null || c.updatedAt > lastActivityAt) {
            lastActivityAt = c.updatedAt;
          }
        }
      }
      children.push({
        _id: child._id as Id<"projects">,
        name: child.name,
        color: docs.get(child._id)?.color ?? null,
        sortKey: child.sortKey ?? 0,
        folderCount: childrenOf(rows, child._id).length,
        chatCount,
        recursiveChatCount,
        lastActivityAt,
      });
    }

    // Direct conversations, sorted with the sidebar's comparator (pinned
    // first, then manual sortKey, then recency).
    const direct = await chatsOf(id, PAGE_CHAT_CAP);
    direct.sort((a, b) => {
      const pa = a.pinned ? 0 : 1;
      const pb = b.pinned ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const ka = a.sortKey ?? 0;
      const kb = b.sortKey ?? 0;
      if (ka !== kb) return ka - kb;
      return b.updatedAt - a.updatedAt;
    });

    return {
      project: {
        _id: id,
        name: project.name,
        color: project.color ?? null,
        parentId: project.parentId ?? null,
      },
      breadcrumb: pathOf(rows, id).map((n) => ({
        _id: n._id as Id<"projects">,
        name: n.name,
      })),
      children,
      chats: direct.map((c) => ({
        _id: c._id,
        title: c.title ?? null,
        color: c.color ?? null,
        pinned: c.pinned ?? false,
        sortKey: c.sortKey ?? 0,
        updatedAt: c.updatedAt,
        lastAssistantAt: c.lastAssistantAt ?? null,
        // WORKING-SET state: is this chat currently shown in the left sidebar?
        // (pinned always shows; the page's toggle drives setChatSidebar).
        inSidebar: c.sidebarHidden !== true || c.pinned === true,
      })),
    };
  },
});

/** The Finder-style COLUMN view's data, in ONE reactive query: one column per
 *  level from the ROOT down to `projectId` (each column = the folders of that
 *  level + the parent's direct chats). Column 0 is the root level (root
 *  folders + unfiled chats) — the "general view". Bounded: the path length is
 *  bounded by the user's own folder count (cycles are structurally refused),
 *  PAGE_CHAT_CAP chats per column. */
export const folderColumns = query({
  args: { projectId: v.union(v.string(), v.null()) },
  handler: async (ctx, { projectId }) => {
    const { userId } = await requireActive(ctx);
    const { rows, docs } = await userFolderNodes(ctx, userId);

    // Resolve the selected path (empty = root only). A malformed/foreign id
    // degrades to the root column rather than erroring — the page owns the
    // not-found state through projectPage already.
    let path: string[] = [];
    if (projectId !== null) {
      const id = ctx.db.normalizeId("projects", projectId);
      if (id !== null) {
        const doc = await ctx.db.get(id);
        if (doc !== null && doc.userId === userId) {
          path = pathOf(rows, id).map((n) => n._id);
        }
      }
    }

    const chatComparator = (
      a: { pinned?: boolean; sortKey?: number; updatedAt: number },
      b: { pinned?: boolean; sortKey?: number; updatedAt: number },
    ) => {
      const pa = a.pinned ? 0 : 1;
      const pb = b.pinned ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const ka = a.sortKey ?? 0;
      const kb = b.sortKey ?? 0;
      if (ka !== kb) return ka - kb;
      return b.updatedAt - a.updatedAt;
    };

    // Chats of one folder level (null = unfiled). Same visibility rules as
    // the folder page; per-level bound.
    const chatsOfLevel = async (parentId: Id<"projects"> | null) => {
      let raw;
      if (parentId === null) {
        // Unfiled chats have NO by_project row match (projectId undefined) —
        // read the recent slice via by_user_updated and filter, bounded.
        raw = (
          await ctx.db
            .query("chats")
            .withIndex("by_user_updated", (q) => q.eq("userId", userId))
            .order("desc")
            .take(PAGE_CHAT_CAP)
        ).filter((c) => c.projectId === undefined);
      } else {
        raw = await ctx.db
          .query("chats")
          .withIndex("by_project", (q) => q.eq("projectId", parentId))
          .take(PAGE_CHAT_CAP);
      }
      return raw
        .filter((c) => !c.archived && c.kind === undefined)
        .sort(chatComparator)
        .map((c) => ({
          _id: c._id,
          title: c.title ?? null,
          color: c.color ?? null,
          pinned: c.pinned ?? false,
          sortKey: c.sortKey ?? 0,
          updatedAt: c.updatedAt,
          lastAssistantAt: c.lastAssistantAt ?? null,
          inSidebar: c.sidebarHidden !== true || c.pinned === true,
        }));
    };

    // Column i shows the CONTENT of path[i-1] (column 0 = the root level).
    const levels: (string | null)[] = [null, ...path];
    const columns = [];
    for (const level of levels) {
      const folders = childrenOf(rows, level).map((f) => ({
        _id: f._id as Id<"projects">,
        name: f.name,
        color: docs.get(f._id)?.color ?? null,
        sortKey: f.sortKey ?? 0,
        // The child of this level that the path continues through (renders
        // as the selected entry of the column).
        selected: path.includes(f._id),
      }));
      columns.push({
        folderId: level as Id<"projects"> | null,
        folders,
        chats: await chatsOfLevel(level as Id<"projects"> | null),
      });
    }
    return { columns };
  },
});

/** The LIST (tree) view's data: the current folder's whole SUBTREE — every
 *  descendant folder plus each folder's direct chats. The client builds the
 *  indented tree with the pure helpers (childrenOf) and owns the fold state.
 *  Bounded by the user's own folder count and PAGE_CHAT_CAP per folder.
 *  Same null-on-missing contract as projectPage. */
export const projectTreeList = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("projects", projectId);
    if (id === null) return null;
    const project = await ctx.db.get(id);
    if (project === null) return null;
    if (project.userId !== userId) {
      throw new Error("Forbidden: project not owned");
    }
    const { rows, docs } = await userFolderNodes(ctx, userId);
    const ids = subtreeIds(rows, id); // BFS, id included
    const folders = ids
      .filter((f) => f !== (id as string))
      .map((f) => {
        const d = docs.get(f)!;
        return {
          _id: f as Id<"projects">,
          name: d.name,
          color: d.color ?? null,
          // parentId RELATIVE to the subtree: a DIRECT child of the viewed
          // folder ships null (the root itself is not in this array, so its
          // id would be a dangling reference the tree helpers normalize to
          // root anyway — making the contract explicit instead).
          parentId: (d.parentId === id
            ? null
            : (d.parentId ?? null)) as Id<"projects"> | null,
          sortKey: d.sortKey ?? 0,
        };
      });
    const chats = [];
    for (const fid of ids) {
      const inFolder = (
        await ctx.db
          .query("chats")
          .withIndex("by_project", (q) =>
            q.eq("projectId", fid as Id<"projects">),
          )
          .take(PAGE_CHAT_CAP)
      ).filter((c) => !c.archived && c.kind === undefined);
      for (const c of inFolder) {
        chats.push({
          _id: c._id,
          folderId: fid as Id<"projects">,
          title: c.title ?? null,
          color: c.color ?? null,
          pinned: c.pinned ?? false,
          sortKey: c.sortKey ?? 0,
          updatedAt: c.updatedAt,
          lastAssistantAt: c.lastAssistantAt ?? null,
          inSidebar: c.sidebarHidden !== true || c.pinned === true,
        });
      }
    }
    // Pre-sorted (pinned first, then recency) — the client groups by folder
    // and the per-group order falls out of this stable sort.
    chats.sort((a, b) => {
      const pa = a.pinned ? 0 : 1;
      const pb = b.pinned ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return b.updatedAt - a.updatedAt;
    });
    return { rootId: id, folders, chats };
  },
});

// Delete a project SUBTREE and cascade-delete its chats (+ their messages/
// parts/outbox). The user explicitly confirms with the recursive counts
// (projectTreeCount + confirmWord client-side); here we perform the
// destructive work. Deletion order is leaves-first so a mid-mutation failure
// never leaves a child pointing at a deleted parent for long — and readers
// treat a dangling parentId as a root anyway (lib/folderTree).
// RESIDUAL (documented, inherited from the previous flat version): each folder
// deletes at most take(500) chats in this mutation; a folder holding more
// keeps the excess (visible, re-deletable). A scheduled continuation is the
// planned hardening if real trees ever hit this.
export const deleteProject = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedProject(ctx, userId, projectId);
    const { rows } = await userFolderNodes(ctx, userId);
    // BFS order is parents-first; reverse for leaves-first deletion.
    const ids = subtreeIds(rows, projectId).reverse();
    for (const id of ids) {
      const chats = await ctx.db
        .query("chats")
        .withIndex("by_project", (q) =>
          q.eq("projectId", id as Id<"projects">),
        )
        .take(500);
      for (const c of chats) await cascadeDeleteChat(ctx, c._id);
      await ctx.db.delete(id as Id<"projects">);
    }
    // ONE audit row for the whole subtree, on the root the user acted on.
    await auditImpersonated(ctx, actor, "project.delete", {
      resource: "project",
      resourceId: projectId,
    });
  },
});
