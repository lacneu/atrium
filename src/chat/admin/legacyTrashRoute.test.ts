// The former /trash page is gone; its URL must still land somewhere useful. Old
// bookmarks and deep links redirect to Settings › Deleted conversations.
//
// Exercised through a real TanStack router (memory history) built from the same
// pieces router.tsx mounts: the legacy path + its beforeLoad, and the paramless
// `/settings/$tab` route validated against PARAMLESS_TABS (an unknown tab would
// silently fall back to "roles" there — so the parsed param is asserted too).

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { z } from "zod";
import { describe, expect, test, vi } from "vitest";
import { PARAMLESS_TABS } from "../AdminSettings";
import {
  LEGACY_TRASH_PATH,
  TRASH_SETTINGS_TAB,
  redirectLegacyTrash,
} from "./legacyTrashRoute";

function buildRouter(initial: string) {
  const root = createRootRoute();
  const legacyTrash = createRoute({
    getParentRoute: () => root,
    path: LEGACY_TRASH_PATH,
    beforeLoad: redirectLegacyTrash,
  });
  const settings = createRoute({ getParentRoute: () => root, path: "settings" });
  const settingsTab = createRoute({
    getParentRoute: () => settings,
    path: "$tab",
    parseParams: (p: Record<string, string>) => ({
      tab: z.enum([...PARAMLESS_TABS]).catch("roles").parse(p.tab),
    }),
  });
  return createRouter({
    routeTree: root.addChildren([legacyTrash, settings.addChildren([settingsTab])]),
    history: createMemoryHistory({ initialEntries: [initial] }),
    // The test runtime has no DOM; as a browser would, follow the redirect.
    isServer: false,
  });
}

describe("legacy /trash URL", () => {
  test("lands on Settings › Deleted conversations", async () => {
    const router = buildRouter("/trash");
    await router.load();
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/deletedChats"),
    );
    // The landing resolves to the settings tab route, its param intact.
    const matches = router.matchRoutes(router.state.location);
    const leaf = matches[matches.length - 1];
    expect(leaf.routeId).toBe("/settings/$tab");
    expect(leaf.params).toEqual({ tab: "deletedChats" });
    expect(TRASH_SETTINGS_TAB).toBe("deletedChats");
  });

  test("the redirect replaces the history entry (Back does not bounce on /trash)", () => {
    let thrown: unknown;
    try {
      redirectLegacyTrash();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      options: { to: "/settings/$tab", params: { tab: "deletedChats" }, replace: true },
    });
  });
});
