// Settings › Deleted conversations: the user's OWN trash, moved out of the
// sidebar into the Personal settings group. Two things are pinned here:
// - the tab exists for every approved user, in the Personal group, with its
//   label, and rides the shared paramless `/settings/$tab` route;
// - the tab renders the trash with everything the former /trash page offered —
//   the retention notice, each conversation with Restore and Delete permanently,
//   Empty trash — wired to the caller's OWN trash functions, never the admin ones.
//
// Rendered with Convex stubbed at the hook boundary: the real component tree,
// fed a known page of trashed conversations.

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

type Page = { results: unknown[]; status: string; loadMore: () => void };

const hooks = vi.hoisted(() => ({
  page: { results: [], status: "Exhausted", loadMore: () => undefined } as Page,
  queried: [] as string[],
  mutations: [] as string[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const name = (ref: unknown) => getFunctionName(ref as FunctionReference<"query">);
  return {
    usePaginatedQuery: (ref: unknown) => {
      hooks.queried.push(name(ref));
      return hooks.page;
    },
    useQuery: (ref: unknown) => (name(ref) === "trash:retention" ? { days: 14 } : undefined),
    useMutation: (ref: unknown) => {
      hooks.mutations.push(name(ref));
      return async () => null;
    },
  };
});

import { DeletedChatsTab } from "./DeletedChatsTab";
import { DialogsProvider } from "@/components/ConfirmDialog";
import {
  PARAMLESS_TABS,
  TAB_I18N,
  TAB_PERMISSION,
  visibleTabs,
} from "../AdminSettings";
import { firstTabOfGroup, groupOfTab } from "./settingsGroups";
import { m } from "@/paraglide/messages.js";

function renderTab(): string {
  return renderToStaticMarkup(h(DialogsProvider, null, h(DeletedChatsTab)));
}

/** How many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  hooks.page = { results: [], status: "Exhausted", loadMore: () => undefined };
  hooks.queried = [];
  hooks.mutations = [];
});

describe("Settings › Deleted conversations is a personal tab", () => {
  test("every approved user sees it, in the Personal group, under its own label", () => {
    expect(visibleTabs(["chats.read"])).toContain("deletedChats");
    expect(TAB_PERMISSION.deletedChats).toBe("chats.read");
    expect(groupOfTab("deletedChats")).toBe("personal");
    expect(TAB_I18N.deletedChats()).toBe("Conversations supprimées");
    // Distinct from the admin's every-user trash tab, which stays in Access.
    expect(TAB_I18N.deletedChats()).not.toBe(TAB_I18N.trash());
    expect(groupOfTab("trash")).toBe("access");
    // Not the group's landing: Files stays first for a plain user.
    expect(firstTabOfGroup(visibleTabs(["chats.read"]), "personal")).toBe("files");
  });

  test("it rides the shared paramless /settings/$tab route", () => {
    expect(PARAMLESS_TABS).toContain("deletedChats");
  });
});

describe("the tab renders the caller's trash with its actions", () => {
  test("each conversation is listed with Restore and Delete permanently, plus Empty trash", () => {
    hooks.page = {
      status: "Exhausted",
      loadMore: () => undefined,
      results: [
        { _id: "c1", title: "Plan du trimestre", trashedAt: Date.UTC(2026, 8, 20), purgeAfter: Date.UTC(2026, 9, 4) },
        { _id: "c2", title: null, trashedAt: Date.UTC(2026, 8, 21), purgeAfter: null },
      ],
    };
    const html = renderTab();
    expect(html).toContain(m.trash_intro({ days: 14 }).replace(/'/g, "&#x27;"));
    expect(html).toContain("Plan du trimestre");
    expect(html).toContain(m.sidebar_untitled());
    expect(count(html, m.trash_restore())).toBe(2);
    expect(count(html, m.trash_purge())).toBe(2);
    expect(html).toContain(m.trash_empty());
    expect(html).not.toContain(m.trash_is_empty());
  });

  test("an empty trash says so and offers no Empty trash", () => {
    const html = renderTab();
    expect(html).toContain(m.trash_is_empty());
    expect(html).not.toContain(m.trash_empty());
  });

  test("a further page offers Show more", () => {
    hooks.page = {
      status: "CanLoadMore",
      loadMore: () => undefined,
      results: [{ _id: "c1", title: "A", trashedAt: 1, purgeAfter: null }],
    };
    expect(renderTab()).toContain(m.trash_load_more());
  });

  test("it reads and acts on the caller's OWN trash, never the admin functions", () => {
    renderTab();
    expect(hooks.queried).toEqual(["trash:listMyTrash"]);
    expect([...hooks.mutations].sort()).toEqual([
      "trash:emptyTrash",
      "trash:purgeChat",
      "trash:restoreChat",
    ]);
  });
});
