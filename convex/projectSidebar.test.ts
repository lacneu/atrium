/// <reference types="vite/client" />
//
// Taking a ROOT folder out of the left sidebar.
//
// The property that matters most here is not the hiding, it is the RETURN: a
// user who removes every root folder must still be able to put one back. A
// folder removed from the bar appears nowhere else in it, and search does not
// match folder names — so if the listing stopped reporting hidden folders, the
// only way out would be to create a new folder as a trick. That is the state
// this file exists to make impossible.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function user(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" });
    return userId;
  });
}

describe("removing a root folder from the sidebar", () => {
  test("hiding EVERY root folder still leaves a way back", async () => {
    // The anti-lockout guarantee. With nothing visible left, the listing must
    // still name what was hidden — otherwise the interface offers no route back
    // and the user has to invent one.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const as = t.withIdentity({ subject: userId });
    const roots: Id<"projects">[] = [];
    for (const name of ["Travail", "Perso", "Archives"]) {
      roots.push(await as.mutation(api.projects.createProject, { name }));
    }

    for (const projectId of roots) {
      await as.mutation(api.projects.setProjectSidebar, {
        projectId,
        hidden: true,
      });
    }

    const listed = await as.query(api.projects.listProjects, {});
    expect(listed).toHaveLength(3);
    expect(listed.every((p) => p.sidebarHidden)).toBe(true);
    // ...and each one can be put back from that same listing.
    await as.mutation(api.projects.setProjectSidebar, {
      projectId: roots[0]!,
      hidden: false,
    });
    const after = await as.query(api.projects.listProjects, {});
    expect(after.filter((p) => !p.sidebarHidden).map((p) => p.name)).toEqual([
      "Travail",
    ]);
  });

  test("a folder taken out of the bar is not taken out of the WORKSPACE", async () => {
    // It left one view. It still holds its conversations and is still a
    // destination when moving something, which is why the listing that feeds the
    // move picker keeps returning it.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const as = t.withIdentity({ subject: userId });
    const projectId = await as.mutation(api.projects.createProject, {
      name: "Travail",
    });
    await as.mutation(api.projects.setProjectSidebar, {
      projectId,
      hidden: true,
    });

    const listed = await as.query(api.projects.listProjects, {});

    expect(listed.map((p) => p.name)).toEqual(["Travail"]);
  });

  test("the folder's own page is a SECOND way back", async () => {
    // The restore list in the bar is one route; the folder page is the other.
    // A user who reaches a hidden folder by its URL, a breadcrumb or a move
    // picker must be told it is out of the bar and be able to undo it there,
    // without walking back to the sidebar.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const as = t.withIdentity({ subject: userId });
    const root = await as.mutation(api.projects.createProject, {
      name: "Archives",
    });
    await as.mutation(api.projects.setProjectSidebar, {
      projectId: root,
      hidden: true,
    });

    const page = await as.query(api.projects.projectPage, { projectId: root });
    expect(page?.project.sidebarHidden).toBe(true);

    await as.mutation(api.projects.setProjectSidebar, {
      projectId: root,
      hidden: false,
    });
    const back = await as.query(api.projects.projectPage, { projectId: root });
    expect(back?.project.sidebarHidden).toBe(false);
  });

  test("a folder page leaves the conversation controls alone", async () => {
    // Computing it from the chat alone made the page offer "remove from the
    // sidebar" for a conversation that was not in it — and taking that action
    // hid the chat INDIVIDUALLY, so it stayed missing after the folder returned.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const as = t.withIdentity({ subject: userId });
    const projectId = await as.mutation(api.projects.createProject, {
      name: "Masqué",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("chats", {
        userId,
        title: "dedans",
        updatedAt: 1,
        projectId,
      });
    });
    await as.mutation(api.projects.setProjectSidebar, {
      projectId,
      hidden: true,
    });

    // The chat's OWN control is untouched by this feature: the folder left the
    // sidebar, the conversation's own state did not. Offering "put back in the
    // sidebar" here would call a mutation that changes nothing while the folder
    // stays hidden — a control that lies.
    const page = await as.query(api.projects.projectPage, { projectId });

    expect(page).not.toBeNull();
    expect(page!.chats).toHaveLength(1);
    expect(page!.chats[0]!.inSidebar).toBe(true);
  });

  test("a NESTED folder cannot be given this state", async () => {
    // A sub-folder already disappears when its parent is collapsed, and one
    // whose parent is hidden would be reachable from nowhere.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const as = t.withIdentity({ subject: userId });
    const parentId = await as.mutation(api.projects.createProject, {
      name: "Travail",
    });
    const childId = await as.mutation(api.projects.createProject, {
      name: "Client",
      parentId,
    });

    await expect(
      as.mutation(api.projects.setProjectSidebar, {
        projectId: childId,
        hidden: true,
      }),
    ).rejects.toThrow(/root folder/i);
  });

  test("moving a hidden folder puts it back in view", async () => {
    // Otherwise nesting it would produce exactly the state the mutation refuses
    // to touch, and it would stay silently absent even after returning to root.
    const t = convexTest(schema, modules);
    const userId = await user(t);
    const as = t.withIdentity({ subject: userId });
    const hostId = await as.mutation(api.projects.createProject, {
      name: "Hôte",
    });
    const movedId = await as.mutation(api.projects.createProject, {
      name: "Déplacé",
    });
    await as.mutation(api.projects.setProjectSidebar, {
      projectId: movedId,
      hidden: true,
    });

    await as.mutation(api.projects.moveProject, {
      projectId: movedId,
      parentId: hostId,
    });

    const moved = (await as.query(api.projects.listProjects, {})).find(
      (p) => p.name === "Déplacé",
    )!;
    expect(moved.sidebarHidden).toBe(false);
  });
});
