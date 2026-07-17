import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

type T = ReturnType<typeof convexTest>;

// Folder hierarchy invariants. Discriminating properties:
//   - depth is capped at 3 on BOTH create and move (refusal, never flattening);
//   - a folder can never be moved into its own subtree (cycle);
//   - deleteProject removes the WHOLE subtree (folders + chats + messages);
//   - projectTreeCount counts recursively (confirmation numbers);
//   - ownership is enforced on every new surface (IDOR).

async function seedUser(t: T, canonical: string) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical,
    });
    return userId;
  });
}

/** A / A1 / A11 chain (3 levels) owned by the caller, via the real mutations. */
async function seedChain(as: ReturnType<T["withIdentity"]>) {
  const a = await as.mutation(api.projects.createProject, { name: "A" });
  const a1 = await as.mutation(api.projects.createProject, {
    name: "A1",
    parentId: a,
  });
  const a11 = await as.mutation(api.projects.createProject, {
    name: "A11",
    parentId: a1,
  });
  return { a, a1, a11 };
}

async function seedChatIn(
  t: T,
  userId: Id<"users">,
  projectId: Id<"projects">,
  withMessage = false,
) {
  return t.run(async (ctx) => {
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
      projectId,
    });
    if (withMessage) {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "hello",
        updatedAt: 1,
      });
    }
    return chatId;
  });
}

describe("projects hierarchy", () => {
  test("createProject nests to ARBITRARY depth; listProjects exposes parentId", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { a, a1, a11 } = await seedChain(as);

    // Depth is unlimited: a 4th (and deeper) level is fine.
    const a111 = await as.mutation(api.projects.createProject, {
      name: "A111",
      parentId: a11,
    });

    const list = await as.query(api.projects.listProjects, {});
    const byName = new Map(list.map((p) => [p.name, p]));
    expect(byName.get("A")!.parentId).toBeNull();
    expect(byName.get("A1")!.parentId).toBe(a);
    expect(byName.get("A11")!.parentId).toBe(a1);
    expect(byName.get("A111")!.parentId).toBe(a11);
    expect([a111]).toBeDefined();
  });

  test("moveProject refuses cycles (into its own grandchild); any acyclic depth is allowed", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { a, a1, a11 } = await seedChain(as);
    const b = await as.mutation(api.projects.createProject, { name: "B" });
    const b1 = await as.mutation(api.projects.createProject, {
      name: "B1",
      parentId: b,
    });

    // Cycle: A into its grandchild A11.
    await expect(
      as.mutation(api.projects.moveProject, { projectId: a, parentId: a11 }),
    ).rejects.toThrow(/cycle/);

    // Depth unlimited: the height-2 subtree A1 under depth-2 B1 -> 4 levels, OK.
    await as.mutation(api.projects.moveProject, { projectId: a1, parentId: b1 });
    // Promote back to root.
    await as.mutation(api.projects.moveProject, { projectId: a1, parentId: null });
    const list = await as.query(api.projects.listProjects, {});
    const byName = new Map(list.map((p) => [p.name, p]));
    expect(byName.get("A1")!.parentId).toBeNull();
    expect([a11]).toBeDefined();
  });

  test("projectTreeList returns the subtree's folders + chats grouped by folder", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { a, a1, a11 } = await seedChain(as);
    const inA = await seedChatIn(t, userId, a);
    const inA11 = await seedChatIn(t, userId, a11);
    // A chat OUTSIDE the subtree must not appear.
    const b = await as.mutation(api.projects.createProject, { name: "B" });
    await seedChatIn(t, userId, b);

    const res = await as.query(api.projects.projectTreeList, { projectId: a });
    expect(res).not.toBeNull();
    expect(res!.rootId).toBe(a);
    expect(res!.folders.map((f) => f.name).sort()).toEqual(["A1", "A11"]);
    // parentId is RELATIVE to the subtree: the viewed folder's direct child
    // ships null (the root is absent from the array), deeper links stay real.
    const byFolderName = new Map(res!.folders.map((f) => [f.name, f]));
    expect(byFolderName.get("A1")!.parentId).toBeNull();
    expect(byFolderName.get("A11")!.parentId).toBe(byFolderName.get("A1")!._id);
    const byId = new Map(res!.chats.map((c) => [c._id, c.folderId]));
    expect(byId.get(inA)).toBe(a);
    expect(byId.get(inA11)).toBe(a11);
    expect(res!.chats).toHaveLength(2);

    // Not-found contract + IDOR.
    expect(
      await as.query(api.projects.projectTreeList, { projectId: "garbage" }),
    ).toBeNull();
    const intruderId = await seedUser(t, "mallory");
    const asIntruder = t.withIdentity({ subject: `${intruderId}|session` });
    await expect(
      asIntruder.query(api.projects.projectTreeList, { projectId: a }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("projectTreeCount counts folders and non-archived chats recursively", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { a, a1, a11 } = await seedChain(as);
    await seedChatIn(t, userId, a);
    await seedChatIn(t, userId, a1);
    await seedChatIn(t, userId, a11);
    // An archived chat must not count.
    const archived = await seedChatIn(t, userId, a11);
    await t.run(async (ctx) => ctx.db.patch(archived, { archived: true }));

    expect(await as.query(api.projects.projectTreeCount, { projectId: a }))
      .toEqual({ folders: 2, chats: 3 });
    expect(await as.query(api.projects.projectTreeCount, { projectId: a1 }))
      .toEqual({ folders: 1, chats: 2 });
    expect(await as.query(api.projects.projectTreeCount, { projectId: a11 }))
      .toEqual({ folders: 0, chats: 1 });
  });

  test("deleteProject removes the WHOLE subtree: folders, chats and their messages", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { a, a1, a11 } = await seedChain(as);
    const rootChat = await seedChatIn(t, userId, a, true);
    const deepChat = await seedChatIn(t, userId, a11, true);
    // A sibling root folder + chat that must SURVIVE.
    const b = await as.mutation(api.projects.createProject, { name: "B" });
    const survivor = await seedChatIn(t, userId, b, true);

    await as.mutation(api.projects.deleteProject, { projectId: a });

    const after = await t.run(async (ctx) => ({
      projects: await ctx.db.query("projects").collect(),
      chats: await ctx.db.query("chats").collect(),
      messages: await ctx.db.query("messages").collect(),
    }));
    expect(after.projects.map((p) => p._id)).toEqual([b]);
    expect(after.chats.map((c) => c._id)).toEqual([survivor]);
    // Every message of the deleted chats is gone; the survivor's remains.
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]!.chatId).toBe(survivor);
    expect([rootChat, deepChat, a, a1, a11]).toBeDefined(); // ids consumed above
  });

  test("IDOR: move/delete/treeCount/create-under are Forbidden on another user's folders", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "alice");
    const asOwner = t.withIdentity({ subject: `${ownerId}|session` });
    const { a } = await seedChain(asOwner);
    const intruderId = await seedUser(t, "mallory");
    const asIntruder = t.withIdentity({ subject: `${intruderId}|session` });

    await expect(
      asIntruder.mutation(api.projects.moveProject, {
        projectId: a,
        parentId: null,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asIntruder.mutation(api.projects.deleteProject, { projectId: a }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asIntruder.query(api.projects.projectTreeCount, { projectId: a }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asIntruder.mutation(api.projects.createProject, {
        name: "inject",
        parentId: a,
      }),
    ).rejects.toThrow(/Forbidden/);
    // The owner's tree is intact.
    const list = await asOwner.query(api.projects.listProjects, {});
    expect(list).toHaveLength(3);
  });

  test("folderColumns returns one column per level (root -> selected), with folders + direct chats", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { a, a1, a11 } = await seedChain(as);
    const unfiled = await t.run(async (ctx) =>
      ctx.db.insert("chats", { userId, updatedAt: 5 }),
    );
    const inA1 = await seedChatIn(t, userId, a1);

    const res = await as.query(api.projects.folderColumns, {
      projectId: a1,
    });
    // Path A/A1 -> 3 columns: root level, A's content, A1's content.
    expect(res.columns).toHaveLength(3);
    expect(res.columns[0]!.folderId).toBeNull();
    expect(res.columns[0]!.folders.map((f) => f.name)).toEqual(["A"]);
    expect(res.columns[0]!.folders[0]!.selected).toBe(true);
    expect(res.columns[0]!.chats.map((c) => c._id)).toEqual([unfiled]);
    expect(res.columns[1]!.folderId).toBe(a);
    expect(res.columns[1]!.folders.map((f) => f.name)).toEqual(["A1"]);
    expect(res.columns[2]!.folderId).toBe(a1);
    expect(res.columns[2]!.folders.map((f) => f.name)).toEqual(["A11"]);
    expect(res.columns[2]!.folders[0]!.selected).toBe(false);
    expect(res.columns[2]!.chats.map((c) => c._id)).toEqual([inA1]);
    expect([a11]).toBeDefined();

    // null (or a foreign/malformed id) degrades to the root column alone.
    const root = await as.query(api.projects.folderColumns, {
      projectId: null,
    });
    expect(root.columns).toHaveLength(1);
    const degraded = await as.query(api.projects.folderColumns, {
      projectId: "garbage",
    });
    expect(degraded.columns).toHaveLength(1);
  });

  test("setChatSidebar hides a chat from listChats (folder page still shows it); pinned always shows", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    const a = await as.mutation(api.projects.createProject, { name: "A" });
    const inA = await seedChatIn(t, userId, a);
    const pinnedChat = await seedChatIn(t, userId, a);
    await t.run(async (ctx) => ctx.db.patch(pinnedChat, { pinned: true }));

    // Remove both from the working set; the pinned one must survive.
    await as.mutation(api.chats.setChatSidebar, { chatId: inA, hidden: true });
    await as.mutation(api.chats.setChatSidebar, {
      chatId: pinnedChat,
      hidden: true,
    });
    const sidebar = (await as.query(api.messages.listChats, {})) as {
      _id: Id<"chats">;
    }[];
    const ids = sidebar.map((c) => c._id);
    expect(ids).not.toContain(inA);
    expect(ids).toContain(pinnedChat); // pinning wins over the opt-out

    // The folder page still lists the hidden chat, flagged out-of-sidebar.
    const page = await as.query(api.projects.projectPage, { projectId: a });
    const row = page!.chats.find((c) => c._id === inA);
    expect(row).toBeDefined();
    expect(row!.inSidebar).toBe(false);

    // Put it back.
    await as.mutation(api.chats.setChatSidebar, { chatId: inA, hidden: false });
    const back = (await as.query(api.messages.listChats, {})) as {
      _id: Id<"chats">;
    }[];
    expect(back.map((c) => c._id)).toContain(inA);
  });

  test("a new sibling (create or move) lands at the TOP of its siblings only", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "alice");
    const as = t.withIdentity({ subject: `${userId}|session` });
    const a = await as.mutation(api.projects.createProject, { name: "A" });
    const c1 = await as.mutation(api.projects.createProject, {
      name: "C1",
      parentId: a,
    });
    const c2 = await as.mutation(api.projects.createProject, {
      name: "C2",
      parentId: a,
    });
    const list = await as.query(api.projects.listProjects, {});
    const key = (id: Id<"projects">) =>
      list.find((p) => p._id === id)!.sortKey;
    // Later-created sibling sorts first (min - 1 among siblings).
    expect(key(c2)).toBeLessThan(key(c1));
    // Moving a root under A drops it above both existing children.
    const d = await as.mutation(api.projects.createProject, { name: "D" });
    await as.mutation(api.projects.moveProject, { projectId: d, parentId: a });
    const after = await as.query(api.projects.listProjects, {});
    const keyAfter = (id: Id<"projects">) =>
      after.find((p) => p._id === id)!.sortKey;
    expect(keyAfter(d)).toBeLessThan(keyAfter(c2));
  });
});
