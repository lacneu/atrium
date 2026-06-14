import { describe, expect, test } from "vitest";
import {
  TABS,
  TAB_PERMISSION,
  GRANTABLE_TABS,
  SETTINGS_TAB_REDIRECTS,
  visibleTabs,
  pathForTab,
  tabFromPathname,
} from "../AdminSettings";
import {
  PERMISSIONS,
  GRANTABLE_USER_PERMISSIONS,
} from "../../../convex/lib/rbac";
import { firstTabOfGroup, visibleGroups } from "./settingsGroups";

// The per-tab RBAC map is the UX mirror of the server's permission gates. These
// tests pin the two together so the nav/landing/grant-editor can NEVER drift
// from what the Convex queries actually enforce.

describe("TAB_PERMISSION", () => {
  test("is total over TABS (one permission per tab)", () => {
    for (const t of TABS) {
      expect(typeof TAB_PERMISSION[t]).toBe("string");
    }
    expect(Object.keys(TAB_PERMISSION).sort()).toEqual([...TABS].sort());
  });

  test("every gating permission is a REAL permission the server knows", () => {
    const known = new Set<string>(Object.values(PERMISSIONS));
    for (const t of TABS) {
      expect(known.has(TAB_PERMISSION[t])).toBe(true);
    }
  });
});

describe("GRANTABLE_TABS ↔ server whitelist (lockstep)", () => {
  test("the grantable tabs map exactly onto GRANTABLE_USER_PERMISSIONS", () => {
    const fromTabs = new Set(GRANTABLE_TABS.map((t) => TAB_PERMISSION[t]));
    const fromServer = new Set<string>(GRANTABLE_USER_PERMISSIONS);
    expect([...fromTabs].sort()).toEqual([...fromServer].sort());
  });

  test("no grantable tab is gated by admin.manage", () => {
    for (const t of GRANTABLE_TABS) {
      expect(TAB_PERMISSION[t]).not.toBe(PERMISSIONS.ADMIN_MANAGE);
    }
  });
});

describe("visibleTabs", () => {
  test("a full-permission holder (admin) sees every tab, in TABS order", () => {
    const all = Object.values(PERMISSIONS);
    expect(visibleTabs(all)).toEqual([...TABS]);
  });

  test("a holder of two read perms sees exactly those tabs, in TABS order", () => {
    // bridge (index 3) precedes traces (index 6) in TABS → nav order, not grant
    // order.
    expect(visibleTabs(["traces.read", "bridge.read"])).toEqual([
      "bridge",
      "traces",
    ]);
  });

  test("agents.files.read grants exactly the agentFiles tab (CONF-4c)", () => {
    expect(visibleTabs(["agents.files.read"])).toEqual(["agentFiles"]);
    // chatDefaults stays admin-only — never reachable through a granted perm.
    expect(visibleTabs(["agents.files.read"])).not.toContain("chatDefaults");
  });

  test("a plain user (chats.read only) sees the owner-scoped tabs (Files + Preferences + Apparence)", () => {
    // Files, Preferences AND Apparence (theme) are owner-scoped and gated on the
    // base `chats.read` permission every approved user holds, so they see all
    // three (and land on the first, Files). Apparence is visible to all because
    // the per-user charte graphique picker lives there (P3); its admin controls
    // are gated INSIDE the component on me.role==="admin". Order follows TABS
    // (files, preferences, theme). A permission-less (pending) user sees nothing.
    expect(visibleTabs(["chats.read"])).toEqual([
      "files",
      "preferences",
      "theme",
    ]);
    expect(visibleTabs([])).toEqual([]);
  });
});

describe("groups × RBAC (sidebar group landing)", () => {
  test("clicking a group lands on its first allowed tab, in nav order", () => {
    // Admin (all perms): the access group's first tab in TABS order is users.
    const adminVisible = visibleTabs(Object.values(PERMISSIONS));
    expect(firstTabOfGroup(adminVisible, "access")).toBe("users");
    expect(firstTabOfGroup(adminVisible, "observability")).toBe("traces");
    // A plain user (chats.read): personal lands on files (files precedes
    // preferences and theme in TABS order).
    const userVisible = visibleTabs(["chats.read"]);
    expect(firstTabOfGroup(userVisible, "personal")).toBe("files");
    // A group with no allowed tab has no landing (the sidebar hides it).
    expect(firstTabOfGroup(userVisible, "observability")).toBeUndefined();
  });

  test("a non-admin only sees groups holding >=1 granted tab", () => {
    expect(visibleGroups(["chats.read", "traces.read"])).toEqual([
      "personal",
      "observability",
    ]);
  });
});

describe("pathForTab / tabFromPathname (round-trip)", () => {
  test("pathForTab builds /settings/<tab> and tabFromPathname reverses it", () => {
    for (const t of TABS) {
      expect(pathForTab(t)).toBe(`/settings/${t}`);
      expect(tabFromPathname(pathForTab(t))).toBe(t);
    }
  });

  test("non-tab pathnames resolve to undefined", () => {
    expect(tabFromPathname("/settings")).toBeUndefined();
    expect(tabFromPathname("/settings/bogus")).toBeUndefined();
    expect(tabFromPathname("/chat/abc")).toBeUndefined();
    expect(tabFromPathname("/")).toBeUndefined();
  });
});

// Legacy tab URLs: when a tab is retired/merged, its old /settings/<tab>
// bookmark must redirect to the absorbing tab (the router mounts one static
// redirect route per entry — see router.tsx uiprefsRedirectRoute).
describe("SETTINGS_TAB_REDIRECTS (retired tabs)", () => {
  test("every source is a RETIRED key and every target a live tab", () => {
    for (const [source, target] of Object.entries(SETTINGS_TAB_REDIRECTS)) {
      // A source still in TABS would shadow a live tab with a redirect.
      expect(TABS as readonly string[]).not.toContain(source);
      expect(TABS).toContain(target);
    }
  });

  test("the merged uiprefs tab redirects to preferences", () => {
    expect(SETTINGS_TAB_REDIRECTS.uiprefs).toBe("preferences");
    // And uiprefs really left the tab universe (nav, RBAC map, groups).
    expect(tabFromPathname("/settings/uiprefs")).toBeUndefined();
  });
});
