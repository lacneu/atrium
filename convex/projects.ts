// Per-user projects: named groupings of chats in the sidebar. Active-user scoped.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireActive } from "./lib/access";
import { auditImpersonated } from "./lib/audit";
import { cascadeDeleteChat } from "./chats";

async function requireOwnedProject(
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
    }));
  },
});

export const createProject = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const { userId, actor } = await requireActive(ctx);
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const minKey = existing.length
      ? Math.min(...existing.map((p) => p.sortKey ?? 0))
      : 0;
    const projectId = await ctx.db.insert("projects", {
      userId,
      name,
      sortKey: minKey - 1,
    });
    await auditImpersonated(ctx, actor, "project.create", {
      resource: "project",
      resourceId: projectId,
    });
    return projectId;
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

export const setProjectCollapsed = mutation({
  args: { projectId: v.id("projects"), collapsed: v.boolean() },
  handler: async (ctx, { projectId, collapsed }) => {
    const { userId } = await requireActive(ctx);
    await requireOwnedProject(ctx, userId, projectId);
    await ctx.db.patch(projectId, { collapsed });
  },
});

// Count the chats inside a project (for the delete-confirmation message).
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

// Delete a project AND cascade-delete its chats (+ their messages/parts/outbox).
// The user explicitly wants the conversations removed with a confirmation — the
// confirm prompt is enforced client-side; here we perform the destructive work.
// (Reverses the earlier "detach, keep chats" behavior.)
export const deleteProject = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const { userId, actor } = await requireActive(ctx);
    await requireOwnedProject(ctx, userId, projectId);
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(500);
    for (const c of chats) await cascadeDeleteChat(ctx, c._id);
    await ctx.db.delete(projectId);
    await auditImpersonated(ctx, actor, "project.delete", {
      resource: "project",
      resourceId: projectId,
    });
  },
});
